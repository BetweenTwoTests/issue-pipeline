# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

A Temporal-orchestrated pipeline where **one GitHub issue == one long-lived
entity workflow**: Claude plan mode plans the issue against a real checkout,
every open question blocks until a human answers, each phase runs in a fresh
Claude session in an isolated git worktree and ships a stacked PR
(`gt submit`), phases are checkboxes on the issue body (not sub-issues), and
the workflow keeps polling until the whole stack merges before closing the
issue. See [DESIGN.md](DESIGN.md) for the full architecture, every
non-obvious decision and why, a running list of real bugs already found and
fixed (read this before "fixing" the same thing again), and what's
deliberately not built yet. This file is just commands + the constraints
that will bite you fastest.

## Commands

```bash
pnpm turbo run build typecheck lint test   # everything, all packages
pnpm --filter @issue-pipeline/worker test  # one package
```

Tests use Node's built-in test runner via `tsx`. **Always pass an explicit
glob, never a bare directory** — `node --test src` does not recursively
discover `*.test.ts` files the way you'd expect (it treats the bare path
as a single module specifier instead); the actual scripts use `node
--import tsx --test "src/**/*.test.ts"`. To run one test or a subset:

```bash
cd packages/core   # or wherever the test lives
node --import tsx --test --test-name-pattern="slugify" "src/**/*.test.ts"
```

The workflow tests (`apps/worker/src/workflows/*.test.ts`) need the local
Temporal stack running (`just infra-up`) — they use
`TestWorkflowEnvironment.createFromExistingServer` against localhost:7833.

Local infra + running it:
```bash
just infra-up   # Postgres + Temporal + Temporal UI (Docker, isolated ports 5433/7833/8833)
just worker     # Temporal worker (tsx watch — restart it manually after changing packages/activities
                # or packages/adapters; watch mode doesn't reliably pick up dependency dist/ rebuilds)
just pipe <args>  # the `pipe` CLI (builds apps/cli first, then runs it) -- e.g. `just pipe status`
just viewer     # agent-session transcript viewer, http://127.0.0.1:8844 (read-only, local files only)
```
`just pipe`'s argument passthrough does not preserve quoting for multi-word
text (`answer`'s `<text>`, any `--note`) — for those, run
`node apps/cli/dist/index.js <args>` directly after `pnpm --filter
@issue-pipeline/cli build`.

## Architecture

Turborepo monorepo with a strict one-way dependency graph:
`apps/worker` → `packages/activities` → `packages/adapters` → `packages/core`;
`apps/cli` → `packages/core` only (the CLI talks to Temporal purely via
`@temporalio/client` — it never imports activities); `apps/viewer` →
`packages/core` only (reads the local session index + Claude Code's own
transcript store; no Temporal, no network beyond serving 127.0.0.1).

**The determinism constraint that matters more than the dependency graph
diagram suggests:** `apps/worker/src/workflows/*.ts` (`issue.ts`, `phase.ts`)
run inside Temporal's workflow sandbox. Temporal's worker bundles everything
*reachable* from these files via webpack when the worker starts. That means:
- Workflow files may import **types only** from `@issue-pipeline/activities`
  (`import type * as activities from "@issue-pipeline/activities"` +
  `proxyActivities<typeof activities>()`) — never a runtime value.
- Workflow files may import **values** from `@issue-pipeline/core`, but only
  because core's entire export surface is deliberately kept pure (no
  `fs`/`child_process`/`node:path`-touching code anywhere in it, transitively).
  This is enforced by convention, not tooling — there's no lint rule for it.
  A `node:*`-touching helper landing in core's barrel breaks the *worker
  process actually starting* (webpack throws `UnhandledSchemeError` on
  `node:path`/etc.), not typecheck — `pnpm turbo run typecheck` will not
  catch this. If you add something to core, ask "does this do real I/O,"
  and if yes, put it in `activities` or a per-app file instead (see
  `apps/worker/src/env.ts` / `apps/cli/src/env.ts` — deliberately duplicated
  rather than shared through core, for exactly this reason). Running the
  workflow tests (`pnpm --filter @issue-pipeline/worker test`) DOES catch
  it — `Worker.create` in the tests performs the same webpack bundling.

Within `packages/activities`, activities are grouped by concern:
`github.ts` (gh CLI + GraphQL: issue/comment/label/checklist/PR-state ops,
discovered-task sub-issues), `git.ts` (bare clone / worktrees / submit),
`agents.ts` (the `runAgent` dispatcher — Claude only — plus the WORKLOG.md
and planner-JSON contract parsers and discovered-task filing), `gates.ts`
(advisory test/lint/build commands), `config.ts` (pipeline.yaml loading +
repo resolution). `packages/adapters` is the CLI-shelling layer underneath
`agents.ts` (`claude.ts` only, plus the prompt templates) — activities never
shell out to an agent directly, they go through the adapter.

**Two workflows:** `issueWorkflow` (the entity — `apps/worker/src/workflows/
issue.ts`) owns the whole issue lifecycle: plan-mode planning loop (re-plans
until zero open questions, every question answered by a human via `pipe
answer`), writes the phase checklist into the issue body, runs
`executeChild(phaseWorkflow, ...)` sequentially stacking each phase's branch
on the previous one's, then sits in a merge-poll loop (default 15 min,
`continueAsNew` when Temporal suggests it) until every phase PR merges, and
finally closes the issue as completed. `phaseWorkflow` owns one phase:
worktree → executor session (fresh Claude session that reads the issue via
`gh issue view --comments`) → WORKLOG.md parse → worklog comment +
discovered-task sub-issues → advisory gates → leftover-commit + `gt submit`
→ PR body. Two different "attempt" counters exist and are not
interchangeable: `phaseWorkflow`'s own `for` loop attempt (executor, then up
to `max_fix_attempts` fixer retries, all within *one* workflow execution,
resetting the worktree to its captured `initialCommitSha` between attempts —
never to the parent branch, which would corrupt the parent's history) vs.
`issueWorkflow`'s per-phase `retryGeneration` (bumped only when a human
sends `pipe resume` after a phase parks, producing a *new* child workflow
execution with a new ID).

Every phase branch — including phase 1 — is created via `git worktree add
--detach <path> <parentRef>` followed by `git checkout -B` + `gt track
--parent <parentRef>` (or plain checkout for `stack_tool: git`), never
`worktree add -b` or `gt create`. This is deliberate, not an oversight: a
branch already checked out in one worktree can't be checked out in another,
and `gt create` fails outright from a detached HEAD — which is also why the
executor prompt tells the agent to commit with plain git and submit with
`gt submit`, never to run `gt create` itself.

## Current scope

Implemented: the full single-issue lifecycle above (plan-mode planning with
blocking Q&A, checklist phases, sequential stacked execution, discovered-task
sub-issues, merge-wait, auto-close), live-tested predecessors for the
worktree/stacking layer. **Not built**: the polling event bridge /
GitHub-comment commands (M4) — pipelines are driven by the `pipe` CLI only,
not `/approve`-style comments; the reviewer role and mid-stack rework (M5);
`stack_final_gate`; `pipe repo add`/`pipe init` (register a target repo by
hand-editing `pipeline.yaml`, see `pipeline.example.yaml`). See DESIGN.md
for what building each of these next would actually involve.
