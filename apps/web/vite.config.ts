import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

function portFromEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  try {
    return Number(new URL(raw).port) || fallback;
  } catch {
    return fallback;
  }
}

// PIPELINE_VIEWER_URL also drives the "Agent session transcript" links the
// pipeline appends to GitHub issue comments (packages/activities), so one
// env var moves both this dev server's port and every link pointing at it.
// Only the port is honored here -- the listen host stays loopback
// regardless of what the URL says.
const port = portFromEnv("PIPELINE_VIEWER_URL", 8845);

// The backend (apps/server) owns /api -- the transcript store, Temporal
// reads/signals/starts, and Prisma. This stays a pure proxy: no API code
// may live in the frontend process. changeOrigin must remain false: the
// backend's cross-origin guard compares the browser's Origin header to the
// forwarded Host, and rewriting Host would 403 every same-origin POST.
const apiProxy = {
  "/api": { target: `http://127.0.0.1:${portFromEnv("PIPELINE_API_URL", 8846)}`, changeOrigin: false },
};

export default defineConfig({
  plugins: [react()],
  server: { host: "127.0.0.1", port, strictPort: true, proxy: apiProxy },
  preview: { host: "127.0.0.1", port, strictPort: true, proxy: apiProxy },
});
