import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  buildPipelineDbPath,
  type AgentSessionRecord,
  type ProjectPipelineStateInput,
  type RecordPipelineEventInput,
} from "@issue-pipeline/core";

/**
 * The state-projection database (Temporal's recommended pattern: workflow
 * histories are the execution record, analysis belongs in your own store).
 * SQLite via node:sqlite -- zero dependencies, one file
 * (~/pipelines/pipeline.db, PIPELINE_DB_PATH overrides), readable by the
 * viewer and any sqlite client with the docker stack down, and outside the
 * `just infra-nuke` blast radius. node:sqlite still prints an
 * ExperimentalWarning on Node 24 -- verified working (WAL, upserts,
 * read-only opens); the warning is log noise, not instability we've hit.
 *
 * Everything here is a disposable read model: deleting the file loses
 * analysis history, never pipeline correctness.
 */

const SCHEMA = `
CREATE TABLE IF NOT EXISTS pipelines (
  workflow_id TEXT PRIMARY KEY,
  repo_slug TEXT NOT NULL,
  issue_number INTEGER NOT NULL,
  stage TEXT NOT NULL,
  current_index INTEGER NOT NULL,
  total_phases INTEGER NOT NULL,
  outcome TEXT,
  started_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_pipelines_repo_issue ON pipelines (repo_slug, issue_number);

CREATE TABLE IF NOT EXISTS phases (
  pipeline_workflow_id TEXT NOT NULL,
  phase_number INTEGER NOT NULL,
  title TEXT NOT NULL,
  status TEXT NOT NULL,
  retry_generation INTEGER NOT NULL,
  head_branch TEXT,
  pr_number INTEGER,
  pr_url TEXT,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (pipeline_workflow_id, phase_number)
);

CREATE TABLE IF NOT EXISTS events (
  source_workflow_id TEXT NOT NULL,
  seq INTEGER NOT NULL,
  pipeline_workflow_id TEXT NOT NULL,
  type TEXT NOT NULL,
  detail TEXT,
  occurred_at TEXT NOT NULL,
  PRIMARY KEY (source_workflow_id, seq)
);
CREATE INDEX IF NOT EXISTS idx_events_pipeline ON events (pipeline_workflow_id, occurred_at);

CREATE TABLE IF NOT EXISTS agent_sessions (
  session_pk INTEGER PRIMARY KEY AUTOINCREMENT,
  repo_slug TEXT NOT NULL,
  issue_number INTEGER NOT NULL,
  phase_number INTEGER,
  role TEXT NOT NULL,
  attempt INTEGER NOT NULL,
  workflow_id TEXT,
  session_id TEXT,
  cwd TEXT NOT NULL,
  ok INTEGER NOT NULL,
  cost_usd REAL,
  num_turns INTEGER,
  started_at TEXT NOT NULL,
  finished_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_sessions_repo_issue ON agent_sessions (repo_slug, issue_number);
CREATE UNIQUE INDEX IF NOT EXISTS idx_sessions_session_id
  ON agent_sessions (session_id) WHERE session_id IS NOT NULL;
`;

export interface ProjectionStore {
  projectPipelineState(input: ProjectPipelineStateInput, nowIso: string): void;
  recordPipelineEvent(input: RecordPipelineEventInput, nowIso: string): void;
  recordAgentSession(record: AgentSessionRecord): void;
  close(): void;
}

/** Factory (used directly by tests with a temp path); the activities below
 * go through a lazy default-path singleton. */
