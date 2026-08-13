import { runCommand } from "./exec";
import type { PipelineConfig } from "@issue-pipeline/core";

export interface GateResult {
  name: string;
  ok: boolean;
  exitCode: number | null;
  output: string;
}

export interface GatesResult {
  passed: boolean;
  results: GateResult[];
}

const MAX_OUTPUT_CHARS = 20_000;

/**
 * Always advisory at this layer -- never throws on a non-zero exit (a
 * failing gate is an expected, informational result here, not an activity
 * error). Only a genuine infra failure (command not found) throws.
 */
export async function runLocalGates(worktreePath: string, config: PipelineConfig): Promise<GatesResult> {
  const results: GateResult[] = [];
  for (const gate of config.gates.commands) {
    try {
      const { stdout, stderr } = await runCommand(gate.command, gate.args, {
        cwd: worktreePath,
        timeoutMs: config.gates.timeout_ms,
      });
      results.push({
        name: gate.name,
        ok: true,
        exitCode: 0,
        output: truncate(stdout + stderr),
      });
    } catch (err) {
      const execErr = err as { code?: number | string; stdout?: string; stderr?: string; message?: string };
      results.push({
        name: gate.name,
        ok: false,
        exitCode: typeof execErr.code === "number" ? execErr.code : null,
        output: truncate((execErr.stdout ?? "") + (execErr.stderr ?? execErr.message ?? "")),
      });
    }
  }
  return { passed: results.every((r) => r.ok), results };
}

function truncate(text: string): string {
  return text.length > MAX_OUTPUT_CHARS ? `${text.slice(0, MAX_OUTPUT_CHARS)}\n...[truncated]` : text;
}
