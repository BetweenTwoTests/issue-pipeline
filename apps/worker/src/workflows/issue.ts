import {
  proxyActivities,
  setHandler,
  condition,
  executeChild,
  workflowInfo,
  continueAsNew,
} from "@temporalio/workflow";
import type * as activities from "@issue-pipeline/activities";
import {
  kickoffSignal,
  questionsAnsweredSignal,
  resumeSignal,
  skipSignal,
  abortSignal,
  checkMergesSignal,
  issueStatusQuery,
  slugify,
  PLAN_COMMENT_HEADER,
  type KickoffPayload,
  type AnswersPayload,
  type AnswerItem,
  type ResumePayload,
  type SkipPayload,
  type AbortPayload,
  type IssueStatus,
  type IssueWorkflowStage,
  type PhaseProgress,
  type OpenQuestion,
  type PlannerOutput,
  type ChecklistPhase,
  type RegisteredRepo,
} from "@issue-pipeline/core";
import { phaseWorkflow, type PhaseWorkflowResult } from "./phase";

const quick = proxyActivities<typeof activities>({
  startToCloseTimeout: "30s",
  retry: { maximumAttempts: 3 },
});
const {
  loadPipelineConfig,
  resolveRegisteredRepoBySlug,
  fetchRootIssue,
  postComment,
  addLabels,
  removeLabels,
  updateIssuePhaseChecklist,
  closeIssueCompleted,
} = quick;

// The merge-wait poll hits GitHub once per open PR -- give it more headroom
// than the single-call activities above.
const polling = proxyActivities<typeof activities>({
  startToCloseTimeout: "2m",
  retry: { maximumAttempts: 3 },
});
const { getPullRequestStates } = polling;

// Worktree/git operations -- can be slow on a cold cache; safe to retry, every
// one of them is designed idempotent (see git.ts).
const gitOps = proxyActivities<typeof activities>({
  startToCloseTimeout: "10m",
  retry: { maximumAttempts: 3 },
});
const { ensureBareClone, fetchRepo, createPlanningWorktree, cleanupIssueWorktrees } = gitOps;

const promptBuilding = proxyActivities<typeof activities>({
  startToCloseTimeout: "2m",
  retry: { maximumAttempts: 3 },
});
const { buildPlannerPrompt } = promptBuilding;

// The planner's own CLI invocation -- generously bounded (2h ceiling), but
// the real per-role cutoff is role.timeout_ms enforced inside the activity
// itself. maximumAttempts: 1 because agent runs are not idempotent; there is
// no "retry" concept for a single planner call the way there is for phases.
const planning = proxyActivities<typeof activities>({
  startToCloseTimeout: "2h",
  heartbeatTimeout: "30s",
  retry: { maximumAttempts: 1 },
});
const { runAgent, parsePlannerOutput } = planning;

export interface MergeWaitResumeState {
  phases: PhaseProgress[];
  closedPrWarningPosted: boolean;
}

export interface IssueWorkflowInput {
  owner: string;
  repo: string;
  issueNumber: number;
  /**
   * Present only when this execution is a continue-as-new hop taken during
   * the merge wait (the one unbounded-duration stage, where 15-minute polls
   * accrue history forever). Everything durable about the pipeline already
   * lives on the GitHub issue by then; this carries just the small per-phase
   * scalars the poll loop needs.
   */
  resumeFromMergeWait?: MergeWaitResumeState;
}

export interface IssueWorkflowResult {
  outcome: "completed" | "aborted";
  mergedPrs: number;
  totalPhases: number;
}

interface IssueState {
  stage: IssueWorkflowStage;
  phases: PhaseProgress[];
  currentIndex: number;
  pendingQuestions: OpenQuestion[];
  /** Answers for the CURRENT round of open questions (indexes are 1-based
   * into pendingQuestions). Cleared each planning round. */
  roundAnswers: AnswerItem[];
  decision?: "resume" | "skip" | "abort";
  aborted: boolean;
  checkMergesRequested: boolean;
}

/**
 * The entity workflow: one GitHub issue == one long-lived issueWorkflow.
 * plan (Claude plan mode) -> answer open questions (human-in-the-loop) ->
 * execute phases sequentially (stacked PRs, phases are checkboxes on the
 * issue body) -> watch the stack until every PR merges -> close the issue.
 */
