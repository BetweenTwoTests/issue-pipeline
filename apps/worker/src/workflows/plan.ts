import { proxyActivities, setHandler, condition, executeChild, workflowInfo } from "@temporalio/workflow";
import type * as activities from "@issue-pipeline/activities";
import {
  kickoffSignal,
  questionsAnsweredSignal,
  resumeSignal,
  skipSignal,
  abortSignal,
  planStatusQuery,
  slugify,
  buildPhaseBranchName,
  type KickoffPayload,
  type AnswersPayload,
  type ResumePayload,
  type SkipPayload,
  type AbortPayload,
  type PlanStatus,
  type PlanWorkflowState,
  type OpenQuestion,
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
  ensureBareClone,
  fetchRepo,
  fetchRootIssue,
  createSubIssue,
  postComment,
  addLabels,
  removeLabels,
  closeSubIssue,
} = quick;

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

export interface PlanWorkflowInput {
  owner: string;
  repo: string;
  issueNumber: number;
}

export interface PlanWorkflowResult {
  outcome: "completed" | "aborted";
  completedPhases: number;
  totalPhases: number;
}

interface PhaseRecord {
  subIssueNumber: number;
  title: string;
  /** Bumped each time a parked phase is retried via /resume -- distinguishes
   * the child workflow ID per retry generation, separate from PhaseWorkflow's
   * own internal fixer-attempt counter. */
  retryGeneration: number;
  headBranch: string | null;
  status: "pending" | "done" | "parked";
}

interface PlanState {
  status: PlanWorkflowState;
  phases: PhaseRecord[];
  currentIndex: number;
  answers: AnswersPayload["answers"];
  decision?: "resume" | "skip" | "abort";
  aborted: boolean;
}

export async function planWorkflow(input: PlanWorkflowInput): Promise<PlanWorkflowResult> {
  const state: PlanState = {
    status: "planning",
    phases: [],
    currentIndex: 0,
    answers: [],
    aborted: false,
  };

  setHandler(kickoffSignal, (_payload: KickoffPayload) => {
    // Informational only (provenance for debugging who/what triggered this
    // run) -- repeat delivery is harmless.
  });
  setHandler(questionsAnsweredSignal, (payload: AnswersPayload) => {
    state.answers.push(...payload.answers);
  });
  setHandler(resumeSignal, (_payload: ResumePayload) => {
    if (state.status === "parked") state.decision = "resume";
  });
  setHandler(skipSignal, (_payload: SkipPayload) => {
    if (state.status === "parked") state.decision = "skip";
  });
  setHandler(abortSignal, (_payload: AbortPayload) => {
    state.aborted = true;
    state.decision = "abort";
  });
  setHandler(planStatusQuery, (): PlanStatus => ({
    status: state.status,
    currentIndex: state.currentIndex,
    totalPhases: state.phases.length,
    headBranch: state.phases[state.currentIndex]?.headBranch ?? null,
  }));

  const config = await loadPipelineConfig();
  const repo = await resolveRegisteredRepoBySlug(config, input.owner, input.repo);
  await ensureBareClone(repo);
  await fetchRepo(repo);

  const rootIssue = await fetchRootIssue(repo, input.issueNumber);

  // First line of idempotency defense against anything that discovers work
  // via the pipeline:ready label (e.g. a polling event bridge) re-finding
  // this issue: flip the label immediately.
  await removeLabels(repo, input.issueNumber, ["pipeline:ready"]);
  await addLabels(repo, input.issueNumber, ["pipeline:in-progress"]);

  const repoSlug = `${input.owner}/${input.repo}`;
  const plannerPromptInput = {
    rootIssueNumber: input.issueNumber,
    rootIssueTitle: rootIssue.title,
    rootIssueBody: rootIssue.body,
    repoSlug,
  };

  const firstPrompt = await buildPlannerPrompt(plannerPromptInput);
  const firstAgentResult = await runAgent({ role: "planner", prompt: firstPrompt, cwd: repo.localPath, config });
  let decomposition = await parsePlannerOutput(firstAgentResult.summary);

  const blockingQuestions = decomposition.open_questions.filter((q) => q.blocking);
  const nonBlockingQuestions = decomposition.open_questions.filter((q) => !q.blocking);

  if (nonBlockingQuestions.length > 0) {
    await postComment(repo, input.issueNumber, formatAssumptions(nonBlockingQuestions));
  }

  if (blockingQuestions.length > 0) {
    state.status = "awaiting_blocking_questions";
    await addLabels(repo, input.issueNumber, ["pipeline:needs-input"]);
    await postComment(repo, input.issueNumber, formatBlockingQuestions(blockingQuestions));

    const answeredAll = () => blockingQuestions.every((_q, i) => state.answers.some((a) => a.index === i + 1));

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

    const answersText = blockingQuestions
      .map((q, i) => {
        const answer = state.answers.find((a) => a.index === i + 1);
        return `${q.q}\nAnswer: ${answer?.text ?? "(no answer recorded)"}`;
      })
      .join("\n\n");
    const secondPrompt = await buildPlannerPrompt({
      ...plannerPromptInput,
      rootIssueBody: `${plannerPromptInput.rootIssueBody}\n\n## Answers to previously-blocking questions\n${answersText}`,
    });
    const secondAgentResult = await runAgent({ role: "planner", prompt: secondPrompt, cwd: repo.localPath, config });
    decomposition = await parsePlannerOutput(secondAgentResult.summary);
  }

  state.status = "running_phase";

  const created = await createSubIssuesForPhases(repo, input.issueNumber, config.branching.branch_prefix, decomposition.phases);
  state.phases = created.map((c) => ({
    subIssueNumber: c.number,
    title: c.title,
    retryGeneration: 0,
    headBranch: null,
    status: "pending" as const,
  }));

  await postComment(repo, input.issueNumber, formatPhaseMap(state.phases));

  let baseBranch = repo.defaultBranch;
  const priorSubIssueNumbers: number[] = [];

  while (state.currentIndex < state.phases.length) {
    const phase = state.phases[state.currentIndex];
    const phaseSpec = decomposition.phases[state.currentIndex];
    const childId = `${workflowInfo().workflowId}-phase-${state.currentIndex}-r${phase.retryGeneration}`;

    const result: PhaseWorkflowResult = await executeChild(phaseWorkflow, {
      workflowId: childId,
      args: [
        {
          owner: input.owner,
          repo: input.repo,
          planIssueNumber: input.issueNumber,
          phaseIndex: state.currentIndex,
          totalPhases: state.phases.length,
          subIssueNumber: phase.subIssueNumber,
          phaseTitle: phaseSpec.title,
          phaseGoal: phaseSpec.goal,
          phaseSpec: phaseSpec.spec,
          acceptance: phaseSpec.acceptance,
          branchSlug: slugify(phaseSpec.title),
          baseBranch,
          priorSubIssueNumbers: [...priorSubIssueNumbers],
        },
      ],
    });

    if (result.status === "done") {
      phase.status = "done";
      phase.headBranch = result.headBranch;
      baseBranch = result.headBranch;
      priorSubIssueNumbers.push(phase.subIssueNumber);
      state.currentIndex += 1;
      continue;
    }

    phase.status = "parked";
    phase.headBranch = result.headBranch;
    state.status = "parked";
    state.decision = undefined;

    await condition(() => state.decision !== undefined);

    if (state.decision === "abort") return finalizeAborted(repo, input.issueNumber, state);

    // Either decision means the phase is no longer stalled -- PhaseWorkflow's
    // park() applied this label to the root issue, so PlanWorkflow (the only
    // place that decides to move past a park) is what clears it.
    await removeLabels(repo, input.issueNumber, ["pipeline:stalled"]);

    if (state.decision === "skip") {
      await closeSubIssue(repo, phase.subIssueNumber, "Skipped by human command.");
      phase.status = "done";
      baseBranch = result.headBranch;
      priorSubIssueNumbers.push(phase.subIssueNumber);
      state.currentIndex += 1;
      state.status = "running_phase";
      continue;
    }

    // resume: retry the same phase index as a new child workflow execution
    phase.retryGeneration += 1;
    state.status = "running_phase";
  }

  state.status = "done";
  await addLabels(repo, input.issueNumber, ["pipeline:done"]);
  await removeLabels(repo, input.issueNumber, ["pipeline:in-progress"]);
  await postComment(repo, input.issueNumber, formatFinalSummary(state.phases));

  return { outcome: "completed", completedPhases: state.phases.length, totalPhases: state.phases.length };
}

