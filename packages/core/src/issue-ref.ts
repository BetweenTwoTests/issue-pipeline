import { planWorkflowId } from "./workflow-names";

export interface IssueRef {
  owner: string;
  repo: string;
  issueNumber: number;
}

const SHORTHAND_RE = /^([^/]+)\/([^/]+)#(\d+)$/;

/**
 * Accepts the "owner/repo#123" shorthand, where 123 is the pipeline
 * tracker's own issue number (the app database's per-repo sequence -- see
 * packages/core/src/contracts/tracker.ts), not a GitHub issue number.
 * GitHub URLs are deliberately rejected: a github.com number would be
 * silently misread as a tracker number.
 */
export function parseIssueRef(ref: string): IssueRef {
  const shorthandMatch = ref.trim().match(SHORTHAND_RE);
  if (shorthandMatch) {
    return { owner: shorthandMatch[1], repo: shorthandMatch[2], issueNumber: Number(shorthandMatch[3]) };
  }
  throw new Error(
    `Could not parse issue reference "${ref}". Expected "owner/repo#123" ` +
      `where 123 is a pipeline tracker issue number (see the web UI's issue list).`,
  );
}

export function issueRefToWorkflowId(ref: IssueRef): string {
  return planWorkflowId(ref.owner, ref.repo, ref.issueNumber);
}
