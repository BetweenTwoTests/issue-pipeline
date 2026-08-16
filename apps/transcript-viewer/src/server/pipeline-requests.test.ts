import assert from "node:assert/strict";
import { test } from "node:test";
import { parseAnswerRequest, parseControlRequest, WORKFLOW_ID_RE } from "./pipeline-requests";

test("parseAnswerRequest accepts a well-formed body and trims answer text", () => {
  const result = parseAnswerRequest({
    workflowId: "pipeline-acme-widgets-1",
    answers: [{ index: 2, text: "  Use Postgres.  " }],
  });
  assert.deepEqual(result, {
    ok: true,
    value: { workflowId: "pipeline-acme-widgets-1", answers: [{ index: 2, text: "Use Postgres." }] },
  });
});

test("parseAnswerRequest rejects malformed shapes", () => {
  assert.equal(parseAnswerRequest(null).ok, false);
  assert.equal(parseAnswerRequest([]).ok, false);
  assert.equal(parseAnswerRequest({ workflowId: "x y", answers: [{ index: 1, text: "a" }] }).ok, false);
  assert.equal(parseAnswerRequest({ workflowId: "ok-id", answers: [] }).ok, false);
  assert.equal(parseAnswerRequest({ workflowId: "ok-id", answers: [{ index: 0, text: "a" }] }).ok, false);
  assert.equal(parseAnswerRequest({ workflowId: "ok-id", answers: [{ index: 1.5, text: "a" }] }).ok, false);
  assert.equal(parseAnswerRequest({ workflowId: "ok-id", answers: [{ index: 1, text: "   " }] }).ok, false);
  assert.equal(parseAnswerRequest({ workflowId: "ok-id", answers: [{ index: 1, text: "x".repeat(10_001) }] }).ok, false);
});

test("parseControlRequest accepts the three actions and drops empty notes", () => {
  const resume = parseControlRequest({ workflowId: "pipeline-a-b-1", action: "resume", note: "  " });
  assert.deepEqual(resume, { ok: true, value: { workflowId: "pipeline-a-b-1", action: "resume", note: undefined } });
  const abort = parseControlRequest({ workflowId: "pipeline-a-b-1", action: "abort", note: "wrong plan" });
  assert.deepEqual(abort, { ok: true, value: { workflowId: "pipeline-a-b-1", action: "abort", note: "wrong plan" } });
});

test("parseControlRequest rejects unknown actions and bad notes", () => {
  assert.equal(parseControlRequest({ workflowId: "ok-id", action: "terminate" }).ok, false);
  assert.equal(parseControlRequest({ workflowId: "ok-id", action: "resume", note: 5 }).ok, false);
  assert.equal(parseControlRequest({ workflowId: "ok-id", action: "resume", note: "x".repeat(2_001) }).ok, false);
});

test("WORKFLOW_ID_RE rejects ids with path or query metacharacters", () => {
  assert.equal(WORKFLOW_ID_RE.test("pipeline-acme-widgets-12"), true);
  assert.equal(WORKFLOW_ID_RE.test("a/b"), false);
  assert.equal(WORKFLOW_ID_RE.test("a b"), false);
  assert.equal(WORKFLOW_ID_RE.test(""), false);
  assert.equal(WORKFLOW_ID_RE.test("-leading-dash"), false);
});
