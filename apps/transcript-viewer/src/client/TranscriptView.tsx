import { useEffect, useMemo, useRef, useState } from "react";
import type { SessionSummary } from "../shared/types";
import { buildRenderItems, RenderItemView } from "./EventCard";
import { formatBytes, shortHome } from "./format";
import { useTranscript } from "./hooks";

/** Sessions modified this recently start with follow-scrolling on. */
const FOLLOW_DEFAULT_WINDOW_MS = 10 * 60_000;

function CopyButton({ text, label }: { text: string; label: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      className="btn"
      title={text}
      onClick={() => {
        void navigator.clipboard.writeText(text).then(() => {
          setCopied(true);
          setTimeout(() => setCopied(false), 1500);
        });
      }}
    >
      {copied ? "Copied!" : label}
    </button>
  );
}

export function TranscriptView({
  project,
  sessionId,
  summary,
}: {
  project: string;
  sessionId: string;
  summary: SessionSummary | null;
}) {
  const t = useTranscript(project, sessionId);
  const [follow, setFollow] = useState(
    () => summary !== null && Date.now() - Date.parse(summary.modifiedAt) < FOLLOW_DEFAULT_WINDOW_MS,
  );
  const scrollRef = useRef<HTMLDivElement>(null);
  // Scrolling up pauses follow-scrolling (so reading or expanding an earlier
  // card is never yanked away); returning to the bottom resumes it.
  const nearBottomRef = useRef(true);

  const onScroll = () => {
    const el = scrollRef.current;
    if (el) nearBottomRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 120;
  };

  useEffect(() => {
    if (!follow || t.updatedAt === 0 || !nearBottomRef.current) return;
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [follow, t.updatedAt]);

  const items = useMemo(() => buildRenderItems(t.events), [t.events]);
  const title = t.customTitle ?? t.aiTitle ?? summary?.title ?? summary?.firstPrompt ?? sessionId;
  const resumeCommand = t.meta.cwd
    ? `cd ${t.meta.cwd} && claude --resume ${sessionId}`
    : `claude --resume ${sessionId}`;

  return (
    <div className="transcript">
      <header className="transcript-head">
        <div className="transcript-title-row">
          <h2 title={sessionId}>{title}</h2>
          <label className="follow-toggle">
            <input type="checkbox" checked={follow} onChange={(e) => setFollow(e.target.checked)} />
            Follow
          </label>
          <CopyButton text={resumeCommand} label="Copy resume command" />
        </div>
        <div className="chips">
          {t.meta.cwd ? <span className="chip">{shortHome(t.meta.cwd)}</span> : null}
          {t.meta.gitBranch ? <span className="chip">⎇ {t.meta.gitBranch}</span> : null}
          {t.meta.version ? <span className="chip">claude {t.meta.version}</span> : null}
          <span className="chip">{formatBytes(t.fileSize)}</span>
          <span className="chip">{t.events.length} events</span>
          {t.malformedLines > 0 ? (
            <span className="chip chip-warn">{t.malformedLines} malformed lines</span>
          ) : null}
        </div>
      </header>
      <div className="transcript-scroll" ref={scrollRef} onScroll={onScroll}>
        {t.error ? <div className="notice notice-error">{t.error}</div> : null}
        {t.loading ? <div className="notice">Loading transcript…</div> : null}
        {!t.loading && !t.error && items.length === 0 ? (
          <div className="notice">No renderable entries in this transcript.</div>
        ) : null}
        {items.map((item) => (
          <RenderItemView key={item.type === "event" ? item.event.id : item.id} item={item} />
        ))}
      </div>
    </div>
  );
}
