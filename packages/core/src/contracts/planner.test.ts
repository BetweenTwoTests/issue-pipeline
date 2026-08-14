import assert from "node:assert/strict";
import { test } from "node:test";
import { slugify, PlannerOutputSchema } from "./planner";

test("slugify lowercases, hyphenates, and strips punctuation", () => {
  assert.equal(slugify("Add Database Schema for X"), "add-database-schema-for");
});

test("slugify truncates to 24 chars without a trailing hyphen", () => {
  const slug = slugify("This Is A Very Long Phase Title That Exceeds The Limit");
  assert.ok(slug.length <= 24, `expected <=24 chars, got ${slug.length}: ${slug}`);
  assert.ok(!slug.endsWith("-"), `slug should not end with a hyphen: ${slug}`);
});

test("slugify falls back to a placeholder for a title with no alphanumerics", () => {
  assert.equal(slugify("!!!"), "phase");
});

test("PlannerOutputSchema accepts a well-formed decomposition", () => {
  const result = PlannerOutputSchema.safeParse({
    phases: [
      {
        title: "Add schema",
        goal: "Create the DB schema",
        spec: "Full spec text",
        acceptance: ["Migration runs cleanly"],
      },
    ],
    open_questions: [{ q: "Which DB?", proposed_answer: "Postgres" }],
  });
  assert.equal(result.success, true);
});

test("PlannerOutputSchema defaults a question's proposed_answer to empty", () => {
  const result = PlannerOutputSchema.safeParse({
    phases: [{ title: "t", goal: "g", spec: "s", acceptance: ["a"] }],
    open_questions: [{ q: "Which DB?" }],
  });
  assert.equal(result.success, true);
  if (result.success) {
    assert.equal(result.data.open_questions[0].proposed_answer, "");
  }
});

test("PlannerOutputSchema rejects an empty phases array", () => {
  const result = PlannerOutputSchema.safeParse({ phases: [], open_questions: [] });
  assert.equal(result.success, false);
});

test("PlannerOutputSchema rejects unknown extra fields (strict)", () => {
  const result = PlannerOutputSchema.safeParse({
    phases: [{ title: "t", goal: "g", spec: "s", acceptance: ["a"], extra_field: "nope" }],
    open_questions: [],
  });
  assert.equal(result.success, false);
});

test("PlannerOutputSchema rejects the retired blocking/depends_on_previous fields", () => {
  const result = PlannerOutputSchema.safeParse({
    phases: [{ title: "t", goal: "g", spec: "s", acceptance: ["a"], depends_on_previous: true }],
    open_questions: [{ q: "Which DB?", proposed_answer: "", blocking: true }],
  });
  assert.equal(result.success, false);
});
