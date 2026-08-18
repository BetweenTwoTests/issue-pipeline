import { proxyActivities } from "@temporalio/workflow";
import type * as activities from "@issue-pipeline/activities";
import { agentSessionId, buildPhaseBranchName, type RegisteredRepo, type PipelineConfig } from "@issue-pipeline/core";

const quick = proxyActivities<typeof activities>({
  startToCloseTimeout: "30s",
  retry: { maximumAttempts: 3 },
});
const {
  loadPipelineConfig,
  resolveRegisteredRepoBySlug,
  ensureBareClone,
  fetchRepo,
  postComment,
  addLabels,
  closeSubIssue,
  setPullRequestBody,
  buildTranscriptFooter,
} = quick;

// Worktree/git operations -- can be slow on a cold cache; safe to retry, every
// one of them is designed idempotent (see git.ts).
const gitOps = proxyActivities<typeof activities>({
  startToCloseTimeout: "10m",
  retry: { maximumAttempts: 3 },
});
const { createPhaseWorktree, resetWorktreeHard, commitWorktreeChanges, submitPullRequest } = gitOps;

const promptBuilding = proxyActivities<typeof activities>({
  startToCloseTimeout: "2m",
  retry: { maximumAttempts: 3 },
});
const { buildExecutorPrompt, buildFixerPrompt } = promptBuilding;

// Advisory local gates. exec.ts's runCommand has no heartbeat plumbing (gates
// are bounded by their own config-driven timeout, not a multi-hour agent
// run), so no heartbeatTimeout here -- just an outer ceiling.
const gatesProxy = proxyActivities<typeof activities>({
  startToCloseTimeout: "20m",
  retry: { maximumAttempts: 1 },
});
const { runLocalGates } = gatesProxy;

// The long-running agent executor/fixer. Heartbeat every ~10s (wired in
// adapters/process.ts), well under the 30s heartbeatTimeout.
// maximumAttempts: 1 -- agent runs are not idempotent; recovery is the
// semantic fixer loop below on a freshly reset worktree, never a blind
// Temporal-level retry of the same attempt.
const agentExecution = proxyActivities<typeof activities>({
  startToCloseTimeout: "2h",
  heartbeatTimeout: "30s",
  retry: { maximumAttempts: 1 },
});
const { runAgent } = agentExecution;

const worklogHandling = proxyActivities<typeof activities>({
  startToCloseTimeout: "30s",
  retry: { maximumAttempts: 3 },
});
const { readAndClearWorklog, postWorklogComment } = worklogHandling;

export interface PhaseWorkflowInput {
  owner: string;
  repo: string;
  planIssueNumber: number;
  /** 0-based. */
  phaseIndex: number;
  totalPhases: number;
  subIssueNumber: number;
  phaseTitle: string;
  phaseGoal: string;
  phaseSpec: string;
  acceptance: string[];
  branchSlug: string;
  /** repo.defaultBranch for phase 1, else the previous phase's branch name. */
  baseBranch: string;
  priorSubIssueNumbers: number[];
}

export interface PhaseWorkflowResult {
  status: "done" | "parked";
  headBranch: string;
}

type FailureReason = "gate_failure" | "worklog_contract_violation" | "agent_crashed" | "declared_blocked";

