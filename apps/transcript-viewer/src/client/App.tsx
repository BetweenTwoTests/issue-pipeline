import { useCallback, useEffect, useState } from "react";
import type { ProjectSummary, SessionSummary } from "../shared/types";
import { fetchProjects, fetchSessions } from "./api";
import { formatBytes, formatWhen, shortHome } from "./format";
import { TranscriptView } from "./TranscriptView";

const PROJECTS_POLL_MS = 30_000;
const SESSIONS_POLL_MS = 5_000;

interface Route {
  project: string | null;
  session: string | null;
}

function parseHash(): Route {
  const params = new URLSearchParams(window.location.hash.replace(/^#/, ""));
  return { project: params.get("p"), session: params.get("s") };
}

function buildHash(project: string | null, session: string | null): string {
  const params = new URLSearchParams();
  if (project) params.set("p", project);
  if (session) params.set("s", session);
  return `#${params.toString()}`;
}

function projectLabel(p: ProjectSummary): string {
  return shortHome(p.displayPath) ?? p.name;
}

export default function App() {
  const [projects, setProjects] = useState<ProjectSummary[] | null>(null);
  const [projectsError, setProjectsError] = useState<string | null>(null);
  const [sessions, setSessions] = useState<SessionSummary[] | null>(null);
  const [sessionsError, setSessionsError] = useState<string | null>(null);
  const [route, setRoute] = useState<Route>(() => parseHash());

  useEffect(() => {
    const onHashChange = () => setRoute(parseHash());
    window.addEventListener("hashchange", onHashChange);
    return () => window.removeEventListener("hashchange", onHashChange);
  }, []);

  const navigate = useCallback((project: string | null, session: string | null, replace = false) => {
    const hash = buildHash(project, session);
    if (replace) {
      window.history.replaceState(null, "", hash);
      setRoute(parseHash());
    } else {
      window.location.hash = hash;
    }
  }, []);

  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      try {
        const loaded = await fetchProjects();
        if (!cancelled) {
          setProjects(loaded);
          setProjectsError(null);
        }
      } catch (err) {
        if (!cancelled) setProjectsError(err instanceof Error ? err.message : String(err));
      }
    };
    void load();
    const interval = setInterval(() => void load(), PROJECTS_POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, []);

  // Landing with no project selected jumps to the most recently active one.
  useEffect(() => {
    if (route.project === null && projects && projects.length > 0) {
      navigate(projects[0].name, null, true);
    }
  }, [route.project, projects, navigate]);

  useEffect(() => {
    setSessions(null);
    setSessionsError(null);
    if (!route.project) return;
    const project = route.project;
    let cancelled = false;
    const load = async () => {
      try {
        const loaded = await fetchSessions(project);
        if (!cancelled) {
          setSessions(loaded);
          setSessionsError(null);
        }
      } catch (err) {
        if (!cancelled) setSessionsError(err instanceof Error ? err.message : String(err));
      }
    };
    void load();
    const interval = setInterval(() => void load(), SESSIONS_POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, [route.project]);

  const selectedSummary = sessions?.find((s) => s.id === route.session) ?? null;

  return (
    <div className="app">
      <aside className="sidebar">
        <header className="sidebar-head">
          <h1>Claude transcripts</h1>
        </header>
        <div className="project-picker">
          {projectsError ? <div className="notice notice-error">{projectsError}</div> : null}
          <select
            value={route.project ?? ""}
            onChange={(e) => navigate(e.target.value || null, null)}
            disabled={!projects}
          >
            <option value="" disabled>
              {projects ? "Select a project…" : "Loading projects…"}
            </option>
            {(projects ?? []).map((p) => (
              <option key={p.name} value={p.name}>
                {projectLabel(p)} ({p.sessionCount})
              </option>
            ))}
          </select>
        </div>
        <div className="session-list">
          {sessionsError ? <div className="notice notice-error">{sessionsError}</div> : null}
          {route.project && !sessions && !sessionsError ? <div className="notice">Loading sessions…</div> : null}
          {(sessions ?? []).map((s) => (
            <button
              key={s.id}
              className={`session-item${s.id === route.session ? " selected" : ""}`}
              onClick={() => navigate(route.project, s.id)}
            >
              <span className="session-title">
                {s.title ?? s.firstPrompt ?? s.id.slice(0, 8)}
                {s.sidechain ? <span className="chip chip-side">subagent</span> : null}
              </span>
              <span className="session-sub">
                {formatWhen(s.modifiedAt)} · {formatBytes(s.sizeBytes)}
                {s.gitBranch ? ` · ⎇ ${s.gitBranch}` : ""}
              </span>
            </button>
          ))}
          {sessions && sessions.length === 0 ? <div className="notice">No sessions in this project.</div> : null}
        </div>
      </aside>
      <main className="main">
        {route.project && route.session ? (
          <TranscriptView
            key={`${route.project}/${route.session}`}
            project={route.project}
            sessionId={route.session}
            summary={selectedSummary}
          />
        ) : (
          <div className="empty-state">
            <p>Select a session to view its transcript.</p>
            <p className="empty-hint">
              Reading from <code>~/.claude/projects</code> — interactive sessions and pipeline agent runs alike.
            </p>
          </div>
        )}
      </main>
    </div>
  );
}
