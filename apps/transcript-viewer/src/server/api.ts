import type { IncomingMessage, ServerResponse } from "node:http";
import { parseAnswerRequest, parseControlRequest, WORKFLOW_ID_RE } from "./pipeline-requests";
import { getPipeline, listPipelines, signalAnswers, signalControl, TEMPORAL_UNCONFIGURED } from "./pipelines";
import { defaultRoot, isValidProjectName, listProjects, listSessions, readSessionChunk, SESSION_ID_RE } from "./store";

const MAX_BODY_BYTES = 64 * 1024;

async function readJsonBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of req) {
    const buf = chunk as Buffer;
    total += buf.length;
    if (total > MAX_BODY_BYTES) throw new Error(`request body exceeds ${MAX_BODY_BYTES} bytes`);
    chunks.push(buf);
  }
  const text = Buffer.concat(chunks).toString("utf8");
  if (text.trim() === "") throw new Error("request body must be JSON");
  return JSON.parse(text) as unknown;
}

/**
 * The POST endpoints signal running workflows, so a drive-by page must not
 * be able to trigger them: requiring application/json forces cross-origin
 * callers into a CORS preflight (which fails -- no CORS headers are served
 * here), and any Origin that is present must be this same loopback host.
 */
function rejectCrossOrigin(req: IncomingMessage): string | null {
  const contentType = String(req.headers["content-type"] ?? "")
    .split(";")[0]
    .trim()
    .toLowerCase();
  if (contentType !== "application/json") return "content-type must be application/json";
  const origin = req.headers.origin;
  if (typeof origin === "string" && origin !== "" && origin !== "null") {
    const host = req.headers.host;
    if (!host || origin !== `http://${host}`) return "cross-origin requests are not allowed";
  }
  return null;
}

/** Temporal-unconfigured -> 503, unknown workflow -> 404, else 500. */
function pipelineErrorStatus(err: unknown): number {
  if (err instanceof Error && err.message === TEMPORAL_UNCONFIGURED) return 503;
  const name = (err as { name?: string })?.name ?? "";
  if (name === "WorkflowNotFoundError") return 404;
  return 500;
}

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

    const sendPipelineError = (err: unknown): void => {
      send(pipelineErrorStatus(err), { error: err instanceof Error ? err.message : String(err) });
    };

    try {
      if (url.pathname === "/api/pipeline/answer" || url.pathname === "/api/pipeline/control") {
        if (req.method !== "POST") {
          send(405, { error: "POST only" });
          return;
        }
        const crossOrigin = rejectCrossOrigin(req);
        if (crossOrigin !== null) {
          send(403, { error: crossOrigin });
          return;
        }
        let body: unknown;
        try {
          body = await readJsonBody(req);
        } catch (err) {
          send(400, { error: err instanceof Error ? err.message : "invalid JSON body" });
          return;
        }
        try {
          if (url.pathname === "/api/pipeline/answer") {
            const parsed = parseAnswerRequest(body);
            if (!parsed.ok) {
              send(400, { error: parsed.error });
              return;
            }
            await signalAnswers(parsed.value.workflowId, parsed.value.answers);
          } else {
            const parsed = parseControlRequest(body);
            if (!parsed.ok) {
              send(400, { error: parsed.error });
              return;
            }
            await signalControl(parsed.value.workflowId, parsed.value.action, parsed.value.note);
          }
          send(200, { ok: true });
        } catch (err) {
          sendPipelineError(err);
        }
        return;
      }

      if (req.method !== "GET") {
        send(405, { error: "GET only" });
        return;
      }

      if (url.pathname === "/api/pipelines") {
        try {
          send(200, { pipelines: await listPipelines() });
        } catch (err) {
          sendPipelineError(err);
        }
        return;
      }

      if (url.pathname === "/api/pipeline") {
        const id = url.searchParams.get("id") ?? "";
        if (!WORKFLOW_ID_RE.test(id)) {
          send(400, { error: "id must be a workflow id" });
          return;
        }
        try {
          send(200, await getPipeline(id));
        } catch (err) {
          sendPipelineError(err);
        }
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
