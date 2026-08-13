import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { randomBytes } from "node:crypto";
import { test } from "node:test";
import type { RegisteredRepo } from "@issue-pipeline/core";
import { createPhaseWorktree, commitWorktreeChanges } from "./git";
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

/** stack_tool: "graphite" below -- gt is a real local dependency of this
 * package already (README lists it as a prerequisite for running the
 * pipeline at all), and none of init/checkout/track/modify need auth or
 * network, only `gt submit` does -- so these run offline same as the git
 * ones above. */

test("createPhaseWorktree with stackTool graphite creates a branch that commitWorktreeChanges can commit to", async () => {
  await withSeedRepo(async (bare) => {
    const repo = testRepo(bare);
    try {
      const worktree = await createPhaseWorktree({
        repo,
        rootIssueNumber: 10,
        phase: 1,
        parentRef: "main",
        newBranchName: "pipe-10-p1-test",
        stackTool: "graphite",
      });
      assert.equal(worktree.branch, "pipe-10-p1-test");

      await fs.writeFile(path.join(worktree.worktreePath, "file.txt"), "hello", "utf8");
      const result = await commitWorktreeChanges({
        worktreePath: worktree.worktreePath,
        stackTool: "graphite",
        message: "test commit",
      });
      assert.equal(result.committed, true);
    } finally {
      await cleanupWorktreeHome(repo);
    }
  });
});

test("createPhaseWorktree with stackTool graphite reuses an existing tracked worktree on the expected branch", async () => {
  await withSeedRepo(async (bare) => {
    const repo = testRepo(bare);
    try {
      const input = {
        repo,
        rootIssueNumber: 11,
        phase: 1,
        parentRef: "main",
        newBranchName: "pipe-11-p1-test",
        stackTool: "graphite" as const,
      };
      const first = await createPhaseWorktree(input);
      const second = await createPhaseWorktree(input);
      assert.deepEqual(second, first);
    } finally {
      await cleanupWorktreeHome(repo);
    }
  });
});

test("createPhaseWorktree with stackTool graphite recreates a worktree that's on the right branch but was never gt track'd", async () => {
  await withSeedRepo(async (bare) => {
    const repo = testRepo(bare);
    try {
      // Simulates dying between `git checkout -b` and the following `gt
      // track` call in createPhaseWorktree -- a real branch exists, with
      // its own commit, but Graphite has no record of it.
      const worktreePath = path.join(os.homedir(), "pipelines", repo.name, "phases", "12", "p1");
      await fs.mkdir(path.dirname(worktreePath), { recursive: true });
      await runCommand("git", ["worktree", "add", "--detach", worktreePath, "main"], { cwd: repo.localPath });
      await runCommand("git", ["checkout", "-b", "pipe-12-p1-test"], { cwd: worktreePath });
      await runCommand("git", ["commit", "--allow-empty", "-m", "start"], { cwd: worktreePath });

      const worktree = await createPhaseWorktree({
        repo,
        rootIssueNumber: 12,
        phase: 1,
        parentRef: "main",
        newBranchName: "pipe-12-p1-test",
        stackTool: "graphite",
      });
      assert.equal(worktree.branch, "pipe-12-p1-test");

      await fs.writeFile(path.join(worktree.worktreePath, "file.txt"), "hello", "utf8");
      const result = await commitWorktreeChanges({
        worktreePath: worktree.worktreePath,
        stackTool: "graphite",
        message: "test commit after recovery",
      });
      // If gt track was never actually (re-)run -- the exact gap this test
      // guards -- gt modify fails with "Cannot perform this operation on
      // untracked branch" instead of committing.
      assert.equal(result.committed, true);
    } finally {
      await cleanupWorktreeHome(repo);
    }
  });
});

test("createPhaseWorktree with stackTool graphite handles parentRef already checked out live in another worktree", async () => {
  await withSeedRepo(async (bare) => {
    const repo = testRepo(bare);
    try {
      // This is exactly the scenario the whole detach-first design exists
      // for: phase 1's branch stays checked out in its own worktree while
      // phase 2 stacks onto it.
      const phase1 = await createPhaseWorktree({
        repo,
        rootIssueNumber: 20,
        phase: 1,
        parentRef: "main",
        newBranchName: "pipe-20-p1-test",
        stackTool: "graphite",
      });
      const phase2 = await createPhaseWorktree({
        repo,
        rootIssueNumber: 20,
        phase: 2,
        parentRef: phase1.branch,
        newBranchName: "pipe-20-p2-test",
        stackTool: "graphite",
      });
      assert.equal(phase2.branch, "pipe-20-p2-test");

      await fs.writeFile(path.join(phase2.worktreePath, "file2.txt"), "hello2", "utf8");
      const result = await commitWorktreeChanges({
        worktreePath: phase2.worktreePath,
        stackTool: "graphite",
        message: "phase 2 commit",
      });
      assert.equal(result.committed, true);
    } finally {
      await cleanupWorktreeHome(repo);
    }
  });
});
