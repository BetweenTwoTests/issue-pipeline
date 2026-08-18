/**
 * Type surface for the frontend -- apps/web imports these type-only, so
 * this barrel must stay side-effect free (no env loading, no server start).
 * The executable entry is main.ts.
 */
export type {
  EventKind,
  TranscriptEvent,
  SessionMeta,
  ParsedChunk,
  SessionChunk,
  ProjectSummary,
  SessionSummary,
  PipelineListItem,
  StartPipelineResult,
  IssueListItem,
  IssueDetail,
  RegisteredRepoSummary,
} from "./types";
