export interface FixerPromptInput {
  phaseNumber: number;
  totalPhases: number;
  phaseTitle: string;
  phaseGoal: string;
  phaseSpec: string;
  acceptance: string[];
  reason: "gate_failure" | "worklog_contract_violation" | "agent_crashed" | "declared_blocked";
  detail: string;
  attemptNumber: number;
  maxAttempts: number;
}

export function buildFixerPrompt(input: FixerPromptInput): string {
  const acceptanceList = input.acceptance.map((a) => `- ${a}`).join("\n");
  return `You are the FIXER agent in an automated issue-pipeline system. Phase ${input.phaseNumber}/${input.totalPhases} ("${input.phaseTitle}") needs a correction. This is attempt ${input.attemptNumber} of ${input.maxAttempts}.

## Original phase spec
Goal: ${input.phaseGoal}

${input.phaseSpec}

## Acceptance criteria
${acceptanceList}

## Why this attempt is needed
Reason: ${input.reason}
Detail:
"""
${input.detail}
"""

## Your task
Fix the specific problem described above in the current working tree (it has been reset to the phase's base branch -- your previous attempt's changes, if any, are gone). Do not re-implement the phase from scratch beyond what's needed to fix the problem. Do not commit, push, or create/switch git branches.

## Required deliverable: WORKLOG.md
Same contract as the executor: overwrite WORKLOG.md at the root of this working directory with exactly these \`##\` sections in order -- Done, Deviations from spec, Surprises / new findings, Follow-ups, and a final literal \`## Status: done\` or \`## Status: blocked\` line. Describe what you changed to address the problem above under "Done". If you cannot fix it within this attempt, use "## Status: blocked" and explain what's needed under "Follow-ups".`;
}
