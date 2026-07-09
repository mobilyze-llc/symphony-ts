import { spawnSync } from "node:child_process";
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  readlink,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";

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
  crabrunnerVersion?: string;
  crabrunnerStateRoot?: string;
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
      ...(options.crabrunnerVersion === undefined
        ? {}
        : { SYMPHONY_CRABRUNNER_VERSION: options.crabrunnerVersion }),
      ...(options.crabrunnerStateRoot === undefined
        ? {}
        : { SYMPHONY_CRABRUNNER_STATE_ROOT: options.crabrunnerStateRoot }),
    },
  });
}

async function makeCmuxSkillSource(): Promise<{
  configDir: string;
  sourceDir: string;
}> {
  const configDir = await makeTempDir("symphony-deploy-config-");
  const sourceDir = join(configDir, "skills", "cmux-spawn");
  await mkdir(sourceDir, { recursive: true });
  await writeFile(join(sourceDir, "SKILL.md"), "# cmux-spawn\n");
  return { configDir, sourceDir };
}

async function runCmuxSkillInstall(options: {
  configDir: string;
  homeDir: string;
}) {
  const source = await deploySource();
  const functions = extractShellFunctions(source, [
    "archive_active_cmux_spawn_duplicate",
    "ensure_cmux_spawn_skill_install",
  ]);
  const shell = [
    'info() { echo "INFO $*"; }',
    'ok() { echo "OK $*"; }',
    'warn() { echo "WARN $*" >&2; }',
    'die() { echo "DIE $*" >&2; exit 1; }',
    'run_or_dry() { "$@"; }',
    "DRY_RUN=false",
    `CLAUDE_CONFIG_DIR=${JSON.stringify(options.configDir)}`,
    functions,
    "ensure_cmux_spawn_skill_install",
  ].join("\n");

  return spawnSync("/bin/bash", ["-c", shell], {
    encoding: "utf8",
    env: {
      HOME: options.homeDir,
      PATH: SAFE_PATH,
    },
  });
}

async function expectCanonicalCmuxLink(homeDir: string, sourceDir: string) {
  const installDir = join(homeDir, ".agents", "skills", "cmux-spawn");
  await expect(readFile(join(installDir, "SKILL.md"), "utf8")).resolves.toBe(
    "# cmux-spawn\n",
  );
  expect(await readlink(installDir)).toBe(await realpath(sourceDir));
  expect(await realpath(installDir)).toBe(await realpath(sourceDir));
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
  it("fails closed when enabled workflow has no crabrunner root configured", async () => {
    const workflowPath = await writeWorkflow(true);
    const result = await runCrabrunnerPreflight({ workflowPath });

    expect(result.status).toBe(1);
    expect(`${result.stdout}\n${result.stderr}`).toContain(
      "SYMPHONY_CRABRUNNER_ROOT",
    );
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

  it("fails closed when bin/crabrunner resolves outside the configured root", async () => {
    const workflowPath = await writeWorkflow(true);
    const crabrunnerRoot = await makeTempDir("symphony-deploy-crabrunner-");
    const outsideRoot = await makeTempDir("symphony-deploy-outside-");
    const binDir = join(crabrunnerRoot, "bin");
    const outsideBin = join(outsideRoot, "crabrunner");
    const crabrunnerBin = join(binDir, "crabrunner");
    await mkdir(binDir, { recursive: true });
    await writeFile(outsideBin, "#!/usr/bin/env bash\nexit 0\n");
    await chmod(outsideBin, 0o755);
    await symlink(outsideBin, crabrunnerBin);

    const result = await runCrabrunnerPreflight({
      workflowPath,
      crabrunnerRoot,
    });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain(
      "resolves outside SYMPHONY_CRABRUNNER_ROOT",
    );
  });

  it("fails closed when bin/crabrunner is a directory", async () => {
    const workflowPath = await writeWorkflow(true);
    const crabrunnerRoot = await makeTempDir("symphony-deploy-crabrunner-");
    const crabrunnerBin = join(crabrunnerRoot, "bin", "crabrunner");
    await mkdir(crabrunnerBin, { recursive: true });

    const result = await runCrabrunnerPreflight({
      workflowPath,
      crabrunnerRoot,
    });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("must be an executable file");
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
      crabrunnerVersion: "symph-949-u0",
      crabrunnerStateRoot: join(crabrunnerRoot, "state"),
    });

    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain("Crabrunner review preflight passed");
    expect(result.stdout).toContain("staged version symph-949-u0");
    expect(result.stdout).toContain(join(crabrunnerRoot, "state"));
  });

  it("fails closed when the configured Crabrunner version cannot be staged", async () => {
    const workflowPath = await writeWorkflow(true);
    const crabrunnerRoot = await makeTempDir("symphony-deploy-crabrunner-");
    const binDir = join(crabrunnerRoot, "bin");
    const crabrunnerBin = join(binDir, "crabrunner");
    await mkdir(binDir, { recursive: true });
    await writeFile(
      crabrunnerBin,
      '#!/usr/bin/env bash\necho \'{"error_code":"staging_build_failed"}\'\nexit 9\n',
    );
    await chmod(crabrunnerBin, 0o755);

    const result = await runCrabrunnerPreflight({
      workflowPath,
      crabrunnerRoot,
      crabrunnerVersion: "broken-version",
      crabrunnerStateRoot: join(crabrunnerRoot, "state"),
    });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("could not stage version 'broken-version'");
    expect(result.stderr).toContain("staging_build_failed");
  });
});

