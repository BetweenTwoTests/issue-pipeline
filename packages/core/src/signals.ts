import { defineSignal, defineQuery } from "@temporalio/workflow";

export interface KickoffPayload {
  source: "cli";
  triggeredBy: string;
}

export interface AnswerItem {
  /** 1-based index into the CURRENT round's numbered open-questions comment. */
  index: number;
  text: string;
}

export interface AnswersPayload {
  answers: AnswerItem[];
}

export interface ResumePayload {
  note?: string;
}

export interface SkipPayload {
  note?: string;
}

export interface AbortPayload {
  note?: string;
}

/** No payload -- just "poll the stack's PR states now instead of waiting out
 * the merge-poll interval". */
export type CheckMergesPayload = Record<string, never>;

export type IssueWorkflowStage =
  | "planning"
  | "awaiting_answers"
  | "executing"
  | "parked"
  | "awaiting_merge"
  | "done"
  | "aborted";

export type PhaseExecutionStatus = "pending" | "running" | "done" | "skipped" | "parked";

/**
 * One phase's progress as tracked by issueWorkflow. Small scalars only --
 * this exact shape also rides through continue-as-new during the merge wait,
 * so nothing here may grow with agent output (that content lives on the
 * GitHub issue itself).
 */
export interface PhaseProgress {
  title: string;
  status: PhaseExecutionStatus;
  /** Bumped each time a parked phase is retried via `pipe resume` -- becomes
   * part of the child workflow ID, separate from phaseWorkflow's internal
   * fixer-attempt counter. */
  retryGeneration: number;
  headBranch: string | null;
  prNumber: number | null;
  prUrl: string | null;
}

export interface IssueStatus {
  stage: IssueWorkflowStage;
  currentIndex: number;
  totalPhases: number;
  phases: PhaseProgress[];
  /** Text of the open questions currently awaiting `pipe answer`, in their
   * numbered order. Empty outside awaiting_answers. */
  pendingQuestions: string[];
}

// Defined once here so both apps/worker (setHandler) and apps/cli (typed
// handle.signal(...)/handle.query(...)) share the exact same descriptors
// without cli depending on worker or activities.
export const kickoffSignal = defineSignal<[KickoffPayload]>("kickoff");
export const questionsAnsweredSignal = defineSignal<[AnswersPayload]>("questionsAnswered");
export const resumeSignal = defineSignal<[ResumePayload]>("resume");
export const skipSignal = defineSignal<[SkipPayload]>("skip");
export const abortSignal = defineSignal<[AbortPayload]>("abort");
export const checkMergesSignal = defineSignal<[CheckMergesPayload]>("checkMerges");

export const issueStatusQuery = defineQuery<IssueStatus, []>("status");
