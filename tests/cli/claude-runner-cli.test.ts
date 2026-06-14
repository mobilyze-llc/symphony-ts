import { describe, expect, it, vi } from "vitest";

import type {
  ClaudeCmuxRunnerInput,
  ClaudeRunnerResult,
} from "../../src/claude-runner/cmux-claude-runner.js";
import {
  parseClaudeRunnerArgs,
  runClaudeRunnerCli,
} from "../../src/cli/claude-runner.js";

describe("symphony-claude-runner CLI", () => {
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
          "--min-bytes",
          "100",
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
      minBytes: 100,
      retryOnInvalid: true,
    });
  });

  it("prints help and usage errors through injectable io", async () => {
    const stdout = vi.fn();
    const stderr = vi.fn();

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
      ],
      { runClaude, stdout },
    );

    expect(exitCode).toBe(0);
    expect(runClaude).toHaveBeenCalledWith(
      expect.objectContaining({
        purpose: "spec-review",
        retryOnInvalid: false,
        validation: expect.objectContaining({
          requiredHeadings: ["Source Read Status"],
          verdictEnums: ["ready_as_written"],
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
  input: ClaudeCmuxRunnerInput,
  status: ClaudeRunnerResult["status"],
): ClaudeRunnerResult {
  return {
    schemaVersion: 1,
    status,
    purpose: input.purpose,
    model: input.model ?? "opus",
    profile: input.profile ?? "legacy",
    workspace: input.workspace,
    promptFile: input.promptFile,
    promptSha256: "prompt-hash",
    artifactDir: input.artifactDir,
    artifactName: input.artifactName,
    artifactPath: `${input.artifactDir}/${input.artifactName}.md`,
    resultJsonPath: `${input.artifactDir}/${input.artifactName}.result.json`,
    cmuxSpawnBin: input.cmuxSpawnBin ?? "cmux-spawn",
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
    usage: null,
    message: "ok",
  };
}
