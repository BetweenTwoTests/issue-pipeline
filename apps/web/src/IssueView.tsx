import { useCallback, useEffect, useState, type ReactNode } from "react";
import type { IssueDetail } from "@issue-pipeline/server";
import type { TrackerComment, TrackerIssue } from "@issue-pipeline/core";
import { addIssueComment, fetchIssueDetail, startPipeline } from "./api";
import { formatWhen } from "./format";
import { issueHash, workflowHash } from "./routes";

const POLL_MS = 3_000;

/**
 * Renders markdown links and bare URLs as anchors; everything else stays
 * literal text. Issue bodies and comments are markdown-ish (agent worklogs,
 * transcript-link footers), and the links are the part worth making live --
 * full markdown rendering is deliberately not attempted.
 */
export function LinkifiedText({ text }: { text: string }) {
  const nodes: ReactNode[] = [];
  const re = /\[([^\]\n]+)\]\((https?:\/\/[^\s)]+)\)|(https?:\/\/[^\s<>")\]]+)/g;
  let last = 0;
  let match: RegExpExecArray | null;
  let key = 0;
  while ((match = re.exec(text)) !== null) {
    if (match.index > last) nodes.push(text.slice(last, match.index));
    const [, label, href, bareUrl] = match;
    const url = href ?? bareUrl;
    nodes.push(
      <a key={key++} href={url} target="_blank" rel="noreferrer">
        {label ?? url}
      </a>,
    );
    last = match.index + match[0].length;
  }
  if (last < text.length) nodes.push(text.slice(last));
  return <pre className="body-text">{nodes}</pre>;
}

function StateBadge({ issue }: { issue: TrackerIssue }) {
  return <span className={`badge badge-${issue.state === "open" ? "open" : "closed"}`}>{issue.state}</span>;
}

function CommentCard({ comment }: { comment: TrackerComment }) {
  return (
    <div className="card comment-card">
      <div className="card-head">
        <span className="card-label">{comment.author}</span>
        <span className={`chip chip-kind-${comment.authorKind}`}>{comment.authorKind}</span>
        <span className="ts">{formatWhen(comment.createdAt)}</span>
      </div>
      <div className="card-body">
        <LinkifiedText text={comment.body} />
      </div>
    </div>
  );
}

/**
 * One tracker issue, rendered the way its GitHub page would have been:
 * title/state/labels, body, linked sub-issues with phase status, and the
 * comment timeline (pipeline notices, agent worklogs, human comments).
 * All of it reads from the app database via the backend -- the pipeline
 * itself is reachable through the workflow link and Start button.
 */
export function IssueView({
  repoOwner,
  repoName,
  number,
}: {
  repoOwner: string;
  repoName: string;
  number: number;
}) {
  const repoSlug = `${repoOwner}/${repoName}`;
  const [detail, setDetail] = useState<IssueDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [actionOk, setActionOk] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      const next = await fetchIssueDetail(repoSlug, number);
      setDetail(next);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, [repoSlug, number]);

  useEffect(() => {
    void refresh();
    const interval = setInterval(() => void refresh(), POLL_MS);
    return () => clearInterval(interval);
  }, [refresh]);

  const issue = detail?.issue ?? null;
  const isRoot = issue !== null && issue.parentNumber === null;

  const submitComment = async (): Promise<void> => {
    if (draft.trim() === "" || busy) return;
    setBusy(true);
    setActionError(null);
    setActionOk(null);
    try {
      await addIssueComment(repoSlug, number, draft.trim());
      setDraft("");
      await refresh();
    } catch (err) {
      setActionError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const submitStart = async (): Promise<void> => {
    setBusy(true);
    setActionError(null);
    setActionOk(null);
    try {
      const result = await startPipeline(`${repoSlug}#${number}`);
      setActionOk(`Pipeline started: ${result.workflowId}`);
    } catch (err) {
      setActionError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="transcript">
      <header className="transcript-head">
        <div className="transcript-title-row">
          <h2>
            {issue ? issue.title : `${repoSlug}#${number}`} <span className="issue-number">#{number}</span>
          </h2>
          {issue ? <StateBadge issue={issue} /> : null}
          {issue && isRoot ? (
            <button className="btn btn-primary" disabled={busy} onClick={() => void submitStart()}>
              Start pipeline
            </button>
          ) : null}
        </div>
        <div className="chips">
          <span className="chip">{repoSlug}</span>
          {issue?.labels.map((label) => (
            <span key={label} className="chip chip-label">
              {label}
            </span>
          ))}
          {issue && issue.parentNumber !== null ? (
            <a className="chip chip-link" href={issueHash(repoOwner, repoName, issue.parentNumber)}>
              parent #{issue.parentNumber}
            </a>
          ) : null}
          {issue?.phase !== null && issue?.phase !== undefined ? <span className="chip">phase {issue.phase}</span> : null}
          {issue?.baseBranch ? <span className="chip">⎇ base {issue.baseBranch}</span> : null}
          {detail ? (
            <a className="chip chip-link" href={workflowHash(detail.workflowId)}>
              pipeline ↗
            </a>
          ) : null}
          {issue ? <span className="chip">opened {formatWhen(issue.createdAt)}</span> : null}
        </div>
      </header>
      <div className="transcript-scroll">
        {error ? <div className="notice notice-error">{error}</div> : null}
        {!detail && !error ? <div className="notice">Loading issue…</div> : null}

        {issue ? (
          <section className="card pipe-section">
            <h3>Description</h3>
            {issue.body.trim() === "" ? (
              <p className="issue-empty">No description.</p>
            ) : (
              <LinkifiedText text={issue.body} />
            )}
          </section>
        ) : null}

        {detail && detail.subIssues.length > 0 ? (
          <section className="card pipe-section">
            <h3>Sub-issues</h3>
            {detail.subIssues.map((sub) => (
              <div key={sub.id} className="phase-row">
                <span className={`dot dot-${sub.state === "closed" ? "ok" : "pending"}`} />
                <a className="phase-title" href={issueHash(sub.repoOwner, sub.repoName, sub.number)}>
                  {sub.phase !== null ? `${sub.phase}. ` : ""}
                  {sub.title}
                </a>
                <span className="chip">#{sub.number}</span>
                {sub.baseBranch ? <span className="chip">⎇ {sub.baseBranch}</span> : null}
                <span className="phase-status">{sub.state}</span>
              </div>
            ))}
          </section>
        ) : null}

        {detail ? (
          <section className="pipe-section">
            <h3 className="comments-title">
              Comments {detail.comments.length > 0 ? <span className="chip">{detail.comments.length}</span> : null}
            </h3>
            {detail.comments.length === 0 ? <div className="notice">No comments yet.</div> : null}
            {detail.comments.map((comment) => (
              <CommentCard key={comment.id} comment={comment} />
            ))}
            <div className="card comment-card">
              <textarea
                rows={3}
                value={draft}
                placeholder="Leave a comment…"
                onChange={(e) => setDraft(e.target.value)}
              />
              <div className="pipe-actions">
                <button
                  className="btn btn-primary"
                  disabled={busy || draft.trim() === ""}
                  onClick={() => void submitComment()}
                >
                  Comment
                </button>
              </div>
            </div>
          </section>
        ) : null}

        {actionError ? <div className="notice notice-error">{actionError}</div> : null}
        {actionOk ? <div className="notice notice-ok">{actionOk}</div> : null}
      </div>
    </div>
  );
}
