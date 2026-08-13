import assert from "node:assert/strict";
import { test } from "node:test";
import { Worker } from "@temporalio/worker";
import { TestWorkflowEnvironment } from "@temporalio/testing";
import { abortSignal } from "@issue-pipeline/core";
import { parsePlannerOutput } from "@issue-pipeline/activities";
import { planWorkflow, type PlanWorkflowInput, type PlanWorkflowResult } from "./plan";

// Registers the whole workflows barrel (not just plan.ts): planWorkflow
// calls executeChild(phaseWorkflow, ...), so phaseWorkflow's workflow type
// must also be present in the same bundle even though this test never lets
// execution reach a phase (it aborts during the blocking-questions wait).
const WORKFLOWS_PATH = require.resolve("./index");
const TEST_TASK_QUEUE = "test-plan-workflow";

const FAKE_REPO = { name: "test-repo", owner: "acme", repo: "widgets", localPath: "/tmp/fake", defaultBranch: "main" };

const BLOCKING_PLANNER_JSON = JSON.stringify({
  phases: [
    { title: "Phase one", goal: "goal", spec: "spec", acceptance: ["works"], depends_on_previous: false },
  ],
  open_questions: [{ q: "Which database?", proposed_answer: "", blocking: true }],
});

test("planWorkflow: an abort signal during the blocking-questions wait ends the pipeline immediately", async () => {
  const testEnv = await TestWorkflowEnvironment.createFromExistingServer({
    address: "localhost:7833",
    namespace: "issue-pipeline",
  });

  const posted: string[] = [];

  const worker = await Worker.create({
    connection: testEnv.nativeConnection,
    namespace: "issue-pipeline",
    taskQueue: TEST_TASK_QUEUE,
    workflowsPath: WORKFLOWS_PATH,
    activities: {
      loadPipelineConfig: async () => ({
        version: 1 as const,
        roles: {
          planner: { adapter: "claude" as const, args: [], timeout_ms: 1000 },
          executor: { adapter: "codex" as const, args: [], timeout_ms: 1000 },
          fixer: { adapter: "codex" as const, args: [], timeout_ms: 1000 },
        },
        policy: { local_gates: "advisory" as const, max_fix_attempts: 1, auto_continue: true },
        branching: { stack_tool: "git" as const, branch_prefix: "pipe", remote: "origin", pr_draft: false },
        gates: { timeout_ms: 1000, commands: [] },
        repos: {},
      }),
      resolveRegisteredRepoBySlug: async () => FAKE_REPO,
      ensureBareClone: async () => {},
      fetchRepo: async () => {},
      fetchRootIssue: async () => ({
        number: 1,
        title: "Root plan issue",
        body: "Do the thing",
        url: "https://github.com/acme/widgets/issues/1",
        state: "open",
        labels: [],
      }),
      removeLabels: async () => {},
      addLabels: async () => {},
      buildPlannerPrompt: async () => "planner prompt",
      runAgent: async () => ({ ok: true, summary: BLOCKING_PLANNER_JSON, deviations: [], artifacts: [] }),
      parsePlannerOutput, // real implementation -- pure, no I/O, no need to mock
      postComment: async (_repo: unknown, _issueNumber: number, body: string) => {
        posted.push(body);
      },
    },
  });

  try {
    const handle = await testEnv.client.workflow.start(planWorkflow, {
      workflowId: `test-plan-abort-${Date.now()}`,
      taskQueue: TEST_TASK_QUEUE,
      args: [{ owner: "acme", repo: "widgets", issueNumber: 1 } satisfies PlanWorkflowInput],
    });

    const result = (await worker.runUntil(async () => {
      // Give the workflow a moment to reach the blocking-questions wait
      // before aborting it -- otherwise the signal could arrive before the
      // workflow has even registered its handler.
      await new Promise((resolve) => setTimeout(resolve, 500));
      await handle.signal(abortSignal, { note: "test abort" });
      return handle.result();
    })) as PlanWorkflowResult;

    assert.equal(result.outcome, "aborted");
    assert.equal(result.completedPhases, 0);
    assert.ok(posted.some((body) => body.includes("open questions")), "expected the blocking-questions comment to have been posted");
    assert.ok(posted.some((body) => body.includes("aborted")), "expected the final aborted comment to have been posted");
  } finally {
    await testEnv.teardown();
  }
});
