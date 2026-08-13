import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { randomBytes } from "node:crypto";
import type { AgentResult, RoleConfig } from "@issue-pipeline/core";
import { spawnWithTimeout, tryGetActivityCancellationSignal, tryHeartbeat } from "./process";

const CODEX_BIN = process.env.PIPELINE_CODEX_BIN ?? "codex";

export interface CodexRunInput {
  prompt: string;
  cwd: string;
  role: RoleConfig;
}

export async function run(input: CodexRunInput): Promise<AgentResult> {
  const lastMessagePath = path.join(os.tmpdir(), `codex-last-message-${randomBytes(8).toString("hex")}.txt`);

  // `-a never` is a TOP-LEVEL codex flag (must precede the `exec` subcommand,
  // not follow it) -- verified against a real invocation. It means execution
  // failures are returned to the model instead of asking a human for
  // approval, which matters a lot here: there is no human present in a
  // headless activity, so any approval-seeking policy (including
  // --full-auto's default "on-failure") would hang until the activity times out.
  const args = [
    "-a",
    "never",
    "exec",
    "--sandbox",
    "workspace-write",
    "--skip-git-repo-check",
    "--output-last-message",
    lastMessagePath,
    ...input.role.args,
  ];

  try {
    const { stdout, stderr, exitCode, timedOut } = await spawnWithTimeout(CODEX_BIN, args, {
      cwd: input.cwd,
      stdinData: input.prompt,
      timeoutMs: input.role.timeout_ms,
      signal: tryGetActivityCancellationSignal(),
      onProgress: tryHeartbeat,
    });
    if (timedOut) {
      return {
        ok: false,
        summary: `codex timed out after ${input.role.timeout_ms}ms`,
        deviations: [],
        artifacts: [],
        raw: stdout,
        meta: { timedOut: true },
      };
    }
    return await buildResult(stdout, stderr, exitCode, lastMessagePath);
  } finally {
    await fs.rm(lastMessagePath, { force: true });
  }
}

async function buildResult(
  stdout: string,
  stderr: string,
  exitCode: number | null,
  lastMessagePath: string,
): Promise<AgentResult> {
  let lastMessage = "";
  try {
    lastMessage = (await fs.readFile(lastMessagePath, "utf8")).trim();
  } catch {
    // File genuinely absent (codex crashed before ever writing it) -- fall
    // through with an empty message, not a thrown error.
  }

  if (exitCode !== 0) {
    return {
      ok: false,
      summary: lastMessage || `codex exited ${exitCode}: ${stderr.slice(0, 2000)}`,
      deviations: [],
      artifacts: [],
      raw: stdout,
    };
  }

  return {
    ok: true,
    summary: lastMessage || "(codex produced no final message)",
    deviations: [],
    artifacts: [],
    raw: stdout,
  };
}
