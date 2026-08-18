import { parseIssueRef, type AnswerItem, type IssueKey, type IssueRef } from "@issue-pipeline/core";

/**
 * Request validation for the pipeline endpoints, kept free of Temporal and
 * fs imports so it can be unit-tested in isolation. Everything here guards
 * signals that mutate a running workflow, so unknown shapes are rejected
 * rather than coerced.
 */

export type ParseResult<T> = { ok: true; value: T } | { ok: false; error: string };

/** Matches the ids this pipeline generates (pipeline-<owner>-<repo>-<n>);
 * the charset cap also keeps ids sane to echo back in error messages. */
export const WORKFLOW_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,255}$/;

const MAX_ANSWERS = 20;
const MAX_ANSWER_CHARS = 10_000;
const MAX_NOTE_CHARS = 2_000;

export const CONTROL_ACTIONS = ["resume", "skip", "abort"] as const;
export type ControlAction = (typeof CONTROL_ACTIONS)[number];

export interface AnswerRequest {
  workflowId: string;
  answers: AnswerItem[];
}

export interface ControlRequest {
  workflowId: string;
  action: ControlAction;
  note?: string;
}

function asRecord(body: unknown): Record<string, unknown> | null {
  return body !== null && typeof body === "object" && !Array.isArray(body) ? (body as Record<string, unknown>) : null;
}

function parseWorkflowId(record: Record<string, unknown>): ParseResult<string> {
  const id = record.workflowId;
  if (typeof id !== "string" || !WORKFLOW_ID_RE.test(id)) {
    return { ok: false, error: "workflowId must be a workflow id string" };
  }
  return { ok: true, value: id };
}

export function parseAnswerRequest(body: unknown): ParseResult<AnswerRequest> {
  const record = asRecord(body);
  if (!record) return { ok: false, error: "body must be a JSON object" };
  const workflowId = parseWorkflowId(record);
  if (!workflowId.ok) return workflowId;

  const rawAnswers = record.answers;
  if (!Array.isArray(rawAnswers) || rawAnswers.length === 0 || rawAnswers.length > MAX_ANSWERS) {
    return { ok: false, error: `answers must be a non-empty array of at most ${MAX_ANSWERS} items` };
  }
  const answers: AnswerItem[] = [];
  for (const raw of rawAnswers) {
    const item = asRecord(raw);
    if (!item) return { ok: false, error: "each answer must be an object" };
    const index = item.index;
    if (typeof index !== "number" || !Number.isInteger(index) || index < 1) {
      return { ok: false, error: "answer.index must be a positive integer (1-based question number)" };
    }
    const text = item.text;
    if (typeof text !== "string" || text.trim() === "") {
      return { ok: false, error: `answer.text for question ${index} must be a non-empty string` };
    }
    if (text.length > MAX_ANSWER_CHARS) {
      return { ok: false, error: `answer.text for question ${index} exceeds ${MAX_ANSWER_CHARS} characters` };
    }
    answers.push({ index, text: text.trim() });
  }
  return { ok: true, value: { workflowId: workflowId.value, answers } };
}

export interface StartRequest {
  ref: IssueRef;
}

