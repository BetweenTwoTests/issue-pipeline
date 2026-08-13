import type { Command } from "commander";
import { WorkflowIdReusePolicy } from "@temporalio/client";
import { PIPELINE_TASK_QUEUE, PLAN_WORKFLOW_NAME, kickoffSignal, type KickoffPayload } from "@issue-pipeline/core";
import { connectClient } from "../lib/client";
import { parseIssueRef, issueRefToWorkflowId } from "../lib/resolve";

export function registerStartCommand(program: Command): void {
  program
    .command("start")
    .description("Start a pipeline for a GitHub issue containing a plan")
    .argument("<issue-ref>", 'GitHub issue URL or "owner/repo#123"')
    .action(async (issueRefArg: string) => {
      const ref = parseIssueRef(issueRefArg);
      const workflowId = issueRefToWorkflowId(ref);
      const { client } = await connectClient();

      try {
        const handle = await client.workflow.signalWithStart(PLAN_WORKFLOW_NAME, {
          workflowId,
          taskQueue: PIPELINE_TASK_QUEUE,
          // Governs the *closed*-workflow case: one pipeline lifetime per
          // issue. If the workflow is still running, signalWithStart just
          // delivers the signal -- no error.
          workflowIdReusePolicy: WorkflowIdReusePolicy.REJECT_DUPLICATE,
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
