import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, expect, it } from "vitest";

const tempDirs: string[] = [];
const launchdRuntimePath =
  "/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin";

afterEach(async () => {
  await Promise.allSettled(
    tempDirs
      .splice(0)
      .map((path) => rm(path, { recursive: true, force: true })),
  );
});

it("runs review runtime preflight with launchd-shaped PATH", async () => {
  const root = await createTempDir("symphony-deploy-preflight-");
  const symphonyRoot = join(root, "symphony-ts");
  const binDir = join(root, "bin");
  const envFile = join(root, ".env");
  const capturedEnv = join(root, "captured-env.txt");
  const capturedArgs = join(root, "captured-args.txt");
  const fakeNode = join(binDir, "node");

  await mkdir(binDir, { recursive: true });
  await mkdir(symphonyRoot, { recursive: true });
  await writeFile(envFile, "CMUX_SPAWN_BIN=/opt/cmux-spawn\n");
  await writeFile(
    fakeNode,
    [
      "#!/usr/bin/env bash",
      `env > "${capturedEnv}"`,
      `printf '%s\\n' "$*" > "${capturedArgs}"`,
      "exit 0",
      "",
    ].join("\n"),
    { mode: 0o755 },
  );

  const deploy = await readFile("ops/symphony-deploy", "utf8");
  const launchdPathLine = deploy.match(/^LAUNCHD_RUNTIME_PATH=.*$/m)?.[0];
  const snippetStart = deploy.indexOf("run_review_runtime_preflight()");
  const snippetEnd = deploy.indexOf(
    "# Check if symphony-ctl service is installed",
  );
  expect(launchdPathLine).toBeDefined();
  expect(snippetStart).toBeGreaterThanOrEqual(0);
  expect(snippetEnd).toBeGreaterThan(snippetStart);

  const result = spawnSync(
    "bash",
    [
      "-c",
      [
        launchdPathLine,
        deploy.slice(snippetStart, snippetEnd),
        "DRY_RUN=false",
        'SYMPHONY_ROOT="$1"',
        'TMPDIR="$2"',
        'SYMPHONY_NODE="$3"',
        'run_review_runtime_preflight "$4"',
      ].join("\n"),
      "bash",
      symphonyRoot,
      root,
      fakeNode,
      envFile,
    ],
    {
      encoding: "utf8",
      env: {
        HOME: root,
        OUTER_ONLY: "must-not-leak",
        PATH: `${binDir}:/usr/bin:/bin`,
      },
    },
  );

  expect(result.status).toBe(0);
  expect(result.stderr).toBe("");

  const childEnv = await readFile(capturedEnv, "utf8");
  expect(childEnv).toContain(`PATH=${launchdRuntimePath}\n`);
  expect(childEnv).toContain(`HOME=${root}\n`);
  expect(childEnv).not.toContain("OUTER_ONLY=");

  const childArgs = await readFile(capturedArgs, "utf8");
  expect(childArgs).toContain(
    `${symphonyRoot}/dist/src/cli/review-runtime-preflight.js`,
  );
  expect(childArgs).toContain("--workspace");
  expect(childArgs).toContain("--env-file");
});

it("does not restart stopped services after review preflight failure", async () => {
  const root = await createTempDir("symphony-deploy-preflight-fail-");
  const symphonyRoot = join(root, "symphony-ts");
  const binDir = join(root, "bin");
  const envFile = join(root, ".env");
  const restartLog = join(root, "restart.log");
  const fakeNode = join(binDir, "node");
  const fakeCtl = join(binDir, "ctl");

  await mkdir(binDir, { recursive: true });
  await mkdir(symphonyRoot, { recursive: true });
  await writeFile(envFile, "CMUX_SPAWN_BIN=/opt/cmux-spawn\n");
  await writeFile(fakeNode, ["#!/usr/bin/env bash", "exit 42", ""].join("\n"), {
    mode: 0o755,
  });
  await writeFile(
    fakeCtl,
    ["#!/usr/bin/env bash", `printf '%s\\n' "$*" >> "${restartLog}"`, ""].join(
      "\n",
    ),
    { mode: 0o755 },
  );

  const deploy = await readFile("ops/symphony-deploy", "utf8");
  const launchdPathLine = deploy.match(/^LAUNCHD_RUNTIME_PATH=.*$/m)?.[0];
  const snippetStart = deploy.indexOf("run_review_runtime_preflight()");
  const snippetEnd = deploy.indexOf(
    "# Check if symphony-ctl service is installed",
  );
  expect(launchdPathLine).toBeDefined();
  expect(snippetStart).toBeGreaterThanOrEqual(0);
  expect(snippetEnd).toBeGreaterThan(snippetStart);

  const result = spawnSync(
    "bash",
    [
      "-c",
      [
        "warn() { :; }",
        launchdPathLine,
        deploy.slice(snippetStart, snippetEnd),
        "DRY_RUN=false",
        'SYMPHONY_ROOT="$1"',
        'TMPDIR="$2"',
        'SYMPHONY_NODE="$3"',
        'CTL="$4"',
        'SLACK_CTL="$5"',
        "REVIEW_RUNTIME_PREFLIGHT_FAILED=false",
        'run_review_runtime_preflight "$6"',
        "preflight_code=$?",
        "restart_stopped_services_after_error",
        'printf "%s\\n" "$preflight_code" "$REVIEW_RUNTIME_PREFLIGHT_FAILED"',
      ].join("\n"),
      "bash",
      symphonyRoot,
      root,
      fakeNode,
      fakeCtl,
      fakeCtl,
      envFile,
    ],
    {
      encoding: "utf8",
      env: {
        HOME: root,
        PATH: `${binDir}:/usr/bin:/bin`,
      },
    },
  );

  expect(result.status).toBe(0);
  expect(result.stderr).toBe("");
  expect(result.stdout.trim().split("\n")).toEqual(["42", "true"]);

  await expect(readFile(restartLog, "utf8")).rejects.toMatchObject({
    code: "ENOENT",
  });
});

