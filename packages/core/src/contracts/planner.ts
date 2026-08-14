import { z } from "zod";

/**
 * The heading the plan comment posted on the issue starts with. Referenced
 * by the executor prompt ("read the comment starting with ...") so each
 * phase session can find the plan among the issue's comments -- the GitHub
 * issue, not Temporal, is the persistent memory between agent sessions.
 */
export const PLAN_COMMENT_HEADER = "## Implementation plan";

export const PhasePlanItemSchema = z
  .object({
    title: z.string().min(1),
    goal: z.string().min(1),
    spec: z.string().min(1),
    acceptance: z.array(z.string()).min(1),
  })
  .strict();

/**
 * Open questions have no "blocking" flag anymore: EVERY open question the
 * planner raises blocks implementation until a human answers it via
 * `pipe answer` (the human-in-the-loop gate). The planner is told to decide
 * non-essential details itself and document them in the spec instead of
 * asking -- so anything it does ask is by definition a real decision.
 */
export const OpenQuestionSchema = z
  .object({
    q: z.string().min(1),
    /** The planner's recommendation, shown to the human next to the question. */
    proposed_answer: z.string().default(""),
  })
  .strict();

export const PlannerOutputSchema = z
  .object({
    phases: z.array(PhasePlanItemSchema).min(1),
    open_questions: z.array(OpenQuestionSchema),
  })
  .strict();

export type PhasePlanItem = z.infer<typeof PhasePlanItemSchema>;
export type OpenQuestion = z.infer<typeof OpenQuestionSchema>;
export type PlannerOutput = z.infer<typeof PlannerOutputSchema>;

/** Lowercase, hyphenated, <=24 chars -- used to build phase branch names. */
export function slugify(title: string): string {
  const slug = title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return (slug || "phase").slice(0, 24).replace(/-+$/, "");
}
