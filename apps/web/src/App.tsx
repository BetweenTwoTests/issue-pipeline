import { useCallback, useEffect, useState } from "react";
import type {
  IssueListItem,
  PipelineListItem,
  ProjectSummary,
  RegisteredRepoSummary,
  SessionSummary,
} from "@issue-pipeline/server";
import { createIssue, fetchIssues, fetchPipelines, fetchProjects, fetchRepos, fetchSessions } from "./api";
import { formatBytes, formatWhen, shortHome } from "./format";
import { IssueView } from "./IssueView";
import { PipelineView, statusClass, statusLabel } from "./PipelineView";
import { buildHash, issueHash, parseHash, parseIssueRoute, type Route } from "./routes";
import { TranscriptView } from "./TranscriptView";

const PROJECTS_POLL_MS = 30_000;
const SESSIONS_POLL_MS = 5_000;
const PIPELINES_POLL_MS = 8_000;
const ISSUES_POLL_MS = 5_000;

function projectLabel(p: ProjectSummary): string {
  return shortHome(p.displayPath) ?? p.name;
}

/** Inline "New issue" form: repo picker from pipeline.yaml, title, plan body. */
function NewIssueForm({ onCreated, onCancel }: { onCreated: (issue: IssueListItem["issue"]) => void; onCancel: () => void }) {
  const [repos, setRepos] = useState<RegisteredRepoSummary[] | null>(null);
  const [repoSlug, setRepoSlug] = useState("");
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    fetchRepos()
      .then((loaded) => {
        if (cancelled) return;
        setRepos(loaded);
        if (loaded.length > 0) setRepoSlug((current) => current || `${loaded[0].owner}/${loaded[0].repo}`);
      })
      .catch((err) => {
        if (!cancelled) setError(err instanceof Error ? err.message : String(err));
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const submit = async (): Promise<void> => {
    if (busy || repoSlug === "" || title.trim() === "") return;
    setBusy(true);
    setError(null);
    try {
      const issue = await createIssue(repoSlug, title.trim(), body);
      onCreated(issue);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <form
      className="new-issue-form"
      onSubmit={(e) => {
        e.preventDefault();
        void submit();
      }}
    >
      <select value={repoSlug} onChange={(e) => setRepoSlug(e.target.value)} disabled={!repos}>
        <option value="" disabled>
          {repos ? "Repo…" : "Loading repos…"}
        </option>
        {(repos ?? []).map((r) => (
          <option key={r.name} value={`${r.owner}/${r.repo}`}>
            {r.owner}/{r.repo}
          </option>
        ))}
      </select>
      <input value={title} placeholder="Title" onChange={(e) => setTitle(e.target.value)} />
      <textarea
        rows={6}
        value={body}
        placeholder="The plan (markdown). This is what the planner decomposes into phases."
        onChange={(e) => setBody(e.target.value)}
      />
      {error ? <div className="notice notice-error">{error}</div> : null}
      <div className="pipe-actions">
        <button className="btn btn-primary" type="submit" disabled={busy || title.trim() === "" || repoSlug === ""}>
          Create issue
        </button>
        <button className="btn" type="button" onClick={onCancel}>
          Cancel
        </button>
      </div>
    </form>
  );
}

export default function App() {
  const [projects, setProjects] = useState<ProjectSummary[] | null>(null);
  const [projectsError, setProjectsError] = useState<string | null>(null);
  const [sessions, setSessions] = useState<SessionSummary[] | null>(null);
  const [sessionsError, setSessionsError] = useState<string | null>(null);
  const [pipelines, setPipelines] = useState<PipelineListItem[]>([]);
  const [pipelinesError, setPipelinesError] = useState<string | null>(null);
  const [issues, setIssues] = useState<IssueListItem[]>([]);
  const [issuesError, setIssuesError] = useState<string | null>(null);
  const [showNewIssue, setShowNewIssue] = useState(false);
  const [route, setRoute] = useState<Route>(() => parseHash());

  useEffect(() => {
    const onHashChange = () => setRoute(parseHash());
    window.addEventListener("hashchange", onHashChange);
    return () => window.removeEventListener("hashchange", onHashChange);
  }, []);

  const navigate = useCallback((project: string | null, session: string | null, replace = false) => {
    const hash = buildHash({ project, session });
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

  const loadPipelines = useCallback(async () => {
    try {
      const loaded = await fetchPipelines();
      setPipelines(loaded);
      setPipelinesError(null);
    } catch (err) {
      setPipelinesError(err instanceof Error ? err.message : String(err));
    }
  }, []);

  useEffect(() => {
    void loadPipelines();
    const interval = setInterval(() => void loadPipelines(), PIPELINES_POLL_MS);
    return () => clearInterval(interval);
  }, [loadPipelines]);

  const loadIssues = useCallback(async () => {
    try {
      const loaded = await fetchIssues();
      setIssues(loaded);
      setIssuesError(null);
    } catch (err) {
      setIssuesError(err instanceof Error ? err.message : String(err));
    }
  }, []);

  useEffect(() => {
    void loadIssues();
    const interval = setInterval(() => void loadIssues(), ISSUES_POLL_MS);
    return () => clearInterval(interval);
  }, [loadIssues]);

  // Landing with nothing selected jumps to the most recently active project.
  useEffect(() => {
    if (route.project === null && route.workflow === null && route.issue === null && projects && projects.length > 0) {
      navigate(projects[0].name, null, true);
    }
  }, [route.project, route.workflow, route.issue, projects, navigate]);

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
  const issueRoute = route.issue ? parseIssueRoute(route.issue) : null;

  return (
    <div className="app">
      <aside className="sidebar">
        <header className="sidebar-head">
          <h1>issue-pipeline</h1>
        </header>
        <div className="pipelines-section">
          <div className="section-title">
            Issues
            <button className="btn btn-small" onClick={() => setShowNewIssue((v) => !v)}>
              {showNewIssue ? "Close" : "New issue"}
            </button>
          </div>
          {showNewIssue ? (
            <NewIssueForm
              onCreated={(issue) => {
                setShowNewIssue(false);
                void loadIssues();
                window.location.hash = issueHash(issue.repoOwner, issue.repoName, issue.number);
              }}
              onCancel={() => setShowNewIssue(false)}
            />
          ) : null}
          {issuesError ? <div className="notice notice-error">{issuesError}</div> : null}
          {issues.map((item) => {
            const key = `${item.issue.repoOwner}/${item.issue.repoName}/${item.issue.number}`;
            return (
              <a
                key={item.issue.id}
                className={`session-item${route.issue === key ? " selected" : ""}`}
                href={issueHash(item.issue.repoOwner, item.issue.repoName, item.issue.number)}
              >
                <span className="session-title">
                  {item.issue.title}{" "}
                  <span className={`badge badge-${item.issue.state === "open" ? "open" : "closed"}`}>
                    {item.issue.state}
                  </span>
                </span>
                <span className="session-sub">
                  {item.issue.repoOwner}/{item.issue.repoName}#{item.issue.number}
                  {item.subIssuesTotal > 0 ? ` · ${item.subIssuesClosed}/${item.subIssuesTotal} phases` : ""}
                  {" · "}
                  {formatWhen(item.issue.updatedAt)}
                </span>
              </a>
            );
          })}
          {issues.length === 0 && !issuesError ? (
            <div className="notice">No issues yet — create one to run a pipeline.</div>
          ) : null}
        </div>
        <div className="pipelines-section">
          <div className="section-title">Pipelines</div>
          {pipelinesError ? <div className="notice notice-error">{pipelinesError}</div> : null}
          {pipelines.map((p) => {
            const label = statusLabel(p);
            return (
              <button
                key={p.workflowId}
                className={`session-item${p.workflowId === route.workflow ? " selected" : ""}`}
                onClick={() => {
                  window.location.hash = buildHash({ project: route.project, session: route.session, workflow: p.workflowId });
                }}
              >
                <span className="session-title">
                  {p.plan ? `${p.plan.owner}/${p.plan.repo}#${p.plan.issueNumber}` : p.workflowId}{" "}
                  <span className={`badge badge-${statusClass(label.replaceAll(" ", "_"))}`}>{label}</span>
                </span>
                <span className="session-sub">started {formatWhen(p.startTime)}</span>
              </button>
            );
          })}
        </div>
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
              className={`session-item${s.id === route.session && !route.workflow && !route.issue ? " selected" : ""}`}
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
        {issueRoute ? (
          <IssueView
            key={route.issue}
            repoOwner={issueRoute.repoOwner}
            repoName={issueRoute.repoName}
            number={issueRoute.number}
          />
        ) : route.workflow ? (
          <PipelineView key={route.workflow} workflowId={route.workflow} />
        ) : route.project && route.session ? (
          <TranscriptView
            key={`${route.project}/${route.session}`}
            project={route.project}
            sessionId={route.session}
            summary={selectedSummary}
          />
        ) : (
          <div className="empty-state">
            <p>Select an issue, a pipeline, or a session transcript.</p>
            <p className="empty-hint">
              Issues live in the pipeline&apos;s own database; transcripts come from <code>~/.claude/projects</code>.
            </p>
          </div>
        )}
      </main>
    </div>
  );
}