export async function issueWorkflow(input: IssueWorkflowInput): Promise<IssueWorkflowResult> {
  const state: IssueState = {
    stage: input.resumeFromMergeWait ? "awaiting_merge" : "planning",
    phases: input.resumeFromMergeWait?.phases ?? [],
    currentIndex: input.resumeFromMergeWait?.phases.length ?? 0,
    pendingQuestions: [],
    roundAnswers: [],
    aborted: false,
    checkMergesRequested: false,
  };

  setHandler(kickoffSignal, (_payload: KickoffPayload) => {
    // Informational only (provenance for debugging who/what triggered this
    // run) -- repeat delivery is harmless.
  });
  setHandler(questionsAnsweredSignal, (payload: AnswersPayload) => {
    state.roundAnswers.push(...payload.answers);
  });
  setHandler(resumeSignal, (_payload: ResumePayload) => {
    if (state.stage === "parked") state.decision = "resume";
  });
  setHandler(skipSignal, (_payload: SkipPayload) => {
    if (state.stage === "parked") state.decision = "skip";
  });
  setHandler(abortSignal, (_payload: AbortPayload) => {
    state.aborted = true;
    state.decision = "abort";
  });
  setHandler(checkMergesSignal, () => {
    state.checkMergesRequested = true;
  });
  setHandler(issueStatusQuery, (): IssueStatus => ({
    stage: state.stage,
    currentIndex: state.currentIndex,
    totalPhases: state.phases.length,
    phases: state.phases,
    pendingQuestions: state.pendingQuestions.map((q) => q.q),
  }));

  const config = await loadPipelineConfig();
  const repo = await resolveRegisteredRepoBySlug(config, input.owner, input.repo);
  await ensureBareClone(repo);
  await fetchRepo(repo);

  let closedPrWarningPosted = input.resumeFromMergeWait?.closedPrWarningPosted ?? false;

  if (!input.resumeFromMergeWait) {
    const rootIssue = await fetchRootIssue(repo, input.issueNumber);

    // First line of idempotency defense against the (currently unbuilt)
    // polling bridge re-finding this issue: flip the label immediately.
    await removeLabels(repo, input.issueNumber, ["pipeline:ready"]);
    await addLabels(repo, input.issueNumber, ["pipeline:in-progress"]);

    // ---- Planning: Claude plan mode against a real checkout, re-run until
    // ---- a plan round comes back with zero open questions.
    const planningWorktree = await createPlanningWorktree(repo, input.issueNumber);
    const answeredQuestions: Array<{ q: string; answer: string }> = [];
    let decomposition: PlannerOutput;
    let planningRound = 0;

    for (;;) {
      planningRound += 1;
      state.stage = "planning";
      const prompt = await buildPlannerPrompt({
        issueNumber: input.issueNumber,
        issueTitle: rootIssue.title,
        issueBody: rootIssue.body,
        repoSlug: `${input.owner}/${input.repo}`,
        defaultBranch: repo.defaultBranch,
        answeredQuestions,
      });
      const agentResult = await runAgent({
        role: "planner",
        prompt,
        cwd: planningWorktree.worktreePath,
        config,
      });
      decomposition = await parsePlannerOutput(agentResult.summary);

      // The plan comment IS the durable plan -- every phase session is told
      // to read it from the issue rather than receiving spec text from
      // Temporal.
      await postComment(repo, input.issueNumber, formatPlanComment(planningRound, decomposition));

      if (decomposition.open_questions.length === 0) break;

      // ---- Human-in-the-loop: EVERY open question blocks implementation.
      state.stage = "awaiting_answers";
      state.pendingQuestions = decomposition.open_questions;
      state.roundAnswers = [];
      await addLabels(repo, input.issueNumber, ["pipeline:needs-input"]);
      await postComment(repo, input.issueNumber, formatQuestionsComment(decomposition.open_questions));

      const questions = decomposition.open_questions;
      const answeredAll = () => questions.every((_q, i) => state.roundAnswers.some((a) => a.index === i + 1));

      let stalledLabelApplied = false;
      while (!answeredAll() && !state.aborted) {
        const signaled = await condition(() => answeredAll() || state.aborted, "72h");
        if (!signaled && !stalledLabelApplied) {
          stalledLabelApplied = true;
          await addLabels(repo, input.issueNumber, ["pipeline:stalled"]);
          await postComment(
            repo,
            input.issueNumber,
            "Still waiting on the open questions above. Use `pipe answer` for each numbered question.",
          );
        }
      }
      if (state.aborted) return finalizeAborted(repo, input.issueNumber, state);

      await removeLabels(repo, input.issueNumber, ["pipeline:needs-input"]);
      if (stalledLabelApplied) await removeLabels(repo, input.issueNumber, ["pipeline:stalled"]);

      const pairs = questions.map((q, i) => ({
        q: q.q,
        answer: state.roundAnswers.find((a) => a.index === i + 1)?.text ?? "(no answer recorded)",
      }));
      answeredQuestions.push(...pairs);
      state.pendingQuestions = [];
      // Recorded on the issue so the decision survives outside Temporal --
      // executor sessions and future humans read it there.
      await postComment(repo, input.issueNumber, formatAnswersComment(pairs));
      // Loop: re-plan with every answer so far baked in.
    }

    // ---- Phases become checkboxes on the issue body, all unchecked.
    state.stage = "executing";
    state.phases = decomposition.phases.map((p) => ({
      title: p.title,
      status: "pending" as const,
      retryGeneration: 0,
      headBranch: null,
      prNumber: null,
      prUrl: null,
    }));
    state.currentIndex = 0;
    await updateIssuePhaseChecklist(repo, input.issueNumber, toChecklist(state.phases));

    // ---- Sequential execution, each phase stacked on the previous one.
    let baseBranch = repo.defaultBranch;
    while (state.currentIndex < state.phases.length) {
      const phase = state.phases[state.currentIndex];
      phase.status = "running";
      const childId = `${workflowInfo().workflowId}-phase-${state.currentIndex}-r${phase.retryGeneration}`;

      const result: PhaseWorkflowResult = await executeChild(phaseWorkflow, {
        workflowId: childId,
        args: [
          {
            owner: input.owner,
            repo: input.repo,
            issueNumber: input.issueNumber,
            phaseIndex: state.currentIndex,
            totalPhases: state.phases.length,
            phaseTitle: phase.title,
            branchSlug: slugify(phase.title),
            baseBranch,
          },
        ],
      });

      phase.headBranch = result.headBranch;
      phase.prNumber = result.prNumber;
      phase.prUrl = result.prUrl;

      if (result.status === "done") {
        phase.status = "done";
        await updateIssuePhaseChecklist(repo, input.issueNumber, toChecklist(state.phases));
        baseBranch = result.headBranch;
        state.currentIndex += 1;
        continue;
      }

      // ---- Parked: human-in-the-loop again (resume / skip / abort).
      phase.status = "parked";
      state.stage = "parked";
      state.decision = undefined;

      await condition(() => state.decision !== undefined);

      if (state.decision === "abort") return finalizeAborted(repo, input.issueNumber, state);

      // Either decision means the phase is no longer stalled -- phaseWorkflow's
      // park() applied this label to the root issue, so issueWorkflow (the only
      // place that decides to move past a park) is what clears it.
      await removeLabels(repo, input.issueNumber, ["pipeline:stalled"]);

      if (state.decision === "skip") {
        phase.status = "skipped";
        await updateIssuePhaseChecklist(repo, input.issueNumber, toChecklist(state.phases));
        // The branch exists (with at least its initial commit) even for a
        // failed phase -- later phases still stack on it so their diffs
        // stay scoped to their own work.
        baseBranch = result.headBranch;
        state.currentIndex += 1;
        state.stage = "executing";
        continue;
      }

      // resume: retry the same phase index as a new child workflow execution
      phase.retryGeneration += 1;
      phase.status = "pending";
      state.stage = "executing";
    }

    await postComment(
      repo,
      input.issueNumber,
      formatMergeWaitComment(state.phases, config.policy.merge_poll_minutes),
    );
  }

  // ---- All phases shipped. The workflow is deliberately NOT done: watch
  // ---- the stack until every phase PR is merged, then close the issue.
  state.stage = "awaiting_merge";
  const pollMs = Math.round(config.policy.merge_poll_minutes * 60_000);

  for (;;) {
    if (state.aborted) return finalizeAborted(repo, input.issueNumber, state);

    const trackedPrNumbers = state.phases
      .filter((p) => p.status === "done" && p.prNumber !== null)
      .map((p) => p.prNumber as number);
    const prStates = trackedPrNumbers.length > 0 ? await getPullRequestStates(repo, trackedPrNumbers) : [];
    if (prStates.every((s) => s.state === "MERGED")) break;

    const closedUnmerged = prStates.filter((s) => s.state === "CLOSED");
    if (closedUnmerged.length > 0 && !closedPrWarningPosted) {
      closedPrWarningPosted = true;
      await postComment(
        repo,
        input.issueNumber,
        `${closedUnmerged.map((s) => `PR #${s.number}`).join(", ")} was closed without merging. ` +
          "The pipeline keeps watching -- reopen the PR(s) to let this issue complete, or `pipe abort` to stop tracking.",
      );
    }

    // The poll loop is the one place history grows without bound (a stack
    // can sit unmerged for weeks) -- roll over to a fresh execution when the
    // server suggests it, carrying only small per-phase scalars. GitHub
    // holds everything else.
    if (workflowInfo().continueAsNewSuggested) {
      await continueAsNew<typeof issueWorkflow>({
        owner: input.owner,
        repo: input.repo,
        issueNumber: input.issueNumber,
        resumeFromMergeWait: { phases: state.phases, closedPrWarningPosted },
      });
    }

    state.checkMergesRequested = false;
    await condition(() => state.checkMergesRequested || state.aborted, pollMs);
  }

  // ---- Every PR merged: the issue is done.
  state.stage = "done";
  await addLabels(repo, input.issueNumber, ["pipeline:done"]);
  await removeLabels(repo, input.issueNumber, ["pipeline:in-progress"]);
  await closeIssueCompleted(repo, input.issueNumber, formatFinalSummary(state.phases));
  await cleanupIssueWorktrees(repo, input.issueNumber, state.phases.length);

  return {
    outcome: "completed",
    mergedPrs: state.phases.filter((p) => p.status === "done" && p.prNumber !== null).length,
    totalPhases: state.phases.length,
  };
}

