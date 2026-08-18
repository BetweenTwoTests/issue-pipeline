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

// The API exposes the contents of ~/.claude/projects (full session
// transcripts: prompts, source code, tool output), so this server must only
// ever listen on loopback -- never run it with --host or a routable
// interface.
export default defineConfig({
  plugins: [react(), transcriptApi()],
  server: { host: "127.0.0.1", port: 8845, strictPort: true },
  preview: { host: "127.0.0.1", port: 8845, strictPort: true },
});
