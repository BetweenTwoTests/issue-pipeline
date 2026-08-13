import * as fs from "node:fs/promises";
import * as os from "node:os";
import { parsePipelineConfig, PipelineConfigError, type PipelineConfig, type RegisteredRepo } from "@issue-pipeline/core";

function expandHome(p: string): string {
  if (p === "~") return os.homedir();
  if (p.startsWith("~/")) return `${os.homedir()}${p.slice(1)}`;
  return p;
}

/**
 * Fail-fast, no silent default path -- mirrors loadTemporalConnectionConfig's
 * philosophy: a wrong pipeline.yaml location for a system that opens real
 * PRs deserves a loud failure, not a guess.
 */
export async function loadPipelineConfig(): Promise<PipelineConfig> {
  const configPath = process.env.PIPELINE_CONFIG_PATH;
  if (!configPath) {
    throw new PipelineConfigError(
      "PIPELINE_CONFIG_PATH is not set. Point it at your pipeline.yaml (see .env.example).",
    );
  }
  let raw: string;
  try {
    raw = await fs.readFile(configPath, "utf8");
  } catch (err) {
    throw new PipelineConfigError(`pipeline.yaml not found at ${configPath}`, err);
  }
  return parsePipelineConfig(raw);
}

// Activities proxied via Temporal's proxyActivities must return a Promise --
// a synchronous return type resolves to an unusable branded type on the
// workflow side ("Type 'Symbol' has no call signatures"), so these are
// `async` even though nothing inside actually awaits.
export async function resolveRegisteredRepo(config: PipelineConfig, name: string): Promise<RegisteredRepo> {
  const entry = config.repos[name];
  if (!entry) {
    throw new PipelineConfigError(`No repo named "${name}" registered in pipeline.yaml`);
  }
  return toRegisteredRepo(name, entry);
}

export async function resolveRegisteredRepoBySlug(config: PipelineConfig, owner: string, repo: string): Promise<RegisteredRepo> {
  const target = `${owner}/${repo}`.toLowerCase();
  for (const [name, entry] of Object.entries(config.repos)) {
    if (entry.github.toLowerCase() === target) {
      return toRegisteredRepo(name, entry);
    }
  }
  throw new PipelineConfigError(
    `No repo registered in pipeline.yaml matching ${owner}/${repo}. Add it under "repos:" first.`,
  );
}

function toRegisteredRepo(
  name: string,
  entry: PipelineConfig["repos"][string],
): RegisteredRepo {
  const [owner, repo] = entry.github.split("/");
  return {
    name,
    owner,
    repo,
    localPath: expandHome(entry.local_path),
    defaultBranch: entry.default_branch,
  };
}
