import { proxyActivities } from "@temporalio/workflow";
import type * as activities from "@issue-pipeline/activities";

const { greet } = proxyActivities<typeof activities>({
  startToCloseTimeout: "1 minute",
});

/** M0 round-trip proof: workflow -> activity -> adapter -> core, and back. */
export async function helloWorkflow(name: string): Promise<string> {
  return greet(name);
}
