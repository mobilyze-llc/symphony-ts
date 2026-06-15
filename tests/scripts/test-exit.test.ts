import { spawnSync } from "node:child_process";
import {
  chmodSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it } from "vitest";

import { deriveExitCode } from "../../scripts/test-exit.mjs";

const greenReport = JSON.stringify({
  numTotalTestSuites: 85,
  numPassedTestSuites: 84,
  numFailedTestSuites: 0,
  numPendingTestSuites: 1,
  numTotalTests: 1403,
  numPassedTests: 1400,
  numFailedTests: 0,
  numPendingTests: 3,
  success: false,
});

describe("deriveExitCode", () => {
  it("keeps exit 0 for a clean vitest run", () => {
    expect(deriveExitCode(0, null)).toEqual({ code: 0, note: null });
  });

  it("overrides a nonzero exit when the JSON report is all green", () => {
    const result = deriveExitCode(1, greenReport);
    expect(result.code).toBe(0);
    expect(result.note).toContain("all-green summary");
    expect(result.note).toContain("SYMPH-389");
  });

  it("keeps the nonzero exit when tests failed", () => {
    const report = JSON.stringify({
      numTotalTests: 10,
      numFailedTests: 2,
      numFailedTestSuites: 1,
    });
    expect(deriveExitCode(1, report)).toEqual({ code: 1, note: null });
  });

  it("keeps the nonzero exit when a suite failed to load despite zero failed tests", () => {
    const report = JSON.stringify({
      numTotalTests: 10,
      numFailedTests: 0,
      numFailedTestSuites: 1,
    });
    expect(deriveExitCode(1, report)).toEqual({ code: 1, note: null });
  });

  it("keeps the nonzero exit when zero tests ran", () => {
    const report = JSON.stringify({
      numTotalTests: 0,
      numFailedTests: 0,
      numFailedTestSuites: 0,
    });
    expect(deriveExitCode(1, report)).toEqual({ code: 1, note: null });
  });

  it.each([
    ["missing report", null],
    ["empty report", ""],
    ["malformed JSON", "{not json"],
    ["non-object JSON", '"hello"'],
    ["missing counts", JSON.stringify({ success: true })],
    [
      "non-integer counts",
      JSON.stringify({
        numTotalTests: "1403",
        numFailedTests: 0,
        numFailedTestSuites: 0,
      }),
    ],
  ])("falls back to the raw exit code on %s", (_label, reportText) => {
    expect(deriveExitCode(2, reportText)).toEqual({ code: 2, note: null });
  });

  it("maps a signal-killed run (null status) to exit 1", () => {
    expect(deriveExitCode(null, greenReport)).toEqual({ code: 1, note: null });
  });
});