export function openProjectionStore(dbPath: string): ProjectionStore {
  mkdirSync(path.dirname(dbPath), { recursive: true });
  const db = new DatabaseSync(dbPath);
  // WAL so the viewer's read-only opens never block (or get blocked by) the
  // worker's writes; busy_timeout covers the rare write/write overlap.
  db.exec("PRAGMA journal_mode=WAL");
  db.exec("PRAGMA busy_timeout=5000");
  db.exec("PRAGMA synchronous=NORMAL");
  db.exec(SCHEMA);

  const upsertPipeline = db.prepare(`
    INSERT INTO pipelines (workflow_id, repo_slug, issue_number, stage, current_index, total_phases, outcome, started_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(workflow_id) DO UPDATE SET
      stage = excluded.stage,
      current_index = excluded.current_index,
      total_phases = excluded.total_phases,
      outcome = excluded.outcome,
      updated_at = excluded.updated_at
  `);
  const deletePhases = db.prepare("DELETE FROM phases WHERE pipeline_workflow_id = ?");
  const insertPhase = db.prepare(`
    INSERT INTO phases (pipeline_workflow_id, phase_number, title, status, retry_generation, head_branch, pr_number, pr_url, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  // OR REPLACE keyed on (source_workflow_id, seq): the workflow's own
  // monotonic counter makes at-least-once activity retries idempotent.
  const insertEvent = db.prepare(`
    INSERT OR REPLACE INTO events (source_workflow_id, seq, pipeline_workflow_id, type, detail, occurred_at)
    VALUES (?, ?, ?, ?, ?, ?)
  `);
  // OR IGNORE + the partial unique index on session_id: the same session
  // can never be recorded twice.
  const insertSession = db.prepare(`
    INSERT OR IGNORE INTO agent_sessions (repo_slug, issue_number, phase_number, role, attempt, workflow_id, session_id, cwd, ok, cost_usd, num_turns, started_at, finished_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  function inTransaction(fn: () => void): void {
    db.exec("BEGIN");
    try {
      fn();
      db.exec("COMMIT");
    } catch (err) {
      db.exec("ROLLBACK");
      throw err;
    }
  }

  return {
    projectPipelineState(input, nowIso) {
      inTransaction(() => {
        upsertPipeline.run(
          input.workflowId,
          input.repoSlug,
          input.issueNumber,
          input.stage,
          input.currentIndex,
          input.totalPhases,
          input.outcome ?? null,
          nowIso,
          nowIso,
        );
        deletePhases.run(input.workflowId);
        input.phases.forEach((phase, i) => {
          insertPhase.run(
            input.workflowId,
            i + 1,
            phase.title,
            phase.status,
            phase.retryGeneration,
            phase.headBranch ?? null,
            phase.prNumber ?? null,
            phase.prUrl ?? null,
            nowIso,
          );
        });
        insertEvent.run(
          input.workflowId,
          input.event.seq,
          input.workflowId,
          input.event.type,
          input.event.detail ? JSON.stringify(input.event.detail) : null,
          nowIso,
        );
      });
    },

    recordPipelineEvent(input, nowIso) {
      insertEvent.run(
        input.sourceWorkflowId,
        input.event.seq,
        input.pipelineWorkflowId,
        input.event.type,
        input.event.detail ? JSON.stringify(input.event.detail) : null,
        nowIso,
      );
    },

    recordAgentSession(record) {
      insertSession.run(
        record.repoSlug,
        record.issueNumber,
        record.phaseNumber ?? null,
        record.role,
        record.attempt,
        record.workflowId ?? null,
        record.sessionId ?? null,
        record.cwd,
        record.ok ? 1 : 0,
        record.costUsd ?? null,
        record.numTurns ?? null,
        record.startedAt,
        record.finishedAt,
      );
    },

    close() {
      db.close();
    },
  };
}

export function defaultPipelineDbPath(): string {
  return process.env.PIPELINE_DB_PATH ?? buildPipelineDbPath(os.homedir());
}

let defaultStore: ProjectionStore | null = null;
function getDefaultStore(): ProjectionStore {
  if (!defaultStore) {
    defaultStore = openProjectionStore(defaultPipelineDbPath());
  }
  return defaultStore;
}

// ---- The activity surface (async wrappers over the sync store) ----

export async function projectPipelineState(input: ProjectPipelineStateInput): Promise<void> {
  getDefaultStore().projectPipelineState(input, new Date().toISOString());
}

export async function recordPipelineEvent(input: RecordPipelineEventInput): Promise<void> {
  getDefaultStore().recordPipelineEvent(input, new Date().toISOString());
}

/** Not an activity in practice (runAgent calls it in-process), but exported
 * through the same barrel for tests and symmetry. */
export async function recordAgentSession(record: AgentSessionRecord): Promise<void> {
  getDefaultStore().recordAgentSession(record);
}
