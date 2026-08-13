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

# Build every package/app
build:
    pnpm turbo run build

# Run a one-off `pipe` CLI command, e.g. `just pipe status`
pipe *ARGS:
    pnpm --filter @issue-pipeline/cli exec pipe {{ARGS}}
