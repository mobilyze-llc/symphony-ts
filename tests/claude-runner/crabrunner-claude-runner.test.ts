import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  type ClaudeCrabrunnerRunnerInput,
  runClaudeCrabrunner,
} from "../../src/claude-runner/crabrunner-claude-runner.js";
import type {
  CrabrunnerAdmissionResult,
  CrabrunnerJobSpec,
  CrabrunnerSchedulerClient,
  CrabrunnerTerminalEvidence,
} from "../../src/stage-execution/crabrunner-backend.js";

describe("Claude crabrunner adapter", () => {
  it("submits a read-only crabrunner lane and maps the artifact to ClaudeRunnerResult", async () => {
    const harness = await createHarness();
    const artifactPath = join(harness.artifactDir, "opus.md");
    await writeFile(artifactPath, validReviewArtifact(), "utf8");
    const scheduler = new RecordingScheduler({
      terminal: {
        state: "succeeded",
        artifactRefs: [artifactPath],
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
    expect(result.cmuxSpawnBin).toBe("crabrunner");
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

  it("returns invalid_artifact when a successful lane emits unreadable output", async () => {
    const harness = await createHarness();
    const artifactPath = join(harness.artifactDir, "opus.md");
    await writeFile(artifactPath, "short\n", "utf8");
    const scheduler = new RecordingScheduler({
      terminal: {
        state: "succeeded",
        artifactRefs: [artifactPath],
      },
    });

    const result = await runClaudeCrabrunner(
      {
        ...baseInput(harness),
        validation: { minBytes: 50 },
      },
      {
        schedulerClient: scheduler,
        now: fixedClock(),
      },
    );

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
    const artifactPath = join(harness.artifactDir, "opus.md");
    await writeFile(artifactPath, validReviewArtifact(), "utf8");
    const scheduler = new RecordingScheduler({
      terminal: {
        state: "succeeded",
        artifactRefs: [artifactPath],
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

  it("extracts a Markdown artifact from a collect archive ref", async () => {
    const harness = await createHarness();
    const archivePath = join(harness.artifactDir, "collect.tar");
    await writeFile(
      archivePath,
      tarWithEntry("job-1/attempts/01/artifact/opus.md", validReviewArtifact()),
    );
    const scheduler = new RecordingScheduler({
      terminal: {
        state: "succeeded",
        artifactRefs: [archivePath],
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
    expect(result.remoteArtifactPath).toBe(
      `${archivePath}:job-1/attempts/01/artifact/opus.md`,
    );
    await expect(readFile(result.artifactPath!, "utf8")).resolves.toContain(
      "ready_as_written",
    );
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

function tarWithEntry(name: string, content: string): Buffer {
  const payload = Buffer.from(content, "utf8");
  const header = Buffer.alloc(512);
  header.write(name, 0, 100, "utf8");
  header.write("0000777\0", 100, 8, "ascii");
  header.write("0000000\0", 108, 8, "ascii");
  header.write("0000000\0", 116, 8, "ascii");
  header.write(
    `${payload.length.toString(8).padStart(11, "0")}\0`,
    124,
    12,
    "ascii",
  );
  header.write("00000000000\0", 136, 12, "ascii");
  header.write("0", 156, 1, "ascii");
  const padding = Buffer.alloc((512 - (payload.length % 512)) % 512);
  return Buffer.concat([header, payload, padding, Buffer.alloc(1024)]);
}
