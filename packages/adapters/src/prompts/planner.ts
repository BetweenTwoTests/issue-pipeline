export interface AnsweredQuestion {
  q: string;
  answer: string;
}

export interface PlannerPromptInput {
  issueNumber: number;
  issueTitle: string;
  issueBody: string;
  repoSlug: string;
  defaultBranch: string;
  /** Human decisions from previous planning rounds -- present on every
   * re-plan after `pipe answer`, binding on the new plan. */
  answeredQuestions: AnsweredQuestion[];
}

/**
 * Runs in Claude Code plan mode (read-only) inside a real checkout of the
 * target repo at trunk -- the issue text is embedded here rather than
 * fetched by the agent, because plan mode's whole point is that the session
 * only reads the codebase; everything else it needs is in this prompt.
 */
export function buildPlannerPrompt(input: PlannerPromptInput): string {
  const answered =
    input.answeredQuestions.length > 0
      ? `\n## Decisions already made by a human (binding -- do not re-ask, do not contradict)\n${input.answeredQuestions
          .map((a) => `- Q: ${a.q}\n  A: ${a.answer}`)
          .join("\n")}\n`
      : "";

  return `You are the PLANNING agent in an automated issue-pipeline system, running in Claude Code plan mode: your working directory is a read-only checkout of ${input.repoSlug} at ${input.defaultBranch}. Read whatever code you need to ground the plan in reality -- the plan you produce will be executed phase-by-phase by fresh agent sessions that stack one PR per phase.

## The task: GitHub issue #${input.issueNumber} -- "${input.issueTitle}"
"""
${input.issueBody}
"""
${answered}
## What to produce
Break the work into an ordered sequence of independently-shippable PHASES (1 is fine for small tasks; prefer 2-6 for larger ones). Each phase becomes: a checklist item on the issue, its own branch stacked on the previous phase's branch, and its own pull request. Phase N+1 always builds on phase N's branch.

Each phase's "spec" must be complete enough that an engineer (or agent) who has read ONLY the issue and your plan can implement it: name the files/modules involved, the concrete change, and why.

## Open questions: ask only what a human must decide
Every open question you raise BLOCKS implementation until a human answers it -- there are no "non-blocking assumptions" in this system. So: decide everything you reasonably can yourself and record the decision inside the relevant phase's spec; raise a question only for a genuine product/architecture decision you cannot make from the issue and the code. An empty open_questions array is the expected common case. Include your recommendation as proposed_answer.

## Output contract (read carefully)
Respond with ONLY a single JSON object -- no prose before or after. Exactly this shape:

{
  "phases": [
    {
      "title": "short imperative title, e.g. 'Add database schema for X'",
      "goal": "one sentence: what this phase delivers",
      "spec": "the full markdown spec for this phase -- self-contained, concrete, grounded in the actual code you read",
      "acceptance": ["concrete, checkable acceptance criterion", "..."]
    }
  ],
  "open_questions": [
    { "q": "the decision a human must make", "proposed_answer": "your recommendation" }
  ]
}`;
}
