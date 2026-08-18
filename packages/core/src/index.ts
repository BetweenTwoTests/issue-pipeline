export { PIPELINE_TASK_QUEUE } from "./task-queue";

// loadTemporalConnectionConfig deliberately does NOT live here (or anywhere
// in this package's export surface): workflow files import values from this
// barrel, and Temporal's workflow bundler traces the whole thing -- a
// node:path/dotenv-using function here would break the workflow sandbox
// build. See apps/worker/src/env.ts and apps/cli/src/env.ts (duplicated on
// purpose) for the actual loader.

export { PLAN_WORKFLOW_NAME, planWorkflowId } from "./workflow-names";
export { parseIssueRef, issueRefToWorkflowId, type IssueRef } from "./issue-ref";

export {
  kickoffSignal,
  questionsAnsweredSignal,
  resumeSignal,
  skipSignal,
  abortSignal,
  planStatusQuery,
  type KickoffPayload,
  type AnswerItem,
  type AnswersPayload,
  type ResumePayload,
  type SkipPayload,
  type AbortPayload,
  type PlanWorkflowState,
  type PlanStatus,
  type PlanQuestionStatus,
  type PlanPhaseStatus,
} from "./signals";

export {
  issueKey,
  formatIssueRef,
  type IssueState,
  type CommentAuthorKind,
  type IssueKey,
  type TrackerIssue,
  type TrackerComment,
} from "./contracts/tracker";
export type { TrackerSyncProvider, TrackerSyncEvent, TrackerSyncPort } from "./contracts/tracker-sync";

export { agentSessionId, type AgentRole, type AdapterName, type AgentResult } from "./contracts/agent";
export { claudeProjectDirName, buildTranscriptUrl } from "./transcript-link";
export type { WorklogStatus, WorklogSections } from "./contracts/worklog";
export {
  PipelineConfigError,
  RoleNotConfiguredError,
  WorklogContractViolationError,
  PlannerOutputParseError,
  TrackerIssueNotFoundError,
  GitOperationError,
  GithubCliError,
} from "./contracts/errors";
export {
  PhasePlanItemSchema,
  OpenQuestionSchema,
  PlannerOutputSchema,
  slugify,
  type PhasePlanItem,
  type OpenQuestion,
  type PlannerOutput,
} from "./contracts/planner";
export {
  SubIssueMetadataSchema,
  composeMetadataComment,
  composeSubIssueBody,
  parseSubIssueMetadata,
  type SubIssueMetadata,
} from "./contracts/sub-issue-metadata";
export {
  githubSlug,
  buildPhaseBranchName,
  buildPhaseWorktreePath,
  type RegisteredRepo,
} from "./contracts/repo";
export {
  PipelineConfigSchema,
  parsePipelineConfig,
  type RoleConfig,
  type PipelineConfig,
} from "./contracts/pipeline-config";
