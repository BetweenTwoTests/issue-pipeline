export interface ExecutorPromptInput {
  phaseNumber: number;
  totalPhases: number;
  phaseTitle: string;
  phaseGoal: string;
  phaseSpec: string;
  acceptance: string[];
  baseBranch: string;
  priorPhasesContext?: string;
}

export function buildExecutorPrompt(input: ExecutorPromptInput): string {
  const acceptanceList = input.acceptance.map((a) => `- ${a}`).join("\n");
  return `You are the EXECUTOR agent in an automated issue-pipeline system. You have full file-editing and shell access in this working directory, which is a dedicated git branch (based on "${input.baseBranch}") checked out just for this phase.

## Phase ${input.phaseNumber}/${input.totalPhases}: ${input.phaseTitle}

Goal: ${input.phaseGoal}

${input.phaseSpec}

## Acceptance criteria
${acceptanceList}
${input.priorPhasesContext ? `\n## What prior phases already did\n${input.priorPhasesContext}\n` : ""}
## Your task
Implement this phase completely: write the code, run/create tests as appropriate, and leave the working tree in a state that could be committed and opened as a pull request as-is. Do not commit, push, or create/switch git branches -- that happens automatically after you finish.

## Required deliverable: WORKLOG.md
Before you finish, create a file named exactly \`WORKLOG.md\` at the root of this working directory (overwrite if it already exists). This file is machine-parsed, so follow this structure exactly -- these \`##\` headers, in this order:

## Done
Bullet list of what you actually implemented. Be specific and factual.

## Deviations from spec
Bullet list of every place your implementation diverged from the spec above, and why. If none, write "None."

## Surprises / new findings
Anything you discovered that the planner didn't anticipate. If none, write "None."

## Follow-ups
Concrete work for a later phase, out of scope here. If none, write "None."

## Status: done
The literal last line of the file must be exactly one of:
\`## Status: done\` -- you completed the phase and it is ready for review/PR.
\`## Status: blocked\` -- you could not complete the phase (missing credentials, a genuine blocker, an environment problem) and need a human to unblock you. Explain exactly what is needed under "Follow-ups".

Do not skip WORKLOG.md and do not rename it. The pipeline will treat this phase as blocked if it is missing or if any section above is absent.`;
}
