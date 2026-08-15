# issue-pipeline

Runs a GitHub issue end-to-end with Claude: plans it in Claude Code plan
mode, gets human sign-off on open questions, implements each phase in an
isolated git worktree as a stacked PR (Graphite), and keeps watching until
the whole stack merges -- then closes the issue.

One issue == one long-lived Temporal **entity workflow** (`issueWorkflow`).
The GitHub issue itself is the persistent memory between agent sessions:

- The issue **body** holds the human-written task description plus a
  checkbox **phase checklist** the pipeline maintains (phases are task-list
  items, *not* sub-issues).
- The **plan** is posted as a comment (`## Implementation plan`), produced
  by Claude plan mode against a real checkout of the repo.
- Every open question in the plan **blocks implementation** until answered
  via `pipe answer` (Temporal human-in-the-loop); answers are recorded as
  comments and the plan is re-generated with them baked in.
- Each phase runs in a **fresh Claude session** that starts by reading the
  issue (`gh issue view <n> --comments`), implements its one phase, commits,
  submits the PR with `gt submit`, and comments back anything it learned.
  Its structured WORKLOG is also posted as a phase-labeled comment.
- New out-of-scope work an agent discovers is filed **immediately as a
  sub-issue** of the root issue (the only remaining use of sub-issues),
  recording which phase surfaced it.
- After the last phase, the workflow stays alive and **polls every 15
  minutes** (configurable) until every phase PR is merged, then closes the
  issue as completed.

See [DESIGN.md](DESIGN.md) for the full architecture, the reasoning behind
every non-obvious decision, a running list of real bugs already found and
fixed, and a concrete roadmap for what's not built yet.

## Prerequisites

- Node 24.6+, pnpm 10+, Docker
- `just` (`brew install just`)
- `gh` CLI, authenticated (`gh auth status`) with `repo` scope
- SSH access to GitHub (the pipeline clones target repos over SSH)
- `claude` CLI (Claude Code), logged in -- the only agent this pipeline uses
- Graphite CLI (`gt`), **with an auth token set** — `gt auth --token <token>`,
  token from https://app.graphite.com/activate. Required for the default
  `stack_tool: graphite`; without it, PR submission will fail. If you'd
  rather skip this for now, set `branching.stack_tool: git` in
  `pipeline.yaml` instead (plain `git push` + `gh pr create`, no stacking).

## Setup

```bash
pnpm install
cp .env.example .env
cp pipeline.example.yaml pipeline.yaml
```

Edit `.env`: set `PIPELINE_CONFIG_PATH` to the **absolute** path of the
`pipeline.yaml` you just created (a relative path resolves wrong — activities
run with cwd set to whichever package invoked them, not the repo root).

Edit `pipeline.yaml`'s `repos:` map to register at least one target repo —
the repo the pipeline will actually check out and work in:

```yaml
repos:
  my-repo:
    github: my-org/my-repo        # owner/repo
    local_path: ~/pipelines/my-repo/.repo   # bare clone -- created automatically on first use
    default_branch: main
```

You don't need to `git clone` this yourself — `ensureBareClone` creates the
bare clone at `local_path` the first time a pipeline touches that repo, and
every phase's worktree is cut from there. **Your own working checkout of
that repo is never touched.**

## Running it

```bash
just infra-up   # Postgres + Temporal + Temporal UI (Docker, isolated ports: 5433/7833/8833)
just worker     # starts the Temporal worker (foreground)
```

Or both together: `just up`. Temporal Web UI: http://localhost:8833

