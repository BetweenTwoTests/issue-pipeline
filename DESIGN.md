# issue-pipeline — Design & Implementation Notes

This documents the system **as built**, not the original proposal it came
from. Where the two differ, this doc wins — it reflects what actually runs,
what actually broke during real testing, and why things are shaped the way
they are. Read [CLAUDE.md](CLAUDE.md) first for commands and the short
version of the architecture; come here for the rationale, the bug history,
and the roadmap.

## 1. What it does

Turns an issue containing a plan into a sequence of sub-issues, runs each
phase with an AI agent in an isolated git worktree, and opens a stacked PR
per phase. The pipeline's own Postgres (`packages/store`, the "app
database") is the source of truth for plan and progress -- issues,
sub-issues, comments, labels -- browsed through the web app; Temporal is
the runtime; git branches are the workspace state. GitHub's remaining
roles: hosting the repos and PRs (real state -- code review happens
there), and optionally receiving a one-way mirror of the tracker
(`sync.provider: github`, §5). Nothing about plan/progress is ever read
back from GitHub.

## 2. Scope: implemented vs. deferred

| Milestone | Status |
|---|---|
| M0 — scaffold (Turborepo, Docker/Temporal infra, hello-world round-trip) | Done |
| M1 — decompose (root issue → planner → sub-issues, blocking/non-blocking open questions) | Done |
| M2 — single phase end-to-end (worktree → executor → WORKLOG.md → gates → PR) | Done |
| M3 — sequential loop + stacking (parent loops children, Graphite/git stacking, fixer loop) | Built and live-tested. `stack_final_gate` (whole-stack CI gate before merge) is **not** built. |
| M4 — event bridge (polling `pipeline:ready`) | **Not built.** Pipelines are started/un-parked via the `pipe` CLI and the web app. |
| M5 — reviewer role, mid-stack rework, Codex-as-executor validation | **Not built** (reviewer role); Codex adapter exists and works but isn't the default (see §8). |

Other things intentionally not built: the optional plan-approval gate (the
original proposal had it off-by-default; cut to simplify PlanWorkflow's
state machine — no functionality lost, just never exercised), `pipe repo
add`/`pipe init` (repos are registered by hand-editing `pipeline.yaml`
against `pipeline.example.yaml`).

Caveat on "live-tested": M1–M3 were live-tested when tracker state was kept
on GitHub issues. The tracker now lives in the app database (§5) behind the
same activity contracts, and that swap — plus the optional GitHub mirror —
has unit/integration coverage but no live multi-phase run yet.

## 3. Package architecture

```
apps/worker  → packages/activities → packages/adapters → packages/core
                                   → packages/store    → packages/core
apps/cli     → packages/core (only — never activities or store)
apps/server  → packages/core + packages/store (never activities/adapters)
```

**Where the tracker lives.** `packages/store` owns the Prisma schema and
repository functions for the app database. Both writers go through it: the
worker's tracker activities (`packages/activities/src/tracker.ts`) and the
web backend (`apps/server`). It stays free of Temporal, gh, git, and agent
concerns — a pure repository layer returning the record shapes defined in
`packages/core/src/contracts/tracker.ts`. The CLI deliberately does *not*
get store access: issue creation is a web/API concern, and keeping the CLI
a pure Temporal client preserves "every pipeline action flows through
Temporal" (the one exception, issue CRUD, is data entry — not a pipeline
action).

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
when the worker actually starts. The fix was to delete that function from
core entirely and duplicate a ~30-line env loader directly in
`apps/worker/src/env.ts` and `apps/cli/src/env.ts` (they can't share it via
activities either, since cli must never depend on activities). If you're
tempted to add a "shared utility" to core, first ask whether it touches
`fs`/`child_process`/`net`/`node:path` — if yes, it belongs in `activities`
or a per-app file, never core.

