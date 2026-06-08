import { describe, expect, it } from "vitest";

import {
  createModeScopedPermissionPolicy,
  evaluateBudgetHardStop,
  evaluateIterationHardStop,
  evaluateModePermission,
  evaluateNoProgressHardStop,
} from "../../src/policy/hard-stops.js";

const CONFIG = {
  maxIterations: 3,
  noProgressTurns: 2,
  maxTokensPerUnit: 1000,
  maxDollarBudgetUsd: 10,
  premiumBudgetPauseRatio: 0.8,
  estimatedCostPer1kTokensUsd: 5,
};

describe("hard-stop policy", () => {
  it("triggers STALLED when the iteration cap is reached", () => {
    expect(
      evaluateIterationHardStop({
        config: CONFIG,
        turnCount: 3,
        totalTokens: 300,
      }),
    ).toMatchObject({
      outcome: "STALLED",
      trigger: "iteration_cap",
    });
  });

  it("triggers STALLED after repeated no-progress turns", () => {
    expect(
      evaluateNoProgressHardStop({
        config: CONFIG,
        repeatedNoProgressTurns: 2,
        turnCount: 2,
        totalTokens: 300,
      }),
    ).toMatchObject({
      outcome: "STALLED",
      trigger: "no_progress",
    });
  });

  it("pauses for token and near-ceiling dollar budgets", () => {
    expect(
      evaluateBudgetHardStop({
        config: CONFIG,
        turnCount: 1,
        totalTokens: 1000,
      }),
    ).toMatchObject({
      outcome: "PAUSED-budget",
      trigger: "token_budget",
    });

    expect(
      evaluateBudgetHardStop({
        config: {
          ...CONFIG,
          maxTokensPerUnit: 10_000,
        },
        turnCount: 1,
        totalTokens: 1600,
      }),
    ).toMatchObject({
      outcome: "PAUSED-budget",
      trigger: "premium_spend_near_ceiling",
    });
  });

  it("denies prototype pull requests and all auto-merge attempts", () => {
    const prototypePolicy = createModeScopedPermissionPolicy({
      mode: "prototype",
      configuredApprovalPolicy: "full-auto",
      configuredThreadSandbox: { type: "fullAccess" },
      configuredTurnSandboxPolicy: { type: "fullAccess" },
      maxBudgetUsd: 50,
    });

    expect(prototypePolicy).toMatchObject({
      canOpenPullRequest: false,
      canAutoMerge: false,
      claudePermissionMode: "acceptEdits",
      maxBudgetUsd: 5,
    });
    expect(
      evaluateModePermission({
        policy: prototypePolicy,
        action: "open_pull_request",
      }),
    ).toMatchObject({
      allowed: false,
      hardStop: {
        outcome: "BLOCKED-needs-human",
        trigger: "permission_denied",
      },
    });

    const fullPolicy = createModeScopedPermissionPolicy({
      mode: "full",
      configuredApprovalPolicy: "full-auto",
      configuredThreadSandbox: { type: "fullAccess" },
      configuredTurnSandboxPolicy: { type: "fullAccess" },
      maxBudgetUsd: 50,
    });
    expect(
      evaluateModePermission({
        policy: fullPolicy,
        action: "open_pull_request",
      }),
    ).toEqual({ allowed: true });
    expect(
      evaluateModePermission({ policy: fullPolicy, action: "auto_merge" }),
    ).toMatchObject({
      allowed: false,
      hardStop: {
        outcome: "BLOCKED-needs-human",
        trigger: "permission_denied",
      },
    });
  });
});
