import { proxyActivities, workflowInfo } from "@temporalio/workflow";
import {
  buildPhaseBranchName,
  issueWorkflowId,
  type PipelineEventType,
  type RegisteredRepo,
  type PipelineConfig,
} from "@issue-pipeline/core";
import type * as activities from "@issue-pipeline/activities";

const quick = proxyActivities<typeof activities>({
  startToCloseTimeout: "30s",
  retry: { maximumAttempts: 3 },
});
const { loadPipelineConfig, resolveRegisteredRepoBySlug, postComment, addLabels, setPullRequestBody, recordPipelineEvent } =
  quick;

// GitHub round-trips that may involve several gh calls each (sub-issue
// listing + creation, worklog comment posting).
const githubOps = proxyActivities<typeof activities>({
  startToCloseTimeout: "2m",
  retry: { maximumAttempts: 3 },
});
const { postPhaseWorklogComment, fileDiscoveredTasks } = githubOps;

// Worktree/git operations -- can be slow on a cold cache; safe to retry, every
// one of them is designed idempotent (see git.ts). submitPhaseBranch is in
// here too: gt submit / git push --force-with-lease converge to the same
// state on re-run, so a Temporal retry after a transient network failure is
// safe.
const gitOps = proxyActivities<typeof activities>({
  startToCloseTimeout: "10m",
  retry: { maximumAttempts: 3 },
});
const { createPhaseWorktree, resetWorktreeHard, commitLeftoverChanges, submitPhaseBranch } = gitOps;

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
const { readAndClearWorklog } = worklogHandling;

export interface PhaseWorkflowInput {
  owner: string;
  repo: string;
  /** The root issue -- the single source of truth the executor session reads
   * (`gh issue view <n> --comments`) and comments on. There is no per-phase
   * sub-issue anymore. */
  issueNumber: number;
  /** 0-based. */
  phaseIndex: number;
  totalPhases: number;
  phaseTitle: string;
  branchSlug: string;
  /** repo.defaultBranch for phase 1, else the previous phase's branch name. */
  baseBranch: string;
}

export interface PhaseWorkflowResult {
  status: "done" | "parked";
  headBranch: string;
  /** Null when no attempt got far enough to submit (e.g. every attempt crashed). */
  prNumber: number | null;
  prUrl: string | null;
}

type FailureReason = "gate_failure" | "worklog_contract_violation" | "agent_crashed" | "declared_blocked";

