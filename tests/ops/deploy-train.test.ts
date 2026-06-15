import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { afterEach, expect, it } from "vitest";

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.allSettled(
    tempDirs
      .splice(0)
      .map((path) => rm(path, { recursive: true, force: true })),
  );
});

it("aborts when origin/main moves after the deploy train captures its expected SHA", async () => {
  const root = await createTempDir("symphony-deploy-train-moving-main-");
  const { source, runtime } = await createGitFixture(root);
  const initialSha = gitStdout(runtime, ["rev-parse", "origin/main"]);

  await commitAndPush(source, "second");

  const result = runMovingMainGuard(runtime, {
    expectedFullSha: initialSha,
    expectedShortSha: initialSha.slice(0, 7),
    expectOverride: "",
    checkpoint: "service stop",
  });

  expect(result.status).toBe(97);
  expect(result.stderr).toContain(
    "origin/main moved during deploy train before service stop",
  );
  expect(result.stderr).toContain(initialSha.slice(0, 12));
});

it("allows the deploy train to proceed when origin/main is unchanged", async () => {
  const root = await createTempDir("symphony-deploy-train-stable-main-");
  const { runtime } = await createGitFixture(root);
  const initialSha = gitStdout(runtime, ["rev-parse", "origin/main"]);

  const result = runMovingMainGuard(runtime, {
    expectedFullSha: initialSha,
    expectedShortSha: initialSha.slice(0, 7),
    expectOverride: "",
    checkpoint: "drain gate",
  });

  expect(result.status).toBe(0);
  expect(result.stdout).toContain(
    `origin/main unchanged (${initialSha.slice(0, 7)})`,
  );
});

it("treats --expect as an explicit pinned deploy override", async () => {
  const root = await createTempDir("symphony-deploy-train-expect-override-");
  const { source, runtime } = await createGitFixture(root);
  const initialSha = gitStdout(runtime, ["rev-parse", "origin/main"]);

  await commitAndPush(source, "second");

  const result = runMovingMainGuard(runtime, {
    expectedFullSha: "",
    expectedShortSha: initialSha.slice(0, 7),
    expectOverride: initialSha,
    checkpoint: "service start",
  });

  expect(result.status).toBe(0);
  expect(result.stdout).toContain(
    `Skipping moving origin/main guard before service start (--expect pins ${initialSha.slice(0, 7)})`,
  );
});

async function createGitFixture(root: string): Promise<{
  origin: string;
  runtime: string;
  source: string;
}> {
  const origin = join(root, "origin.git");
  const source = join(root, "source");
  const runtime = join(root, "runtime");

  git(root, ["init", "--bare", origin]);
  await mkdir(source, { recursive: true });
  git(source, ["init", "-b", "main"]);
  git(source, ["config", "user.email", "agent@example.com"]);
  git(source, ["config", "user.name", "Agent"]);
  await writeFile(join(source, "README.md"), "first\n");
  git(source, ["add", "README.md"]);
  git(source, ["commit", "-m", "first"]);
  git(source, ["remote", "add", "origin", origin]);
  git(source, ["push", "-u", "origin", "main"]);
  git(root, ["clone", origin, runtime]);
  git(runtime, ["fetch", "origin"]);

  return { origin, runtime, source };
}

async function commitAndPush(source: string, content: string): Promise<void> {
  await writeFile(join(source, "README.md"), `${content}\n`);
  git(source, ["add", "README.md"]);
  git(source, ["commit", "-m", content]);
  git(source, ["push", "origin", "main"]);
}

function runMovingMainGuard(
  runtime: string,
  input: {
    checkpoint: string;
    expectedFullSha: string;
    expectedShortSha: string;
    expectOverride: string;
  },
): ReturnType<typeof spawnSync> {
  const deploy = readFileSync(resolve("ops/deploy-train.sh"), "utf8");
  const extractedHelpers = [
    extractShellFunction(deploy, "full_sha"),
    extractShellFunction(deploy, "assert_origin_main_unchanged"),
  ].join("\n");
  expect(extractedHelpers).toContain("full_sha()");
  expect(extractedHelpers).toContain("assert_origin_main_unchanged()");
  expect(extractedHelpers).not.toContain("same_path()");
  expect(extractedHelpers).not.toContain("file_size()");

  return spawnSync(
    "bash",
    [
      "-c",
      [
        "set -euo pipefail",
        'info() { printf "info:%s\\n" "$*"; }',
        'ok() { printf "ok:%s\\n" "$*"; }',
        'die() { printf "%s\\n" "$*" >&2; exit 97; }',
        `EXPECT_OVERRIDE=${bashQuote(input.expectOverride)}`,
        `EXPECTED_SHA=${bashQuote(input.expectedShortSha)}`,
        `EXPECTED_FULL_SHA=${bashQuote(input.expectedFullSha)}`,
        'RUNTIME_CHECKOUT="$1"',
        extractedHelpers,
        'assert_origin_main_unchanged "$2"',
      ].join("\n"),
      "bash",
      runtime,
      input.checkpoint,
    ],
    {
      encoding: "utf8",
      env: {
        HOME: runtime,
        PATH: "/usr/bin:/bin",
      },
    },
  );
}

function extractShellFunction(source: string, name: string): string {
  const lines = source.split("\n");
  const start = lines.findIndex((line) => line === `${name}() {`);
  expect(start).toBeGreaterThanOrEqual(0);

  const end = lines.findIndex((line, index) => index > start && line === "}");
  expect(end).toBeGreaterThan(start);

  return lines.slice(start, end + 1).join("\n");
}

function git(cwd: string, args: string[]): ReturnType<typeof spawnSync> {
  const result = spawnSync("git", args, {
    cwd,
    encoding: "utf8",
    env: {
      HOME: cwd,
      PATH: "/usr/bin:/bin",
    },
  });
  if (result.status !== 0) {
    throw new Error(
      `git ${args.join(" ")} failed\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`,
    );
  }
  return result;
}

function gitStdout(cwd: string, args: string[]): string {
  return String(git(cwd, args).stdout).trim();
}

async function createTempDir(prefix: string): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), prefix));
  tempDirs.push(path);
  return path;
}

function bashQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}
