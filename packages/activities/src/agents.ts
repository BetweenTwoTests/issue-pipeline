import * as fs from "node:fs/promises";
import * as path from "node:path";
import {
  type AgentResult,
  type AgentRole,
  type PipelineConfig,
  type PlannerOutput,
  type RegisteredRepo,
  type WorklogSections,
  PlannerOutputSchema,
  PlannerOutputParseError,
  WorklogContractViolationError,
} from "@issue-pipeline/core";
import {
  runClaude,
  buildPlannerPrompt as renderPlannerPrompt,
  buildExecutorPrompt as renderExecutorPrompt,
  buildFixerPrompt as renderFixerPrompt,
  type PlannerPromptInput,
  type ExecutorPromptInput,
  type FixerPromptInput,
} from "@issue-pipeline/adapters";
import { createDiscoveredTaskIssue } from "./github";

/**
 * Workflow code must never import @issue-pipeline/adapters directly -- doing
 * so would pull real runtime code (including process.ts's child_process use)
 * into the Temporal workflow bundle. These thin wrappers are the only way
 * issue.ts/phase.ts reach the prompt templates.
 */
export async function buildPlannerPrompt(input: PlannerPromptInput): Promise<string> {
  return renderPlannerPrompt(input);
}

export async function buildExecutorPrompt(input: ExecutorPromptInput): Promise<string> {
  return renderExecutorPrompt(input);
}

export async function buildFixerPrompt(input: FixerPromptInput): Promise<string> {
  return renderFixerPrompt(input);
}

export interface RunAgentInput {
  role: AgentRole;
  prompt: string;
  cwd: string;
  config: PipelineConfig;
}

// The planner runs in Claude Code's read-only "plan" mode -- it explores the
// checkout it's pointed at but cannot modify anything; its deliverable is
// the JSON plan. Executor/fixer need to freely edit files and run shell
// commands unattended inside an isolated worktree (including `gt submit` and
// `gh issue comment`) -- the worktree sandboxing is the safety boundary, not
// the permission mode: "the blast radius is a branch, worst case is a bad PR."
const DEFAULT_PERMISSION_MODE: Record<AgentRole, string> = {
  planner: "plan",
  executor: "bypassPermissions",
  fixer: "bypassPermissions",
};

/** Claude only: the codex adapter was removed when this pipeline went
 * single-vendor (single-issue redesign). role.adapter survives in config as
 * a claude-only enum so an old codex config fails loudly at parse time. */
export async function runAgent(input: RunAgentInput): Promise<AgentResult> {
  const roleConfig = input.config.roles[input.role];
  return runClaude({
    prompt: input.prompt,
    cwd: input.cwd,
    role: roleConfig,
    defaultPermissionMode: DEFAULT_PERMISSION_MODE[input.role],
  });
}

/**
 * Tries raw JSON.parse, then a fenced ```json block, then the first balanced
 * {...} -- LLMs don't always comply with "output only JSON" even when told to.
 */
function extractJsonBlock(text: string): string {
  const trimmed = text.trim();
  try {
    JSON.parse(trimmed);
    return trimmed;
  } catch {
    // fall through to more lenient extraction
  }
  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fenced) return fenced[1].trim();
  const braceMatch = trimmed.match(/\{[\s\S]*\}/);
  if (braceMatch) return braceMatch[0];
  return trimmed;
}

// async even though nothing inside awaits: proxied Temporal activities must
// return a Promise, or the workflow-side type resolves to an unusable
// branded type ("Type 'Symbol' has no call signatures").
export async function parsePlannerOutput(rawSummary: string): Promise<PlannerOutput> {
  const jsonText = extractJsonBlock(rawSummary);
  let parsed: unknown;
  try {
    parsed = JSON.parse(jsonText);
  } catch (err) {
    throw new PlannerOutputParseError(`planner output was not valid JSON: ${(err as Error).message}`, rawSummary);
  }
  const result = PlannerOutputSchema.safeParse(parsed);
  if (!result.success) {
    throw new PlannerOutputParseError(`planner JSON failed schema validation: ${result.error.message}`, rawSummary);
  }
  return result.data;
}

const WORKLOG_FILENAME = "WORKLOG.md";
const WORKLOG_PROCESSED_FILENAME = "WORKLOG.md.processed";
const REQUIRED_SECTIONS = ["done", "deviations from spec", "surprises / new findings", "follow-ups"];
// Optional on purpose: an agent forgetting "## Discovered tasks" shouldn't
// fail the whole phase -- it just means no tasks get filed for that attempt.
const DISCOVERED_TASKS_SECTION = "discovered tasks";
const STATUS_RE = /^##\s*Status:\s*(done|blocked)\s*$/im;