**Why cli never imports activities.** Keeps the CLI a thin, safe Temporal
client — every real action (GitHub calls, git operations, agent execution)
flows through Temporal so it's observable/retryable/durable. `pipe start`
only ever calls `client.workflow.signalWithStart`; `resume`/`skip`/`abort`/
`answer` only ever call `handle.signal(...)`.

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

## 4. The two workflows

### `planWorkflow` (apps/worker/src/workflows/plan.ts)

1. Load `pipeline.yaml`, resolve the registered repo by GitHub owner/repo
   (not by the `repos:` map key — the workflow only ever receives
   owner/repo/issue# from the CLI).
2. `ensureBareClone` + `fetchRepo` (idempotent — safe even if another
   pipeline already set this repo up).
3. Fetch the root issue, flip its label from `pipeline:ready` (if applied
   manually — nothing in this build applies it) to `pipeline:in-progress`.
4. Run the planner once. Partition `open_questions` by `.blocking`. Any
   non-blocking ones get posted as an "assumptions made" comment. Any
   blocking ones pause the workflow (`condition()` with a 72h timeout that
   re-arms and posts a `pipeline:stalled` label + reminder comment if it
   fires) until answered via `pipe answer` or the pipeline is aborted; then
   the planner runs a **second** time with the answers appended to the
   prompt, and *that* output is what gets turned into sub-issues. (If there
   are no blocking questions, the first pass's output is final.)
5. Create one sub-issue per phase (via `createSubIssue`, idempotent —
   checks `listSubIssues` for an existing `{parent, phase}` match first),
   embedding a machine-readable `<!-- pipeline: {...} -->` metadata comment
   in the body (parsed by `parseSubIssueMetadata` in core).
6. Sequential loop: `executeChild(phaseWorkflow, ...)` per phase, stacking
   `baseBranch` forward to whatever branch the previous phase produced.
   A child returning `{status: "parked"}` pauses the *parent* awaiting
   `resume`/`skip`/`abort`. `resume` retries the same phase index as a
   **new child workflow execution** (see `retryGeneration` below); `skip`
   closes that phase's sub-issue as skipped and advances anyway.

**Decision: `phaseWorkflow` fetches its own handoff context, rather than
`planWorkflow` forwarding it.** The parent only ever passes
`priorSubIssueNumbers: number[]` (pointers) to each child. The child's own
`buildExecutorPrompt` activity fetches and formats prior phases' worklog
comments right before building the prompt. This keeps `planWorkflow`'s own
persisted workflow state to small scalars (per the general Temporal
guidance: don't grow per-iteration state with content that belongs in an
external system) — if the parent forwarded growing worklog text through
every child's start args instead, that text would transit the parent's own
event history on every single phase, not just the one child that needs it.

### `phaseWorkflow` (apps/worker/src/workflows/phase.ts)

One phase, one child workflow execution, per the retry-generation counter
described below. Loop body (`for (attempt = 0; attempt <= max_fix_attempts;
attempt++)`):
1. `attempt === 0`: build the **executor** prompt. `attempt > 0`: reset the
   worktree, build the **fixer** prompt with the previous attempt's failure
   reason baked in (`agent_crashed` | `worklog_contract_violation` |
   `declared_blocked` | `gate_failure`).
2. `runAgent` — the actual CLI invocation. `AgentResult.ok` answers **only**
   "did the process exit cleanly," nothing about task success.
3. If `!agentResult.ok`: that's `agent_crashed`, skip straight to the retry
   decision (no worklog to read — the process never got that far).
4. Otherwise `readAndClearWorklog` parses the required `WORKLOG.md`
   contract. A missing file or missing section throws
   `WorklogContractViolationError` → `worklog_contract_violation`, also
   straight to the retry decision.
5. Otherwise: post the worklog as a sub-issue comment, run advisory gates,
   commit, submit/update the PR (idempotent either way), write the PR body.
   Then branch on `worklog.status`: `"blocked"` → `declared_blocked`, retry
   decision. `"done"` with `policy.local_gates: blocking` and a failing
   gate → `gate_failure`, retry decision. `"done"` and gates pass (or are
   advisory) → close the sub-issue, return `{status: "done", headBranch}`.
6. Retry decision: `attempt === max_fix_attempts` → post a parked-comment on
   the **root** issue (not the sub-issue — see below) with a
   `pipeline:stalled` label, return `{status: "parked", headBranch}`.
   Otherwise loop again (worktree gets reset first, at the top of the next
   iteration).

**`AgentResult` vs. `WorklogSections` is a deliberate, load-bearing split,
not two representations of the same thing.** `AgentResult` (in
`packages/core/src/contracts/agent.ts`) is the adapter's own report on
whether the CLI process ran; `WorklogSections` (parsed by
`readAndClearWorklog` in `packages/activities/src/agents.ts`) is the agent's
*self-reported* claim about the actual task. Collapsing these (e.g. treating
"process exited 0" as "task done") would make a crashed-before-writing-
WORKLOG.md agent silently look successful.

**Two different "attempt" counters, not one.** `phaseWorkflow`'s own `for`
loop (executor + up to `max_fix_attempts` fixer retries) all happens inside
**one** workflow execution — Temporal-level activity retries are
deliberately disabled for `runAgent` (`retry: { maximumAttempts: 1 }`,
since agent runs aren't idempotent; recovery is this semantic loop on a
freshly reset worktree, never a blind re-run of the same attempt).
Separately, `planWorkflow` tracks a per-phase `retryGeneration`, bumped only
when a human sends `/resume` after `phaseWorkflow` has already returned
`parked` (i.e., after its *entire* internal fixer loop is exhausted) — this
produces a **new child workflow execution** with a derived ID
(`${parentId}-phase-${index}-r${retryGeneration}`), because a Temporal child
workflow that already completed can't be "resumed," only re-started fresh.

**Fixer-loop worktree reset target: the phase branch's own initial commit,
never the parent branch.** `createPhaseWorktree` always produces exactly one
commit on the new branch before the agent ever runs (Graphite's own
documented behavior for `gt create` with no staged changes; the plain-git
path creates one explicitly with `--allow-empty` to match). Every attempt
after the first amends that same commit (`gt modify` / `git commit
--amend`). Resetting to the *parent* branch directly, instead of to this
captured `initialCommitSha`, would collapse the phase branch onto the
parent's own commit — and the next amend would then rewrite the *parent's*
history instead of the phase's own.

## 5. Tracker persistence (packages/store) and the one-way sync seam

**The tracker is Postgres, not GitHub.** The workflows' tracker operations
(`fetchRootIssue`, `createSubIssue`, `postComment`, `postWorklogComment`,
`addLabels`/`removeLabels`, `closeSubIssue` in
`packages/activities/src/tracker.ts`) kept their names and
`(RegisteredRepo, issueNumber)` signatures across the GitHub→Postgres move,
so `plan.ts`/`phase.ts` are indifferent to where tracker state lives.
Numbers are a per-repo sequence allocated by the store (refs still read
`owner/repo#123`), and the plan workflow ID scheme
(`pipeline-<owner>-<repo>-<n>`) is unchanged. Root issues are created by
humans (web UI "New issue" / POST /api/issues) — `fetchRootIssue` throws
`TrackerIssueNotFoundError` rather than ever creating one implicitly, and
the server pre-checks existence on start so a bad ref fails the POST, not
the workflow.

- **Sub-issue idempotency is a DB constraint, not a list-scan.** The old
  GitHub path re-listed sub-issues and matched an embedded
  `<!-- pipeline: {...} -->` metadata comment to survive Temporal's
  at-least-once retries; the store enforces one sub-issue per
  `(parentId, phase)` with a unique index and returns the existing row on
  a repeat create. Phase metadata (parent, phase, base branch) is
  first-class columns, so sub-issue bodies stay clean markdown.
- **Comment authorship is data.** Comments carry `author` +
  `authorKind` (`pipeline` | `agent` | `human`). The executor prompt's
  prior-phase handoff context selects `authorKind = "agent"` worklog
  comments — a human comment pasted into a sub-issue can't leak into the
  prompt by starting with the right heading.
- **Control-plane comments live on the root issue, not the sub-issue.**
  Sub-issues accumulate the execution log (worklog comments); the root
  issue is where every "awaiting X" comment and state label goes, and where
  a parked phase's explanation gets posted — one place for a human to look
  for "what does this pipeline need from me."

**The sync seam (one-way, Postgres → external).** Every tracker mutation,
after its Postgres write commits, emits a `TrackerSyncEvent`
(`issue_created` / `comment_added` / `labels_added` / `labels_removed` /
`issue_closed`, defined in `packages/core/src/contracts/tracker-sync.ts`)
through `mirrorTrackerEvent` in `packages/activities/src/tracker-sync.ts` —
a choke point that resolves `sync.provider` from pipeline.yaml and **never
throws**: mirroring is best-effort by contract, so an external-tracker
outage can't park a phase. `provider: none` (default) makes it a no-op.
`provider: github` (`tracker-sync-github.ts`) mirrors to GitHub issues on
the issue's own repo slug, mapping tracker→GitHub issue numbers in the
`issue_mirrors` table; issues are mirrored lazily on first event (enabling
sync mid-pipeline picks up from there), sub-issues are linked via the
GraphQL `addSubIssue` mutation and carry the `<!-- pipeline: {...} -->`
metadata comment with the *GitHub-side* parent number. Adding Linear later
= a new `TrackerSyncProvider` member + a `TrackerSyncPort` implementation +
a `resolveTrackerSync` case; workflows and store don't change. Known
limitation, on purpose: human comments written through the web UI are
server-side writes and don't pass through the activities choke point, so
they aren't mirrored — full-fidelity sync would be a store-level outbox
table drained by a scheduled workflow (see §11).

GitHub-mechanics facts that still govern the mirror path
(`packages/activities/src/github.ts`):

- **Sub-issues**: `gh` has no native sub-issue command (verified — checked
  `gh issue create --help`/`gh issue edit --help`, no `--parent` flag
  exists). Linking uses the GraphQL `addSubIssue` mutation with
  `subIssueUrl` (the child's plain URL, which `gh issue create` already
  prints — avoids a second lookup for the child's node ID) and
  `replaceParent: true` (idempotent).
- **Labels must exist on the repo before they can be added to *or removed
  from* an issue** — verified directly against a real repo:
  `gh issue edit --add-label`/`--remove-label` both fail with `'<label>'
  not found` for a label that was never created. `addGithubIssueLabels`
  auto-creates any missing label (`gh label create <name> --force`,
  idempotent) and retries once; `removeGithubIssueLabels` treats "label
  doesn't exist" as an already-satisfied no-op.

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
- **Phase worktrees** live at a fixed path derived from `os.homedir()`, the
  repo's `pipeline.yaml` key name, the root issue number, and the phase
  number (`buildPhaseWorktreePath` in core) — **independent of whatever
  custom `local_path` was chosen for the bare clone.**
- **Every phase branch (including phase 1) is created via `git worktree add
  --detach <path> <parentRef>` then `gt create <name> --onto <parentRef>`**
  (or `git checkout -b` for the plain-git path) — never `worktree add -b`
  directly. A branch already checked out in one worktree can't be checked
  out in a second one; detaching at the parent's tip first and
  materializing the new branch *inside* the worktree is Graphite's own
  documented fix for this, and happens to make phase 1 (parentRef = trunk)
  and phase N>1 (parentRef = previous phase's branch) the same code path.
- **`gt submit` has no flag for setting PR title/body non-interactively** —
  confirmed via `gt submit --help`. The flow always finalizes the real PR
  body via `gh pr edit --body-file` afterward, regardless of which stack
  tool opened the PR, and always resolves the definitive PR via `gh pr view
  <branch>` rather than parsing either tool's stdout.
- **Graphite needs its own auth token**, separate from `gh auth` —
  `gt auth --token <token>` (token from
  https://app.graphite.com/activate). Not configured on the machine this
  was built on. `branching.stack_tool: git` is the fallback that needs none
  of this (plain `git push` + `gh pr create --base`), and produces the same
  branch-stacking shape.

## 7. The WORKLOG.md contract (packages/activities/src/agents.ts)

Executor/fixer prompts require the agent to write `WORKLOG.md` at the
worktree root with five `##` sections in order: `Done`, `Deviations from
spec`, `Surprises / new findings`, `Follow-ups`, and a final literal
`## Status: done` or `## Status: blocked` line. `readAndClearWorklog`
parses it, then **renames** it to `WORKLOG.md.processed` rather than
deleting it — a retry landing after a crash between "rename" and "return"
(Temporal activities are at-least-once) finds the `.processed` file and
re-parses from there instead of falsely throwing "missing."

The section-header regex (`/^##\s+([^\n]+)\n?/`) had a real bug during
initial testing: an earlier version used a non-greedy `(.+?)` followed by
an entirely-optional `\s*\n?` tail. Since the whole tail could match zero
characters, the non-greedy capture stopped after matching just one
character ("D" instead of "Done") — every real worklog failed with
"missing required section." Caught by the unit test in
`packages/activities/src/agents.test.ts`, not by manual testing — if you
touch this parser, run that test file, don't just eyeball the regex.

## 8. Adapters (packages/adapters/src)

Both CLIs verified directly against real invocations (not assumed from
docs), because the alternative — a subtly wrong flag silently breaking
every executor run — is exactly the failure mode this layer exists to
prevent:

- **claude**: `-p --output-format json --permission-mode <mode>` (`plan`
  for the read-only planner, `bypassPermissions` for executor/fixer — the
  worktree sandboxing is the safety boundary, not the permission mode; see
  the original proposal's own reasoning: "blast radius is a branch, worst
  case is a bad PR"). No `--max-turns` flag exists (checked the full help
  output) — only `--max-budget-usd`. Confirmed JSON shape via a real call:
  `{type: "result", is_error: bool, result: string, num_turns,
  total_cost_usd, session_id, subtype}`.
- **codex**: `-a never exec --sandbox workspace-write --skip-git-repo-check
  --output-last-message <file>`. Two things confirmed the hard way: `-a`
  (approval policy) is a **top-level** flag and errors if placed after
  `exec` (`codex exec -a never` fails; `codex -a never exec` works).
  `--full-auto`'s default approval policy is "ask on failure" — in a
  headless activity with no human to answer, that hangs until the activity
  times out; `-a never` ("execution failures are immediately returned to
  the model") is the correct choice for unattended execution, not the
  more commonly-documented `--full-auto` shortcut.
- **Codex isn't the default adapter right now** — not an architectural
  choice, just that the `codex` CLI installed where this was built (brew,
  0.30.0) is far behind the API's current model roster and fails outright
  (`gpt-5.4 requires a newer version of Codex`); `npm i -g @openai/codex`
  has 0.147.0. All three roles default to `claude` in
  `pipeline.example.yaml` until that's resolved; swapping any role back is
  a one-line config edit (`adapter: codex`), not a code change.
- **Heartbeating**: `adapters/src/process.ts`'s `spawnWithTimeout` accepts
  an `onProgress` callback wired to `Context.current().heartbeat()` (via a
  deferred `require("@temporalio/activity")`, so adapters stay callable
  outside a real activity context — e.g. from tests — without throwing).
  Fires every ~10s with the CLI's last output line, comfortably under the
  30s `heartbeatTimeout` the workflow proxies set. Without this, Temporal
  would kill a legitimately-still-running multi-minute agent process for
  "missing heartbeat" regardless of actual progress.

## 9. Workflow ID reuse policy

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

## 10. Local infra (docker/docker-compose.yml)

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

## 11. Roadmap: what upgrading this next actually involves

**M4 — event bridge.** The design this was scoped against calls for a
60-second polling `BridgePollWorkflow` (Temporal Schedules can only start
*workflows*, never bare activities — confirmed against the SDK — so the
bridge is necessarily a short-lived workflow, not a raw scheduled
activity). With the tracker in Postgres the bridge's job simplifies to one
activity: list tracker issues labeled `pipeline:ready` that have no running
pipeline workflow and `signalWithStart` them (via a Client held inside that
one activity — workflow code can't hold a `Client` directly, but
`getExternalWorkflowHandle(workflowId)` from `@temporalio/workflow` can
signal an already-running workflow with no Client at all). The original
GitHub-comment command half (`/approve /resume /skip /abort /answer` parsed
out of issue comments) is superseded for the local tracker — the web UI
delivers those as Temporal signals directly — and reviving it for mirrored
GitHub issues would mean reading GitHub comments back, which the sync seam
deliberately never does; if that's ever wanted, it's a separate inbound
bridge with its own de-duplication (bot-reaction markers), not part of the
sync provider.

**Full-fidelity tracker sync.** The inline `mirrorTrackerEvent` choke point
covers pipeline-originated writes only. If mirroring must also cover
server-originated writes (human comments, future UI edits) and survive
worker crashes between the Postgres write and the mirror call, move the
seam down into `packages/store`: an outbox table appended in the same
transaction as each mutation, drained in order by a scheduled workflow (the
event bridge above is the natural host). The `TrackerSyncEvent` shape and
`issue_mirrors` mapping table are already provider-shaped for exactly that
upgrade.

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
(`gt restack` cascades automatically to descendants after `gt modify`
amends an ancestor — confirmed via `gt modify --help`).

**Reviewer role / mid-stack rework (M5).** The adapter/config plumbing for
a fourth role already generalizes cleanly (`AgentRole` in
`packages/core/src/contracts/agent.ts` is currently `"planner" | "executor"
| "fixer"` — add `"reviewer"`, plus a `ReviewerOutput` schema and prompt
template alongside the existing ones in `packages/adapters/src/prompts/`).
The harder part is wiring an automated review step into `phaseWorkflow`
without weakening the "closed sub-issue = phase advanced" invariant the
whole system leans on (§5) — reviewer-rejects should probably feed the
existing fixer loop (a new `FailureReason` variant) rather than becoming a
third, separate retry mechanism.

## 12. Web app: transcripts + pipeline console (apps/web + apps/server)

Two packages, one localhost product. `apps/server` is the backend that
powers the frontend and owns everything about how users interact with the
pipeline; `apps/web` is a React/Vite frontend that proxies `/api` to it.
`just server` + `just web` → http://127.0.0.1:8845 (frontend) over
http://127.0.0.1:8846 (backend). Pipeline behavior that users may want to
drive from the UI — starting runs, answering questions, and eventually
editing prompts/policies — belongs in `apps/server`, not in the frontend
and not in new CLI commands.

**apps/server** (CJS/tsc, the repo's standard package shape; workspace
imports: core only, never activities/adapters):

- **Transcripts**: reads `~/.claude/projects/<cwd-derived-dir>/<id>.jsonl`
  directly (Claude Code's internal store — undocumented, so the parser is
  deliberately defensive: unknown line/block types are skipped, malformed
  lines counted and surfaced, never thrown on) and serves parsed events —
  prompts, assistant text, thinking, tool calls paired with results by
  `tool_use_id`, subagent sidechain groups. Live tail is byte-offset
  polling: `/api/session?offset=<bytes>` returns only complete new lines (a
  torn trailing write is held back until the next poll, unless it already
  parses as complete JSON — a writer that just hasn't newline-terminated
  yet). Event ids are `<entry uuid>:<block index>` so React reconciliation
  preserves `<details>` open/closed state across appends — a re-render must
  never re-collapse what the reader opened.
- **Pipeline control**: lists `planWorkflow` executions, reads each one's
  `planStatusQuery` (which exposes the blocking questions with answered
  flags, the phase list, and the issue ref precisely so a UI can render an
  answer form from workflow state alone), starts pipelines
  (`signalWithStart` + kickoff, ALLOW_DUPLICATE_FAILED_ONLY — the same
  semantics as `pipe start`, plus a pre-check that the tracker issue exists
  and is a root issue, so a bad ref fails the POST rather than the
  workflow), and delivers human responses as Temporal signals —
  `questionsAnswered`, `resume`, `skip`, `abort` — through
  `@temporalio/client` in `src/pipelines.ts`. Never shell out to `pipe` for
  this: the workflow is the source of truth and the signal contracts live
  in core. Status queries are raced against a 3s timeout because they hang
  forever when no worker is running; unset TEMPORAL_ADDRESS/NAMESPACE →
  503, never a default address, matching the worker/CLI rule.
- **Issues**: `src/issues.ts` + the `/api/issues`, `/api/issue`,
  `/api/issue/comment`, `/api/repos` routes serve and mutate the tracker
  through `packages/store` — the issue list (with sub-issue progress
  counts), a full issue page (body, labels, sub-issues, comments), issue
  creation (validated against pipeline.yaml's registered repos, stored with
  the yaml's casing so tracker keys always match what the worker looks up),
  and human comments (`authorKind: "human"`). The frontend renders these as
  a GitHub-style issue page; agent worklogs and pipeline notices arrive as
  comments as phases run.
- **Persistence**: the app database — docker's `ipl-app-postgres`
  (postgres 18, port 5434), a separate server from Temporal's postgres so
  app migrations can never touch workflow history. The schema and Prisma
  client live in `packages/store` (shared with the worker's tracker
  activities, which is why it's a package and not server-local). Temporal
  stays the source of truth for execution state; the app DB is the source
  of truth for tracker state (issues/comments/labels) and holds the
  `pipeline_launches` audit rows (best-effort: a DB outage must never block
  starting a pipeline). `APP_DATABASE_URL` in .env; `just db-migrate`
  applies migrations.
- **Security**: binds 127.0.0.1 only — it serves the whole session store
  and can signal/start workflows. The `project`/`id` query params double as
  path segments under the store root; strict shape validation
  (directory-name charset, session UUID) is the path-traversal guard.
  Mutating POSTs require same-origin `application/json` (cross-origin
  callers hit a CORS preflight that fails, so a drive-by page cannot signal
  workflows through a loopback server). The frontend proxy keeps
  `changeOrigin: false` because this guard compares Origin against Host.

**apps/web** is the repo's only ESM/JSX/bundler-resolution package (`build`
is `tsc --noEmit && vite build`, still emitting `dist/**` so turbo caching
works unchanged); its workspace deps (`server`, `core`) are type-only, so
no backend code reaches the browser bundle. Don't copy its tsconfig for a
backend package.

The pipeline links back into the web app: worklog comments (executor/fixer,
per attempt) and the root issue's phase-map comment (planner) end with an
"Agent session transcript" footer deep-linking that run's session —
`buildTranscriptFooter` in `packages/activities/src/agents.ts`, URL shape
in `packages/core/src/transcript-link.ts` (which replicates Claude Code's
cwd→directory flattening). `PIPELINE_VIEWER_URL` (default
http://localhost:8845) feeds both the frontend's port and those links, so
one variable moves both; `PIPELINE_API_URL` (default http://localhost:8846)
does the same for the backend and the frontend's proxy target. The env
reads happen in activities/apps because workflow code cannot touch
`process.env`.
