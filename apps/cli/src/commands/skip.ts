import type { Command } from "commander";
import { skipSignal } from "@issue-pipeline/core";
import { withPipelineHandle } from "../lib/signal-helper";

export function registerSkipCommand(program: Command): void {
  program
    .command("skip")
    .description("Skip the currently parked phase and move on to the next one")
    .argument("<issue-ref>", 'GitHub issue URL or "owner/repo#123"')
    .option("--note <text>", "Optional note to record with the skip")
    .action(async (issueRefArg: string, opts: { note?: string }) => {
      await withPipelineHandle(issueRefArg, async (handle, workflowId) => {
        await handle.signal(skipSignal, { note: opts.note });
        console.log(`Sent skip to ${workflowId}`);
      });
    });
}
