import type { Command } from "commander";
import { checkMergesSignal } from "@issue-pipeline/core";
import { withPipelineHandle } from "../lib/signal-helper";

export function registerCheckCommand(program: Command): void {
  program
    .command("check")
    .description("Poll the stack's PR merge states now instead of waiting out the poll interval")
    .argument("<issue-ref>", 'GitHub issue URL or "owner/repo#123"')
    .action(async (issueRefArg: string) => {
      await withPipelineHandle(issueRefArg, async (handle, workflowId) => {
        await handle.signal(checkMergesSignal, {});
        console.log(`Sent merge-check nudge to ${workflowId}`);
      });
    });
}
