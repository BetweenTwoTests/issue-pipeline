import { useState } from "react";
import type { TranscriptEvent } from "../shared/types";
import { formatClock } from "./format";

/**
 * A transcript renders as a list of items: single events (with a tool_use
 * carrying its tool_result inline) and sidechain groups (a subagent's
 * events nested under one collapsible block).
 */
export type RenderItem =
  | { type: "event"; event: TranscriptEvent; result?: TranscriptEvent }
  | { type: "sidechain"; id: string; items: RenderItem[] };

export function buildRenderItems(events: TranscriptEvent[]): RenderItem[] {
  const resultByToolId = new Map<string, TranscriptEvent>();
  for (const e of events) {
    if (e.kind === "tool_result" && e.toolUseId && !resultByToolId.has(e.toolUseId)) {
      resultByToolId.set(e.toolUseId, e);
    }
  }
  // Results shown inline under their tool_use are dropped from the flow.
  const claimed = new Set<string>();
  for (const e of events) {
    if (e.kind === "tool_use" && e.toolUseId) {
      const result = resultByToolId.get(e.toolUseId);
      if (result) claimed.add(result.id);
    }
  }

  const buildRange = (range: TranscriptEvent[]): RenderItem[] => {
    const out: RenderItem[] = [];
    for (const e of range) {
      if (e.kind === "tool_result" && claimed.has(e.id)) continue;
      if (e.kind === "tool_use" && e.toolUseId) {
        out.push({ type: "event", event: e, result: resultByToolId.get(e.toolUseId) });
        continue;
      }
      out.push({ type: "event", event: e });
    }
    return out;
  };

  const items: RenderItem[] = [];
  let i = 0;
  while (i < events.length) {
    if (!events[i].sidechain) {
      items.push(...buildRange([events[i]]));
      i += 1;
      continue;
    }
    // A run of consecutive sidechain events with the same agent id is one
    // subagent conversation.
    const start = i;
    const agentKey = events[i].agentId;
    while (i < events.length && events[i].sidechain && events[i].agentId === agentKey) i += 1;
    const inner = buildRange(events.slice(start, i));
    if (inner.length > 0) items.push({ type: "sidechain", id: `sc-${events[start].id}`, items: inner });
  }
  return items;
}

function ClampedText({ text, limit }: { text: string; limit: number }) {
  const [expanded, setExpanded] = useState(false);
  if (text.length <= limit) return <pre className="body-text">{text}</pre>;
  return (
    <div>
      <pre className="body-text">{expanded ? text : `${text.slice(0, limit)}…`}</pre>
      <button className="link-btn" onClick={() => setExpanded(!expanded)}>
        {expanded ? "Show less" : `Show ${(text.length - limit).toLocaleString()} more characters`}
      </button>
    </div>
  );
}

function previewText(text: string | undefined, max = 90): string {
  const flat = (text ?? "").replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

function Clock({ iso }: { iso: string | null }) {
  const clock = formatClock(iso);
  return clock ? (
    <span className="ts" title={iso ?? undefined}>
      {clock}
    </span>
  ) : null;
}

function ToolCard({ event, result }: { event: TranscriptEvent; result?: TranscriptEvent }) {
  const status = result ? (result.isError ? "err" : "ok") : "pending";
  return (
    <details className="card tool-card">
      <summary>
        <span className={`dot dot-${status}`} />
        <span className="tool-name">{event.toolName}</span>
        <span className="summary-preview">{event.toolPreview}</span>
        <Clock iso={event.timestamp} />
      </summary>
      <div className="card-body">
        <div className="section-label">Input</div>
        <ClampedText text={event.toolInput ?? ""} limit={2500} />
        <div className="section-label">
          {result ? (result.isError ? "Result — error" : "Result") : "No result recorded"}
        </div>
        {result ? <ClampedText text={result.text ?? "(empty result)"} limit={2500} /> : null}
      </div>
    </details>
  );
}

/** Slash-command bookkeeping ("<command-name>...", "<local-command-stdout>...")
 * recorded as user entries -- shown collapsed, out of the way. */
function isCommandRecord(text: string): boolean {
  return text.startsWith("<");
}

function EventCard({ event, result }: { event: TranscriptEvent; result?: TranscriptEvent }) {
  switch (event.kind) {
    case "prompt": {
      const text = event.text ?? "";
      if (isCommandRecord(text)) {
        return (
          <details className="card meta-card">
            <summary>
              <span className="summary-title">Command record</span>
              <span className="summary-preview">{previewText(text)}</span>
              <Clock iso={event.timestamp} />
            </summary>
            <div className="card-body">
              <ClampedText text={text} limit={2500} />
            </div>
          </details>
        );
      }
      return (
        <div className="card prompt-card">
          <div className="card-head">
            <span className="card-label">User</span>
            <Clock iso={event.timestamp} />
          </div>
          <ClampedText text={text} limit={2500} />
        </div>
      );
    }
    case "assistant_text":
      return (
        <div className="card assistant-card">
          <div className="card-head">
            <span className="card-label">Claude</span>
            {event.model ? <span className="chip">{event.model}</span> : null}
            <Clock iso={event.timestamp} />
          </div>
          <ClampedText text={event.text ?? ""} limit={6000} />
        </div>
      );
    case "thinking":
      return (
        <details className="card thinking-card">
          <summary>
            <span className="summary-title">Thinking</span>
            <span className="summary-preview">{previewText(event.text)}</span>
            <Clock iso={event.timestamp} />
          </summary>
          <div className="card-body">
            <ClampedText text={event.text ?? ""} limit={4000} />
          </div>
        </details>
      );
    case "tool_use":
      return <ToolCard event={event} result={result} />;
    case "tool_result":
      // Only results whose tool_use never appeared render standalone.
      return (
        <details className="card tool-card">
          <summary>
            <span className={`dot ${event.isError ? "dot-err" : "dot-ok"}`} />
            <span className="tool-name">Tool result</span>
            <span className="summary-preview">{previewText(event.text)}</span>
            <Clock iso={event.timestamp} />
          </summary>
          <div className="card-body">
            <ClampedText text={event.text ?? ""} limit={2500} />
          </div>
        </details>
      );
  }
}

export function RenderItemView({ item }: { item: RenderItem }) {
  if (item.type === "event") {
    return <EventCard event={item.event} result={item.result} />;
  }
  const first = item.items[0];
  const firstText =
    first?.type === "event" ? (first.event.text ?? first.event.toolPreview ?? "") : "";
  return (
    <details className="card sidechain-card">
      <summary>
        <span className="summary-title">Subagent</span>
        <span className="chip">{item.items.length} steps</span>
        <span className="summary-preview">{previewText(firstText)}</span>
      </summary>
      <div className="card-body sidechain-body">
        {item.items.map((inner) => (
          <RenderItemView key={inner.type === "event" ? inner.event.id : inner.id} item={inner} />
        ))}
      </div>
    </details>
  );
}
