import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  parseDotenv,
  parseReviewRuntimePreflightArgs,
  runReviewRuntimePreflightCli,
} from "../../src/cli/review-runtime-preflight.js";

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.allSettled(
    tempDirs
      .splice(0)
      .map((path) => rm(path, { recursive: true, force: true })),
  );
});

describe("parseReviewRuntimePreflightArgs", () => {
  it("parses workspace, env-file, and machine output flags", () => {
    expect(
      parseReviewRuntimePreflightArgs(
        [
          "--workspace",
          "product",
          "--env-file",
          ".env",
          "--allow-symphony-workspace",
          "--skip-cmux-preflight",
          "--json",
        ],
        "/repo",
      ),
    ).toEqual({
      workspace: "/repo/product",
      envFile: "/repo/.env",
      allowSymphonyWorkspace: true,
      skipCmuxPreflight: true,
      json: true,
      help: false,
    });
  });
});

describe("parseDotenv", () => {
  it("parses quoted and unquoted deployment env values", () => {
    expect(
      parseDotenv(`
# comment
export CMUX_SPAWN_BIN="/opt/cmux-spawn"
export	REVIEW_GATE_ALT=/opt/alt-gate
SYMPHONY_COUNCIL_REVIEW_GATE='/opt/symphony-council-review-gate'
PATH=/opt/bin:/usr/bin # operator shell
ignored
`),
    ).toEqual({
      CMUX_SPAWN_BIN: "/opt/cmux-spawn",
      REVIEW_GATE_ALT: "/opt/alt-gate",
      SYMPHONY_COUNCIL_REVIEW_GATE: "/opt/symphony-council-review-gate",
      PATH: "/opt/bin:/usr/bin",
    });
  });
});

