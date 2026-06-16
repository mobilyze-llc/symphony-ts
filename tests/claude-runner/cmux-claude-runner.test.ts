import { createHash } from "node:crypto";
import {
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  symlink,
  utimes,
  writeFile,
} from "node:fs/promises";
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
          requiredJsonSections: ["Reconciliation JSON"],
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

  it("bounds stdout and stderr diagnostics in the normalized result", async () => {
    const harness = await createHarness();
    const noisyStderr = "é".repeat(20);
    const runCommand: ClaudeRunnerCommand = async (_command, args) => {
      if (args[0] === "preflight") {
        return { exitCode: 0, stdout: "preflight-ok", stderr: "" };
      }
      const artifactName = readFlag(args, "--artifact-name");
      const artifactPath = join(harness.artifactDir, `${artifactName}.md`);
      await writeFile(artifactPath, validReviewArtifact(), "utf8");
      return {
        exitCode: 0,
        stdout: JSON.stringify({
          state: "complete",
          artifact_path: artifactPath,
          status_path: join(harness.artifactDir, `${artifactName}.status.json`),
          message: "complete",
        }),
        stderr: noisyStderr,
      };
    };

    const result = await runClaudeCmux(
      {
        purpose: "spec-review",
        workspace: harness.workspace,
        promptFile: harness.promptFile,
        artifactDir: harness.artifactDir,
        artifactName: "opus",
        diagnosticByteLimit: 13,
        validation: {
          minBytes: 50,
          requireFirstHeading: "Verdict",
          requiredHeadings: ["Source Read Status"],
          requiredJsonSections: ["Reconciliation JSON"],
          verdictEnums: ["ready_as_written"],
          requireSourceReadStatus: true,
        },
      },
      { runCommand },
    );

    expect(result.status).toBe("passed");
    expect(result.diagnostics.diagnosticByteLimit).toBe(13);
    expect(result.diagnostics.preflight?.stdout).toMatchObject({
      text: "preflight-ok",
      truncated: false,
      omittedBytes: 0,
    });
    expect(result.diagnostics.attempts[0]?.stdout).toMatchObject({
      truncated: true,
      maxBytes: 13,
    });
    expect(result.diagnostics.attempts[0]?.stderr).toMatchObject({
      text: "é".repeat(6),
      originalBytes: 40,
      omittedBytes: 28,
      truncated: true,
      maxBytes: 13,
    });
  });

  it("rejects oversized diagnostic byte limits before invoking cmux", async () => {
    const harness = await createHarness();
    let commandCount = 0;

    await expect(
      runClaudeCmux(
        {
          purpose: "spec-review",
          workspace: harness.workspace,
          promptFile: harness.promptFile,
          artifactDir: harness.artifactDir,
          artifactName: "opus",
          diagnosticByteLimit: 256 * 1024 + 1,
        },
        {
          runCommand: async () => {
            commandCount += 1;
            return { exitCode: 0, stdout: "{}", stderr: "" };
          },
        },
      ),
    ).rejects.toThrow("diagnosticByteLimit must be <=");

    expect(commandCount).toBe(0);
  });

  it("rejects unsafe artifact names before invoking cmux", async () => {
    const harness = await createHarness();
    let commandCount = 0;

    await expect(
      runClaudeCmux(
        {
          purpose: "spec-review",
          workspace: harness.workspace,
          promptFile: harness.promptFile,
          artifactDir: harness.artifactDir,
          artifactName: "../opus",
        },
        {
          runCommand: async () => {
            commandCount += 1;
            return { exitCode: 0, stdout: "{}", stderr: "" };
          },
        },
      ),
    ).rejects.toThrow("artifactName must be a basename");

    expect(commandCount).toBe(0);
  });

  it("uses a repair fence that cannot be closed by prior artifact fences", async () => {
    const harness = await createHarness();
    let runCount = 0;
    let repairPrompt = "";
    const runCommand: ClaudeRunnerCommand = async (_command, args) => {
      if (args[0] === "preflight") {
        return { exitCode: 0, stdout: "{}", stderr: "" };
      }
      runCount += 1;
      const artifactName = readFlag(args, "--artifact-name");
      const artifactPath = join(harness.artifactDir, `${artifactName}.md`);
      if (runCount === 1) {
        await writeFile(
          artifactPath,
          ["Previous artifact", "", "```json", '{"ok":false}', "```"].join(
            "\n",
          ),
          "utf8",
        );
      } else {
        repairPrompt = await readFile(readFlag(args, "--prompt-file"), "utf8");
        await writeFile(artifactPath, validReviewArtifact(), "utf8");
      }
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
    expect(repairPrompt).toContain("````markdown\n");
    expect(repairPrompt).toContain("```json");
    expect(repairPrompt).toContain("\n````\n");
  });

  it("allows generated prompt and artifact files outside the workspace", async () => {
    const harness = await createHarness();
    const externalArtifactDir = await mkdtemp(
      join(tmpdir(), "claude-runner-artifacts-"),
    );
    const externalPromptFile = join(externalArtifactDir, "prompt.md");
    await writeFile(externalPromptFile, "Generated prompt\n", "utf8");
    const runCommand: ClaudeRunnerCommand = async (_command, args) => {
      if (args[0] === "preflight") {
        return { exitCode: 0, stdout: "{}", stderr: "" };
      }
      const artifactName = readFlag(args, "--artifact-name");
      const artifactPath = join(externalArtifactDir, `${artifactName}.md`);
      await writeFile(artifactPath, validReviewArtifact(), "utf8");
      return {
        exitCode: 0,
        stdout: JSON.stringify({
          state: "complete",
          artifact_path: artifactPath,
          status_path: join(externalArtifactDir, `${artifactName}.status.json`),
        }),
        stderr: "",
      };
    };

    const result = await runClaudeCmux(
      {
        purpose: "spec-review",
        workspace: harness.workspace,
        promptFile: externalPromptFile,
        artifactDir: externalArtifactDir,
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

    expect(result.status).toBe("passed");
    expect(result.sourceVisibility.status).toBe("ok");
    expect(result.sourceVisibility.sources[0]).toMatchObject({
      kind: "prompt",
      path: externalPromptFile,
      readable: true,
      insideWorkspace: false,
      error: null,
    });
  });

  it("rejects cmux artifact paths outside the artifact dir without repair reads", async () => {
    const harness = await createHarness();
    const outsideDir = await mkdtemp(join(tmpdir(), "claude-runner-outside-"));
    const outsideArtifact = join(outsideDir, "opus.md");
    await writeFile(outsideArtifact, validReviewArtifact(), "utf8");
    let runCount = 0;
    const runCommand: ClaudeRunnerCommand = async (_command, args) => {
      if (args[0] === "preflight") {
        return { exitCode: 0, stdout: "{}", stderr: "" };
      }
      runCount += 1;
      return {
        exitCode: 0,
        stdout: JSON.stringify({
          state: "complete",
          artifact_path: outsideArtifact,
          status_path: join(harness.artifactDir, "opus.status.json"),
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

    expect(runCount).toBe(1);
    expect(result.status).toBe("invalid_artifact");
    expect(result.remoteArtifactPath).toBeNull();
    expect(result.attempts).toHaveLength(1);
    expect(result.validationErrors).toEqual(
      expect.arrayContaining([
        expect.stringContaining("artifact_path resolves outside artifact dir"),
        expect.stringContaining("mirror fallback local mirror is absent"),
      ]),
    );
  });

  it("accepts a same-stem local mirror for remote cmux artifact paths", async () => {
    const harness = await createHarness();
    const outsideDir = await mkdtemp(join(tmpdir(), "claude-runner-remote-"));
    const remoteArtifact = join(outsideDir, "opus.md");
    const mirroredArtifact = join(harness.artifactDir, "opus.md");
    const artifact = validReviewArtifact();
    const artifactSha256 = createHash("sha256").update(artifact).digest("hex");
    const runCommand: ClaudeRunnerCommand = async (_command, args) => {
      if (args[0] === "preflight") {
        return { exitCode: 0, stdout: "{}", stderr: "" };
      }
      await writeFile(mirroredArtifact, artifact, "utf8");
      return {
        exitCode: 0,
        stdout: JSON.stringify({
          state: "complete",
          artifact_path: remoteArtifact,
          remote_artifact_sha256: artifactSha256,
          status_path: join(harness.artifactDir, "opus.status.json"),
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

    expect(result.status).toBe("passed");
    expect(result.artifactPath).toBe(mirroredArtifact);
    expect(result.remoteArtifactPath).toBe(remoteArtifact);
    expect(result.attempts[0]).toMatchObject({
      artifactPath: mirroredArtifact,
      remoteArtifactPath: remoteArtifact,
      mirrorFallback: expect.objectContaining({
        attempted: true,
        used: true,
        remoteArtifactPath: remoteArtifact,
        selectedMirrorPath: mirroredArtifact,
        freshnessPassed: true,
        failureKind: null,
      }),
      validationErrors: [],
    });
  });

  it("rejects stale same-stem mirrors left before the current cmux run", async () => {
    const harness = await createHarness();
    const outsideDir = await mkdtemp(join(tmpdir(), "claude-runner-remote-"));
    const remoteArtifact = join(outsideDir, "opus.md");
    const mirroredArtifact = join(harness.artifactDir, "opus.md");
    await writeFile(mirroredArtifact, validReviewArtifact(), "utf8");
    const runCommand: ClaudeRunnerCommand = async (_command, args) => {
      if (args[0] === "preflight") {
        return { exitCode: 0, stdout: "{}", stderr: "" };
      }
      return {
        exitCode: 0,
        stdout: JSON.stringify({
          state: "complete",
          artifact_path: remoteArtifact,
          status_path: join(harness.artifactDir, "opus.status.json"),
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
    expect(result.artifactPath).toBe(remoteArtifact);
    expect(result.remoteArtifactPath).toBeNull();
    expect(result.validationErrors).toEqual([
      expect.stringContaining("artifact_path resolves outside artifact dir"),
      expect.stringContaining("mirror fallback local mirror is absent"),
    ]);
    expect(result.attempts[0]?.mirrorFallback).toMatchObject({
      attempted: true,
      used: false,
      failureKind: "absent",
      selectedMirrorPath: mirroredArtifact,
    });
  });

  it("rejects stale same-stem mirrors written before the run start", async () => {
    const harness = await createHarness();
    const outsideDir = await mkdtemp(join(tmpdir(), "claude-runner-remote-"));
    const remoteArtifact = join(outsideDir, "opus.md");
    const mirroredArtifact = join(harness.artifactDir, "opus.md");
    const oldDate = new Date("2000-01-01T00:00:00Z");
    const runCommand: ClaudeRunnerCommand = async (_command, args) => {
      if (args[0] === "preflight") {
        return { exitCode: 0, stdout: "{}", stderr: "" };
      }
      await writeFile(mirroredArtifact, validReviewArtifact(), "utf8");
      await utimes(mirroredArtifact, oldDate, oldDate);
      return {
        exitCode: 0,
        stdout: JSON.stringify({
          state: "complete",
          artifact_path: remoteArtifact,
          status_path: join(harness.artifactDir, "opus.status.json"),
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
    expect(result.attempts[0]?.mirrorFallback).toMatchObject({
      attempted: true,
      used: false,
      failureKind: "stale",
      freshnessPassed: false,
      selectedMirrorPath: mirroredArtifact,
    });
    expect(result.validationErrors).toEqual([
      expect.stringContaining("artifact_path resolves outside artifact dir"),
      expect.stringContaining("mirror fallback is stale"),
    ]);
  });

  it("rejects stale same-stem mirror directories without aborting the run", async () => {
    const harness = await createHarness();
    const outsideDir = await mkdtemp(join(tmpdir(), "claude-runner-remote-"));
    const remoteArtifact = join(outsideDir, "opus.md");
    const mirroredArtifact = join(harness.artifactDir, "opus.md");
    await mkdir(mirroredArtifact);
    const runCommand: ClaudeRunnerCommand = async (_command, args) => {
      if (args[0] === "preflight") {
        return { exitCode: 0, stdout: "{}", stderr: "" };
      }
      return {
        exitCode: 0,
        stdout: JSON.stringify({
          state: "complete",
          artifact_path: remoteArtifact,
          status_path: join(harness.artifactDir, "opus.status.json"),
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
    expect(result.artifactPath).toBe(remoteArtifact);
    expect(result.remoteArtifactPath).toBeNull();
    expect(result.validationErrors).toEqual(
      expect.arrayContaining([
        expect.stringContaining("artifact_path resolves outside artifact dir"),
        expect.stringContaining("mirror fallback local mirror is absent"),
      ]),
    );
  });

  it("rejects remote cmux artifact paths when the local mirror escapes by symlink", async () => {
    const harness = await createHarness();
    const outsideDir = await mkdtemp(join(tmpdir(), "claude-runner-remote-"));
    const remoteArtifact = join(outsideDir, "opus.md");
    const symlinkTarget = join(outsideDir, "opus.md");
    const mirroredArtifact = join(harness.artifactDir, "opus.md");
    const runCommand: ClaudeRunnerCommand = async (_command, args) => {
      if (args[0] === "preflight") {
        return { exitCode: 0, stdout: "{}", stderr: "" };
      }
      await writeFile(symlinkTarget, validReviewArtifact(), "utf8");
      await symlink(symlinkTarget, mirroredArtifact);
      return {
        exitCode: 0,
        stdout: JSON.stringify({
          state: "complete",
          artifact_path: remoteArtifact,
          status_path: join(harness.artifactDir, "opus.status.json"),
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
    expect(result.artifactPath).toBe(remoteArtifact);
    expect(result.remoteArtifactPath).toBeNull();
    expect(result.validationErrors).toEqual(
      expect.arrayContaining([
        expect.stringContaining("artifact_path resolves outside artifact dir"),
      ]),
    );
    expect(result.attempts[0]?.mirrorFallback).toMatchObject({
      attempted: true,
      used: false,
      failureKind: "symlink_escape",
      remoteArtifactPath: remoteArtifact,
    });
  });

  it("skips stale mirror cleanup when the mirror symlink resolves outside the artifact dir", async () => {
    const harness = await createHarness();
    const outsideDir = await mkdtemp(join(tmpdir(), "claude-runner-remote-"));
    const remoteArtifact = join(outsideDir, "opus.md");
    const symlinkTarget = join(outsideDir, "opus.md");
    const mirroredArtifact = join(harness.artifactDir, "opus.md");
    await writeFile(symlinkTarget, validReviewArtifact(), "utf8");
    await symlink(symlinkTarget, mirroredArtifact);
    const runCommand: ClaudeRunnerCommand = async (_command, args) => {
      if (args[0] === "preflight") {
        return { exitCode: 0, stdout: "{}", stderr: "" };
      }
      return {
        exitCode: 0,
        stdout: JSON.stringify({
          state: "complete",
          artifact_path: remoteArtifact,
          status_path: join(harness.artifactDir, "opus.status.json"),
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

    expect(await readFile(symlinkTarget, "utf8")).toContain("ready_as_written");
    expect(result.status).toBe("invalid_artifact");
    expect(result.attempts[0]?.mirrorFallback).toMatchObject({
      attempted: true,
      used: false,
      failureKind: "symlink_escape",
      remoteArtifactPath: remoteArtifact,
    });
  });

  it("fails closed without repair when remote mirror provenance hash mismatches", async () => {
    const harness = await createHarness();
    const outsideDir = await mkdtemp(join(tmpdir(), "claude-runner-remote-"));
    const remoteArtifact = join(outsideDir, "opus.md");
    const mirroredArtifact = join(harness.artifactDir, "opus.md");
    const runCommand: ClaudeRunnerCommand = async (_command, args) => {
      if (args[0] === "preflight") {
        return { exitCode: 0, stdout: "{}", stderr: "" };
      }
      await writeFile(mirroredArtifact, validReviewArtifact(), "utf8");
      return {
        exitCode: 0,
        stdout: JSON.stringify({
          state: "complete",
          artifact_path: remoteArtifact,
          remote_artifact_sha256: "0".repeat(64),
          status_path: join(harness.artifactDir, "opus.status.json"),
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

    expect(result.status).toBe("invalid_artifact");
    expect(result.attempts).toHaveLength(1);
    expect(result.attempts[0]?.mirrorFallback).toMatchObject({
      attempted: true,
      used: false,
      failureKind: "provenance_mismatch",
      selectedMirrorPath: mirroredArtifact,
    });
    expect(result.validationErrors).toEqual([
      expect.stringContaining("artifact_path resolves outside artifact dir"),
      expect.stringContaining("mirror fallback provenance sha256 mismatch"),
    ]);
  });

  it("fails closed when remote mirror provenance hash is malformed", async () => {
    const harness = await createHarness();
    const outsideDir = await mkdtemp(join(tmpdir(), "claude-runner-remote-"));
    const remoteArtifact = join(outsideDir, "opus.md");
    const mirroredArtifact = join(harness.artifactDir, "opus.md");
    const runCommand: ClaudeRunnerCommand = async (_command, args) => {
      if (args[0] === "preflight") {
        return { exitCode: 0, stdout: "{}", stderr: "" };
      }
      await writeFile(mirroredArtifact, validReviewArtifact(), "utf8");
      return {
        exitCode: 0,
        stdout: JSON.stringify({
          state: "complete",
          artifact_path: remoteArtifact,
          remote_artifact_sha256: "not-a-sha",
          status_path: join(harness.artifactDir, "opus.status.json"),
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
    expect(result.attempts[0]?.mirrorFallback).toMatchObject({
      attempted: true,
      used: false,
      failureKind: "provenance_mismatch",
      selectedMirrorPath: mirroredArtifact,
    });
    expect(result.validationErrors).toEqual([
      expect.stringContaining("artifact_path resolves outside artifact dir"),
      expect.stringContaining("mirror fallback provenance sha256 is malformed"),
    ]);
  });

  it("rejects cmux artifact symlinks that resolve outside the artifact dir", async () => {
    const harness = await createHarness();
    const outsideDir = await mkdtemp(join(tmpdir(), "claude-runner-outside-"));
    const outsideArtifact = join(outsideDir, "opus.md");
    const linkedArtifact = join(harness.artifactDir, "opus.md");
    const runCommand: ClaudeRunnerCommand = async (_command, args) => {
      if (args[0] === "preflight") {
        return { exitCode: 0, stdout: "{}", stderr: "" };
      }
      await writeFile(outsideArtifact, validReviewArtifact(), "utf8");
      await symlink(outsideArtifact, linkedArtifact);
      return {
        exitCode: 0,
        stdout: JSON.stringify({
          state: "complete",
          artifact_path: linkedArtifact,
          status_path: join(harness.artifactDir, "opus.status.json"),
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
        expect.stringContaining("artifact_path resolves outside artifact dir"),
      ]),
    );
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

  it("requires source-read evidence in the Source Read Status section", async () => {
    const dir = await mkdtemp(join(tmpdir(), "claude-artifact-"));
    const artifact = join(dir, "artifact.md");
    await writeFile(
      artifact,
      [
        "## Verdict",
        "",
        "Verdict enum: ready_as_written",
        "",
        "The phrase SOURCE_READ_STATUS appears here, but not as a heading.",
        "",
        "## Reconciliation JSON",
        "",
        "```json",
        '{"schemaVersion":1}',
        "```",
        "",
        "Long enough artifact body for validation to pass.",
      ].join("\n"),
      "utf8",
    );

    await expect(
      validateClaudeArtifact(artifact, {
        minBytes: 50,
        requireSourceReadStatus: true,
      }),
    ).resolves.toContain(
      "artifact is missing a non-empty Source Read Status section",
    );
  });

  it("validates required JSON sections with delimiter-aware fences", async () => {
    const dir = await mkdtemp(join(tmpdir(), "claude-artifact-"));
    const artifact = join(dir, "artifact.md");
    await writeFile(
      artifact,
      [
        "## Verdict",
        "",
        "Verdict enum: ready_as_written",
        "",
        "## Source Read Status",
        "",
        "Read source.",
        "",
        "## `Reconciliation   JSON:`",
        "",
        "````json",
        "{",
        '  "schemaVersion": 1,',
        '  "markdown": "```json\\n{\\"nested\\":true}\\n```"',
        "}",
        "````",
        "",
        "Long enough artifact body for validation to pass.",
      ].join("\n"),
      "utf8",
    );

    await expect(
      validateClaudeArtifact(artifact, {
        minBytes: 50,
        requiredJsonSections: ["Reconciliation JSON"],
      }),
    ).resolves.toEqual([]);
  });

  it("accepts ATX closing markers in validated artifact headings", async () => {
    const dir = await mkdtemp(join(tmpdir(), "claude-artifact-"));
    const artifact = join(dir, "artifact.md");
    await writeFile(
      artifact,
      [
        "## Verdict ###",
        "",
        "Verdict enum: ready_as_written",
        "",
        "## Reconciliation JSON ###",
        "",
        "```json",
        '{"schemaVersion":1}',
        "```",
        "",
        "Long enough artifact body for validation to pass.",
      ].join("\n"),
      "utf8",
    );

    await expect(
      validateClaudeArtifact(artifact, {
        minBytes: 50,
        requireFirstHeading: "Verdict",
        requiredJsonSections: ["Reconciliation JSON"],
      }),
    ).resolves.toEqual([]);
  });

  it("rejects duplicate JSON fences in required sections", async () => {
    const dir = await mkdtemp(join(tmpdir(), "claude-artifact-"));
    const artifact = join(dir, "artifact.md");
    await writeFile(
      artifact,
      [
        "## Verdict",
        "",
        "Verdict enum: ready_as_written",
        "",
        "## Source Read Status",
        "",
        "Read source.",
        "",
        "## Reconciliation JSON",
        "",
        "```json",
        '{"schemaVersion":1}',
        "```",
        "",
        "```json",
        '{"schemaVersion":2}',
        "```",
        "",
        "Long enough artifact body for validation to pass.",
      ].join("\n"),
      "utf8",
    );

    await expect(
      validateClaudeArtifact(artifact, {
        minBytes: 50,
        requiredJsonSections: ["Reconciliation JSON"],
      }),
    ).resolves.toEqual([
      expect.stringContaining(
        'artifact required JSON section "Reconciliation JSON" contains multiple fenced json objects',
      ),
    ]);
  });

  it("rejects unterminated JSON fences in required sections", async () => {
    const dir = await mkdtemp(join(tmpdir(), "claude-artifact-"));
    const artifact = join(dir, "artifact.md");
    await writeFile(
      artifact,
      [
        "## Verdict",
        "",
        "Verdict enum: ready_as_written",
        "",
        "## Reconciliation JSON",
        "",
        "```json",
        '{"schemaVersion":1}',
        "",
        "Long enough artifact body for validation to pass.",
      ].join("\n"),
      "utf8",
    );

    await expect(
      validateClaudeArtifact(artifact, {
        minBytes: 50,
        requiredJsonSections: ["Reconciliation JSON"],
      }),
    ).resolves.toEqual([
      expect.stringContaining(
        'artifact required JSON section "Reconciliation JSON" has an unterminated fenced json object',
      ),
    ]);
  });

  it("rejects malformed required JSON sections", async () => {
    const dir = await mkdtemp(join(tmpdir(), "claude-artifact-"));
    const artifact = join(dir, "artifact.md");
    await writeFile(
      artifact,
      [
        "## Verdict",
        "",
        "Verdict enum: ready_as_written",
        "",
        "## Source Read Status",
        "",
        "Read source.",
        "",
        "## Reconciliation JSON",
        "",
        "```json",
        '{"schemaVersion":',
        "```",
        "",
        "Long enough artifact body for validation to pass.",
      ].join("\n"),
      "utf8",
    );

    await expect(
      validateClaudeArtifact(artifact, {
        minBytes: 50,
        requiredJsonSections: ["Reconciliation JSON"],
      }),
    ).resolves.toEqual([
      expect.stringContaining(
        'artifact required JSON section "Reconciliation JSON" contains invalid JSON',
      ),
    ]);
  });

  it("rejects non-object JSON in required sections", async () => {
    const dir = await mkdtemp(join(tmpdir(), "claude-artifact-"));
    const artifact = join(dir, "artifact.md");
    await writeFile(
      artifact,
      [
        "## Verdict",
        "",
        "Verdict enum: ready_as_written",
        "",
        "## Reconciliation JSON",
        "",
        "```json",
        '["not", "an", "object"]',
        "```",
        "",
        "Long enough artifact body for validation to pass.",
      ].join("\n"),
      "utf8",
    );

    await expect(
      validateClaudeArtifact(artifact, {
        minBytes: 50,
        requiredJsonSections: ["Reconciliation JSON"],
      }),
    ).resolves.toEqual([
      expect.stringContaining(
        'artifact required JSON section "Reconciliation JSON" JSON must be an object',
      ),
    ]);
  });

  it("rejects missing structured JSON in required sections", async () => {
    const dir = await mkdtemp(join(tmpdir(), "claude-artifact-"));
    const artifact = join(dir, "artifact.md");
    await writeFile(
      artifact,
      [
        "## Verdict",
        "",
        "Verdict enum: ready_as_written",
        "",
        "## Source Read Status",
        "",
        "Read source.",
        "",
        "## Reconciliation JSON",
        "",
        "The model described the JSON but did not produce it.",
        "",
        "Long enough artifact body for validation to pass.",
      ].join("\n"),
      "utf8",
    );

    await expect(
      validateClaudeArtifact(artifact, {
        minBytes: 50,
        requiredJsonSections: ["Reconciliation JSON"],
      }),
    ).resolves.toContain(
      'artifact required JSON section "Reconciliation JSON" is missing a fenced json object',
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

function validReviewArtifact(): string {
  return [
    "## Verdict",
    "",
    "Verdict enum: ready_as_written",
    "",
    "## Source Read Status",
    "",
    "Read the prompt and source packet.",
    "",
    "## Reconciliation JSON",
    "",
    "```json",
    '{"schemaVersion":1}',
    "```",
    "",
    "Long enough artifact body for validation to pass.",
  ].join("\n");
}
