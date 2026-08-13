import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { randomBytes } from "node:crypto";
import {
  GithubCliError,
  composeSubIssueBody,
  parseSubIssueMetadata,
  type RegisteredRepo,
  type SubIssueMetadata,
  type WorklogSections,
} from "@issue-pipeline/core";
import { runCommand, isExecFileError } from "./exec";

export interface RootIssue {
  number: number;
  title: string;
  body: string;
  url: string;
  state: string;
  labels: string[];
}

export interface CreatedSubIssue {
  number: number;
  url: string;
}

export interface SubIssueSummary {
  number: number;
  url: string;
  state: string;
  title: string;
  metadata: SubIssueMetadata | null;
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

/** Like gh(), but returns null instead of throwing when gh's stderr indicates
 * "not found" -- used for idempotency checks that shouldn't hard-fail. */
async function ghOrNull(args: string[]): Promise<string | null> {
  try {
    const { stdout } = await runCommand("gh", args);
    return stdout;
  } catch {
    return null;
  }
}

export async function fetchRootIssue(repo: RegisteredRepo, issueNumber: number): Promise<RootIssue> {
  const stdout = await gh([
    "issue",
    "view",
    String(issueNumber),
    "--json",
    "title,body,number,url,state,labels",
    "-R",
    `${repo.owner}/${repo.repo}`,
  ]);
  const parsed = JSON.parse(stdout);
  return {
    number: parsed.number,
    title: parsed.title,
    body: parsed.body ?? "",
    url: parsed.url,
    state: parsed.state,
    labels: (parsed.labels ?? []).map((l: { name: string }) => l.name),
  };
}

export async function listSubIssues(repo: RegisteredRepo, parentIssueNumber: number): Promise<SubIssueSummary[]> {
  const stdout = await gh([
    "api",
    `repos/${repo.owner}/${repo.repo}/issues/${parentIssueNumber}/sub_issues`,
    "--paginate",
  ]);
  const issues: Array<{ number: number; html_url: string; state: string; title: string; body: string | null }> =
    JSON.parse(stdout);
  return issues.map((issue) => ({
    number: issue.number,
    url: issue.html_url,
    state: issue.state,
    title: issue.title,
    metadata: parseSubIssueMetadata(issue.body),
  }));
}

export async function getSubIssueMetadata(repo: RegisteredRepo, issueNumber: number): Promise<SubIssueMetadata | null> {
  const body = await ghOrNull([
    "issue",
    "view",
    String(issueNumber),
    "--json",
    "body",
    "-R",
    `${repo.owner}/${repo.repo}`,
    "-q",
    ".body",
  ]);
  return parseSubIssueMetadata(body);
}

/** Resolves the GraphQL node id for an issue (needed by addSubIssue) via its REST resource. */
async function fetchIssueNodeId(repo: RegisteredRepo, issueNumber: number): Promise<string> {
  const stdout = await gh([
    "api",
    `repos/${repo.owner}/${repo.repo}/issues/${issueNumber}`,
    "--jq",
    ".node_id",
  ]);
  return stdout.trim();
}

/** Idempotent: no-ops if childIssueUrl is already linked under parentIssueNumber. */
export async function linkSubIssue(repo: RegisteredRepo, parentIssueNumber: number, childIssueNumber: number, childIssueUrl: string): Promise<void> {
  const existing = await listSubIssues(repo, parentIssueNumber);
  if (existing.some((s) => s.number === childIssueNumber)) return;

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

/**
 * Idempotent: checks listSubIssues() for an existing {parent, phase} match
 * before creating -- guards against Temporal at-least-once activity retries
 * producing duplicate sub-issues.
 */
export async function createSubIssue(
  repo: RegisteredRepo,
  input: { parentIssueNumber: number; phase: number; title: string; bodyMarkdown: string; baseBranch: string },
): Promise<CreatedSubIssue> {
  const existing = await listSubIssues(repo, input.parentIssueNumber);
  const already = existing.find((s) => s.metadata?.parent === input.parentIssueNumber && s.metadata?.phase === input.phase);
  if (already) return { number: already.number, url: already.url };

  const metadata: SubIssueMetadata = {
    parent: input.parentIssueNumber,
    phase: input.phase,
    base_branch: input.baseBranch,
  };
  const fullBody = composeSubIssueBody(metadata, input.bodyMarkdown);

  const url = await withTempFile(fullBody, (tmpPath) =>
    gh(["issue", "create", "--title", input.title, "--body-file", tmpPath, "-R", `${repo.owner}/${repo.repo}`]),
  );
  const trimmedUrl = url.trim();
  const match = trimmedUrl.match(/\/issues\/(\d+)$/);
  if (!match) {
    throw new GithubCliError(`could not parse issue number from gh issue create output: ${trimmedUrl}`, "issue create", trimmedUrl);
  }
  const number = Number(match[1]);
  await linkSubIssue(repo, input.parentIssueNumber, number, trimmedUrl);
  return { number, url: trimmedUrl };
}

export async function postComment(repo: RegisteredRepo, issueNumber: number, bodyMarkdown: string): Promise<{ url: string }> {
  const url = await withTempFile(bodyMarkdown, (tmpPath) =>
    gh(["issue", "comment", String(issueNumber), "--body-file", tmpPath, "-R", `${repo.owner}/${repo.repo}`]),
  );
  return { url: url.trim() };
}

export async function postWorklogComment(
  repo: RegisteredRepo,
  issueNumber: number,
  worklog: WorklogSections,
): Promise<{ url: string }> {
  const body = `## Worklog (status: ${worklog.status})

### Done
${worklog.done}

### Deviations from spec
${worklog.deviationsFromSpec}

### Surprises / new findings
${worklog.surprisesFindings}

### Follow-ups
${worklog.followUps}`;
  return postComment(repo, issueNumber, body);
}

// GitHub requires a label to already exist on the repo before it can be
// added to (or removed from) an issue -- verified directly: `gh issue edit
// --add-label`/`--remove-label` both fail with "'<label>' not found" for a
// label that was never created on the repo. These pipeline:* labels are
// ours; nothing else creates them, so a freshly-registered repo has none of
// them. A fixed color makes them visually recognizable as pipeline-owned.
const PIPELINE_LABEL_COLOR = "5319e7";

async function ensureLabelExists(repo: RegisteredRepo, label: string): Promise<void> {
  // --force updates color/description if the label already exists rather
  // than erroring -- idempotent, safe to call unconditionally.
  await gh(["label", "create", label, "-R", `${repo.owner}/${repo.repo}`, "--color", PIPELINE_LABEL_COLOR, "--force"]);
}

export async function addLabels(repo: RegisteredRepo, issueNumber: number, labels: string[]): Promise<void> {
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

export async function removeLabels(repo: RegisteredRepo, issueNumber: number, labels: string[]): Promise<void> {
  if (labels.length === 0) return;
  try {
    await gh(["issue", "edit", String(issueNumber), "--remove-label", labels.join(","), "-R", `${repo.owner}/${repo.repo}`]);
  } catch (err) {
    // A label that doesn't exist on the repo at all can't be applied to the
    // issue either -- "remove it" is vacuously satisfied, not an error.
    if (!(err instanceof GithubCliError) || !/not found/i.test(err.stderr)) throw err;
  }
}

export async function closeSubIssue(repo: RegisteredRepo, issueNumber: number, closingComment: string): Promise<void> {
  await gh(["issue", "close", String(issueNumber), "--comment", closingComment, "-R", `${repo.owner}/${repo.repo}`]);
}

export async function setPullRequestBody(repo: RegisteredRepo, prNumber: number, bodyMarkdown: string): Promise<void> {
  await withTempFile(bodyMarkdown, (tmpPath) =>
    gh(["pr", "edit", String(prNumber), "--body-file", tmpPath, "-R", `${repo.owner}/${repo.repo}`]),
  );
}

export async function getPullRequestForBranch(
  repo: RegisteredRepo,
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

export interface IssueComment {
  body: string;
  author: string;
}

/** Used to assemble prior-phase handoff context (worklog comments) for the executor prompt. */
export async function listComments(repo: RegisteredRepo, issueNumber: number): Promise<IssueComment[]> {
  const stdout = await gh([
    "issue",
    "view",
    String(issueNumber),
    "--json",
    "comments",
    "-R",
    `${repo.owner}/${repo.repo}`,
    "-q",
    ".comments",
  ]);
  const raw: Array<{ body: string; author?: { login?: string } }> = JSON.parse(stdout);
  return raw.map((c) => ({ body: c.body, author: c.author?.login ?? "unknown" }));
}
