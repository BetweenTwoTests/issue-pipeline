import type { TrackerSyncEvent, TrackerSyncPort, TrackerSyncProvider } from "@issue-pipeline/core";
import { formatIssueRef, issueKey } from "@issue-pipeline/core";
import { loadPipelineConfig } from "./config";
import { githubTrackerSync } from "./tracker-sync-github";

/**
 * The choke point every tracker mutation flows through after its Postgres
 * write commits. One direction only: app database -> external tracker.
 * Best-effort by contract -- a sync failure is logged and swallowed, never
 * surfaced to the calling activity, because the pipeline's own state is
 * already safely in Postgres and an external-tracker outage must not park
 * a phase.
 */

const noopTrackerSync: TrackerSyncPort = {
  async mirror(): Promise<void> {},
};

export function resolveTrackerSync(provider: TrackerSyncProvider): TrackerSyncPort {
  switch (provider) {
    case "github":
      return githubTrackerSync;
    case "none":
      return noopTrackerSync;
  }
}

export async function mirrorTrackerEvent(event: TrackerSyncEvent): Promise<void> {
  try {
    const config = await loadPipelineConfig();
    if (config.sync.provider === "none") return;
    await resolveTrackerSync(config.sync.provider).mirror(event);
  } catch (err) {
    console.warn(
      `[tracker-sync] mirror of ${event.type} for ${formatIssueRef(issueKey(event.issue))} failed ` +
        `(tracker state in Postgres is unaffected): ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}
