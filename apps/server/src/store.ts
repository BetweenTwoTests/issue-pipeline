import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { ProjectSummary, SessionChunk, SessionSummary } from "./types";
import { parseLines } from "./transcript";

/**
 * Read-only access to Claude Code's session store. Every function takes the
 * store root explicitly so tests can point it at a fixture directory.
 */

export const SESSION_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SESSION_FILE_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.jsonl$/i;

/**
 * Project directory names are cwd paths with separators flattened to "-".
 * The shape check is the path-traversal guard: a name is used as a single
 * directory segment under the store root, so it must never contain a path
 * separator or be a relative marker.
 */
export function isValidProjectName(name: string): boolean {
  return /^[A-Za-z0-9._-]{1,300}$/.test(name) && name !== "." && name !== "..";
}

export function defaultRoot(): string {
  return path.join(os.homedir(), ".claude", "projects");
}

const NL = 0x0a;
/** Head/tail window scanned when summarizing a session without reading all of it. */
const SUMMARY_WINDOW_BYTES = 64 * 1024;

async function statOrNull(p: string): Promise<{ size: number; mtimeMs: number } | null> {
  try {
    const st = await fs.stat(p);
    return { size: st.size, mtimeMs: st.mtimeMs };
  } catch {
    return null;
  }
}

async function readBytes(filePath: string, from: number, length: number): Promise<Buffer> {
  const handle = await fs.open(filePath, "r");
  try {
    const buffer = Buffer.alloc(length);
    const { bytesRead } = await handle.read(buffer, 0, length, from);
    return buffer.subarray(0, bytesRead);
  } finally {
    await handle.close();
  }
}

/** Cache of expensive per-file summaries, invalidated by size+mtime. */
const summaryCache = new Map<string, { key: string; summary: SessionSummary }>();
const cwdHintCache = new Map<string, { key: string; cwd: string | null }>();

function pruneCache(cache: Map<string, unknown>): void {
  if (cache.size > 2000) cache.clear();
}

/** First `cwd` recorded in a transcript, for display; null if none found early. */
async function readCwdHint(filePath: string, cacheKey: string): Promise<string | null> {
  const cached = cwdHintCache.get(filePath);
  if (cached && cached.key === cacheKey) return cached.cwd;
  let cwd: string | null = null;
  try {
    const head = await readBytes(filePath, 0, 16 * 1024);
    for (const line of head.toString("utf8").split("\n")) {
      const trimmed = line.trim();
      if (trimmed === "") continue;
      try {
        const obj = JSON.parse(trimmed) as { cwd?: unknown };
        if (typeof obj.cwd === "string" && obj.cwd !== "") {
          cwd = obj.cwd;
          break;
        }
      } catch {
        // torn line inside the head window -- keep scanning
      }
    }
  } catch {
    cwd = null;
  }
  pruneCache(cwdHintCache);
  cwdHintCache.set(filePath, { key: cacheKey, cwd });
  return cwd;
}

export async function listProjects(root: string): Promise<ProjectSummary[]> {
  let entries;
  try {
    entries = await fs.readdir(root, { withFileTypes: true });
  } catch {
    return [];
  }
  const projects: ProjectSummary[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || !isValidProjectName(entry.name)) continue;
    const dirPath = path.join(root, entry.name);
    let files: string[];
    try {
      files = await fs.readdir(dirPath);
    } catch {
      continue;
    }
    const sessionFiles = files.filter((f) => SESSION_FILE_RE.test(f));
    if (sessionFiles.length === 0) continue;

    let lastMtimeMs = 0;
    let newest: { path: string; key: string } | null = null;
    for (const file of sessionFiles) {
      const filePath = path.join(dirPath, file);
      const st = await statOrNull(filePath);
      if (st && st.mtimeMs >= lastMtimeMs) {
        lastMtimeMs = st.mtimeMs;
        newest = { path: filePath, key: `${st.size}:${st.mtimeMs}` };
      }
    }
    projects.push({
      name: entry.name,
      sessionCount: sessionFiles.length,
      lastModified: lastMtimeMs > 0 ? new Date(lastMtimeMs).toISOString() : null,
      displayPath: newest ? await readCwdHint(newest.path, newest.key) : null,
    });
  }
  projects.sort((a, b) => (b.lastModified ?? "").localeCompare(a.lastModified ?? ""));
  return projects;
}

function previewLine(s: string, max = 140): string {
  const flat = s.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

interface ScannedTitles {
  aiTitle: string | null;
  customTitle: string | null;
}

function scanTitles(lines: string[]): ScannedTitles {
  let aiTitle: string | null = null;
  let customTitle: string | null = null;
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed === "") continue;
    // Cheap substring pre-filter; title lines are rare.
    if (!trimmed.includes('"ai-title"') && !trimmed.includes('"custom-title"')) continue;
    try {
      const obj = JSON.parse(trimmed) as { type?: string; aiTitle?: unknown; customTitle?: unknown };
      if (obj.type === "ai-title" && typeof obj.aiTitle === "string") aiTitle = obj.aiTitle;
      if (obj.type === "custom-title" && typeof obj.customTitle === "string") customTitle = obj.customTitle;
    } catch {
      // torn line inside a scan window
    }
  }
  return { aiTitle, customTitle };
}

/**
 * Builds a session summary from the file's head and tail windows only, so
 * listing a project with hundreds of large transcripts stays fast. Titles
 * are appended near the end of the file as they are (re)generated, so the
 * tail window sees the latest one.
 */
