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

/** `gt parent` fails with "Cannot perform this operation on untracked
 * branch" (verified directly) when the current branch was never registered
 * via `gt create`/`gt track` -- the cheapest read-only way to tell a fully
 * set up phase branch apart from one where `git checkout -b` succeeded but
 * the following `gt track` did not. */
async function isTrackedByGraphite(worktreePath: string): Promise<boolean> {
  try {
    await gt(["parent", "--no-interactive", "--quiet"], worktreePath);
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
 * materializes the new branch inside the worktree. It happens to also be
 * simpler than special-casing phase 1: the same detach-then-create sequence
 * works whether parentRef is trunk or a stacked phase branch.
 *
 * For the graphite path this means plain `git checkout -b` + `gt track
 * --parent`, NOT `gt create --onto` -- verified directly against a real
 * failure: `gt create` requires the current worktree to already be on some
 * real branch and fails with "Cannot perform this operation without a
 * branch checked out" from a detached HEAD, regardless of --onto (the
 * detach is the whole point, so `gt create` can never be used directly
 * here). `gt track --parent <ref>` only touches Graphite's own metadata db,
 * so it works even while <ref> is checked out live in a different worktree
 * -- verified directly against that exact scenario too.
 */
export async function createPhaseWorktree(input: CreatePhaseWorktreeInput): Promise<PhaseWorktree> {
  // Computed here, not by the caller: it depends on os.homedir(), which is
  // real system state workflow code is never allowed to read directly.
  const worktreePath = buildPhaseWorktreePath(os.homedir(), input.repo.name, input.rootIssueNumber, input.phase);

  if (await pathExists(worktreePath)) {
    const currentBranch = (await git(["branch", "--show-current"], { cwd: worktreePath })).trim();
    const onExpectedBranch = currentBranch === input.newBranchName;
    // For graphite, being on the right branch isn't enough on its own -- an
    // interrupted earlier attempt could have completed `git checkout -b`
    // but died before the following `gt track` call, leaving a branch
    // that's real but unknown to Graphite's stack metadata.
    const reusable = onExpectedBranch && (input.stackTool !== "graphite" || (await isTrackedByGraphite(worktreePath)));
    if (reusable) {
      const sha = (await git(["rev-parse", "HEAD"], { cwd: worktreePath })).trim();
      return { worktreePath, branch: input.newBranchName, initialCommitSha: sha };
    }
    // A partial worktree left behind by an interrupted earlier attempt (an
    // activity retry after `gt track`/`git checkout -b` failed partway, or a
    // killed worker) -- verified via a real repro: reusing a branchless one
    // as-is fails opaquely much later at commitWorktreeChanges ("Cannot
    // perform this operation without a branch checked out" from gt,
    // deterministically, on every retry). Tear it down and fall through to
    // recreate it properly rather than trusting whatever state it was left
    // in.
    await removeWorktree(input.repo, worktreePath);
  }

  await fs.mkdir(path.dirname(worktreePath), { recursive: true });
  await git(["worktree", "add", "--detach", worktreePath, input.parentRef], { cwd: input.repo.localPath });

  if (input.stackTool === "graphite") {
    await ensureGraphiteInitialized(input.repo, worktreePath);
  }

  // Same for both stack tools: an explicit empty commit gives every phase
  // branch a distinguishing commit of its own (distinct from parentRef)
  // before the agent ever runs, which is what `gt create` would otherwise
  // have given us for free -- see the doc comment above for why `gt
  // create` itself can't be used here.
  //
  // -B, not -b: removeWorktree (above) only tears down the working
  // directory, not the branch ref itself -- if an interrupted earlier
  // attempt got as far as creating newBranchName before dying, the ref is
  // still there (just unchecked-out), and plain -b would fail with "a
  // branch named ... already exists". -B resets it to the fresh detached
  // HEAD instead, which is exactly what recreating-from-scratch means here.
  await git(["checkout", "-B", input.newBranchName], { cwd: worktreePath });
  await git(["commit", "--allow-empty", "-m", `Start phase branch ${input.newBranchName}`], { cwd: worktreePath });

  if (input.stackTool === "graphite") {
    // Registers the branch into Graphite's own stack metadata with the
    // correct parent -- distinct from git's ref/commit graph, which has no
    // notion of "parent branch" at all.
    await gt(["track", "--parent", input.parentRef, "--no-interactive", "--quiet"], worktreePath);
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
