import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import { DatabaseSync } from "node:sqlite";
import type { AgentSessionRecord, ProjectPipelineStateInput } from "@issue-pipeline/core";
import { openProjectionStore } from "./projection-db";

async function withTempDb(fn: (dbPath: string) => Promise<void>): Promise<void> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "issue-pipeline-projection-"));
  try {
    await fn(path.join(dir, "nested", "pipeline.db"));
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
}

function snapshot(overrides: Partial<ProjectPipelineStateInput>): ProjectPipelineStateInput {
  return {
    workflowId: "pipeline-acme-widgets-1",
    repoSlug: "acme/widgets",
    issueNumber: 1,
    stage: "planning",
    currentIndex: 0,
    totalPhases: 0,
    outcome: null,
    phases: [],
    event: { seq: 1, type: "pipeline_started" },
    ...overrides,
  };
}

function sessionRecord(overrides: Partial<AgentSessionRecord>): AgentSessionRecord {
  return {
    repoSlug: "acme/widgets",
    issueNumber: 1,
    phaseNumber: 1,
    attempt: 0,
    startedAt: "2026-08-14T00:00:00.000Z",
    finishedAt: "2026-08-14T00:05:00.000Z",
    role: "executor",
    workflowId: "pipeline-acme-widgets-1-phase-0-r0",
    sessionId: "11111111-2222-3333-4444-555555555555",
    cwd: "/tmp/worktree",
    ok: true,
    costUsd: 0.42,
    numTurns: 12,
    ...overrides,
  };
}

test("projectPipelineState upserts the pipeline row, replaces phases, and appends the event", async () => {
  await withTempDb(async (dbPath) => {
    const store = openProjectionStore(dbPath);
    store.projectPipelineState(snapshot({}), "2026-08-14T00:00:00.000Z");
    store.projectPipelineState(
      snapshot({
        stage: "executing",
        totalPhases: 2,
        phases: [
          { title: "Phase A", status: "done", retryGeneration: 0, headBranch: "b1", prNumber: 7, prUrl: "u7" },
          { title: "Phase B", status: "running", retryGeneration: 1, headBranch: null, prNumber: null, prUrl: null },
        ],
        currentIndex: 1,
        event: { seq: 2, type: "phase_started", detail: { phase: 2 } },
      }),
      "2026-08-14T00:10:00.000Z",
    );
    store.close();

    const db = new DatabaseSync(dbPath, { readOnly: true });
    const pipelines = db.prepare("SELECT * FROM pipelines").all() as Array<Record<string, unknown>>;
    assert.equal(pipelines.length, 1, "same workflow_id must upsert, not duplicate");
    assert.equal(pipelines[0].stage, "executing");
    assert.equal(pipelines[0].started_at, "2026-08-14T00:00:00.000Z", "started_at survives upserts");
    assert.equal(pipelines[0].updated_at, "2026-08-14T00:10:00.000Z");

    const phases = db.prepare("SELECT * FROM phases ORDER BY phase_number").all() as Array<Record<string, unknown>>;
    assert.equal(phases.length, 2);
    assert.equal(phases[0].status, "done");
    assert.equal(phases[0].pr_number, 7);
    assert.equal(phases[1].retry_generation, 1);

    const events = db.prepare("SELECT * FROM events ORDER BY seq").all() as Array<Record<string, unknown>>;
    assert.equal(events.length, 2);
    assert.equal(events[1].type, "phase_started");
    assert.equal(JSON.parse(events[1].detail as string).phase, 2);
    db.close();
  });
});

test("events are idempotent per (source_workflow_id, seq) -- an activity retry replaces, never duplicates", async () => {
  await withTempDb(async (dbPath) => {
    const store = openProjectionStore(dbPath);
    store.recordPipelineEvent(
      { pipelineWorkflowId: "p", sourceWorkflowId: "p-phase-0-r0", event: { seq: 1, type: "attempt_started" } },
      "t1",
    );
    store.recordPipelineEvent(
      { pipelineWorkflowId: "p", sourceWorkflowId: "p-phase-0-r0", event: { seq: 1, type: "attempt_started" } },
      "t2",
    );
    // Same seq from a DIFFERENT source (the parent) must not collide.
    store.recordPipelineEvent(
      { pipelineWorkflowId: "p", sourceWorkflowId: "p", event: { seq: 1, type: "pipeline_started" } },
      "t3",
    );
    store.close();

    const db = new DatabaseSync(dbPath, { readOnly: true });
    const events = db.prepare("SELECT * FROM events").all() as Array<Record<string, unknown>>;
    assert.equal(events.length, 2);
    db.close();
  });
});

test("recordAgentSession dedupes by session id but keeps crashed runs (null session id)", async () => {
  await withTempDb(async (dbPath) => {
    const store = openProjectionStore(dbPath);
    store.recordAgentSession(sessionRecord({}));
    store.recordAgentSession(sessionRecord({})); // duplicate session id -> ignored
    store.recordAgentSession(sessionRecord({ sessionId: null, ok: false, attempt: 1, role: "fixer" }));
    store.recordAgentSession(sessionRecord({ sessionId: null, ok: false, attempt: 2, role: "fixer" }));
    store.close();

    const db = new DatabaseSync(dbPath, { readOnly: true });
    const rows = db.prepare("SELECT role, ok, session_id FROM agent_sessions ORDER BY session_pk").all() as Array<
      Record<string, unknown>
    >;
    assert.equal(rows.length, 3, "one deduped executor + two distinct crashed fixers");
    assert.equal(rows[0].ok, 1);
    assert.equal(rows[1].session_id, null);
    db.close();
  });
});