export async function phaseWorkflow(input: PhaseWorkflowInput): Promise<PhaseWorkflowResult> {
  const config = await loadPipelineConfig();
  const repo = await resolveRegisteredRepoBySlug(config, input.owner, input.repo);

  const phaseNumber = input.phaseIndex + 1;
  const repoSlug = `${input.owner}/${input.repo}`;
  // Pure string formatting (no system state) -- safe to call directly in
  // workflow code, unlike the worktree's filesystem path, which depends on
  // os.homedir() and is computed inside createPhaseWorktree instead.
  const branchName = buildPhaseBranchName(config.branching.branch_prefix, input.issueNumber, phaseNumber, input.branchSlug);

  const worktree = await createPhaseWorktree({
    repo,
    rootIssueNumber: input.issueNumber,
    phase: phaseNumber,
    parentRef: input.baseBranch,
    newBranchName: branchName,
    stackTool: config.branching.stack_tool,
  });

  let priorFailure: { reason: FailureReason; detail: string } | undefined;
  let lastPr: { url: string; number: number } | null = null;
  const maxFixAttempts = config.policy.max_fix_attempts;

  // Attempt-level projection events, grouped under the ENTITY workflow's id
  // (derivable from owner/repo/issue -- pure) but keyed/deduped by this
  // child execution's own id and counter.
  const pipelineWorkflowId = issueWorkflowId(input.owner, input.repo, input.issueNumber);
  let eventSeq = 0;
  const emit = async (type: PipelineEventType, detail: Record<string, unknown>): Promise<void> => {
    eventSeq += 1;
    await recordPipelineEvent({
      pipelineWorkflowId,
      sourceWorkflowId: workflowInfo().workflowId,
      event: { seq: eventSeq, type, detail },
    });
  };

  // attempt 0 = the initial executor run; attempts 1..maxFixAttempts = fixer runs.
  for (let attempt = 0; attempt <= maxFixAttempts; attempt++) {
    if (attempt > 0) {
      await resetWorktreeHard(worktree.worktreePath, worktree.initialCommitSha);
    }

    const prompt =
      attempt === 0
        ? await buildExecutorPrompt({
            repoSlug,
            issueNumber: input.issueNumber,
            phaseNumber,
            totalPhases: input.totalPhases,
            phaseTitle: input.phaseTitle,
            branch: worktree.branch,
            baseBranch: input.baseBranch,
            stackTool: config.branching.stack_tool,
          })
        : await buildFixerPrompt({
            repoSlug,
            issueNumber: input.issueNumber,
            phaseNumber,
            totalPhases: input.totalPhases,
            phaseTitle: input.phaseTitle,
            branch: worktree.branch,
            stackTool: config.branching.stack_tool,
            reason: priorFailure!.reason,
            detail: priorFailure!.detail,
            attemptNumber: attempt,
            maxAttempts: maxFixAttempts,
          });

    await emit("attempt_started", { phase: phaseNumber, attempt, role: attempt === 0 ? "executor" : "fixer" });
    const agentResult = await runAgent({
      role: attempt === 0 ? "executor" : "fixer",
      prompt,
      cwd: worktree.worktreePath,
      config,
      context: {
        repoSlug,
        issueNumber: input.issueNumber,
        phaseNumber,
        attempt,
      },
    });

    if (!agentResult.ok) {
      await emit("attempt_finished", { phase: phaseNumber, attempt, outcome: "agent_crashed" });
      priorFailure = { reason: "agent_crashed", detail: agentResult.summary };
      if (attempt === maxFixAttempts) {
        return park(repo, config, input, worktree.branch, lastPr, "agent_crashed", agentResult.summary);
      }
      continue;
    }

    let worklog;
    try {
      worklog = await readAndClearWorklog(worktree.worktreePath);
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      await emit("attempt_finished", { phase: phaseNumber, attempt, outcome: "worklog_contract_violation" });
      priorFailure = { reason: "worklog_contract_violation", detail };
      if (attempt === maxFixAttempts) {
        return park(repo, config, input, worktree.branch, lastPr, "worklog_contract_violation", detail);
      }
      continue;
    }

    // Worklogs land on the root issue (labeled by phase) -- they are the
    // handoff context the NEXT phase's session reads via `gh issue view`.
    // The session footer ties the comment to its Claude Code transcript.
    await postPhaseWorklogComment(repo, input.issueNumber, phaseNumber, input.totalPhases, worklog, {
      sessionId: typeof agentResult.meta?.sessionId === "string" ? agentResult.meta.sessionId : null,
      costUsd: typeof agentResult.meta?.costUsd === "number" ? agentResult.meta.costUsd : null,
      numTurns: typeof agentResult.meta?.numTurns === "number" ? agentResult.meta.numTurns : null,
    });
    // "Immediately file discovered tasks": every out-of-scope task the agent
    // reported becomes a sub-issue of the root issue, recording which phase
    // it came from -- the one remaining use of sub-issues in this system.
    await fileDiscoveredTasks(repo, input.issueNumber, phaseNumber, worklog.discoveredTasks);

    const gateResult = await runLocalGates(worktree.worktreePath, config);

    // The agent owns its commits and (on the graphite path) usually its own
    // `gt submit`. These two are the pipeline-side guarantee: anything left
    // uncommitted gets committed, and the branch is (re)submitted after
    // EVERY session so the PR always matches the branch.
    await commitLeftoverChanges({
      worktreePath: worktree.worktreePath,
      message: `Phase ${phaseNumber}: auto-commit of changes the agent left uncommitted`,
    });
    const pr = await submitPhaseBranch({
      worktreePath: worktree.worktreePath,
      branch: worktree.branch,
      parentRef: input.baseBranch,
      stackTool: config.branching.stack_tool,
      repo,
      remote: config.branching.remote,
      title: `Phase ${phaseNumber}/${input.totalPhases}: ${input.phaseTitle}`,
      draft: config.branching.pr_draft,
    });
    lastPr = pr;
    await setPullRequestBody(repo, pr.number, formatPrBody(worklog, gateResult));

    if (worklog.status === "blocked") {
      await emit("attempt_finished", { phase: phaseNumber, attempt, outcome: "declared_blocked", prNumber: pr.number });
      priorFailure = { reason: "declared_blocked", detail: worklog.followUps };
      if (attempt === maxFixAttempts) {
        return park(repo, config, input, worktree.branch, lastPr, "declared_blocked", worklog.followUps);
      }
      continue;
    }

    // worklog.status === "done" from here on.
    if (config.policy.local_gates === "blocking" && !gateResult.passed) {
      const detail = gateResult.results
        .filter((r) => !r.ok)
        .map((r) => `${r.name}: ${r.output.slice(0, 500)}`)
        .join("\n\n");
      await emit("attempt_finished", { phase: phaseNumber, attempt, outcome: "gate_failure", prNumber: pr.number });
      priorFailure = { reason: "gate_failure", detail };
      if (attempt === maxFixAttempts) {
        return park(repo, config, input, worktree.branch, lastPr, "gate_failure", detail);
      }
      continue;
    }

    await emit("attempt_finished", { phase: phaseNumber, attempt, outcome: "done", prNumber: pr.number });
    return { status: "done", headBranch: worktree.branch, prNumber: pr.number, prUrl: pr.url };
  }

  throw new Error("phaseWorkflow: fell through the fixer loop unexpectedly");
}

