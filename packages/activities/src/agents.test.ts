import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import { PlannerOutputParseError, WorklogContractViolationError } from "@issue-pipeline/core";
import { parsePlannerOutput, readAndClearWorklog, parseDiscoveredTasks } from "./agents";

const VALID_PLANNER_JSON = JSON.stringify({
  phases: [
    { title: "Add schema", goal: "Create the schema", spec: "spec text", acceptance: ["works"] },
  ],
  open_questions: [],
});

test("parsePlannerOutput parses raw JSON with no surrounding text", async () => {
  const result = await parsePlannerOutput(VALID_PLANNER_JSON);
  assert.equal(result.phases.length, 1);
  assert.equal(result.phases[0].title, "Add schema");
});

test("parsePlannerOutput extracts JSON from a fenced code block", async () => {
  const result = await parsePlannerOutput(`Here is the plan:\n\n\`\`\`json\n${VALID_PLANNER_JSON}\n\`\`\`\n\nHope that helps!`);
  assert.equal(result.phases.length, 1);
});

test("parsePlannerOutput extracts the first balanced {...} as a last resort", async () => {
  const result = await parsePlannerOutput(`Sure, here you go: ${VALID_PLANNER_JSON} let me know if you need changes.`);
  assert.equal(result.phases.length, 1);
});

test("parsePlannerOutput throws PlannerOutputParseError on unparseable garbage", async () => {
  await assert.rejects(() => parsePlannerOutput("not json at all, sorry"), PlannerOutputParseError);
});

test("parsePlannerOutput throws PlannerOutputParseError when JSON is valid but fails schema", async () => {
  await assert.rejects(() => parsePlannerOutput(JSON.stringify({ phases: [] })), PlannerOutputParseError);
});

async function withTempDir(fn: (dir: string) => Promise<void>): Promise<void> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "issue-pipeline-test-"));
  try {
    await fn(dir);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
}

const VALID_WORKLOG = `## Done
- Implemented the thing

## Deviations from spec
None.

## Surprises / new findings
None.

## Follow-ups
None.

## Status: done`;

test("readAndClearWorklog parses a well-formed WORKLOG.md and renames it", async () => {
  await withTempDir(async (dir) => {
    await fs.writeFile(path.join(dir, "WORKLOG.md"), VALID_WORKLOG, "utf8");
    const result = await readAndClearWorklog(dir);
    assert.equal(result.status, "done");
    assert.equal(result.done, "- Implemented the thing");
    assert.equal(result.deviationsFromSpec, "None.");

    // Renamed, not deleted -- WORKLOG.md itself should be gone.
    await assert.rejects(() => fs.access(path.join(dir, "WORKLOG.md")));
    const processed = await fs.readFile(path.join(dir, "WORKLOG.md.processed"), "utf8");
    assert.equal(processed, VALID_WORKLOG);
  });
});

test("readAndClearWorklog parses a blocked status correctly", async () => {
  await withTempDir(async (dir) => {
    const blocked = VALID_WORKLOG.replace("## Status: done", "## Status: blocked");
    await fs.writeFile(path.join(dir, "WORKLOG.md"), blocked, "utf8");
    const result = await readAndClearWorklog(dir);
    assert.equal(result.status, "blocked");
  });
});

test("readAndClearWorklog throws WorklogContractViolationError when the file is missing", async () => {
  await withTempDir(async (dir) => {
    await assert.rejects(() => readAndClearWorklog(dir), WorklogContractViolationError);
  });
});

test("readAndClearWorklog throws WorklogContractViolationError when a required section is missing", async () => {
  await withTempDir(async (dir) => {
    const missingSection = "## Done\n- did stuff\n\n## Status: done";
    await fs.writeFile(path.join(dir, "WORKLOG.md"), missingSection, "utf8");
    await assert.rejects(() => readAndClearWorklog(dir), WorklogContractViolationError);
  });
});

test("readAndClearWorklog throws WorklogContractViolationError when the status line is missing", async () => {
  await withTempDir(async (dir) => {
    const noStatus = VALID_WORKLOG.replace("## Status: done", "");
    await fs.writeFile(path.join(dir, "WORKLOG.md"), noStatus, "utf8");
    await assert.rejects(() => readAndClearWorklog(dir), WorklogContractViolationError);
  });
});

test("readAndClearWorklog is idempotent: a retry after the file was already renamed re-parses from .processed", async () => {
  await withTempDir(async (dir) => {
    await fs.writeFile(path.join(dir, "WORKLOG.md"), VALID_WORKLOG, "utf8");
    const first = await readAndClearWorklog(dir);
    // Simulates a Temporal at-least-once retry landing after a crash between
    // "rename" and "return" -- must NOT throw "missing", must return the
    // same parsed result from WORKLOG.md.processed.
    const second = await readAndClearWorklog(dir);
    assert.deepEqual(second, first);
  });
});

test("readAndClearWorklog defaults a missing Discovered tasks section to None. (optional by contract)", async () => {
  await withTempDir(async (dir) => {
    await fs.writeFile(path.join(dir, "WORKLOG.md"), VALID_WORKLOG, "utf8");
    const result = await readAndClearWorklog(dir);
    assert.equal(result.discoveredTasks, "None.");
  });
});

test("readAndClearWorklog captures a present Discovered tasks section", async () => {
  await withTempDir(async (dir) => {
    const withTasks = VALID_WORKLOG.replace(
      "## Status: done",
      "## Discovered tasks\n- Fix flaky auth test -- it fails under parallel runs\n\n## Status: done",
    );
    await fs.writeFile(path.join(dir, "WORKLOG.md"), withTasks, "utf8");
    const result = await readAndClearWorklog(dir);
    assert.equal(result.discoveredTasks, "- Fix flaky auth test -- it fails under parallel runs");
  });
});

test("parseDiscoveredTasks splits bullets into title/context on the -- separator", () => {
  const tasks = parseDiscoveredTasks("- Fix flaky auth test -- it fails under parallel runs\n- Upgrade zod");
  assert.equal(tasks.length, 2);
  assert.equal(tasks[0].title, "Fix flaky auth test");
  assert.equal(tasks[0].context, "it fails under parallel runs");
  assert.equal(tasks[1].title, "Upgrade zod");
  assert.equal(tasks[1].context, "Upgrade zod");
});

test("parseDiscoveredTasks treats None. and non-bullet prose as no tasks", () => {
  assert.deepEqual(parseDiscoveredTasks("None."), []);
  assert.deepEqual(parseDiscoveredTasks("- None."), []);
  assert.deepEqual(parseDiscoveredTasks("nothing here\njust prose"), []);
  assert.deepEqual(parseDiscoveredTasks(""), []);
});

test("parseDiscoveredTasks truncates an overlong title but keeps full context", () => {
  const long = "x".repeat(200);
  const tasks = parseDiscoveredTasks(`- ${long}`);
  assert.equal(tasks.length, 1);
  assert.ok(tasks[0].title.length <= 120);
  assert.equal(tasks[0].context, long);
});
