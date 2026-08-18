import type { PlanStatus, TrackerComment, TrackerIssue } from "@issue-pipeline/core";

/** Types shared between the server middleware and the React client. */

/** Response to POST /api/pipeline/start. */
export interface StartPipelineResult {
  workflowId: string;
}

/** One root issue in GET /api/issues. */
export interface IssueListItem {
  issue: TrackerIssue;
  subIssuesTotal: number;
  subIssuesClosed: number;
  /** The plan workflow id this issue starts (derived, whether or not it ran yet). */
  workflowId: string;
}

/** GET /api/issue: an issue with everything its page renders. */
export interface IssueDetail {
  issue: TrackerIssue;
  /** The root issue, when `issue` is a phase sub-issue. */
  parent: TrackerIssue | null;
  subIssues: TrackerIssue[];
  comments: TrackerComment[];
  /** The plan workflow id of this issue's pipeline (the parent's for sub-issues). */
  workflowId: string;
}

/** One pipeline.yaml `repos:` entry, for the new-issue form's repo picker. */
export interface RegisteredRepoSummary {
  name: string;
  owner: string;
  repo: string;
  defaultBranch: string;
}

/** One plan workflow as shown in the pipelines panel. */
export interface PipelineListItem {
  workflowId: string;
  runId: string;
  /** Temporal execution status: RUNNING, COMPLETED, TERMINATED, FAILED, ... */
  executionStatus: string;
  startTime: string | null;
  /** Result of the workflow's status query, when it answered in time. */
  plan?: PlanStatus;
  /** Why `plan` is missing (query timeout usually means no worker running). */
  queryError?: string;
}

export type EventKind = "prompt" | "assistant_text" | "thinking" | "tool_use" | "tool_result";

export interface TranscriptEvent {
  /**
   * Stable per-content-block id: "<entry uuid>:<block index>", falling back
   * to "<byte namespace>:<line index>:<block index>" for entries without a
   * uuid. React keys (and therefore <details> open/closed state) depend on
   * these staying identical across live-tail appends.
   */
  id: string;
  kind: EventKind;
  timestamp: string | null;
  /** True for entries produced inside a subagent (Task/Explore) run. */
  sidechain: boolean;
  /** Groups sidechain entries belonging to one subagent, when recorded. */
  agentId: string | null;
  /** prompt / assistant_text / thinking / tool_result body. */
  text?: string;
  /** tool_use only. */
  toolName?: string;
  toolInput?: string;
  /** One-line summary of the tool input, for collapsed rendering. */
  toolPreview?: string;
  /** Links a tool_use to its tool_result. */
  toolUseId?: string;
  /** tool_result only. */
  isError?: boolean;
  model?: string;
}

/** Session-level fields harvested from user/assistant entries. */
export interface SessionMeta {
  cwd: string | null;
  gitBranch: string | null;
  version: string | null;
  slug: string | null;
}

export interface ParsedChunk {
  events: TranscriptEvent[];
  /** Claude Code's generated title, when an ai-title entry is present. */
  aiTitle: string | null;
  /** User-assigned title, when a custom-title entry is present. */
  customTitle: string | null;
  /** Last-seen values within this chunk; null where absent. */
  meta: SessionMeta;
  /**
   * Lines that failed to parse as JSON -- surfaced so truncation/corruption
   * is visible instead of silent.
   */
  malformedLines: number;
}

export interface SessionChunk extends ParsedChunk {
  /** Byte offset to pass as ?offset= on the next poll. */
  offset: number;
  fileSize: number;
  /**
   * True when the requested offset was past the end of the file (the file
   * was replaced or truncated); the chunk restarts from byte 0 and the
   * client must discard previously accumulated events.
   */
  reset: boolean;
}

export interface ProjectSummary {
  /** Directory name under ~/.claude/projects (cwd with separators flattened to "-"). */
  name: string;
  sessionCount: number;
  lastModified: string | null;
  /** Real cwd of the newest session, for display; the directory name is lossy. */
  displayPath: string | null;
}

export interface SessionSummary {
  id: string;
  title: string | null;
  firstPrompt: string | null;
  startedAt: string | null;
  modifiedAt: string;
  sizeBytes: number;
  gitBranch: string | null;
  /** True when the file's entries are subagent output rather than a top-level session. */
  sidechain: boolean;
}
