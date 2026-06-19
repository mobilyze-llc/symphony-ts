import { describe, expect, it } from "vitest";

import type { StageDefinition } from "../../src/config/types.js";
import type { Issue } from "../../src/domain/model.js";
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
        },
      }),
      stageName: "implement",
      defaultRunnerKind: "codex",
      defaultRunnerModel: null,
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
    });
    expect(job.identity.idempotencyKey).toMatch(
      /^stage-execution:SYMPH-807:implement:2:crabrunner:[a-f0-9]{20}$/,
    );
    expect(job.identity.idempotencyKey).not.toContain("feature/SYMPH-807:refs");
    expect(job.identity.idempotencyKey).not.toContain("rg:807");
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
