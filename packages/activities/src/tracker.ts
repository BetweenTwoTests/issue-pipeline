import {
  TrackerIssueNotFoundError,
  formatIssueRef,
  type IssueKey,
  type IssueState,
  type RegisteredRepo,
  type WorklogSections,
} from "@issue-pipeline/core";
import * as store from "@issue-pipeline/store";
import { mirrorTrackerEvent } from "./tracker-sync";

/**
 * Tracker activities: the issue/sub-issue/comment/label operations the
 * workflows drive. All state lives in the app database (packages/store);
 * every mutation additionally emits a one-way TrackerSyncEvent so a
 * configured external tracker (sync.provider in pipeline.yaml) can mirror
 * it. Mirroring is best-effort and can never fail these activities.
 *
 * Signatures are keyed by (RegisteredRepo, issueNumber) -- the same triple
 * the workflows carry -- so the workflow code doesn't care where tracker
 * state lives.
 */

function keyFor(repo: RegisteredRepo, issueNumber: number): IssueKey {
  return { repoOwner: repo.owner, repoName: repo.repo, number: issueNumber };
}

export interface RootIssue {
  number: number;
  title: string;
  body: string;
  state: IssueState;
  labels: string[];
}

export async function fetchRootIssue(repo: RegisteredRepo, issueNumber: number): Promise<RootIssue> {
  const key = keyFor(repo, issueNumber);
  const issue = await store.getIssue(key);
  if (!issue) {
    throw new TrackerIssueNotFoundError(
      `No tracker issue ${formatIssueRef(key)}. Pipelines run against issues in the app database -- ` +
        `create one first (web UI "New issue" or POST /api/issues), then start the pipeline with its number.`,
      formatIssueRef(key),
    );
  }
  return { number: issue.number, title: issue.title, body: issue.body, state: issue.state, labels: issue.labels };
}

export interface CreatedSubIssue {
  number: number;
}

/**
 * Idempotent under Temporal's at-least-once activity retries: the store
 * enforces one sub-issue per (parent, phase) and returns the existing row
 * on a repeat create.
 */
export async function createSubIssue(
  repo: RegisteredRepo,
  input: { parentIssueNumber: number; phase: number; title: string; bodyMarkdown: string; baseBranch: string },
): Promise<CreatedSubIssue> {
  const parentKey = keyFor(repo, input.parentIssueNumber);
  const issue = await store.createSubIssue({
    parent: parentKey,
    phase: input.phase,
    title: input.title,
    body: input.bodyMarkdown,
    baseBranch: input.baseBranch,
  });
  const parent = await store.getIssue(parentKey);
  await mirrorTrackerEvent({ type: "issue_created", issue, parent });
  return { number: issue.number };
}

export async function postComment(
  repo: RegisteredRepo,
  issueNumber: number,
  bodyMarkdown: string,
): Promise<{ id: string }> {
  const { issue, comment } = await store.addComment(keyFor(repo, issueNumber), {
    author: "pipeline",
    authorKind: "pipeline",
    body: bodyMarkdown,
  });
  await mirrorTrackerEvent({ type: "comment_added", issue, comment });
  return { id: comment.id };
}

export async function postWorklogComment(
  repo: RegisteredRepo,
  issueNumber: number,
  worklog: WorklogSections,
  /** Which agent produced this worklog -- becomes the comment's author. */
  author: "executor" | "fixer",
  /** Appended verbatim after the template (e.g. the transcript footer from
   * buildTranscriptFooter); "" adds nothing. */
  footer = "",
): Promise<{ id: string }> {
  const body = `## Worklog (status: ${worklog.status})

### Done
${worklog.done}

### Deviations from spec
${worklog.deviationsFromSpec}

### Surprises / new findings
${worklog.surprisesFindings}

### Follow-ups
${worklog.followUps}${footer}`;
  const { issue, comment } = await store.addComment(keyFor(repo, issueNumber), {
    author,
    authorKind: "agent",
    body,
  });
  await mirrorTrackerEvent({ type: "comment_added", issue, comment });
  return { id: comment.id };
}

export async function addLabels(repo: RegisteredRepo, issueNumber: number, labels: string[]): Promise<void> {
  if (labels.length === 0) return;
  const issue = await store.addLabels(keyFor(repo, issueNumber), labels);
  await mirrorTrackerEvent({ type: "labels_added", issue, labels });
}

export async function removeLabels(repo: RegisteredRepo, issueNumber: number, labels: string[]): Promise<void> {
  if (labels.length === 0) return;
  const issue = await store.removeLabels(keyFor(repo, issueNumber), labels);
  await mirrorTrackerEvent({ type: "labels_removed", issue, labels });
}

export async function closeSubIssue(
  repo: RegisteredRepo,
  issueNumber: number,
  closingComment: string,
): Promise<void> {
  const key = keyFor(repo, issueNumber);
  const commented = await store.addComment(key, {
    author: "pipeline",
    authorKind: "pipeline",
    body: closingComment,
  });
  await mirrorTrackerEvent({ type: "comment_added", issue: commented.issue, comment: commented.comment });
  const issue = await store.closeIssue(key);
  await mirrorTrackerEvent({ type: "issue_closed", issue });
}
