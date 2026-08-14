import type { Command } from "commander";
import { issueStatusQuery } from "@issue-pipeline/core";
import { connectClient } from "../lib/client";
import { withPipelineHandle } from "../lib/signal-helper";

export function registerStatusCommand(program: Command): void {
  program
    .command("status")
    .description("With an issue-ref: that pipeline's live status. Without: Temporal connectivity check.")
    .argument("[issue-ref]", 'GitHub issue URL or "owner/repo#123"')
    .action(async (issueRefArg?: string) => {
      if (issueRefArg === undefined) {
        await printNamespaceStatus();
        return;
      }
      await withPipelineHandle(issueRefArg, async (handle, workflowId) => {
        const status = await handle.query(issueStatusQuery);
        console.log(`${workflowId}: ${status.stage}`);
        if (status.pendingQuestions.length > 0) {
          console.log("  open questions (answer each with `pipe answer <issue-ref> <n> \"<text>\"`):");
          status.pendingQuestions.forEach((q, i) => console.log(`    ${i + 1}. ${q}`));
        }
        if (status.phases.length > 0) {
          console.log(`  phases (${status.currentIndex}/${status.totalPhases} advanced):`);
          status.phases.forEach((p, i) => {
            const pr = p.prNumber !== null ? ` PR #${p.prNumber}` : "";
            const branch = p.headBranch ? ` [${p.headBranch}]` : "";
            console.log(`    ${i + 1}. ${p.status.padEnd(7)} ${p.title}${branch}${pr}`);
          });
        }
      });
    });
}

async function printNamespaceStatus(): Promise<void> {
  const { client, namespace } = await connectClient();
  try {
    const info = await client.workflowService.describeNamespace({ namespace });
    console.log(`Connected to namespace "${namespace}"`);
    console.log(`  namespace id: ${info.namespaceInfo?.id ?? "unknown"}`);
    console.log(`  state:        ${info.namespaceInfo?.state ?? "unknown"}`);
  } catch (err) {
    console.error(`Failed to reach Temporal namespace "${namespace}":`, err);
    process.exitCode = 1;
  } finally {
    await client.connection.close();
  }
}
