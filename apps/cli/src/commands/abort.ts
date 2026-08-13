import type { Command } from "commander";
import { abortSignal } from "@issue-pipeline/core";
import { withPipelineHandle } from "../lib/signal-helper";

export function registerAbortCommand(program: Command): void {
  program
    .command("abort")
    .description("Abort a pipeline (valid from any non-terminal state)")
    .argument("<issue-ref>", 'GitHub issue URL or "owner/repo#123"')
    .option("--note <text>", "Optional note to record with the abort")
    .action(async (issueRefArg: string, opts: { note?: string }) => {
      await withPipelineHandle(issueRefArg, async (handle, workflowId) => {
        await handle.signal(abortSignal, { note: opts.note });
        console.log(`Sent abort to ${workflowId}`);
      });
    });
}
