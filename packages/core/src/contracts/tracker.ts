/**
 * The pipeline's issue tracker: issues, sub-issues, comments, and labels
 * live as rows in the app database (packages/store owns the schema and
 * repository functions; apps/web displays them). These are the pure record
 * shapes shared by activities, the web backend, and the frontend. External
 * trackers (GitHub, Linear) are write-only mirrors fed through
 * TrackerSyncPort -- never read back.
 */

export type IssueState = "open" | "closed";

/**
 * Who wrote a comment. "pipeline" = the orchestrator's own control-plane
 * comments (phase maps, parked notices), "agent" = a planner/executor/fixer
 * run's output (worklogs -- the executor prompt builder harvests prior-phase
 * handoff context from exactly these), "human" = a person via the web UI.
 */
export type CommentAuthorKind = "pipeline" | "agent" | "human";

/** Natural key for an issue: tracker numbers are unique per repo. */
export interface IssueKey {
  repoOwner: string;
  repoName: string;
  number: number;
}

export interface TrackerIssue {
  id: string;
  repoOwner: string;
  repoName: string;
  /** Per-repo sequential number, allocated by the store on creation. */
  number: number;
  title: string;
  body: string;
  state: IssueState;
  labels: string[];
  /** Root issues have no parent; sub-issues point at their plan issue. */
  parentNumber: number | null;
  /** 1-based phase index -- set only on sub-issues. */
  phase: number | null;
  /** The branch this phase stacks on -- set only on sub-issues. */
  baseBranch: string | null;
  createdAt: string;
  updatedAt: string;
  closedAt: string | null;
}

export interface TrackerComment {
  id: string;
  /** Display name: the role for pipeline/agent comments, a username for humans. */
  author: string;
  authorKind: CommentAuthorKind;
  body: string;
  createdAt: string;
}

export function issueKey(issue: Pick<TrackerIssue, "repoOwner" | "repoName" | "number">): IssueKey {
  return { repoOwner: issue.repoOwner, repoName: issue.repoName, number: issue.number };
}

export function formatIssueRef(key: IssueKey): string {
  return `${key.repoOwner}/${key.repoName}#${key.number}`;
}
