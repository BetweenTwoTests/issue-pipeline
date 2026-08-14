export interface ExecutorPromptInput {
  repoSlug: string;
  issueNumber: number;
  /** 1-based. */
  phaseNumber: number;
  totalPhases: number;
  phaseTitle: string;
  branch: string;
  baseBranch: string;
  stackTool: "graphite" | "git";
}

const WORKLOG_CONTRACT = `## Required deliverable: WORKLOG.md
Before you finish, create a file named exactly \`WORKLOG.md\` at the root of this working directory (overwrite if it already exists). This file is machine-parsed, so follow this structure exactly -- these \`##\` headers, in this order:

## Done
Bullet list of what you actually implemented. Be specific and factual.

## Deviations from spec
Bullet list of every place your implementation diverged from the plan on the issue, and why. If none, write "None."

## Surprises / new findings
Anything you discovered that the plan didn't anticipate. If none, write "None."

## Follow-ups
Concrete work for a later phase of THIS issue, out of scope here. If none, write "None."

## Discovered tasks
NEW work that is out of scope for this issue entirely (a bug you noticed, missing tests elsewhere, a refactor worth doing). One bullet per task, phrased as a short imperative title, optionally followed by " -- " and context. The pipeline files each bullet as a sub-issue of the root issue, recording which phase it came from -- do NOT create GitHub issues yourself. If none, write "None."

## Status: done
The literal last line of the file must be exactly one of:
\`## Status: done\` -- you completed the phase and the PR is submitted.
\`## Status: blocked\` -- you could not complete the phase (missing credentials, a genuine blocker, an environment problem) and need a human to unblock you. Explain exactly what is needed under "Follow-ups".

Do not skip WORKLOG.md and do not rename it. The pipeline treats this phase as failed if it is missing or malformed.`;

function submissionInstructions(stackTool: "graphite" | "git", branch: string): string {
  if (stackTool === "graphite") {
    return `2. Commit ALL of your work with plain \`git add\` + \`git commit\` (one or more commits, clear messages). Do NOT create or switch branches and do NOT run \`gt create\` -- this worktree is already on branch \`${branch}\`, which is already tracked in Graphite's stack with the correct parent (\`gt create\` would fail here and create a duplicate branch).
3. Submit the PR: run \`gt submit --no-interactive\`. The pipeline verifies the PR exists after your session and re-runs \`gt submit\` if needed, but you should do it yourself.`;
  }
  return `2. Commit ALL of your work with plain \`git add\` + \`git commit\` (one or more commits, clear messages). Do NOT create or switch branches.
3. Do not push. The pipeline pushes \`${branch}\` and opens/updates the PR immediately after your session.`;
}

export function buildExecutorPrompt(input: ExecutorPromptInput): string {
  return `You are the EXECUTOR agent in an automated issue-pipeline system.

Plan an implementation of GitHub issue #${input.issueNumber} by reading all the contents: run \`gh issue view ${input.issueNumber} --comments -R ${input.repoSlug}\` first. The issue is the single source of truth between sessions: its body holds the task description and the phase checklist, the LATEST comment starting with "## Implementation plan" holds the agreed plan (with any human-answered questions posted after it), and every already-completed phase has posted a "Phase k/${input.totalPhases} worklog" comment describing what it actually did (including deviations from the plan -- trust the worklogs over the plan where they differ).

You are implementing phase ${input.phaseNumber} of ${input.totalPhases} ONLY: "${input.phaseTitle}". Do not implement any other phase, even partially.

## Where you are
Your working directory is a dedicated git worktree on branch \`${input.branch}\`, created on top of \`${input.baseBranch}\` (the previous phase's branch, or trunk for phase 1). It is isolated -- nothing you do here touches any other checkout.

## Your task, in order
1. Implement this phase completely: write the code, run/create tests as appropriate.
${submissionInstructions(input.stackTool, input.branch)}
4. After implementation and submitting the PR, update the issue with a comment (\`gh issue comment ${input.issueNumber} -R ${input.repoSlug}\`) if anything new was found or your implementation differs from what the issue and plan describe -- the next phase's session will read your comment. Skip the comment if there is genuinely nothing new to say (your WORKLOG.md below is always posted to the issue by the pipeline regardless).

${WORKLOG_CONTRACT}`;
}
