import type { Command } from "commander";
import { resumeSignal } from "@issue-pipeline/core";
import { withPipelineHandle } from "../lib/signal-helper";

export function registerResumeCommand(program: Command): void {
  program
    .command("resume")
    .description("Resume a parked pipeline (retries the current phase from scratch)")
    .argument("<issue-ref>", '"owner/repo#123" (tracker issue number)')
    .option("--note <text>", "Optional note to record with the resume")
    .action(async (issueRefArg: string, opts: { note?: string }) => {
      await withPipelineHandle(issueRefArg, async (handle, workflowId) => {
        await handle.signal(resumeSignal, { note: opts.note });
        console.log(`Sent resume to ${workflowId}`);
      });
    });
}
