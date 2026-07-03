import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it, vi } from "vitest";

import type { ClaudeRunnerResult } from "../../src/claude-runner/cmux-claude-runner.js";
import type { ClaudeCrabrunnerRunnerInput } from "../../src/claude-runner/crabrunner-claude-runner.js";
import {
  parseClaudeRunnerArgs,
  runClaudeRunnerCli,
} from "../../src/cli/claude-runner.js";

describe("claude-runner CLI", () => {
  it("uses claude-runner as the package binary name", () => {
    const packageJson = JSON.parse(
      readFileSync(resolve(__dirname, "../../package.json"), "utf8"),
    ) as { bin?: Record<string, string> };

    expect(packageJson.bin).toMatchObject({
      "claude-runner": "./dist/src/cli/claude-runner.js",
    });
    expect(packageJson.bin).not.toHaveProperty("symphony-claude-runner");
  });

  it("parses required paths, validators, sources, and retry mode", () => {
    expect(
      parseClaudeRunnerArgs(
        [
          "--purpose",
          "research",
          "--workspace",
          "repo",
          "--prompt-file",
          "repo/prompt.md",
          "--artifact-dir",
          "repo/artifacts",
          "--artifact-name",
          "opus",
          "--source",
          "src/a.ts",
          "--required-heading",
          "Verdict",
          "--require-first-heading",
          "Verdict",
          "--verdict-enum",
          "ready",
          "--required-json-section",
          "Reconciliation JSON",
          "--min-bytes",
          "100",
          "--diagnostic-byte-limit",
          "512",
          "--retry-on-invalid",
        ],
        "/tmp",
      ),
    ).toMatchObject({
      purpose: "research",
      workspace: "/tmp/repo",
      promptFile: "/tmp/repo/prompt.md",
      artifactDir: "/tmp/repo/artifacts",
      artifactName: "opus",
      sourcePaths: ["src/a.ts"],
      requiredHeadings: ["Verdict"],
      requireFirstHeading: "Verdict",
      verdictEnums: ["ready"],
      requiredJsonSections: ["Reconciliation JSON"],
      minBytes: 100,
      diagnosticByteLimit: 512,
      retryOnInvalid: true,
    });
  });

  it("prints help and usage errors through injectable io", async () => {
    const stdout = vi.fn();
    const stderr = vi.fn();
    const runClaude = vi.fn(async (input) => makeResult(input, "passed"));

    await expect(
      runClaudeRunnerCli(["--help"], { stdout, stderr }),
    ).resolves.toBe(0);
    expect(stdout).toHaveBeenCalledWith(expect.stringContaining("Usage:"));

    await expect(runClaudeRunnerCli([], { stdout, stderr })).resolves.toBe(2);
    expect(stderr).toHaveBeenCalledWith(
      expect.stringContaining("--workspace is required"),
    );

    await expect(
      runClaudeRunnerCli(["--purpose", "surprise"], { stdout, stderr }),
    ).resolves.toBe(2);
    expect(stderr).toHaveBeenCalledWith(
      expect.stringContaining("--purpose must be one of"),
    );

    await expect(
      runClaudeRunnerCli(
        [
          "--purpose",
          "custom",
          "--workspace",
          "/repo",
          "--prompt-file",
          "/repo/prompt.md",
          "--artifact-dir",
          "/repo/artifacts",
          "--artifact-name",
          "../opus",
        ],
        { runClaude, stdout, stderr },
      ),
    ).resolves.toBe(2);
    expect(stderr).toHaveBeenCalledWith(
      expect.stringContaining("--artifact-name must be a basename"),
    );

    await expect(
      runClaudeRunnerCli(
        [
          "--purpose",
          "custom",
          "--workspace",
          "/repo",
          "--prompt-file",
          "/repo/prompt.md",
          "--artifact-dir",
          "/repo/artifacts",
          "--artifact-name",
          "opus",
          "--diagnostic-byte-limit",
          "262145",
        ],
        { runClaude, stdout, stderr },
      ),
    ).resolves.toBe(2);
    expect(stderr).toHaveBeenCalledWith(
      expect.stringContaining("--diagnostic-byte-limit must be <="),
    );
    expect(runClaude).not.toHaveBeenCalled();
  });

  it("passes parsed input to the runner and maps runner status to exit code", async () => {
    const stdout = vi.fn();
    const runClaude = vi.fn(async (input) => makeResult(input, "passed"));

    const exitCode = await runClaudeRunnerCli(
      [
        "--purpose",
        "spec-review",
        "--workspace",
        "/repo",
        "--prompt-file",
        "/repo/prompt.md",
        "--artifact-dir",
        "/repo/artifacts",
        "--artifact-name",
        "opus",
        "--required-heading",
        "Source Read Status",
        "--verdict-enum",
        "ready_as_written",
        "--required-json-section",
        "Reconciliation JSON",
        "--diagnostic-byte-limit",
        "1024",
      ],
      { runClaude, stdout },
    );

    expect(exitCode).toBe(0);
    expect(runClaude).toHaveBeenCalledWith(
      expect.objectContaining({
        purpose: "spec-review",
        retryOnInvalid: false,
        diagnosticByteLimit: 1024,
        validation: expect.objectContaining({
          requiredHeadings: ["Source Read Status"],
          verdictEnums: ["ready_as_written"],
          requiredJsonSections: ["Reconciliation JSON"],
        }),
      }),
    );
    expect(JSON.parse(String(stdout.mock.calls[0]?.[0]))).toMatchObject({
      status: "passed",
      purpose: "spec-review",
    });

    await expect(
      runClaudeRunnerCli(
        [
          "--purpose",
          "custom",
          "--workspace",
          "/repo",
          "--prompt-file",
          "/repo/prompt.md",
          "--artifact-dir",
          "/repo/artifacts",
          "--artifact-name",
          "opus",
        ],
        {
          runClaude: async (input) => makeResult(input, "invalid_artifact"),
          stdout: vi.fn(),
        },
      ),
    ).resolves.toBe(1);
  });
});

function makeResult(
  input: ClaudeCrabrunnerRunnerInput,
  status: ClaudeRunnerResult["status"],
): ClaudeRunnerResult {
  return {
    schemaVersion: 1,
    status,
    purpose: input.purpose,
    model: input.model ?? "opus",
    profile: input.profile ?? "read-only",
    workspace: input.workspace,
    promptFile: input.promptFile,
    promptSha256: "prompt-hash",
    artifactDir: input.artifactDir,
    artifactName: input.artifactName,
    artifactPath: `${input.artifactDir}/${input.artifactName}.md`,
    resultJsonPath: `${input.artifactDir}/${input.artifactName}.result.json`,
    cmuxSpawnBin: input.crabrunnerBin ?? "crabrunner",
    laneId: "claude-custom",
    phase: input.purpose,
    startedAt: "2026-06-14T00:00:00.000Z",
    completedAt: "2026-06-14T00:00:01.000Z",
    sourceVisibility: {
      status: "ok",
      workspace: input.workspace,
      sources: [],
    },
    attempts: [],
    validationErrors: [],
    diagnostics: {
      diagnosticByteLimit: 16 * 1024,
      preflight: null,
      attempts: [],
    },
    usage: null,
    message: "ok",
  };
}
