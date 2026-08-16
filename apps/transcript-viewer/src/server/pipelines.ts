import * as path from "node:path";
import dotenv from "dotenv";
import { Client, Connection } from "@temporalio/client";
import {
  PLAN_WORKFLOW_NAME,
  abortSignal,
  planStatusQuery,
  questionsAnsweredSignal,
  resumeSignal,
  skipSignal,
  type AnswerItem,
  type PlanStatus,
} from "@issue-pipeline/core";
import type { PipelineListItem } from "../shared/types";
import type { ControlAction } from "./pipeline-requests";

/**
 * Temporal-side access for the pipelines panel: list/inspect plan workflows
 * and deliver human-in-the-loop signals (answers, resume/skip/abort). This
 * mirrors what the `pipe` CLI does over @temporalio/client -- the workflow
 * is the source of truth and the signal contracts come from
 * @issue-pipeline/core, so nothing here shells out to the CLI.
 *
 * TEMPORAL_ADDRESS / TEMPORAL_NAMESPACE come from the repo's .env, same as
 * apps/worker/src/env.ts and apps/cli/src/env.ts (each app loads it
 * itself on purpose -- see the comment there). `pnpm --filter
 * @issue-pipeline/transcript-viewer dev` runs with cwd at the package root,
 * so the repo root sits two levels up; variables already present in the
 * environment (e.g. from `just transcripts`, which dotenv-loads .env) win
 * because dotenv never overrides existing values.
 */
dotenv.config({ path: path.resolve(process.cwd(), "../../.env"), quiet: true });

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
