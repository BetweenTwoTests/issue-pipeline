import { WorkflowNotFoundError, type WorkflowHandle } from "@temporalio/client";
import { connectClient } from "./client";
import { parseIssueRef, issueRefToWorkflowId } from "./resolve";

/**
 * Shared by every "signal an existing pipeline" command (resume/skip/abort/
 * answer): resolves the issue ref, connects, hands the caller a live handle,
 * and turns "no such pipeline" into a clear one-line message instead of a
 * raw stack trace -- a typo'd ref or a pipeline that was never started is a
 * routine mistake, not an exceptional one.
 */
export async function withPipelineHandle(
  issueRefArg: string,
  fn: (handle: WorkflowHandle, workflowId: string) => Promise<void>,
): Promise<void> {
  const ref = parseIssueRef(issueRefArg);
  const workflowId = issueRefToWorkflowId(ref);
  const { client } = await connectClient();
  try {
    const handle = client.workflow.getHandle(workflowId);
    await fn(handle, workflowId);
  } catch (err) {
    if (err instanceof WorkflowNotFoundError) {
      console.error(`No pipeline found for "${issueRefArg}" (workflow ID: ${workflowId}). Has it been started with \`pipe start\`?`);
      process.exitCode = 1;
      return;
    }
    throw err;
  } finally {
    await client.connection.close();
  }
}
