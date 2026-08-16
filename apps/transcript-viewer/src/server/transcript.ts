import type { ParsedChunk, SessionMeta, TranscriptEvent } from "../shared/types";

/**
 * Parser for Claude Code's session transcript files
 * (~/.claude/projects/<cwd-derived-dir>/<sessionId>.jsonl).
 *
 * The format is Claude Code's INTERNAL storage, not a documented API --
 * verified against real files in this machine's session store, but liable
 * to grow new line/block types with any claude release. The parser is
 * therefore deliberately defensive: unknown line types are skipped, unknown
 * content blocks fall back to raw JSON, and a malformed line never aborts
 * the file.
 *
 * Pure (lines in, events out) so it can be unit-tested without fs, and so
 * the store can feed it incremental line batches when live-tailing a
 * still-growing file.
 */

interface ContentBlock {
  type?: string;
  text?: string;
  thinking?: string;
  id?: string;
  name?: string;
  input?: unknown;
  tool_use_id?: string;
  content?: unknown;
  is_error?: boolean;
}

interface TranscriptLine {
  type?: string;
  aiTitle?: string;
  customTitle?: string;
  isSidechain?: boolean;
  agentId?: string;
  uuid?: string;
  timestamp?: string;
  cwd?: string;
  gitBranch?: string;
  version?: string;
  slug?: string;
  message?: {
    role?: string;
    model?: string;
    content?: string | ContentBlock[];
  };
}

const PREVIEW_KEYS = ["command", "file_path", "pattern", "query", "url", "prompt", "description"];
const PREVIEW_MAX = 100;

/**
 * Cap on a single event's text. A pathological multi-megabyte tool result
 * would otherwise dominate the JSON payload and the DOM; anything past the
 * cap is summarized with a truncation marker.
 */
const EVENT_TEXT_MAX = 200_000;

function oneLine(s: string): string {
  const flat = s.replace(/\s+/g, " ").trim();
  return flat.length > PREVIEW_MAX ? `${flat.slice(0, PREVIEW_MAX - 1)}…` : flat;
}

function capText(s: string): string {
  if (s.length <= EVENT_TEXT_MAX) return s;
  return `${s.slice(0, EVENT_TEXT_MAX)}\n… [truncated ${s.length - EVENT_TEXT_MAX} more characters]`;
}

function toolPreview(input: unknown): string {
  if (input && typeof input === "object" && !Array.isArray(input)) {
    const obj = input as Record<string, unknown>;
    for (const key of PREVIEW_KEYS) {
      const value = obj[key];
      if (typeof value === "string" && value.trim() !== "") {
        return oneLine(value);
      }
    }
  }
  try {
    return oneLine(JSON.stringify(input) ?? "");
  } catch {
    return "";
  }
}

/** tool_result content arrives as a plain string OR an array of blocks. */
function stringifyResultContent(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((block: ContentBlock) => {
        if (block && typeof block === "object" && block.type === "text" && typeof block.text === "string") {
          return block.text;
        }
        try {
          return JSON.stringify(block);
        } catch {
          return String(block);
        }
      })
      .join("\n");
  }
  if (content === undefined || content === null) return "";
  try {
    return JSON.stringify(content, null, 2);
  } catch {
    return String(content);
  }
}

/**
 * Parses a batch of JSONL lines. `idNamespace` disambiguates fallback ids
 * for entries without a uuid across successive incremental batches -- the
 * store passes the batch's starting byte offset, which is unique per line
 * and identical when the same bytes are re-read.
 */
export function parseLines(lines: string[], idNamespace = "0"): ParsedChunk {
  const events: TranscriptEvent[] = [];
  let aiTitle: string | null = null;
  let customTitle: string | null = null;
  let malformedLines = 0;
  const meta: SessionMeta = { cwd: null, gitBranch: null, version: null, slug: null };

  lines.forEach((line, lineIndex) => {
    const trimmed = line.trim();
    if (trimmed === "") return;
    let obj: TranscriptLine;
    try {
      obj = JSON.parse(trimmed) as TranscriptLine;
    } catch {
      malformedLines += 1;
      return;
    }

    if (obj.type === "ai-title" && typeof obj.aiTitle === "string") {
      aiTitle = obj.aiTitle;
      return;
    }
    if (obj.type === "custom-title" && typeof obj.customTitle === "string") {
      customTitle = obj.customTitle;
      return;
    }
    // queue-operation, attachment, system, last-prompt, mode, summary, ...
    if (obj.type !== "user" && obj.type !== "assistant") return;

    if (typeof obj.cwd === "string") meta.cwd = obj.cwd;
    if (typeof obj.gitBranch === "string") meta.gitBranch = obj.gitBranch;
    if (typeof obj.version === "string") meta.version = obj.version;
    if (typeof obj.slug === "string") meta.slug = obj.slug;

    const entryId = typeof obj.uuid === "string" && obj.uuid !== "" ? obj.uuid : `${idNamespace}:${lineIndex}`;
    const base = {
      timestamp: typeof obj.timestamp === "string" ? obj.timestamp : null,
      sidechain: obj.isSidechain === true,
      agentId: typeof obj.agentId === "string" ? obj.agentId : null,
    };
    let blockIndex = 0;
    const push = (event: Omit<TranscriptEvent, "id">): void => {
      events.push({ id: `${entryId}:${blockIndex}`, ...event });
      blockIndex += 1;
    };

    const content = obj.message?.content;

    if (obj.type === "user") {
      if (typeof content === "string") {
        push({ kind: "prompt", ...base, text: capText(content) });
      } else if (Array.isArray(content)) {
        for (const block of content) {
          if (!block || typeof block !== "object") continue;
          if (block.type === "tool_result") {
            push({
              kind: "tool_result",
              ...base,
              text: capText(stringifyResultContent(block.content)),
              toolUseId: typeof block.tool_use_id === "string" ? block.tool_use_id : undefined,
              isError: block.is_error === true,
            });
          } else if (block.type === "text" && typeof block.text === "string") {
            push({ kind: "prompt", ...base, text: capText(block.text) });
          } else if (block.type === "image") {
            push({ kind: "prompt", ...base, text: "[image attachment]" });
          }
        }
      }
      return;
    }

    // assistant
    if (!Array.isArray(content)) return;
    const model = typeof obj.message?.model === "string" ? obj.message.model : undefined;
    for (const block of content) {
      if (!block || typeof block !== "object") continue;
      switch (block.type) {
        case "text":
          if (typeof block.text === "string" && block.text !== "") {
            push({ kind: "assistant_text", ...base, text: capText(block.text), model });
          }
          break;
        case "thinking": {
          // Empty thinking text with only a signature = redacted; still show
          // that thinking happened.
          const text = typeof block.thinking === "string" ? block.thinking : "";
          push({ kind: "thinking", ...base, text: capText(text) || "(thinking content redacted)" });
          break;
        }
        case "tool_use": {
          let inputJson: string;
          try {
            inputJson = JSON.stringify(block.input, null, 2) ?? "";
          } catch {
            inputJson = String(block.input);
          }
          push({
            kind: "tool_use",
            ...base,
            toolName: typeof block.name === "string" ? block.name : "(unknown tool)",
            toolInput: capText(inputJson),
            toolPreview: toolPreview(block.input),
            toolUseId: typeof block.id === "string" ? block.id : undefined,
            model,
          });
          break;
        }
        default:
          break; // unknown assistant block type -- skip, don't crash
      }
    }
  });

  return { events, aiTitle, customTitle, meta, malformedLines };
}

export function parseTranscript(raw: string): ParsedChunk {
  return parseLines(raw.split("\n"));
}
