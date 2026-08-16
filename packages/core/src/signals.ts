import { defineSignal, defineQuery } from "@temporalio/workflow";

export interface KickoffPayload {
  source: "cli";
  triggeredBy: string;
}

export interface AnswerItem {
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

export type PlanWorkflowState =
  | "planning"
  | "awaiting_blocking_questions"
  | "running_phase"
  | "parked"
  | "done"
  | "aborted";

export interface PlanQuestionStatus {
  /** 1-based, matching the numbering in the pipeline's issue comment. */
  index: number;
  question: string;
  /** The planner's own recommendation, usable as a suggested answer. */
  proposedAnswer: string;
  answered: boolean;
}

export interface PlanPhaseStatus {
  subIssueNumber: number;
  title: string;
  status: "pending" | "done" | "parked";
  headBranch: string | null;
}

/**
 * Everything a human-in-the-loop surface (the CLI, the transcript viewer's
 * pipelines panel) needs to render a pipeline and decide what response to
 * send -- which blocking questions are still open, and which phase is
 * parked. Answering/resuming happens via the signals below, never by
 * mutating this.
 */
export interface PlanStatus {
  status: PlanWorkflowState;
  owner: string;
  repo: string;
  issueNumber: number;
  currentIndex: number;
  totalPhases: number;
  headBranch: string | null;
  /** Empty until the planner raises blocking questions. */
  blockingQuestions: PlanQuestionStatus[];
  phases: PlanPhaseStatus[];
}

// Defined once here so both apps/worker (setHandler) and apps/cli (typed
// handle.signal(...)/handle.query(...)) share the exact same descriptors
// without cli depending on worker or activities.
export const kickoffSignal = defineSignal<[KickoffPayload]>("kickoff");
export const questionsAnsweredSignal = defineSignal<[AnswersPayload]>("questionsAnswered");
export const resumeSignal = defineSignal<[ResumePayload]>("resume");
export const skipSignal = defineSignal<[SkipPayload]>("skip");
export const abortSignal = defineSignal<[AbortPayload]>("abort");

export const planStatusQuery = defineQuery<PlanStatus, []>("status");
