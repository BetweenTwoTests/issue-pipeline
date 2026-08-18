import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { randomBytes } from "node:crypto";
import { GithubCliError } from "@issue-pipeline/core";
import { runCommand, isExecFileError } from "./exec";

/**
 * GitHub access. Two consumers with different roles:
 * - Pull requests (setPullRequestBody, getPullRequestForBranch): GitHub is
 *   where code review happens, so PRs are real state, used by the phase
 *   workflow directly.
 * - Issue mirroring (the *GithubIssue* functions): tracker state lives in
 *   the app database (packages/store); these are only invoked by the
 *   one-way GitHub sync provider (tracker-sync-github.ts) when
 *   `sync.provider: github` is configured. Nothing reads issue state back
 *   from GitHub.
 */

/** The subset of RegisteredRepo that identifies a GitHub repo (`-R owner/repo`). */
export interface GithubTarget {
  owner: string;
  repo: string;
}

async function withTempFile<T>(content: string, fn: (path: string) => Promise<T>): Promise<T> {
  const tmpPath = path.join(os.tmpdir(), `issue-pipeline-${randomBytes(8).toString("hex")}.md`);
  await fs.writeFile(tmpPath, content, "utf8");
  try {
    return await fn(tmpPath);
  } finally {
    await fs.rm(tmpPath, { force: true });
  }
}

async function gh(args: string[]): Promise<string> {
  try {
    const { stdout } = await runCommand("gh", args);
    return stdout;
  } catch (err) {
    const stderr = isExecFileError(err) ? (err.stderr ?? err.message) : String(err);
    throw new GithubCliError(`gh ${args.join(" ")} failed: ${stderr.trim()}`, args.join(" "), stderr);
  }
}

/** Like gh(), but returns null instead of throwing when gh fails -- used for
 * lookups that shouldn't hard-fail (e.g. "no PR for this branch yet"). */
async function ghOrNull(args: string[]): Promise<string | null> {
  try {
    const { stdout } = await runCommand("gh", args);
    return stdout;
  } catch {
    return null;
  }
}

export async function setPullRequestBody(repo: GithubTarget, prNumber: number, bodyMarkdown: string): Promise<void> {
  await withTempFile(bodyMarkdown, (tmpPath) =>
    gh(["pr", "edit", String(prNumber), "--body-file", tmpPath, "-R", `${repo.owner}/${repo.repo}`]),
  );
}

export async function getPullRequestForBranch(
  repo: GithubTarget,
  branch: string,
): Promise<{ url: string; number: number; title: string } | null> {
  const stdout = await ghOrNull([
    "pr",
    "view",
    branch,
    "--json",
    "url,number,title",
    "-R",
    `${repo.owner}/${repo.repo}`,
  ]);
  if (stdout === null) return null;
  return JSON.parse(stdout);
}

// --- Issue mirroring helpers (GitHub sync provider only) -------------------

export async function createGithubIssue(
  repo: GithubTarget,
  title: string,
  bodyMarkdown: string,
): Promise<{ number: number; url: string }> {
  const url = await withTempFile(bodyMarkdown, (tmpPath) =>
    gh(["issue", "create", "--title", title, "--body-file", tmpPath, "-R", `${repo.owner}/${repo.repo}`]),
  );
  const trimmedUrl = url.trim();
  const match = trimmedUrl.match(/\/issues\/(\d+)$/);
  if (!match) {
    throw new GithubCliError(
      `could not parse issue number from gh issue create output: ${trimmedUrl}`,
      "issue create",
      trimmedUrl,
    );
  }
  return { number: Number(match[1]), url: trimmedUrl };
}

export async function postGithubIssueComment(
  repo: GithubTarget,
  issueNumber: number,
  bodyMarkdown: string,
): Promise<void> {
  await withTempFile(bodyMarkdown, (tmpPath) =>
    gh(["issue", "comment", String(issueNumber), "--body-file", tmpPath, "-R", `${repo.owner}/${repo.repo}`]),
  );
}

