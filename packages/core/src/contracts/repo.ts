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
