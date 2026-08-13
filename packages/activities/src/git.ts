import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { GitOperationError, buildPhaseWorktreePath, type RegisteredRepo } from "@issue-pipeline/core";
import { runCommand, isExecFileError } from "./exec";
import { getPullRequestForBranch } from "./github";

async function git(args: string[], opts?: { cwd?: string }): Promise<string> {
  try {
    const { stdout } = await runCommand("git", args, opts);
    return stdout;
  } catch (err) {
    const stderr = isExecFileError(err) ? (err.stderr ?? err.message) : String(err);
    throw new GitOperationError(`git ${args.join(" ")} failed: ${stderr.trim()}`, args.join(" "), stderr);
  }
}

async function gt(args: string[], cwd: string): Promise<string> {
  try {
    const { stdout } = await runCommand("gt", args, { cwd });
    return stdout;
  } catch (err) {
    const stderr = isExecFileError(err) ? (err.stderr ?? err.message) : String(err);
    throw new GitOperationError(`gt ${args.join(" ")} failed: ${stderr.trim()}`, args.join(" "), stderr);
  }
}

/** Only used for the plain-git PR-creation fallback (the Graphite path never
 * needs to shell out to `gh` directly -- `gt submit` handles it). */
async function gh(args: string[], cwd: string): Promise<string> {
  try {
    const { stdout } = await runCommand("gh", args, { cwd });
    return stdout;
  } catch (err) {
    const stderr = isExecFileError(err) ? (err.stderr ?? err.message) : String(err);
    throw new GitOperationError(`gh ${args.join(" ")} failed: ${stderr.trim()}`, args.join(" "), stderr);
  }
}

