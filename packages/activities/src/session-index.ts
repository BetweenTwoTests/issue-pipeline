import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { buildAgentSessionsIndexPath, type AgentSessionRecord } from "@issue-pipeline/core";

/**
 * Appends one record to the agent-session index (JSONL). The index is what
 * ties a pipeline stage (repo/issue/phase/role/attempt) to its Claude Code
 * session id -- the transcript itself already lives in Claude Code's own
 * session store (~/.claude/projects/<cwd-derived-dir>/<sessionId>.jsonl),
 * written by the claude CLI for every -p run; the pipeline deliberately
 * stores no second copy.
 *
 * Split from runAgent so the append logic is unit-testable against a temp
 * path; runAgent passes the real ~/pipelines location.
 */
export async function appendAgentSessionRecord(indexPath: string, record: AgentSessionRecord): Promise<void> {
  await fs.mkdir(path.dirname(indexPath), { recursive: true });
  await fs.appendFile(indexPath, `${JSON.stringify(record)}\n`, "utf8");
}

export function defaultAgentSessionsIndexPath(): string {
  return buildAgentSessionsIndexPath(os.homedir());
}
