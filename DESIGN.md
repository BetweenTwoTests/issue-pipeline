# issue-pipeline — Design & Implementation Notes

This documents the system **as built**, not the original proposal it came
from. Where the two differ, this doc wins — it reflects what actually runs,
what actually broke during real testing, and why things are shaped the way
they are. Read [CLAUDE.md](CLAUDE.md) first for commands and the short
version of the architecture; come here for the rationale, the bug history,
and the roadmap.

## 1. What it does

One GitHub issue in, one merged stack out. `pipe start <issue>` spins up a
long-lived Temporal **entity workflow** for that issue which: plans the work
with Claude Code plan mode against a real checkout, posts the plan as an
issue comment, blocks until a human answers every open question, writes the
phases into the issue body as a checkbox list, executes each phase in a
fresh Claude session inside an isolated git worktree (one stacked PR per
phase, submitted with `gt submit`), files any newly-discovered out-of-scope
work as sub-issues, then keeps polling until every PR in the stack is merged
— and only then closes the issue as completed.

The GitHub issue is the source of truth and the **persistent memory between
agent sessions**; Temporal is the runtime (state machine, retries, timers,
human-in-the-loop signals); git branches are the workspace state. No
database beyond Temporal's own Postgres persistence store.

## 2. The single-issue redesign (what changed and why)

The first iteration of this system decomposed a root issue into one
**sub-issue per phase**. That was replaced wholesale:

- **Phases are checkbox task-list items on the root issue's body**, not
  sub-issues. One page shows the whole pipeline: description, plan,
  progress, worklogs. Sub-issues scattered the story across N+1 pages and
  duplicated content that already had to live in the plan.
- **The root issue is what agents read and write.** Every executor session
  starts with `gh issue view <n> --comments` and ends (when it has
  something to say) with `gh issue comment`. Nothing about prior phases is
  forwarded through Temporal inputs anymore — the old `phaseWorkflow`
  fetched prior sub-issues' worklog comments to build handoff context; now
  the session just reads the one issue. Temporal carries only small scalars
  (titles, branch names, PR numbers).
- **`planWorkflow` became `issueWorkflow`, an entity workflow.** The issue
  is the entity; the workflow ID (`pipeline-<owner>-<repo>-<n>`) is its
  address; signals (`answer`/`resume`/`skip`/`abort`/`checkMerges`) are its
  API; a query (`status`) exposes its state; and it does not return when
  the code ships — it lives until the stack merges or a human aborts.
- **Claude only.** The codex adapter was deleted (see §9). The
  `roles.<role>.adapter` key survives as a claude-only enum so an old
  config naming codex fails loudly at parse time instead of silently
  misbehaving.
- **Sub-issues have exactly one remaining job**: "discovered tasks" — new,
  out-of-scope work an agent surfaces mid-phase (see §7).

## 3. Package architecture

```
apps/worker  → packages/activities → packages/adapters → packages/core
apps/cli     → packages/core (only — never activities)
```

**Why core must stay pure.** `packages/core` is imported for *values* by
both workflow code (`apps/worker/src/workflows/*.ts`, which runs inside
Temporal's sandboxed workflow bundle) and ordinary Node code (activities,
adapters, the CLI). Temporal's worker bundles everything reachable from the
workflow files via webpack at worker startup. The very first live test of
this system hit this directly: `loadTemporalConnectionConfig` lived in
`packages/core`'s barrel, used `node:path` + `dotenv`, and `phase.ts`
imported *values* from core (`buildPhaseBranchName`, `slugify`, the signal
definitions) — so webpack traced the whole barrel, hit `node:path`, and
failed with `UnhandledSchemeError: Reading from "node:path" is not handled
by plugins`. **`tsc`/typecheck does not catch this** — it's only visible
when the worker actually starts (or when the workflow tests run:
`Worker.create` there performs the same webpack bundling, which is the
cheapest regression check for it). The fix was to delete that function from
core entirely and duplicate a ~30-line env loader directly in
`apps/worker/src/env.ts` and `apps/cli/src/env.ts` (they can't share it via
activities either, since cli must never depend on activities). If you're
tempted to add a "shared utility" to core, first ask whether it touches
`fs`/`child_process`/`net`/`node:path` — if yes, it belongs in `activities`
or a per-app file, never core. (The phase-checklist renderer and the prompt
constants are in core precisely because they are pure string manipulation.)

