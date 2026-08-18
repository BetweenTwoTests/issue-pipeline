export class PipelineConfigError extends Error {
  constructor(
    message: string,
    public readonly cause?: unknown,
  ) {
    super(message);
    this.name = "PipelineConfigError";
  }
}

export class RoleNotConfiguredError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RoleNotConfiguredError";
  }
}

/** Thrown when WORKLOG.md is missing or fails to match the required section contract. */
export class WorklogContractViolationError extends Error {
  constructor(
    message: string,
    public readonly cwd: string,
  ) {
    super(message);
    this.name = "WorklogContractViolationError";
  }
}

export class PlannerOutputParseError extends Error {
  constructor(
    message: string,
    public readonly rawOutput: string,
  ) {
    super(message);
    this.name = "PlannerOutputParseError";
  }
}

export class GitOperationError extends Error {
  constructor(
    message: string,
    public readonly command: string,
    public readonly stderr: string,
  ) {
    super(message);
    this.name = "GitOperationError";
  }
}

/**
 * Thrown when a tracker activity is asked to operate on an issue that has
 * no row in the app database -- most commonly a pipeline started for an
 * issue number that was never created (issues are created via the web UI
 * or POST /api/issues, never implicitly).
 */
export class TrackerIssueNotFoundError extends Error {
  constructor(
    message: string,
    public readonly issueRef: string,
  ) {
    super(message);
    this.name = "TrackerIssueNotFoundError";
  }
}

export class GithubCliError extends Error {
  constructor(
    message: string,
    public readonly command: string,
    public readonly stderr: string,
  ) {
    super(message);
    this.name = "GithubCliError";
  }
}
