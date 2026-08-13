# issue-pipeline

Turns a GitHub issue containing a plan into a sequence of sub-issues, executes
each phase with an AI agent in an isolated git worktree, and opens a stacked
PR per phase. Orchestrated by Temporal; GitHub issues/sub-issues are the
source of truth; git branches are the workspace state.

Currently implements: decompose a root issue into phases (with blocking/
non-blocking open-question handling), and run each phase end-to-end
(worktree → executor agent → WORKLOG.md contract → advisory gates → PR →
bounded fixer loop → park on failure). The polling event bridge and reviewer
role from the original design are not built yet — pipelines are started and
un-parked via the `pipe` CLI, not GitHub comments.

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
just infra-up   # Postgres + Temporal + Temporal UI (Docker, isolated ports: 5433/7833/8833)
just worker     # starts the Temporal worker (foreground)
```

Or both together: `just up`. Temporal Web UI: http://localhost:8833

In another terminal, use the CLI via `just pipe <args>`:

```bash
just pipe status                                    # connectivity check
just pipe start https://github.com/my-org/my-repo/issues/123
just pipe resume https://github.com/my-org/my-repo/issues/123
just pipe skip   https://github.com/my-org/my-repo/issues/123
just pipe abort  https://github.com/my-org/my-repo/issues/123
```

`answer` and any `--note` take free-text that can contain spaces -- `just`'s
argument passthrough doesn't preserve quoting, so run those directly instead:

```bash
pnpm --filter @issue-pipeline/cli build
node apps/cli/dist/index.js answer https://github.com/my-org/my-repo/issues/123 1 "Use Postgres"
```

`start` kicks off `PlanWorkflow` for that root issue: fetch → decompose into
phases → create sub-issues → run phases sequentially, each stacking its
branch on the previous phase's. A phase that fails after its fix attempts
are exhausted parks the whole pipeline and posts a comment on the root issue
explaining what happened; `resume`/`skip`/`abort` unblock it. `answer`
answers one of the plan's numbered blocking questions (posted as a comment
when decomposition can't proceed without a decision).

Progress is visible in the Temporal UI (workflow history, and the executor's
last output line via heartbeat) and as comments/labels on the GitHub issues
themselves.

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
CLI wrappers + prompt templates), `packages/activities` (GitHub/git/gates,
the actual I/O layer), `apps/worker` (the Temporal worker + `plan.ts`/
`phase.ts` workflows), `apps/cli` (the `pipe` command).

## Troubleshooting

- `just infra-up` hangs or the temporal container is unhealthy: `docker logs
  ipl-temporal` — most often a stale volume from an earlier config; `just
  infra-nuke` wipes it (also wipes workflow history).
- `pipe` commands fail with a missing-env error: check `.env` is present and
  `PIPELINE_CONFIG_PATH` is absolute.
- A phase parks immediately: check the comment it posts on the root issue,
  and the worker's own stdout (agent stdout is included in activity
  failures).
