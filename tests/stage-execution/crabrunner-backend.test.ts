import { describe, expect, it, vi } from "vitest";

import type { AgentRunInput } from "../../src/agent/runner.js";
import type { StageExecutionJobSpec } from "../../src/stage-execution/backend.js";
import {
  CRABRUNNER_JOB_SPEC_VERSION,
  type CrabrunnerAdmissionResult,
  type CrabrunnerCancellationRequest,
  type CrabrunnerJobSpec,
  type CrabrunnerSchedulerClient,
  CrabrunnerStageExecutionBackend,
  CrabrunnerStatusPollError,
  type CrabrunnerTerminalEvidence,
  createCrabrunnerJobSpec,
  validateCrabrunnerLaneEnforcementContract,
} from "../../src/stage-execution/crabrunner-backend.js";

describe("CrabrunnerStageExecutionBackend", () => {
  it("emits versioned job specs and maps deterministic success", async () => {
    const client = createClient({
      admission: { status: "accepted", jobId: "job-1" },
      terminal: {
        state: "succeeded",
        artifactRefs: ["/tmp/artifacts/result.json"],
        artifactHashes: ["sha256-result"],
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
        enforcement: expect.objectContaining({
          required: true,
          budget: expect.objectContaining({
            maxTokens: 50_000,
            maxUsd: 4,
          }),
          timing: expect.objectContaining({
            timeoutMs: 600_000,
            stallTimeoutMs: 120_000,
          }),
          cancellation: expect.objectContaining({
            processGroupKill: true,
          }),
        }),
      }),
    ]);
    expect(client.calls).toEqual(["submit", "status:job-1", "collect:job-1"]);
    expect(result.result.runAttempt.status).toBe("succeeded");
    expect(result.result.workspace.workspaceKey).toBe("issue-807");
    expect(result.evidence?.terminal?.state).toBe("succeeded");
    expect(result.evidence?.artifactRefs).toEqual([
      "/tmp/artifacts/result.json",
    ]);
    expect(result.evidence?.artifactHashes).toEqual(["sha256-result"]);
    expect(result.evidence?.terminal?.artifactHashes).toEqual([
      "sha256-result",
    ]);
    expect(result.result.liveSession.codexSessionLogs).toEqual([
      {
        label: "crabrunner-artifact-1",
        path: "/tmp/artifacts/result.json",
        url: null,
      },
    ]);
  });

  it("preserves the lane final artifact as the agent message for existing signal parsers", async () => {
    const finalMessage = "Investigation complete.\n[STAGE_COMPLETE]";
    const backend = new CrabrunnerStageExecutionBackend({
      client: createClient({
        admission: { status: "accepted", jobId: "job-final-message" },
        terminal: {
          state: "succeeded",
          artifact: {
            status: "ready",
            jobId: "job-final-message",
            primary: {
              name: "/attempts/1/artifact/investigate.md",
              content: finalMessage,
              hash: "hash-final-message",
            },
            entries: [],
          },
        },
      }),
    });

    const result = await backend.execute({
      job: createJob(),
      runnerInput: createRunnerInput(),
    });

    expect(result.result.lastTurn?.message).toBe(finalMessage);
    expect(result.result.metadata?.agentMessage).toBe(finalMessage);
    expect(result.result.metadata?.laneJobId).toBe("job-final-message");
  });

  it("preserves a mid-loop human block from progress when the final artifact omits it", async () => {
    const backend = new CrabrunnerStageExecutionBackend({
      client: createClient({
        admission: { status: "accepted", jobId: "job-progress-signal" },
        terminal: {
          state: "succeeded",
          artifact: {
            status: "ready",
            jobId: "job-progress-signal",
            primary: {
              name: "/attempts/1/artifact/implement.md",
              content: "The lane continued after an earlier boundary.",
              hash: "hash-progress-signal",
            },
            entries: [
              {
                name: "/attempts/1/artifact/implement.progress.jsonl",
                content: [
                  JSON.stringify({
                    seq: 3,
                    type: "assistant-message",
                    detail: "[BLOCKED_NEEDS_HUMAN: branch_push]",
                  }),
                  JSON.stringify({
                    seq: 4,
                    type: "assistant-message",
                    detail: "[BLOCKED_NEEDS_HUMAN: pr_creation]",
                  }),
                ].join("\n"),
                hash: "hash-progress",
              },
            ],
          },
        },
      }),
    });

    const result = await backend.execute({
      job: createJob(),
      runnerInput: createRunnerInput(),
    });

    expect(result.result.lastTurn?.message).toContain(
      "[BLOCKED_NEEDS_HUMAN: pr_creation]",
    );
    expect(result.result.hardStop).toMatchObject({
      outcome: "BLOCKED-needs-human",
      trigger: "worker_reported_block",
      humanBlockOperation: "pr_creation",
    });
  });

  it("ignores quoted human-block markers in progress prose", async () => {
    const backend = new CrabrunnerStageExecutionBackend({
      client: createClient({
        admission: { status: "accepted", jobId: "job-quoted-progress" },
        terminal: {
          state: "succeeded",
          artifact: {
            status: "ready",
            jobId: "job-quoted-progress",
            primary: {
              name: "/attempts/1/artifact/implement.md",
              content: "The implementation completed.",
              hash: "hash-quoted-progress",
            },
            entries: [
              {
                name: "/attempts/1/artifact/implement.progress.jsonl",
                content: JSON.stringify({
                  seq: 5,
                  type: "assistant-message",
                  detail:
                    "When done, output [BLOCKED_NEEDS_HUMAN: pr_creation] on its own line.",
                }),
                hash: "hash-quoted-progress-log",
              },
            ],
          },
        },
      }),
    });

    const result = await backend.execute({
      job: createJob(),
      runnerInput: createRunnerInput(),
    });

    expect(result.result.hardStop).toBeUndefined();
    expect(result.result.lastTurn?.message).toBe(
      "The implementation completed.",
    );
  });

  it("threads the runner abort signal into scheduler submit", async () => {
    const controller = new AbortController();
    const client = createClient({
      admission: { status: "accepted", jobId: "job-signal" },
      terminal: { state: "succeeded" },
    });
    const backend = new CrabrunnerStageExecutionBackend({ client });

    await backend.execute({
      job: createJob(),
      runnerInput: createRunnerInput({ signal: controller.signal }),
    });

    expect(client.submittedSignals).toEqual([controller.signal]);
  });

  it("normalizes crabrunner legacy counters through the usage contract", async () => {
    const backend = new CrabrunnerStageExecutionBackend({
      client: createClient({
        admission: { status: "accepted", jobId: "job-normalize" },
        terminal: {
          state: "succeeded",
          usage: {
            status: "available",
            inputTokens: 11.9,
            outputTokens: 7.2,
            totalTokens: 19.1,
            cacheReadTokens: 3.8,
            cacheWriteTokens: -1.2,
            noCacheTokens: 8.4,
            reasoningTokens: 2.9,
          },
        },
      }),
    });

    const result = await backend.execute({
      job: createJob(),
      runnerInput: createRunnerInput(),
    });

    expect(result.result.liveSession.usageMeasurement?.tokens).toMatchObject({
      inputTokens: 11,
      outputTokens: 7,
      totalTokens: 19,
      cacheReadTokens: 3,
      noCacheTokens: 8,
      reasoningTokens: 2,
    });
    expect(
      result.result.liveSession.usageMeasurement?.tokens.cacheWriteTokens,
    ).toBeUndefined();
    expect(result.result.liveSession).toMatchObject({
      codexInputTokens: 11,
      codexOutputTokens: 7,
      codexTotalTokens: 19,
      codexCacheReadTokens: 3,
      codexCacheWriteTokens: 0,
      codexNoCacheTokens: 8,
      codexReasoningTokens: 2,
      totalStageInputTokens: 11,
      totalStageOutputTokens: 7,
      totalStageTotalTokens: 19,
      totalStageCacheReadTokens: 3,
      totalStageCacheWriteTokens: 0,
    });
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
    ["budget_exceeded", "failed"],
    ["turn_cap_reached", "failed"],
    ["stalled", "stalled"],
    ["canceled", "canceled_by_reconciliation"],
    ["kill_failed", "failed"],
    ["enforcement_contract_missing", "failed"],
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
    expect(result.result.liveSession.usageMeasurement).toMatchObject({
      source: "crabrunner",
      measurementQuality: "unavailable",
      tokens: {
        inputTokens: null,
        outputTokens: null,
        totalTokens: null,
      },
      cost: {
        amountUsd: null,
        authority: "unavailable",
      },
      unavailableReason: "telemetry missing",
    });
    expect(result.result.liveSession.codexTotalTokens).toBe(0);
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

  it("preserves progress, process, and cancellation evidence in terminal summaries", async () => {
    const backend = new CrabrunnerStageExecutionBackend({
      client: createClient({
        admission: { status: "accepted", jobId: "job-evidence" },
        terminal: {
          state: "budget_exceeded",
          message: "token budget exceeded",
          progress: {
            heartbeatCount: 3,
            progressEventCount: 5,
            usageEventCount: 2,
            lastHeartbeatAt: "2026-06-20T12:00:00.000Z",
            lastProgressAt: "2026-06-20T12:00:01.000Z",
            lastUsageAt: "2026-06-20T12:00:02.000Z",
          },
          process: {
            pid: 1234,
            processGroupId: 1234,
          },
          cancellation: {
            requested: false,
            signal: null,
            processGroup: false,
            killed: false,
            failure: null,
          },
        },
      }),
    });

    const result = await backend.execute({
      job: createJob(),
      runnerInput: createRunnerInput(),
    });

    expect(result.result.runAttempt.status).toBe("failed");
    expect(result.result.liveSession.lastCodexMessage).toContain(
      '"usageEventCount":2',
    );
    expect(result.result.liveSession.lastCodexMessage).toContain('"pid":1234');
    expect(result.result.liveSession.lastCodexMessage).toContain(
      '"cancellation"',
    );
  });

  it("fails closed lane-side when delegated enforcement metadata is missing", async () => {
    const job = {
      ...createJob(),
      enforcement: {
        ...createJob().enforcement,
        budget: {
          ...createJob().enforcement.budget,
          maxTokens: null,
          maxUsd: null,
        },
        timing: {
          ...createJob().enforcement.timing,
          stallTimeoutMs: null,
        },
      },
    };
    const spec = createCrabrunnerJobSpec(
      {
        job,
        runnerInput: createRunnerInput(),
      },
      false,
    );
    const client = createClient({
      admission: { status: "accepted", jobId: "job-should-not-submit" },
      terminal: { state: "succeeded" },
    });
    const backend = new CrabrunnerStageExecutionBackend({ client });

    const result = await backend.execute({
      job,
      runnerInput: createRunnerInput(),
    });

    expect(client.calls).toEqual([]);
    expect(result.result.runAttempt.status).toBe("failed");
    expect(result.evidence).toMatchObject({
      admission: {
        status: "rejected",
        jobId: null,
      },
      terminal: {
        state: "enforcement_contract_missing",
      },
    });
    expect(validateCrabrunnerLaneEnforcementContract(spec)).toEqual({
      state: "enforcement_contract_missing",
      message:
        "missing or invalid delegated lane enforcement metadata: enforcement.budget.maxTokens, enforcement.budget.maxUsd, enforcement.timing.stallTimeoutMs",
    });
  });

  it("allows non-delegated enforcement contracts to remain advisory", () => {
    const job = {
      ...createJob(),
      enforcement: {
        ...createJob().enforcement,
        required: false,
        budget: {
          maxTokens: null,
          maxUsd: null,
          estimatedCostPer1kTokensUsd: null,
          cachedTokenCostRatio: null,
          liveBudgetGraceRatio: null,
        },
      },
    };
    const spec = createCrabrunnerJobSpec(
      {
        job,
        runnerInput: createRunnerInput(),
      },
      false,
    );

    expect(validateCrabrunnerLaneEnforcementContract(spec)).toBeNull();
  });

  it("rejects invalid delegated budget and timeout metadata before submission", async () => {
    const job = {
      ...createJob(),
      enforcement: {
        ...createJob().enforcement,
        budget: {
          ...createJob().enforcement.budget,
          cachedTokenCostRatio: null,
          liveBudgetGraceRatio: 1.5,
        },
        timing: {
          ...createJob().enforcement.timing,
          timeoutMs: 0,
        },
      },
    };
    const spec = createCrabrunnerJobSpec(
      {
        job,
        runnerInput: createRunnerInput(),
      },
      false,
    );
    const client = createClient({
      admission: { status: "accepted", jobId: "job-should-not-submit" },
      terminal: { state: "succeeded" },
    });
    const backend = new CrabrunnerStageExecutionBackend({ client });

    const result = await backend.execute({
      job,
      runnerInput: createRunnerInput(),
    });

    expect(client.calls).toEqual([]);
    expect(result.evidence?.terminal).toEqual({
      state: "enforcement_contract_missing",
      message:
        "missing or invalid delegated lane enforcement metadata: enforcement.budget.cachedTokenCostRatio, enforcement.budget.liveBudgetGraceRatio, enforcement.timing.timeoutMs",
    });
    expect(validateCrabrunnerLaneEnforcementContract(spec)).toEqual(
      result.evidence?.terminal,
    );
  });

  it("cancels delegated jobs by job id with process-group kill semantics on abort", async () => {
    const controller = new AbortController();
    controller.abort("stall_timeout");
    const cancelRequests: Array<{
      jobId: string;
      request: CrabrunnerCancellationRequest;
    }> = [];
    const client = createClient({
      admission: { status: "accepted", jobId: "job-cancel" },
      terminal: { state: "succeeded" },
      cancel: async (jobId, request) => {
        cancelRequests.push({ jobId, request });
        return {
          state: "canceled",
          message: "canceled by abort signal",
          cancellation: {
            requested: true,
            signal: request.signal,
            processGroup: request.processGroup,
            killed: true,
            failure: null,
          },
        };
      },
    });
    const backend = new CrabrunnerStageExecutionBackend({ client });

    const result = await backend.execute({
      job: createJob(),
      runnerInput: createRunnerInput({ signal: controller.signal }),
    });

    expect(client.calls).toEqual(["submit", "cancel:job-cancel"]);
    expect(cancelRequests).toEqual([
      {
        jobId: "job-cancel",
        request: {
          reason: "abort_signal",
          signal: "SIGTERM",
          processGroup: true,
          killGraceMs: 5_000,
        },
      },
    ]);
    expect(result.result.runAttempt.status).toBe("canceled_by_reconciliation");
    expect(result.evidence?.terminal?.cancellation).toMatchObject({
      killed: true,
      processGroup: true,
    });
  });

  it("cancels delegated jobs when abort fires during collection", async () => {
    const controller = new AbortController();
    const cancelRequests: Array<{
      jobId: string;
      request: CrabrunnerCancellationRequest;
    }> = [];
    const calls: string[] = [];
    const submittedSpecs: CrabrunnerJobSpec[] = [];
    const client: CrabrunnerSchedulerClient & {
      calls: string[];
      submittedSpecs: CrabrunnerJobSpec[];
    } = {
      calls,
      submittedSpecs,
      submit: vi.fn(async (spec) => {
        calls.push("submit");
        submittedSpecs.push(spec);
        return { status: "accepted" as const, jobId: "job-race" };
      }),
      status: vi.fn(async (jobId) => {
        calls.push(`status:${jobId}`);
      }),
      // Realistic: an abort kills the in-flight collect subprocess, so collect
      // REJECTS fast (it does not hang). The backend must route that aborted
      // rejection to cancelJob and yield cancellation evidence — not
      // artifact_collection_failed (recheck-2 P2).
      collect: vi.fn(async (jobId) => {
        calls.push(`collect:${jobId}`);
        controller.abort("stall_timeout");
        const abortError = new Error("collect aborted");
        abortError.name = "AbortError";
        throw abortError;
      }),
      cancel: vi.fn(async (jobId, request) => {
        calls.push(`cancel:${jobId}`);
        cancelRequests.push({ jobId, request });
        return {
          state: "canceled" as const,
          message: "canceled while collecting",
          cancellation: {
            requested: true,
            signal: request.signal,
            processGroup: request.processGroup,
            killed: true,
            failure: null,
          },
        };
      }),
    };
    const backend = new CrabrunnerStageExecutionBackend({ client });

    const result = await backend.execute({
      job: createJob(),
      runnerInput: createRunnerInput({ signal: controller.signal }),
    });

    expect(calls).toEqual([
      "submit",
      "status:job-race",
      "collect:job-race",
      "cancel:job-race",
    ]);
    expect(cancelRequests).toHaveLength(1);
    expect(result.result.runAttempt.status).toBe("canceled_by_reconciliation");
    expect(result.evidence?.terminal?.state).toBe("canceled");
    expect(result.evidence?.terminal?.cancellation).toMatchObject({
      killed: true,
      processGroup: true,
    });
  });

  it("routes an abort during in-flight status to cancellation evidence, not runner_failed", async () => {
    // recheck-2 P2: a fast-rejecting status (execFile kill) must NOT be
    // reported as runner_failed when the cause was an abort; it must yield
    // cancellation evidence, and cancelJob must run exactly once.
    const controller = new AbortController();
    const calls: string[] = [];
    const cancelRequests: CrabrunnerCancellationRequest[] = [];
    const client: CrabrunnerSchedulerClient & { calls: string[] } = {
      calls,
      submit: vi.fn(async () => {
        calls.push("submit");
        return { status: "accepted" as const, jobId: "job-status-abort" };
      }),
      status: vi.fn(async (jobId) => {
        calls.push(`status:${jobId}`);
        controller.abort("stall_timeout");
        const abortError = new Error("status aborted");
        abortError.name = "AbortError";
        throw abortError;
      }),
      collect: vi.fn(async (jobId) => {
        calls.push(`collect:${jobId}`);
        return { state: "succeeded" as const };
      }),
      cancel: vi.fn(async (jobId, request) => {
        calls.push(`cancel:${jobId}`);
        cancelRequests.push(request);
        return {
          state: "canceled" as const,
          message: "canceled during status",
          cancellation: {
            requested: true,
            signal: request.signal,
            processGroup: request.processGroup,
            killed: true,
            failure: null,
          },
        };
      }),
    };
    const backend = new CrabrunnerStageExecutionBackend({ client });

    const result = await backend.execute({
      job: createJob(),
      runnerInput: createRunnerInput({ signal: controller.signal }),
    });

    // collect must NOT run (status aborted); cancel runs exactly once.
    expect(calls).toEqual([
      "submit",
      "status:job-status-abort",
      "cancel:job-status-abort",
    ]);
    expect(cancelRequests).toHaveLength(1);
    expect(result.result.runAttempt.status).toBe("canceled_by_reconciliation");
    expect(result.evidence?.terminal?.state).toBe("canceled");
    expect(result.result.runAttempt.error).not.toContain("runner_failed");
  });

  it("surfaces kill failure distinctly when cancellation cannot be delivered", async () => {
    const controller = new AbortController();
    controller.abort("operator_stop");
    const backend = new CrabrunnerStageExecutionBackend({
      client: createClient({
        admission: { status: "accepted", jobId: "job-kill-failed" },
        terminal: { state: "succeeded" },
      }),
    });

    const result = await backend.execute({
      job: createJob(),
      runnerInput: createRunnerInput({ signal: controller.signal }),
    });

    expect(result.result.runAttempt.status).toBe("failed");
    expect(result.result.runAttempt.error).toContain("crabrunner_kill_failed");
    expect(result.evidence?.terminal?.state).toBe("kill_failed");
    expect(result.evidence?.terminal?.cancellation).toMatchObject({
      requested: true,
      processGroup: true,
      killed: false,
      failure: "cancel_not_supported",
    });
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

  it("persists the last poll liveness snapshot when status fails", async () => {
    const client = createClient({
      admission: { status: "accepted", jobId: "job-poll-timeout" },
      terminal: { state: "succeeded" },
    });
    client.status = vi.fn(async () => {
      throw new CrabrunnerStatusPollError(
        new Error("did not become collectible within 7 status polls"),
        {
          lastHeartbeatAt: "2026-07-09T12:00:00.000Z",
          lastProgressAt: "2026-07-09T12:00:01.000Z",
        },
      );
    });
    const backend = new CrabrunnerStageExecutionBackend({ client });

    const result = await backend.execute({
      job: createJob(),
      runnerInput: createRunnerInput(),
    });

    expect(result.evidence?.terminal).toMatchObject({
      state: "runner_failed",
      progress: {
        lastHeartbeatAt: "2026-07-09T12:00:00.000Z",
        lastProgressAt: "2026-07-09T12:00:01.000Z",
      },
    });
    expect(result.result.liveSession.lastCodexMessage).toContain(
      '"lastHeartbeatAt":"2026-07-09T12:00:00.000Z"',
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
  cancel?: (
    jobId: string,
    request: CrabrunnerCancellationRequest,
  ) => Promise<CrabrunnerTerminalEvidence>;
}): CrabrunnerSchedulerClient & {
  calls: string[];
  submittedSpecs: CrabrunnerJobSpec[];
  submittedSignals: Array<AbortSignal | undefined>;
} {
  const calls: string[] = [];
  const submittedSpecs: CrabrunnerJobSpec[] = [];
  const submittedSignals: Array<AbortSignal | undefined> = [];
  const cancel = input.cancel;
  return {
    calls,
    submittedSpecs,
    submittedSignals,
    submit: vi.fn(async (spec, signal) => {
      calls.push("submit");
      submittedSpecs.push(spec);
      submittedSignals.push(signal);
      return input.admission;
    }),
    status: vi.fn(async (jobId) => {
      calls.push(`status:${jobId}`);
    }),
    collect: vi.fn(async (jobId) => {
      calls.push(`collect:${jobId}`);
      return input.terminal;
    }),
    ...(cancel === undefined
      ? {}
      : {
          cancel: vi.fn(async (jobId, request) => {
            calls.push(`cancel:${jobId}`);
            return await cancel(jobId, request);
          }),
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
    enforcement: {
      required: true,
      budget: {
        maxTokens: 50_000,
        maxUsd: 4,
        estimatedCostPer1kTokensUsd: 0.05,
        cachedTokenCostRatio: 0.1,
        liveBudgetGraceRatio: 0.2,
      },
      timing: {
        timeoutMs: 600_000,
        stallTimeoutMs: 120_000,
        noProgressTurns: 3,
        maxIterations: 10,
      },
      telemetry: {
        heartbeatIntervalMs: 30_000,
        progressIntervalMs: 30_000,
        usageIntervalMs: 30_000,
      },
      cancellation: {
        jobIdRequired: true,
        cooperativeAbort: true,
        processGroupKill: true,
        killGraceMs: 5_000,
      },
    },
  };
}

function createRunnerInput(
  overrides: Partial<Pick<AgentRunInput, "signal">> = {},
): AgentRunInput {
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
    ...overrides,
  };
}
