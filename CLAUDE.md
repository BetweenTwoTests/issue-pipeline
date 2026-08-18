# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

A Temporal-orchestrated pipeline that decomposes a GitHub issue containing a
plan into sequential phases, executes each with an AI agent in an isolated
git worktree, and opens a stacked PR per phase. See [DESIGN.md](DESIGN.md)
for the full architecture, every non-obvious decision and why, a running
list of real bugs already found and fixed (read this before "fixing" the
same thing again), and what's deliberately not built yet. This file is
just commands + the constraints that will bite you fastest.

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

Local infra + running it:
```bash
just infra-up   # Postgres + Temporal + Temporal UI (Docker, isolated ports 5433/7833/8833)
just worker     # Temporal worker (tsx watch — restart it manually after changing packages/activities
                # or packages/adapters; watch mode doesn't reliably pick up dependency dist/ rebuilds)
just pipe <args>  # the `pipe` CLI (builds apps/cli first, then runs it) -- e.g. `just pipe status`
```
`just pipe`'s argument passthrough does not preserve quoting for multi-word
text (`answer`'s `<text>`, any `--note`) — for those, run
`node apps/cli/dist/index.js <args>` directly after `pnpm --filter
@issue-pipeline/cli build`.

## Architecture

Turborepo monorepo, five packages with a strict one-way dependency graph:
`apps/worker` → `packages/activities` → `packages/adapters` → `packages/core`;
`apps/cli` → `packages/core` only (the CLI talks to Temporal purely via
`@temporalio/client` — it never imports activities).

**The determinism constraint that matters more than the dependency graph
diagram suggests:** `apps/worker/src/workflows/*.ts` (`plan.ts`, `phase.ts`)
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
  rather than shared through core, for exactly this reason).

Within `packages/activities`, activities are grouped by concern:
`github.ts` (gh CLI + GraphQL), `git.ts` (bare clone / worktree / Graphite
stacking), `agents.ts` (the `runAgent` dispatcher + the WORKLOG.md and
planner-JSON contract parsers), `gates.ts` (advisory test/lint/build
commands), `config.ts` (pipeline.yaml loading + repo resolution).
`packages/adapters` is the CLI-shelling layer underneath `agents.ts`
(`claude.ts`, `codex.ts`, prompt templates) — activities never shell out
directly, they go through an adapter.

**Two workflows, one recursion-shaped relationship:** `planWorkflow` fetches
the root issue, runs the planner, handles blocking/non-blocking open
questions, creates sub-issues, then loops `executeChild(phaseWorkflow, ...)`
sequentially, stacking each phase's branch on the previous one's.
`phaseWorkflow` owns one phase: worktree → executor agent → WORKLOG.md
parse → advisory gates → PR → close-sub-issue-or-park. Two different
"attempt" counters exist and are not interchangeable: `phaseWorkflow`'s own
`for` loop attempt (executor, then up to `max_fix_attempts` fixer retries,
all within *one* workflow execution, resetting the worktree to its captured
`initialCommitSha` between attempts — never to the parent branch, which
would corrupt the parent's history on amend) vs. `planWorkflow`'s
per-phase `retryGeneration` (bumped only when a human sends `/resume` after
a phase parks, producing a *new* child workflow execution with a new ID).

Every phase branch — including phase 1 — is created via `git worktree add
--detach <path> <parentRef>` followed by `gt create --onto <parentRef>` (or
plain `git checkout -b` if `stack_tool: git`), never `worktree add -b`
directly. This is deliberate, not an oversight: a branch already checked out
in one worktree can't be checked out in another, and detaching first is
Graphite's own documented fix for that — treating phase 1 identically to
phase N>1 (parentRef = trunk vs. the previous phase's branch) is simpler
than special-casing it.

## Current scope

Implemented and live-tested against a real repo: decompose (M1), single- and
multi-phase sequential execution with Graphite/git stacking (M2 + most of
M3). **Not built**: the polling event bridge / GitHub-comment commands
(M4) — pipelines are driven by the `pipe` CLI only, not `/approve`-style
comments; the reviewer role and mid-stack rework (M5); `stack_final_gate`;
`pipe repo add`/`pipe init` (register a target repo by hand-editing
`pipeline.yaml`, see `pipeline.example.yaml`). See DESIGN.md for what
building each of these next would actually involve.

## Code comments and tests

Whenever you write or edit a code comment or a test, follow the
`timeless-comments` skill
([.claude/skills/timeless-comments/SKILL.md](.claude/skills/timeless-comments/SKILL.md)):
comments describe the code as it stands — no issue/PR numbers (except
`TODO(#123)`), no change-relative wording ("now", "previously", "used to
be"); rejected alternatives are stated in the present ("X, not Y: Y
would ..."). Tests must pass unchanged years from now: pin dates; the
local Dockerized Temporal + offline `git`/`gt` the tests already use are
fine, live external services are not. History worth keeping goes in
DESIGN.md's bug list, which is deliberately a change record.
