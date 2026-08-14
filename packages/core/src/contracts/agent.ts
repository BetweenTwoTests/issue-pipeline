export type AgentRole = "planner" | "executor" | "fixer";
/** Claude only -- this pipeline is deliberately single-vendor now. The
 * codex adapter was removed with the single-issue redesign; see DESIGN.md §8. */
export type AdapterName = "claude";

/**
 * The result of a single agent CLI invocation (runAgent). This answers only
 * "did the process run, and what did it say" -- it is deliberately distinct
 * from WorklogSections, which is the agent's own self-reported contract
 * output (what it actually did and whether it considers the phase done).
 * `ok: false` means the CLI process itself crashed or timed out; it says
 * nothing about whether WORKLOG.md exists or is well-formed.
 */
export interface AgentResult {
  ok: boolean;
  summary: string;
  deviations: string[];
  artifacts: string[];
  raw?: string;
  meta?: Record<string, unknown>;
}

/** Where in the pipeline an agent session ran -- attached to runAgent calls
 * so the session can be tied back to its stage. */
export interface AgentSessionContext {
  /** "owner/repo". */
  repoSlug: string;
  issueNumber: number;
  /** 1-based; null for planner sessions. */
  phaseNumber: number | null;
  /** Fixer attempt number for executor/fixer (0 = the executor run), or the
   * planning round for planner sessions (1 = first plan). */
  attempt: number;
}

/**
 * One line of ~/pipelines/agent-sessions.jsonl -- the durable index mapping
 * every agent CLI invocation to its Claude Code session id, which is the key
 * into Claude Code's own transcript store
 * (~/.claude/projects/<cwd-derived-dir>/<sessionId>.jsonl). Written
 * best-effort by runAgent; read by the transcript viewer (apps/viewer).
 */
export interface AgentSessionRecord extends AgentSessionContext {
  startedAt: string;
  finishedAt: string;
  role: AgentRole;
  workflowId: string | null;
  sessionId: string | null;
  cwd: string;
  ok: boolean;
  costUsd: number | null;
  numTurns: number | null;
}