export async function phaseWorkflow(input: PhaseWorkflowInput): Promise<PhaseWorkflowResult> {
  const config = await loadPipelineConfig();
  const repo = await resolveRegisteredRepoBySlug(config, input.owner, input.repo);
  await ensureBareClone(repo);
  await fetchRepo(repo);

  const phaseNumber = input.phaseIndex + 1;
  // Pure string formatting (no system state) -- safe to call directly in
  // workflow code, unlike the worktree's filesystem path, which depends on
  // os.homedir() and is computed inside createPhaseWorktree instead.
  const branchName = buildPhaseBranchName(config.branching.branch_prefix, input.planIssueNumber, phaseNumber, input.branchSlug);

  const worktree = await createPhaseWorktree({
    repo,
    rootIssueNumber: input.planIssueNumber,
    phase: phaseNumber,
    parentRef: input.baseBranch,
    newBranchName: branchName,
    stackTool: config.branching.stack_tool,
  });

  let priorFailure: { reason: FailureReason; detail: string } | undefined;
  const maxFixAttempts = config.policy.max_fix_attempts;

  // attempt 0 = the initial executor run; attempts 1..maxFixAttempts = fixer runs.
  for (let attempt = 0; attempt <= maxFixAttempts; attempt++) {
    if (attempt > 0) {
      await resetWorktreeHard(worktree.worktreePath, worktree.initialCommitSha);
    }

    const prompt =
      attempt === 0
        ? await buildExecutorPrompt({
            repo,
            phaseNumber,
            totalPhases: input.totalPhases,
            phaseTitle: input.phaseTitle,
            phaseGoal: input.phaseGoal,
            phaseSpec: input.phaseSpec,
            acceptance: input.acceptance,
            baseBranch: input.baseBranch,
            priorSubIssueNumbers: input.priorSubIssueNumbers,
          })
        : await buildFixerPrompt({
            phaseNumber,
            totalPhases: input.totalPhases,
            phaseTitle: input.phaseTitle,
            phaseGoal: input.phaseGoal,
            phaseSpec: input.phaseSpec,
            acceptance: input.acceptance,
            reason: priorFailure!.reason,
            detail: priorFailure!.detail,
            attemptNumber: attempt,
            maxAttempts: maxFixAttempts,
          });

    const agentResult = await runAgent({
      role: attempt === 0 ? "executor" : "fixer",
      prompt,
      cwd: worktree.worktreePath,
      config,
    });

    if (!agentResult.ok) {
      priorFailure = { reason: "agent_crashed", detail: agentResult.summary };
      if (attempt === maxFixAttempts) {
        return park(repo, config, input, worktree.branch, "agent_crashed", agentResult.summary);
      }
      continue;
    }

    let worklog;
    try {
      worklog = await readAndClearWorklog(worktree.worktreePath);
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      priorFailure = { reason: "worklog_contract_violation", detail };
      if (attempt === maxFixAttempts) {
        return park(repo, config, input, worktree.branch, "worklog_contract_violation", detail);
      }
      continue;
    }

    const transcriptFooter = await buildTranscriptFooter({
      cwd: worktree.worktreePath,
      sessionId: agentSessionId(agentResult),
    });
    await postWorklogComment(repo, input.subIssueNumber, worklog, transcriptFooter);
    const gateResult = await runLocalGates(worktree.worktreePath, config);

    await commitWorktreeChanges({
      worktreePath: worktree.worktreePath,
      stackTool: config.branching.stack_tool,
      message: `${input.phaseTitle}\n\n${worklog.done}`,
    });

    const pr = await submitPullRequest({
      worktreePath: worktree.worktreePath,
      branch: worktree.branch,
      parentRef: input.baseBranch,
      stackTool: config.branching.stack_tool,
      repo,
      remote: config.branching.remote,
      title: `Phase ${phaseNumber}/${input.totalPhases}: ${input.phaseTitle}`,
      draft: config.branching.pr_draft,
    });
    await setPullRequestBody(repo, pr.number, formatPrBody(worklog, gateResult));

    if (worklog.status === "blocked") {
      priorFailure = { reason: "declared_blocked", detail: worklog.followUps };
      if (attempt === maxFixAttempts) {
        return park(repo, config, input, worktree.branch, "declared_blocked", worklog.followUps);
      }
      continue;
    }

    // worklog.status === "done" from here on.
    if (config.policy.local_gates === "blocking" && !gateResult.passed) {
      const detail = gateResult.results
        .filter((r) => !r.ok)
        .map((r) => `${r.name}: ${r.output.slice(0, 500)}`)
        .join("\n\n");
      priorFailure = { reason: "gate_failure", detail };
      if (attempt === maxFixAttempts) {
        return park(repo, config, input, worktree.branch, "gate_failure", detail);
      }
      continue;
    }

    await closeSubIssue(repo, input.subIssueNumber, `Closed by issue-pipeline. PR: ${pr.url}`);
    return { status: "done", headBranch: worktree.branch };
  }

  throw new Error("phaseWorkflow: fell through the fixer loop unexpectedly");
}

async function park(
  repo: RegisteredRepo,
  config: PipelineConfig,
  input: PhaseWorkflowInput,
  headBranch: string,
  reason: FailureReason,
  detail: string,
): Promise<PhaseWorkflowResult> {
  await addLabels(repo, input.planIssueNumber, ["pipeline:stalled"]);
  await postComment(
    repo,
    input.planIssueNumber,
    `Phase ${input.phaseIndex + 1}/${input.totalPhases} (sub-issue #${input.subIssueNumber}) is parked after ${config.policy.max_fix_attempts} fix attempt(s).\n\n` +
      `Reason: ${reason}\n${detail}\n\n` +
      "Use `pipe resume`, `pipe skip`, or `pipe abort` on this pipeline to continue.",
  );
  return { status: "parked", headBranch };
}

function formatPrBody(
  worklog: { done: string; deviationsFromSpec: string; surprisesFindings: string; followUps: string; status: string },
  gateResult: { passed: boolean; results: Array<{ name: string; ok: boolean }> },
): string {
  const gateLine = gateResult.passed
    ? "Local gates: passed"
    : `Local gates (advisory): ${gateResult.results
        .filter((r) => !r.ok)
        .map((r) => r.name)
        .join(", ")} failed`;
  return `## Done\n${worklog.done}\n\n## Deviations from spec\n${worklog.deviationsFromSpec}\n\n## Surprises / new findings\n${worklog.surprisesFindings}\n\n## Follow-ups\n${worklog.followUps}\n\n---\n${gateLine}`;
}