Write the task as a GitHub issue (a human- or AI-written description of what
you want done -- it does not need to contain a plan; planning is the
pipeline's first step). Then, in another terminal:

```bash
just pipe start https://github.com/my-org/my-repo/issues/123
just pipe status https://github.com/my-org/my-repo/issues/123   # live stage/phases/PRs (no arg: connectivity check)
just pipe check  https://github.com/my-org/my-repo/issues/123   # poll PR merge states now
just pipe resume https://github.com/my-org/my-repo/issues/123   # retry a parked phase
just pipe skip   https://github.com/my-org/my-repo/issues/123   # skip a parked phase
just pipe abort  https://github.com/my-org/my-repo/issues/123
```

`answer` and any `--note` take free-text that can contain spaces -- `just`'s
argument passthrough doesn't preserve quoting, so run those directly instead:

```bash
pnpm --filter @issue-pipeline/cli build
node apps/cli/dist/index.js answer https://github.com/my-org/my-repo/issues/123 1 "Use Postgres"
```

The lifecycle `start` kicks off: plan (Claude plan mode, in a read-only
checkout) → plan posted as a comment → **every** open question answered by a
human (`pipe answer`, plan re-generated with answers) → phase checklist
written into the issue body → phases executed sequentially (fresh Claude
session + worktree + stacked PR each; checkbox ticked as each finishes) →
poll until all PRs merge → issue closed as completed.

A phase that fails after its fix attempts are exhausted parks the pipeline
and posts a comment on the issue explaining what happened;
`resume`/`skip`/`abort` unblock it.

Progress is visible in the Temporal UI (workflow history, and the executor's
last output line via heartbeat) and on the GitHub issue itself (checklist,
comments, labels).

## Inspecting a run

`pipe status` shows the live stage / phases / PRs. For deeper inspection a
run leaves its trail in four places: Temporal history, the worktrees on
disk (while the issue is still in flight — they're cleaned up on close),
the Claude session transcripts, and the GitHub issue/PRs.

Workflow IDs are derived, not random, so you can construct them:

- issue: `pipeline-<owner>-<repo>-<issue-number>`
- phase: `<issue-id>-phase-<0-based-index>-r<retry-generation>` — e.g.
  `pipeline-my-org-my-repo-123-phase-0-r0` is phase 1's first run; `-r1` is
  the same phase re-run after a `pipe resume`.

### Temporal history

The UI is the fastest way to read a run, since it decodes activity
inputs/outputs for you. Deep-link straight to an issue workflow (no run ID
needed — it resolves to the latest run of that ID):

```bash
open http://localhost:8833/namespaces/issue-pipeline/workflows/pipeline-my-org-my-repo-123
```

Its **Relationships** tab links the per-phase child workflows. In a phase's
**Event History**, each `runAgent` result carries the agent's full summary
plus `meta.sessionId` / `costUsd` / `numTurns`; a failed activity's failure
event carries the agent's stdout.

There's no `temporal` CLI on the host — it ships inside the server image, so
shell into that container, and address the server by its compose name
(`temporal:7233`), not the host-side port:

```bash
docker exec ipl-temporal temporal workflow list --address temporal:7233 --namespace issue-pipeline
```

```bash
docker exec ipl-temporal temporal workflow show --address temporal:7233 --namespace issue-pipeline --workflow-id pipeline-my-org-my-repo-123-phase-0-r0
```

Add `--run-id` to target an earlier execution — a bare `--workflow-id`
resolves to the latest run, and one workflow ID accumulates runs two ways:
re-running `pipe start` after a failed execution, and the merge-wait loop's
continue-as-new, which by design rolls a long-lived issue workflow onto a
fresh run with fresh history. On an issue that's been sitting in merge-wait,
the planning events (and the links to the phase children) live in the
*earlier* runs, not the latest one; the UI's run list on the workflow page
gets you to them.

`--output json` gives the full history machine-readably, but every payload
comes back base64-encoded (the UI decodes them; the CLI doesn't). To pull the
agent results — session ID, cost, turn count — out of one phase:

```bash
docker exec ipl-temporal temporal workflow show --address temporal:7233 --namespace issue-pipeline --workflow-id pipeline-my-org-my-repo-123-phase-0-r0 --output json | jq -r '[.events[] | select(.eventType=="EVENT_TYPE_ACTIVITY_TASK_SCHEDULED" and .activityTaskScheduledEventAttributes.activityType.name=="runAgent") | .eventId] as $ids | .events[] | select(.eventType=="EVENT_TYPE_ACTIVITY_TASK_COMPLETED" and (.activityTaskCompletedEventAttributes.scheduledEventId | IN($ids[]))) | .activityTaskCompletedEventAttributes.result.payloads[0].data' | base64 -d | jq '{ok, summary, meta}'
```

### Agent session transcripts

Claude Code stores transcripts per working directory, so which directory an
agent ran in determines where its session lands — the path is flattened with
`/` and `.` both becoming `-`:

- executor and fixer run in the phase worktree →
  `~/.claude/projects/-Users-<you>-pipelines-<repo>-phases-<issue>-p<N>/<session-id>.jsonl`
- the planner runs in the planning worktree →
  `~/.claude/projects/-Users-<you>-pipelines-<repo>-phases-<issue>-planning/<session-id>.jsonl`

The `.jsonl` is the whole turn-by-turn transcript: every tool call and file
edit. Transcripts outlive the worktrees — they're not touched by
`cleanupIssueWorktrees`. To read one interactively instead, resume it from
the same directory the agent ran in (Claude Code looks sessions up by cwd,
so a session resumed from anywhere else won't be found; if the issue already
closed and the worktree was cleaned up, `mkdir -p` the path first):

```bash
cd ~/pipelines/my-repo/phases/123/p1 && claude --resume <session-id>
```

### Worktrees and GitHub

While an issue is in flight, worktrees live at
`~/pipelines/<repo-key>/phases/<issue>/` (`planning/` plus `p<N>/` per
phase), where `<repo-key>` is the key under `repos:` in `pipeline.yaml`.
Each phase worktree sits on its phase branch with the executor's commits and
a `WORKLOG.md.processed` — the phase's WORKLOG contract file, renamed once
the workflow consumed it. `git log`, `git diff <parent-branch>`, and
`gt log` all work there. When the issue closes as completed,
`cleanupIssueWorktrees` removes them (the bare clone stays); an aborted or
parked pipeline leaves them in place.

On GitHub everything lands on the root issue: the plan, Q&A, per-phase
worklog comments (`## Phase k/N worklog`), park explanations, and merge-wait
status. A parked pipeline also labels the issue `pipeline:stalled`.
Discovered out-of-scope work shows up as sub-issues.

## Development

```bash
pnpm turbo run build typecheck lint test   # everything, all packages
pnpm --filter @issue-pipeline/worker test  # one package
```

Package layout: `packages/core` (types/schemas/signals, no I/O — safe to
import from Temporal workflow code), `packages/adapters` (the claude CLI
wrapper + prompt templates), `packages/activities` (GitHub/git/gates, the
actual I/O layer), `apps/worker` (the Temporal worker + `issue.ts`/
`phase.ts` workflows), `apps/cli` (the `pipe` command).

## Troubleshooting

- `just infra-up` hangs or the temporal container is unhealthy: `docker logs
  ipl-temporal` — most often a stale volume from an earlier config; `just
  infra-nuke` wipes it (also wipes workflow history).
- `pipe` commands fail with a missing-env error: check `.env` is present and
  `PIPELINE_CONFIG_PATH` is absolute.
- A phase parks immediately: check the comment it posts on the issue, and
  the worker's own stdout (agent stdout is included in activity failures).