async function buildSummary(
  filePath: string,
  id: string,
  st: { size: number; mtimeMs: number },
): Promise<SessionSummary> {
  const head = await readBytes(filePath, 0, Math.min(st.size, SUMMARY_WINDOW_BYTES));
  const headLines = head.toString("utf8").split("\n");
  // Drop the final element: past the window it is a torn line, and on a
  // newline-terminated boundary it is empty anyway.
  if (head.length < st.size) headLines.pop();

  let firstPrompt: string | null = null;
  let startedAt: string | null = null;
  let gitBranch: string | null = null;
  let sidechain = false;
  let sawEntry = false;
  let titles = scanTitles(headLines);

  for (const line of headLines) {
    const trimmed = line.trim();
    if (trimmed === "") continue;
    let obj: {
      type?: string;
      timestamp?: string;
      isSidechain?: boolean;
      gitBranch?: string;
      message?: { content?: unknown };
    };
    try {
      obj = JSON.parse(trimmed);
    } catch {
      continue;
    }
    if (obj.type !== "user" && obj.type !== "assistant") continue;
    if (!sawEntry) {
      sawEntry = true;
      sidechain = obj.isSidechain === true;
    }
    if (startedAt === null && typeof obj.timestamp === "string") startedAt = obj.timestamp;
    if (gitBranch === null && typeof obj.gitBranch === "string") gitBranch = obj.gitBranch;
    if (firstPrompt === null && obj.type === "user" && typeof obj.message?.content === "string") {
      // Slash-command records ("<command-name>...") are bookkeeping, not the
      // user's own words -- keep scanning for a real prompt.
      if (!obj.message.content.startsWith("<")) firstPrompt = previewLine(obj.message.content);
    }
    if (firstPrompt !== null && startedAt !== null && gitBranch !== null) break;
  }

  if (st.size > head.length) {
    const tailFrom = Math.max(head.length, st.size - SUMMARY_WINDOW_BYTES);
    const tail = await readBytes(filePath, tailFrom, st.size - tailFrom);
    const tailLines = tail.toString("utf8").split("\n");
    tailLines.shift(); // torn first line: the window starts mid-line
    const tailTitles = scanTitles(tailLines);
    titles = {
      aiTitle: tailTitles.aiTitle ?? titles.aiTitle,
      customTitle: tailTitles.customTitle ?? titles.customTitle,
    };
  }

  return {
    id,
    title: titles.customTitle ?? titles.aiTitle ?? null,
    firstPrompt,
    startedAt,
    modifiedAt: new Date(st.mtimeMs).toISOString(),
    sizeBytes: st.size,
    gitBranch,
    sidechain,
  };
}

export async function listSessions(root: string, project: string): Promise<SessionSummary[]> {
  if (!isValidProjectName(project)) throw new Error(`invalid project name: ${project}`);
  const dirPath = path.join(root, project);
  const files = await fs.readdir(dirPath);
  const sessions: SessionSummary[] = [];
  for (const file of files) {
    if (!SESSION_FILE_RE.test(file)) continue;
    const filePath = path.join(dirPath, file);
    const st = await statOrNull(filePath);
    if (!st) continue;
    const id = file.slice(0, -".jsonl".length).toLowerCase();
    const key = `${st.size}:${st.mtimeMs}`;
    const cached = summaryCache.get(filePath);
    if (cached && cached.key === key) {
      sessions.push(cached.summary);
      continue;
    }
    const summary = await buildSummary(filePath, id, st);
    pruneCache(summaryCache);
    summaryCache.set(filePath, { key, summary });
    sessions.push(summary);
  }
  sessions.sort((a, b) => b.modifiedAt.localeCompare(a.modifiedAt));
  return sessions;
}

/**
 * Reads and parses the transcript from `fromOffset` (bytes) to the end of
 * the file, returning the offset to resume from. Only complete lines are
 * consumed: a torn trailing line (a write in progress) is held back until
 * the next poll -- unless it already parses as complete JSON, which means
 * the writer simply hasn't terminated the final line with a newline.
 * Newlines are single-byte in UTF-8 and never part of a multi-byte
 * sequence, so slicing at newline boundaries is encoding-safe.
 */
export async function readSessionChunk(
  root: string,
  project: string,
  id: string,
  fromOffset: number,
): Promise<SessionChunk> {
  if (!isValidProjectName(project)) throw new Error(`invalid project name: ${project}`);
  if (!SESSION_ID_RE.test(id)) throw new Error(`invalid session id: ${id}`);
  const filePath = path.join(root, project, `${id}.jsonl`);

  const st = await fs.stat(filePath);
  let from = fromOffset;
  let reset = false;
  if (from > st.size) {
    // The file shrank (replaced or truncated) -- restart from the top.
    from = 0;
    reset = true;
  }

  const empty: SessionChunk = {
    events: [],
    aiTitle: null,
    customTitle: null,
    meta: { cwd: null, gitBranch: null, version: null, slug: null },
    malformedLines: 0,
    offset: from,
    fileSize: st.size,
    reset,
  };
  if (from === st.size) return empty;

  const buffer = await readBytes(filePath, from, st.size - from);
  const lastNewline = buffer.lastIndexOf(NL);
  let consumed = lastNewline + 1; // 0 when no newline in the window
  const lines = consumed > 0 ? buffer.subarray(0, consumed).toString("utf8").split("\n") : [];

  if (consumed < buffer.length) {
    const tailText = buffer.subarray(consumed).toString("utf8");
    try {
      JSON.parse(tailText.trim());
      lines.push(tailText);
      consumed = buffer.length;
    } catch {
      // torn write in progress -- leave it for the next poll
    }
  }

  const chunk = parseLines(lines, String(from));
  return { ...chunk, offset: from + consumed, fileSize: st.size, reset };
}
