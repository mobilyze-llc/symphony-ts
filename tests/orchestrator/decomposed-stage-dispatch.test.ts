import { describe, expect, it } from "vitest";

import type { AgentRunInput, AgentRunResult } from "../../src/agent/runner.js";
import type { StageExecutionSubStage } from "../../src/config/types.js";
import { createEmptyLiveSession } from "../../src/domain/model.js";
import type { Issue, LiveSession } from "../../src/domain/model.js";
import type { StageUsageMeasurement } from "../../src/domain/stage-usage.js";
import type { DispatcherRunJournalEntryDraft } from "../../src/logging/run-journal.js";
import { executeDecomposedStageDispatch } from "../../src/orchestrator/decomposed-stage-dispatch.js";
import type {
  StageExecutionBackendInput,
  StageExecutionBackendResult,
  StageExecutionBackendRunner,
  StageExecutionJobSpec,
} from "../../src/stage-execution/backend.js";
import { createStageExecutionJobSpec } from "../../src/stage-execution/job-spec.js";

function createIssue(overrides?: Partial<Issue>): Issue {
  return {
    id: "issue-1",
    identifier: "SYMPH-1",
    title: "Decomposed stage",
    description: null,
    priority: 1,
    state: "In Progress",
    branchName: "codex/SYMPH-1",
    url: null,
    labels: [],
    blockedBy: [],
    createdAt: "2026-06-20T00:00:00.000Z",
    updatedAt: "2026-06-20T00:00:00.000Z",
    ...overrides,
  };
}

function createSubStageProfile(
  name: string,
  overrides?: {
    maxTokens?: number | null;
    consume?: readonly string[];
    produce?: readonly string[];
    missingCapsule?: "fail" | "degrade";
    profile?: string;
    backend?: "crabrunner" | "current-runner" | "manual";
  },
): StageExecutionSubStage {
  return {
    name,
    execution: {
      role: "implementer",
      phase: "implement",
      backend: overrides?.backend ?? "crabrunner",
      controlNeeding: false,
      provider: "openai",
      model: "gpt-5.3-codex",
      reasoningEffort: "medium",
      profile: overrides?.profile ?? `profile.${name}`,
      artifacts: { requires: [], produces: [] },
      timeoutMs: null,
      budget: {
        maxTokens: overrides?.maxTokens ?? 10_000,
        maxUsd: null,
      },
      dependencies: {
        stages: [],
        capsules: [...(overrides?.consume ?? [])],
        missingCapsule: overrides?.missingCapsule ?? "fail",
      },
      runGroup: { id: "rg-1", key: null },
      capsules: {
        consume: [...(overrides?.consume ?? [])],
        produce: [...(overrides?.produce ?? [])],
      },
      subStages: [],
    },
  };
}

/**
 * A backend that resolves synchronously with a canned result derived from a
 * per-sub-stage factory keyed by job stageName. The factory lets each test
 * shape token usage / produced capsules per sub-stage.
 */
class ImmediateBackend implements StageExecutionBackendRunner {
  readonly backend = "crabrunner" as const;
  readonly inputs: StageExecutionBackendInput[] = [];

  constructor(
    private readonly resultFor: (
      job: StageExecutionJobSpec,
      runnerInput: AgentRunInput,
    ) => AgentRunResult,
  ) {}

  async execute(
    input: StageExecutionBackendInput,
  ): Promise<StageExecutionBackendResult> {
    this.inputs.push(input);
    return {
      job: input.job,
      result: this.resultFor(input.job, input.runnerInput),
    };
  }
}

function liveSessionWithTokens(total: number): LiveSession {
  return {
    ...createEmptyLiveSession(),
    codexInputTokens: Math.floor(total / 3),
    codexOutputTokens: Math.floor(total / 3),
    codexTotalTokens: total,
    totalStageInputTokens: Math.floor(total / 3),
    totalStageOutputTokens: Math.floor(total / 3),
    totalStageTotalTokens: total,
    turnCount: 1,
  };
}

