import path from "node:path";
import dotenv from "dotenv";

// Deliberately duplicated from apps/worker/src/env.ts rather than shared via
// @issue-pipeline/core: core's barrel is also imported (for values, not just
// types) by workflow code, and Temporal's workflow bundler traces that whole
// barrel -- node:path/dotenv living there would break the workflow sandbox
// build. cli can't reach a shared copy via activities either (cli must never
// depend on activities), so a small duplicated file is the simplest correct fix.
dotenv.config({ path: path.resolve(__dirname, "../../../.env"), quiet: true });

export interface TemporalConnectionConfig {
  address: string;
  namespace: string;
}

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value || value.trim() === "") {
    throw new Error(
      `Missing required environment variable ${name}. Set it in the repo's ` +
        `.env (see .env.example). This project never falls back to a bare ` +
        `default Temporal address/namespace -- only its own isolated stack.`,
    );
  }
  return value;
}

/**
 * Loads TEMPORAL_ADDRESS / TEMPORAL_NAMESPACE from the repo's .env. Throws
 * immediately if either is missing -- never silently defaults to
 * localhost:7233, so a bare shell env can't misdirect the CLI.
 */
export function loadTemporalConnectionConfig(): TemporalConnectionConfig {
  return {
    address: requireEnv("TEMPORAL_ADDRESS"),
    namespace: requireEnv("TEMPORAL_NAMESPACE"),
  };
}
