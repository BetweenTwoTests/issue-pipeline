# issue-pipeline

Turns an issue containing a plan into a sequence of sub-issues, executes
each phase with an AI agent in an isolated git worktree, and opens a stacked
PR per phase. Orchestrated by Temporal. Issues, sub-issues, comments, and
labels live in the pipeline's own Postgres (browse them in the web app,
`just web`); git branches are the workspace state; GitHub is used for PRs
and, optionally, as a one-way mirror of the tracker (`sync.provider` in
`pipeline.yaml`).

Currently implements: decompose a root issue into phases (with blocking/
non-blocking open-question handling), and run each phase end-to-end
(worktree → executor agent → WORKLOG.md contract → advisory gates → PR →
bounded fixer loop → park on failure). The polling event bridge and reviewer
role from the original design are not built yet — pipelines are started and
un-parked via the `pipe` CLI, not GitHub comments.

See [DESIGN.md](DESIGN.md) for the full architecture, the reasoning behind
every non-obvious decision, a running list of real bugs already found and
fixed, and a concrete roadmap for what's not built yet.

## Prerequisites

- Node 24.6+, pnpm 10+, Docker
- `just` (`brew install just`)
- `gh` CLI, authenticated (`gh auth status`) with `repo` scope
- SSH access to GitHub (the pipeline clones target repos over SSH)
- `claude` CLI, logged in
- Graphite CLI (`gt`), **with an auth token set** — `gt auth --token <token>`,
  token from https://app.graphite.com/activate. Required for the default
  `stack_tool: graphite`; without it, PR submission will fail. If you'd
  rather skip this for now, set `branching.stack_tool: git` in
  `pipeline.yaml` instead (plain `git push` + `gh pr create`, no stacking).
- `codex` CLI — only needed if you switch a role to `adapter: codex`. Not
  used by default right now (see "Adapters" below).

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
just infra-up    # Postgres x2 + Temporal + Temporal UI (Docker, isolated ports: 5433/5434/7833/8833)
just db-migrate  # apply the app database's migrations (issue tracker lives there)
just worker      # starts the Temporal worker (foreground)
just server      # backend API (issues, pipelines, transcripts) -- http://127.0.0.1:8846
just web         # web app -- http://localhost:8845
```

Temporal Web UI: http://localhost:8833

**Create an issue first** — the plan the pipeline decomposes is the body of
a tracker issue in the app database, not a GitHub issue. Use the web app's
"New issue" form (pick a registered repo, paste the plan as the body), or
POST it:

```bash
curl -s -X POST http://127.0.0.1:8846/api/issues \
  -H 'content-type: application/json' \
  -d '{"repo": "my-org/my-repo", "title": "Add feature X", "body": "...the plan..."}'
```

Then start it — from the issue's page in the web app ("Start pipeline"), or
with the CLI via `just pipe <args>` (`#12` is the tracker issue number the
create step returned, not a GitHub number):

```bash
just pipe status                    # connectivity check
just pipe start  my-org/my-repo#12
just pipe resume my-org/my-repo#12
just pipe skip   my-org/my-repo#12
just pipe abort  my-org/my-repo#12
```

`answer` and any `--note` take free-text that can contain spaces -- `just`'s
argument passthrough doesn't preserve quoting, so run those directly instead:

```bash
pnpm --filter @issue-pipeline/cli build
node apps/cli/dist/index.js answer my-org/my-repo#12 1 "Use Postgres"
```

`start` kicks off `PlanWorkflow` for that root issue: fetch → decompose into
phases → create sub-issues → run phases sequentially, each stacking its
branch on the previous phase's. A phase that fails after its fix attempts
are exhausted parks the whole pipeline and posts a comment on the root issue
explaining what happened; `resume`/`skip`/`abort` unblock it. `answer`
answers one of the plan's numbered blocking questions (posted as a comment
when decomposition can't proceed without a decision). Answering and
resume/skip/abort also work from the issue's pipeline page in the web app.

