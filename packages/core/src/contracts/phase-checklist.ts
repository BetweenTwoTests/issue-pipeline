/**
 * The phase checklist that lives INSIDE the root issue's body -- phases are
 * task-list items on the issue itself, not sub-issues. The section is
 * bracketed by HTML-comment markers so it can be rewritten idempotently
 * without touching whatever a human wrote around it.
 *
 * Pure string manipulation only: this module is imported by workflow-adjacent
 * code paths and must never touch fs/env (see the core-purity rule in
 * DESIGN.md §3).
 */

export const PHASE_CHECKLIST_BEGIN = "<!-- pipeline:phases:begin -->";
export const PHASE_CHECKLIST_END = "<!-- pipeline:phases:end -->";

export interface ChecklistPhase {
  title: string;
  done: boolean;
  /** Rendered next to a checked item when known, linking the phase to its PR. */
  prNumber?: number | null;
  prUrl?: string | null;
  /** Freeform annotation, e.g. "skipped by human" -- rendered in italics. */
  note?: string | null;
}

/** Renders the full marker-wrapped checklist section (no surrounding blank lines). */
export function renderPhaseChecklist(phases: ChecklistPhase[]): string {
  const lines = phases.map((phase, i) => {
    const box = phase.done ? "[x]" : "[ ]";
    const pr = phase.prNumber != null ? ` ([PR #${phase.prNumber}](${phase.prUrl ?? ""}))` : "";
    const note = phase.note ? ` _(${phase.note})_` : "";
    return `- ${box} Phase ${i + 1}: ${phase.title}${pr}${note}`;
  });
  return `${PHASE_CHECKLIST_BEGIN}\n## Phases\n${lines.join("\n")}\n${PHASE_CHECKLIST_END}`;
}

/**
 * Replaces the existing marker-wrapped section in `body`, or appends one if
 * no markers are present yet. Never touches anything outside the markers, so
 * repeated calls (Temporal activities are at-least-once) and human edits to
 * the rest of the body are both safe.
 */
export function upsertPhaseChecklist(body: string, renderedChecklist: string): string {
  const beginIdx = body.indexOf(PHASE_CHECKLIST_BEGIN);
  const endIdx = body.indexOf(PHASE_CHECKLIST_END);
  if (beginIdx !== -1 && endIdx !== -1 && endIdx > beginIdx) {
    const before = body.slice(0, beginIdx);
    const after = body.slice(endIdx + PHASE_CHECKLIST_END.length);
    return `${before}${renderedChecklist}${after}`;
  }
  const trimmed = body.replace(/\s+$/, "");
  return trimmed === "" ? renderedChecklist : `${trimmed}\n\n${renderedChecklist}`;
}
