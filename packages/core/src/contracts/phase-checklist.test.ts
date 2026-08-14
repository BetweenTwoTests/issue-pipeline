import assert from "node:assert/strict";
import { test } from "node:test";
import {
  renderPhaseChecklist,
  upsertPhaseChecklist,
  PHASE_CHECKLIST_BEGIN,
  PHASE_CHECKLIST_END,
} from "./phase-checklist";

test("renderPhaseChecklist renders unchecked and checked task items with 1-based numbering", () => {
  const rendered = renderPhaseChecklist([
    { title: "Add schema", done: true, prNumber: 12, prUrl: "https://github.com/o/r/pull/12" },
    { title: "Wire the API", done: false },
  ]);
  assert.ok(rendered.startsWith(PHASE_CHECKLIST_BEGIN));
  assert.ok(rendered.endsWith(PHASE_CHECKLIST_END));
  assert.ok(rendered.includes("- [x] Phase 1: Add schema ([PR #12](https://github.com/o/r/pull/12))"));
  assert.ok(rendered.includes("- [ ] Phase 2: Wire the API"));
});

test("renderPhaseChecklist renders a note in italics", () => {
  const rendered = renderPhaseChecklist([{ title: "Flaky thing", done: true, note: "skipped by human" }]);
  assert.ok(rendered.includes("- [x] Phase 1: Flaky thing _(skipped by human)_"));
});

test("upsertPhaseChecklist appends to a body without markers, preserving the original text", () => {
  const body = "Human-written description of the task.\n";
  const result = upsertPhaseChecklist(body, renderPhaseChecklist([{ title: "A", done: false }]));
  assert.ok(result.startsWith("Human-written description of the task."));
  assert.ok(result.includes(PHASE_CHECKLIST_BEGIN));
  assert.ok(result.includes("- [ ] Phase 1: A"));
});

test("upsertPhaseChecklist replaces an existing marker section in place, twice over", () => {
  const original = "Intro text.\n\nOutro text after the list.";
  const v1 = upsertPhaseChecklist(
    `Intro text.\n\n${renderPhaseChecklist([{ title: "A", done: false }])}\n\nOutro text after the list.`,
    renderPhaseChecklist([{ title: "A", done: true, prNumber: 3, prUrl: "u" }]),
  );
  assert.ok(v1.includes("- [x] Phase 1: A ([PR #3](u))"));
  assert.ok(!v1.includes("- [ ] Phase 1: A"), "old unchecked item should be gone");
  assert.ok(v1.startsWith("Intro text."));
  assert.ok(v1.endsWith("Outro text after the list."));

  // Idempotent: upserting the same rendered content again changes nothing.
  const v2 = upsertPhaseChecklist(v1, renderPhaseChecklist([{ title: "A", done: true, prNumber: 3, prUrl: "u" }]));
  assert.equal(v2, v1);
  // Structure preserved relative to a marker-free original.
  assert.ok(original.startsWith("Intro text."));
});

test("upsertPhaseChecklist on an empty body returns just the checklist", () => {
  const rendered = renderPhaseChecklist([{ title: "A", done: false }]);
  assert.equal(upsertPhaseChecklist("", rendered), rendered);
});
