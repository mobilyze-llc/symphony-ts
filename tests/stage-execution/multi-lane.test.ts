import { describe, expect, it } from "vitest";

import type { AgentRunInput, AgentRunResult } from "../../src/agent/runner.js";
import type { Issue } from "../../src/domain/model.js";
import type {
  StageExecutionBackendInput,
  StageExecutionBackendResult,
  StageExecutionBackendRunner,
  StageExecutionJobSpec,
} from "../../src/stage-execution/backend.js";
import { runStageExecutionLanes } from "../../src/stage-execution/multi-lane.js";

interface Lane {
  laneId: string;
  runGroupId?: string;
}

describe("runStageExecutionLanes", () => {
  it("dispatches lanes through backend.execute and preserves ordered provenance", async () => {
    const releaseSlow: { current: (() => void) | null } = { current: null };
    const started: string[] = [];
    const completed: string[] = [];
    const backend = fakeBackend(async (input) => {
      const laneId = input.job.identity.stageName ?? "";
      started.push(laneId);
      if (laneId === "slow") {
        await new Promise<void>((resolve) => {
          releaseSlow.current = resolve;
        });
      }
      completed.push(laneId);
      return backendResult(input, {
        artifactRefs: [`/artifacts/${laneId}.json`],
      });
    });

    const pending = runStageExecutionLanes<
      Lane,
      string,
      string[],
      { artifactRefs: readonly string[] }
    >({
      lanes: [{ laneId: "slow" }, { laneId: "fast" }],
      dispatchMode: "parallel",
      buildJobSpec: laneJob,
      buildRunnerInput: laneRunnerInput,
      resolveBackend: () => backend,
      expectedIdentity: { runGroupId: "rg-review" },
      collectArtifact: (lane) =>
        `${lane.lane.laneId}:${lane.backendResult?.evidence?.artifactRefs[0]}`,
      aggregate: (lanes) =>
        lanes.map((lane) => lane.artifact ?? "missing-artifact"),
    });

    expect(started).toEqual(["slow", "fast"]);
    await Promise.resolve();
    expect(completed).toEqual(["fast"]);
    releaseSlow.current?.();

    const result = await pending;

    expect(result.aggregate).toEqual([
      "slow:/artifacts/slow.json",
      "fast:/artifacts/fast.json",
    ]);
    expect(result.lanes.map((lane) => lane.index)).toEqual([0, 1]);
    expect(result.lanes.map((lane) => lane.job.identity.stageName)).toEqual([
      "slow",
      "fast",
    ]);
    expect(backend.submitted.map((job) => job.identity.stageName)).toEqual([
      "slow",
      "fast",
    ]);
  });

  it("validates run group identity before dispatch", async () => {
    const backend = fakeBackend();

    const result = await runStageExecutionLanes<Lane, string, string[]>({
      lanes: [
        { laneId: "good" },
        { laneId: "wrong-group", runGroupId: "rg-wrong" },
      ],
      buildJobSpec: laneJob,
      buildRunnerInput: laneRunnerInput,
      resolveBackend: () => backend,
      expectedIdentity: { runGroupId: "rg-review" },
      collectArtifact: (lane) =>
        lane.validationErrors[0]?.field ?? lane.dispatchStatus,
      aggregate: (lanes) =>
        lanes.map((lane) => lane.artifact ?? "missing-artifact"),
    });

    expect(result.aggregate).toEqual(["completed", "runGroupId"]);
    expect(result.lanes[1]?.dispatchStatus).toBe("skipped");
    expect(result.lanes[1]?.validationErrors[0]).toMatchObject({
      field: "runGroupId",
      expected: "rg-review",
      actual: "rg-wrong",
    });
    expect(backend.submitted.map((job) => job.identity.stageName)).toEqual([
      "good",
    ]);
  });

  it("forwards admission callbacks for review and decomposed lane shapes", async () => {
    const admitted: string[] = [];
    const backend = fakeBackend(async (input) => {
      input.onLaneJobId?.(`lane-${input.job.identity.stageName}`);
      return backendResult(input);
    });

    await runStageExecutionLanes<Lane, string, string[]>({
      lanes: [{ laneId: "reviewer" }, { laneId: "sub-stage" }],
      dispatchMode: "parallel",
      buildJobSpec: laneJob,
      buildRunnerInput: laneRunnerInput,
      resolveBackend: () => backend,
      onLaneJobId: (jobId) => admitted.push(jobId),
      collectArtifact: (lane) => lane.lane.laneId,
      aggregate: (lanes) => lanes.map((lane) => lane.artifact ?? "missing"),
    });

    expect(admitted).toEqual(["lane-reviewer", "lane-sub-stage"]);
  });

  it("isolates per-lane backend failures and still aggregates every lane", async () => {
    const backend = fakeBackend(async (input) => {
      if (input.job.identity.stageName === "bad") {
        throw new Error("backend failed");
      }
      return backendResult(input);
    });

    const result = await runStageExecutionLanes<Lane, string, string[]>({
      lanes: [{ laneId: "first" }, { laneId: "bad" }, { laneId: "last" }],
      buildJobSpec: laneJob,
      buildRunnerInput: laneRunnerInput,
      resolveBackend: () => backend,
      expectedIdentity: { runGroupId: "rg-review" },
      collectArtifact: (lane) =>
        lane.error instanceof Error ? lane.error.message : lane.dispatchStatus,
      aggregate: (lanes) =>
        lanes.map((lane) => lane.artifact ?? "missing-artifact"),
    });

    expect(result.aggregate).toEqual([
      "completed",
      "backend failed",
      "completed",
    ]);
    expect(result.lanes.map((lane) => lane.dispatchStatus)).toEqual([
      "completed",
      "failed",
      "completed",
    ]);
    expect(backend.submitted.map((job) => job.identity.stageName)).toEqual([
      "first",
      "bad",
      "last",
    ]);
  });

  it("supports review fan-out and decomposed sequential caller shapes", async () => {
    const backend = fakeBackend();

    const review = await runStageExecutionLanes<
      Lane & { kind: "reviewer" | "browser-qa" },
      string,
      string
    >({
      lanes: [
        { laneId: "reviewer-a", kind: "reviewer" },
        { laneId: "browser-qa", kind: "browser-qa" },
      ],
      dispatchMode: "parallel",
      buildJobSpec: laneJob,
      buildRunnerInput: laneRunnerInput,
      resolveBackend: () => backend,
      expectedIdentity: { runGroupId: "rg-review" },
      collectArtifact: (lane) => `${lane.lane.kind}:${lane.lane.laneId}`,
      aggregate: (lanes) =>
        lanes.map((lane) => lane.artifact ?? "missing").join(","),
    });

    expect(review.aggregate).toBe("reviewer:reviewer-a,browser-qa:browser-qa");

    const dispatchOrder: string[] = [];
    const decomposed = await runStageExecutionLanes<
      { name: string },
      StageExecutionBackendResult | null,
      readonly (string | null)[]
    >({
      lanes: [{ name: "patch-plan" }, { name: "first-patch" }],
      dispatchMode: "sequential",
      buildJobSpec: (lane) => laneJob({ laneId: lane.name }),
      buildRunnerInput: (lane) => laneRunnerInput({ laneId: lane.name }),
      resolveBackend: () =>
        fakeBackend((input) => {
          dispatchOrder.push(input.job.identity.stageName ?? "");
          return Promise.resolve(backendResult(input));
        }),
      collectArtifact: (lane) => lane.backendResult,
      aggregate: (lanes) =>
        lanes.map((lane) => lane.artifact?.job.identity.stageName ?? null),
    });

    expect(decomposed.aggregate).toEqual(["patch-plan", "first-patch"]);
    expect(dispatchOrder).toEqual(["patch-plan", "first-patch"]);
  });
});

