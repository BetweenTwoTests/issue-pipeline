import assert from "node:assert/strict";
import { test } from "node:test";
import { Worker } from "@temporalio/worker";
import { TestWorkflowEnvironment } from "@temporalio/testing";
import { abortSignal, type ChecklistPhase } from "@issue-pipeline/core";
import { parsePlannerOutput } from "@issue-pipeline/activities";
import { issueWorkflow, type IssueWorkflowInput, type IssueWorkflowResult } from "./issue";

// Registers the whole workflows barrel (not just issue.ts): issueWorkflow
// calls executeChild(phaseWorkflow, ...), so phaseWorkflow's workflow type
// must also be present in the same bundle.
const WORKFLOWS_PATH = require.resolve("./index");
const TEST_TASK_QUEUE = "test-issue-workflow";

const FAKE_REPO = { name: "test-repo", owner: "acme", repo: "widgets", localPath: "/tmp/fake", defaultBranch: "main" };

function baseConfig() {
  return {
    version: 1 as const,
    roles: {
      planner: { adapter: "claude" as const, args: [], timeout_ms: 1000 },
      executor: { adapter: "claude" as const, args: [], timeout_ms: 1000 },
      fixer: { adapter: "claude" as const, args: [], timeout_ms: 1000 },
    },
    policy: {
      local_gates: "advisory" as const,
      max_fix_attempts: 1,
      auto_continue: true,
      merge_poll_minutes: 15,
    },
    branching: { stack_tool: "git" as const, branch_prefix: "pipe", remote: "origin", pr_draft: false },
    gates: { timeout_ms: 1000, commands: [] },
    repos: {},
  };
}

const FAKE_ROOT_ISSUE = {
  number: 1,
  title: "Root issue",
  body: "Do the thing",
  url: "https://github.com/acme/widgets/issues/1",
  state: "open",
  labels: [],
};

const QUESTION_PLANNER_JSON = JSON.stringify({
  phases: [{ title: "Phase one", goal: "goal", spec: "spec", acceptance: ["works"] }],
  open_questions: [{ q: "Which database?", proposed_answer: "Postgres" }],
});

const CLEAN_PLANNER_JSON = JSON.stringify({
  phases: [{ title: "Do the thing", goal: "goal", spec: "spec", acceptance: ["works"] }],
  open_questions: [],
});

test("issueWorkflow: an abort signal while awaiting answers ends the pipeline (every open question blocks)", async () => {
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
      loadPipelineConfig: async () => baseConfig(),
      resolveRegisteredRepoBySlug: async () => FAKE_REPO,
      ensureBareClone: async () => {},
      fetchRepo: async () => {},
      fetchRootIssue: async () => FAKE_ROOT_ISSUE,
      removeLabels: async () => {},
      addLabels: async () => {},
      createPlanningWorktree: async () => ({ worktreePath: "/tmp/fake-planning" }),
      buildPlannerPrompt: async () => "planner prompt",
      runAgent: async () => ({ ok: true, summary: QUESTION_PLANNER_JSON, deviations: [], artifacts: [] }),
      parsePlannerOutput, // real implementation -- pure, no I/O, no need to mock
      projectPipelineState: async () => {},
      postComment: async (_repo: unknown, _issueNumber: number, body: string) => {
        posted.push(body);
      },
    },
  });

  try {
    const handle = await testEnv.client.workflow.start(issueWorkflow, {
      workflowId: `test-issue-abort-${Date.now()}`,
      taskQueue: TEST_TASK_QUEUE,
      args: [{ owner: "acme", repo: "widgets", issueNumber: 1 } satisfies IssueWorkflowInput],
    });

    const result = (await worker.runUntil(async () => {
      // Give the workflow a moment to reach the awaiting-answers wait
      // before aborting it -- otherwise the signal could arrive before the
      // workflow has even registered its handler.
      await new Promise((resolve) => setTimeout(resolve, 500));
      await handle.signal(abortSignal, { note: "test abort" });
      return handle.result();
    })) as IssueWorkflowResult;

    assert.equal(result.outcome, "aborted");
    assert.equal(result.mergedPrs, 0);
    assert.ok(
      posted.some((body) => body.startsWith("## Implementation plan")),
      "expected the plan comment to have been posted",
    );
    assert.ok(
      posted.some((body) => body.includes("Open questions blocking implementation")),
      "expected the open-questions comment to have been posted",
    );
    assert.ok(posted.some((body) => body.includes("aborted")), "expected the final aborted comment to have been posted");
  } finally {
    await testEnv.teardown();
  }
});

