import assert from "node:assert/strict";
import { test } from "node:test";
import {
  parseAnswerRequest,
  parseControlRequest,
  parseCreateIssueRequest,
  parseIssueCommentRequest,
  parseIssueKeyParams,
  parseStartRequest,
  WORKFLOW_ID_RE,
} from "./pipeline-requests";

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

test("parseStartRequest accepts owner/repo#N and rejects URLs", () => {
  const ok = parseStartRequest({ issueRef: "acme/widgets#12" });
  assert.deepEqual(ok, { ok: true, value: { ref: { owner: "acme", repo: "widgets", issueNumber: 12 } } });
  // GitHub URLs are rejected: a github.com issue number is not a tracker number.
  assert.equal(parseStartRequest({ issueRef: "https://github.com/acme/widgets/issues/12" }).ok, false);
  assert.equal(parseStartRequest({ issueRef: "" }).ok, false);
});

test("parseCreateIssueRequest validates repo slug, title, and optional body", () => {
  const ok = parseCreateIssueRequest({ repo: "acme/widgets", title: "  Add feature  ", body: "plan text" });
  assert.deepEqual(ok, { ok: true, value: { repoSlug: "acme/widgets", title: "Add feature", body: "plan text" } });

  const noBody = parseCreateIssueRequest({ repo: "acme/widgets", title: "T" });
  assert.deepEqual(noBody, { ok: true, value: { repoSlug: "acme/widgets", title: "T", body: "" } });

  assert.equal(parseCreateIssueRequest({ repo: "not-a-slug", title: "T" }).ok, false);
  assert.equal(parseCreateIssueRequest({ repo: "a/../b", title: "T" }).ok, false);
  assert.equal(parseCreateIssueRequest({ repo: "acme/widgets", title: "   " }).ok, false);
  assert.equal(parseCreateIssueRequest({ repo: "acme/widgets", title: "T", body: 5 }).ok, false);
  assert.equal(parseCreateIssueRequest({ repo: "acme/widgets", title: "x".repeat(301) }).ok, false);
});

test("parseIssueCommentRequest validates the issue key and comment body", () => {
  const ok = parseIssueCommentRequest({ repo: "acme/widgets", number: 3, body: "hello" });
  assert.deepEqual(ok, {
    ok: true,
    value: { key: { repoOwner: "acme", repoName: "widgets", number: 3 }, body: "hello" },
  });
  assert.equal(parseIssueCommentRequest({ repo: "acme/widgets", number: 0, body: "x" }).ok, false);
  assert.equal(parseIssueCommentRequest({ repo: "acme/widgets", number: 1.5, body: "x" }).ok, false);
  assert.equal(parseIssueCommentRequest({ repo: "acme/widgets", number: 1, body: "  " }).ok, false);
});

test("parseIssueKeyParams parses ?repo=&number= pairs", () => {
  const ok = parseIssueKeyParams("acme/widgets", "7");
  assert.deepEqual(ok, { ok: true, value: { repoOwner: "acme", repoName: "widgets", number: 7 } });
  assert.equal(parseIssueKeyParams("acme", "7").ok, false);
  assert.equal(parseIssueKeyParams("acme/widgets", "-1").ok, false);
  assert.equal(parseIssueKeyParams("acme/widgets", "seven").ok, false);
});

test("WORKFLOW_ID_RE rejects ids with path or query metacharacters", () => {
  assert.equal(WORKFLOW_ID_RE.test("pipeline-acme-widgets-12"), true);
  assert.equal(WORKFLOW_ID_RE.test("a/b"), false);
  assert.equal(WORKFLOW_ID_RE.test("a b"), false);
  assert.equal(WORKFLOW_ID_RE.test(""), false);
  assert.equal(WORKFLOW_ID_RE.test("-leading-dash"), false);
});
