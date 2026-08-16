import react from "@vitejs/plugin-react";
import { defineConfig, type Plugin } from "vite";
import { createApiMiddleware } from "./src/server/api";

/**
 * Serves the transcript API inside Vite's own dev/preview server, so the
 * viewer is a single process with no separate backend to start or proxy to.
 */
function transcriptApi(): Plugin {
  return {
    name: "transcript-api",
    configureServer(server) {
      server.middlewares.use(createApiMiddleware());
    },
    configurePreviewServer(server) {
      server.middlewares.use(createApiMiddleware());
    },
  };
}

// PIPELINE_VIEWER_URL also drives the "Agent session transcript" links the
// pipeline appends to GitHub issue comments (packages/activities), so one
// env var moves both this server's port and every link pointing at it. Only
// the port is honored here -- the listen host stays loopback regardless of
// what the URL says.
function portFromEnv(): number {
  const raw = process.env.PIPELINE_VIEWER_URL;
  if (!raw) return 8845;
  try {
    return Number(new URL(raw).port) || 8845;
  } catch {
    return 8845;
  }
}
const port = portFromEnv();

// The API exposes the contents of ~/.claude/projects (full session
// transcripts: prompts, source code, tool output), so this server must only
// ever listen on loopback -- never run it with --host or a routable
// interface.
export default defineConfig({
  plugins: [react(), transcriptApi()],
  server: { host: "127.0.0.1", port, strictPort: true },
  preview: { host: "127.0.0.1", port, strictPort: true },
});
