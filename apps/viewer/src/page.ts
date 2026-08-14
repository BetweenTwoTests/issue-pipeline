/**
 * The whole frontend, embedded as a string: tsc emits plain JS to dist/ and
 * copies no assets, so a single self-contained page keeps the build step
 * honest (no asset-copy scripts). Vanilla JS + CSS, no CDN, localhost only.
 */
export function renderPage(): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>issue-pipeline sessions</title>
<style>
  :root {
    --bg: #1a1915; --bg2: #211f1a; --panel: #262420; --border: #3a372f;
    --text: #e8e4da; --dim: #a09a8c; --accent: #d97757; --accent-dim: #b4562f;
    --planner: #7aa2f7; --executor: #9ece6a; --fixer: #e0af68; --err: #f7768e;
    --mono: ui-monospace, SFMono-Regular, Menlo, monospace;
  }
  * { box-sizing: border-box; }
  body { margin: 0; background: var(--bg); color: var(--text);
         font: 14px/1.5 -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
         display: flex; height: 100vh; overflow: hidden; }
  #sidebar { width: 340px; min-width: 340px; border-right: 1px solid var(--border);
             overflow-y: auto; background: var(--bg2); }
  #sidebar header { padding: 14px 16px 10px; position: sticky; top: 0; background: var(--bg2);
                    border-bottom: 1px solid var(--border); z-index: 2; }
  #sidebar h1 { margin: 0; font-size: 15px; font-weight: 650; color: var(--accent); }
  #sidebar h1 span { color: var(--dim); font-weight: 400; }
  .group-h { padding: 10px 16px 4px; font-size: 11px; text-transform: uppercase;
             letter-spacing: .08em; color: var(--dim); }
  .sess { display: block; width: 100%; text-align: left; border: 0; cursor: pointer;
          background: transparent; color: var(--text); padding: 8px 16px;
          border-left: 3px solid transparent; font: inherit; }
  .sess:hover { background: var(--panel); }
  .sess.active { background: var(--panel); border-left-color: var(--accent); }
  .sess .row1 { display: flex; gap: 8px; align-items: center; }
  .sess .row2 { color: var(--dim); font-size: 12px; margin-top: 2px; display: flex; gap: 10px; }
  .badge { font-size: 10.5px; font-weight: 700; padding: 1px 7px; border-radius: 9px;
           text-transform: uppercase; letter-spacing: .04em; color: #16150f; }
  .badge.planner { background: var(--planner); }
  .badge.executor { background: var(--executor); }
  .badge.fixer { background: var(--fixer); }
  .badge.other { background: var(--dim); }
  .dot { width: 8px; height: 8px; border-radius: 50%; flex: none; }
  .dot.ok { background: var(--executor); } .dot.bad { background: var(--err); }
  .dot.unknown { background: var(--dim); }
  #main { flex: 1; overflow-y: auto; padding: 0 0 60px; }
  #main .head { position: sticky; top: 0; background: var(--bg); z-index: 2;
                padding: 14px 22px; border-bottom: 1px solid var(--border); }
  #main .head h2 { margin: 0 0 2px; font-size: 16px; }
  #main .head .meta { color: var(--dim); font-size: 12px; font-family: var(--mono); }
  #events { padding: 16px 22px; max-width: 980px; }
  .ev { margin: 10px 0; }
  .ev .label { font-size: 11px; text-transform: uppercase; letter-spacing: .07em;
               color: var(--dim); margin-bottom: 3px; }
  .card { background: var(--panel); border: 1px solid var(--border); border-radius: 8px;
          padding: 10px 14px; overflow-x: auto; }
  .assistant .card { border-left: 3px solid var(--accent); }
  pre { margin: 0; white-space: pre-wrap; word-break: break-word; font-family: var(--mono);
        font-size: 12.5px; }
  details { background: var(--panel); border: 1px solid var(--border); border-radius: 8px; }
  details summary { cursor: pointer; padding: 7px 12px; color: var(--dim);
                    font-family: var(--mono); font-size: 12.5px; user-select: none; }
  details summary .tname { color: var(--fixer); font-weight: 700; }
  details[data-err="1"] summary .tname { color: var(--err); }
  details > div { padding: 4px 14px 12px; border-top: 1px solid var(--border); }
  .thinking summary { font-style: italic; }
  .sidechain-tag { color: var(--planner); font-size: 10.5px; margin-left: 6px; }
  #empty { color: var(--dim); padding: 60px; text-align: center; }
  label.live { float: right; color: var(--dim); font-size: 12px; user-select: none; }
  a { color: var(--accent); }
</style>
</head>
<body>
<nav id="sidebar">
  <header>
    <h1>issue-pipeline <span>/ agent sessions</span></h1>
  </header>
  <div id="list"></div>
</nav>
<section id="main">
  <div id="empty">Select a session. Sessions appear here as the pipeline runs
    (indexed in <code>~/pipelines/agent-sessions.jsonl</code>, transcripts read
    from Claude Code's own store).</div>
</section>
<script>
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));
const state = { sessions: [], selected: null, live: true, renderedRawLength: null };

function fmtTime(iso) {
  if (!iso) return "";
  const d = new Date(iso);
  return d.toLocaleDateString(undefined, { month: "short", day: "numeric" }) + " " +
         d.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
}
function roleClass(role) {
  if (role === "planner" || role === "executor" || role === "fixer") return role;
  return "other";
}
function stageLabel(s) {
  const phase = s.phaseNumber != null ? "phase " + s.phaseNumber : "planning";
  const attempt = s.attempt != null ? (s.role === "planner" ? " · round " + s.attempt : " · attempt " + s.attempt) : "";
  return phase + attempt;
}

