/**
 * Deep links into the local web app (apps/web) for a Claude Code session
 * transcript. Pure string construction -- callers supply the
 * viewer's base URL (activities read it from PIPELINE_VIEWER_URL), which
 * keeps this importable from workflow code.
 */

/**
 * The directory Claude Code stores a session under
 * (~/.claude/projects/<dir>/<sessionId>.jsonl), derived from the session's
 * cwd by replacing every non-alphanumeric character with "-" (both "/" and
 * "." collapse: "/a/.b" -> "-a--b").
 */
export function claudeProjectDirName(cwd: string): string {
  return cwd.replace(/[^a-zA-Z0-9]/g, "-");
}

/** The viewer's hash route for one session: #p=<project dir>&s=<session id>. */
export function buildTranscriptUrl(viewerBaseUrl: string, cwd: string, sessionId: string): string {
  return `${viewerBaseUrl.replace(/\/+$/, "")}/#p=${claudeProjectDirName(cwd)}&s=${sessionId}`;
}
