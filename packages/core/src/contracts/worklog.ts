export type WorklogStatus = "done" | "blocked";

/** Parsed contents of the executor/fixer's required WORKLOG.md deliverable. */
export interface WorklogSections {
  done: string;
  deviationsFromSpec: string;
  surprisesFindings: string;
  followUps: string;
  /**
   * "## Discovered tasks" -- new work the agent found that is OUT of scope
   * for this issue's phases. Each bullet becomes a sub-issue of the root
   * issue (the one place sub-issues still exist in this system). Optional in
   * the file; defaults to "None." when the section is absent so an agent
   * forgetting it doesn't fail the whole contract.
   */
  discoveredTasks: string;
  status: WorklogStatus;
  raw: string;
}
