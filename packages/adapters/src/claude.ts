import type { AgentResult, RoleConfig } from "@issue-pipeline/core";
import { spawnWithTimeout, tryGetActivityCancellationSignal, tryHeartbeat } from "./process";

const CLAUDE_BIN = process.env.PIPELINE_CLAUDE_BIN ?? "claude";

export interface ClaudeRunInput {
  prompt: string;
  cwd: string;
  role: RoleConfig;
  /** e.g. "acceptEdits" for executor/fixer, "plan" for a read-only planner. */
  defaultPermissionMode: string;
}

export async function run(input: ClaudeRunInput): Promise<AgentResult> {
  const args = [
    "-p",
    "--output-format",
    "json",
    "--permission-mode",
    input.defaultPermissionMode,
    ...(input.role.max_budget_usd ? ["--max-budget-usd", String(input.role.max_budget_usd)] : []),
    ...input.role.args,
  ];
  const { stdout, stderr, exitCode, timedOut } = await spawnWithTimeout(CLAUDE_BIN, args, {
    cwd: input.cwd,
    stdinData: input.prompt,
    timeoutMs: input.role.timeout_ms,
    signal: tryGetActivityCancellationSignal(),
    onProgress: tryHeartbeat,
  });
  if (timedOut) {
    return {
      ok: false,
      summary: `claude timed out after ${input.role.timeout_ms}ms`,
      deviations: [],
      artifacts: [],
      raw: stdout,
      meta: { timedOut: true },
    };
  }
  return parseClaudeJson(stdout, stderr, exitCode);
}

interface ClaudeResultJson {
  type?: string;
  is_error?: boolean;
  subtype?: string;
  result?: string;
  num_turns?: number;
  total_cost_usd?: number;
  session_id?: string;
}

function parseClaudeJson(stdout: string, stderr: string, exitCode: number | null): AgentResult {
  if (exitCode !== 0) {
    return {
      ok: false,
      summary: `claude exited ${exitCode}: ${stderr.slice(0, 2000)}`,
      deviations: [],
      artifacts: [],
      raw: stdout,
    };
  }
  let parsed: ClaudeResultJson;
  try {
    parsed = JSON.parse(stdout);
  } catch (err) {
    return {
      ok: false,
      summary: `claude produced non-JSON stdout despite --output-format json: ${(err as Error).message}`,
      deviations: [],
      artifacts: [],
      raw: stdout,
    };
  }
  const ok = parsed.type === "result" && parsed.is_error === false;
  return {
    ok,
    summary: typeof parsed.result === "string" ? parsed.result : JSON.stringify(parsed),
    deviations: [],
    artifacts: [],
    raw: stdout,
    meta: {
      numTurns: parsed.num_turns,
      costUsd: parsed.total_cost_usd,
      sessionId: parsed.session_id,
      subtype: parsed.subtype,
    },
  };
}
