import assert from "node:assert/strict";
import { test } from "node:test";
import { Worker } from "@temporalio/worker";
import { TestWorkflowEnvironment } from "@temporalio/testing";
import { phaseWorkflow, type PhaseWorkflowInput, type PhaseWorkflowResult } from "./phase";

// Uses the real Temporal stack already running via `just infra-up` (Docker)
// rather than TestWorkflowEnvironment.createLocal()/createTimeSkipping(),
// both of which download an external server binary on first use. phase.ts
// has no long time-based waits, so a non-time-skipping environment is fine.
const TEST_TASK_QUEUE = "test-phase-workflow";

function baseConfig(maxFixAttempts: number) {
  return {
    version: 1 as const,
    roles: {
      planner: { adapter: "claude" as const, args: [], timeout_ms: 1000 },
      executor: { adapter: "claude" as const, args: [], timeout_ms: 1000 },
      fixer: { adapter: "claude" as const, args: [], timeout_ms: 1000 },
    },
    policy: {
      local_gates: "advisory" as const,
      max_fix_attempts: maxFixAttempts,
      auto_continue: true,
      merge_poll_minutes: 15,
    },
    branching: { stack_tool: "git" as const, branch_prefix: "pipe", remote: "origin", pr_draft: false },
    gates: { timeout_ms: 1000, commands: [] },
    repos: {},
  };
}

const FAKE_REPO = { name: "test-repo", owner: "acme", repo: "widgets", localPath: "/tmp/fake", defaultBranch: "main" };

const BASE_INPUT: PhaseWorkflowInput = {
  owner: "acme",
  repo: "widgets",
  issueNumber: 1,
  phaseIndex: 0,
  totalPhases: 1,
  phaseTitle: "Do the thing",
  branchSlug: "do-thing",
  baseBranch: "main",
};

test("phaseWorkflow: retries exactly max_fix_attempts times then parks when the agent keeps crashing", async () => {
  const testEnv = await TestWorkflowEnvironment.createFromExistingServer({
    address: "localhost:7833",
    namespace: "issue-pipeline",
  });

  const calls = { runAgent: 0, resetWorktreeHard: 0, addLabels: [] as string[][] };

  const worker = await Worker.create({
    connection: testEnv.nativeConnection,
    namespace: "issue-pipeline",
    taskQueue: TEST_TASK_QUEUE,
    workflowsPath: require.resolve("./phase"),
    activities: {
      loadPipelineConfig: async () => baseConfig(1),
      resolveRegisteredRepoBySlug: async () => FAKE_REPO,
      createPhaseWorktree: async () => ({
        worktreePath: "/tmp/fake-worktree",
        branch: "pipe/1/p1-do-thing",
        initialCommitSha: "deadbeef",
      }),
      resetWorktreeHard: async () => {
        calls.resetWorktreeHard++;
      },
      buildExecutorPrompt: async () => "executor prompt",
      buildFixerPrompt: async () => "fixer prompt",
      runAgent: async () => {
        calls.runAgent++;
        return { ok: false, summary: "agent crashed", deviations: [], artifacts: [] };
      },
      readAndClearWorklog: async () => {
        throw new Error("should not be reached: runAgent always fails before worklog parsing");
      },
      postPhaseWorklogComment: async () => {
        throw new Error("should not be reached: a crashed agent has no worklog to post");
      },
      fileDiscoveredTasks: async () => {
        throw new Error("should not be reached: a crashed agent has no discovered tasks");
      },
      runLocalGates: async () => ({ passed: true, results: [] }),
      commitLeftoverChanges: async () => ({ committed: false }),
      submitPhaseBranch: async () => {
        throw new Error("should not be reached: a crashed agent never reaches PR submission");
      },
      setPullRequestBody: async () => {},
      addLabels: async (_repo: unknown, _issueNumber: number, labels: string[]) => {
        calls.addLabels.push(labels);
      },
      postComment: async () => {},
    },
  });

  try {
    const result = (await worker.runUntil(
      testEnv.client.workflow.execute(phaseWorkflow, {
        workflowId: `test-phase-crash-${Date.now()}`,
        taskQueue: TEST_TASK_QUEUE,
        args: [BASE_INPUT],
      }),
    )) as PhaseWorkflowResult;

    assert.equal(result.status, "parked");
    assert.equal(result.prNumber, null, "no attempt got far enough to submit a PR");
    // executor attempt (0) + exactly 1 fixer attempt (max_fix_attempts: 1)
    assert.equal(calls.runAgent, 2);
    // reset happens before every attempt EXCEPT the first
    assert.equal(calls.resetWorktreeHard, 1);
    assert.ok(calls.addLabels.some((labels) => labels.includes("pipeline:stalled")));
  } finally {
    await testEnv.teardown();
  }
});

