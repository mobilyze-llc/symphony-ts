import { mkdir, mkdtemp, realpath, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  type ClaudeRunnerCommand,
  extractVerdictEnum,
  runClaudeCmux,
  validateClaudeArtifact,
} from "../../src/claude-runner/cmux-claude-runner.js";

describe("Claude CMUX runner", () => {
  it("rejects summary-only artifacts instead of reporting success", async () => {
    const harness = await createHarness();
    const runCommand: ClaudeRunnerCommand = async (_command, args) => {
      if (args[0] === "preflight") {
        return { exitCode: 0, stdout: "{}", stderr: "" };
      }
      const artifactName = readFlag(args, "--artifact-name");
      const artifactPath = join(harness.artifactDir, `${artifactName}.md`);
      await writeFile(artifactPath, "done\n", "utf8");
      return {
        exitCode: 0,
        stdout: JSON.stringify({
          state: "complete",
          artifact_path: artifactPath,
          status_path: join(harness.artifactDir, `${artifactName}.status.json`),
        }),
        stderr: "",
      };
    };

    const result = await runClaudeCmux(
      {
        purpose: "spec-review",
        workspace: harness.workspace,
        promptFile: harness.promptFile,
        artifactDir: harness.artifactDir,
        artifactName: "opus",
        validation: {
          minBytes: 50,
          requireFirstHeading: "Verdict",
          requiredHeadings: ["Source Read Status"],
          verdictEnums: ["ready_as_written"],
        },
      },
      { runCommand },
    );

    expect(result.status).toBe("invalid_artifact");
    expect(result.validationErrors).toEqual(
      expect.arrayContaining([
        expect.stringContaining("artifact is too small"),
        'artifact first heading must be "Verdict"',
        'artifact is missing required heading "Source Read Status"',
      ]),
    );
  });

  it("retries once with validation errors and accepts the repaired artifact", async () => {
    const harness = await createHarness();
    let runCount = 0;
    const runCommand: ClaudeRunnerCommand = async (_command, args) => {
      if (args[0] === "preflight") {
        return { exitCode: 0, stdout: "{}", stderr: "" };
      }
      runCount += 1;
      const artifactName = readFlag(args, "--artifact-name");
      const artifactPath = join(harness.artifactDir, `${artifactName}.md`);
      await writeFile(
        artifactPath,
        runCount === 1
          ? "done\n"
          : [
              "## Verdict",
              "",
              "Verdict enum: ready_as_written",
              "",
              "## Source Read Status",
              "",
              "Read the prompt and source packet.",
              "",
              "Long enough artifact body for validation to pass.",
            ].join("\n"),
        "utf8",
      );
      return {
        exitCode: 0,
        stdout: JSON.stringify({
          state: "complete",
          artifact_path: artifactPath,
          status_path: join(harness.artifactDir, `${artifactName}.status.json`),
        }),
        stderr: "",
      };
    };

    const result = await runClaudeCmux(
      {
        purpose: "spec-review",
        workspace: harness.workspace,
        promptFile: harness.promptFile,
        artifactDir: harness.artifactDir,
        artifactName: "opus",
        retryOnInvalid: true,
        validation: {
          minBytes: 50,
          requireFirstHeading: "Verdict",
          requiredHeadings: ["Source Read Status"],
          verdictEnums: ["ready_as_written"],
        },
      },
      { runCommand },
    );

    expect(result.status).toBe("passed");
    expect(result.attempts).toHaveLength(2);
    expect(result.attempts[1]?.artifactName).toBe("opus-repair-2");
  });

  it("fails before invocation when a declared source is outside the workspace", async () => {
    const harness = await createHarness();
    let commandCount = 0;
    const result = await runClaudeCmux(
      {
        purpose: "research",
        workspace: harness.workspace,
        promptFile: harness.promptFile,
        artifactDir: harness.artifactDir,
        artifactName: "opus",
        sourcePaths: [join(tmpdir(), "outside-source.md")],
      },
      {
        runCommand: async () => {
          commandCount += 1;
          return { exitCode: 0, stdout: "{}", stderr: "" };
        },
      },
    );

    expect(result.status).toBe("failed");
    expect(commandCount).toBe(0);
    expect(result.sourceVisibility.status).toBe("invalid_source_path");
  });

  it("fails before invocation when a declared source symlinks outside the workspace", async () => {
    const harness = await createHarness();
    const outsideDir = await mkdtemp(join(tmpdir(), "claude-runner-outside-"));
    const outsideSource = join(outsideDir, "source.md");
    const linkedSource = join(harness.workspace, "linked-source.md");
    await writeFile(outsideSource, "outside source\n", "utf8");
    await symlink(outsideSource, linkedSource);

    let commandCount = 0;
    const result = await runClaudeCmux(
      {
        purpose: "research",
        workspace: harness.workspace,
        promptFile: harness.promptFile,
        artifactDir: harness.artifactDir,
        artifactName: "opus",
        sourcePaths: ["linked-source.md"],
      },
      {
        runCommand: async () => {
          commandCount += 1;
          return { exitCode: 0, stdout: "{}", stderr: "" };
        },
      },
    );

    expect(result.status).toBe("failed");
    expect(commandCount).toBe(0);
    expect(result.sourceVisibility.status).toBe("invalid_source_path");
    const canonicalOutsideSource = await realpath(outsideSource);
    expect(result.sourceVisibility.sources[1]).toMatchObject({
      path: "linked-source.md",
      resolvedPath: canonicalOutsideSource,
      insideWorkspace: false,
      readable: false,
      error: "source path is outside workspace",
    });
  });

  it("fails fast when cmux preflight fails", async () => {
    const harness = await createHarness();
    let commandCount = 0;
    const result = await runClaudeCmux(
      {
        purpose: "review",
        workspace: harness.workspace,
        promptFile: harness.promptFile,
        artifactDir: harness.artifactDir,
        artifactName: "opus",
      },
      {
        runCommand: async () => {
          commandCount += 1;
          return {
            exitCode: 2,
            stdout: "",
            stderr: "cmux missing",
          };
        },
      },
    );

    expect(commandCount).toBe(1);
    expect(result.status).toBe("failed");
    expect(result.validationErrors).toEqual(["cmux-spawn preflight failed"]);
    expect(result.message).toBe("cmux missing");
    expect(result.attempts).toEqual([]);
  });

  it("validates allowed verdict enums", async () => {
    const dir = await mkdtemp(join(tmpdir(), "claude-artifact-"));
    const artifact = join(dir, "artifact.md");
    await writeFile(
      artifact,
      [
        "## Verdict",
        "",
        "Verdict enum: needs_operator_context",
        "",
        "## Source Read Status",
        "",
        "Read source.",
      ].join("\n"),
      "utf8",
    );

    await expect(
      validateClaudeArtifact(artifact, {
        minBytes: 20,
        requireFirstHeading: "Verdict",
        requiredHeadings: ["Source Read Status"],
        verdictEnums: ["ready_as_written"],
      }),
    ).resolves.toContain(
      'artifact verdict "needs_operator_context" is not one of ready_as_written',
    );
  });

  it("normalizes artifact verdict enum casing during validation", async () => {
    const dir = await mkdtemp(join(tmpdir(), "claude-artifact-"));
    const artifact = join(dir, "artifact.md");
    await writeFile(
      artifact,
      [
        "## Verdict",
        "",
        "Verdict enum: Ready_As_Written",
        "",
        "## Source Read Status",
        "",
        "Read source.",
      ].join("\n"),
      "utf8",
    );

    await expect(
      validateClaudeArtifact(artifact, {
        minBytes: 20,
        requireFirstHeading: "Verdict",
        requiredHeadings: ["Source Read Status"],
        verdictEnums: ["ready_as_written"],
      }),
    ).resolves.toEqual([]);
  });

  it("does not accept generic status text as the artifact verdict", () => {
    expect(
      extractVerdictEnum(
        [
          "Status: ready_as_written",
          "",
          "## Verdict",
          "Needs more detail.",
        ].join("\n"),
      ),
    ).toBeNull();
    expect(extractVerdictEnum("Verdict enum: ready_as_written")).toBe(
      "ready_as_written",
    );
  });
});

async function createHarness(): Promise<{
  workspace: string;
  artifactDir: string;
  promptFile: string;
}> {
  const workspace = await mkdtemp(join(tmpdir(), "claude-runner-ws-"));
  const artifactDir = join(workspace, ".artifacts");
  await mkdir(artifactDir, { recursive: true });
  const promptFile = join(workspace, "prompt.md");
  await writeFile(promptFile, "Prompt\n", "utf8");
  return { workspace, artifactDir, promptFile };
}

function readFlag(args: readonly string[], flag: string): string {
  const index = args.indexOf(flag);
  const value = args[index + 1];
  if (index < 0 || value === undefined) {
    throw new Error(`Missing ${flag}`);
  }
  return value;
}
