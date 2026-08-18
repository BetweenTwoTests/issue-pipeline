import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import * as path from "node:path";
import { after, test } from "node:test";
import dotenv from "dotenv";
import { TrackerIssueNotFoundError } from "@issue-pipeline/core";

// Runs against the app Postgres from `just infra-up` (ipl-app-postgres) --
// the same local-Docker convention as the workflow tests, which use the
// dockerized Temporal. APP_DATABASE_URL comes from the repo .env.
dotenv.config({ path: path.resolve(__dirname, "../../../.env"), quiet: true });

import {
  addComment,
  addLabels,
  closeIssue,
  createRootIssue,
  createSubIssue,
  disconnectStore,
  getIssue,
  getIssueMirror,
  getPrisma,
  listComments,
  listRootIssues,
  listSubIssues,
  removeLabels,
  saveIssueMirror,
} from "./index";

// Unique owner per run: tests share the dev database, so rows from other
// runs must never be visible to assertions here.
const OWNER = `test-owner-${randomUUID().slice(0, 8)}`;
const REPO = "widgets";

after(async () => {
  await getPrisma().issue.deleteMany({ where: { repoOwner: OWNER } });
  await disconnectStore();
});

test("createRootIssue allocates sequential per-repo numbers", async () => {
  const first = await createRootIssue({ repoOwner: OWNER, repoName: REPO, title: "First", body: "b1" });
  const second = await createRootIssue({ repoOwner: OWNER, repoName: REPO, title: "Second", body: "b2" });
  const otherRepo = await createRootIssue({ repoOwner: OWNER, repoName: "gadgets", title: "Other", body: "b" });

  assert.equal(second.number, first.number + 1);
  assert.equal(otherRepo.number, 1, "each repo has its own number sequence");
  assert.equal(first.state, "open");
  assert.equal(first.parentNumber, null);
});

test("createSubIssue is idempotent on (parent, phase) and carries phase metadata", async () => {
  const root = await createRootIssue({ repoOwner: OWNER, repoName: REPO, title: "Plan", body: "plan body" });
  const key = { repoOwner: OWNER, repoName: REPO, number: root.number };

  const sub = await createSubIssue({ parent: key, phase: 1, title: "Phase 1", body: "spec", baseBranch: "main" });
  const again = await createSubIssue({ parent: key, phase: 1, title: "Phase 1", body: "spec", baseBranch: "main" });

  assert.equal(again.number, sub.number, "re-creating the same phase returns the existing sub-issue");
  assert.equal(sub.parentNumber, root.number);
  assert.equal(sub.phase, 1);
  assert.equal(sub.baseBranch, "main");

  const subs = await listSubIssues(key);
  assert.equal(subs.length, 1);
  assert.equal(subs[0].number, sub.number);
});

test("addComment/listComments round-trip preserves author kind and order", async () => {
  const root = await createRootIssue({ repoOwner: OWNER, repoName: REPO, title: "Comments", body: "" });
  const key = { repoOwner: OWNER, repoName: REPO, number: root.number };

  await addComment(key, { author: "pipeline", authorKind: "pipeline", body: "first" });
  const { issue, comment } = await addComment(key, { author: "executor", authorKind: "agent", body: "## Worklog" });

  assert.equal(issue.number, root.number, "addComment returns the issue snapshot for sync events");
  assert.equal(comment.authorKind, "agent");

  const comments = await listComments(key);
  assert.deepEqual(
    comments.map((c) => [c.author, c.authorKind, c.body]),
    [
      ["pipeline", "pipeline", "first"],
      ["executor", "agent", "## Worklog"],
    ],
  );
});

test("addLabels unions and removeLabels subtracts, both idempotently", async () => {
  const root = await createRootIssue({ repoOwner: OWNER, repoName: REPO, title: "Labels", body: "" });
  const key = { repoOwner: OWNER, repoName: REPO, number: root.number };

  await addLabels(key, ["pipeline:ready", "pipeline:in-progress"]);
  const afterReAdd = await addLabels(key, ["pipeline:in-progress"]);
  assert.deepEqual([...afterReAdd.labels].sort(), ["pipeline:in-progress", "pipeline:ready"]);

  const afterRemove = await removeLabels(key, ["pipeline:ready", "never-existed"]);
  assert.deepEqual(afterRemove.labels, ["pipeline:in-progress"]);
});

test("closeIssue sets closedAt once and is idempotent", async () => {
  const root = await createRootIssue({ repoOwner: OWNER, repoName: REPO, title: "Close me", body: "" });
  const key = { repoOwner: OWNER, repoName: REPO, number: root.number };

  const closed = await closeIssue(key);
  assert.equal(closed.state, "closed");
  assert.ok(closed.closedAt);

  const again = await closeIssue(key);
  assert.equal(again.closedAt, closed.closedAt, "second close keeps the original closedAt");
});

test("missing issues: getIssue returns null, mutations throw TrackerIssueNotFoundError", async () => {
  const missing = { repoOwner: OWNER, repoName: REPO, number: 999_999 };
  assert.equal(await getIssue(missing), null);
  await assert.rejects(
    () => addComment(missing, { author: "pipeline", authorKind: "pipeline", body: "x" }),
    TrackerIssueNotFoundError,
  );
});

test("listRootIssues excludes sub-issues and reports closed/total counts", async () => {
  const localOwner = `${OWNER}-list`;
  const root = await createRootIssue({ repoOwner: localOwner, repoName: REPO, title: "List root", body: "" });
  const key = { repoOwner: localOwner, repoName: REPO, number: root.number };
  const sub1 = await createSubIssue({ parent: key, phase: 1, title: "P1", body: "", baseBranch: "main" });
  await createSubIssue({ parent: key, phase: 2, title: "P2", body: "", baseBranch: "b1" });
  await closeIssue({ repoOwner: localOwner, repoName: REPO, number: sub1.number });

  try {
    const summaries = await listRootIssues();
    const mine = summaries.filter((s) => s.issue.repoOwner === localOwner);
    assert.equal(mine.length, 1, "sub-issues never appear as roots");
    assert.equal(mine[0].subIssuesTotal, 2);
    assert.equal(mine[0].subIssuesClosed, 1);
  } finally {
    await getPrisma().issue.deleteMany({ where: { repoOwner: localOwner } });
  }
});

test("issue mirrors upsert and read back per provider", async () => {
  const root = await createRootIssue({ repoOwner: OWNER, repoName: REPO, title: "Mirrored", body: "" });

  assert.equal(await getIssueMirror(root.id, "github"), null);
  await saveIssueMirror(root.id, "github", { externalNumber: 77, externalUrl: "https://github.com/x/y/issues/77" });
  await saveIssueMirror(root.id, "github", { externalNumber: 78, externalUrl: "https://github.com/x/y/issues/78" });

  const mirror = await getIssueMirror(root.id, "github");
  assert.deepEqual(mirror, { externalNumber: 78, externalUrl: "https://github.com/x/y/issues/78" });
});
