import { spawnSync } from "node:child_process";
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

const DEPLOY_PATH = resolve("ops/symphony-deploy");
const SAFE_PATH = "/usr/bin:/bin";
const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.allSettled(
    tempDirs
      .splice(0)
      .map((path) => rm(path, { recursive: true, force: true })),
  );
});

async function deploySource(): Promise<string> {
  return await readFile(DEPLOY_PATH, "utf8");
}

function extractShellFunction(source: string, name: string): string {
  const lines = source.split("\n");
  const start = lines.findIndex((line) => line === `${name}() {`);
  expect(start, `function ${name}() not found`).toBeGreaterThanOrEqual(0);

  const end = lines.findIndex((line, index) => index > start && line === "}");
  expect(end).toBeGreaterThan(start);

  return lines.slice(start, end + 1).join("\n");
}

function extractShellFunctions(source: string, names: string[]): string {
  return names.map((name) => extractShellFunction(source, name)).join("\n");
}

async function makeTempDir(prefix: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

async function writeWorkflow(enabled: boolean): Promise<string> {
  const dir = await makeTempDir("symphony-deploy-workflow-");
  const path = join(dir, "WORKFLOW.md");
  await writeFile(
    path,
    [
      "---",
      "review_execution:",
      "  crabrunner_job_group:",
      `    enabled: ${enabled ? "true" : "false"}`,
      "---",
      "",
    ].join("\n"),
  );
  return path;
}

async function runCrabrunnerPreflight(options: {
  workflowPath: string;
  crabrunnerRoot?: string;
}) {
  const source = await deploySource();
  const functions = extractShellFunctions(source, [
    "trim_config_value",
    "dotenv_value",
    "deploy_config_value",
    "resolve_symphony_workflow_path",
    "workflow_enables_crabrunner_review",
    "run_crabrunner_review_preflight",
  ]);
  const shell = [
    'info() { echo "INFO $*"; }',
    'ok() { echo "OK $*"; }',
    'warn() { echo "WARN $*" >&2; }',
    'die() { echo "DIE $*" >&2; exit 1; }',
    `SYMPHONY_ROOT=${JSON.stringify(resolve("."))}`,
    functions,
    'run_crabrunner_review_preflight ""',
  ].join("\n");

  return spawnSync("/bin/bash", ["-c", shell], {
    encoding: "utf8",
    env: {
      PATH: SAFE_PATH,
      SYMPHONY_WORKFLOW: options.workflowPath,
      ...(options.crabrunnerRoot === undefined
        ? {}
        : { SYMPHONY_CRABRUNNER_ROOT: options.crabrunnerRoot }),
    },
  });
}

it("does not invoke the removed local review runtime preflight", async () => {
  const deploy = await deploySource();

  expect(deploy).not.toContain("run_review_runtime_preflight");
  expect(deploy).not.toContain("review-runtime-preflight.js");
  expect(deploy).not.toContain("SYMPHONY_COUNCIL_REVIEW_GATE");
  expect(deploy).not.toContain("CMUX_SPAWN_BIN");
  expect(deploy).toContain("review/QA runs through crabrunner when configured");
});

it("sets the service reinstall flag only when service env was refreshed", async () => {
  const deploy = await deploySource();
  const envPresentBlock = deploy.match(
    /if \[\[ -f "\$local_env" \]\]; then[\s\S]*?else/,
  )?.[0];

  expect(envPresentBlock).toContain("Using service environment from .env");
  expect(envPresentBlock).toContain("if $NEED_ENV_RESTART");
  expect(envPresentBlock).toContain("NEED_SERVICE_REINSTALL=true");
});

it("warns on missing .env and continues to branch pruning", async () => {
  const deploy = await deploySource();
  const missingEnvWarningIndex = deploy.indexOf(
    ".env not found — skipping service environment refresh",
  );
  const pruneIndex = deploy.indexOf("Pruning stale branches...");

  expect(missingEnvWarningIndex).toBeGreaterThan(-1);
  expect(pruneIndex).toBeGreaterThan(missingEnvWarningIndex);
});

it("reinstalls launchd when an env refresh requires it", async () => {
  const deploy = await deploySource();
  const serviceBlock = deploy.match(
    /if ! service_installed; then[\s\S]*?else\s*\n {4}info "Starting service\.\.\."/,
  )?.[0];

  expect(serviceBlock).toContain(
    "elif $NEED_ENV_RESTART || $NEED_SERVICE_REINSTALL; then",
  );
  expect(serviceBlock).toContain('run_or_dry "$CTL" uninstall');
  expect(serviceBlock).toContain('run_or_dry "$CTL" install');
  expect(serviceBlock).toContain('run_or_dry "$CTL" start');
});

describe("crabrunner review substrate preflight", () => {
  it("passes as a no-op when the crabrunner root is unset", async () => {
    const workflowPath = await writeWorkflow(true);
    const result = await runCrabrunnerPreflight({ workflowPath });

    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain("SYMPHONY_CRABRUNNER_ROOT not set");
  });

  it("passes as a no-op when the workflow does not enable crabrunner review", async () => {
    const workflowPath = await writeWorkflow(false);
    const crabrunnerRoot = await makeTempDir("symphony-deploy-crabrunner-");
    const result = await runCrabrunnerPreflight({
      workflowPath,
      crabrunnerRoot,
    });

    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain(
      "workflow does not enable crabrunner review",
    );
  });

  it("fails closed with an actionable message when bin/crabrunner is missing", async () => {
    const workflowPath = await writeWorkflow(true);
    const crabrunnerRoot = await makeTempDir("symphony-deploy-crabrunner-");
    const result = await runCrabrunnerPreflight({
      workflowPath,
      crabrunnerRoot,
    });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("Crabrunner review preflight failed");
    expect(result.stderr).toContain("missing");
    expect(result.stderr).toContain("bin/crabrunner");
    expect(result.stderr).toContain("SYMPHONY_CRABRUNNER_ROOT");
  });

  it("passes when bin/crabrunner resolves under the configured root", async () => {
    const workflowPath = await writeWorkflow(true);
    const crabrunnerRoot = await makeTempDir("symphony-deploy-crabrunner-");
    const binDir = join(crabrunnerRoot, "bin");
    const crabrunnerBin = join(binDir, "crabrunner");
    await mkdir(binDir, { recursive: true });
    await writeFile(crabrunnerBin, "#!/usr/bin/env bash\nexit 0\n");
    await chmod(crabrunnerBin, 0o755);

    const result = await runCrabrunnerPreflight({
      workflowPath,
      crabrunnerRoot,
    });

    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain("Crabrunner review preflight passed");
  });
});