async function pathExists(p: string): Promise<boolean> {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

/**
 * Idempotent: if localPath already exists, only verifies remote.origin.fetch
 * is set correctly and returns. `git clone --bare` does NOT populate
 * remote.origin.fetch (a real, verified gotcha) -- fixed immediately after
 * cloning, before any fetch is attempted.
 */
export async function ensureBareClone(repo: RegisteredRepo): Promise<void> {
  if (await pathExists(repo.localPath)) {
    await git(["config", "remote.origin.fetch", "+refs/heads/*:refs/remotes/origin/*"], { cwd: repo.localPath });
    return;
  }
  await fs.mkdir(path.dirname(repo.localPath), { recursive: true });
  await git(["clone", "--bare", `git@github.com:${repo.owner}/${repo.repo}.git`, repo.localPath]);
  await git(["config", "remote.origin.fetch", "+refs/heads/*:refs/remotes/origin/*"], { cwd: repo.localPath });
}

export async function fetchRepo(repo: RegisteredRepo): Promise<void> {
  await git(["fetch", "origin", "--prune"], { cwd: repo.localPath });
}

/** gt init is documented idempotent -- always safe to (re)run, so no marker-file check. */
export async function ensureGraphiteInitialized(repo: RegisteredRepo, atWorktreePath: string): Promise<void> {
  await gt(["init", "--trunk", repo.defaultBranch, "--no-interactive", "--quiet"], atWorktreePath);
}

export interface CreatePhaseWorktreeInput {
  repo: RegisteredRepo;
  rootIssueNumber: number;
  /** 1-based. */
  phase: number;
  /** repo.defaultBranch for phase 1, else the previous phase's branch name. */
  parentRef: string;
  newBranchName: string;
  stackTool: "graphite" | "git";
}

export interface PhaseWorktree {
  worktreePath: string;
  branch: string;
  /** The branch's own first commit -- reset target between fixer attempts,
   * distinct from parentRef so a reset never touches the parent's history. */
  initialCommitSha: string;
}

/**
 * A branch already checked out in one worktree cannot be checked out again
 * in another -- this is why every phase (including phase 1, where parentRef
 * is just the default branch) detaches at the parent's tip first, then
 * materializes the new branch inside the worktree. This is Graphite's own
 * documented pattern for exactly this scenario, and it happens to also be
 * simpler than special-casing phase 1: the same detach-then-create sequence
 * works whether parentRef is trunk or a stacked phase branch.
 */
export async function createPhaseWorktree(input: CreatePhaseWorktreeInput): Promise<PhaseWorktree> {
  // Computed here, not by the caller: it depends on os.homedir(), which is
  // real system state workflow code is never allowed to read directly.
  const worktreePath = buildPhaseWorktreePath(os.homedir(), input.repo.name, input.rootIssueNumber, input.phase);

  if (await pathExists(worktreePath)) {
    const currentBranch = (await git(["branch", "--show-current"], { cwd: worktreePath })).trim();
    if (currentBranch === input.newBranchName) {
      const sha = (await git(["rev-parse", "HEAD"], { cwd: worktreePath })).trim();
      return { worktreePath, branch: input.newBranchName, initialCommitSha: sha };
    }
    // Not on the expected branch -- a partial worktree left behind by an
    // interrupted earlier attempt (an activity retry after `gt create`/
    // `git checkout -b` failed partway, or a killed worker), verified via a
    // real repro: reusing it as-is hands back a worktree with no real
    // branch checked out, which then fails opaquely much later at
    // commitWorktreeChanges ("Cannot perform this operation without a
    // branch checked out" from gt, deterministically, on every retry).
    // Tear it down and fall through to recreate it properly rather than
    // trusting whatever state it was left in.
    await removeWorktree(input.repo, worktreePath);
  }

  await fs.mkdir(path.dirname(worktreePath), { recursive: true });
  await git(["worktree", "add", "--detach", worktreePath, input.parentRef], { cwd: input.repo.localPath });

  if (input.stackTool === "graphite") {
    await ensureGraphiteInitialized(input.repo, worktreePath);
    // "If your working directory contains no changes, an empty branch will
    // be created" -- gt create's own documented behavior, giving every
    // phase branch a distinguishing commit before the agent ever runs.
    await gt(["create", input.newBranchName, "--onto", input.parentRef, "--no-interactive", "--quiet"], worktreePath);
  } else {
    await git(["checkout", "-b", input.newBranchName], { cwd: worktreePath });
    // Plain git has no equivalent auto-empty-commit behavior -- create one
    // explicitly so both stack tools give every phase branch the same
    // "always has its own commit to amend" invariant.
    await git(["commit", "--allow-empty", "-m", `Start phase branch ${input.newBranchName}`], { cwd: worktreePath });
  }

  const initialCommitSha = (await git(["rev-parse", "HEAD"], { cwd: worktreePath })).trim();
  return { worktreePath, branch: input.newBranchName, initialCommitSha };
}

/**
 * Resets to the phase branch's OWN initial commit (never to parentRef
 * directly) -- resetting straight to parentRef would collapse the phase
 * branch onto the parent's commit, and a subsequent amend would then
 * corrupt the *parent's* history instead of the phase's own.
 */
export async function resetWorktreeHard(worktreePath: string, initialCommitSha: string): Promise<void> {
  await git(["reset", "--hard", initialCommitSha], { cwd: worktreePath });
  await git(["clean", "-fd"], { cwd: worktreePath });
}

export async function removeWorktree(repo: RegisteredRepo, worktreePath: string): Promise<void> {
  await git(["worktree", "remove", "--force", worktreePath], { cwd: repo.localPath });
}

/**
 * Always amends the branch's own initial commit (created by
 * createPhaseWorktree) rather than creating a new one -- this keeps every
 * phase branch at exactly one commit whether it's the executor's first pass
 * or the Nth fixer attempt (each attempt starts from a resetWorktreeHard
 * back to that same initial commit).
 */
export async function commitWorktreeChanges(input: {
  worktreePath: string;
  stackTool: "graphite" | "git";
  message: string;
}): Promise<{ committed: boolean }> {
  if (input.stackTool === "graphite") {
    try {
      await gt(["modify", "-a", "-m", input.message, "--no-interactive", "--quiet"], input.worktreePath);
      return { committed: true };
    } catch (err) {
      // Best-effort: exact wording for Graphite's "nothing staged" case is
      // not yet verified against a live gt invocation -- broadened match,
      // re-throws anything that doesn't look like this specific case.
      const stderr = isExecFileError(err) ? (err.stderr ?? err.message) : String(err);
      if (/nothing to commit|no changes|nothing staged/i.test(stderr)) {
        return { committed: false };
      }
      throw err;
    }
  }
  await git(["add", "-A"], { cwd: input.worktreePath });
  const status = await git(["status", "--porcelain"], { cwd: input.worktreePath });
  if (status.trim() === "") return { committed: false };
  await git(["commit", "--amend", "-m", input.message], { cwd: input.worktreePath });
  return { committed: true };
}

/**
 * Idempotent: checks getPullRequestForBranch first -- if a PR already
 * exists for `branch`, returns it unchanged instead of re-creating.
 */
export async function submitPullRequest(input: {
  worktreePath: string;
  branch: string;
  parentRef: string;
  stackTool: "graphite" | "git";
  repo: RegisteredRepo;
  remote: string;
  title: string;
  draft: boolean;
}): Promise<{ url: string; number: number }> {
  const existing = await getPullRequestForBranch(input.repo, input.branch);
  if (existing) return existing;

  if (input.stackTool === "graphite") {
    const args = ["submit", "--no-interactive", "--no-edit", "--quiet"];
    if (input.draft) args.push("--draft");
    await gt(args, input.worktreePath);
  } else {
    await git(["push", "-u", input.remote, input.branch], { cwd: input.worktreePath });
    await gh(
      [
        "pr",
        "create",
        "--base",
        input.parentRef,
        "--head",
        input.branch,
        "--title",
        input.title,
        "--body",
        "Opened by issue-pipeline; description follows shortly.",
        "-R",
        `${input.repo.owner}/${input.repo.repo}`,
        ...(input.draft ? ["--draft"] : []),
      ],
      input.worktreePath,
    );
  }

  const pr = await getPullRequestForBranch(input.repo, input.branch);
  if (!pr) {
    throw new GitOperationError(`PR not found for branch ${input.branch} immediately after submit`, "submit", "");
  }
  return pr;
}
