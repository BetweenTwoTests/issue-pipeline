import * as http from "node:http";
import { serverPort } from "./env";
import { createApiMiddleware } from "./api";

/**
 * The backend behind apps/web: session transcripts from ~/.claude/projects,
 * pipeline reads/signals/starts via Temporal, and the issue tracker in the
 * app database (packages/store). Binds loopback ONLY -- it serves the
 * user's entire Claude Code session store and can signal or start
 * workflows, so it must never listen on a routable interface.
 */
const HOST = "127.0.0.1";
const port = serverPort();
const api = createApiMiddleware();

const server = http.createServer((req, res) => {
  void api(req, res, () => {
    res.writeHead(404, { "content-type": "application/json; charset=utf-8" });
    res.end(JSON.stringify({ error: "not found" }));
  });
});

server.listen(port, HOST, () => {
  console.log(`[server] http://${HOST}:${port} (issue-pipeline backend, loopback only)`);
});