function fakeBackend(
  execute: (
    input: StageExecutionBackendInput,
  ) => Promise<
    StageExecutionBackendResult<{ artifactRefs: readonly string[] }>
  > = (input) => Promise.resolve(backendResult(input)),
): StageExecutionBackendRunner<{ artifactRefs: readonly string[] }> & {
  submitted: StageExecutionJobSpec[];
} {
  const submitted: StageExecutionJobSpec[] = [];
  return {
    backend: "crabrunner",
    submitted,
    execute: async (input) => {
      submitted.push(input.job);
      return execute(input);
    },
  };
}

function laneJob(lane: Lane): StageExecutionJobSpec {
  return {
    backend: "crabrunner",
    role: "reviewer",
    phase: "review",
    identity: {
      issueId: "issue-912",
      issueIdentifier: "SYMPH-912",
      stageName: lane.laneId,
      stageAttempt: 0,
      runGroupId: lane.runGroupId ?? "rg-review",
      profileId: `profile.${lane.laneId}`,
      baseRef: "base",
      targetHeadRef: "head",
      artifactRoot: "/artifacts",
      idempotencyKey: `idem-${lane.laneId}`,
    },
    runner: {
      runnerKind: "codex",
      model: null,
      provider: null,
      reasoningEffort: null,
    },
    enforcement: {
      required: true,
      budget: {
        maxTokens: 1000,
        maxUsd: 1,
        estimatedCostPer1kTokensUsd: 0.05,
        cachedTokenCostRatio: 0.1,
        liveBudgetGraceRatio: 0.2,
      },
      timing: {
        timeoutMs: 1000,
        stallTimeoutMs: 1000,
        noProgressTurns: 1,
        maxIterations: 1,
      },
      telemetry: {
        heartbeatIntervalMs: 1,
        progressIntervalMs: 1,
        usageIntervalMs: 1,
      },
      cancellation: {
        jobIdRequired: true,
        cooperativeAbort: true,
        processGroupKill: true,
        killGraceMs: 1,
      },
    },
  };
}

function laneRunnerInput(lane: Lane): AgentRunInput {
  return {
    issue: issue(),
    attempt: 0,
    stageName: lane.laneId,
  };
}

function backendResult(
  input: StageExecutionBackendInput,
  evidence: { artifactRefs: readonly string[] } = { artifactRefs: [] },
): StageExecutionBackendResult<{ artifactRefs: readonly string[] }> {
  return {
    job: input.job,
    evidence,
    result: runResult(input.runnerInput),
  };
}

function runResult(input: AgentRunInput): AgentRunResult {
  return {
    issue: input.issue,
    workspace: {
      path: "/workspace",
      workspaceKey: input.issue.id,
      createdNow: false,
    },
    runAttempt: {
      issueId: input.issue.id,
      issueIdentifier: input.issue.identifier,
      attempt: input.attempt,
      workspacePath: "/workspace",
      startedAt: "2026-06-24T00:00:00.000Z",
      status: "succeeded",
    },
    liveSession: {} as never,
    turnsCompleted: 0,
    lastTurn: null,
    rateLimits: null,
  };
}

function issue(): Issue {
  return {
    id: "issue-912",
    identifier: "SYMPH-912",
    title: "Migrate review dispatch",
    description: null,
    priority: 1,
    state: "In Review",
    branchName: "codex/SYMPH-912",
    url: null,
    labels: [],
    blockedBy: [],
    createdAt: null,
    updatedAt: null,
  };
}