it("exits the deploy block when review preflight fails", async () => {
  const root = await createTempDir("symphony-deploy-preflight-exit-");
  const symphonyRoot = join(root, "symphony-ts");
  const binDir = join(root, "bin");
  const envFile = join(root, ".env");
  const fakeNode = join(binDir, "node");

  await mkdir(binDir, { recursive: true });
  await mkdir(symphonyRoot, { recursive: true });
  await writeFile(envFile, "CMUX_SPAWN_BIN=/opt/cmux-spawn\n");
  await writeFile(fakeNode, ["#!/usr/bin/env bash", "exit 42", ""].join("\n"), {
    mode: 0o755,
  });

  const deploy = await readFile("ops/symphony-deploy", "utf8");
  const launchdPathLine = deploy.match(/^LAUNCHD_RUNTIME_PATH=.*$/m)?.[0];
  const helperStart = deploy.indexOf("run_review_runtime_preflight()");
  const helperEnd = deploy.indexOf(
    "# Check if symphony-ctl service is installed",
  );
  const blockStart = deploy.indexOf(
    '  if [[ -f "$local_env" ]]; then\n    info "Checking review runtime preflight..."',
  );
  const blockEnd = deploy.indexOf("\n\n  # Prune stale branches", blockStart);
  expect(launchdPathLine).toBeDefined();
  expect(helperStart).toBeGreaterThanOrEqual(0);
  expect(helperEnd).toBeGreaterThan(helperStart);
  expect(blockStart).toBeGreaterThanOrEqual(0);
  expect(blockEnd).toBeGreaterThan(blockStart);

  const result = spawnSync(
    "bash",
    [
      "-c",
      [
        "set -eEuo pipefail",
        "info() { :; }",
        'ok() { printf "ok:%s\\n" "$*"; }',
        "warn() { :; }",
        'die() { printf "die:%s\\n" "$*" >&2; exit 1; }',
        launchdPathLine,
        deploy.slice(helperStart, helperEnd),
        "DRY_RUN=false",
        "NO_RESTART=false",
        'SYMPHONY_ROOT="$1"',
        'TMPDIR="$2"',
        'SYMPHONY_NODE="$3"',
        'local_env="$4"',
        "NEED_SERVICE_REINSTALL=false",
        "service_installed() { return 0; }",
        deploy.slice(blockStart, blockEnd),
        'printf "continued:%s\\n" "$NEED_SERVICE_REINSTALL"',
      ].join("\n"),
      "bash",
      symphonyRoot,
      root,
      fakeNode,
      envFile,
    ],
    {
      encoding: "utf8",
      env: {
        HOME: root,
        PATH: `${binDir}:/usr/bin:/bin`,
      },
    },
  );

  expect(result.status).toBe(42);
  expect(result.stdout).not.toContain("ok:Review runtime preflight passed");
  expect(result.stdout).not.toContain("continued:");
});

it("fails clearly when node is unavailable for review preflight", async () => {
  const root = await createTempDir("symphony-deploy-preflight-no-node-");
  const envFile = join(root, ".env");
  await writeFile(envFile, "CMUX_SPAWN_BIN=/opt/cmux-spawn\n");

  const deploy = await readFile("ops/symphony-deploy", "utf8");
  const launchdPathLine = deploy.match(/^LAUNCHD_RUNTIME_PATH=.*$/m)?.[0];
  const snippetStart = deploy.indexOf("run_review_runtime_preflight()");
  const snippetEnd = deploy.indexOf(
    "# Check if symphony-ctl service is installed",
  );
  expect(launchdPathLine).toBeDefined();
  expect(snippetStart).toBeGreaterThanOrEqual(0);
  expect(snippetEnd).toBeGreaterThan(snippetStart);

  const result = spawnSync(
    "bash",
    [
      "-c",
      [
        'die() { printf "%s\\n" "$*" >&2; exit 1; }',
        launchdPathLine,
        deploy.slice(snippetStart, snippetEnd),
        "DRY_RUN=false",
        'SYMPHONY_ROOT="$1"',
        'TMPDIR="$2"',
        "unset SYMPHONY_NODE",
        'run_review_runtime_preflight "$3"',
      ].join("\n"),
      "bash",
      root,
      root,
      envFile,
    ],
    {
      encoding: "utf8",
      env: {
        HOME: root,
        PATH: "/usr/bin:/bin",
      },
    },
  );

  expect(result.status).toBe(1);
  expect(result.stderr).toContain("node not found");
  expect(result.stderr).not.toContain("/opt/homebrew/bin/node");
});

async function createTempDir(prefix: string): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), prefix));
  tempDirs.push(path);
  return path;
}
