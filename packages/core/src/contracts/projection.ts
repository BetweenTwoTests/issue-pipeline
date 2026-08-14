import type { IssueWorkflowStage, PhaseProgress } from "../signals";

/**
 * The state-projection contract: Temporal's own guidance is to treat
 * workflow histories as the execution record, NOT the analysis store --
 * workflows project their state transitions into an external database of
 * your own instead. Here that database is a local SQLite file (see
 * buildPipelineDbPath in contracts/repo.ts); these are the pure types both
 * the writing activity (packages/activities/src/projection-db.ts) and the
 * reading viewer (apps/viewer) share.
 *
 * The projection is a disposable READ MODEL: deleting the file loses
 * analysis history, never pipeline correctness (Temporal + the GitHub issue
 * remain the sources of truth).
 */

export type PipelineEventType =
  // issueWorkflow (the entity)
  | "pipeline_started"
  | "plan_posted"
  | "awaiting_answers"
  | "answers_recorded"
  | "executing_started"
  | "phase_started"
  | "phase_done"
  | "phase_parked"
  | "phase_skipped"
  | "phase_resumed"
  | "merge_wait_started"
  | "pr_closed_warning"
  | "pipeline_completed"
  | "pipeline_aborted"
  // phaseWorkflow (child executions)
  | "attempt_started"
  | "attempt_finished";

export interface PipelineEvent {
  /** Monotonic per source workflow execution chain -- (sourceWorkflowId,
   * seq) is the idempotency key that makes at-least-once activity retries
   * safe (INSERT OR REPLACE). */
  seq: number;
  type: PipelineEventType;
  detail?: Record<string, unknown>;
}

/** Full snapshot upsert + one event append, called by issueWorkflow at every
 * state transition. */
export interface ProjectPipelineStateInput {
  workflowId: string;
  repoSlug: string;
  issueNumber: number;
  stage: IssueWorkflowStage;
  currentIndex: number;
  totalPhases: number;
  outcome: "completed" | "aborted" | null;
  phases: PhaseProgress[];
  event: PipelineEvent;
}

/** Event-only append for child phaseWorkflow executions -- children never
 * own the pipelines row, but their attempt-level events group under the
 * entity via pipelineWorkflowId. */
export interface RecordPipelineEventInput {
  pipelineWorkflowId: string;
  sourceWorkflowId: string;
  event: PipelineEvent;
}
