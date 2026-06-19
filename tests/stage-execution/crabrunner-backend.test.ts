import { describe, expect, it, vi } from "vitest";

import type { AgentRunInput } from "../../src/agent/runner.js";
import type { StageExecutionJobSpec } from "../../src/stage-execution/backend.js";
import {
  CRABRUNNER_JOB_SPEC_VERSION,
  type CrabrunnerAdmissionResult,
  type CrabrunnerJobSpec,
  type CrabrunnerSchedulerClient,
  CrabrunnerStageExecutionBackend,
  type CrabrunnerTerminalEvidence,
} from "../../src/stage-execution/crabrunner-backend.js";

describe("CrabrunnerStageExecutionBackend", () => {
  it("emits versioned job specs and maps deterministic success", async () => {
    const client = createClient({
      admission: { status: "accepted", jobId: "job-1" },
      terminal: {
        state: "succeeded",
        artifactRefs: ["/tmp/artifacts/result.json"],
        workspacePath: "/tmp/workspaces/SYMPH-807",
        usage: {
          status: "available",
          inputTokens: 11,
          outputTokens: 7,
          totalTokens: 18,
        },
      },
    });
    const backend = new CrabrunnerStageExecutionBackend({
      client,
      now: () => new Date("2026-06-19T12:00:00.000Z"),
    });

    const result = await backend.execute({
      job: createJob(),
      runnerInput: createRunnerInput(),
    });

    expect(client.submittedSpecs).toEqual([
      expect.objectContaining({
        schema: CRABRUNNER_JOB_SPEC_VERSION,
        backend: "crabrunner",
        role: "implementer",
        phase: "implement",
        mode: "submit",
        issue: expect.objectContaining({ identifier: "SYMPH-807" }),
      }),
    ]);
    expect(client.calls).toEqual(["submit", "status:job-1", "collect:job-1"]);
    expect(result.result.runAttempt.status).toBe("succeeded");
    expect(result.result.workspace.workspaceKey).toBe("issue-807");
    expect(result.evidence?.terminal?.state).toBe("succeeded");
    expect(result.evidence?.artifactRefs).toEqual([
      "/tmp/artifacts/result.json",
    ]);
    expect(result.result.liveSession.codexSessionLogs).toEqual([
      {
        label: "crabrunner-artifact-1",
        path: "/tmp/artifacts/result.json",
        url: null,
      },
    ]);
  });

  it("emits dry-run specs when configured", async () => {
    const client = createClient({
      admission: { status: "accepted", jobId: "dry-1" },
      terminal: { state: "succeeded", artifactRefs: [], usage: null },
    });
    const backend = new CrabrunnerStageExecutionBackend({
      client,
      dryRun: true,
    });

    await backend.execute({
      job: createJob(),
      runnerInput: createRunnerInput(),
    });

    expect(client.submittedSpecs[0]?.mode).toBe("dry-run");
  });

  it("maps admission rejection without falling through to local success", async () => {
    const client = createClient({
      admission: {
        status: "rejected",
        jobId: null,
        reason: "queue closed",
      },
      terminal: { state: "succeeded" },
    });
    const backend = new CrabrunnerStageExecutionBackend({ client });

    const result = await backend.execute({
      job: createJob(),
      runnerInput: createRunnerInput(),
    });

    expect(client.calls).toEqual(["submit"]);
    expect(result.result.runAttempt.status).toBe("failed");
    expect(result.result.runAttempt.error).toContain(
      "crabrunner_admission_rejected",
    );
    expect(result.evidence?.admission.status).toBe("rejected");
  });

  it.each([
    ["timed_out", "timed_out"],
    ["canceled", "canceled_by_reconciliation"],
    ["runner_failed", "failed"],
    ["artifact_parse_failed", "failed"],
    ["artifact_collection_failed", "failed"],
  ] as const)(
    "maps terminal %s to Symphony status %s",
    async (terminalState, expectedStatus) => {
      const backend = new CrabrunnerStageExecutionBackend({
        client: createClient({
          admission: { status: "accepted", jobId: "job-terminal" },
          terminal: {
            state: terminalState,
            message: `${terminalState} detail`,
          },
        }),
      });

      const result = await backend.execute({
        job: createJob(),
        runnerInput: createRunnerInput(),
      });

      expect(result.result.runAttempt.status).toBe(expectedStatus);
      expect(result.result.runAttempt.error).toContain(
        `crabrunner_${terminalState}`,
      );
      expect(result.evidence?.terminal?.state).toBe(terminalState);
    },
  );

  it("maps usage unavailable distinctly and never records available zero evidence", async () => {
    const backend = new CrabrunnerStageExecutionBackend({
      client: createClient({
        admission: { status: "accepted", jobId: "job-usage" },
        terminal: {
          state: "usage_unavailable",
          usage: { status: "unavailable", reason: "telemetry missing" },
          message: "telemetry missing",
        },
      }),
    });

    const result = await backend.execute({
      job: createJob(),
      runnerInput: createRunnerInput(),
    });

    expect(result.result.runAttempt.status).toBe("succeeded");
    expect(result.result.runAttempt.error).toBeUndefined();
    expect(result.evidence?.usage).toEqual({
      status: "unavailable",
      reason: "telemetry missing",
    });
    expect(result.result.liveSession.lastCodexMessage).toContain(
      '"usageStatus":"unavailable"',
    );
    expect(result.result.liveSession.lastCodexMessage).toContain(
      '"terminalMessage":"telemetry missing"',
    );
    expect(result.evidence?.usage).not.toHaveProperty("totalTokens");
  });

  it("fails closed when admission accepts without a job id", async () => {
    const backend = new CrabrunnerStageExecutionBackend({
      client: createClient({
        admission: { status: "accepted", jobId: "" },
        terminal: { state: "succeeded" },
      }),
    });

    const result = await backend.execute({
      job: createJob(),
      runnerInput: createRunnerInput(),
    });

    expect(result.result.runAttempt.status).toBe("failed");
    expect(result.result.runAttempt.error).toBe(
      "crabrunner_admission_accepted_without_job_id",
    );
  });

  it("maps scheduler unavailability to failure instead of local success", async () => {
    const backend = new CrabrunnerStageExecutionBackend({
      client: {
        submit: vi.fn(async () => {
          throw new Error("scheduler offline");
        }),
        status: vi.fn(async () => {}),
        collect: vi.fn(
          async (): Promise<CrabrunnerTerminalEvidence> => ({
            state: "runner_failed",
          }),
        ),
      },
    });

    const result = await backend.execute({
      job: createJob(),
      runnerInput: createRunnerInput(),
    });

    expect(result.result.runAttempt.status).toBe("failed");
    expect(result.result.runAttempt.error).toContain(
      "crabrunner_admission_rejected",
    );
    expect(result.evidence?.admission.reason).toContain(
      "crabrunner_unavailable",
    );
  });

  it("maps collect exceptions to artifact collection failure", async () => {
    const backend = new CrabrunnerStageExecutionBackend({
      client: {
        submit: vi.fn(
          async (): Promise<CrabrunnerAdmissionResult> => ({
            status: "accepted",
            jobId: "job-2",
          }),
        ),
        status: vi.fn(async () => {}),
        collect: vi.fn(async () => {
          throw new Error("missing artifact");
        }),
      },
    });

    const result = await backend.execute({
      job: createJob(),
      runnerInput: createRunnerInput(),
    });

    expect(result.result.runAttempt.status).toBe("failed");
    expect(result.result.runAttempt.error).toContain(
      "crabrunner_artifact_collection_failed",
    );
    expect(result.evidence?.terminal?.state).toBe("artifact_collection_failed");
  });
});

