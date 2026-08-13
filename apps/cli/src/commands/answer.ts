import type { Command } from "commander";
import { questionsAnsweredSignal } from "@issue-pipeline/core";
import { withPipelineHandle } from "../lib/signal-helper";

export function registerAnswerCommand(program: Command): void {
  program
    .command("answer")
    .description("Answer one of a pipeline's numbered blocking questions")
    .argument("<issue-ref>", 'GitHub issue URL or "owner/repo#123"')
    .argument("<index>", "1-based question number, as posted in the pipeline's comment")
    .argument("<text>", "Answer text (quote it if it contains spaces)")
    .action(async (issueRefArg: string, indexArg: string, text: string) => {
      const index = Number(indexArg);
      if (!Number.isInteger(index) || index < 1) {
        throw new Error(`<index> must be a positive integer, got "${indexArg}"`);
      }
      await withPipelineHandle(issueRefArg, async (handle, workflowId) => {
        await handle.signal(questionsAnsweredSignal, { answers: [{ index, text }] });
        console.log(`Sent answer for question ${index} to ${workflowId}`);
      });
    });
}
