import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, test } from "node:test";
import { isValidProjectName, listProjects, listSessions, readSessionChunk } from "./store";

const MAIN_ID = "11111111-1111-1111-1111-111111111111";
const SIDECHAIN_ID = "22222222-2222-2222-2222-222222222222";
const CHUNK_ID = "33333333-3333-3333-3333-333333333333";
const DEMO_PROJECT = "-Users-alice-git-demo";

function line(obj: unknown): string {
  return `${JSON.stringify(obj)}\n`;
}

const tmpRoots: string[] = [];

async function makeRoot(): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "issue-pipeline-server-test-"));
  tmpRoots.push(root);
  return root;
}

afterEach(async () => {
  while (tmpRoots.length > 0) {
    await fs.rm(tmpRoots.pop()!, { recursive: true, force: true });
  }
});

async function writeDemoProject(root: string): Promise<string> {
  const dir = path.join(root, DEMO_PROJECT);
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(
    path.join(dir, `${MAIN_ID}.jsonl`),
    line({ type: "queue-operation", operation: "enqueue" }) +
      line({
        type: "user",
        uuid: "u1",
        timestamp: "2026-01-05T10:00:00.000Z",
        cwd: "/Users/alice/git/demo",
        gitBranch: "main",
        message: { role: "user", content: "Fix the login bug" },
      }) +
      line({
        type: "assistant",
        uuid: "a1",
        timestamp: "2026-01-05T10:00:05.000Z",
        message: { role: "assistant", model: "claude-fable-5", content: [{ type: "text", text: "Looking into it." }] },
      }) +
      line({ type: "ai-title", aiTitle: "Login bug investigation" }),
  );
  await fs.writeFile(
    path.join(dir, `${SIDECHAIN_ID}.jsonl`),
    line({
      type: "user",
      uuid: "s1",
      isSidechain: true,
      timestamp: "2026-01-04T09:00:00.000Z",
      cwd: "/Users/alice/git/demo",
      message: { role: "user", content: "Explore the auth module" },
    }),
  );
  // Pin mtimes so ordering assertions don't depend on write timing.
  await fs.utimes(path.join(dir, `${MAIN_ID}.jsonl`), new Date("2026-01-05T10:01:00Z"), new Date("2026-01-05T10:01:00Z"));
  await fs.utimes(
    path.join(dir, `${SIDECHAIN_ID}.jsonl`),
    new Date("2026-01-04T09:01:00Z"),
    new Date("2026-01-04T09:01:00Z"),
  );
  return dir;
}

test("listProjects lists directories with sessions and reads a display cwd", async () => {
  const root = await makeRoot();
  await writeDemoProject(root);
  await fs.mkdir(path.join(root, "-Users-alice-git-empty"), { recursive: true }); // no sessions -> excluded
  await fs.writeFile(path.join(root, "stray.txt"), "not a project");

  const projects = await listProjects(root);
  assert.equal(projects.length, 1);
  assert.equal(projects[0].name, DEMO_PROJECT);
  assert.equal(projects[0].sessionCount, 2);
  assert.equal(projects[0].displayPath, "/Users/alice/git/demo");
  assert.equal(projects[0].lastModified, "2026-01-05T10:01:00.000Z");
});

test("listSessions summarizes newest-first with titles, first prompt, and sidechain flag", async () => {
  const root = await makeRoot();
  await writeDemoProject(root);

  const sessions = await listSessions(root, DEMO_PROJECT);
  assert.deepEqual(
    sessions.map((s) => s.id),
    [MAIN_ID, SIDECHAIN_ID],
  );
  const [main, side] = sessions;
  assert.equal(main.title, "Login bug investigation");
  assert.equal(main.firstPrompt, "Fix the login bug");
  assert.equal(main.startedAt, "2026-01-05T10:00:00.000Z");
  assert.equal(main.gitBranch, "main");
  assert.equal(main.sidechain, false);
  assert.equal(main.sizeBytes > 0, true);
  assert.equal(side.sidechain, true);
});

test("a custom title wins over the generated title, and summaries refresh when the file grows", async () => {
  const root = await makeRoot();
  const dir = await writeDemoProject(root);

  const before = await listSessions(root, DEMO_PROJECT);
  assert.equal(before[0].title, "Login bug investigation");

  await fs.appendFile(path.join(dir, `${MAIN_ID}.jsonl`), line({ type: "custom-title", customTitle: "Login fix" }));
  const after = await listSessions(root, DEMO_PROJECT);
  assert.equal(after[0].title, "Login fix");
});