**Why cli never imports activities.** Keeps the CLI a thin, safe Temporal
client — every real action (GitHub calls, git operations, agent execution)
flows through Temporal so it's observable/retryable/durable. `pipe start`
only ever calls `client.workflow.signalWithStart`; `resume`/`skip`/`abort`/
`answer`/`check` only ever call `handle.signal(...)`; `status <ref>` only
`handle.query(...)`.

**Module system: CommonJS, not ESM — deliberately.** Node 24's native
TypeScript execution only *erases type annotations*; it does not transform
`import`/`export` syntax into `require`/`module.exports`. A `"type":
"commonjs"` package whose source uses ESM `import`/`export` syntax cannot be
`require()`'d by plain Node at all — this was discovered during initial
scaffolding (tsc errored with "ECMAScript imports and exports cannot be
written in a CommonJS file under 'verbatimModuleSyntax'" the moment
`module`/`moduleResolution` were set to `nodenext`). The resolution: real
`tsc` builds to `dist/` for every package (`tsconfig.base.json` uses
`module: commonjs`, `moduleResolution: node10`, no `verbatimModuleSyntax`),
and `tsx` (esbuild-backed, does the actual transform) drives the dev loop
(`tsx watch src/worker.ts`, `node --import tsx --test ...`). Don't try to
remove the build step for "internal" packages to save time — `require()`ing
raw `.ts` source with `import`/`export` syntax under CommonJS will throw a
syntax error at runtime regardless of what tsc's `module` setting says,
since tsc isn't in the loop for a bare `node dist/index.js` invocation.

## 4. `issueWorkflow` (apps/worker/src/workflows/issue.ts)

The entity workflow's stages, in order:

