import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { randomBytes } from "node:crypto";
import { test } from "node:test";
import type { RegisteredRepo } from "@issue-pipeline/core";
import { createPhaseWorktree, createPlanningWorktree, commitLeftoverChanges, fetchRepo } from "./git";
import { runCommand } from "./exec";

/** stack_tool: "git" throughout most tests -- exercises createPhaseWorktree
 * without depending on the `gt` binary or Graphite auth being available. */

async function withSeedRepo(fn: (bareLocalPath: string, seedPath: string) => Promise<void>): Promise<void> {
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
    await runCommand("git", ["config", "remote.origin.fetch", "+refs/heads/*:refs/remotes/origin/*"], { cwd: bare });
    await fn(bare, seed);
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
      // checkout step -- e.g. an activity retry after a transient failure,
      // or a worker restart mid-activity. Verified against a real
      // production failure: reusing this blindly (the old behavior)
      // silently hands back a worktree with no branch checked out, which
      // only surfaces much later as an opaque "Cannot perform this
      // operation without a branch checked out", deterministically, on
      // every subsequent retry.
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

test("commitLeftoverChanges commits dirty files as a NEW commit and no-ops on a clean tree", async () => {
  await withSeedRepo(async (bare) => {
    const repo = testRepo(bare);
    try {
      const worktree = await createPhaseWorktree({
        repo,
        rootIssueNumber: 4,
        phase: 1,
        parentRef: "main",
        newBranchName: "pipe-4-p1-test",
        stackTool: "git",
      });

      const clean = await commitLeftoverChanges({ worktreePath: worktree.worktreePath, message: "leftovers" });
      assert.equal(clean.committed, false);

      await fs.writeFile(path.join(worktree.worktreePath, "file.txt"), "hello", "utf8");
      const dirty = await commitLeftoverChanges({ worktreePath: worktree.worktreePath, message: "leftovers" });
      assert.equal(dirty.committed, true);

      // A new commit on top of the initial one -- never an amend, which
      // would rewrite a commit the agent may already have pushed.
      const { stdout } = await runCommand("git", ["rev-parse", "HEAD~1"], { cwd: worktree.worktreePath });
      assert.equal(stdout.trim(), worktree.initialCommitSha);
    } finally {
      await cleanupWorktreeHome(repo);
    }
  });
});

test("fetchRepo fast-forwards the bare clone's local trunk ref to origin's tip", async () => {
  await withSeedRepo(async (bare, seed) => {
    const repo = testRepo(bare);
    // Advance the "remote" (seed) after the bare clone was made -- without
    // the second fetch refspec in fetchRepo, refs/heads/main in the bare
    // clone stays frozen at clone time and every planning worktree/phase-1
    // branch would be cut from stale code.
    await runCommand("git", ["commit", "--allow-empty", "-m", "upstream moved"], { cwd: seed });
    const upstream = (await runCommand("git", ["rev-parse", "main"], { cwd: seed })).stdout.trim();

    const before = (await runCommand("git", ["rev-parse", "main"], { cwd: bare })).stdout.trim();
    assert.notEqual(before, upstream, "sanity check: bare clone starts stale");

    await fetchRepo(repo);
    const after = (await runCommand("git", ["rev-parse", "main"], { cwd: bare })).stdout.trim();
    assert.equal(after, upstream);
  });
});

test("createPlanningWorktree checks out a detached read-only copy at trunk and recreates cleanly", async () => {
  await withSeedRepo(async (bare) => {
    const repo = testRepo(bare);
    try {
      const first = await createPlanningWorktree(repo, 5);
      const detached = await runCommand("git", ["branch", "--show-current"], { cwd: first.worktreePath });
      assert.equal(detached.stdout.trim(), "", "planning worktree must be detached (it never commits)");

      // Leave junk behind, then recreate -- must come back clean.
      await fs.writeFile(path.join(first.worktreePath, "junk.txt"), "junk", "utf8");
      const second = await createPlanningWorktree(repo, 5);
      assert.equal(second.worktreePath, first.worktreePath);
      await assert.rejects(() => fs.access(path.join(second.worktreePath, "junk.txt")));
    } finally {
      await cleanupWorktreeHome(repo);
    }
  });
});

/** stack_tool: "graphite" below -- gt is a real local dependency of this
 * package already (README lists it as a prerequisite for running the
 * pipeline at all), and none of init/checkout/track need auth or network,
 * only `gt submit` does -- so these run offline same as the git ones above. */

test("createPhaseWorktree with stackTool graphite leaves the branch tracked (gt parent resolves)", async () => {
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
      // `gt parent` exits non-zero on untracked branches (verified; --quiet
      // suppresses its stdout, so the exit code IS the signal -- same
      // predicate production's isTrackedByGraphite uses). Resolving here
      // proves `gt track` actually registered the branch.
      await assert.doesNotReject(
        runCommand("gt", ["parent", "--no-interactive", "--quiet"], { cwd: worktree.worktreePath }),
      );
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

      // If gt track was never actually (re-)run -- the exact gap this test
      // guards -- `gt parent` exits non-zero with "Cannot perform this
      // operation on untracked branch".
      await assert.doesNotReject(
        runCommand("gt", ["parent", "--no-interactive", "--quiet"], { cwd: worktree.worktreePath }),
      );
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
      const result = await commitLeftoverChanges({
        worktreePath: phase2.worktreePath,
        message: "phase 2 leftovers",
      });
      assert.equal(result.committed, true);
    } finally {
      await cleanupWorktreeHome(repo);
    }
  });
});