describe("scripts/test.mjs wiring", () => {
  const testDir = dirname(fileURLToPath(import.meta.url));
  const wrapperPath = resolve(testDir, "../../scripts/test.mjs");
  let fakeBinDir: string | null = null;
  let fakeArgsPath: string | null = null;

  afterEach(() => {
    if (fakeBinDir !== null) {
      rmSync(fakeBinDir, { recursive: true, force: true });
      fakeBinDir = null;
      fakeArgsPath = null;
    }
  });

  function installFakeVitest(input: {
    exitCode: number;
    report: string | null;
  }): void {
    fakeBinDir = mkdtempSync(join(tmpdir(), "symphony-fake-vitest-"));
    const reportLiteral =
      input.report === null ? "null" : JSON.stringify(input.report);
    const script = [
      "#!/usr/bin/env node",
      'import { writeFileSync } from "node:fs";',
      "if (process.env.SYMPHONY_FAKE_VITEST_ARGS_PATH !== undefined) {",
      "  writeFileSync(process.env.SYMPHONY_FAKE_VITEST_ARGS_PATH, JSON.stringify(process.argv.slice(2)));",
      "}",
      `const report = ${reportLiteral};`,
      "const outputArg = process.argv.find((arg) => arg.startsWith('--outputFile.json='));",
      "if (report !== null && outputArg !== undefined) {",
      "  writeFileSync(outputArg.slice('--outputFile.json='.length), report);",
      "}",
      "console.log('Test Files  84 passed | 1 skipped');",
      `process.exit(${input.exitCode});`,
    ].join("\n");
    const fakePath = join(fakeBinDir, "vitest");
    fakeArgsPath = join(fakeBinDir, "vitest-args.json");
    writeFileSync(fakePath, script);
    chmodSync(fakePath, 0o755);
  }

  function readFakeVitestArgs(): string[] {
    if (fakeArgsPath === null) {
      throw new Error("installFakeVitest must run first");
    }
    return JSON.parse(readFileSync(fakeArgsPath, "utf8")) as string[];
  }

  function runWrapper(
    extraArgs: string[] = [],
    extraEnv: NodeJS.ProcessEnv = {},
  ) {
    if (fakeBinDir === null) {
      throw new Error("installFakeVitest must run first");
    }
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      ...extraEnv,
      PATH: `${fakeBinDir}:${process.env.PATH}`,
      SYMPHONY_FAKE_VITEST_ARGS_PATH: fakeArgsPath ?? "",
    };
    if (!("AI_AGENT" in extraEnv)) {
      env.AI_AGENT = undefined;
    }
    if (!("SYMPHONY_TEST_AGENT" in extraEnv)) {
      env.SYMPHONY_TEST_AGENT = undefined;
    }
    return spawnSync(process.execPath, [wrapperPath, ...extraArgs], {
      encoding: "utf8",
      env,
    });
  }

  it("exits 0 when fake vitest exits 1 with an all-green JSON report", () => {
    installFakeVitest({ exitCode: 1, report: greenReport });
    const result = runWrapper();
    expect(result.status).toBe(0);
    expect(result.stderr).toContain("all-green summary");
  });

  it("wires verbose and JSON reporters by default", () => {
    installFakeVitest({ exitCode: 0, report: greenReport });
    const result = runWrapper();
    expect(result.status).toBe(0);
    const vitestArgs = readFakeVitestArgs();
    expect(vitestArgs).toContain("--reporter=verbose");
    expect(vitestArgs).toContain("--reporter=json");
    expect(vitestArgs.some((arg) => arg.startsWith("--outputFile.json="))).toBe(
      true,
    );
  });

  it("wires agent and JSON reporters when an agent env var is set", () => {
    installFakeVitest({ exitCode: 0, report: greenReport });
    const result = runWrapper([], { AI_AGENT: "codex" });
    expect(result.status).toBe(0);
    const vitestArgs = readFakeVitestArgs();
    expect(vitestArgs).toContain("--reporter=agent");
    expect(vitestArgs).toContain("--reporter=json");
    expect(vitestArgs).not.toContain("--reporter=verbose");
  });

  it("wires agent and JSON reporters when the repo flag is set", () => {
    installFakeVitest({ exitCode: 0, report: greenReport });
    const result = runWrapper(["--symphony-agent"]);
    expect(result.status).toBe(0);
    const vitestArgs = readFakeVitestArgs();
    expect(vitestArgs).toContain("--reporter=agent");
    expect(vitestArgs).toContain("--reporter=json");
    expect(vitestArgs).not.toContain("--reporter=verbose");
    expect(vitestArgs).not.toContain("--symphony-agent");
  });

  it("strips the package-manager separator before forwarding file filters", () => {
    installFakeVitest({ exitCode: 0, report: greenReport });
    const result = runWrapper(["--", "tests/scripts/test-exit.test.ts"]);
    expect(result.status).toBe(0);
    const vitestArgs = readFakeVitestArgs();
    expect(vitestArgs).toContain("tests/scripts/test-exit.test.ts");
    expect(vitestArgs).not.toContain("--");
  });

  it("propagates a failing exit when the report shows failures", () => {
    installFakeVitest({
      exitCode: 1,
      report: JSON.stringify({
        numTotalTests: 10,
        numFailedTests: 1,
        numFailedTestSuites: 1,
      }),
    });
    const result = runWrapper();
    expect(result.status).toBe(1);
  });

  it("propagates the raw exit when no JSON report is written", () => {
    installFakeVitest({ exitCode: 3, report: null });
    const result = runWrapper();
    expect(result.status).toBe(3);
  });

  it("skips report wiring when the caller passes --reporter", () => {
    installFakeVitest({ exitCode: 1, report: greenReport });
    const result = runWrapper(["--reporter=dot"]);
    // Caller-controlled reporters: no JSON report requested, raw exit wins.
    expect(result.status).toBe(1);
  });

  it("reports a spawn failure instead of exiting silently", () => {
    fakeBinDir = mkdtempSync(join(tmpdir(), "symphony-fake-vitest-"));
    const result = spawnSync(process.execPath, [wrapperPath], {
      encoding: "utf8",
      // PATH without vitest: spawn fails with ENOENT.
      env: { ...process.env, PATH: fakeBinDir },
    });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("failed to spawn vitest");
  });
});
