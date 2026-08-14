import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { buildPipelineDbPath } from "@issue-pipeline/core";

/** One row in the viewer's session list. Two sources:
 * - "index": a row the pipeline projected into the SQLite projection DB
 *   (~/pipelines/pipeline.db; rich: role/phase/attempt/cost).
 * - "discovered": a transcript found by scanning Claude Code's session store
 *   for directories whose (cwd-derived) name looks like a pipeline worktree
 *   -- covers sessions from before the projection DB existed and any
 *   projection-write failure. Stage info is reconstructed from the
 *   directory name, so it's best-effort.
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

export interface ViewerPhase {
  phaseNumber: number;
  title: string;
  status: string;
  retryGeneration: number;
  headBranch: string | null;
  prNumber: number | null;
  prUrl: string | null;
}

export interface ViewerPipeline {
  workflowId: string;
  repoSlug: string;
  issueNumber: number;
  stage: string;
  currentIndex: number;
  totalPhases: number;
  outcome: string | null;
  startedAt: string;
  updatedAt: string;
  totalCostUsd: number;
  eventCount: number;
  phases: ViewerPhase[];
}

export interface ViewerEvent {
  sourceWorkflowId: string;
  seq: number;
  type: string;
  detail: Record<string, unknown> | null;
  occurredAt: string;
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

function pipelineDbPath(): string {
  return process.env.PIPELINE_DB_PATH ?? buildPipelineDbPath(os.homedir());
}

/** Read-only, per-request open: no long-lived handle to go stale between
 * the worker's WAL checkpoints, and a missing DB (pipeline never ran on
 * this machine) is just "no rows", not an error. */
function withDb<T>(fn: (db: DatabaseSync) => T, fallback: T): T {
  let db: DatabaseSync;
  try {
    db = new DatabaseSync(pipelineDbPath(), { readOnly: true });
  } catch {
    return fallback;
  }
  try {
    return fn(db);
  } finally {
    db.close();
  }
}

async function statOrNull(p: string): Promise<{ size: number; mtimeMs: number } | null> {
  try {
    const st = await fs.stat(p);
    return { size: st.size, mtimeMs: st.mtimeMs };
  } catch {
    return null;
  }
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

interface SessionRow {
  repo_slug: string;
  issue_number: number;
  phase_number: number | null;
  role: string;
  attempt: number;
  workflow_id: string | null;
  session_id: string | null;
  cwd: string;
  ok: number;
  cost_usd: number | null;
  num_turns: number | null;
  started_at: string;
  finished_at: string;
  session_pk: number;
}

export async function listSessions(): Promise<ViewerSession[]> {
  const transcriptPaths = await scanTranscriptStore();
  const sessions: ViewerSession[] = [];
  const seen = new Set<string>();

  // 1. The projection DB -- authoritative where present.
  const rows = withDb(
    (db) => db.prepare("SELECT * FROM agent_sessions ORDER BY started_at DESC").all() as unknown as SessionRow[],
    [] as SessionRow[],
  );
  for (const row of rows) {
    const sessionId = row.session_id?.toLowerCase() ?? null;
    const transcriptPath = sessionId ? (transcriptPaths.get(sessionId) ?? null) : null;
    const st = transcriptPath ? await statOrNull(transcriptPath) : null;
    if (sessionId) seen.add(sessionId);
    sessions.push({
      sessionId: sessionId ?? `no-session-${row.session_pk}`,
      source: "index",
      repoSlug: row.repo_slug,
      repoName: row.repo_slug.split("/")[1] ?? row.repo_slug,
      issueNumber: row.issue_number,
      phaseNumber: row.phase_number,
      role: row.role,
      attempt: row.attempt,
      startedAt: row.started_at,
      ok: row.ok === 1,
      costUsd: row.cost_usd,
      numTurns: row.num_turns,
      cwd: row.cwd,
      workflowId: row.workflow_id,
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

export async function listPipelines(): Promise<ViewerPipeline[]> {
  return withDb((db) => {
    const pipelines = db
      .prepare(
        `SELECT p.*,
           (SELECT COALESCE(SUM(s.cost_usd), 0) FROM agent_sessions s
             WHERE s.repo_slug = p.repo_slug AND s.issue_number = p.issue_number) AS total_cost,
           (SELECT COUNT(*) FROM events e WHERE e.pipeline_workflow_id = p.workflow_id) AS event_count
         FROM pipelines p ORDER BY p.updated_at DESC`,
      )
      .all() as unknown as Array<Record<string, unknown>>;
    const phasesStmt = db.prepare("SELECT * FROM phases WHERE pipeline_workflow_id = ? ORDER BY phase_number");
    return pipelines.map((p) => ({
      workflowId: p.workflow_id as string,
      repoSlug: p.repo_slug as string,
      issueNumber: p.issue_number as number,
      stage: p.stage as string,
      currentIndex: p.current_index as number,
      totalPhases: p.total_phases as number,
      outcome: (p.outcome as string) ?? null,
      startedAt: p.started_at as string,
      updatedAt: p.updated_at as string,
      totalCostUsd: (p.total_cost as number) ?? 0,
      eventCount: (p.event_count as number) ?? 0,
      phases: (phasesStmt.all(p.workflow_id as string) as unknown as Array<Record<string, unknown>>).map((ph) => ({
        phaseNumber: ph.phase_number as number,
        title: ph.title as string,
        status: ph.status as string,
        retryGeneration: ph.retry_generation as number,
        headBranch: (ph.head_branch as string) ?? null,
        prNumber: (ph.pr_number as number) ?? null,
        prUrl: (ph.pr_url as string) ?? null,
      })),
    }));
  }, []);
}

export async function listEvents(pipelineWorkflowId: string): Promise<ViewerEvent[]> {
  return withDb((db) => {
    const rows = db
      .prepare("SELECT * FROM events WHERE pipeline_workflow_id = ? ORDER BY occurred_at, seq")
      .all(pipelineWorkflowId) as unknown as Array<Record<string, unknown>>;
    return rows.map((r) => {
      let detail: Record<string, unknown> | null = null;
      if (typeof r.detail === "string") {
        try {
          detail = JSON.parse(r.detail);
        } catch {
          detail = { raw: r.detail };
        }
      }
      return {
        sourceWorkflowId: r.source_workflow_id as string,
        seq: r.seq as number,
        type: r.type as string,
        detail,
        occurredAt: r.occurred_at as string,
      };
    });
  }, []);
}

export async function findTranscriptPath(sessionId: string): Promise<string | null> {
  if (!SESSION_ID_RE.test(sessionId)) return null;
  const transcriptPaths = await scanTranscriptStore();
  return transcriptPaths.get(sessionId.toLowerCase()) ?? null;
}

export async function readTranscriptRaw(transcriptPath: string): Promise<string> {
  return fs.readFile(transcriptPath, "utf8");
}
