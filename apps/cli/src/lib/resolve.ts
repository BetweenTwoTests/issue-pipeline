import { issueWorkflowId } from "@issue-pipeline/core";

export interface IssueRef {
  owner: string;
  repo: string;
  issueNumber: number;
}

const URL_RE = /^https?:\/\/github\.com\/([^/]+)\/([^/]+)\/issues\/(\d+)\/?$/;
const SHORTHAND_RE = /^([^/]+)\/([^/]+)#(\d+)$/;

/** Accepts a full GitHub issue URL or the "owner/repo#123" shorthand. */
export function parseIssueRef(ref: string): IssueRef {
  const urlMatch = ref.trim().match(URL_RE);
  if (urlMatch) {
    return { owner: urlMatch[1], repo: urlMatch[2], issueNumber: Number(urlMatch[3]) };
  }
  const shorthandMatch = ref.trim().match(SHORTHAND_RE);
  if (shorthandMatch) {
    return { owner: shorthandMatch[1], repo: shorthandMatch[2], issueNumber: Number(shorthandMatch[3]) };
  }
  throw new Error(
    `Could not parse issue reference "${ref}". Expected a GitHub issue URL ` +
      `(https://github.com/owner/repo/issues/123) or "owner/repo#123".`,
  );
}

export function issueRefToWorkflowId(ref: IssueRef): string {
  return issueWorkflowId(ref.owner, ref.repo, ref.issueNumber);
}
