export interface RegisteredRepo {
  name: string;
  owner: string;
  repo: string;
  localPath: string;
  defaultBranch: string;
}

export function githubSlug(r: RegisteredRepo): string {
  return `${r.owner}/${r.repo}`;
}

export function buildPhaseBranchName(
  branchPrefix: string,
  rootIssueNumber: number,
  phase: number,
  slug: string,
): string {
  return `${branchPrefix}/${rootIssueNumber}/p${phase}-${slug}`;
}

export function buildPhaseWorktreePath(
  homeDir: string,
  repoName: string,
  rootIssueNumber: number,
  phase: number,
): string {
  return `${homeDir}/pipelines/${repoName}/phases/${rootIssueNumber}/p${phase}`;
}

/**
 * Where the read-only planning worktree lives -- a sibling of the phase
 * worktrees. The planner runs in Claude Code plan mode with the target repo
 * checked out here (at trunk), so the plan is grounded in the actual code,
 * not just the issue text. Never gets a branch: the planner never commits.
 */
export function buildPlanningWorktreePath(
  homeDir: string,
  repoName: string,
  rootIssueNumber: number,
): string {
  return `${homeDir}/pipelines/${repoName}/phases/${rootIssueNumber}/planning`;
}

/**
 * The agent-session index (JSONL, one AgentSessionRecord per line). Lives
 * beside the worktrees, NOT inside any of them -- it must survive worktree
 * cleanup after an issue completes.
 */
export function buildAgentSessionsIndexPath(homeDir: string): string {
  return `${homeDir}/pipelines/agent-sessions.jsonl`;
}
