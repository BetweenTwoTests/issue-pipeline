import { useEffect, useMemo, useRef, useState } from "react";
import type { SessionSummary } from "../shared/types";
import { buildRenderItems, RenderItemView } from "./EventCard";
import { formatBytes, shortHome } from "./format";
import { useTranscript } from "./hooks";

/** Sessions modified this recently start with follow-scrolling on. */
const FOLLOW_DEFAULT_WINDOW_MS = 10 * 60_000;

function ClipboardIcon() {
  return (
    <svg
      width="13"
      height="13"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <rect x="9" y="9" width="13" height="13" rx="2" ry="2" />
      <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
    </svg>
  );
}

function CheckIcon() {
  return (
    <svg
      width="13"
      height="13"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <polyline points="20 6 9 17 4 12" />
    </svg>
  );
}

/**
 * navigator.clipboard needs a secure context and can reject when the
 * document isn't focused; the hidden-textarea path covers those cases.
 */
async function copyToClipboard(text: string): Promise<boolean> {
  if (navigator.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch {
      // fall through to the textarea path
    }
  }
  const textarea = document.createElement("textarea");
  textarea.value = text;
  textarea.style.position = "fixed";
  textarea.style.opacity = "0";
  document.body.appendChild(textarea);
  textarea.select();
  let ok = false;
  try {
    ok = document.execCommand("copy");
  } catch {
    ok = false;
  }
  textarea.remove();
  return ok;
}

/** Copies `text` to the clipboard; the icon flips to a checkmark briefly. */
function CopyButton({ text, label }: { text: string; label: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      className={`btn btn-copy${copied ? " copied" : ""}`}
      title={text}
      onClick={() => {
        void copyToClipboard(text).then((ok) => {
          if (!ok) return;
          setCopied(true);
          setTimeout(() => setCopied(false), 1500);
        });
      }}
    >
      {copied ? <CheckIcon /> : <ClipboardIcon />}
      <span>{copied ? "Copied!" : label}</span>
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
          <CopyButton text={resumeCommand} label="Resume Claude session" />
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
