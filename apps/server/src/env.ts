import * as path from "node:path";
import dotenv from "dotenv";

// Mirrors apps/worker/src/env.ts and apps/cli/src/env.ts (deliberately
// duplicated per app -- see the comment there): the repo's .env carries
// TEMPORAL_ADDRESS / TEMPORAL_NAMESPACE / APP_DATABASE_URL. Resolved
// relative to this file so it works from src/ (tsx) and dist/ (node) alike;
// variables already present in the environment win because dotenv never
// overrides.
dotenv.config({ path: path.resolve(__dirname, "../../../.env"), quiet: true });

/**
 * Listen port, taken from PIPELINE_API_URL so this server and the
 * frontend's /api proxy target (apps/web/vite.config.ts) always agree.
 */
export function serverPort(): number {
  const raw = process.env.PIPELINE_API_URL;
  if (!raw) return 8846;
  try {
    return Number(new URL(raw).port) || 8846;
  } catch {
    return 8846;
  }
}