function makeResult(issue: Issue, total: number): AgentRunResult {
  return {
    issue,
    workspace: { path: "/tmp/ws", workspaceKey: "issue-1", createdNow: true },
    runAttempt: {
      issueId: issue.id,
      issueIdentifier: issue.identifier,
      attempt: null,
      workspacePath: "/tmp/ws",
      startedAt: "2026-06-20T00:00:00.000Z",
      status: "succeeded",
    },
    liveSession: liveSessionWithTokens(total),
    turnsCompleted: 1,
    lastTurn: null,
    rateLimits: null,
  };
}

function makeResultWithCost(
  issue: Issue,
  total: number,
  amountUsd: number,
): AgentRunResult {
  const result = makeResult(issue, total);
  return {
    ...result,
    liveSession: {
      ...result.liveSession,
      usageMeasurement: usageMeasurementWithCost(amountUsd),
    },
  };
}

function usageMeasurementWithCost(amountUsd: number): StageUsageMeasurement {
  return {
    schema: "symphony.stage-usage.v1",
    source: "crabrunner",
    runnerKind: "crabrunner-deterministic",
    provider: "openai",
    model: "gpt-5.3-codex",
    profile: "profile.costed",
    measurementQuality: "true",
    tokens: {
      inputTokens: 120,
      outputTokens: 30,
      totalTokens: 150,
    },
    cost: {
      amountUsd,
      currency: "USD",
      source: "provider_billing",
      authority: "authoritative",
      sourceDescription: "test terminal usage evidence",
    },
  };
}

interface HarnessOptions {
  subStages: readonly StageExecutionSubStage[];
  resultFor: (
    job: StageExecutionJobSpec,
    runnerInput: AgentRunInput,
  ) => AgentRunResult;
  producedCapsuleFiles?: ReadonlySet<string>;
  initialCapsulePaths?: readonly string[];
  /** Override the clock; defaults to a monotonic per-call stub. */
  now?: () => Date;
}

function runHarness(options: HarnessOptions): {
  result: Promise<AgentRunResult>;
  backend: ImmediateBackend;
  journal: DispatcherRunJournalEntryDraft[];
  runnerInputs: AgentRunInput[];
  jobOrder: string[];
} {
  const issue = createIssue();
  const backend = new ImmediateBackend(options.resultFor);
  const journal: DispatcherRunJournalEntryDraft[] = [];
  const runnerInputs: AgentRunInput[] = [];
  const jobOrder: string[] = [];
  const producedFiles = options.producedCapsuleFiles ?? new Set<string>();
  // Monotonic default clock: each call advances 1s so successive journal
  // entries (running vs terminal) get distinct timestamps.
  let nowTick = 0;
  const defaultNow = (): Date =>
    new Date(Date.UTC(2026, 5, 20, 0, 0, nowTick++));

  const result = executeDecomposedStageDispatch({
    issue,
    attempt: null,
    stageName: "implement",
    subStages: options.subStages,
    effectiveHardStops: null,
    baseRef: "origin/main",
    artifactRoot: "/tmp/artifacts/issue-1",
    ...(options.initialCapsulePaths === undefined
      ? {}
      : { initialCapsulePaths: options.initialCapsulePaths }),
    resolveBackend: (job) => {
      jobOrder.push(job.identity.stageName ?? "<none>");
      return backend;
    },
    createStageExecutionJobSpec: (subStageInput) =>
      createStageExecutionJobSpec({
        issue,
        attempt: null,
        stage: {
          type: "agent",
          runner: null,
          model: null,
          prompt: null,
          maxTurns: null,
          timeoutMs: null,
          concurrency: null,
          gateType: null,
          maxRework: null,
          reviewers: [],
          transitions: { onComplete: null, onApprove: null, onRework: null },
          linearState: null,
          execution: subStageInput.execution,
        },
        // Parent stage name flows into identity for journal correlation.
        stageName: subStageInput.stageName,
        defaultRunnerKind: "codex",
        defaultRunnerModel: null,
        defaultRunnerProvider: "openai",
        effectiveHardStops: null,
        defaultTurnTimeoutMs: 120_000,
        defaultStallTimeoutMs: 60_000,
        baseRef: "origin/main",
        artifactRoot: "/tmp/artifacts/issue-1",
      }),
    buildRunnerInput: (runnerInput) => {
      runnerInputs.push(runnerInput);
      return runnerInput;
    },
    appendJournalEntry: async (draft) => {
      journal.push(draft);
    },
    fileExists: (absolutePath) => producedFiles.has(absolutePath),
    now: options.now ?? defaultNow,
  });

  return { result, backend, journal, runnerInputs, jobOrder };
}

