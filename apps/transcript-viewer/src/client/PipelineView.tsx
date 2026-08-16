import { useCallback, useEffect, useState } from "react";
import type { PipelineListItem } from "../shared/types";
import { fetchPipeline, sendAnswers, sendControl } from "./api";
import { formatWhen } from "./format";

const POLL_MS = 3_000;

/** Sidebar badge + header chip styling bucket for a pipeline's status. */
export function statusClass(status: string): string {
  switch (status) {
    case "awaiting_blocking_questions":
    case "parked":
      return "attention";
    case "planning":
    case "running_phase":
    case "running":
      return "running";
    case "done":
    case "completed":
      return "done";
    default:
      return "dead";
  }
}

export function statusLabel(item: PipelineListItem): string {
  return (item.plan?.status ?? item.executionStatus).toLowerCase().replaceAll("_", " ");
}

/**
 * One plan workflow: status, phases, and the human-in-the-loop responses --
 * blocking-question answers, resume/skip for a parked phase, abort. All of
 * these are Temporal signals delivered through the viewer's API; the
 * workflow reacts exactly as it does to the `pipe` CLI.
 */
export function PipelineView({ workflowId }: { workflowId: string }) {
  const [item, setItem] = useState<PipelineListItem | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [drafts, setDrafts] = useState<Record<number, string>>({});
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [actionOk, setActionOk] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      const next = await fetchPipeline(workflowId);
      setItem(next);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, [workflowId]);

  useEffect(() => {
    void refresh();
    const interval = setInterval(() => void refresh(), POLL_MS);
    return () => clearInterval(interval);
  }, [refresh]);

  // Seed each unanswered question's draft with the planner's own proposal,
  // once, so accepting the recommendation is a single click.
  useEffect(() => {
    const questions = item?.plan?.blockingQuestions ?? [];
    setDrafts((prev) => {
      let changed = false;
      const next = { ...prev };
      for (const q of questions) {
        if (!q.answered && next[q.index] === undefined) {
          next[q.index] = q.proposedAnswer;
          changed = true;
        }
      }
      return changed ? next : prev;
    });
  }, [item]);

  const plan = item?.plan;
  const running = item?.executionStatus === "RUNNING";
  const unanswered = (plan?.blockingQuestions ?? []).filter((q) => !q.answered);
  const issueRef = plan ? `${plan.owner}/${plan.repo}#${plan.issueNumber}` : workflowId;
  const issueUrl = plan ? `https://github.com/${plan.owner}/${plan.repo}/issues/${plan.issueNumber}` : null;
  const status = statusLabel(item ?? { workflowId, runId: "", executionStatus: "…", startTime: null });

  const submitAnswers = async (): Promise<void> => {
    const answers = unanswered
      .map((q) => ({ index: q.index, text: (drafts[q.index] ?? "").trim() }))
      .filter((a) => a.text !== "");
    if (answers.length === 0) {
      setActionError("Type at least one answer first.");
      return;
    }
    setBusy(true);
    setActionError(null);
    setActionOk(null);
    try {
      await sendAnswers(workflowId, answers);
      setActionOk(`Sent ${answers.length} answer${answers.length > 1 ? "s" : ""}.`);
      await refresh();
    } catch (err) {
      setActionError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const control = async (action: "resume" | "skip" | "abort"): Promise<void> => {
    if (action === "abort" && !window.confirm("Abort this pipeline? The run ends for every remaining phase.")) {
      return;
    }
    setBusy(true);
    setActionError(null);
    setActionOk(null);
    try {
      await sendControl(workflowId, action, note.trim() === "" ? undefined : note.trim());
      setActionOk(`Sent ${action}.`);
      await refresh();
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
          <h2 title={workflowId}>{issueRef}</h2>
          <span className={`badge badge-${statusClass(status.replaceAll(" ", "_"))}`}>{status}</span>
        </div>
        <div className="chips">
          <span className="chip">{workflowId}</span>
          {issueUrl ? (
            <a className="chip chip-link" href={issueUrl} target="_blank" rel="noreferrer">
              issue ↗
            </a>
          ) : null}
          {item?.startTime ? <span className="chip">started {formatWhen(item.startTime)}</span> : null}
          {plan && plan.totalPhases > 0 ? (
            <span className="chip">
              phase {Math.min(plan.currentIndex + 1, plan.totalPhases)}/{plan.totalPhases}
            </span>
          ) : null}
        </div>
      </header>
      <div className="transcript-scroll">
        {error ? <div className="notice notice-error">{error}</div> : null}
        {item?.queryError ? (
          <div className="notice notice-error">Status query failed: {item.queryError}</div>
        ) : null}
        {!item && !error ? <div className="notice">Loading pipeline…</div> : null}

        {plan && plan.blockingQuestions.length > 0 ? (
          <section className="card pipe-section">
            <h3>Blocking questions</h3>
            {plan.blockingQuestions.map((q) => (
              <div key={q.index} className="pipe-question">
                <div className="pipe-question-head">
                  <span className="pipe-qnum">{q.index}.</span>
                  <span className="pipe-qtext">{q.question}</span>
                  {q.answered ? <span className="chip chip-ok">answered</span> : null}
                </div>
                {!q.answered && running ? (
                  <textarea
                    rows={2}
                    value={drafts[q.index] ?? ""}
                    placeholder="Type your answer…"
                    onChange={(e) => setDrafts((prev) => ({ ...prev, [q.index]: e.target.value }))}
                  />
                ) : null}
              </div>
            ))}
            {running && unanswered.length > 0 ? (
              <div className="pipe-actions">
                <button className="btn btn-primary" disabled={busy} onClick={() => void submitAnswers()}>
                  Send {unanswered.length > 1 ? "answers" : "answer"}
                </button>
              </div>
            ) : null}
          </section>
        ) : null}

        {plan && plan.phases.length > 0 ? (
          <section className="card pipe-section">
            <h3>Phases</h3>
            {plan.phases.map((p, i) => (
              <div key={p.subIssueNumber} className="phase-row">
                <span className={`dot dot-${p.status === "done" ? "ok" : p.status === "parked" ? "err" : "pending"}`} />
                <span className="phase-title">
                  {i + 1}. {p.title}
                </span>
                <span className="chip">#{p.subIssueNumber}</span>
                {p.headBranch ? <span className="chip">⎇ {p.headBranch}</span> : null}
                <span className="phase-status">{p.status}</span>
              </div>
            ))}
          </section>
        ) : null}

        {running ? (
          <section className="card pipe-section">
            <h3>Actions</h3>
            <input
              className="pipe-note"
              value={note}
              placeholder="Optional note (sent with resume / skip / abort)"
              onChange={(e) => setNote(e.target.value)}
            />
            <div className="pipe-actions">
              {plan?.status === "parked" ? (
                <>
                  <button className="btn btn-primary" disabled={busy} onClick={() => void control("resume")}>
                    Resume phase
                  </button>
                  <button className="btn" disabled={busy} onClick={() => void control("skip")}>
                    Skip phase
                  </button>
                </>
              ) : null}
              <button className="btn btn-danger" disabled={busy} onClick={() => void control("abort")}>
                Abort pipeline
              </button>
            </div>
          </section>
        ) : null}

        {actionError ? <div className="notice notice-error">{actionError}</div> : null}
        {actionOk ? <div className="notice notice-ok">{actionOk}</div> : null}
      </div>
    </div>
  );
}
