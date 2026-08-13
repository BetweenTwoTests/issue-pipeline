import type { Command } from "commander";
import { connectClient } from "../lib/client";

export function registerStatusCommand(program: Command): void {
  program
    .command("status")
    .description("Check connectivity to the issue-pipeline Temporal namespace")
    .action(async () => {
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
    });
}
