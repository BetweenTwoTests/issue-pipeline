set dotenv-load := true

# List all recipes
default:
    @just --list

# Start Postgres + Temporal + Temporal UI, wait for health
infra-up:
    docker compose -f docker/docker-compose.yml up -d --wait

# Stop the stack, keep the ipl-pgdata volume (Temporal history survives)
infra-down:
    docker compose -f docker/docker-compose.yml down

# Stop the stack AND delete the volume -- the only way to lose workflow history
infra-nuke:
    docker compose -f docker/docker-compose.yml down -v

# Tail infra logs
infra-logs:
    docker compose -f docker/docker-compose.yml logs -f

# Bring up infra, then run the worker in the foreground
up: infra-up worker

# Run the Temporal worker (auto-restarts on file change)
worker:
    pnpm --filter @issue-pipeline/worker dev

# Agent-session transcript viewer (read-only, http://127.0.0.1:8844)
viewer:
    pnpm --filter @issue-pipeline/viewer dev

# Build every package/app
build:
    pnpm turbo run build

# Run a one-off `pipe` CLI command, e.g. `just pipe status` or
# `just pipe start https://github.com/owner/repo/issues/123`.
# (direct node invocation, not `pnpm exec pipe` -- pnpm does not self-link a
# package's own `bin` entry into its own node_modules/.bin)
# NOTE: `just`'s variadic capture does not preserve quoting -- a quoted
# multi-word argument (e.g. `pipe answer`'s <text>, or --note) arrives here
# already split on whitespace. For those, build once then invoke node
# directly: `pnpm --filter @issue-pipeline/cli build && node apps/cli/dist/index.js answer <ref> 1 "answer text"`.
pipe *ARGS:
    pnpm --filter @issue-pipeline/cli build >/dev/null
    node apps/cli/dist/index.js {{ARGS}}
