import assert from "node:assert/strict";
import { test } from "node:test";
import { parsePipelineConfig } from "./pipeline-config";
import { PipelineConfigError } from "./errors";

const MINIMAL_VALID_YAML = `
version: 1
roles:
  planner: { adapter: claude }
  executor: { adapter: codex }
  fixer: { adapter: codex }
`;

test("parsePipelineConfig applies defaults for every optional block", () => {
  const config = parsePipelineConfig(MINIMAL_VALID_YAML);
  assert.equal(config.policy.local_gates, "advisory");
  assert.equal(config.policy.max_fix_attempts, 2);
  assert.equal(config.policy.auto_continue, true);
  assert.equal(config.branching.stack_tool, "graphite");
  assert.equal(config.branching.branch_prefix, "pipe");
  assert.equal(config.branching.remote, "origin");
  assert.equal(config.branching.pr_draft, false);
  assert.deepEqual(config.gates.commands, []);
  assert.deepEqual(config.repos, {});
  assert.equal(config.roles.planner.timeout_ms, 900_000);
  assert.deepEqual(config.roles.planner.args, []);
});

test("parsePipelineConfig throws PipelineConfigError on invalid YAML syntax", () => {
  assert.throws(() => parsePipelineConfig("version: 1\n  roles: [broken"), PipelineConfigError);
});

test("parsePipelineConfig throws PipelineConfigError when a required role is missing", () => {
  assert.throws(
    () => parsePipelineConfig("version: 1\nroles:\n  planner: { adapter: claude }\n"),
    PipelineConfigError,
  );
});

test("parsePipelineConfig throws when adapter is not one of the known values", () => {
  assert.throws(
    () =>
      parsePipelineConfig(`
version: 1
roles:
  planner: { adapter: gpt5 }
  executor: { adapter: codex }
  fixer: { adapter: codex }
`),
    PipelineConfigError,
  );
});

test("parsePipelineConfig rejects a repo entry with a malformed github slug", () => {
  assert.throws(
    () =>
      parsePipelineConfig(`
${MINIMAL_VALID_YAML}
repos:
  myrepo:
    github: not-a-slug
    local_path: ~/pipelines/myrepo/.repo
`),
    PipelineConfigError,
  );
});

test("parsePipelineConfig accepts a fully-specified config", () => {
  const config = parsePipelineConfig(`
version: 1
roles:
  planner: { adapter: claude, args: ["--permission-mode", "plan"], timeout_ms: 600000, max_budget_usd: 2.0 }
  executor: { adapter: codex, args: ["--full-auto"] }
  fixer: { adapter: codex }
policy:
  local_gates: blocking
  max_fix_attempts: 3
  auto_continue: false
branching:
  stack_tool: git
  branch_prefix: feature
  remote: upstream
  pr_draft: true
gates:
  timeout_ms: 60000
  commands:
    - { name: test, command: npm, args: ["test"] }
repos:
  chronic-backend:
    github: Flagler-Health/chronic-backend
    local_path: ~/pipelines/chronic-backend/.repo
    default_branch: main
`);
  assert.equal(config.policy.local_gates, "blocking");
  assert.equal(config.branching.stack_tool, "git");
  assert.equal(config.gates.commands.length, 1);
  assert.equal(config.repos["chronic-backend"]?.github, "Flagler-Health/chronic-backend");
});