/** Resolves the GraphQL node id for an issue (needed by addSubIssue) via its REST resource. */
async function fetchIssueNodeId(repo: GithubTarget, issueNumber: number): Promise<string> {
  const stdout = await gh([
    "api",
    `repos/${repo.owner}/${repo.repo}/issues/${issueNumber}`,
    "--jq",
    ".node_id",
  ]);
  return stdout.trim();
}

/**
 * Links child under parent via the GraphQL addSubIssue mutation -- `gh` has
 * no native sub-issue command (no --parent flag on issue create/edit).
 * replaceParent makes re-linking the same pair idempotent.
 */
export async function linkGithubSubIssue(
  repo: GithubTarget,
  parentIssueNumber: number,
  childIssueUrl: string,
): Promise<void> {
  const parentNodeId = await fetchIssueNodeId(repo, parentIssueNumber);
  await gh([
    "api",
    "graphql",
    "-f",
    `query=mutation($issueId: ID!, $childUrl: String!) {
      addSubIssue(input: { issueId: $issueId, subIssueUrl: $childUrl, replaceParent: true }) {
        issue { number }
        subIssue { number url }
      }
    }`,
    "-f",
    `issueId=${parentNodeId}`,
    "-f",
    `childUrl=${childIssueUrl}`,
  ]);
}

// GitHub requires a label to already exist on the repo before it can be
// added to (or removed from) an issue -- verified directly: `gh issue edit
// --add-label`/`--remove-label` both fail with "'<label>' not found" for a
// label that was never created on the repo. The pipeline:* labels are ours;
// nothing else creates them, so a freshly-mirrored repo has none of them.
// A fixed color makes them visually recognizable as pipeline-owned.
const PIPELINE_LABEL_COLOR = "5319e7";

async function ensureLabelExists(repo: GithubTarget, label: string): Promise<void> {
  // --force updates color/description if the label already exists rather
  // than erroring -- idempotent, safe to call unconditionally.
  await gh(["label", "create", label, "-R", `${repo.owner}/${repo.repo}`, "--color", PIPELINE_LABEL_COLOR, "--force"]);
}

export async function addGithubIssueLabels(repo: GithubTarget, issueNumber: number, labels: string[]): Promise<void> {
  if (labels.length === 0) return;
  const target = `${repo.owner}/${repo.repo}`;
  try {
    await gh(["issue", "edit", String(issueNumber), "--add-label", labels.join(","), "-R", target]);
  } catch (err) {
    if (!(err instanceof GithubCliError) || !/not found/i.test(err.stderr)) throw err;
    // Create whichever labels are missing, then retry once. Only reached
    // the first time a given label is used against a given repo -- it
    // persists on the repo after that.
    for (const label of labels) {
      await ensureLabelExists(repo, label);
    }
    await gh(["issue", "edit", String(issueNumber), "--add-label", labels.join(","), "-R", target]);
  }
}

export async function removeGithubIssueLabels(repo: GithubTarget, issueNumber: number, labels: string[]): Promise<void> {
  if (labels.length === 0) return;
  try {
    await gh(["issue", "edit", String(issueNumber), "--remove-label", labels.join(","), "-R", `${repo.owner}/${repo.repo}`]);
  } catch (err) {
    // A label that doesn't exist on the repo at all can't be applied to the
    // issue either -- "remove it" is vacuously satisfied, not an error.
    if (!(err instanceof GithubCliError) || !/not found/i.test(err.stderr)) throw err;
  }
}

export async function closeGithubIssue(repo: GithubTarget, issueNumber: number): Promise<void> {
  try {
    await gh(["issue", "close", String(issueNumber), "-R", `${repo.owner}/${repo.repo}`]);
  } catch (err) {
    // Mirroring replays state, so "already closed" is success, not failure.
    if (!(err instanceof GithubCliError) || !/already closed/i.test(err.stderr)) throw err;
  }
}
