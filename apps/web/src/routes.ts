/**
 * Hash-based routing shared by the sidebar and the views. Four params:
 * p (transcript project), s (session), w (pipeline workflow id),
 * i (tracker issue as "owner/repo/number"). Links are plain anchors to
 * these hashes so browser history works without a router.
 */

export interface Route {
  project: string | null;
  session: string | null;
  workflow: string | null;
  issue: string | null;
}

export function parseHash(): Route {
  const params = new URLSearchParams(window.location.hash.replace(/^#/, ""));
  return {
    project: params.get("p"),
    session: params.get("s"),
    workflow: params.get("w"),
    issue: params.get("i"),
  };
}

export function buildHash(parts: Partial<Record<"project" | "session" | "workflow" | "issue", string | null>>): string {
  const params = new URLSearchParams();
  if (parts.project) params.set("p", parts.project);
  if (parts.session) params.set("s", parts.session);
  if (parts.workflow) params.set("w", parts.workflow);
  if (parts.issue) params.set("i", parts.issue);
  return `#${params.toString()}`;
}

export function issueHash(repoOwner: string, repoName: string, number: number): string {
  return buildHash({ issue: `${repoOwner}/${repoName}/${number}` });
}

export function workflowHash(workflowId: string): string {
  return buildHash({ workflow: workflowId });
}

export interface IssueRoute {
  repoOwner: string;
  repoName: string;
  number: number;
}

export function parseIssueRoute(raw: string): IssueRoute | null {
  const match = raw.match(/^([^/]+)\/([^/]+)\/(\d+)$/);
  if (!match) return null;
  return { repoOwner: match[1], repoName: match[2], number: Number(match[3]) };
}
