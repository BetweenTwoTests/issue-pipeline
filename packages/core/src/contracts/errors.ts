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
