export type WorklogStatus = "done" | "blocked";

/** Parsed contents of the executor/fixer's required WORKLOG.md deliverable. */
export interface WorklogSections {
  done: string;
  deviationsFromSpec: string;
  surprisesFindings: string;
  followUps: string;
  status: WorklogStatus;
  raw: string;
}
