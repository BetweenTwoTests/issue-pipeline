export const PLAN_WORKFLOW_NAME = "planWorkflow";

export function planWorkflowId(owner: string, repo: string, issueNumber: number): string {
  return `pipeline-${owner}-${repo}-${issueNumber}`;
}
