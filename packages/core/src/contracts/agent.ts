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
