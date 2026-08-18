import type { IncomingMessage, ServerResponse } from "node:http";
import { defaultRoot, isValidProjectName, listProjects, listSessions, readSessionChunk, SESSION_ID_RE } from "./store";

/**
 * Connect-style middleware serving the transcript API. Mounted inside
 * Vite's dev/preview server (see vite.config.ts), which binds loopback
 * only -- this handler must never be exposed on a routable interface, as
 * it reads the user's entire Claude Code session store.
 */
export function createApiMiddleware(root: string = defaultRoot()) {
  return async function transcriptApi(req: IncomingMessage, res: ServerResponse, next: () => void): Promise<void> {
    let url: URL;
    try {
      url = new URL(req.url ?? "/", "http://localhost");
    } catch {
      next();
      return;
    }
    if (!url.pathname.startsWith("/api/")) {
      next();
      return;
    }

    const send = (status: number, body: unknown): void => {
      res.writeHead(status, {
        "content-type": "application/json; charset=utf-8",
        "cache-control": "no-store",
      });
      res.end(JSON.stringify(body));
    };

    try {
      if (req.method !== "GET") {
        send(405, { error: "GET only" });
        return;
      }

      if (url.pathname === "/api/projects") {
        send(200, { projects: await listProjects(root) });
        return;
      }

      // For the routes below, project and id double as path segments under
      // the store root -- the strict shape checks (single directory-name
      // segment, session UUID) are what make path traversal impossible.
      const project = url.searchParams.get("project") ?? "";

      if (url.pathname === "/api/sessions") {
        if (!isValidProjectName(project)) {
          send(400, { error: "project must be a session-store directory name" });
          return;
        }
        try {
          send(200, { sessions: await listSessions(root, project) });
        } catch (err) {
          if ((err as NodeJS.ErrnoException).code === "ENOENT") {
            send(404, { error: `no such project: ${project}` });
            return;
          }
          throw err;
        }
        return;
      }

      if (url.pathname === "/api/session") {
        const id = url.searchParams.get("id") ?? "";
        if (!isValidProjectName(project)) {
          send(400, { error: "project must be a session-store directory name" });
          return;
        }
        if (!SESSION_ID_RE.test(id)) {
          send(400, { error: "id must be a session UUID" });
          return;
        }
        const offsetRaw = url.searchParams.get("offset") ?? "0";
        const offset = Number(offsetRaw);
        if (!Number.isSafeInteger(offset) || offset < 0) {
          send(400, { error: "offset must be a non-negative integer" });
          return;
        }
        try {
          send(200, await readSessionChunk(root, project, id, offset));
        } catch (err) {
          if ((err as NodeJS.ErrnoException).code === "ENOENT") {
            send(404, { error: `no transcript found for session ${id}` });
            return;
          }
          throw err;
        }
        return;
      }

      send(404, { error: "not found" });
    } catch (err) {
      send(500, { error: err instanceof Error ? err.message : String(err) });
    }
  };
}
