import { z } from "zod";
import YAML from "yaml";
import { PipelineConfigError } from "./errors";

const RoleConfigSchema = z
  .object({
    adapter: z.enum(["claude", "codex"]),
    args: z.array(z.string()).default([]),
    timeout_ms: z.number().int().positive().default(900_000),
    max_budget_usd: z.number().positive().optional(),
  })
  .strict();

export const PipelineConfigSchema = z
  .object({
    version: z.literal(1),
    roles: z
      .object({
        planner: RoleConfigSchema,
        executor: RoleConfigSchema,
        fixer: RoleConfigSchema,
      })
      .strict(),
    policy: z
      .object({
        local_gates: z.enum(["advisory", "blocking"]).default("advisory"),
        max_fix_attempts: z.number().int().min(0).default(2),
        auto_continue: z.boolean().default(true),
      })
      .strict()
      .default({}),
    branching: z
      .object({
        stack_tool: z.enum(["graphite", "git"]).default("graphite"),
        branch_prefix: z.string().default("pipe"),
        remote: z.string().default("origin"),
        pr_draft: z.boolean().default(false),
      })
      .strict()
      .default({}),
    gates: z
      .object({
        commands: z
          .array(
            z
              .object({
                name: z.string(),
                command: z.string(),
                args: z.array(z.string()).default([]),
              })
              .strict(),
          )
          .default([]),
        timeout_ms: z.number().int().positive().default(300_000),
      })
      .strict()
      .default({}),
    // One-way mirroring of tracker writes (app database -> external
    // tracker). "none" disables it; "github" mirrors issues/comments/labels
    // to each repo's `github:` slug. See TrackerSyncPort in
    // contracts/tracker-sync.ts for what adding a provider involves.
    sync: z
      .object({
        provider: z.enum(["none", "github"]).default("none"),
      })
      .strict()
      .default({}),
    repos: z
      .record(
        z.string(),
        z
          .object({
            github: z.string().regex(/^[^/]+\/[^/]+$/, 'must be "owner/repo"'),
            local_path: z.string().min(1),
            default_branch: z.string().default("main"),
          })
          .strict(),
      )
      .default({}),
  })
  .strict();

export type RoleConfig = z.infer<typeof RoleConfigSchema>;
export type PipelineConfig = z.infer<typeof PipelineConfigSchema>;

/**
 * Pure: YAML text in, validated object out (or throws). No fs/env access --
 * that is the caller's job (see loadPipelineConfig in @issue-pipeline/activities).
 */
export function parsePipelineConfig(raw: string): PipelineConfig {
  let doc: unknown;
  try {
    doc = YAML.parse(raw);
  } catch (err) {
    throw new PipelineConfigError(`pipeline.yaml is not valid YAML: ${(err as Error).message}`, err);
  }
  const result = PipelineConfigSchema.safeParse(doc);
  if (!result.success) {
    throw new PipelineConfigError(`pipeline.yaml failed validation: ${result.error.message}`, result.error.issues);
  }
  return result.data;
}
