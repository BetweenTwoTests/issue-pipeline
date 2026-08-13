import path from "node:path";
import dotenv from "dotenv";

// This file is intentionally NOT part of @issue-pipeline/core: workflow
// files (workflows/*.ts) import values from core's barrel, and Temporal's
// workflow bundler traces that whole barrel -- if this lived in core,
// node:path/dotenv would get pulled into the workflow sandbox bundle and
// fail to build ("UnhandledSchemeError: Reading from node:path"). apps/cli
// keeps its own identical copy for the same reason (cli must never import
// activities, so it can't share this via that path either).
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
 * localhost:7233, so a bare shell env can't misdirect the worker.
 */
export function loadTemporalConnectionConfig(): TemporalConnectionConfig {
  return {
    address: requireEnv("TEMPORAL_ADDRESS"),
    namespace: requireEnv("TEMPORAL_NAMESPACE"),
  };
}
