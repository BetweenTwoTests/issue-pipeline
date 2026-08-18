import type { PipelineListItem, ProjectSummary, SessionChunk, SessionSummary } from "../shared/types";

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
