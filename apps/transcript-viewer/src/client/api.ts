import type { ProjectSummary, SessionChunk, SessionSummary } from "../shared/types";

async function getJson<T>(url: string): Promise<T> {
  const res = await fetch(url);
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