test("phaseWorkflow: posts the worklog, files discovered tasks, submits the PR, and returns done", async () => {
  const testEnv = await TestWorkflowEnvironment.createFromExistingServer({
    address: "localhost:7833",
    namespace: "issue-pipeline",
  });

  const calls = {
    submitPhaseBranch: 0,
    postPhaseWorklogComment: 0,
    fileDiscoveredTasks: [] as string[],
  };

  const worker = await Worker.create({
    connection: testEnv.nativeConnection,
    namespace: "issue-pipeline",
    taskQueue: TEST_TASK_QUEUE,
    workflowsPath: require.resolve("./phase"),
    activities: {
      loadPipelineConfig: async () => baseConfig(2),
      resolveRegisteredRepoBySlug: async () => FAKE_REPO,
      createPhaseWorktree: async () => ({
        worktreePath: "/tmp/fake-worktree",
        branch: "pipe/1/p1-do-thing",
        initialCommitSha: "deadbeef",
      }),
      resetWorktreeHard: async () => {},
      buildExecutorPrompt: async () => "executor prompt",
      buildFixerPrompt: async () => "fixer prompt",
      runAgent: async () => ({ ok: true, summary: "did it", deviations: [], artifacts: [] }),
      readAndClearWorklog: async () => ({
        done: "did the thing",
        deviationsFromSpec: "None.",
        surprisesFindings: "None.",
        followUps: "None.",
        discoveredTasks: "- Found a flaky test elsewhere",
        status: "done" as const,
        raw: "## Done\ndid the thing\n\n## Status: done",
      }),
      postPhaseWorklogComment: async () => {
        calls.postPhaseWorklogComment++;
        return { url: "https://example.com/comment" };
      },
      fileDiscoveredTasks: async (_repo: unknown, _issue: number, _phase: number, text: string) => {
        calls.fileDiscoveredTasks.push(text);
        return { created: 1, total: 1 };
      },
      runLocalGates: async () => ({ passed: true, results: [] }),
      commitLeftoverChanges: async () => ({ committed: true }),
      submitPhaseBranch: async () => {
        calls.submitPhaseBranch++;
        return { url: "https://github.com/acme/widgets/pull/1", number: 1 };
      },
      setPullRequestBody: async () => {},
      addLabels: async () => {},
      postComment: async () => {},
    },
  });

  try {
    const result = (await worker.runUntil(
      testEnv.client.workflow.execute(phaseWorkflow, {
        workflowId: `test-phase-done-${Date.now()}`,
        taskQueue: TEST_TASK_QUEUE,
        args: [BASE_INPUT],
      }),
    )) as PhaseWorkflowResult;

    assert.equal(result.status, "done");
    assert.equal(result.headBranch, "pipe/1/p1-do-thing");
    assert.equal(result.prNumber, 1);
    assert.equal(result.prUrl, "https://github.com/acme/widgets/pull/1");
    assert.equal(calls.submitPhaseBranch, 1);
    assert.equal(calls.postPhaseWorklogComment, 1);
    assert.deepEqual(calls.fileDiscoveredTasks, ["- Found a flaky test elsewhere"]);
  } finally {
    await testEnv.teardown();
  }
});
