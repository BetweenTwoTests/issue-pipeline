import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { buildAgentSessionsIndexPath, type AgentSessionRecord } from "@issue-pipeline/core";

/** One row in the viewer's session list. Two sources:
 * - "index": a line the pipeline wrote to ~/pipelines/agent-sessions.jsonl
 *   (rich: role/phase/attempt/cost).
 * - "discovered": a transcript found by scanning Claude Code's session store
 *   for directories whose (cwd-derived) name looks like a pipeline worktree
 *   -- covers sessions from before the index existed and any index-write
 *   failure. Stage info is reconstructed from the directory name, so it's
 *   best-effort.
 */
export interface ViewerSession {
  sessionId: string;
  source: "index" | "discovered";
  repoSlug: string | null;
  repoName: string | null;
  issueNumber: number | null;
  phaseNumber: number | null;
  role: string | null;
  attempt: number | null;
  startedAt: string | null;
  ok: boolean | null;
  costUsd: number | null;
  numTurns: number | null;
  cwd: string | null;
  workflowId: string | null;
  transcriptPath: string | null;
  sizeBytes: number;
}

const SESSION_FILE_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.jsonl$/i;
export const SESSION_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Claude Code derives a session-store directory from the session's cwd by
// replacing path separators (and other non-alphanumerics like ".") with "-".
// A pipeline phase worktree ~/pipelines/<repo>/phases/<n>/p<k> therefore
// becomes ...-pipelines-<repo>-phases-<n>-p<k>. <repo> may itself contain
// dashes, so these anchor on the "-pipelines-" marker and the tail shape.
const PHASE_DIR_RE = /-pipelines-(.+)-phases-(\d+)-p(\d+)$/;
const PLANNING_DIR_RE = /-pipelines-(.+)-phases-(\d+)-planning$/;
// The pre-redesign planner ran in the bare clone at ~/pipelines/<repo>/.repo
// ("." also munges to "-", hence the double dash).
const LEGACY_PLANNER_DIR_RE = /-pipelines-(.+)--repo$/;

function claudeProjectsDir(): string {
  return path.join(os.homedir(), ".claude", "projects");
}

async function statOrNull(p: string): Promise<{ size: number; mtimeMs: number } | null> {
  try {
    const st = await fs.stat(p);
    return { size: st.size, mtimeMs: st.mtimeMs };
  } catch {
    return null;
  }
}

async function readJsonlRecords(indexPath: string): Promise<AgentSessionRecord[]> {
  let raw: string;
  try {
    raw = await fs.readFile(indexPath, "utf8");
  } catch {
    return [];
  }
  const records: AgentSessionRecord[] = [];
  for (const line of raw.split("\n")) {
    if (line.trim() === "") continue;
    try {
      records.push(JSON.parse(line) as AgentSessionRecord);
    } catch {
      // a torn/corrupt line hides one session, not the whole index
    }
  }
  return records;
}

/** Maps every session id in Claude Code's store to its transcript path. */
async function scanTranscriptStore(): Promise<Map<string, string>> {
  const bySessionId = new Map<string, string>();
  let dirs: string[];
  try {
    dirs = await fs.readdir(claudeProjectsDir());
  } catch {
    return bySessionId;
  }
  for (const dir of dirs) {
    const dirPath = path.join(claudeProjectsDir(), dir);
    let files: string[];
    try {
      files = await fs.readdir(dirPath);
    } catch {
      continue;
    }
    for (const file of files) {
      if (SESSION_FILE_RE.test(file)) {
        bySessionId.set(file.slice(0, -".jsonl".length).toLowerCase(), path.join(dirPath, file));
      }
    }
  }
  return bySessionId;
}

interface DiscoveredStage {
  repoName: string;
  issueNumber: number | null;
  phaseNumber: number | null;
  role: string | null;
}

function parsePipelineDirName(dir: string): DiscoveredStage | null {
  const phase = dir.match(PHASE_DIR_RE);
  if (phase) {
    return { repoName: phase[1], issueNumber: Number(phase[2]), phaseNumber: Number(phase[3]), role: null };
  }
  const planning = dir.match(PLANNING_DIR_RE);
  if (planning) {
    return { repoName: planning[1], issueNumber: Number(planning[2]), phaseNumber: null, role: "planner" };
  }
  const legacy = dir.match(LEGACY_PLANNER_DIR_RE);
  if (legacy) {
    return { repoName: legacy[1], issueNumber: null, phaseNumber: null, role: "planner" };
  }
  return null;
}

export async function listSessions(): Promise<ViewerSession[]> {
  const transcriptPaths = await scanTranscriptStore();
  const sessions: ViewerSession[] = [];
  const seen = new Set<string>();

  // 1. The pipeline's own index -- authoritative where present.
  const records = await readJsonlRecords(buildAgentSessionsIndexPath(os.homedir()));
  for (const record of records) {
    const sessionId = record.sessionId?.toLowerCase() ?? null;
    const transcriptPath = sessionId ? (transcriptPaths.get(sessionId) ?? null) : null;
    const st = transcriptPath ? await statOrNull(transcriptPath) : null;
    if (sessionId) seen.add(sessionId);
    sessions.push({
      sessionId: sessionId ?? `no-session-${record.startedAt}-${record.role}`,
      source: "index",
      repoSlug: record.repoSlug ?? null,
      repoName: record.repoSlug ? (record.repoSlug.split("/")[1] ?? record.repoSlug) : null,
      issueNumber: record.issueNumber ?? null,
      phaseNumber: record.phaseNumber ?? null,
      role: record.role ?? null,
      attempt: record.attempt ?? null,
      startedAt: record.startedAt ?? null,
      ok: record.ok ?? null,
      costUsd: record.costUsd ?? null,
      numTurns: record.numTurns ?? null,
      cwd: record.cwd ?? null,
      workflowId: record.workflowId ?? null,
      transcriptPath,
      sizeBytes: st?.size ?? 0,
    });
  }

  // 2. Discovery sweep over the transcript store for pipeline-shaped cwds.
  for (const [sessionId, transcriptPath] of transcriptPaths) {
    if (seen.has(sessionId)) continue;
    const stage = parsePipelineDirName(path.basename(path.dirname(transcriptPath)));
    if (!stage) continue;
    const st = await statOrNull(transcriptPath);
    sessions.push({
      sessionId,
      source: "discovered",
      repoSlug: null,
      repoName: stage.repoName,
      issueNumber: stage.issueNumber,
      phaseNumber: stage.phaseNumber,
      role: stage.role ?? (stage.phaseNumber !== null ? "executor/fixer" : null),
      attempt: null,
      startedAt: st ? new Date(st.mtimeMs).toISOString() : null,
      ok: null,
      costUsd: null,
      numTurns: null,
      cwd: null,
      workflowId: null,
      transcriptPath,
      sizeBytes: st?.size ?? 0,
    });
  }

  sessions.sort((a, b) => (b.startedAt ?? "").localeCompare(a.startedAt ?? ""));
  return sessions;
}

export async function findTranscriptPath(sessionId: string): Promise<string | null> {
  if (!SESSION_ID_RE.test(sessionId)) return null;
  const transcriptPaths = await scanTranscriptStore();
  return transcriptPaths.get(sessionId.toLowerCase()) ?? null;
}

export async function readTranscriptRaw(transcriptPath: string): Promise<string> {
  return fs.readFile(transcriptPath, "utf8");
}
