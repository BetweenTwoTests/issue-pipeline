export { PIPELINE_TASK_QUEUE } from "./task-queue";

// loadTemporalConnectionConfig deliberately does NOT live here (or anywhere
// in this package's export surface): workflow files import values from this
// barrel, and Temporal's workflow bundler traces the whole thing -- a
// node:path/dotenv-using function here would break the workflow sandbox
// build. See apps/worker/src/env.ts and apps/cli/src/env.ts (duplicated on
// purpose) for the actual loader.

export { ISSUE_WORKFLOW_NAME, issueWorkflowId } from "./workflow-names";

export {
  kickoffSignal,
  questionsAnsweredSignal,
  resumeSignal,
  skipSignal,
  abortSignal,
  checkMergesSignal,
  issueStatusQuery,
  type KickoffPayload,
  type AnswerItem,
  type AnswersPayload,
  type ResumePayload,
  type SkipPayload,
  type AbortPayload,
  type CheckMergesPayload,
  type IssueWorkflowStage,
  type PhaseExecutionStatus,
  type PhaseProgress,
  type IssueStatus,
} from "./signals";

export type {
  AgentRole,
  AdapterName,
  AgentResult,
  AgentSessionContext,
  AgentSessionRecord,
} from "./contracts/agent";
export type { WorklogStatus, WorklogSections } from "./contracts/worklog";
export {
  PipelineConfigError,
  RoleNotConfiguredError,
  WorklogContractViolationError,
  PlannerOutputParseError,
  GitOperationError,
  GithubCliError,
} from "./contracts/errors";
export {
  PLAN_COMMENT_HEADER,
  PhasePlanItemSchema,
  OpenQuestionSchema,
  PlannerOutputSchema,
  slugify,
  type PhasePlanItem,
  type OpenQuestion,
  type PlannerOutput,
} from "./contracts/planner";
export {
  PHASE_CHECKLIST_BEGIN,
  PHASE_CHECKLIST_END,
  renderPhaseChecklist,
  upsertPhaseChecklist,
  type ChecklistPhase,
} from "./contracts/phase-checklist";
export {
  githubSlug,
  buildPhaseBranchName,
  buildPhaseWorktreePath,
  buildPlanningWorktreePath,
  buildPipelineDbPath,
  type RegisteredRepo,
} from "./contracts/repo";
export type {
  PipelineEventType,
  PipelineEvent,
  ProjectPipelineStateInput,
  RecordPipelineEventInput,
} from "./contracts/projection";
export {
  PipelineConfigSchema,
  parsePipelineConfig,
  type RoleConfig,
  type PipelineConfig,
} from "./contracts/pipeline-config";