describe("runReviewRuntimePreflightCli", () => {
  it("passes from a product workspace when env-file binaries are executable", async () => {
    const root = await createTempDir("review-runtime-preflight-pass-");
    const workspace = join(root, "product");
    const bin = join(root, "bin");
    await mkdir(workspace, { recursive: true });
    await mkdir(bin, { recursive: true });
    await writeFile(join(workspace, "package.json"), '{"name":"product"}\n');

    const gate = await writeExecutable(
      join(bin, "symphony-council-review-gate"),
      `#!/usr/bin/env sh
test "$1" = "--help"
`,
    );
    const cmux = await writeExecutable(
      join(bin, "cmux-spawn"),
      `#!/usr/bin/env sh
test "$1" = "preflight"
test "$2" = "--caffeinate"
test "$3" = "--json"
printf '{"ok":true}\\n'
`,
    );
    const envFile = join(root, ".env");
    await writeFile(
      envFile,
      `SYMPHONY_COUNCIL_REVIEW_GATE=${gate}\nCMUX_SPAWN_BIN=${cmux}\n`,
    );

    const execCalls: string[][] = [];
    const stdout: string[] = [];
    const stderr: string[] = [];
    const exitCode = await runReviewRuntimePreflightCli(
      ["--workspace", workspace, "--env-file", envFile, "--json"],
      {
        env: { PATH: "/usr/bin:/bin" },
        stdout: (message) => stdout.push(message),
        stderr: (message) => stderr.push(message),
        execFile: async (file, args) => {
          execCalls.push([file, ...args]);
          return { stdout: "", stderr: "" };
        },
      },
    );

    expect(exitCode).toBe(0);
    expect(stderr.join("")).toBe("");
    const result = JSON.parse(stdout.join("")) as { status: string };
    expect(result.status).toBe("passed");
    expect(execCalls).toEqual([
      [gate, "--help"],
      [cmux, "preflight", "--caffeinate", "--json"],
    ]);
  });

  it("resolves relative executable env paths from the product workspace", async () => {
    const root = await createTempDir("review-runtime-preflight-relative-");
    const workspace = join(root, "product");
    const bin = join(workspace, "bin");
    await mkdir(bin, { recursive: true });
    await writeFile(join(workspace, "package.json"), '{"name":"product"}\n');

    await writeExecutable(
      join(bin, "symphony-council-review-gate"),
      "#!/usr/bin/env sh\nexit 0\n",
    );
    await writeExecutable(
      join(bin, "cmux-spawn"),
      "#!/usr/bin/env sh\nexit 0\n",
    );
    const envFile = join(root, ".env");
    await writeFile(
      envFile,
      "SYMPHONY_COUNCIL_REVIEW_GATE=./bin/symphony-council-review-gate\nCMUX_SPAWN_BIN=./bin/cmux-spawn\n",
    );

    const execCalls: string[][] = [];
    const exitCode = await runReviewRuntimePreflightCli(
      ["--workspace", workspace, "--env-file", envFile, "--json"],
      {
        cwd: root,
        env: { PATH: "/usr/bin:/bin" },
        stdout: () => undefined,
        stderr: () => undefined,
        execFile: async (file, args) => {
          execCalls.push([file, ...args]);
          return { stdout: "", stderr: "" };
        },
      },
    );

    expect(exitCode).toBe(0);
    expect(execCalls).toEqual([
      [join(bin, "symphony-council-review-gate"), "--help"],
      [join(bin, "cmux-spawn"), "preflight", "--caffeinate", "--json"],
    ]);
  });

  it("fails when executable env overrides are bare PATH commands", async () => {
    const root = await createTempDir("review-runtime-preflight-bare-env-");
    const workspace = join(root, "product");
    const bin = join(root, "bin");
    await mkdir(workspace, { recursive: true });
    await mkdir(bin, { recursive: true });
    await writeFile(join(workspace, "package.json"), '{"name":"product"}\n');
    await writeExecutable(
      join(bin, "symphony-council-review-gate"),
      "#!/usr/bin/env sh\nexit 0\n",
    );
    await writeExecutable(
      join(bin, "cmux-spawn"),
      "#!/usr/bin/env sh\nexit 0\n",
    );
    const envFile = join(root, ".env");
    await writeFile(
      envFile,
      "SYMPHONY_COUNCIL_REVIEW_GATE=symphony-council-review-gate\nCMUX_SPAWN_BIN=cmux-spawn\n",
    );

    const stdout: string[] = [];
    const exitCode = await runReviewRuntimePreflightCli(
      ["--workspace", workspace, "--env-file", envFile, "--json"],
      {
        env: { PATH: `${bin}:/usr/bin:/bin` },
        stdout: (message) => stdout.push(message),
        stderr: () => undefined,
        execFile: async () => ({ stdout: "", stderr: "" }),
      },
    );

    expect(exitCode).toBe(1);
    expect(stdout.join("")).toContain(
      "env overrides must be absolute or workspace-relative executable paths",
    );
  });

  it("fails from a symphony-ts checkout so the smoke cannot pass via dist fallback", async () => {
    const root = await createTempDir("review-runtime-preflight-symphony-");
    await mkdir(join(root, "dist/src/cli"), { recursive: true });
    await writeFile(join(root, "package.json"), '{"name":"symphony-ts"}\n');
    await writeFile(join(root, "dist/src/cli/council-review-gate.js"), "\n");

    const stderr: string[] = [];
    const exitCode = await runReviewRuntimePreflightCli(
      [
        "--workspace",
        root,
        "--skip-cmux-preflight",
        "--env-file",
        await envFileWithFakeBinaries(root),
      ],
      {
        env: { PATH: "/usr/bin:/bin" },
        stdout: () => undefined,
        stderr: (message) => stderr.push(message),
        execFile: async () => ({ stdout: "", stderr: "" }),
      },
    );

    expect(exitCode).toBe(1);
    expect(stderr.join("")).toContain("not the symphony-ts checkout");
  });

  it("does not run executable smoke checks from a rejected workspace", async () => {
    const root = await createTempDir("review-runtime-preflight-rejected-");
    await mkdir(join(root, "dist/src/cli"), { recursive: true });
    await writeFile(join(root, "package.json"), '{"name":"symphony-ts"}\n');
    await writeFile(join(root, "dist/src/cli/council-review-gate.js"), "\n");

    let execCalls = 0;
    const exitCode = await runReviewRuntimePreflightCli(
      ["--workspace", root, "--env-file", await envFileWithFakeBinaries(root)],
      {
        env: { PATH: "/usr/bin:/bin" },
        stdout: () => undefined,
        stderr: () => undefined,
        execFile: async () => {
          execCalls += 1;
          return { stdout: "", stderr: "" };
        },
      },
    );

    expect(exitCode).toBe(1);
    expect(execCalls).toBe(0);
  });

  it("fails closed with the review-stage cmux guidance when cmux-spawn is missing", async () => {
    const root = await createTempDir("review-runtime-preflight-missing-cmux-");
    const workspace = join(root, "product");
    const bin = join(root, "bin");
    await mkdir(workspace, { recursive: true });
    await mkdir(bin, { recursive: true });
    await writeFile(join(workspace, "package.json"), '{"name":"product"}\n');
    await writeExecutable(
      join(bin, "symphony-council-review-gate"),
      "#!/usr/bin/env sh\nexit 0\n",
    );

    const stderr: string[] = [];
    const exitCode = await runReviewRuntimePreflightCli(
      ["--workspace", workspace, "--skip-cmux-preflight"],
      {
        env: { PATH: `${bin}:/usr/bin:/bin` },
        stdout: () => undefined,
        stderr: (message) => stderr.push(message),
        execFile: async () => ({ stdout: "", stderr: "" }),
      },
    );

    expect(exitCode).toBe(1);
    expect(stderr.join("")).toContain(
      "Set CMUX_SPAWN_BIN to an executable cmux-spawn path or put cmux-spawn on PATH.",
    );
  });
});

async function createTempDir(prefix: string): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), prefix));
  tempDirs.push(path);
  return path;
}

async function writeExecutable(
  path: string,
  contents: string,
): Promise<string> {
  await writeFile(path, contents);
  await chmod(path, 0o755);
  return path;
}

async function envFileWithFakeBinaries(root: string): Promise<string> {
  const bin = join(root, "bin");
  await mkdir(bin, { recursive: true });
  const gate = await writeExecutable(
    join(bin, "symphony-council-review-gate"),
    "#!/usr/bin/env sh\nexit 0\n",
  );
  const cmux = await writeExecutable(
    join(bin, "cmux-spawn"),
    "#!/usr/bin/env sh\nexit 0\n",
  );
  const envFile = join(root, ".env");
  await writeFile(
    envFile,
    `SYMPHONY_COUNCIL_REVIEW_GATE=${gate}\nCMUX_SPAWN_BIN=${cmux}\n`,
  );
  return envFile;
}
