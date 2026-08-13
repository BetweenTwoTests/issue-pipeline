import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { randomBytes } from "node:crypto";
import { test } from "node:test";
import type { RegisteredRepo } from "@issue-pipeline/core";
import { createPhaseWorktree } from "./git";
import { runCommand } from "./exec";

/** stack_tool: "git" throughout -- exercises createPhaseWorktree without
 * depending on the `gt` binary or Graphite auth being available in CI. */

async function withSeedRepo(fn: (bareLocalPath: string) => Promise<void>): Promise<void> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "issue-pipeline-git-test-"));
  const seed = path.join(dir, "seed");
  const bare = path.join(dir, "bare.git");
  try {
    await fs.mkdir(seed, { recursive: true });
    await runCommand("git", ["init", "--initial-branch=main"], { cwd: seed });
    await runCommand("git", ["config", "user.email", "test@example.com"], { cwd: seed });
    await runCommand("git", ["config", "user.name", "Test"], { cwd: seed });
    await runCommand("git", ["commit", "--allow-empty", "-m", "root commit"], { cwd: seed });
    await runCommand("git", ["clone", "--bare", seed, bare]);
    await fn(bare);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
}

/** repo.name is randomized per test so the real ~/pipelines/<name> path
 * createPhaseWorktree computes (via the real os.homedir(), by design -- see
 * git.ts) is exclusive to this test and never collides with a real
 * registered repo's worktrees. */
function testRepo(localPath: string): RegisteredRepo {
  return {
    name: `git-test-${randomBytes(6).toString("hex")}`,
    owner: "test-owner",
    repo: "test-repo",
    localPath,
    defaultBranch: "main",
  };
}

async function cleanupWorktreeHome(repo: RegisteredRepo): Promise<void> {
  await fs.rm(path.join(os.homedir(), "pipelines", repo.name), { recursive: true, force: true });
}

test("createPhaseWorktree creates a new worktree checked out on the expected branch", async () => {
  await withSeedRepo(async (bare) => {
    const repo = testRepo(bare);
    try {
      const worktree = await createPhaseWorktree({
        repo,
        rootIssueNumber: 1,
        phase: 1,
        parentRef: "main",
        newBranchName: "pipe-1-p1-test",
        stackTool: "git",
      });
      assert.equal(worktree.branch, "pipe-1-p1-test");
      const { stdout } = await runCommand("git", ["branch", "--show-current"], { cwd: worktree.worktreePath });
      assert.equal(stdout.trim(), "pipe-1-p1-test");
    } finally {
      await cleanupWorktreeHome(repo);
    }
  });
});

test("createPhaseWorktree reuses an existing worktree already on the expected branch", async () => {
  await withSeedRepo(async (bare) => {
    const repo = testRepo(bare);
    try {
      const input = {
        repo,
        rootIssueNumber: 2,
        phase: 1,
        parentRef: "main",
        newBranchName: "pipe-2-p1-test",
        stackTool: "git" as const,
      };
      const first = await createPhaseWorktree(input);
      const second = await createPhaseWorktree(input);
      assert.deepEqual(second, first);
    } finally {
      await cleanupWorktreeHome(repo);
    }
  });
});

test("createPhaseWorktree recreates a stale worktree left detached by an interrupted earlier attempt", async () => {
  await withSeedRepo(async (bare) => {
    const repo = testRepo(bare);
    try {
      // Simulates exactly what's left on disk when an earlier attempt got
      // as far as `git worktree add --detach` but never reached the branch
      // checkout step -- e.g. an activity retry after a transient `gt
      // create`/`git checkout -b` failure, or a worker restart mid-activity.
      // Verified against a real production failure: reusing this blindly
      // (the old behavior) silently hands back a worktree with no branch
      // checked out, which only surfaces much later as an opaque "Cannot
      // perform this operation without a branch checked out" from `gt
      // modify`, deterministically, on every subsequent retry.
      const worktreePath = path.join(os.homedir(), "pipelines", repo.name, "phases", "3", "p1");
      await fs.mkdir(path.dirname(worktreePath), { recursive: true });
      await runCommand("git", ["worktree", "add", "--detach", worktreePath, "main"], { cwd: repo.localPath });

      const before = await runCommand("git", ["branch", "--show-current"], { cwd: worktreePath });
      assert.equal(before.stdout.trim(), "", "sanity check: partial worktree starts detached");

      const worktree = await createPhaseWorktree({
        repo,
        rootIssueNumber: 3,
        phase: 1,
        parentRef: "main",
        newBranchName: "pipe-3-p1-test",
        stackTool: "git",
      });

      assert.equal(worktree.branch, "pipe-3-p1-test");
      const after = await runCommand("git", ["branch", "--show-current"], { cwd: worktree.worktreePath });
      assert.equal(after.stdout.trim(), "pipe-3-p1-test");
    } finally {
      await cleanupWorktreeHome(repo);
    }
  });
});
