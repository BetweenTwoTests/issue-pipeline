import assert from "node:assert/strict";
import { test } from "node:test";
import { parseTranscript } from "./transcript";

/** Fixture lines mirror the REAL shapes observed in Claude Code's session
 * store (~/.claude/projects/...) from actual pipeline runs -- if a claude
 * release changes the format, update these from a fresh real file. */
const LINES = [
  { type: "queue-operation", operation: "enqueue", content: "ignored" },
  { type: "ai-title", aiTitle: "Create issue-1.md with heading", sessionId: "x" },
  {
    type: "user",
    timestamp: "2026-08-14T00:37:00.230Z",
    message: { role: "user", content: "You are the EXECUTOR agent..." },
  },
  { type: "attachment", attachment: { type: "deferred_tools_delta" } },
  {
    type: "assistant",
    timestamp: "2026-08-14T00:37:05.000Z",
    message: {
      role: "assistant",
      model: "claude-fable-5",
      content: [{ type: "thinking", thinking: "", signature: "redacted-sig" }],
    },
  },
  {
    type: "assistant",
    timestamp: "2026-08-14T00:37:06.000Z",
    message: {
      role: "assistant",
      model: "claude-fable-5",
      content: [{ type: "text", text: "I'll create the file and the required WORKLOG." }],
    },
  },
  {
    type: "assistant",
    timestamp: "2026-08-14T00:37:07.000Z",
    message: {
      role: "assistant",
      model: "claude-fable-5",
      content: [
        {
          type: "tool_use",
          id: "toolu_1",
          name: "Write",
          input: { file_path: "/tmp/wt/issue-1.md", content: "# Issue 1\n" },
        },
      ],
    },
  },
  {
    type: "user",
    timestamp: "2026-08-14T00:37:09.204Z",
    message: {
      role: "user",
      content: [{ tool_use_id: "toolu_1", type: "tool_result", content: "File created successfully" }],
    },
  },
  {
    type: "user",
    isSidechain: true,
    message: {
      role: "user",
      content: [
        { type: "tool_result", content: [{ type: "text", text: "block one" }, { type: "text", text: "block two" }] },
      ],
    },
  },
  { type: "last-prompt", lastPrompt: "ignored", leafUuid: "y" },
];

const RAW = LINES.map((l) => JSON.stringify(l)).join("\n") + "\nnot json at all\n";

test("parseTranscript extracts prompt, thinking, text, tool_use, and tool_result in order", () => {
  const parsed = parseTranscript(RAW);
  assert.equal(parsed.title, "Create issue-1.md with heading");
  assert.equal(parsed.malformedLines, 1);
  assert.deepEqual(
    parsed.events.map((e) => e.kind),
    ["prompt", "thinking", "assistant_text", "tool_use", "tool_result", "tool_result"],
  );

  const [prompt, thinking, text, toolUse, toolResult, sidechainResult] = parsed.events;
  assert.equal(prompt.text, "You are the EXECUTOR agent...");
  assert.equal(thinking.text, "(thinking content redacted)");
  assert.equal(text.model, "claude-fable-5");
  assert.equal(toolUse.toolName, "Write");
  assert.ok(toolUse.toolInput?.includes("issue-1.md"));
  assert.equal(toolUse.toolPreview, "/tmp/wt/issue-1.md");
  assert.equal(toolResult.text, "File created successfully");
  assert.equal(toolResult.sidechain, false);
  // array-shaped tool_result content collapses to its text blocks
  assert.equal(sidechainResult.text, "block one\nblock two");
  assert.equal(sidechainResult.sidechain, true);
});

test("parseTranscript never throws on garbage and skips unknown line/block types", () => {
  const parsed = parseTranscript(
    [
      JSON.stringify({ type: "mystery-new-line-type", stuff: 1 }),
      JSON.stringify({
        type: "assistant",
        message: { role: "assistant", content: [{ type: "brand_new_block", data: 1 }] },
      }),
      "",
      "   ",
    ].join("\n"),
  );
  assert.equal(parsed.events.length, 0);
  assert.equal(parsed.malformedLines, 0);
});

test("parseTranscript falls back to a JSON preview for tool inputs without known preview keys", () => {
  const parsed = parseTranscript(
    JSON.stringify({
      type: "assistant",
      message: { role: "assistant", content: [{ type: "tool_use", name: "Weird", input: { alpha: 1 } }] },
    }),
  );
  assert.equal(parsed.events[0].toolPreview, '{"alpha":1}');
});
