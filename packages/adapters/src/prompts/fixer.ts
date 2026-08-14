export interface FixerPromptInput {
  repoSlug: string;
  issueNumber: number;
  /** 1-based. */
  phaseNumber: number;
  totalPhases: number;
  phaseTitle: string;
  branch: string;
  stackTool: "graphite" | "git";
  reason: "gate_failure" | "worklog_contract_violation" | "agent_crashed" | "declared_blocked";
  detail: string;
  attemptNumber: number;
  maxAttempts: number;
}

export function buildFixerPrompt(input: FixerPromptInput): string {
  const submit =
    input.stackTool === "graphite"
      ? `commit with plain \`git add\` + \`git commit\`, then run \`gt submit --no-interactive\` to update the PR (never \`gt create\` -- the branch already exists and is tracked)`
      : `commit with plain \`git add\` + \`git commit\` (the pipeline pushes and updates the PR after your session)`;

  return `You are the FIXER agent in an automated issue-pipeline system. Phase ${input.phaseNumber}/${input.totalPhases} ("${input.phaseTitle}") of GitHub issue #${input.issueNumber} needs a correction. This is fix attempt ${input.attemptNumber} of ${input.maxAttempts}.

Start by reading the full issue -- run \`gh issue view ${input.issueNumber} --comments -R ${input.repoSlug}\`. The LATEST comment starting with "## Implementation plan" holds the plan; prior phases' worklog comments describe what already shipped. You are fixing phase ${input.phaseNumber} ONLY.

## Why this attempt is needed
Reason: ${input.reason}
Detail:
"""
${input.detail}
"""

## Where you are
A dedicated git worktree on branch \`${input.branch}\`. It has been RESET to the phase branch's initial state -- the previous attempt's changes are gone. Re-do the phase with the failure above in mind; do not just re-run what failed.

## Your task
Implement the phase so the problem above cannot recur, then ${submit}. Do not create or switch branches. Then, if your approach differs from the plan, say so in a comment on issue #${input.issueNumber} (\`gh issue comment\`).

## Required deliverable: WORKLOG.md
Same contract as the executor: overwrite WORKLOG.md at the root of this working directory with exactly these \`##\` sections in order -- Done, Deviations from spec, Surprises / new findings, Follow-ups, Discovered tasks, and a final literal \`## Status: done\` or \`## Status: blocked\` line. Describe what you changed to address the failure under "Done". If you cannot fix it within this attempt, use \`## Status: blocked\` and explain what's needed under "Follow-ups".`;
}
