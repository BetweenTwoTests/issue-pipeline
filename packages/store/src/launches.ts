import type { IssueRef } from "@issue-pipeline/core";
import { getPrisma } from "./client";

/**
 * Best-effort audit write. Temporal is the source of truth for the run
 * itself, so a database outage must never block starting a pipeline --
 * failures are logged and swallowed.
 */
export async function recordLaunch(input: {
  workflowId: string;
  ref: IssueRef;
  source: "web" | "cli";
  triggeredBy: string;
}): Promise<void> {
  try {
    await getPrisma().pipelineLaunch.create({
      data: {
        workflowId: input.workflowId,
        owner: input.ref.owner,
        repo: input.ref.repo,
        issueNumber: input.ref.issueNumber,
        source: input.source,
        triggeredBy: input.triggeredBy,
      },
    });
  } catch (err) {
    console.warn(
      `[store] launch audit write failed (the pipeline still started): ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}
