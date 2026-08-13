import assert from "node:assert/strict";
import { test } from "node:test";
import { composeMetadataComment, composeSubIssueBody, parseSubIssueMetadata } from "./sub-issue-metadata";

test("composeMetadataComment produces a parseable HTML comment", () => {
  const metadata = { parent: 123, phase: 2, base_branch: "pipe/123/p1-schema" };
  const comment = composeMetadataComment(metadata);
  assert.match(comment, /^<!-- pipeline: \{.*\} -->$/);
  assert.deepEqual(parseSubIssueMetadata(comment), metadata);
});

test("composeSubIssueBody prefixes the metadata comment before the body", () => {
  const metadata = { parent: 1, phase: 1, base_branch: "main" };
  const body = composeSubIssueBody(metadata, "## Goal\nDo the thing");
  assert.ok(body.startsWith("<!-- pipeline:"));
  assert.ok(body.includes("## Goal\nDo the thing"));
  assert.deepEqual(parseSubIssueMetadata(body), metadata);
});

test("parseSubIssueMetadata round-trips through a full sub-issue body with trailing content", () => {
  const metadata = { parent: 42, phase: 3, base_branch: "pipe/42/p2-api" };
  const body = composeSubIssueBody(metadata, "# Phase 3\n\nSome spec text.\n\n## Acceptance\n- a\n- b");
  assert.deepEqual(parseSubIssueMetadata(body), metadata);
});

test("parseSubIssueMetadata returns null for missing body", () => {
  assert.equal(parseSubIssueMetadata(null), null);
  assert.equal(parseSubIssueMetadata(undefined), null);
  assert.equal(parseSubIssueMetadata(""), null);
});

test("parseSubIssueMetadata returns null (never throws) for a garbled comment", () => {
  assert.equal(parseSubIssueMetadata("<!-- pipeline: {not valid json} -->\n\nbody"), null);
  assert.equal(parseSubIssueMetadata("no metadata comment at all"), null);
});

test("parseSubIssueMetadata returns null for a comment that fails schema validation", () => {
  // "phase" is a required positive int; this comment has it as a string.
  assert.equal(parseSubIssueMetadata('<!-- pipeline: {"parent": 1, "phase": "two", "base_branch": "main"} -->'), null);
});
