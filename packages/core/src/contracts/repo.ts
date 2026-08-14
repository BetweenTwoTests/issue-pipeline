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
 * The state-projection database (SQLite, via node:sqlite): pipelines,
 * phases, events, agent_sessions. Lives beside the worktrees, NOT inside
 * any of them (survives worktree cleanup) and NOT inside the dockerized
 * Temporal Postgres (survives `just infra-nuke`, which is documented as
 * the only way to lose workflow history -- analysis history shouldn't
 * share that blast radius). Overridable via PIPELINE_DB_PATH, resolved by
 * the callers that do I/O.
 */
export function buildPipelineDbPath(homeDir: string): string {
  return `${homeDir}/pipelines/pipeline.db`;
}