describe("cmux-spawn skill install canonicalization", () => {
  it("installs the canonical ~/.agents symlink", async () => {
    const homeDir = await makeTempDir("symphony-deploy-home-");
    const { configDir, sourceDir } = await makeCmuxSkillSource();

    const result = await runCmuxSkillInstall({ configDir, homeDir });

    expect(result.status, result.stderr).toBe(0);
    await expectCanonicalCmuxLink(homeDir, sourceDir);
  });

  it("uses a resolved target when CLAUDE_CONFIG_DIR is relative", async () => {
    const homeDir = await makeTempDir("symphony-deploy-home-");
    const { configDir, sourceDir } = await makeCmuxSkillSource();

    const result = await runCmuxSkillInstall({
      configDir: relative(process.cwd(), configDir),
      homeDir,
    });

    expect(result.status, result.stderr).toBe(0);
    await expectCanonicalCmuxLink(homeDir, sourceDir);
  });

  it("keeps the canonical ~/.agents symlink idempotent", async () => {
    const homeDir = await makeTempDir("symphony-deploy-home-");
    const { configDir, sourceDir } = await makeCmuxSkillSource();

    expect((await runCmuxSkillInstall({ configDir, homeDir })).status).toBe(0);
    const result = await runCmuxSkillInstall({ configDir, homeDir });

    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain("cmux-spawn user skill already points");
    await expectCanonicalCmuxLink(homeDir, sourceDir);
  });

  it("archives copy-style ~/.agents installs before replacing them", async () => {
    const homeDir = await makeTempDir("symphony-deploy-home-");
    const { configDir, sourceDir } = await makeCmuxSkillSource();
    const userInstall = join(homeDir, ".agents", "skills", "cmux-spawn");
    await mkdir(userInstall, { recursive: true });
    await writeFile(join(userInstall, "SKILL.md"), "copy\n");

    const result = await runCmuxSkillInstall({ configDir, homeDir });

    expect(result.status, result.stderr).toBe(0);
    await expectCanonicalCmuxLink(homeDir, sourceDir);
    expect(await readdir(join(homeDir, ".agents", "skills"))).toContainEqual(
      expect.stringMatching(/^cmux-spawn\.disabled\./),
    );
  });

  it("archives active .claude and .codex duplicate cmux-spawn installs", async () => {
    const homeDir = await makeTempDir("symphony-deploy-home-");
    const { configDir, sourceDir } = await makeCmuxSkillSource();
    const claudeDuplicate = join(homeDir, ".claude", "skills", "cmux-spawn");
    const codexDuplicate = join(homeDir, ".codex", "skills", "cmux-spawn");
    await mkdir(claudeDuplicate, { recursive: true });
    await mkdir(codexDuplicate, { recursive: true });
    await writeFile(join(claudeDuplicate, "SKILL.md"), "duplicate\n");
    await writeFile(join(codexDuplicate, "SKILL.md"), "duplicate\n");

    const result = await runCmuxSkillInstall({ configDir, homeDir });

    expect(result.status, result.stderr).toBe(0);
    await expectCanonicalCmuxLink(homeDir, sourceDir);
    await expect(
      readFile(join(claudeDuplicate, "SKILL.md"), "utf8"),
    ).rejects.toThrow();
    await expect(
      readFile(join(codexDuplicate, "SKILL.md"), "utf8"),
    ).rejects.toThrow();
    expect(await readdir(join(homeDir, ".claude", "skills"))).toContainEqual(
      expect.stringMatching(/^cmux-spawn\.disabled\./),
    );
    expect(await readdir(join(homeDir, ".codex", "skills"))).toContainEqual(
      expect.stringMatching(/^cmux-spawn\.disabled\./),
    );
  });
});