async function refreshSessions() {
  const res = await fetch("/api/sessions");
  const data = await res.json();
  state.sessions = data.sessions;
  const groups = new Map();
  for (const s of state.sessions) {
    const key = (s.repoSlug || s.repoName || "unknown repo") + (s.issueNumber != null ? " #" + s.issueNumber : "");
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(s);
  }
  let html = "";
  for (const [key, sessions] of groups) {
    html += '<div class="group-h">' + esc(key) + "</div>";
    for (const s of sessions) {
      const ok = s.ok === null ? "unknown" : (s.ok ? "ok" : "bad");
      const cost = s.costUsd != null ? "$" + s.costUsd.toFixed(2) : "";
      const size = s.sizeBytes ? Math.round(s.sizeBytes / 1024) + " KB" : "no transcript";
      const active = s.sessionId === state.selected ? " active" : "";
      html += '<button class="sess' + active + '" data-id="' + esc(s.sessionId) + '"' +
        (s.transcriptPath ? "" : " disabled") + ">" +
        '<div class="row1"><span class="dot ' + ok + '"></span>' +
        '<span class="badge ' + roleClass(s.role) + '">' + esc(s.role || "?") + "</span>" +
        "<span>" + esc(stageLabel(s)) + "</span>" +
        (s.source === "discovered" ? '<span class="sidechain-tag">unindexed</span>' : "") +
        "</div>" +
        '<div class="row2"><span>' + esc(fmtTime(s.startedAt)) + "</span><span>" + esc(cost) +
        "</span><span>" + esc(size) + "</span></div></button>";
    }
  }
  document.getElementById("list").innerHTML = html || '<div class="group-h">no sessions yet</div>';
  for (const btn of document.querySelectorAll(".sess[data-id]")) {
    btn.addEventListener("click", () => openSession(btn.getAttribute("data-id")));
  }
}

function renderEvent(ev) {
  const side = ev.sidechain ? '<span class="sidechain-tag">subagent</span>' : "";
  if (ev.kind === "prompt") {
    return '<div class="ev"><details><summary>prompt' + side + " (" + ev.text.length +
      ' chars)</summary><div><pre>' + esc(ev.text) + "</pre></div></details></div>";
  }
  if (ev.kind === "assistant_text") {
    return '<div class="ev assistant"><div class="label">claude' + side + "</div>" +
      '<div class="card"><pre>' + esc(ev.text) + "</pre></div></div>";
  }
  if (ev.kind === "thinking") {
    return '<div class="ev"><details class="thinking"><summary>thinking' + side +
      '</summary><div><pre>' + esc(ev.text) + "</pre></div></details></div>";
  }
  if (ev.kind === "tool_use") {
    return '<div class="ev"><details><summary><span class="tname">' + esc(ev.toolName) +
      "</span> " + esc(ev.toolPreview || "") + side + '</summary><div><pre>' +
      esc(ev.toolInput) + "</pre></div></details></div>";
  }
  if (ev.kind === "tool_result") {
    const err = ev.isError ? ' data-err="1"' : "";
    const label = ev.isError ? "result (error)" : "result";
    return '<div class="ev"><details' + err + '><summary><span class="tname">' + label +
      "</span> " + esc((ev.text || "").slice(0, 100)) + side + '</summary><div><pre>' +
      esc(ev.text) + "</pre></div></details></div>";
  }
  return "";
}

async function openSession(id, opts) {
  const isRefresh = state.selected === id && opts && opts.onlyIfChanged;
  state.selected = id;
  const res = await fetch("/api/transcript?id=" + encodeURIComponent(id));
  const main = document.getElementById("main");
  if (!res.ok) {
    main.innerHTML = '<div id="empty">transcript not found for ' + esc(id) + "</div>";
    return;
  }
  const data = await res.json();
  // Live refresh: leave the DOM (and every <details> the user opened)
  // untouched unless the transcript actually grew.
  if (isRefresh && data.rawLength === state.renderedRawLength) return;
  state.renderedRawLength = data.rawLength;
  const s = state.sessions.find((x) => x.sessionId === id) || {};
  const metaBits = [
    id,
    s.workflowId,
    s.cwd,
    s.costUsd != null ? "$" + s.costUsd.toFixed(2) : null,
    s.numTurns != null ? s.numTurns + " turns" : null,
    data.malformedLines ? data.malformedLines + " malformed lines" : null,
  ].filter(Boolean).map(esc).join(" · ");
  const title = data.title || ((s.role || "session") + " — " + stageLabel(s));
  main.innerHTML =
    '<div class="head"><label class="live"><input type="checkbox" id="live"' +
    (state.live ? " checked" : "") + "> live</label><h2>" + esc(title) + "</h2>" +
    '<div class="meta">' + metaBits + "</div></div>" +
    '<div id="events">' + data.events.map(renderEvent).join("") + "</div>";
  document.getElementById("live").addEventListener("change", (e) => { state.live = e.target.checked; });
  if (!(opts && opts.keepScroll)) main.scrollTop = 0;
  refreshSessions();
}

setInterval(() => {
  refreshSessions();
  if (state.selected && state.live) {
    const main = document.getElementById("main");
    const nearBottom = main.scrollHeight - main.scrollTop - main.clientHeight < 200;
    const prevScroll = main.scrollTop;
    openSession(state.selected, { keepScroll: true, onlyIfChanged: true }).then(() => {
      main.scrollTop = nearBottom ? main.scrollHeight : prevScroll;
    });
  }
}, 4000);
refreshSessions();
</script>
</body>
</html>`;
}