async function finalizeAborted(
  repo: RegisteredRepo,
  issueNumber: number,
  state: IssueState,
): Promise<IssueWorkflowResult> {
  state.stage = "aborted";
  await postComment(repo, issueNumber, "Pipeline aborted by human command.");
  await removeLabels(repo, issueNumber, ["pipeline:in-progress"]);
  return {
    outcome: "aborted",
    mergedPrs: 0,
    totalPhases: state.phases.length,
  };
}

function toChecklist(phases: PhaseProgress[]): ChecklistPhase[] {
  return phases.map((p) => ({
    title: p.title,
    done: p.status === "done" || p.status === "skipped",
    prNumber: p.prNumber,
    prUrl: p.prUrl,
    note: p.status === "skipped" ? "skipped by human" : null,
  }));
}

function formatPlanComment(round: number, plan: PlannerOutput): string {
  const header = round > 1 ? `${PLAN_COMMENT_HEADER} (revision ${round})` : PLAN_COMMENT_HEADER;
  const phases = plan.phases
    .map(
      (p, i) =>
        `### Phase ${i + 1}: ${p.title}\n**Goal:** ${p.goal}\n\n${p.spec}\n\n**Acceptance criteria:**\n${p.acceptance
          .map((a) => `- ${a}`)
          .join("\n")}`,
    )
    .join("\n\n");
  const questionNote =
    plan.open_questions.length > 0
      ? `\n\n---\n**This plan has ${plan.open_questions.length} open question(s) -- see the next comment. Implementation will not start until every one is answered.**`
      : "";
  return `${header}\n\n${phases}${questionNote}`;
}

