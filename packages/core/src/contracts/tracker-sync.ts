import type { TrackerComment, TrackerIssue } from "./tracker";

/**
 * One-way mirroring of tracker writes to an external tracker. The app
 * database is the source of truth; a sync provider only ever receives
 * events after the Postgres write has committed, and nothing is ever read
 * back from the external side. Mirroring is best-effort by design: a
 * provider outage must never fail a pipeline (the choke point in
 * packages/activities/src/tracker-sync.ts swallows and logs errors).
 *
 * Adding a provider (e.g. Linear) means: a new member here, a
 * TrackerSyncPort implementation in packages/activities, and a case in
 * resolveTrackerSync -- nothing in the workflows or the store changes.
 */
export type TrackerSyncProvider = "none" | "github";

export type TrackerSyncEvent =
  | {
      type: "issue_created";
      issue: TrackerIssue;
      /** Set when the created issue is a sub-issue, so providers can link it. */
      parent: TrackerIssue | null;
    }
  | { type: "comment_added"; issue: TrackerIssue; comment: TrackerComment }
  | { type: "labels_added"; issue: TrackerIssue; labels: string[] }
  | { type: "labels_removed"; issue: TrackerIssue; labels: string[] }
  | { type: "issue_closed"; issue: TrackerIssue };

export interface TrackerSyncPort {
  mirror(event: TrackerSyncEvent): Promise<void>;
}
