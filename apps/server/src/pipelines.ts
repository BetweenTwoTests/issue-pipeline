import { Client, Connection, WorkflowIdReusePolicy } from "@temporalio/client";
import {
  PIPELINE_TASK_QUEUE,
  PLAN_WORKFLOW_NAME,
  abortSignal,
  issueRefToWorkflowId,
  kickoffSignal,
  planStatusQuery,
  questionsAnsweredSignal,
  resumeSignal,
  skipSignal,
  TrackerIssueNotFoundError,
  formatIssueRef,
  type AnswerItem,
  type IssueRef,
  type KickoffPayload,
  type PlanStatus,
} from "@issue-pipeline/core";
import { getIssue, recordLaunch } from "@issue-pipeline/store";
import { BadRequestError } from "./issues";
import "./env"; // loads the repo .env (TEMPORAL_ADDRESS / TEMPORAL_NAMESPACE)
import type { ControlAction } from "./pipeline-requests";
import type { PipelineListItem } from "./types";

/**
 * Temporal-side access for the pipelines panel: list/inspect plan workflows,
 * start new ones, and deliver human-in-the-loop signals (answers,
 * resume/skip/abort). This mirrors what the `pipe` CLI does over
 * @temporalio/client -- the workflow is the source of truth and the signal
 * contracts come from @issue-pipeline/core, so nothing here shells out to
 * the CLI.
 */

export const TEMPORAL_UNCONFIGURED =
  "TEMPORAL_ADDRESS / TEMPORAL_NAMESPACE are not set -- copy .env.example to .env. " +
  "This project never falls back to a default Temporal address, so pipeline " +
  "actions are unavailable until they are configured.";

const LIST_LIMIT = 25;
/** Status queries need a running worker; without one they would hang the
 * panel forever, so they are raced against this. */
const QUERY_TIMEOUT_MS = 3_000;

function temporalTarget(): { address: string; namespace: string } | null {
  const address = process.env.TEMPORAL_ADDRESS?.trim();
  const namespace = process.env.TEMPORAL_NAMESPACE?.trim();
  return address && namespace ? { address, namespace } : null;
}

let clientPromise: Promise<Client> | null = null;

function getClient(): Promise<Client> {
  const target = temporalTarget();
  if (!target) return Promise.reject(new Error(TEMPORAL_UNCONFIGURED));
  if (!clientPromise) {
    clientPromise = Connection.connect({ address: target.address, connectTimeout: "3s" }).then(
      (connection) => new Client({ connection, namespace: target.namespace }),
    );
    // A failed connect must not poison every later request -- drop the
    // rejected promise so the next request retries.
    clientPromise.catch(() => {
      clientPromise = null;
    });
  }
  return clientPromise;
}

function withTimeout<T>(promise: Promise<T>, ms: number, what: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`${what} timed out after ${ms}ms -- is the worker running? (just worker)`)),
      ms,
    );
    timer.unref();
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (err) => {
        clearTimeout(timer);
        reject(err);
      },
    );
  });
}

function queryPlan(client: Client, workflowId: string): Promise<PlanStatus> {
  return withTimeout(client.workflow.getHandle(workflowId).query(planStatusQuery), QUERY_TIMEOUT_MS, "status query");
}

async function attachPlan(client: Client, item: PipelineListItem): Promise<void> {
  try {
    item.plan = await queryPlan(client, item.workflowId);
  } catch (err) {
    item.queryError = err instanceof Error ? err.message : String(err);
  }
}

export async function listPipelines(): Promise<PipelineListItem[]> {
  const client = await getClient();
  const items: PipelineListItem[] = [];
  for await (const wf of client.workflow.list({
    query: `WorkflowType = '${PLAN_WORKFLOW_NAME}'`,
    pageSize: LIST_LIMIT,
  })) {
    items.push({
      workflowId: wf.workflowId,
      runId: wf.runId,
      executionStatus: wf.status.name,
      startTime: wf.startTime ? wf.startTime.toISOString() : null,
    });
    if (items.length >= LIST_LIMIT) break;
  }
  // Closed workflows can answer queries too (the worker replays history), so
  // enrich every row and tolerate per-row failure.
  await Promise.all(items.map((item) => attachPlan(client, item)));
  return items;
}

export async function getPipeline(workflowId: string): Promise<PipelineListItem> {
  const client = await getClient();
  const description = await client.workflow.getHandle(workflowId).describe();
  const item: PipelineListItem = {
    workflowId,
    runId: description.runId,
    executionStatus: description.status.name,
    startTime: description.startTime ? description.startTime.toISOString() : null,
  };
  await attachPlan(client, item);
  return item;
}

/**
 * Starts (or signals, if already running) the plan workflow for an issue --
 * the web-triggered equivalent of `pipe start`. ALLOW_DUPLICATE_FAILED_ONLY
 * governs the closed-workflow case: re-running an issue whose pipeline
 * already completed successfully is blocked, while one that failed, was
 * terminated, or was cancelled can be retried; REJECT_DUPLICATE would
 * permanently wedge an issue's workflow id after any failure. A
 * still-running workflow just receives the kickoff signal.
 */
export async function startPipeline(ref: IssueRef, triggeredBy: string): Promise<{ workflowId: string }> {
  // Fail fast on a ref with no tracker row: without this, the workflow
  // would start, fail inside fetchRootIssue, and the UI would only learn
  // about it from the workflow's failure state.
  const key = { repoOwner: ref.owner, repoName: ref.repo, number: ref.issueNumber };
  const issue = await getIssue(key);
  if (!issue) {
    throw new TrackerIssueNotFoundError(
      `No tracker issue ${formatIssueRef(key)} -- create it first (the "New issue" form or POST /api/issues).`,
      formatIssueRef(key),
    );
  }
  if (issue.parentNumber !== null) {
    throw new BadRequestError(
      `${formatIssueRef(key)} is a phase sub-issue of #${issue.parentNumber}; start the pipeline on the root issue.`,
    );
  }

  const client = await getClient();
  const workflowId = issueRefToWorkflowId(ref);
  await client.workflow.signalWithStart(PLAN_WORKFLOW_NAME, {
    workflowId,
    taskQueue: PIPELINE_TASK_QUEUE,
    workflowIdReusePolicy: WorkflowIdReusePolicy.ALLOW_DUPLICATE_FAILED_ONLY,
    args: [{ owner: ref.owner, repo: ref.repo, issueNumber: ref.issueNumber }],
    signal: kickoffSignal,
    signalArgs: [{ source: "web", triggeredBy } satisfies KickoffPayload],
  });
  await recordLaunch({ workflowId, ref, source: "web", triggeredBy });
  return { workflowId };
}

export async function signalAnswers(workflowId: string, answers: AnswerItem[]): Promise<void> {
  const client = await getClient();
  await client.workflow.getHandle(workflowId).signal(questionsAnsweredSignal, { answers });
}

export async function signalControl(workflowId: string, action: ControlAction, note?: string): Promise<void> {
  const client = await getClient();
  const handle = client.workflow.getHandle(workflowId);
  const payload = note === undefined ? {} : { note };
  switch (action) {
    case "resume":
      await handle.signal(resumeSignal, payload);
      break;
    case "skip":
      await handle.signal(skipSignal, payload);
      break;
    case "abort":
      await handle.signal(abortSignal, payload);
      break;
  }
}
