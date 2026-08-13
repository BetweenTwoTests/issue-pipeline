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

export interface PlanStatus {
  status: PlanWorkflowState;
  currentIndex: number;
  totalPhases: number;
  headBranch: string | null;
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