async function park(
  repo: RegisteredRepo,
  config: PipelineConfig,
  input: PhaseWorkflowInput,
  headBranch: string,
  lastPr: { url: string; number: number } | null,
  reason: FailureReason,
  detail: string,
): Promise<PhaseWorkflowResult> {
  await addLabels(repo, input.issueNumber, ["pipeline:stalled"]);
  await postComment(
    repo,
    input.issueNumber,
    `Phase ${input.phaseIndex + 1}/${input.totalPhases} ("${input.phaseTitle}") is parked after ${config.policy.max_fix_attempts} fix attempt(s).\n\n` +
      `Reason: ${reason}\n${detail}\n\n` +
      "Use `pipe resume`, `pipe skip`, or `pipe abort` on this pipeline to continue.",
  );
  return { status: "parked", headBranch, prNumber: lastPr?.number ?? null, prUrl: lastPr?.url ?? null };
}

function formatPrBody(
  worklog: {
    done: string;
    deviationsFromSpec: string;
    surprisesFindings: string;
    followUps: string;
    discoveredTasks: string;
    status: string;
  },
  gateResult: { passed: boolean; results: Array<{ name: string; ok: boolean }> },
): string {
  const gateLine = gateResult.passed
    ? "Local gates: passed"
    : `Local gates (advisory): ${gateResult.results
        .filter((r) => !r.ok)
        .map((r) => r.name)
        .join(", ")} failed`;
  return `## Done\n${worklog.done}\n\n## Deviations from spec\n${worklog.deviationsFromSpec}\n\n## Surprises / new findings\n${worklog.surprisesFindings}\n\n## Follow-ups\n${worklog.followUps}\n\n## Discovered tasks\n${worklog.discoveredTasks}\n\n---\n${gateLine}`;
}