Progress is visible in the web app (the issue page shows sub-issues,
worklog comments, and labels as they land) and in the Temporal UI (workflow
history, and the executor's last output line via heartbeat).

## Inspecting a run

A finished (or parked) run leaves its trail in four places: the tracker
issues in the web app (`just web`), Temporal history, the phase worktrees on
disk, and the GitHub PRs. There's no `pipe` subcommand for any of this —
`pipe status` only checks namespace connectivity.

Workflow IDs are derived, not random, so you can construct them:

- plan: `pipeline-<owner>-<repo>-<root-issue-number>`
- phase: `<plan-id>-phase-<0-based-index>-r<retry-generation>` — e.g.
  `pipeline-my-org-my-repo-123-phase-0-r0` is phase 1's first run; `-r1` is
  the same phase re-run after a `pipe resume`.

### Temporal history

The UI is the fastest way to read a run, since it decodes activity
inputs/outputs for you. Deep-link straight to a plan workflow (no run ID
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

Add `--run-id` to target an earlier execution: re-running `pipe start` on the
same root issue reuses the same workflow ID, and a bare `--workflow-id`
resolves to the latest one.

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
  `~/.claude/projects/-Users-<you>-pipelines-<repo>-phases-<root-issue>-p<N>/<session-id>.jsonl`
- the planner runs in the bare clone →
  `~/.claude/projects/-Users-<you>-pipelines-<repo>--repo/<session-id>.jsonl`
  (doubled dash — `.repo` flattens to `-repo`)

The `.jsonl` is the whole turn-by-turn transcript: every tool call and file
edit. To read it interactively instead, resume it from the same directory it
ran in (a session resumed from anywhere else won't be found):

```bash
cd ~/pipelines/my-repo/phases/123/p1 && claude --resume <session-id>
```

### Worktrees and the tracker

Phase worktrees are left in place after a run: `~/pipelines/<repo-key>/phases/
<root-issue>/p<N>`, where `<repo-key>` is the key under `repos:` in
`pipeline.yaml`. Each sits on its phase branch with the executor's commits and
a `WORKLOG.md.processed` — the phase's WORKLOG contract file, renamed once the
workflow consumed it. `git log`, `git diff <parent-branch>`, and `gt log` all
work there.

In the tracker (web app): each phase's WORKLOG is posted as a comment on
that phase's sub-issue, and a parked pipeline labels the root issue
`pipeline:stalled` and comments there with the failure reason. With
`sync.provider: github` in `pipeline.yaml`, all of it is additionally
mirrored one-way to GitHub issues.

## Adapters

Each role (`planner`, `executor`, `fixer`) in `pipeline.yaml` maps
independently to `claude` or `codex` — swapping is a config edit, not a code
change. All three default to `claude`. To use `codex` for a role, first
confirm your installed `codex` CLI is current (`codex --version`) — an
outdated CLI can silently fail with a model-version error at the API level.

## Development

```bash
pnpm turbo run build typecheck lint test   # everything, all packages
pnpm --filter @issue-pipeline/worker test  # one package
```

Package layout: `packages/core` (types/schemas/signals, no I/O — safe to
import from Temporal workflow code), `packages/adapters` (claude.ts/codex.ts
CLI wrappers + prompt templates), `packages/activities` (tracker/git/GitHub/
gates, the actual I/O layer), `packages/store` (Prisma schema + repositories
for the app database — the issue tracker), `apps/worker` (the Temporal
worker + `plan.ts`/`phase.ts` workflows), `apps/cli` (the `pipe` command),
`apps/server` + `apps/web` (the backend API and web app: issues, pipeline
control, transcripts).

## Troubleshooting

- `just infra-up` hangs or the temporal container is unhealthy: `docker logs
  ipl-temporal` — most often a stale volume from an earlier config; `just
  infra-nuke` wipes it (also wipes workflow history).
- `pipe` commands fail with a missing-env error: check `.env` is present and
  `PIPELINE_CONFIG_PATH` is absolute.
- A phase parks immediately: check the comment it posts on the root issue,
  and the worker's own stdout (agent stdout is included in activity
  failures).
