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
      executor: { adapter: "codex" as const, args: [], timeout_ms: 1000 },
      fixer: { adapter: "codex" as const, args: [], timeout_ms: 1000 },
    },
    policy: { local_gates: "advisory" as const, max_fix_attempts: maxFixAttempts, auto_continue: true },
    branching: { stack_tool: "git" as const, branch_prefix: "pipe", remote: "origin", pr_draft: false },
    gates: { timeout_ms: 1000, commands: [] },
    repos: {},
  };
}

const FAKE_REPO = { name: "test-repo", owner: "acme", repo: "widgets", localPath: "/tmp/fake", defaultBranch: "main" };

const BASE_INPUT: PhaseWorkflowInput = {
  owner: "acme",
  repo: "widgets",
  planIssueNumber: 1,
  phaseIndex: 0,
  totalPhases: 1,
  subIssueNumber: 2,
  phaseTitle: "Do the thing",
  phaseGoal: "goal",
  phaseSpec: "spec",
  acceptance: ["works"],
  branchSlug: "do-thing",
  baseBranch: "main",
  priorSubIssueNumbers: [],
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
      ensureBareClone: async () => {},
      fetchRepo: async () => {},
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
      postWorklogComment: async () => {},
      buildTranscriptFooter: async () => "",
      runLocalGates: async () => ({ passed: true, results: [] }),
      commitWorktreeChanges: async () => ({ committed: false }),
      submitPullRequest: async () => {
        throw new Error("should not be reached: a crashed agent never reaches PR submission");
      },
      setPullRequestBody: async () => {},
      closeSubIssue: async () => {
        throw new Error("should not be reached: a parked phase never closes its sub-issue");
      },
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
    // executor attempt (0) + exactly 1 fixer attempt (max_fix_attempts: 1)
    assert.equal(calls.runAgent, 2);
    // reset happens before every attempt EXCEPT the first
    assert.equal(calls.resetWorktreeHard, 1);
    assert.ok(calls.addLabels.some((labels) => labels.includes("pipeline:stalled")));
  } finally {
    await testEnv.teardown();
  }
});

test("phaseWorkflow: closes the sub-issue and returns done when the worklog says done", async () => {
  const testEnv = await TestWorkflowEnvironment.createFromExistingServer({
    address: "localhost:7833",
    namespace: "issue-pipeline",
  });

  const calls = { closeSubIssue: 0, submitPullRequest: 0 };

  const worker = await Worker.create({
    connection: testEnv.nativeConnection,
    namespace: "issue-pipeline",
    taskQueue: TEST_TASK_QUEUE,
    workflowsPath: require.resolve("./phase"),
    activities: {
      loadPipelineConfig: async () => baseConfig(2),
      resolveRegisteredRepoBySlug: async () => FAKE_REPO,
      ensureBareClone: async () => {},
      fetchRepo: async () => {},
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
        status: "done" as const,
        raw: "## Done\ndid the thing\n\n## Status: done",
      }),
      postWorklogComment: async () => {},
      buildTranscriptFooter: async () => "",
      runLocalGates: async () => ({ passed: true, results: [] }),
      commitWorktreeChanges: async () => ({ committed: true }),
      submitPullRequest: async () => {
        calls.submitPullRequest++;
        return { url: "https://github.com/acme/widgets/pull/1", number: 1 };
      },
      setPullRequestBody: async () => {},
      closeSubIssue: async () => {
        calls.closeSubIssue++;
      },
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
    assert.equal(calls.closeSubIssue, 1);
    assert.equal(calls.submitPullRequest, 1);
  } finally {
    await testEnv.teardown();
  }
});