1. **Setup.** Load `pipeline.yaml`, resolve the registered repo by GitHub
   owner/repo (not by the `repos:` map key — the workflow only ever
   receives owner/repo/issue# from the CLI), `ensureBareClone` +
   `fetchRepo`, fetch the root issue, flip `pipeline:ready` →
   `pipeline:in-progress`.
2. **Planning loop (plan mode + human-in-the-loop).** Create the planning
   worktree (a *detached, read-only checkout of trunk* — see §6), run the
   planner (Claude Code plan mode, §9), parse the JSON contract, post the
   rendered plan as a comment (`## Implementation plan`, the heading the
   executor prompt tells later sessions to look for — latest one wins).
   If the plan has open questions: label `pipeline:needs-input`, post them
   as a numbered comment, and **wait**. `pipe answer <ref> <n> "<text>"`
   answers one question; a 72h `condition` timeout re-arms with a
   `pipeline:stalled` label + reminder comment. When every question is
   answered, the answers are posted as a comment (so the decision history
   lives on the issue, not just in Temporal) and the planner runs again
   with all answers so far baked into its prompt. The loop exits only when
   a planning round produces **zero** open questions.

   **Decision: every open question blocks.** The old blocking/non-blocking
   split (non-blocking questions became auto-applied "assumptions") is
   gone. The planner is instead told to decide non-essential things itself
   and record the decision in the phase spec — so anything it *does* ask
   is by definition a human decision, and implementation must not start
   past an unanswered one. One rule, no judgment call about what counts as
   "blocking".
3. **Checklist.** Phase records are created in workflow state and the
   checkbox list is written into the issue body (§5). All unchecked.
4. **Sequential execution.** For each phase: `executeChild(phaseWorkflow)`
   with a derived child ID (`<parent>-phase-<i>-r<retryGeneration>`),
   passing only scalars — owner/repo/issue#, phase index/title/slug, and
   `baseBranch` (trunk for phase 1, else the previous phase's branch; this
   is what makes the stack). A child returning `done` ticks its checkbox
   (with the PR link) and advances. A child returning `parked` pauses the
   parent awaiting `resume` (retry same index as a **new** child execution,
   `retryGeneration+1` — a completed Temporal child can't be "resumed",
   only re-started), `skip` (checkbox ticked with a "skipped by human"
   note; the *next* phase still stacks on the skipped phase's branch so
   every phase's diff stays scoped to its own work), or `abort`.
5. **Merge wait.** Post one "All phases executed" comment listing the PRs,
   then loop: read every done-phase PR's state via `gh pr view` — if all
   `MERGED`, exit the loop; if any is `CLOSED` (gh's json state means
   closed-*without*-merge; merged PRs report `MERGED`) post a one-time
   warning comment and keep waiting (reopen the PR or `pipe abort`);
   otherwise `condition(checkMerges || aborted, merge_poll_minutes)`. The
   poll runs **before** the first wait, so a stack that merged while phases
   were still executing closes the issue immediately. `pipe check` forces
   an immediate poll.

   **continue-as-new lives here and only here.** The merge wait is the one
   stage with unbounded duration (a stack can sit for weeks; at 15-minute
   polls history grows forever), so when `workflowInfo().
   continueAsNewSuggested` fires, the workflow rolls over carrying only
   `{phases (small scalars), closedPrWarningPosted}` and re-enters directly
   at the merge wait. Planning/execution never continue-as-new — their
   history is bounded by the number of phases. Deliberately NOT carried:
   anything an agent wrote (it's on the issue), the plan (same), config
   (re-loaded fresh each execution).
6. **Close.** Label `pipeline:done`, remove `pipeline:in-progress`, close
   the issue via `gh issue close --reason completed` with the final
   summary as the closing comment, and best-effort remove the planning +
   phase worktrees (`cleanupIssueWorktrees`). The bare clone stays.

**Decision: the workflow outlives "the code is written".** "An issue being
marked as completed means all the phases related to it were completed" —
and completed means *merged*, not *PR opened*. Closing the issue is the
pipeline's job, so the entity stays alive watching the stack. Checkboxes
track "phase executed (PR exists)"; issue closure tracks "everything
merged". Two different facts, two different mechanisms.

## 5. GitHub mechanics (packages/activities/src/github.ts)

- **The phase checklist is a marker-bracketed section of the issue body**:
  `<!-- pipeline:phases:begin -->` … `<!-- pipeline:phases:end -->` around a
  `## Phases` task list (`- [x] Phase 2: … ([PR #12](url))`). The section is
  always re-rendered *whole* from workflow state and spliced between the
  markers (`upsertPhaseChecklist` in core — pure string code, unit-tested):
  idempotent under Temporal's at-least-once activity retries, self-healing
  if a human mangles a checkbox, and guaranteed to never touch what the
  human wrote around it. The workflow (single writer) owns every update;
  phase children never edit the body.
- **Sub-issues**: `gh` has no native sub-issue command (verified — checked
  `gh issue create --help`/`gh issue edit --help`, no `--parent` flag
  exists). Linking uses the GraphQL `addSubIssue` mutation with
  `subIssueUrl` (the child's plain URL, which `gh issue create` already
  prints — avoids a second lookup for the child's node ID) and
  `replaceParent: true` (idempotent). Listing uses the REST endpoint
  `GET /repos/{owner}/{repo}/issues/{n}/sub_issues`. Since the redesign
  this machinery serves **only** discovered tasks (§7).
- **Labels must exist on the repo before they can be added to *or removed
  from* an issue** — verified directly against a real repo:
  `gh issue edit --add-label`/`--remove-label` both fail with `'<label>'
  not found` for a label that was never created. None of the `pipeline:*`
  labels this system uses (`pipeline:in-progress`, `pipeline:needs-input`,
  `pipeline:stalled`, `pipeline:done`) exist anywhere by default. Fix (in
  `addLabels`/`removeLabels`): `addLabels` auto-creates any missing label
  (`gh label create <name> --force`, idempotent) and retries once;
  `removeLabels` treats "label doesn't exist" as an already-satisfied
  no-op (removing a label that was never even defined on the repo can't
  meaningfully fail).
- **Everything lands on the root issue** — plan, questions, answers,
  per-phase worklogs (labeled `## Phase k/N worklog`), park explanations,
  merge-wait status. One page for a human to read top to bottom, and the
  exact page every agent session is told to read first.
- **PR merge states**: `gh pr view <n> --json state` reports
  `OPEN | CLOSED | MERGED` — `CLOSED` strictly means closed-without-merge,
  so the merge wait treats it as "needs a human look", not success.
- `closeIssueCompleted` uses `gh issue close --reason completed --comment`
  (flags verified against gh's help) and treats "already closed" as
  satisfied.

## 6. Git/Graphite mechanics (packages/activities/src/git.ts)

- **Bare clone per registered repo**, at `repos.<name>.local_path` (must be
  an absolute path or `~/...` — activities run with `cwd` set to whichever
  package invoked them, not the repo root, so a relative path resolves
  unpredictably; nothing currently validates this at config-parse time).
  Created automatically on first use (`ensureBareClone`) — never touches
  the developer's own working checkout of that repo. `git clone --bare`
  does **not** populate `remote.origin.fetch`; fixed immediately after
  cloning (`git config remote.origin.fetch
  '+refs/heads/*:refs/remotes/origin/*'`), before any fetch is attempted.
- **Real bug found during the redesign: the bare clone's local trunk ref
  goes stale.** The refspec above only updates `refs/remotes/origin/*`, so
  `refs/heads/<trunk>` in the bare clone stayed frozen at clone time — and
  trunk is exactly what the planning worktree and every phase-1 branch are
  cut from, so the *second* issue ever run against a repo would have
  planned and built against weeks-old code. `fetchRepo` now also runs
  `git fetch origin +<trunk>:<trunk>` (verified empirically: fetching into
  a bare repo's current branch is allowed — the "refusing to fetch into
  current branch" guard only applies to non-bare repos — and worktrees
  don't block it as long as trunk itself is never checked out in one,
  which it never is here: phase worktrees sit on phase branches and the
  planning worktree is detached). Covered by a real test in git.test.ts.
- **The planning worktree** (`createPlanningWorktree`) is a detached
  checkout of trunk at `~/pipelines/<name>/phases/<issue>/planning`,
  recreated from scratch on every planning round (planning against stale
  code is worse than the second it takes to re-add). Detached on purpose:
  the planner never commits, so it never needs a branch — and a branchless
  worktree can never collide with the branch-checkout rules below.
- **Phase worktrees** live at a fixed path derived from `os.homedir()`, the
  repo's `pipeline.yaml` key name, the root issue number, and the phase
  number (`buildPhaseWorktreePath` in core) — **independent of whatever
  custom `local_path` was chosen for the bare clone.**
- **Every phase branch (including phase 1) is created via `git worktree add
  --detach <path> <parentRef>` then `git checkout -B <name>` + `gt track
  --parent <parentRef>`** (or plain checkout for the git path) — never
  `worktree add -b`, and never `gt create`. A branch already checked out in
  one worktree can't be checked out in a second one; detaching at the
  parent's tip first and materializing the new branch *inside* the worktree
  sidesteps that, and happens to make phase 1 (parentRef = trunk) and phase
  N>1 (parentRef = previous phase's branch) the same code path. `gt create`
  specifically **fails from a detached HEAD** ("Cannot perform this
  operation without a branch checked out" — verified against a real
  failure, regardless of `--onto`), which is also why the executor prompt
  tells the agent to commit with plain git and submit with `gt submit`,
  never to run `gt create` itself, even though the original design sketch
  said "a PR using `gt create` and `gt submit`". `gt track --parent <ref>`
  only touches Graphite's own metadata db, so it works even while `<ref>`
  is checked out live in a different worktree — verified directly against
  that exact scenario too. (`gt parent` is the read-side check for "is this
  branch tracked" — note its `--quiet` suppresses stdout, so the **exit
  code** is the signal, not output text.)
- **The agent owns its commits; the pipeline guarantees convergence.** The
  executor session commits its own work (plain `git add`+`git commit`) and,
  on the graphite path, runs `gt submit` itself. After every session the
  pipeline then (a) commits anything left uncommitted as a **new** commit
  (`commitLeftoverChanges` — never an amend, which would silently rewrite a
  commit the agent may already have pushed) and (b) unconditionally
  (re)submits the branch (`submitPhaseBranch`): `gt submit` for graphite
  (idempotent; creates the PR if missing, pushes new commits, force-pushes
  a rewritten branch after a fixer reset), or `git push --force-with-lease`
  + `gh pr create`-if-missing for the git path. **This "always resubmit"
  replaced a real latent bug**: the old `submitPullRequest` early-returned
  whenever a PR already existed for the branch, so a fixer attempt's
  rewritten commits never actually reached an already-open PR — the PR
  silently kept showing attempt 1's code.
- **Fixer-loop worktree reset target: the phase branch's own initial
  commit, never the parent branch.** `createPhaseWorktree` always produces
  exactly one (empty) commit on the new branch before the agent ever runs.
  Every fixer attempt starts from `git reset --hard <initialCommitSha>` +
  `git clean -fd`, wiping the previous attempt's commits *and* leftovers.
  Resetting to the *parent* branch directly would collapse the phase branch
  onto the parent's own commit and the branch's history would bleed into
  the parent's.
- **`gt submit` has no flag for setting PR title/body non-interactively** —
  confirmed via `gt submit --help`. The flow always finalizes the real PR
  body via `gh pr edit --body-file` afterward, and always resolves the
  definitive PR via `gh pr view <branch>` rather than parsing either tool's
  stdout.
- **Graphite needs its own auth token**, separate from `gh auth` —
  `gt auth --token <token>` (token from
  https://app.graphite.com/activate). `branching.stack_tool: git` is the
  fallback that needs none of this (plain `git push` + `gh pr create
  --base`), and produces the same branch-stacking shape.

## 7. `phaseWorkflow` + the WORKLOG.md contract

One phase, one child workflow execution (per `retryGeneration`, §4). Loop
body (`for (attempt = 0; attempt <= max_fix_attempts; attempt++)`):
1. `attempt === 0`: build the **executor** prompt — which is deliberately
   thin, because the issue is the context: "Plan an implementation of
   GitHub issue #N by reading all the contents (`gh issue view N
   --comments`) … You are implementing phase k of T ONLY", plus the
   operational contract (where the worktree is, commit + `gt submit`, no
   `gt create`, comment back deviations via `gh issue comment`) and the
   WORKLOG contract. `attempt > 0`: reset the worktree, build the **fixer**
   prompt with the previous attempt's failure reason baked in
   (`agent_crashed` | `worklog_contract_violation` | `declared_blocked` |
   `gate_failure`).
2. `runAgent` — the Claude CLI invocation. `AgentResult.ok` answers **only**
   "did the process exit cleanly," nothing about task success.
3. If `!agentResult.ok`: that's `agent_crashed`, skip straight to the retry
   decision (no worklog to read — the process never got that far).
4. Otherwise `readAndClearWorklog` parses the required `WORKLOG.md`
   contract. A missing file or missing section throws
   `WorklogContractViolationError` → `worklog_contract_violation`, also
   straight to the retry decision.
5. Otherwise: post the worklog as a phase-labeled comment on the root
   issue, **immediately file discovered tasks**, run advisory gates, commit
   leftovers, (re)submit the PR, write the PR body. Then branch on
   `worklog.status`: `"blocked"` → `declared_blocked`, retry decision.
   `"done"` with `policy.local_gates: blocking` and a failing gate →
   `gate_failure`, retry decision. `"done"` and gates pass (or are
   advisory) → return `{status: "done", headBranch, prNumber, prUrl}` (the
   parent ticks the checkbox).
6. Retry decision: `attempt === max_fix_attempts` → post a parked-comment on
   the root issue with a `pipeline:stalled` label, return
   `{status: "parked", …}`. Otherwise loop again (worktree reset first, at
   the top of the next iteration).

**WORKLOG.md**: executor/fixer prompts require the agent to write it at the
worktree root with `##` sections `Done`, `Deviations from spec`,
`Surprises / new findings`, `Follow-ups`, **`Discovered tasks`** (optional
in the parser — an agent forgetting it shouldn't fail the phase; required
by the prompt), and a final literal `## Status: done|blocked` line.
`readAndClearWorklog` parses it, then **renames** it to
`WORKLOG.md.processed` rather than deleting it — a retry landing after a
crash between "rename" and "return" (Temporal activities are at-least-once)
finds the `.processed` file and re-parses from there instead of falsely
throwing "missing."

**Discovered tasks → sub-issues.** Each `- <title> -- <context>` bullet in
that section becomes a sub-issue of the root issue (`fileDiscoveredTasks` →
`createDiscoveredTaskIssue`), with the body recording which phase surfaced
it. Idempotent **by title** among the parent's existing sub-issues, which
covers both Temporal activity retries and a fixer attempt re-reporting the
same discovery. The agent is explicitly told NOT to create issues itself —
one writer, one dedupe point.

**`AgentResult` vs. `WorklogSections` is a deliberate, load-bearing split,
not two representations of the same thing.** `AgentResult` (core) is the
adapter's own report on whether the CLI process ran; `WorklogSections`
(parsed in activities) is the agent's *self-reported* claim about the
actual task. Collapsing these (e.g. treating "process exited 0" as "task
done") would make a crashed-before-writing-WORKLOG.md agent silently look
successful.

**The section-header regex** (`/^##\s+([^\n]+)\n?/`) had a real bug during
initial testing: an earlier version used a non-greedy `(.+?)` followed by
an entirely-optional `\s*\n?` tail. Since the whole tail could match zero
characters, the non-greedy capture stopped after matching just one
character ("D" instead of "Done") — every real worklog failed with
"missing required section." Caught by the unit test in
`packages/activities/src/agents.test.ts`, not by manual testing — if you
touch this parser, run that test file, don't just eyeball the regex.

## 8. Human-in-the-loop surface (signals/queries + CLI)

Defined once in `packages/core/src/signals.ts`, shared by worker
(`setHandler`) and CLI (typed `handle.signal`/`handle.query`):

| Signal / query | CLI | Valid when | Effect |
|---|---|---|---|
| `questionsAnswered` | `pipe answer <ref> <n> "<text>"` | awaiting_answers | Records the answer to question n of the *current* round; when all are in, answers are posted to the issue and the planner re-runs |
| `resume` | `pipe resume <ref>` | parked | Retries the parked phase as a new child execution |
| `skip` | `pipe skip <ref>` | parked | Ticks the phase with a "skipped by human" note and advances |
| `abort` | `pipe abort <ref>` | any non-terminal | Ends the workflow (comment posted, `pipeline:in-progress` removed) |
| `checkMerges` | `pipe check <ref>` | awaiting_merge | Polls PR states now instead of waiting out the interval |
| `status` query | `pipe status <ref>` | always | Stage, per-phase status/branch/PR, pending questions |

`pipe status` without an argument is the old connectivity check.

## 9. Adapter (packages/adapters/src)

Claude only. The CLI contract was verified directly against real
invocations (not assumed from docs), because the alternative — a subtly
wrong flag silently breaking every executor run — is exactly the failure
mode this layer exists to prevent:

- `claude -p --output-format json --permission-mode <mode>`, prompt on
  stdin. `plan` for the planner (Claude Code **plan mode**: read-only
  exploration of the checkout it's pointed at — the planner's whole job is
  to read code and answer with JSON), `bypassPermissions` for
  executor/fixer — the worktree sandboxing is the safety boundary, not the
  permission mode ("the blast radius is a branch, worst case is a bad
  PR"). Executor/fixer sessions *need* the loose mode: their contract
  includes running `gh issue view/comment` and `gt submit` unattended.
- No `--max-turns` flag exists (checked the full help output) — only
  `--max-budget-usd`, which is what `roles.<role>.max_budget_usd` feeds.
- Confirmed JSON result shape via a real call: `{type: "result", is_error:
  bool, result: string, num_turns, total_cost_usd, session_id, subtype}`.
  `session_id` is captured into `AgentResult.meta` — unused today, but
  it's what `claude --resume <session-id>` would need if fixer attempts
  ever want to continue the executor's session instead of starting fresh
  (deliberately not done: fresh sessions that re-read the issue are the
  point of GitHub-as-memory).
- **Why codex was removed** (history, so nobody re-adds it casually): it
  was never load-bearing — the codex CLI installed where this was built
  was far behind the API's model roster and failed outright, so all roles
  already defaulted to claude. Going single-vendor deleted a second prompt
  dialect, a second output-parsing path, and a second failure mode, in
  exchange for a one-line enum change if it ever comes back.
- **Heartbeating**: `adapters/src/process.ts`'s `spawnWithTimeout` accepts
  an `onProgress` callback wired to `Context.current().heartbeat()` (via a
  deferred `require("@temporalio/activity")`, so adapters stay callable
  outside a real activity context — e.g. from tests — without throwing).
  Fires every ~10s with the CLI's last output line, comfortably under the
  30s `heartbeatTimeout` the workflow proxies set. Without this, Temporal
  would kill a legitimately-still-running multi-minute agent process for
  "missing heartbeat" regardless of actual progress.

## 10. Workflow ID reuse policy

`pipe start` uses `WorkflowIdReusePolicy.ALLOW_DUPLICATE_FAILED_ONLY`, not
`REJECT_DUPLICATE`. This was a real bug in the first version: `REJECT_
DUPLICATE` blocks starting a new execution under an issue's workflow ID
after *any* prior execution closed, including a failed one — so the very
first bug hit in live testing (the label bug above) would have permanently
wedged that issue's pipeline, recoverable only by manually terminating the
old workflow execution via the Temporal UI/client. `ALLOW_DUPLICATE_FAILED_
ONLY` gives the actually-wanted semantics: block re-running an issue whose
pipeline already *completed successfully*, freely allow retrying one that
failed/was terminated/was cancelled. A still-running execution is
unaffected either way — `signalWithStart` just delivers the signal to it.
(Continue-as-new is unaffected too: the new execution continues under the
same workflow ID as part of the same execution chain.)

## 11. Local infra (docker/docker-compose.yml)

Postgres (`ipl-postgres`, 5433), Temporal (`ipl-temporal`, 7833),
Temporal UI (`ipl-temporal-ui`, 8833) — all on non-default ports so this
stack can't collide with another Temporal/Postgres setup on the same
machine. `.env`'s `TEMPORAL_ADDRESS`/`TEMPORAL_NAMESPACE` are required with
no fallback default, specifically so a misconfigured worker can never
silently register against the wrong cluster.

**Healthcheck gotcha**: `temporal-server --env docker` (what
`temporalio/auto-setup` runs) binds to the container's own bridge-network
IP, not `127.0.0.1` — a `127.0.0.1:7233` healthcheck inside the container
will never succeed even though the server is up and fully healthy. The
working healthcheck targets the Compose *service name* (`temporal:7233`),
which resolves correctly via Docker's embedded DNS even from within the
same container: `["CMD", "temporal", "operator", "cluster", "health",
"--address", "temporal:7233"]`.

## 12. Roadmap: what upgrading this next actually involves

**M4 — event bridge.** The design this was scoped against calls for a
60-second polling `BridgePollWorkflow` (Temporal Schedules can only start
*workflows*, never bare activities — confirmed against the SDK — so the
bridge is necessarily a short-lived workflow, not a raw scheduled
activity). It needs: an activity that lists `pipeline:ready` issues without
a running pipeline workflow and `signalWithStart`s them (via a Client held
inside that one activity — workflow code can't hold a `Client` directly,
but `getExternalWorkflowHandle(workflowId)` from `@temporalio/workflow` can
signal an already-running workflow with no Client at all); an activity that
scans unprocessed comments on issues carrying a `pipeline:*` state label for
`/resume /skip /abort /answer N: text /check` and routes them to the right
signal based on the issue's current label; and de-duplication via a
bot-reaction marker on already-processed comments. None of
`issue.ts`/`phase.ts` need to change — the signals and workflow-ID scheme
already exist in `packages/core/src/signals.ts` for exactly this.

**`pipe repo add` / `pipe init`.** Needs a pure "given pipeline.yaml's raw
text and a new repo entry, return the edited text" function in core (safe
there — no `fs`, just string/YAML-document manipulation), with the actual
file read/write happening in the CLI command itself (the CLI can use
`node:fs` directly in its own command files; the "cli never imports
activities" rule is about not depending on the *activities package*, not a
ban on the CLI doing any I/O of its own).

**`stack_final_gate`.** After the last phase, run the full configured gate
suite against the stack's top branch; on failure, a fixer loop targeting
whichever phase branch owns the failing code, followed by a restack
(`gt restack` cascades automatically to descendants after an ancestor is
amended — confirmed via `gt modify --help`). The natural place is between
the execution loop and the merge wait in `issueWorkflow`.

**Reviewer role / mid-stack rework (M5).** The adapter/config plumbing for
a fourth role already generalizes cleanly (`AgentRole` in
`packages/core/src/contracts/agent.ts` is currently `"planner" | "executor"
| "fixer"` — add `"reviewer"`, plus a `ReviewerOutput` schema and prompt
template alongside the existing ones in `packages/adapters/src/prompts/`).
The harder part is wiring an automated review step into `phaseWorkflow`
without weakening the "checkbox ticked = phase advanced" invariant —
reviewer-rejects should probably feed the existing fixer loop (a new
`FailureReason` variant) rather than becoming a third, separate retry
mechanism. The merge wait also gives M5 a natural home for *mid-stack
rework*: a `CLOSED` PR discovered during the poll could re-open a fixer
child for that phase instead of just warning.
