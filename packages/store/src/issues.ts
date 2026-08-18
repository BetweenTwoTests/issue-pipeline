import {
  TrackerIssueNotFoundError,
  formatIssueRef,
  type CommentAuthorKind,
  type IssueKey,
  type TrackerComment,
  type TrackerIssue,
} from "@issue-pipeline/core";
import { Prisma, type Issue as IssueRow, type IssueComment as CommentRow } from "@prisma/client";
import { getPrisma } from "./client";

/**
 * Repository functions for tracker state. Everything is keyed by
 * {repoOwner, repoName, number} -- the same triple the workflows carry --
 * and returns the pure record shapes from @issue-pipeline/core, so callers
 * (activities, the web backend) never see Prisma types.
 */

type IssueRowWithParent = IssueRow & { parent: { number: number } | null };

const PARENT_NUMBER_INCLUDE = { parent: { select: { number: true } } } as const;

function toAuthorKind(raw: string): CommentAuthorKind {
  return raw === "agent" || raw === "human" ? raw : "pipeline";
}

function toTrackerIssue(row: IssueRowWithParent): TrackerIssue {
  return {
    id: row.id,
    repoOwner: row.repoOwner,
    repoName: row.repoName,
    number: row.number,
    title: row.title,
    body: row.body,
    state: row.state === "closed" ? "closed" : "open",
    labels: row.labels,
    parentNumber: row.parent?.number ?? null,
    phase: row.phase,
    baseBranch: row.baseBranch,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    closedAt: row.closedAt?.toISOString() ?? null,
  };
}

function toTrackerComment(row: CommentRow): TrackerComment {
  return {
    id: row.id,
    author: row.author,
    authorKind: toAuthorKind(row.authorKind),
    body: row.body,
    createdAt: row.createdAt.toISOString(),
  };
}

function whereKey(key: IssueKey) {
  return {
    repoOwner_repoName_number: {
      repoOwner: key.repoOwner,
      repoName: key.repoName,
      number: key.number,
    },
  };
}

function isUniqueViolation(err: unknown): boolean {
  return err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002";
}

async function requireIssueRow(key: IssueKey): Promise<IssueRowWithParent> {
  const row = await getPrisma().issue.findUnique({ where: whereKey(key), include: PARENT_NUMBER_INCLUDE });
  if (!row) {
    throw new TrackerIssueNotFoundError(
      `No tracker issue ${formatIssueRef(key)} -- create it first (web UI "New issue" or POST /api/issues).`,
      formatIssueRef(key),
    );
  }
  return row;
}

export async function getIssue(key: IssueKey): Promise<TrackerIssue | null> {
  const row = await getPrisma().issue.findUnique({ where: whereKey(key), include: PARENT_NUMBER_INCLUDE });
  return row ? toTrackerIssue(row) : null;
}

export interface CreateRootIssueInput {
  repoOwner: string;
  repoName: string;
  title: string;
  body: string;
  labels?: string[];
}

export interface CreateSubIssueInput {
  parent: IssueKey;
  /** 1-based phase index. */
  phase: number;
  title: string;
  body: string;
  baseBranch: string;
}

// Numbers are allocated as max+1 inside a create that can lose a race; the
// (repoOwner, repoName, number) unique constraint turns the race into a
// retriable P2002 rather than a duplicate number. Contention is a single
// worker plus the web backend, so a handful of retries is plenty.
const NUMBER_ALLOCATION_ATTEMPTS = 5;

async function createIssueWithAllocatedNumber(
  data: Omit<Prisma.IssueUncheckedCreateInput, "number">,
  repoOwner: string,
  repoName: string,
  findExisting: (() => Promise<IssueRowWithParent | null>) | null,
): Promise<TrackerIssue> {
  const prisma = getPrisma();
  for (let attempt = 0; attempt < NUMBER_ALLOCATION_ATTEMPTS; attempt++) {
    const max = await prisma.issue.aggregate({ where: { repoOwner, repoName }, _max: { number: true } });
    const number = (max._max.number ?? 0) + 1;
    try {
      const row = await prisma.issue.create({
        data: { ...data, number },
        include: PARENT_NUMBER_INCLUDE,
      });
      return toTrackerIssue(row);
    } catch (err) {
      if (!isUniqueViolation(err)) throw err;
      // Two unique constraints can fire: (parentId, phase) means this
      // sub-issue already exists (return it -- idempotent create); the
      // number constraint means a concurrent insert took the number
      // (reallocate and retry).
      if (findExisting) {
        const existing = await findExisting();
        if (existing) return toTrackerIssue(existing);
      }
    }
  }
  throw new Error(
    `Could not allocate an issue number for ${repoOwner}/${repoName} after ${NUMBER_ALLOCATION_ATTEMPTS} attempts.`,
  );
}

export async function createRootIssue(input: CreateRootIssueInput): Promise<TrackerIssue> {
  return createIssueWithAllocatedNumber(
    {
      repoOwner: input.repoOwner,
      repoName: input.repoName,
      title: input.title,
      body: input.body,
      labels: input.labels ?? [],
    },
    input.repoOwner,
    input.repoName,
    null,
  );
}