function splitSections(raw: string): Record<string, string> {
  const sections: Record<string, string> = {};
  const parts = raw.split(/\n(?=##\s+)/);
  for (const part of parts) {
    // [^\n]+ (not the non-greedy .+? this used to be): the old pattern's
    // tail (\s*\n?) could match zero characters, so the non-greedy capture
    // stopped after a single character ("D" instead of "Done").
    const headerMatch = part.match(/^##\s+([^\n]+)\n?/);
    if (!headerMatch) continue;
    const header = headerMatch[1].trim();
    if (/^status:/i.test(header)) continue;
    sections[header.toLowerCase()] = part.slice(headerMatch[0].length).trim();
  }
  return sections;
}

/**
 * Reads + validates WORKLOG.md, then RENAMES (not deletes) it -- idempotent
 * under Temporal's at-least-once activity retries: a retry landing after a
 * crash between "rename" and "return" finds WORKLOG.md.processed instead of
 * WORKLOG.md and re-parses from there, rather than falsely throwing "missing".
 */
export async function readAndClearWorklog(cwd: string): Promise<WorklogSections> {
  const activePath = path.join(cwd, WORKLOG_FILENAME);
  const processedPath = path.join(cwd, WORKLOG_PROCESSED_FILENAME);

  let raw: string;
  let needsRename = true;
  try {
    raw = await fs.readFile(activePath, "utf8");
  } catch {
    try {
      raw = await fs.readFile(processedPath, "utf8");
      needsRename = false;
    } catch {
      throw new WorklogContractViolationError(`WORKLOG.md missing in ${cwd}`, cwd);
    }
  }

  const sections = splitSections(raw);
  for (const name of REQUIRED_SECTIONS) {
    if (!(name in sections)) {
      throw new WorklogContractViolationError(`WORKLOG.md missing required section "## ${name}" in ${cwd}`, cwd);
    }
  }
  const statusMatch = raw.match(STATUS_RE);
  if (!statusMatch) {
    throw new WorklogContractViolationError(`WORKLOG.md missing "## Status: done|blocked" line in ${cwd}`, cwd);
  }

  if (needsRename) {
    await fs.rename(activePath, processedPath);
  }

  return {
    done: sections["done"],
    deviationsFromSpec: sections["deviations from spec"],
    surprisesFindings: sections["surprises / new findings"],
    followUps: sections["follow-ups"],
    discoveredTasks: sections[DISCOVERED_TASKS_SECTION] ?? "None.",
    status: statusMatch[1].toLowerCase() as "done" | "blocked",
    raw,
  };
}

export interface DiscoveredTask {
  title: string;
  context: string;
}

const NONE_RE = /^(none|n\/a|nothing)\.?$/i;
const MAX_TITLE_LENGTH = 120;

/**
 * Parses the "## Discovered tasks" section text into individual tasks. One
 * top-level bullet per task; "<title> -- <context>" splits into a short
 * issue title plus context, otherwise the bullet is both. Exported for its
 * unit tests -- the parse rules here decide what becomes a real GitHub
 * issue, so they get the same test treatment as the worklog parser.
 */
export function parseDiscoveredTasks(sectionText: string): DiscoveredTask[] {
  const tasks: DiscoveredTask[] = [];
  for (const line of sectionText.split("\n")) {
    const bulletMatch = line.match(/^\s*[-*]\s+(.*\S)\s*$/);
    if (!bulletMatch) continue;
    const bullet = bulletMatch[1];
    if (NONE_RE.test(bullet)) continue;
    const sepMatch = bullet.match(/\s+(?:--|—)\s+/);
    let title: string;
    let context: string;
    if (sepMatch && sepMatch.index !== undefined && sepMatch.index > 0) {
      title = bullet.slice(0, sepMatch.index).trim();
      context = bullet.slice(sepMatch.index + sepMatch[0].length).trim() || bullet;
    } else {
      title = bullet;
      context = bullet;
    }
    if (title.length > MAX_TITLE_LENGTH) {
      title = `${title.slice(0, MAX_TITLE_LENGTH - 1)}…`;
    }
    tasks.push({ title, context });
  }
  return tasks;
}

/**
 * Files every discovered task from a phase's worklog as a sub-issue of the
 * root issue, immediately after the worklog is parsed. Returns how many
 * were newly created (vs. already existing -- createDiscoveredTaskIssue is
 * idempotent by title, so fixer attempts re-reporting the same discovery
 * don't duplicate it).
 */
export async function fileDiscoveredTasks(
  repo: RegisteredRepo,
  rootIssueNumber: number,
  phaseNumber: number,
  discoveredTasksText: string,
): Promise<{ created: number; total: number }> {
  const tasks = parseDiscoveredTasks(discoveredTasksText);
  let created = 0;
  for (const task of tasks) {
    const result = await createDiscoveredTaskIssue(repo, {
      parentIssueNumber: rootIssueNumber,
      phaseNumber,
      title: task.title,
      context: task.context,
    });
    if (result.created) created += 1;
  }
  return { created, total: tasks.length };
}