function createClient(input: {
  admission: CrabrunnerAdmissionResult;
  terminal: CrabrunnerTerminalEvidence;
}): CrabrunnerSchedulerClient & {
  calls: string[];
  submittedSpecs: CrabrunnerJobSpec[];
} {
  const calls: string[] = [];
  const submittedSpecs: CrabrunnerJobSpec[] = [];
  return {
    calls,
    submittedSpecs,
    submit: vi.fn(async (spec) => {
      calls.push("submit");
      submittedSpecs.push(spec);
      return input.admission;
    }),
    status: vi.fn(async (jobId) => {
      calls.push(`status:${jobId}`);
    }),
    collect: vi.fn(async (jobId) => {
      calls.push(`collect:${jobId}`);
      return input.terminal;
    }),
  };
}

function createJob(): StageExecutionJobSpec {
  return {
    backend: "crabrunner",
    role: "implementer",
    phase: "implement",
    identity: {
      issueId: "issue-807",
      issueIdentifier: "SYMPH-807",
      stageName: "implement",
      stageAttempt: 0,
      runGroupId: "rg-807",
      profileId: "deterministic.crabrunner",
      baseRef: "41e1975",
      targetHeadRef: "codex/SYMPH-807",
      artifactRoot: "/tmp/artifacts/SYMPH-807",
      idempotencyKey:
        "stage-execution:SYMPH-807:implement:0:crabrunner:1234567890abcdef1234",
    },
    runner: {
      runnerKind: "crabrunner-deterministic",
      model: null,
      provider: null,
      reasoningEffort: null,
    },
  };
}

function createRunnerInput(): AgentRunInput {
  return {
    issue: {
      id: "issue-807",
      identifier: "SYMPH-807",
      title: "Add deterministic crabrunner scheduler backend",
      description: null,
      priority: 1,
      state: "In Progress",
      branchName: "codex/SYMPH-807",
      url: null,
      labels: [],
      blockedBy: [],
      createdAt: null,
      updatedAt: null,
    },
    attempt: null,
    stageName: "implement",
  };
}
