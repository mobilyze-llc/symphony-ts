import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  type ClaudeCrabrunnerRunnerInput,
  resolveClaudeCrabrunnerSchedulerOptions,
  runClaudeCrabrunner,
} from "../../src/claude-runner/crabrunner-claude-runner.js";
import type {
  CrabrunnerAdmissionResult,
  CrabrunnerJobSpec,
  CrabrunnerSchedulerClient,
  CrabrunnerTerminalEvidence,
} from "../../src/stage-execution/crabrunner-backend.js";
import { readyCollectedArtifact } from "../stage-execution/collected-artifact-fixtures.js";

describe("Claude crabrunner adapter", () => {
  it("resolves scheduler options from the Symphony crabrunner environment", () => {
    expect(
      resolveClaudeCrabrunnerSchedulerOptions({
        cwd: "/fallback/repo",
        env: {
          SYMPHONY_CRABRUNNER_ROOT: " /crucible ",
          SYMPHONY_CRABRUNNER_TARGET_REPO: " /target/repo ",
          SYMPHONY_CRABRUNNER_HOST: " studio2.local ",
          SYMPHONY_CRABRUNNER_STATE_ROOT: " /state ",
          SYMPHONY_CRABRUNNER_REMOTE_USER: " eric ",
          SYMPHONY_CRABRUNNER_REMOTE_PORT: " 2222 ",
          SYMPHONY_CRABRUNNER_REMOTE_WORK_ROOT: " /remote/work ",
          SYMPHONY_CRABRUNNER_REMOTE_STATE_ROOT: " /remote/state ",
          SYMPHONY_CRABRUNNER_REMOTE_ARTIFACT_DIR: " /remote/artifacts ",
          SYMPHONY_CRABRUNNER_CRABBOX_BIN: " /bin/crabbox ",
          SYMPHONY_CRABRUNNER_VERSION: " 2026.07.03 ",
        },
      }),
    ).toMatchObject({
      crucibleRoot: "/crucible",
      targetRepoRoot: "/target/repo",
      host: "studio2.local",
      stateRoot: "/state",
      remoteUser: "eric",
      remotePort: "2222",
      remoteWorkRoot: "/remote/work",
      remoteStateRoot: "/remote/state",
      remoteRunArtifactDir: "/remote/artifacts",
      crabboxBin: "/bin/crabbox",
      crabrunnerVersion: "2026.07.03",
    });
  });

  it("prefers explicit target repo input over the crabrunner target repo environment", () => {
    expect(
      resolveClaudeCrabrunnerSchedulerOptions({
        cwd: "/fallback/repo",
        targetRepoRoot: "/input/repo",
        env: {
          SYMPHONY_CRABRUNNER_ROOT: "/crucible",
          SYMPHONY_CRABRUNNER_TARGET_REPO: "/env/repo",
          REPO_URL: "https://github.com/mobilyze-llc/symphony-ts.git",
        },
      }).targetRepoRoot,
    ).toBe("/input/repo");
  });

  it("requires an explicit crabrunner root for production scheduler resolution", () => {
    expect(() =>
      resolveClaudeCrabrunnerSchedulerOptions({
        cwd: "/repo",
        env: { SYMPHONY_CRABRUNNER_ROOT: " " },
      }),
    ).toThrow(
      "SYMPHONY_CRABRUNNER_ROOT is required to run Claude through crabrunner",
    );
  });

  it("prefers explicit target repo input over ambient REPO_URL", () => {
    expect(
      resolveClaudeCrabrunnerSchedulerOptions({
        cwd: "/fallback/repo",
        targetRepoRoot: "/input/repo",
        env: {
          SYMPHONY_CRABRUNNER_ROOT: "/crucible",
          REPO_URL: "https://github.com/mobilyze-llc/symphony-ts.git",
        },
      }).targetRepoRoot,
    ).toBe("/input/repo");
  });

  it("falls back to REPO_URL only when no explicit target repo is provided", () => {
    expect(
      resolveClaudeCrabrunnerSchedulerOptions({
        cwd: "/fallback/repo",
        env: {
          SYMPHONY_CRABRUNNER_ROOT: "/crucible",
          REPO_URL: "https://github.com/mobilyze-llc/symphony-ts.git",
        },
      }).targetRepoRoot,
    ).toBe("https://github.com/mobilyze-llc/symphony-ts.git");
  });

  it("submits a read-only crabrunner lane and maps the artifact to ClaudeRunnerResult", async () => {
    const harness = await createHarness();
    const artifactPath = join(harness.artifactDir, "opus.md");
    const scheduler = new RecordingScheduler({
      terminal: {
        state: "succeeded",
        artifact: readyArtifact(validReviewArtifact()),
        usage: {
          status: "available",
          inputTokens: 10,
          outputTokens: 20,
          totalTokens: 30,
        },
        message: "done",
      },
    });

    const result = await runClaudeCrabrunner(
      {
        ...baseInput(harness),
        timeoutSeconds: 42,
        validation: {
          minBytes: 50,
          requireFirstHeading: "Verdict",
          requiredHeadings: ["Source Read Status"],
          verdictEnums: ["ready_as_written"],
        },
      },
      {
        schedulerClient: scheduler,
        now: fixedClock(),
      },
    );

    expect(result.status).toBe("passed");
    expect(result.model).toBe("opus");
    expect(result.profile).toBe("read-only");
    expect(result.schemaVersion).toBe(2);
    expect(result.runnerBin).toBe("crabrunner");
    expect(result).not.toHaveProperty("cmuxSpawnBin");
    expect(result.artifactPath).toBe(artifactPath);
    expect(result.message).toBe("done");
    expect(result.usage).toMatchObject({
      status: "available",
      inputTokens: 10,
      outputTokens: 20,
      totalTokens: 30,
    });
    expect(result.attempts[0]).toMatchObject({
      artifactName: "opus",
      artifactPath,
      state: "succeeded",
      exitCode: 0,
      validationErrors: [],
    });
    expect(
      JSON.parse(await readFile(result.resultJsonPath, "utf8")),
    ).toMatchObject({
      status: "passed",
      artifactPath,
    });

    expect(scheduler.submissions).toHaveLength(1);
    expect(scheduler.submissions[0]).toMatchObject({
      schema: "symphony.crabrunner.job.v1",
      backend: "crabrunner",
      mode: "submit",
      promptFile: harness.promptFile,
      role: "reviewer",
      phase: "review",
      runner: {
        runnerKind: "claude",
        provider: "anthropic",
        model: "opus",
      },
      enforcement: {
        required: true,
        timing: {
          timeoutMs: 42_000,
        },
      },
      issue: {
        identifier: "SYMPH-1038",
      },
    });
  });

  it("returns failed when the crabrunner lane reaches a failed terminal state", async () => {
    const harness = await createHarness();
    const scheduler = new RecordingScheduler({
      terminal: {
        state: "runner_failed",
        message: "worker exploded",
      },
    });

    const result = await runClaudeCrabrunner(baseInput(harness), {
      schedulerClient: scheduler,
      now: fixedClock(),
    });

    expect(result.status).toBe("failed");
    expect(result.message).toBe("worker exploded");
    expect(result.validationErrors).toEqual([
      "crabrunner lane ended runner_failed",
    ]);
    expect(result.attempts[0]).toMatchObject({
      state: "runner_failed",
      exitCode: 1,
    });
  });

  it("maps crabrunner timed_out terminal evidence to the shared timed_out status", async () => {
    const harness = await createHarness();
    const scheduler = new RecordingScheduler({
      terminal: {
        state: "timed_out",
        message: "deadline exceeded",
      },
    });

    const result = await runClaudeCrabrunner(baseInput(harness), {
      schedulerClient: scheduler,
      now: fixedClock(),
    });

    expect(result.status).toBe("timed_out");
    expect(result.message).toBe("deadline exceeded");
    expect(result.validationErrors).toEqual([
      "crabrunner lane ended timed_out",
    ]);
  });

  it("returns invalid_artifact when default validation rejects a short artifact", async () => {
    const harness = await createHarness();
    const artifactPath = join(harness.artifactDir, "opus.md");
    const scheduler = new RecordingScheduler({
      terminal: {
        state: "succeeded",
        artifact: readyArtifact("short\n"),
      },
    });

    const result = await runClaudeCrabrunner(baseInput(harness), {
      schedulerClient: scheduler,
      now: fixedClock(),
    });

    expect(result.status).toBe("invalid_artifact");
    expect(result.artifactPath).toBe(artifactPath);
    expect(result.validationErrors).toEqual([
      expect.stringContaining("artifact is too small"),
    ]);
  });

  it("returns failed when crabrunner admission rejects the lane", async () => {
    const harness = await createHarness();
    const scheduler = new RecordingScheduler({
      admission: {
        status: "rejected",
        jobId: null,
        reason: "queue full",
      },
      terminal: {
        state: "succeeded",
      },
    });

    const result = await runClaudeCrabrunner(baseInput(harness), {
      schedulerClient: scheduler,
      now: fixedClock(),
    });

    expect(result.status).toBe("failed");
    expect(result.message).toBe("crabrunner admission rejected: queue full");
    expect(result.attempts[0]).toMatchObject({
      state: "rejected",
      exitCode: 1,
    });
    expect(scheduler.submissions).toHaveLength(1);
  });

  it("returns failed when scheduler status throws after admission", async () => {
    const harness = await createHarness();
    const scheduler = new RecordingScheduler({
      terminal: {
        state: "succeeded",
      },
      statusError: new Error("status unavailable"),
    });

    const result = await runClaudeCrabrunner(baseInput(harness), {
      schedulerClient: scheduler,
      now: fixedClock(),
    });

    expect(result.status).toBe("failed");
    expect(result.message).toBe(
      "crabrunner scheduler failed: status unavailable",
    );
    expect(result.validationErrors).toEqual([
      "crabrunner scheduler failed: status unavailable",
    ]);
    expect(result.diagnostics.attempts[0]?.stdout.text).toContain(
      "status unavailable",
    );
  });

  it("fails before scheduler submit when declared source visibility is invalid", async () => {
    const harness = await createHarness();
    const scheduler = new RecordingScheduler({
      terminal: {
        state: "succeeded",
      },
    });

    const result = await runClaudeCrabrunner(
      {
        ...baseInput(harness),
        sourcePaths: [join(tmpdir(), "outside-source.md")],
      },
      {
        schedulerClient: scheduler,
        now: fixedClock(),
      },
    );

    expect(result.status).toBe("failed");
    expect(result.sourceVisibility.status).toBe("invalid_source_path");
    expect(result.validationErrors).toEqual([
      "one or more declared source paths are unreadable",
    ]);
    expect(scheduler.submissions).toHaveLength(0);
  });

  it("rejects scheduler target repo roots that do not match the workspace", async () => {
    const harness = await createHarness();
    const otherRepo = await mkdtemp(join(tmpdir(), "claude-crabrunner-other-"));

    await expect(
      runClaudeCrabrunner(baseInput(harness), {
        schedulerOptions: {
          crucibleRoot: harness.workspace,
          targetRepoRoot: otherRepo,
        },
        now: fixedClock(),
      }),
    ).rejects.toThrow(
      "runClaudeCrabrunner requires schedulerOptions.targetRepoRoot to match input.workspace",
    );
  });

  it("allows scheduler target repo roots that match the workspace", async () => {
    const harness = await createHarness();
    const scheduler = new RecordingScheduler({
      terminal: {
        state: "succeeded",
        artifact: readyArtifact(validReviewArtifact()),
      },
    });

    const result = await runClaudeCrabrunner(
      {
        ...baseInput(harness),
        validation: {
          minBytes: 50,
          requireFirstHeading: "Verdict",
          requiredHeadings: ["Source Read Status"],
          verdictEnums: ["ready_as_written"],
        },
      },
      {
        schedulerClient: scheduler,
        schedulerOptions: {
          crucibleRoot: harness.workspace,
          targetRepoRoot: harness.workspace,
        },
        now: fixedClock(),
      },
    );

    expect(result.status).toBe("passed");
    expect(scheduler.submissions).toHaveLength(1);
  });

  it("rejects retryOnInvalid because crabrunner adapter lanes are one-shot", async () => {
    const harness = await createHarness();
    const scheduler = new RecordingScheduler({
      terminal: {
        state: "succeeded",
      },
    });

    await expect(
      runClaudeCrabrunner(
        {
          ...baseInput(harness),
          retryOnInvalid: true,
        } as unknown as ClaudeCrabrunnerRunnerInput,
        {
          schedulerClient: scheduler,
          now: fixedClock(),
        },
      ),
    ).rejects.toThrow("runClaudeCrabrunner does not support retryOnInvalid");
    expect(scheduler.submissions).toHaveLength(0);
  });

  it("rejects invalid diagnostic limits before scheduler resolution", async () => {
    const harness = await createHarness();

    await expect(
      runClaudeCrabrunner({
        ...baseInput(harness),
        diagnosticByteLimit: 0,
      }),
    ).rejects.toThrow("diagnosticByteLimit must be a positive integer");
  });

  it("maps write profile and provider-qualified models onto the job spec", async () => {
    const harness = await createHarness();
    const scheduler = new RecordingScheduler({
      terminal: {
        state: "succeeded",
        artifact: readyArtifact(validReviewArtifact()),
      },
    });

    await runClaudeCrabrunner(
      {
        ...baseInput(harness),
        profile: "write",
        model: "anthropic/claude-opus-4",
      },
      {
        schedulerClient: scheduler,
        now: fixedClock(),
      },
    );

    expect(scheduler.submissions[0]).toMatchObject({
      role: "implementer",
      phase: "implement",
      runner: {
        model: "anthropic/claude-opus-4",
        provider: null,
      },
    });
  });

  it("passes explicit provider and reasoning effort to crabrunner job specs", async () => {
    const harness = await createHarness();
    const scheduler = new RecordingScheduler({
      terminal: {
        state: "succeeded",
        artifact: readyArtifact(validReviewArtifact(), "artifact/codex.md"),
      },
    });

    await runClaudeCrabrunner(
      {
        ...baseInput(harness),
        model: "codex",
        runnerProvider: "openai",
        reasoningEffort: "high",
      },
      {
        schedulerClient: scheduler,
        now: fixedClock(),
      },
    );

    expect(scheduler.submissions[0]).toMatchObject({
      runner: {
        model: "codex",
        provider: "openai",
        reasoningEffort: "high",
      },
    });
  });

  it("persists a ready collected artifact before validation", async () => {
    const harness = await createHarness();
    const artifactName = "job-1/attempts/01/artifact/opus.md";
    const scheduler = new RecordingScheduler({
      terminal: {
        state: "succeeded",
        artifact: readyArtifact(validReviewArtifact(), artifactName),
      },
    });

    const result = await runClaudeCrabrunner(
      {
        ...baseInput(harness),
        validation: {
          minBytes: 50,
          requireFirstHeading: "Verdict",
          requiredHeadings: ["Source Read Status"],
          verdictEnums: ["ready_as_written"],
        },
      },
      {
        schedulerClient: scheduler,
        now: fixedClock(),
      },
    );

    expect(result.status).toBe("passed");
    expect(result.artifactPath).toBe(join(harness.artifactDir, "opus.md"));
    expect(result.remoteArtifactPath).toBe(artifactName);
    await expect(readFile(result.artifactPath!, "utf8")).resolves.toContain(
      "ready_as_written",
    );
  });

  it("accepts validity2-style ready review content from collected artifacts", async () => {
    const harness = await createHarness();
    const scheduler = new RecordingScheduler({
      terminal: {
        state: "succeeded",
        artifact: readyArtifact(
          `## Verdict\nPASS\n\n## Findings\n- ${"No blocking findings. ".repeat(12)}\n`,
        ),
      },
    });

    const result = await runClaudeCrabrunner(baseInput(harness), {
      schedulerClient: scheduler,
      now: fixedClock(),
    });

    expect(result.status).toBe("passed");
    expect(result.validationErrors).toEqual([]);
    expect(result.message).not.toContain("invalid_artifact");
  });
});

