export type AgentRole = "planner" | "executor" | "fixer";
export type AdapterName = "claude" | "codex";

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

/**
 * The Claude session id the claude adapter records in meta.sessionId --
 * undefined for adapters with no session concept (codex) and for crashed
 * runs that produced no parseable CLI output.
 */
export function agentSessionId(result: AgentResult): string | undefined {
  const value = result.meta?.sessionId;
  return typeof value === "string" && value !== "" ? value : undefined;
}