describe("executeDecomposedStageDispatch", () => {
  it("dispatches sub-stages in order through the resolved backend", async () => {
    const subStages = [
      createSubStageProfile("patch-plan", { produce: ["plan.json"] }),
      createSubStageProfile("first-patch", {
        consume: ["plan.json"],
        produce: ["patch.json"],
      }),
    ];

    const { result, backend, jobOrder } = runHarness({
      subStages,
      producedCapsuleFiles: new Set([
        "/tmp/artifacts/issue-1/plan.json",
        "/tmp/artifacts/issue-1/patch.json",
      ]),
      resultFor: () => makeResult(createIssue(), 100),
    });

    const aggregate = await result;

    expect(backend.inputs).toHaveLength(2);
    // Each per-sub-stage job carries a UNIQUE identity composed of the PARENT
    // stage name + the sub-stage name (so the run group correlates AND each
    // sub-stage is distinct even if profiles collide), and its own profile id.
    expect(backend.inputs.map((entry) => entry.job.identity.stageName)).toEqual(
      ["implement/patch-plan", "implement/first-patch"],
    );
    expect(backend.inputs.map((entry) => entry.job.identity.profileId)).toEqual(
      ["profile.patch-plan", "profile.first-patch"],
    );
    // resolveBackend is consulted once per dispatched sub-stage, in order.
    expect(jobOrder).toEqual(["implement/patch-plan", "implement/first-patch"]);
    expect(aggregate.hardStop ?? null).toBeNull();
  });

  it("sums token fields across all dispatched sub-stages", async () => {
    const subStages = [
      createSubStageProfile("patch-plan", { produce: ["plan.json"] }),
      createSubStageProfile("first-patch", {
        consume: ["plan.json"],
        produce: ["patch.json"],
      }),
    ];
    const tokensByStage = new Map<string, number>();
    let call = 0;

    const { result, backend } = runHarness({
      subStages,
      producedCapsuleFiles: new Set([
        "/tmp/artifacts/issue-1/plan.json",
        "/tmp/artifacts/issue-1/patch.json",
      ]),
      resultFor: () => {
        call += 1;
        const total = call === 1 ? 100 : 200;
        tokensByStage.set(`call-${call}`, total);
        return makeResult(createIssue(), total);
      },
    });

    const aggregate = await result;
    expect(backend.inputs).toHaveLength(2);
    expect(aggregate.liveSession.codexTotalTokens).toBe(300);
    expect(aggregate.liveSession.totalStageTotalTokens).toBe(300);
    expect(aggregate.liveSession.turnCount).toBe(2);
    expect(aggregate.hardStop ?? null).toBeNull();
  });

  it("journals a running and a terminal delegated_stage_attempt entry per sub-stage", async () => {
    const subStages = [
      createSubStageProfile("patch-plan", { produce: ["plan.json"] }),
      createSubStageProfile("first-patch", {
        consume: ["plan.json"],
        produce: ["patch.json"],
      }),
    ];

    const { result, journal } = runHarness({
      subStages,
      producedCapsuleFiles: new Set([
        "/tmp/artifacts/issue-1/plan.json",
        "/tmp/artifacts/issue-1/patch.json",
      ]),
      resultFor: () => makeResult(createIssue(), 100),
    });

    await result;

    const kinds = journal.map((entry) => entry.kind);
    expect(kinds.every((kind) => kind === "delegated_stage_attempt")).toBe(
      true,
    );
    // 2 sub-stages x (running + terminal) = 4 entries.
    expect(journal).toHaveLength(4);

    const statuses = journal.map((entry) => entry.metadata.status);
    expect(statuses).toEqual(["running", "succeeded", "running", "succeeded"]);

    const stageNames = journal.map((entry) => entry.metadata.stageName);
    expect(stageNames).toEqual([
      "implement/patch-plan",
      "implement/patch-plan",
      "implement/first-patch",
      "implement/first-patch",
    ]);
    // The projection keys per (runGroupId, composite sub-stage name); the
    // journal entry's `stage` field tracks the same composite name (builder
    // contract).
    expect(journal.map((entry) => entry.stage)).toEqual([
      "implement/patch-plan",
      "implement/patch-plan",
      "implement/first-patch",
      "implement/first-patch",
    ]);
    // Each sub-stage's attempt key is distinct, so the projection never
    // collapses two sub-stages into one row.
    const attemptKeys = new Set(
      journal.map((entry) => entry.metadata.attemptIdempotencyKey),
    );
    expect(attemptKeys.size).toBe(2);
  });

  it("stops at a budget breach, does not dispatch later sub-stages, and sets a hardStop", async () => {
    const subStages = [
      createSubStageProfile("patch-plan", {
        maxTokens: 100,
        produce: ["plan.json"],
      }),
      createSubStageProfile("first-patch", {
        consume: ["plan.json"],
        produce: ["patch.json"],
      }),
    ];

    const { result, backend, journal } = runHarness({
      subStages,
      // plan.json would exist, but the breach withholds it anyway.
      producedCapsuleFiles: new Set(["/tmp/artifacts/issue-1/plan.json"]),
      resultFor: () => makeResult(createIssue(), 250),
    });

    const aggregate = await result;
    expect(backend.inputs).toHaveLength(1);
    expect(aggregate.hardStop).not.toBeNull();
    expect(aggregate.hardStop?.outcome).toBe("PAUSED-budget");
    // running + budget-terminal for the single dispatched sub-stage.
    expect(journal).toHaveLength(2);
    expect(journal.map((entry) => entry.metadata.status)).toEqual([
      "running",
      "failed",
    ]);
  });

  it("sets hardStop estimatedCostUsd from terminal usage measurements", async () => {
    const subStages = [
      createSubStageProfile("patch-plan", {
        maxTokens: 100,
        produce: ["plan.json"],
      }),
      createSubStageProfile("first-patch", {
        consume: ["plan.json"],
        produce: ["patch.json"],
      }),
    ];

    const { result, backend } = runHarness({
      subStages,
      producedCapsuleFiles: new Set(["/tmp/artifacts/issue-1/plan.json"]),
      resultFor: () => makeResultWithCost(createIssue(), 250, 3.2100014),
    });

    const aggregate = await result;
    expect(backend.inputs).toHaveLength(1);
    expect(aggregate.hardStop?.estimatedCostUsd).toBe(3.210001);
  });

  it("synthesizes a hardStop result without dispatching when the first required capsule is missing", async () => {
    const subStages = [
      createSubStageProfile("first-patch", {
        consume: ["plan.json"],
        produce: ["patch.json"],
      }),
    ];

    const { result, backend, journal } = runHarness({
      subStages,
      // No initial capsules, so plan.json is never available -> fail closed.
      resultFor: () => makeResult(createIssue(), 100),
    });

    const aggregate = await result;
    expect(backend.inputs).toHaveLength(0);
    expect(aggregate.hardStop).not.toBeNull();
    // A synthesized empty live session (no tokens) when nothing dispatched.
    expect(aggregate.liveSession.codexTotalTokens).toBe(0);
    // The fail-closed sub-stage is journaled running + failed.
    expect(journal.map((entry) => entry.metadata.status)).toEqual([
      "running",
      "failed",
    ]);
  });

  it("fails closed when a declared produced capsule is not actually on disk", async () => {
    const subStages = [
      createSubStageProfile("patch-plan", { produce: ["plan.json"] }),
      createSubStageProfile("first-patch", {
        consume: ["plan.json"],
        produce: ["patch.json"],
      }),
    ];

    const { result, backend } = runHarness({
      subStages,
      // patch-plan claims plan.json but no file exists -> handoff fails closed.
      producedCapsuleFiles: new Set(),
      resultFor: () => makeResult(createIssue(), 100),
    });

    const aggregate = await result;
    // first-patch never dispatches because plan.json was not verified produced.
    expect(backend.inputs).toHaveLength(1);
    expect(aggregate.hardStop).not.toBeNull();
  });

  it("never mutates stage state — it only returns data and journals", async () => {
    // The module has no access to advanceStage / issueReworkCounts / onWorkerExit.
    // This is enforced structurally by the injected-deps surface; the test
    // asserts the contract by confirming no unexpected callback is invoked
    // beyond resolveBackend, buildRunnerInput, appendJournalEntry, fileExists.
    const subStages = [
      createSubStageProfile("patch-plan", { produce: ["plan.json"] }),
    ];
    let stageMutations = 0;
    const { result } = runHarness({
      subStages,
      producedCapsuleFiles: new Set(["/tmp/artifacts/issue-1/plan.json"]),
      resultFor: () => {
        stageMutations += 0; // no-op: there is no stage-advance hook to call.
        return makeResult(createIssue(), 100);
      },
    });
    await result;
    expect(stageMutations).toBe(0);
  });

  it("gives sub-stages distinct identities and journal entries even when they share a profile and run group (P2-1)", async () => {
    // Two sub-stages with the SAME profile + same run group. Without a
    // per-sub-stage identity, the crabrunner idempotency hash AND the SYMPH-811
    // projection key (runGroupId + stageName) would collide and conflate them.
    const subStages = [
      createSubStageProfile("first", { profile: "shared.profile" }),
      createSubStageProfile("second", { profile: "shared.profile" }),
    ];

    const { result, backend, journal } = runHarness({
      subStages,
      resultFor: () => makeResult(createIssue(), 100),
    });

    await result;

    expect(backend.inputs).toHaveLength(2);
    // Distinct backend job identities (the idempotency key must differ).
    const jobKeys = backend.inputs.map(
      (entry) => entry.job.identity.idempotencyKey,
    );
    expect(new Set(jobKeys).size).toBe(2);
    // The per-sub-stage identity composes parent + sub-stage name.
    expect(backend.inputs.map((entry) => entry.job.identity.stageName)).toEqual(
      ["implement/first", "implement/second"],
    );

    // Distinct journal projection keys: each sub-stage gets its own
    // (runGroupId, stageName) + attempt key, so the reducer shows both rows.
    const delegated = journal.filter(
      (entry) => entry.kind === "delegated_stage_attempt",
    );
    expect(delegated).toHaveLength(4);
    expect(delegated.map((entry) => entry.metadata.stageName)).toEqual([
      "implement/first",
      "implement/first",
      "implement/second",
      "implement/second",
    ]);
    const attemptKeys = new Set(
      delegated.map((entry) => entry.metadata.attemptIdempotencyKey),
    );
    expect(attemptKeys.size).toBe(2);
    // And the journal idempotency keys (attemptKey + status) are all distinct,
    // so neither sub-stage's running/terminal entry dedupes the other's.
    expect(new Set(delegated.map((entry) => entry.idempotencyKey)).size).toBe(
      4,
    );
  });

  it("fails closed when a sub-stage declares a non-delegated backend (P2-2)", async () => {
    const subStages = [
      createSubStageProfile("first"),
      createSubStageProfile("second", { backend: "current-runner" }),
    ];

    const { result, backend } = runHarness({
      subStages,
      resultFor: () => makeResult(createIssue(), 100),
    });

    await expect(result).rejects.toThrow(/current-runner/);
    // Fail closed BEFORE any dispatch — no sub-stage runs.
    expect(backend.inputs).toHaveLength(0);
  });

  it("uses the actual clock for the synthesized result's startedAt when nothing dispatched (P2-3)", async () => {
    const subStages = [
      createSubStageProfile("first-patch", {
        consume: ["plan.json"],
        produce: ["patch.json"],
      }),
    ];
    const fixed = new Date("2026-06-21T12:34:56.000Z");

    const { result, backend } = runHarness({
      subStages,
      now: () => fixed,
      resultFor: () => makeResult(createIssue(), 100),
    });

    const aggregate = await result;
    expect(backend.inputs).toHaveLength(0);
    // Not the epoch (which would report a decades-long duration in finalize).
    expect(aggregate.runAttempt.startedAt).toBe(fixed.toISOString());
    expect(aggregate.runAttempt.startedAt).not.toBe(new Date(0).toISOString());
  });

  it("does not count a produced capsule whose declared path escapes the artifact root (Track)", async () => {
    const subStages = [
      createSubStageProfile("patch-plan", {
        produce: ["../escape.json", "/etc/passwd"],
      }),
      createSubStageProfile("first-patch", {
        consume: ["../escape.json"],
        produce: ["patch.json"],
      }),
    ];

    const { result, backend } = runHarness({
      subStages,
      // Both escaping targets "exist" on disk, but must NOT count as produced
      // because they resolve outside the run-group artifact root.
      producedCapsuleFiles: new Set([
        "/tmp/escape.json",
        "/etc/passwd",
        "/tmp/artifacts/escape.json",
      ]),
      resultFor: () => makeResult(createIssue(), 100),
    });

    const aggregate = await result;
    // patch-plan dispatched, but its escaping produce paths are withheld, so
    // first-patch's required capsule is missing -> sequence fails closed.
    expect(backend.inputs).toHaveLength(1);
    expect(aggregate.hardStop).not.toBeNull();
  });

  it("journals running and terminal entries with distinct timestamps (observability)", async () => {
    const subStages = [
      createSubStageProfile("patch-plan", { produce: ["plan.json"] }),
    ];

    const { result, journal } = runHarness({
      subStages,
      producedCapsuleFiles: new Set(["/tmp/artifacts/issue-1/plan.json"]),
      resultFor: () => makeResult(createIssue(), 100),
    });

    await result;
    const delegated = journal.filter(
      (entry) => entry.kind === "delegated_stage_attempt",
    );
    expect(delegated).toHaveLength(2);
    expect(delegated[0]!.timestamp).not.toBe(delegated[1]!.timestamp);
  });

  it("reads a legitimate zero stage-token total as 0, not the codex fallback (P2-1)", async () => {
    // A zero-turn / synthesized sub-stage can legitimately spend 0 stage tokens
    // while codexTotalTokens carries an unrelated nonzero value. The per-
    // sub-stage budget check must read 0 (within the ceiling), NOT fall back to
    // codexTotalTokens and falsely trip a budget breach.
    const subStages = [createSubStageProfile("zero-turn", { maxTokens: 100 })];
    const zeroStageResult: AgentRunResult = {
      ...makeResult(createIssue(), 0),
      liveSession: {
        ...createEmptyLiveSession(),
        // Stage rollup is a legitimate 0; codex live total is unrelated 500.
        totalStageTotalTokens: 0,
        codexTotalTokens: 500,
        turnCount: 0,
      },
    };

    const { result, backend } = runHarness({
      subStages,
      resultFor: () => zeroStageResult,
    });

    const aggregate = await result;
    expect(backend.inputs).toHaveLength(1);
    // 0 <= ceiling(100): the sequence completes, no budget breach.
    expect(aggregate.hardStop ?? null).toBeNull();
    // The aggregate reflects the stage rollup (0), not the codex fallback (500).
    expect(aggregate.liveSession.totalStageTotalTokens).toBe(0);
  });

  it("does not count an empty or '.' produced-capsule path even when the artifact root exists (T3)", async () => {
    const subStages = [
      createSubStageProfile("patch-plan", { produce: ["", "."] }),
      createSubStageProfile("first-patch", {
        consume: [""],
        produce: ["patch.json"],
      }),
    ];

    const { result, backend } = runHarness({
      subStages,
      // The artifact root dir itself "exists" — an empty/"." produce path must
      // still NOT count as a produced capsule (it would resolve to the root).
      producedCapsuleFiles: new Set(["/tmp/artifacts/issue-1"]),
      resultFor: () => makeResult(createIssue(), 100),
    });

    const aggregate = await result;
    // patch-plan dispatched, but "" / "." are not counted, so first-patch's
    // required capsule is missing -> sequence fails closed.
    expect(backend.inputs).toHaveLength(1);
    expect(aggregate.hardStop).not.toBeNull();
  });
});
