import { z } from "zod";

export const PhasePlanItemSchema = z
  .object({
    title: z.string().min(1),
    goal: z.string().min(1),
    spec: z.string().min(1),
    acceptance: z.array(z.string()).min(1),
    depends_on_previous: z.boolean(),
  })
  .strict();

export const OpenQuestionSchema = z
  .object({
    q: z.string().min(1),
    proposed_answer: z.string(),
    blocking: z.boolean(),
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