class RecordingScheduler implements CrabrunnerSchedulerClient {
  readonly submissions: CrabrunnerJobSpec[] = [];

  constructor(
    private readonly input: {
      admission?: CrabrunnerAdmissionResult;
      terminal: CrabrunnerTerminalEvidence;
      statusError?: Error;
      collectError?: Error;
    },
  ) {}

  async submit(spec: CrabrunnerJobSpec): Promise<CrabrunnerAdmissionResult> {
    this.submissions.push(spec);
    return this.input.admission ?? { status: "accepted", jobId: "job-1" };
  }

  async status(): Promise<void> {
    if (this.input.statusError !== undefined) {
      throw this.input.statusError;
    }
  }

  async collect(): Promise<CrabrunnerTerminalEvidence> {
    if (this.input.collectError !== undefined) {
      throw this.input.collectError;
    }
    return this.input.terminal;
  }
}

async function createHarness(): Promise<{
  workspace: string;
  artifactDir: string;
  promptFile: string;
}> {
  const workspace = await mkdtemp(join(tmpdir(), "claude-crabrunner-ws-"));
  const artifactDir = join(workspace, ".artifacts");
  await mkdir(artifactDir, { recursive: true });
  const promptFile = join(workspace, "prompt.md");
  await writeFile(promptFile, "Prompt\n", "utf8");
  return { workspace, artifactDir, promptFile };
}

function baseInput(
  harness: Awaited<ReturnType<typeof createHarness>>,
): ClaudeCrabrunnerRunnerInput {
  return {
    purpose: "spec-review",
    workspace: harness.workspace,
    promptFile: harness.promptFile,
    artifactDir: harness.artifactDir,
    artifactName: "opus",
    issue: {
      id: "8149ab40-998c-484a-bc5a-d602eb94ccad",
      identifier: "SYMPH-1038",
      title: "cmux to crabrunner adapter",
    },
  };
}

function fixedClock(): () => Date {
  return () => new Date("2026-07-03T00:00:00.000Z");
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
    "Long enough artifact body for validation to pass.",
  ].join("\n");
}

function readyArtifact(
  content: string,
  name = "job-1/attempts/01/artifact/opus.md",
) {
  return readyCollectedArtifact(name, content);
}
