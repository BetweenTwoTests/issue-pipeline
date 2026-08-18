import * as fs from "node:fs/promises";
import {
  parsePipelineConfig,
  planWorkflowId,
  type IssueKey,
  type TrackerIssue,
} from "@issue-pipeline/core";
import * as store from "@issue-pipeline/store";
import type { IssueDetail, IssueListItem, RegisteredRepoSummary } from "./types";

/**
 * Issue reads/writes for the web UI: the tracker lives in the app database
 * (packages/store), and this is the only place besides the worker's
 * activities that touches it. Human-originated writes (new issues,
 * comments) happen here directly -- they are tracker data, not pipeline
 * control, so they don't go through Temporal signals.
 */

/** A request that is well-formed JSON but semantically invalid -- mapped to 400. */
export class BadRequestError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BadRequestError";
  }
}

export const PIPELINE_CONFIG_UNSET =
  "PIPELINE_CONFIG_PATH is not set -- copy .env.example to .env and point it at your pipeline.yaml. " +
  "Issue creation validates repos against its `repos:` map.";

export async function listRegisteredRepos(): Promise<RegisteredRepoSummary[]> {
  const configPath = process.env.PIPELINE_CONFIG_PATH;
  if (!configPath) throw new Error(PIPELINE_CONFIG_UNSET);
  const raw = await fs.readFile(configPath, "utf8");
  const config = parsePipelineConfig(raw);
  return Object.entries(config.repos).map(([name, entry]) => {
    const [owner, repo] = entry.github.split("/");
    return { name, owner, repo, defaultBranch: entry.default_branch };
  });
}

export async function listIssues(): Promise<IssueListItem[]> {
  const summaries = await store.listRootIssues();
  return summaries.map((summary) => ({
    issue: summary.issue,
    subIssuesTotal: summary.subIssuesTotal,
    subIssuesClosed: summary.subIssuesClosed,
    workflowId: planWorkflowId(summary.issue.repoOwner, summary.issue.repoName, summary.issue.number),
  }));
}

export async function getIssueDetail(key: IssueKey): Promise<IssueDetail | null> {
  const issue = await store.getIssue(key);
  if (!issue) return null;
  const [comments, subIssues, parent] = await Promise.all([
    store.listComments(key),
    store.listSubIssues(key),
    issue.parentNumber !== null
      ? store.getIssue({ repoOwner: key.repoOwner, repoName: key.repoName, number: issue.parentNumber })
      : Promise.resolve(null),
  ]);
  // A sub-issue's pipeline is its parent's -- one plan workflow per root issue.
  const rootNumber = issue.parentNumber ?? issue.number;
  return {
    issue,
    parent,
    subIssues,
    comments,
    workflowId: planWorkflowId(key.repoOwner, key.repoName, rootNumber),
  };
}

/**
 * Creates a root issue for a registered repo. The stored owner/name use
 * pipeline.yaml's casing regardless of how the request spelled the slug, so
 * tracker keys always match what the worker's activities look up.
 */
export async function createIssue(input: { repoSlug: string; title: string; body: string }): Promise<TrackerIssue> {
  const [owner, name] = input.repoSlug.split("/");
  const repos = await listRegisteredRepos();
  const registered = repos.find(
    (r) => r.owner.toLowerCase() === owner.toLowerCase() && r.repo.toLowerCase() === name.toLowerCase(),
  );
  if (!registered) {
    throw new BadRequestError(`Repo ${input.repoSlug} is not registered in pipeline.yaml -- add it under "repos:" first.`);
  }
  return store.createRootIssue({
    repoOwner: registered.owner,
    repoName: registered.repo,
    title: input.title,
    body: input.body,
  });
}

export async function addHumanComment(key: IssueKey, body: string, author: string) {
  const { comment } = await store.addComment(key, { author, authorKind: "human", body });
  return comment;
}