test("issueWorkflow: plans, executes the phase, waits for the PR to merge, then closes the issue", async () => {
  const testEnv = await TestWorkflowEnvironment.createFromExistingServer({
    address: "localhost:7833",
    namespace: "issue-pipeline",
  });

  const posted: string[] = [];
  const checklistSnapshots: ChecklistPhase[][] = [];
  const calls = {
    closingComments: [] as string[],
    cleanupIssueWorktrees: 0,
    getPullRequestStates: 0,
    fileDiscoveredTasks: [] as string[],
    executorRuns: 0,
    projectedEvents: [] as string[],
  };

  const worker = await Worker.create({
    connection: testEnv.nativeConnection,
    namespace: "issue-pipeline",
    taskQueue: TEST_TASK_QUEUE,
    workflowsPath: WORKFLOWS_PATH,
    activities: {
      loadPipelineConfig: async () => baseConfig(),
      resolveRegisteredRepoBySlug: async () => FAKE_REPO,
      ensureBareClone: async () => {},
      fetchRepo: async () => {},
      fetchRootIssue: async () => FAKE_ROOT_ISSUE,
      removeLabels: async () => {},
      addLabels: async () => {},
      createPlanningWorktree: async () => ({ worktreePath: "/tmp/fake-planning" }),
      buildPlannerPrompt: async () => "planner prompt",
      buildExecutorPrompt: async () => "executor prompt",
      buildFixerPrompt: async () => "fixer prompt",
      runAgent: async (input: { role: string }) => {
        if (input.role === "planner") {
          return { ok: true, summary: CLEAN_PLANNER_JSON, deviations: [], artifacts: [] };
        }
        calls.executorRuns += 1;
        return { ok: true, summary: "did it", deviations: [], artifacts: [] };
      },
      parsePlannerOutput, // real implementation
      projectPipelineState: async (input: { event: { type: string } }) => {
        calls.projectedEvents.push(input.event.type);
      },
      recordPipelineEvent: async (input: { event: { type: string } }) => {
        calls.projectedEvents.push(input.event.type);
      },
      postComment: async (_repo: unknown, _issueNumber: number, body: string) => {
        posted.push(body);
      },
      updateIssuePhaseChecklist: async (_repo: unknown, _issueNumber: number, phases: ChecklistPhase[]) => {
        checklistSnapshots.push(phases);
      },
      // ---- child phaseWorkflow activities ----
      createPhaseWorktree: async () => ({
        worktreePath: "/tmp/fake-worktree",
        branch: "pipe/1/p1-do-the-thing",
        initialCommitSha: "deadbeef",
      }),
      resetWorktreeHard: async () => {},
      readAndClearWorklog: async () => ({
        done: "did the thing",
        deviationsFromSpec: "None.",
        surprisesFindings: "None.",
        followUps: "None.",
        discoveredTasks: "- Tighten the widget flange -- found while testing",
        status: "done" as const,
        raw: "raw",
      }),
      postPhaseWorklogComment: async () => ({ url: "https://example.com/comment" }),
      fileDiscoveredTasks: async (_repo: unknown, _issue: number, _phase: number, text: string) => {
        calls.fileDiscoveredTasks.push(text);
        return { created: 1, total: 1 };
      },
      runLocalGates: async () => ({ passed: true, results: [] }),
      commitLeftoverChanges: async () => ({ committed: false }),
      submitPhaseBranch: async () => ({ url: "https://github.com/acme/widgets/pull/7", number: 7 }),
      setPullRequestBody: async () => {},
      // ---- merge wait + completion ----
      getPullRequestStates: async (_repo: unknown, prNumbers: number[]) => {
        calls.getPullRequestStates += 1;
        return prNumbers.map((n) => ({ number: n, url: `https://github.com/acme/widgets/pull/${n}`, state: "MERGED" as const }));
      },
      closeIssueCompleted: async (_repo: unknown, _issueNumber: number, closingComment: string) => {
        calls.closingComments.push(closingComment);
      },
      cleanupIssueWorktrees: async () => {
        calls.cleanupIssueWorktrees += 1;
      },
    },
  });

  try {
    const result = (await worker.runUntil(
      testEnv.client.workflow.execute(issueWorkflow, {
        workflowId: `test-issue-happy-${Date.now()}`,
        taskQueue: TEST_TASK_QUEUE,
        args: [{ owner: "acme", repo: "widgets", issueNumber: 1 } satisfies IssueWorkflowInput],
      }),
    )) as IssueWorkflowResult;

    assert.equal(result.outcome, "completed");
    assert.equal(result.totalPhases, 1);
    assert.equal(result.mergedPrs, 1);
    assert.equal(calls.executorRuns, 1);
    assert.equal(calls.closingComments.length, 1);
    assert.equal(calls.cleanupIssueWorktrees, 1);
    assert.ok(calls.getPullRequestStates >= 1);
    assert.deepEqual(calls.fileDiscoveredTasks, ["- Tighten the widget flange -- found while testing"]);

    // Checklist written before execution (unchecked) and after the phase
    // finished (checked, with the PR reference).
    assert.ok(checklistSnapshots.length >= 2, `expected >=2 checklist updates, got ${checklistSnapshots.length}`);
    const first = checklistSnapshots[0];
    assert.equal(first[0].done, false);
    const last = checklistSnapshots[checklistSnapshots.length - 1];
    assert.equal(last[0].done, true);
    assert.equal(last[0].prNumber, 7);

    assert.ok(
      posted.some((body) => body.startsWith("## Implementation plan")),
      "expected the plan comment to have been posted",
    );
    assert.ok(
      posted.some((body) => body.includes("All phases executed")),
      "expected the merge-wait comment to have been posted",
    );
    // The projection saw the whole lifecycle, in order, from both workflows.
    for (const expected of [
      "pipeline_started",
      "plan_posted",
      "executing_started",
      "phase_started",
      "attempt_started",
      "attempt_finished",
      "phase_done",
      "merge_wait_started",
      "pipeline_completed",
    ]) {
      assert.ok(calls.projectedEvents.includes(expected), `expected projected event ${expected}`);
    }
    // The final summary rides on the CLOSING comment (gh issue close -c),
    // not a separate postComment.
    assert.ok(
      calls.closingComments[0].includes("closing this issue as completed"),
      "expected the closing comment to carry the final summary",
    );
  } finally {
    await testEnv.teardown();
  }
});
