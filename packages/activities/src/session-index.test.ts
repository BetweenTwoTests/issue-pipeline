import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import type { AgentSessionRecord } from "@issue-pipeline/core";
import { appendAgentSessionRecord } from "./session-index";

function record(overrides: Partial<AgentSessionRecord>): AgentSessionRecord {
  return {
    repoSlug: "acme/widgets",
    issueNumber: 1,
    phaseNumber: 1,
    attempt: 0,
    startedAt: "2026-08-14T00:00:00.000Z",
    finishedAt: "2026-08-14T00:05:00.000Z",
    role: "executor",
    workflowId: "pipeline-acme-widgets-1",
    sessionId: "11111111-2222-3333-4444-555555555555",
    cwd: "/tmp/worktree",
    ok: true,
    costUsd: 0.42,
    numTurns: 12,
    ...overrides,
  };
}

test("appendAgentSessionRecord creates parent dirs and appends one JSON line per call", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "issue-pipeline-session-index-"));
  try {
    const indexPath = path.join(dir, "nested", "agent-sessions.jsonl");
    await appendAgentSessionRecord(indexPath, record({ attempt: 0 }));
    await appendAgentSessionRecord(indexPath, record({ attempt: 1, role: "fixer", ok: false, sessionId: null }));

    const lines = (await fs.readFile(indexPath, "utf8")).trim().split("\n");
    assert.equal(lines.length, 2);
    const first = JSON.parse(lines[0]);
    const second = JSON.parse(lines[1]);
    assert.equal(first.role, "executor");
    assert.equal(first.sessionId, "11111111-2222-3333-4444-555555555555");
    assert.equal(second.role, "fixer");
    assert.equal(second.ok, false);
    assert.equal(second.sessionId, null);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});
