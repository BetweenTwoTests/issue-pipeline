/**
 * Parser for Claude Code's session transcript files
 * (~/.claude/projects/<cwd-derived-dir>/<sessionId>.jsonl).
 *
 * The format is Claude Code's INTERNAL storage, not a documented API --
 * verified against real files this pipeline produced, but liable to grow
 * new line/block types with any claude release. The parser is therefore
 * deliberately defensive: unknown line types are skipped, unknown content
 * blocks fall back to raw JSON, and a malformed line never aborts the file.
 *
 * Pure (string in, events out) so it can be unit-tested without fs.
 */

export interface TranscriptEvent {
  kind: "prompt" | "assistant_text" | "thinking" | "tool_use" | "tool_result";
  timestamp: string | null;
  sidechain: boolean;
  /** prompt / assistant_text / thinking / tool_result body. */
  text?: string;
  /** tool_use only. */
  toolName?: string;
  toolInput?: string;
  /** One-line summary of the tool input, for collapsed rendering. */
  toolPreview?: string;
  /** tool_result only. */
  isError?: boolean;
  model?: string;
}

export interface ParsedTranscript {
  /** Claude Code's own generated title for the session, when present. */
  title: string | null;
  events: TranscriptEvent[];
  /** Lines that failed to parse as JSON -- surfaced so truncation/corruption
   * is visible instead of silent. */
  malformedLines: number;
}

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
  isSidechain?: boolean;
  timestamp?: string;
  message?: {
    role?: string;
    model?: string;
    content?: string | ContentBlock[];
  };
}

const PREVIEW_KEYS = ["command", "file_path", "pattern", "query", "url", "prompt", "description"];
const PREVIEW_MAX = 100;

function oneLine(s: string): string {
  const flat = s.replace(/\s+/g, " ").trim();
  return flat.length > PREVIEW_MAX ? `${flat.slice(0, PREVIEW_MAX - 1)}…` : flat;
}

function toolPreview(input: unknown): string {
  if (input && typeof input === "object" && !Array.isArray(input)) {
    const obj = input as Record<string, unknown>;
    for (const key of PREVIEW_KEYS) {
      if (typeof obj[key] === "string" && (obj[key] as string).trim() !== "") {
        return oneLine(obj[key] as string);
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

export function parseTranscript(raw: string): ParsedTranscript {
  const events: TranscriptEvent[] = [];
  let title: string | null = null;
  let malformedLines = 0;

  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (trimmed === "") continue;
    let obj: TranscriptLine;
    try {
      obj = JSON.parse(trimmed) as TranscriptLine;
    } catch {
      malformedLines += 1;
      continue;
    }

    if (obj.type === "ai-title" && typeof obj.aiTitle === "string") {
      title = obj.aiTitle;
      continue;
    }
    if (obj.type !== "user" && obj.type !== "assistant") continue; // queue-operation, attachment, last-prompt, summary, ...

    const base = {
      timestamp: typeof obj.timestamp === "string" ? obj.timestamp : null,
      sidechain: obj.isSidechain === true,
    };
    const content = obj.message?.content;

    if (obj.type === "user") {
      if (typeof content === "string") {
        events.push({ kind: "prompt", ...base, text: content });
      } else if (Array.isArray(content)) {
        for (const block of content) {
          if (!block || typeof block !== "object") continue;
          if (block.type === "tool_result") {
            events.push({
              kind: "tool_result",
              ...base,
              text: stringifyResultContent(block.content),
              isError: block.is_error === true,
            });
          } else if (block.type === "text" && typeof block.text === "string") {
            events.push({ kind: "prompt", ...base, text: block.text });
          }
        }
      }
      continue;
    }

    // assistant
    if (!Array.isArray(content)) continue;
    const model = typeof obj.message?.model === "string" ? obj.message.model : undefined;
    for (const block of content) {
      if (!block || typeof block !== "object") continue;
      switch (block.type) {
        case "text":
          if (typeof block.text === "string" && block.text !== "") {
            events.push({ kind: "assistant_text", ...base, text: block.text, model });
          }
          break;
        case "thinking": {
          // Empty thinking text with only a signature = redacted; still show
          // that thinking happened.
          const text = typeof block.thinking === "string" ? block.thinking : "";
          events.push({ kind: "thinking", ...base, text: text || "(thinking content redacted)" });
          break;
        }
        case "tool_use": {
          let inputJson: string;
          try {
            inputJson = JSON.stringify(block.input, null, 2) ?? "";
          } catch {
            inputJson = String(block.input);
          }
          events.push({
            kind: "tool_use",
            ...base,
            toolName: typeof block.name === "string" ? block.name : "(unknown tool)",
            toolInput: inputJson,
            toolPreview: toolPreview(block.input),
            model,
          });
          break;
        }
        default:
          break; // unknown assistant block type -- skip, don't crash
      }
    }
  }

  return { title, events, malformedLines };
}
