import assert from "node:assert/strict";
import { test } from "node:test";
import { buildTranscriptUrl, claudeProjectDirName } from "./transcript-link";

test("claudeProjectDirName flattens every non-alphanumeric character to a dash", () => {
  assert.equal(claudeProjectDirName("/Users/alice/git/demo"), "-Users-alice-git-demo");
  // "." flattens too, so a dotted segment produces a double dash.
  assert.equal(claudeProjectDirName("/Users/alice/pipelines/test-repo/.repo"), "-Users-alice-pipelines-test-repo--repo");
  assert.equal(claudeProjectDirName("/tmp/my_repo v2"), "-tmp-my-repo-v2");
});

test("buildTranscriptUrl composes the viewer hash route and tolerates a trailing slash", () => {
  const expected = "http://localhost:8845/#p=-Users-alice-pipelines-demo-phases-3-p1&s=aaaaaaaa-0000-0000-0000-000000000001";
  assert.equal(
    buildTranscriptUrl(
      "http://localhost:8845",
      "/Users/alice/pipelines/demo/phases/3/p1",
      "aaaaaaaa-0000-0000-0000-000000000001",
    ),
    expected,
  );
  assert.equal(
    buildTranscriptUrl(
      "http://localhost:8845/",
      "/Users/alice/pipelines/demo/phases/3/p1",
      "aaaaaaaa-0000-0000-0000-000000000001",
    ),
    expected,
  );
});
