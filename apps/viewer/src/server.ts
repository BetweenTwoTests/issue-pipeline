import * as http from "node:http";
import { listSessions, listPipelines, listEvents, findTranscriptPath, readTranscriptRaw, SESSION_ID_RE } from "./store";
import { parseTranscript } from "./transcript";
import { renderPage } from "./page";

/**
 * Read-only local viewer for the pipeline's agent-session transcripts.
 * Binds 127.0.0.1 ONLY -- it serves the contents of ~/.claude/projects
 * (full agent transcripts, which can contain source code and issue text),
 * so it must never listen on a routable interface.
 */
const PORT = Number(process.env.VIEWER_PORT ?? 8844);
const HOST = "127.0.0.1";

function json(res: http.ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  res.end(payload);
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url ?? "/", `http://${HOST}:${PORT}`);

    if (req.method !== "GET") {
      json(res, 405, { error: "GET only" });
      return;
    }

    if (url.pathname === "/") {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      res.end(renderPage());
      return;
    }

    if (url.pathname === "/api/sessions") {
      json(res, 200, { sessions: await listSessions() });
      return;
    }

    if (url.pathname === "/api/pipelines") {
      json(res, 200, { pipelines: await listPipelines() });
      return;
    }

    if (url.pathname === "/api/events") {
      const workflowId = url.searchParams.get("workflowId") ?? "";
      // A bound SQL parameter, never a path -- length is the only guard needed.
      if (workflowId === "" || workflowId.length > 300) {
        json(res, 400, { error: "workflowId required" });
        return;
      }
      json(res, 200, { events: await listEvents(workflowId) });
      return;
    }

    if (url.pathname === "/api/transcript") {
      const id = url.searchParams.get("id") ?? "";
      // The id doubles as a filename inside the transcript store -- the
      // strict UUID shape check is what makes path traversal impossible.
      if (!SESSION_ID_RE.test(id)) {
        json(res, 400, { error: "id must be a session UUID" });
        return;
      }
      const transcriptPath = await findTranscriptPath(id);
      if (!transcriptPath) {
        json(res, 404, { error: `no transcript found for session ${id}` });
        return;
      }
      const raw = await readTranscriptRaw(transcriptPath);
      const parsed = parseTranscript(raw);
      // rawLength is the client's cheap change detector: the live poll only
      // re-renders (and so only resets <details> open/closed state) when the
      // underlying file actually grew.
      json(res, 200, { ...parsed, transcriptPath, rawLength: raw.length });
      return;
    }

    json(res, 404, { error: "not found" });
  } catch (err) {
    json(res, 500, { error: err instanceof Error ? err.message : String(err) });
  }
});

server.listen(PORT, HOST, () => {
  console.log(`[viewer] http://${HOST}:${PORT} (agent-session transcripts, read-only, localhost only)`);
});
