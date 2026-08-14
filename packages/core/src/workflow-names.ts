export const ISSUE_WORKFLOW_NAME = "issueWorkflow";

/**
 * The entity workflow ID: one GitHub issue == one issueWorkflow. Kept to the
 * same "pipeline-" prefix scheme the CLI has always used, so nothing about
 * how a human addresses a pipeline changes.
 */
export function issueWorkflowId(owner: string, repo: string, issueNumber: number): string {
  return `pipeline-${owner}-${repo}-${issueNumber}`;
}