async function createSubIssuesForPhases(
  repo: RegisteredRepo,
  parentIssueNumber: number,
  branchPrefix: string,
  phases: Array<{ title: string; goal: string; spec: string; acceptance: string[] }>,
): Promise<Array<{ number: number; title: string }>> {
  const created: Array<{ number: number; title: string }> = [];
  let previousBranch: string | null = null;
  for (let i = 0; i < phases.length; i++) {
    const phase = phases[i];
    const slug = slugify(phase.title);
    const branchName = buildPhaseBranchName(branchPrefix, parentIssueNumber, i + 1, slug);
    const baseBranchForMetadata = previousBranch ?? repo.defaultBranch;
    const bodyMarkdown = `${phase.spec}\n\n## Acceptance criteria\n${phase.acceptance.map((a) => `- ${a}`).join("\n")}`;
    const result = await createSubIssue(repo, {
      parentIssueNumber,
      phase: i + 1,
      title: phase.title,
      bodyMarkdown,
      baseBranch: baseBranchForMetadata,
    });
    created.push({ number: result.number, title: phase.title });
    previousBranch = branchName;
  }
  return created;
}

async function finalizeAborted(
  repo: RegisteredRepo,
  issueNumber: number,
  state: PlanState,
): Promise<PlanWorkflowResult> {
  state.status = "aborted";
  await postComment(repo, issueNumber, "Pipeline aborted by human command.");
  return {
    outcome: "aborted",
    completedPhases: state.phases.filter((p) => p.status === "done").length,
    totalPhases: state.phases.length,
  };
}

function formatBlockingQuestions(questions: OpenQuestion[]): string {
  const lines = questions.map((q, i) => `${i + 1}. ${q.q}`).join("\n");
  return `This plan has open questions that block decomposition:\n\n${lines}\n\nUse \`pipe answer <issue-ref> <n> "<text>"\` for each.`;
}

function formatAssumptions(questions: OpenQuestion[]): string {
  const lines = questions.map((q) => `- ${q.q}\n  _Assumption used: ${q.proposed_answer}_`).join("\n");
  return `Decomposition proceeded with these assumptions (reply if any are wrong):\n\n${lines}`;
}

function formatPhaseMap(phases: PhaseRecord[]): string {
  const lines = phases.map((p, i) => `${i + 1}. ${p.title} (sub-issue #${p.subIssueNumber})`).join("\n");
  return `Proposed phase plan:\n\n${lines}`;
}

function formatFinalSummary(phases: PhaseRecord[]): string {
  const lines = phases.map((p, i) => `${i + 1}. ${p.title} -- ${p.status} (${p.headBranch ?? "no branch"})`).join("\n");
  return `Pipeline complete.\n\n${lines}`;
}
