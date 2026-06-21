import { describe, expect, it } from "vitest";

import type {
  StageDefinition,
  WorkflowHardStopsConfig,
} from "../../src/config/types.js";
import type { Issue } from "../../src/domain/model.js";
import type { StageExecutionEnforcementContract } from "../../src/stage-execution/backend.js";
import {
  createStageExecutionIdempotencyKey,
  createStageExecutionJobSpec,
} from "../../src/stage-execution/job-spec.js";

describe("createStageExecutionJobSpec", () => {
  it("builds scheduler-safe identity from stage execution config", () => {
    const job = createStageExecutionJobSpec({
      issue: createIssue({
        id: "issue:807",
        identifier: "SYMPH-807",
        branchName: "feature/SYMPH-807:refs",
      }),
      attempt: 2,
      stage: createStage({
        execution: {
          role: "implementer",
          phase: "implement",
          backend: "crabrunner",
          controlNeeding: false,
          provider: "openai",
          model: "gpt-5.3-codex",
          reasoningEffort: "medium",
          profile: "write:pro16",
          artifacts: { requires: [], produces: ["patch"] },
          timeoutMs: null,
          budget: { maxTokens: null, maxUsd: null },
          dependencies: { stages: [], capsules: [], missingCapsule: "fail" },
          runGroup: { id: "rg:807", key: null },
          capsules: { consume: [], produce: [] },
          subStages: [],
        },
      }),
      stageName: "implement",
      defaultRunnerKind: "codex",
      defaultRunnerModel: null,
      effectiveHardStops: createHardStops({
        maxTokensPerUnit: 50_000,
        maxDollarBudgetUsd: 6,
      }),
      defaultTurnTimeoutMs: 600_000,
      defaultStallTimeoutMs: 120_000,
      baseRef: "origin/main:weird",
      artifactRoot: "/tmp/artifacts/issue-807",
    });

    expect(job).toMatchObject({
      backend: "crabrunner",
      role: "implementer",
      phase: "implement",
      identity: {
        issueId: "issue:807",
        issueIdentifier: "SYMPH-807",
        stageName: "implement",
        stageAttempt: 2,
        runGroupId: "rg:807",
        profileId: "write:pro16",
        baseRef: "origin/main:weird",
        targetHeadRef: "feature/SYMPH-807:refs",
        artifactRoot: "/tmp/artifacts/issue-807",
      },
      runner: {
        runnerKind: "codex",
        model: "gpt-5.3-codex",
        provider: "openai",
        reasoningEffort: "medium",
      },
      enforcement: {
        required: true,
        budget: {
          maxTokens: 50_000,
          maxUsd: 6,
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
    });
    expect(job.identity.idempotencyKey).toMatch(
      /^stage-execution:SYMPH-807:implement:2:crabrunner:[a-f0-9]{20}$/,
    );
    expect(job.identity.idempotencyKey).not.toContain("feature/SYMPH-807:refs");
    expect(job.identity.idempotencyKey).not.toContain("rg:807");
  });

  it("derives delegated enforcement from stage profile and effective hard stops", () => {
    const job = createStageExecutionJobSpec({
      issue: createIssue({ id: "issue-832", identifier: "SYMPH-832" }),
      attempt: 0,
      stage: createStage({
        timeoutMs: 900_000,
        execution: {
          role: "implementer",
          phase: "implement",
          backend: "crabrunner",
          controlNeeding: false,
          provider: "openai",
          model: null,
          reasoningEffort: null,
          profile: "write.pro16",
          artifacts: { requires: [], produces: ["patch"] },
          timeoutMs: 180_000,
          budget: { maxTokens: 12_000, maxUsd: 1.25 },
          dependencies: { stages: [], capsules: [], missingCapsule: "fail" },
          runGroup: { id: "rg-832", key: null },
          capsules: { consume: [], produce: [] },
          subStages: [],
        },
      }),
      stageName: "implement",
      defaultRunnerKind: "codex",
      defaultRunnerModel: "gpt-5.3-codex",
      effectiveHardStops: createHardStops({
        maxTokensPerUnit: 80_000,
        maxDollarBudgetUsd: 9,
        noProgressTurns: 4,
      }),
      defaultTurnTimeoutMs: 600_000,
      defaultStallTimeoutMs: 90_000,
      baseRef: "origin/main",
      artifactRoot: "/tmp/artifacts/issue-832",
    });

    expect(job.enforcement).toEqual({
      required: true,
      budget: {
        maxTokens: 12_000,
        maxUsd: 1.25,
        estimatedCostPer1kTokensUsd: 0.05,
        cachedTokenCostRatio: 0.1,
        liveBudgetGraceRatio: 0.2,
      },
      timing: {
        timeoutMs: 180_000,
        stallTimeoutMs: 90_000,
        noProgressTurns: 4,
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
    });
  });

  it("preserves the legacy current-runner idempotency key contract", () => {
    const job = createStageExecutionJobSpec({
      issue: createIssue({
        id: "issue-806",
        identifier: "SYMPH-806",
        branchName: "codex/SYMPH-806-stage-execution-backend",
      }),
      attempt: 1,
      stage: createStage({
        execution: {
          role: "implementer",
          phase: "implement",
          backend: "current-runner",
          controlNeeding: false,
          provider: null,
          model: null,
          reasoningEffort: null,
          profile: "write.pro16",
          artifacts: { requires: [], produces: [] },
          timeoutMs: null,
          budget: { maxTokens: null, maxUsd: null },
          dependencies: { stages: [], capsules: [], missingCapsule: "fail" },
          runGroup: { id: "rg-806", key: null },
          capsules: { consume: [], produce: [] },
          subStages: [],
        },
      }),
      stageName: "implement",
      defaultRunnerKind: "codex",
      defaultRunnerModel: "gpt-5.3-codex",
      baseRef: "origin/main",
      artifactRoot: "/tmp/artifacts/issue-806",
    });

    expect(job.identity.idempotencyKey).toBe(
      "issue-806:implement:1:current-runner:rg-806:codex/SYMPH-806-stage-execution-backend",
    );
  });

  it("threads the top-level runner provider into stages without an execution provider", () => {
    const job = createStageExecutionJobSpec({
      issue: createIssue({ id: "issue-834", identifier: "SYMPH-834" }),
      attempt: 0,
      stage: createStage({
        execution: {
          role: "investigator",
          phase: "investigate",
          backend: "current-runner",
          controlNeeding: true,
          provider: null,
          model: null,
          reasoningEffort: null,
          profile: null,
          artifacts: { requires: [], produces: [] },
          timeoutMs: null,
          budget: { maxTokens: null, maxUsd: null },
          dependencies: { stages: [], capsules: [], missingCapsule: "fail" },
          runGroup: { id: "rg-834", key: null },
          capsules: { consume: [], produce: [] },
          subStages: [],
        },
      }),
      stageName: "investigate",
      defaultRunnerKind: "codex",
      defaultRunnerModel: null,
      defaultRunnerProvider: "codex-app-server",
      baseRef: "origin/main",
      artifactRoot: "/tmp/artifacts/issue-834",
    });

    expect(job.runner.provider).toBe("codex-app-server");
  });

  it("does not apply a top-level provider across a stage runner override", () => {
    const job = createStageExecutionJobSpec({
      issue: createIssue({ id: "issue-834", identifier: "SYMPH-834" }),
      attempt: 0,
      stage: createStage({
        runner: "gemini",
        execution: {
          role: "investigator",
          phase: "investigate",
          backend: "current-runner",
          controlNeeding: false,
          provider: null,
          model: null,
          reasoningEffort: null,
          profile: null,
          artifacts: { requires: [], produces: [] },
          timeoutMs: null,
          budget: { maxTokens: null, maxUsd: null },
          dependencies: { stages: [], capsules: [], missingCapsule: "fail" },
          runGroup: { id: "rg-834", key: null },
          capsules: { consume: [], produce: [] },
          subStages: [],
        },
      }),
      stageName: "investigate",
      defaultRunnerKind: "codex",
      defaultRunnerModel: null,
      defaultRunnerProvider: "openai",
      baseRef: "origin/main",
      artifactRoot: "/tmp/artifacts/issue-834",
    });

    expect(job.runner).toMatchObject({
      runnerKind: "gemini",
      provider: "gemini",
    });
  });

  it("changes identity when model/profile/base/head fields change", () => {
    const base = {
      issueId: "issue-807",
      issueIdentifier: "SYMPH-807",
      stageKey: "implement",
      stageAttempt: 0,
      backend: "crabrunner",
      runGroupId: "rg-807",
      profileId: "write.pro16",
      baseRef: "41e1975",
      targetHeadRef: "head-a",
      enforcement: createEnforcement(),
      runner: {
        runnerKind: "codex",
        model: "gpt-5.3-codex",
        provider: "openai",
        reasoningEffort: "medium",
      },
    };

    const original = createStageExecutionIdempotencyKey(base);
    expect(
      createStageExecutionIdempotencyKey({
        ...base,
        runner: { ...base.runner, model: "gpt-5.4-codex" },
      }),
    ).not.toBe(original);
    expect(
      createStageExecutionIdempotencyKey({
        ...base,
        runner: { ...base.runner, provider: "anthropic" },
      }),
    ).not.toBe(original);
    expect(
      createStageExecutionIdempotencyKey({
        ...base,
        profileId: "write.studio1",
      }),
    ).not.toBe(original);
    expect(
      createStageExecutionIdempotencyKey({
        ...base,
        targetHeadRef: "head-b",
      }),
    ).not.toBe(original);
    expect(
      createStageExecutionIdempotencyKey({
        ...base,
        baseRef: "41e1976",
      }),
    ).not.toBe(original);
    expect(
      createStageExecutionIdempotencyKey({
        ...base,
        enforcement: {
          ...base.enforcement,
          budget: {
            ...base.enforcement.budget,
            maxTokens: 24_000,
          },
        },
      }),
    ).not.toBe(original);
  });

  it("keeps scheduler-key visible segments bounded and non-empty", () => {
    const key = createStageExecutionIdempotencyKey({
      issueId: "issue-807",
      issueIdentifier: `${"a".repeat(80)}!!!`,
      stageKey: "!!!",
      stageAttempt: 3,
      backend: "crabrunner",
      runGroupId: "rg-807",
      profileId: null,
      baseRef: "41e1975",
      targetHeadRef: "feature/SYMPH-807",
      enforcement: createEnforcement(),
      runner: {
        runnerKind: "codex",
        model: null,
        provider: null,
        reasoningEffort: null,
      },
    });

    expect(key).toMatch(
      new RegExp(
        `^stage-execution:${"a".repeat(64)}:unknown:3:crabrunner:[a-f0-9]{20}$`,
      ),
    );
  });

  it("collapses unsafe scheduler-key runs and trims slice-created trailing dashes", () => {
    const key = createStageExecutionIdempotencyKey({
      issueId: "issue-807",
      issueIdentifier: `${"a".repeat(63)}!!!b`,
      stageKey: "<script>\nphase\tone</script>",
      stageAttempt: 3,
      backend: "crabrunner",
      runGroupId: "rg-807",
      profileId: null,
      baseRef: "41e1975",
      targetHeadRef: "feature/SYMPH-807",
      enforcement: createEnforcement(),
      runner: {
        runnerKind: "codex",
        model: null,
        provider: null,
        reasoningEffort: null,
      },
    });

    expect(key).toMatch(
      new RegExp(
        `^stage-execution:${"a".repeat(63)}:script-phase-one-script:3:crabrunner:[a-f0-9]{20}$`,
      ),
    );
  });
});

function createIssue(overrides: Partial<Issue>): Issue {
  return {
    id: "issue-1",
    identifier: "ISSUE-1",
    title: "Issue 1",
    description: null,
    priority: 1,
    state: "In Progress",
    branchName: null,
    url: null,
    labels: [],
    blockedBy: [],
    createdAt: null,
    updatedAt: null,
    ...overrides,
  };
}

function createStage(overrides: Partial<StageDefinition>): StageDefinition {
  return {
    type: "agent",
    runner: "codex",
    model: "gpt-5.3-codex",
    reasoningEffort: null,
    prompt: null,
    maxTurns: null,
    timeoutMs: null,
    concurrency: null,
    gateType: null,
    maxRework: null,
    reviewers: [],
    transitions: { onComplete: null, onApprove: null, onRework: null },
    linearState: null,
    hardStops: null,
    execution: null,
    ...overrides,
  };
}

function createHardStops(
  overrides: Partial<WorkflowHardStopsConfig> = {},
): WorkflowHardStopsConfig {
  return {
    maxIterations: 10,
    noProgressTurns: 3,
    maxTokensPerUnit: 100_000,
    maxDollarBudgetUsd: 10,
    premiumBudgetPauseRatio: 0.8,
    liveBudgetGraceRatio: 0.2,
    estimatedCostPer1kTokensUsd: 0.05,
    cachedTokenCostRatio: 0.1,
    maxPrimaryWindowPctPerUnit: null,
    maxSecondaryWindowPctPerUnit: null,
    ...overrides,
  };
}

function createEnforcement(
  overrides: Partial<StageExecutionEnforcementContract> = {},
): StageExecutionEnforcementContract {
  return {
    required: true,
    budget: {
      maxTokens: 12_000,
      maxUsd: 1.25,
      estimatedCostPer1kTokensUsd: 0.05,
      cachedTokenCostRatio: 0.1,
      liveBudgetGraceRatio: 0.2,
    },
    timing: {
      timeoutMs: 180_000,
      stallTimeoutMs: 90_000,
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
    ...overrides,
  };
}