/** Idempotent on (parent, phase): re-creating an existing phase sub-issue returns the existing row. */
export async function createSubIssue(input: CreateSubIssueInput): Promise<TrackerIssue> {
  const prisma = getPrisma();
  const parentRow = await requireIssueRow(input.parent);

  const findExisting = () =>
    prisma.issue.findFirst({
      where: { parentId: parentRow.id, phase: input.phase },
      include: PARENT_NUMBER_INCLUDE,
    });

  const existing = await findExisting();
  if (existing) return toTrackerIssue(existing);

  return createIssueWithAllocatedNumber(
    {
      repoOwner: input.parent.repoOwner,
      repoName: input.parent.repoName,
      title: input.title,
      body: input.body,
      parentId: parentRow.id,
      phase: input.phase,
      baseBranch: input.baseBranch,
    },
    input.parent.repoOwner,
    input.parent.repoName,
    findExisting,
  );
}

export interface RootIssueSummary {
  issue: TrackerIssue;
  subIssuesTotal: number;
  subIssuesClosed: number;
}

export async function listRootIssues(limit = 100): Promise<RootIssueSummary[]> {
  const rows = await getPrisma().issue.findMany({
    where: { parentId: null },
    orderBy: { updatedAt: "desc" },
    take: limit,
    include: { subIssues: { select: { state: true } } },
  });
  return rows.map((row) => ({
    issue: toTrackerIssue({ ...row, parent: null }),
    subIssuesTotal: row.subIssues.length,
    subIssuesClosed: row.subIssues.filter((s) => s.state === "closed").length,
  }));
}

export async function listSubIssues(parent: IssueKey): Promise<TrackerIssue[]> {
  const parentRow = await requireIssueRow(parent);
  const rows = await getPrisma().issue.findMany({
    where: { parentId: parentRow.id },
    orderBy: { phase: "asc" },
  });
  return rows.map((row) => toTrackerIssue({ ...row, parent: { number: parentRow.number } }));
}

export interface AddCommentInput {
  author: string;
  authorKind: CommentAuthorKind;
  body: string;
}

/**
 * Returns the issue alongside the comment: callers that mirror the write to
 * an external tracker need the full issue snapshot for the sync event.
 * Also bumps the issue's updatedAt so "recently active" orderings reflect
 * comment activity, not just field edits.
 */
export async function addComment(
  key: IssueKey,
  input: AddCommentInput,
): Promise<{ issue: TrackerIssue; comment: TrackerComment }> {
  const prisma = getPrisma();
  const row = await requireIssueRow(key);
  const [comment, updated] = await prisma.$transaction([
    prisma.issueComment.create({
      data: { issueId: row.id, author: input.author, authorKind: input.authorKind, body: input.body },
    }),
    prisma.issue.update({ where: { id: row.id }, data: {}, include: PARENT_NUMBER_INCLUDE }),
  ]);
  return { issue: toTrackerIssue(updated), comment: toTrackerComment(comment) };
}

export async function listComments(key: IssueKey): Promise<TrackerComment[]> {
  const row = await requireIssueRow(key);
  const rows = await getPrisma().issueComment.findMany({
    where: { issueId: row.id },
    orderBy: { createdAt: "asc" },
  });
  return rows.map(toTrackerComment);
}

export async function addLabels(key: IssueKey, labels: string[]): Promise<TrackerIssue> {
  const row = await requireIssueRow(key);
  const merged = [...new Set([...row.labels, ...labels])];
  if (merged.length === row.labels.length) return toTrackerIssue(row);
  const updated = await getPrisma().issue.update({
    where: { id: row.id },
    data: { labels: merged },
    include: PARENT_NUMBER_INCLUDE,
  });
  return toTrackerIssue(updated);
}

export async function removeLabels(key: IssueKey, labels: string[]): Promise<TrackerIssue> {
  const row = await requireIssueRow(key);
  const remaining = row.labels.filter((l) => !labels.includes(l));
  if (remaining.length === row.labels.length) return toTrackerIssue(row);
  const updated = await getPrisma().issue.update({
    where: { id: row.id },
    data: { labels: remaining },
    include: PARENT_NUMBER_INCLUDE,
  });
  return toTrackerIssue(updated);
}

/** Idempotent: closing a closed issue returns it unchanged (closedAt keeps its first value). */
export async function closeIssue(key: IssueKey): Promise<TrackerIssue> {
  const row = await requireIssueRow(key);
  if (row.state === "closed") return toTrackerIssue(row);
  const updated = await getPrisma().issue.update({
    where: { id: row.id },
    data: { state: "closed", closedAt: new Date() },
    include: PARENT_NUMBER_INCLUDE,
  });
  return toTrackerIssue(updated);
}

export interface IssueMirrorRef {
  externalNumber: number;
  externalUrl: string;
}

export async function getIssueMirror(issueId: string, provider: string): Promise<IssueMirrorRef | null> {
  const row = await getPrisma().issueMirror.findUnique({
    where: { issueId_provider: { issueId, provider } },
  });
  return row ? { externalNumber: row.externalNumber, externalUrl: row.externalUrl } : null;
}

export async function saveIssueMirror(
  issueId: string,
  provider: string,
  mirror: IssueMirrorRef,
): Promise<void> {
  await getPrisma().issueMirror.upsert({
    where: { issueId_provider: { issueId, provider } },
    create: { issueId, provider, ...mirror },
    update: { ...mirror },
  });
}
