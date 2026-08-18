import type {
  IssueDetail,
  IssueListItem,
  PipelineListItem,
  ProjectSummary,
  RegisteredRepoSummary,
  SessionChunk,
  SessionSummary,
  StartPipelineResult,
} from "@issue-pipeline/server";
import type { TrackerComment, TrackerIssue } from "@issue-pipeline/core";

async function parseResponse<T>(res: Response): Promise<T> {
  if (!res.ok) {
    let message = `HTTP ${res.status}`;
    try {
      const body = (await res.json()) as { error?: string };
      if (typeof body.error === "string") message = body.error;
    } catch {
      // non-JSON error body -- keep the status message
    }
    throw new Error(message);
  }
  return (await res.json()) as T;
}

async function getJson<T>(url: string): Promise<T> {
  return parseResponse<T>(await fetch(url));
}

async function postJson<T>(url: string, body: unknown): Promise<T> {
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  return parseResponse<T>(res);
}

export async function fetchProjects(): Promise<ProjectSummary[]> {
  const body = await getJson<{ projects: ProjectSummary[] }>("/api/projects");
  return body.projects;
}

export async function fetchSessions(project: string): Promise<SessionSummary[]> {
  const body = await getJson<{ sessions: SessionSummary[] }>(
    `/api/sessions?project=${encodeURIComponent(project)}`,
  );
  return body.sessions;
}

export async function fetchChunk(project: string, id: string, offset: number): Promise<SessionChunk> {
  return getJson<SessionChunk>(
    `/api/session?project=${encodeURIComponent(project)}&id=${encodeURIComponent(id)}&offset=${offset}`,
  );
}

export async function fetchPipelines(): Promise<PipelineListItem[]> {
  const body = await getJson<{ pipelines: PipelineListItem[] }>("/api/pipelines");
  return body.pipelines;
}

export async function fetchPipeline(workflowId: string): Promise<PipelineListItem> {
  return getJson<PipelineListItem>(`/api/pipeline?id=${encodeURIComponent(workflowId)}`);
}

export async function sendAnswers(workflowId: string, answers: { index: number; text: string }[]): Promise<void> {
  await postJson<{ ok: boolean }>("/api/pipeline/answer", { workflowId, answers });
}

export async function sendControl(workflowId: string, action: "resume" | "skip" | "abort", note?: string): Promise<void> {
  await postJson<{ ok: boolean }>("/api/pipeline/control", { workflowId, action, note });
}

export async function startPipeline(issueRef: string): Promise<StartPipelineResult> {
  return postJson<StartPipelineResult>("/api/pipeline/start", { issueRef });
}

export async function fetchIssues(): Promise<IssueListItem[]> {
  const body = await getJson<{ issues: IssueListItem[] }>("/api/issues");
  return body.issues;
}

export async function fetchIssueDetail(repoSlug: string, number: number): Promise<IssueDetail> {
  return getJson<IssueDetail>(`/api/issue?repo=${encodeURIComponent(repoSlug)}&number=${number}`);
}

export async function fetchRepos(): Promise<RegisteredRepoSummary[]> {
  const body = await getJson<{ repos: RegisteredRepoSummary[] }>("/api/repos");
  return body.repos;
}

export async function createIssue(repoSlug: string, title: string, body: string): Promise<TrackerIssue> {
  const res = await postJson<{ issue: TrackerIssue }>("/api/issues", { repo: repoSlug, title, body });
  return res.issue;
}

export async function addIssueComment(repoSlug: string, number: number, body: string): Promise<TrackerComment> {
  const res = await postJson<{ comment: TrackerComment }>("/api/issue/comment", { repo: repoSlug, number, body });
  return res.comment;
}
