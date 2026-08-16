import * as fs from "node:fs/promises";
import * as path from "node:path";
import {
  type AgentResult,
  type AgentRole,
  type PipelineConfig,
  type PlannerOutput,
  type WorklogSections,
  buildTranscriptUrl,
  PlannerOutputSchema,
  PlannerOutputParseError,
  WorklogContractViolationError,
} from "@issue-pipeline/core";
import {
  runClaude,
  runCodex,
  buildPlannerPrompt as renderPlannerPrompt,
  buildExecutorPrompt as renderExecutorPrompt,
  buildFixerPrompt as renderFixerPrompt,
  type PlannerPromptInput,
  type FixerPromptInput,
} from "@issue-pipeline/adapters";
import type { RegisteredRepo } from "@issue-pipeline/core";
import { listComments } from "./github";

/**
 * Workflow code must never import @issue-pipeline/adapters directly -- doing
 * so would pull real runtime code (including process.ts's child_process use)
 * into the Temporal workflow bundle. These thin wrappers are the only way
 * plan.ts/phase.ts reach the prompt templates.
 */
export async function buildPlannerPrompt(input: PlannerPromptInput): Promise<string> {
  return renderPlannerPrompt(input);
}

export async function buildFixerPrompt(input: FixerPromptInput): Promise<string> {
  return renderFixerPrompt(input);
}

export interface BuildExecutorPromptInput {
  repo: RegisteredRepo;
  phaseNumber: number;
  totalPhases: number;
  phaseTitle: string;
  phaseGoal: string;
  phaseSpec: string;
  acceptance: string[];
  baseBranch: string;
  priorSubIssueNumbers: number[];
}

/**
 * Fetches prior phases' worklog comments itself (Decision A: the child
 * PhaseWorkflow assembles its own handoff context on demand, rather than
 * PlanWorkflow forwarding growing text through every child's start input) --
 * this keeps PlanWorkflow's own persisted state to small scalars only.
 */
export async function buildExecutorPrompt(input: BuildExecutorPromptInput): Promise<string> {
  let priorPhasesContext: string | undefined;
  if (input.priorSubIssueNumbers.length > 0) {
    const chunks: string[] = [];
    for (const subIssueNumber of input.priorSubIssueNumbers) {
      const comments = await listComments(input.repo, subIssueNumber);
      for (const comment of comments) {
        if (comment.body.startsWith("## Worklog")) {
          chunks.push(`### Phase sub-issue #${subIssueNumber}\n${comment.body}`);
        }
      }
    }
    if (chunks.length > 0) priorPhasesContext = chunks.join("\n\n");
  }
  return renderExecutorPrompt({
    phaseNumber: input.phaseNumber,
    totalPhases: input.totalPhases,
    phaseTitle: input.phaseTitle,
    phaseGoal: input.phaseGoal,
    phaseSpec: input.phaseSpec,
    acceptance: input.acceptance,
    baseBranch: input.baseBranch,
    priorPhasesContext,
  });
}

export interface RunAgentInput {
  role: AgentRole;
  prompt: string;
  cwd: string;
  config: PipelineConfig;
}

// The planner should never edit files (its whole job is to respond with
// JSON), so it runs in Claude's read-only "plan" mode as a safety backstop.
// Executor/fixer need to freely edit files and run shell commands
// unattended inside an isolated worktree -- the doc's own explicit design
// (§12): "the blast radius is a branch, worst case is a bad PR."
const DEFAULT_PERMISSION_MODE: Record<AgentRole, string> = {
  planner: "plan",
  executor: "bypassPermissions",
  fixer: "bypassPermissions",
};

/** The transcript viewer's own default port (apps/transcript-viewer). */
const DEFAULT_VIEWER_URL = "http://localhost:8845";

/**
 * Markdown footer linking an agent run's session transcript in the local
 * viewer (`just transcripts`). Empty when the run reported no session id
 * (codex has no session concept; a crashed claude run may report none) --
 * callers append the result verbatim. The base URL comes from
 * PIPELINE_VIEWER_URL so links track wherever the viewer listens; they
 * resolve only on the operator's machine, matching the viewer's
 * loopback-only design.
 */
export async function buildTranscriptFooter(input: { cwd: string; sessionId?: string }): Promise<string> {
  if (!input.sessionId) return "";
  const configured = process.env.PIPELINE_VIEWER_URL?.trim();
  const url = buildTranscriptUrl(configured || DEFAULT_VIEWER_URL, input.cwd, input.sessionId);
  return `\n\n---\n[Agent session transcript](${url}) (local viewer: \`just transcripts\`)`;
}

export async function runAgent(input: RunAgentInput): Promise<AgentResult> {
  const roleConfig = input.config.roles[input.role];
  switch (roleConfig.adapter) {
    case "claude":
      return runClaude({
        prompt: input.prompt,
        cwd: input.cwd,
        role: roleConfig,
        defaultPermissionMode: DEFAULT_PERMISSION_MODE[input.role],
      });
    case "codex":
      return runCodex({ prompt: input.prompt, cwd: input.cwd, role: roleConfig });
  }
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
const STATUS_RE = /^##\s*Status:\s*(done|blocked)\s*$/im;

function splitSections(raw: string): Record<string, string> {
  const sections: Record<string, string> = {};
  const parts = raw.split(/\n(?=##\s+)/);
  for (const part of parts) {
    // [^\n]+, not a non-greedy .+?: the \n? that follows can match zero
    // characters, so a non-greedy capture would stop after a single
    // character ("D" instead of "Done").
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
    status: statusMatch[1].toLowerCase() as "done" | "blocked",
    raw,
  };
}
