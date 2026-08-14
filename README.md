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
just pipe status https://github.com/my-org/my-repo/issues/123   # live stage/phases/PRs
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

## Pipeline state projection (the analysis DB)

Per Temporal's own guidance — workflow histories are the execution record,
analysis belongs in your own datastore — both workflows project every state
transition into a local SQLite database at `~/pipelines/pipeline.db`
(Node's built-in `node:sqlite`, no server, no dependency;
`PIPELINE_DB_PATH` overrides the location). Tables:

- `pipelines` — one row per issue: stage, phase progress, outcome, timestamps
- `phases` — per-phase status / branch / PR
- `events` — append-only transition log (plan rounds, answers, phase
  starts/parks/skips/resumes, per-attempt outcomes, merge-wait, completion)
- `agent_sessions` — one row per Claude session: role, phase, attempt,
  Claude Code session id, cost, turns, duration

It's a disposable read model: deleting the file loses analysis history,
never pipeline correctness (Temporal + the GitHub issue stay the sources of
truth). Query it with anything that speaks SQLite, e.g. cost per issue:

```bash
sqlite3 ~/pipelines/pipeline.db "SELECT repo_slug, issue_number, ROUND(SUM(cost_usd),2) AS usd, COUNT(*) AS sessions FROM agent_sessions GROUP BY 1,2 ORDER BY usd DESC"
```

## Viewing agent session transcripts

Every planner/executor/fixer run is a real `claude -p` session, and Claude
Code itself already stores the full transcript — every message, tool call,
and result — in its session store
(`~/.claude/projects/<cwd-derived-dir>/<session-id>.jsonl`). The projection
DB's `agent_sessions` table maps each pipeline stage to its session id, and
each phase's worklog comment on the issue carries the id and cost too.

```bash
just viewer   # read-only UI at http://127.0.0.1:8844
```

The viewer shows each pipeline (stage, phase progress, total cost) with its
projected event timeline, and every session grouped by repo/issue with
role + phase/attempt badges. Clicking a session renders the full transcript
(prompt, Claude's messages, thinking, collapsible tool calls/results) and
live-tails sessions that are still running. Transcripts from before the
projection DB existed are discovered by scanning the session store for
pipeline-shaped worktree paths and shown as "unindexed". Localhost-only by
design — transcripts contain source code and issue text.

To re-open a session interactively instead of viewing it, run
`claude --resume <session-id>` from that session's worktree directory
(works only while the worktree still exists — they're cleaned up when the
issue completes).

## Development

```bash
pnpm turbo run build typecheck lint test   # everything, all packages
pnpm --filter @issue-pipeline/worker test  # one package
```

Package layout: `packages/core` (types/schemas/signals, no I/O — safe to
import from Temporal workflow code), `packages/adapters` (the claude CLI
wrapper + prompt templates), `packages/activities` (GitHub/git/gates, the
actual I/O layer), `apps/worker` (the Temporal worker + `issue.ts`/
`phase.ts` workflows), `apps/cli` (the `pipe` command), `apps/viewer` (the
local transcript viewer — reads local files only, never talks to Temporal).

## Troubleshooting

- `just infra-up` hangs or the temporal container is unhealthy: `docker logs
  ipl-temporal` — most often a stale volume from an earlier config; `just
  infra-nuke` wipes it (also wipes workflow history).
- `pipe` commands fail with a missing-env error: check `.env` is present and
  `PIPELINE_CONFIG_PATH` is absolute.
- A phase parks immediately: check the comment it posts on the issue, and
  the worker's own stdout (agent stdout is included in activity failures).
