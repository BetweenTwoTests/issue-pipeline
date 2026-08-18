import {
  composeSubIssueBody,
  formatIssueRef,
  issueKey,
  type TrackerComment,
  type TrackerIssue,
  type TrackerSyncPort,
} from "@issue-pipeline/core";
import * as store from "@issue-pipeline/store";
import {
  addGithubIssueLabels,
  closeGithubIssue,
  createGithubIssue,
  linkGithubSubIssue,
  postGithubIssueComment,
  removeGithubIssueLabels,
  type GithubTarget,
} from "./github";

/**
 * Mirrors tracker writes to GitHub issues on the repo the issue belongs to
 * (its repoOwner/repoName -- the same slug the phase PRs target). The
 * issue_mirrors table maps each tracker issue to the GitHub issue it
 * created, so later comment/label/close events land on the same GitHub
 * issue. Issues are mirrored lazily: the first event of any type for an
 * unmirrored issue creates the GitHub copy (so enabling sync mid-pipeline
 * picks up from there rather than erroring).
 */

const PROVIDER = "github";

function targetFor(issue: TrackerIssue): GithubTarget {
  return { owner: issue.repoOwner, repo: issue.repoName };
}

function mirrorMarker(issue: TrackerIssue): string {
  return (
    `<!-- mirrored from issue-pipeline ${formatIssueRef(issueKey(issue))} -- ` +
    `the pipeline's app database is the source of truth; edits here are never read back -->`
  );
}

/** GitHub attributes every mirrored comment to the gh token's user, so the
 * real author travels in the body. */
function formatMirroredComment(comment: TrackerComment): string {
  return `_${comment.author} via issue-pipeline:_\n\n${comment.body}`;
}

async function ensureMirroredIssue(
  issue: TrackerIssue,
  parentHint: TrackerIssue | null,
): Promise<store.IssueMirrorRef> {
  const existing = await store.getIssueMirror(issue.id, PROVIDER);
  if (existing) return existing;

  let parentMirror: store.IssueMirrorRef | null = null;
  if (issue.parentNumber !== null) {
    const parent =
      parentHint ??
      (await store.getIssue({ repoOwner: issue.repoOwner, repoName: issue.repoName, number: issue.parentNumber }));
    if (parent) parentMirror = await ensureMirroredIssue(parent, null);
  }

  // Sub-issues carry the same machine-readable metadata comment the
  // pipeline embeds everywhere it writes GitHub sub-issue bodies -- with
  // the GitHub-side parent number, since that's what means something on
  // the mirror.
  const body =
    parentMirror && issue.phase !== null
      ? composeSubIssueBody(
          { parent: parentMirror.externalNumber, phase: issue.phase, base_branch: issue.baseBranch ?? "" },
          `${mirrorMarker(issue)}\n\n${issue.body}`,
        )
      : `${mirrorMarker(issue)}\n\n${issue.body}`;

  const created = await createGithubIssue(targetFor(issue), issue.title, body);
  const mirror: store.IssueMirrorRef = { externalNumber: created.number, externalUrl: created.url };
  await store.saveIssueMirror(issue.id, PROVIDER, mirror);

  if (parentMirror) {
    await linkGithubSubIssue(targetFor(issue), parentMirror.externalNumber, created.url);
  }
  if (issue.labels.length > 0) {
    await addGithubIssueLabels(targetFor(issue), created.number, issue.labels);
  }
  if (issue.state === "closed") {
    await closeGithubIssue(targetFor(issue), created.number);
  }
  return mirror;
}

export const githubTrackerSync: TrackerSyncPort = {
  async mirror(event): Promise<void> {
    switch (event.type) {
      case "issue_created": {
        await ensureMirroredIssue(event.issue, event.parent);
        return;
      }
      case "comment_added": {
        const mirror = await ensureMirroredIssue(event.issue, null);
        await postGithubIssueComment(targetFor(event.issue), mirror.externalNumber, formatMirroredComment(event.comment));
        return;
      }
      case "labels_added": {
        const mirror = await ensureMirroredIssue(event.issue, null);
        await addGithubIssueLabels(targetFor(event.issue), mirror.externalNumber, event.labels);
        return;
      }
      case "labels_removed": {
        const mirror = await ensureMirroredIssue(event.issue, null);
        await removeGithubIssueLabels(targetFor(event.issue), mirror.externalNumber, event.labels);
        return;
      }
      case "issue_closed": {
        const mirror = await ensureMirroredIssue(event.issue, null);
        await closeGithubIssue(targetFor(event.issue), mirror.externalNumber);
        return;
      }
    }
  },
};