function formatQuestionsComment(questions: OpenQuestion[]): string {
  const lines = questions
    .map((q, i) => `${i + 1}. ${q.q}${q.proposed_answer ? `\n   _Planner's recommendation: ${q.proposed_answer}_` : ""}`)
    .join("\n");
  return `Open questions blocking implementation:\n\n${lines}\n\nAnswer each with \`pipe answer <issue-ref> <n> "<text>"\`. The plan is re-generated once all are answered.`;
}

function formatAnswersComment(pairs: Array<{ q: string; answer: string }>): string {
  const lines = pairs.map((p, i) => `${i + 1}. **Q:** ${p.q}\n   **A:** ${p.answer}`).join("\n");
  return `Answers recorded (the plan will be revised with these baked in):\n\n${lines}`;
}

function formatMergeWaitComment(phases: PhaseProgress[], pollMinutes: number): string {
  const prLines = phases
    .map((p, i) => {
      const pr = p.prNumber !== null ? `[PR #${p.prNumber}](${p.prUrl ?? ""})` : "no PR";
      return `${i + 1}. ${p.title} -- ${p.status} (${pr})`;
    })
    .join("\n");
  return `All phases executed.\n\n${prLines}\n\nThe pipeline now checks every ${pollMinutes} minute(s) until every phase PR is merged, then closes this issue. \`pipe check\` forces an immediate check.`;
}

function formatFinalSummary(phases: PhaseProgress[]): string {
  const lines = phases
    .map((p, i) => {
      const pr = p.prNumber !== null ? `[PR #${p.prNumber}](${p.prUrl ?? ""})` : "no PR";
      return `${i + 1}. ${p.title} -- ${p.status} (${pr})`;
    })
    .join("\n");
  return `Every phase PR is merged -- closing this issue as completed.\n\n${lines}`;
}
