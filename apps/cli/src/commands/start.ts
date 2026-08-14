import type { Command } from "commander";
import { WorkflowIdReusePolicy } from "@temporalio/client";
import { PIPELINE_TASK_QUEUE, ISSUE_WORKFLOW_NAME, kickoffSignal, type KickoffPayload } from "@issue-pipeline/core";
import { connectClient } from "../lib/client";
import { parseIssueRef, issueRefToWorkflowId } from "../lib/resolve";

export function registerStartCommand(program: Command): void {
  program
    .command("start")
    .description("Start the pipeline for a GitHub issue (one issue == one long-lived workflow)")
    .argument("<issue-ref>", 'GitHub issue URL or "owner/repo#123"')
    .action(async (issueRefArg: string) => {
      const ref = parseIssueRef(issueRefArg);
      const workflowId = issueRefToWorkflowId(ref);
      const { client } = await connectClient();

      try {
        const handle = await client.workflow.signalWithStart(ISSUE_WORKFLOW_NAME, {
          workflowId,
          taskQueue: PIPELINE_TASK_QUEUE,
          // Governs the *closed*-workflow case. REJECT_DUPLICATE (rejects
          // ANY prior execution, including failed ones) was the wrong
          // choice here: it would permanently wedge an issue's workflow ID
          // after any failure, with no way to retry short of manually
          // terminating the old execution in Temporal. ALLOW_DUPLICATE_FAILED_ONLY
          // gives the actually-wanted semantics: block re-running an issue
          // whose pipeline already completed successfully, but freely allow
          // retrying one that failed, was terminated, or was cancelled. A
          // still-running workflow is unaffected either way --
          // signalWithStart just delivers the signal to it.
          workflowIdReusePolicy: WorkflowIdReusePolicy.ALLOW_DUPLICATE_FAILED_ONLY,
          args: [{ owner: ref.owner, repo: ref.repo, issueNumber: ref.issueNumber }],
          signal: kickoffSignal,
          signalArgs: [{ source: "cli", triggeredBy: process.env.USER ?? "unknown" } satisfies KickoffPayload],
        });
        console.log(`Started pipeline: ${handle.workflowId}`);
      } finally {
        await client.connection.close();
      }
    });
}