test("readSessionChunk consumes complete lines incrementally and holds back torn writes", async () => {
  const root = await makeRoot();
  const dir = path.join(root, "-tmp-work");
  await fs.mkdir(dir, { recursive: true });
  const file = path.join(dir, `${CHUNK_ID}.jsonl`);
  const promptLine = line({
    type: "user",
    uuid: "u1",
    timestamp: "2026-03-01T12:00:00.000Z",
    message: { role: "user", content: "hello" },
  });
  await fs.writeFile(file, promptLine);

  const first = await readSessionChunk(root, "-tmp-work", CHUNK_ID, 0);
  assert.deepEqual(
    first.events.map((e) => e.kind),
    ["prompt"],
  );
  assert.equal(first.offset, Buffer.byteLength(promptLine));
  assert.equal(first.reset, false);

  const noGrowth = await readSessionChunk(root, "-tmp-work", CHUNK_ID, first.offset);
  assert.equal(noGrowth.events.length, 0);
  assert.equal(noGrowth.offset, first.offset);

  // A torn write (no newline yet, not valid JSON) is held back...
  const fullLine = line({
    type: "assistant",
    uuid: "a1",
    message: { role: "assistant", content: [{ type: "text", text: "world" }] },
  });
  await fs.appendFile(file, fullLine.slice(0, 25));
  const heldBack = await readSessionChunk(root, "-tmp-work", CHUNK_ID, first.offset);
  assert.equal(heldBack.events.length, 0);
  assert.equal(heldBack.offset, first.offset);

  // ...and consumed once the line completes.
  await fs.appendFile(file, fullLine.slice(25));
  const completed = await readSessionChunk(root, "-tmp-work", CHUNK_ID, heldBack.offset);
  assert.deepEqual(
    completed.events.map((e) => e.kind),
    ["assistant_text"],
  );
  assert.equal(completed.events[0].text, "world");
  assert.equal(completed.offset, Buffer.byteLength(promptLine + fullLine));
});

test("readSessionChunk consumes an unterminated final line once it parses as complete JSON", async () => {
  const root = await makeRoot();
  const dir = path.join(root, "-tmp-work");
  await fs.mkdir(dir, { recursive: true });
  const file = path.join(dir, `${CHUNK_ID}.jsonl`);
  const promptLine = line({ type: "user", uuid: "u1", message: { role: "user", content: "hello" } });
  const unterminated = JSON.stringify({
    type: "assistant",
    uuid: "a1",
    message: { role: "assistant", content: [{ type: "text", text: "done" }] },
  });
  await fs.writeFile(file, promptLine + unterminated);

  const chunk = await readSessionChunk(root, "-tmp-work", CHUNK_ID, 0);
  assert.deepEqual(
    chunk.events.map((e) => e.kind),
    ["prompt", "assistant_text"],
  );
  assert.equal(chunk.offset, Buffer.byteLength(promptLine + unterminated));
});

test("readSessionChunk resets when the file shrinks below the resume offset", async () => {
  const root = await makeRoot();
  const dir = path.join(root, "-tmp-work");
  await fs.mkdir(dir, { recursive: true });
  const file = path.join(dir, `${CHUNK_ID}.jsonl`);
  const promptLine = line({ type: "user", uuid: "u1", message: { role: "user", content: "hello" } });
  await fs.writeFile(file, promptLine + line({ type: "ai-title", aiTitle: "t" }));
  const first = await readSessionChunk(root, "-tmp-work", CHUNK_ID, 0);

  await fs.writeFile(file, promptLine); // replaced with a shorter file
  const reset = await readSessionChunk(root, "-tmp-work", CHUNK_ID, first.offset);
  assert.equal(reset.reset, true);
  assert.deepEqual(
    reset.events.map((e) => e.kind),
    ["prompt"],
  );
  assert.equal(reset.offset, Buffer.byteLength(promptLine));
});

test("isValidProjectName rejects traversal-shaped names", () => {
  assert.equal(isValidProjectName(DEMO_PROJECT), true);
  assert.equal(isValidProjectName(".."), false);
  assert.equal(isValidProjectName("."), false);
  assert.equal(isValidProjectName("a/b"), false);
  assert.equal(isValidProjectName("a\\b"), false);
  assert.equal(isValidProjectName(""), false);
});