/** Accepts { issueRef: "owner/repo#123" } -- a tracker issue number. */
export function parseStartRequest(body: unknown): ParseResult<StartRequest> {
  const record = asRecord(body);
  if (!record) return { ok: false, error: "body must be a JSON object" };
  const issueRef = record.issueRef;
  if (typeof issueRef !== "string" || issueRef.trim() === "" || issueRef.length > 500) {
    return { ok: false, error: "issueRef must be owner/repo#123 (a tracker issue number)" };
  }
  try {
    return { ok: true, value: { ref: parseIssueRef(issueRef) } };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

/** "owner/name" as stored on tracker issues; also a path-safety guard, since
 * the pieces are echoed into database queries and error messages. */
export const REPO_SLUG_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*\/[A-Za-z0-9][A-Za-z0-9._-]*$/;

const MAX_TITLE_CHARS = 300;
const MAX_ISSUE_BODY_CHARS = 60_000;

function parseRepoSlug(raw: unknown): ParseResult<{ owner: string; name: string }> {
  if (typeof raw !== "string" || !REPO_SLUG_RE.test(raw)) {
    return { ok: false, error: "repo must be an owner/name slug" };
  }
  const [owner, name] = raw.split("/");
  return { ok: true, value: { owner, name } };
}

export interface CreateIssueRequest {
  repoSlug: string;
  title: string;
  body: string;
}

/** Accepts { repo: "owner/name", title, body? } for POST /api/issues. */
export function parseCreateIssueRequest(body: unknown): ParseResult<CreateIssueRequest> {
  const record = asRecord(body);
  if (!record) return { ok: false, error: "body must be a JSON object" };
  const repo = parseRepoSlug(record.repo);
  if (!repo.ok) return repo;
  const title = record.title;
  if (typeof title !== "string" || title.trim() === "" || title.length > MAX_TITLE_CHARS) {
    return { ok: false, error: `title must be a non-empty string of at most ${MAX_TITLE_CHARS} characters` };
  }
  const rawBody = record.body ?? "";
  if (typeof rawBody !== "string" || rawBody.length > MAX_ISSUE_BODY_CHARS) {
    return { ok: false, error: `body must be a string of at most ${MAX_ISSUE_BODY_CHARS} characters` };
  }
  return {
    ok: true,
    value: { repoSlug: `${repo.value.owner}/${repo.value.name}`, title: title.trim(), body: rawBody },
  };
}

export interface IssueCommentRequest {
  key: IssueKey;
  body: string;
}

/** Accepts { repo: "owner/name", number, body } for POST /api/issue/comment. */
export function parseIssueCommentRequest(body: unknown): ParseResult<IssueCommentRequest> {
  const record = asRecord(body);
  if (!record) return { ok: false, error: "body must be a JSON object" };
  const repo = parseRepoSlug(record.repo);
  if (!repo.ok) return repo;
  const number = record.number;
  if (typeof number !== "number" || !Number.isInteger(number) || number < 1) {
    return { ok: false, error: "number must be a positive integer (tracker issue number)" };
  }
  const text = record.body;
  if (typeof text !== "string" || text.trim() === "" || text.length > MAX_ISSUE_BODY_CHARS) {
    return { ok: false, error: `body must be a non-empty string of at most ${MAX_ISSUE_BODY_CHARS} characters` };
  }
  return {
    ok: true,
    value: {
      key: { repoOwner: repo.value.owner, repoName: repo.value.name, number },
      body: text,
    },
  };
}

/** Validates the ?repo=owner/name&number=N query params of GET /api/issue. */
export function parseIssueKeyParams(repoRaw: string, numberRaw: string): ParseResult<IssueKey> {
  const repo = parseRepoSlug(repoRaw);
  if (!repo.ok) return repo;
  const number = Number(numberRaw);
  if (!Number.isSafeInteger(number) || number < 1) {
    return { ok: false, error: "number must be a positive integer (tracker issue number)" };
  }
  return { ok: true, value: { repoOwner: repo.value.owner, repoName: repo.value.name, number } };
}

export function parseControlRequest(body: unknown): ParseResult<ControlRequest> {
  const record = asRecord(body);
  if (!record) return { ok: false, error: "body must be a JSON object" };
  const workflowId = parseWorkflowId(record);
  if (!workflowId.ok) return workflowId;

  const action = record.action;
  if (typeof action !== "string" || !CONTROL_ACTIONS.includes(action as ControlAction)) {
    return { ok: false, error: `action must be one of: ${CONTROL_ACTIONS.join(", ")}` };
  }
  const note = record.note;
  if (note !== undefined && typeof note !== "string") {
    return { ok: false, error: "note must be a string when present" };
  }
  if (typeof note === "string" && note.length > MAX_NOTE_CHARS) {
    return { ok: false, error: `note exceeds ${MAX_NOTE_CHARS} characters` };
  }
  const trimmed = typeof note === "string" && note.trim() !== "" ? note.trim() : undefined;
  return { ok: true, value: { workflowId: workflowId.value, action: action as ControlAction, note: trimmed } };
}
