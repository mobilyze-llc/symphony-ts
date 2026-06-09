import { describe, expect, it } from "vitest";

import {
  createModeScopedPermissionPolicy,
  describeModePermissionEnvelope,
  detectModePermissionAction,
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

  it("preserves configured network-enabled sandbox for thin and full workers", () => {
    const turnSandboxPolicy = {
      type: "workspace-write",
      network_access: true,
    };

    const thinPolicy = createModeScopedPermissionPolicy({
      mode: "thin",
      configuredApprovalPolicy: "never",
      configuredThreadSandbox: "workspace-write",
      configuredTurnSandboxPolicy: turnSandboxPolicy,
      maxBudgetUsd: 50,
    });
    const fullPolicy = createModeScopedPermissionPolicy({
      mode: "full",
      configuredApprovalPolicy: "never",
      configuredThreadSandbox: "workspace-write",
      configuredTurnSandboxPolicy: turnSandboxPolicy,
      maxBudgetUsd: 50,
    });
    const prototypePolicy = createModeScopedPermissionPolicy({
      mode: "prototype",
      configuredApprovalPolicy: "never",
      configuredThreadSandbox: "workspace-write",
      configuredTurnSandboxPolicy: turnSandboxPolicy,
      maxBudgetUsd: 50,
    });

    expect(thinPolicy.turnSandboxPolicy).toBe(turnSandboxPolicy);
    expect(fullPolicy.turnSandboxPolicy).toBe(turnSandboxPolicy);
    expect(prototypePolicy.turnSandboxPolicy).toEqual({
      type: "workspace-write",
      networkAccess: false,
    });
  });

  it("classifies PR creation, auto-merge, and bypass commands for active runner enforcement", () => {
    expect(
      detectModePermissionAction({
        toolName: "Bash",
        toolInput: { command: "gh pr create --fill" },
      }),
    ).toBe("open_pull_request");
    expect(
      detectModePermissionAction({
        toolName: "Bash",
        toolInput: { command: "gh pr merge 270 --auto" },
      }),
    ).toBe("auto_merge");
    expect(
      detectModePermissionAction({
        toolName: "Bash",
        toolInput: { command: "gh pr merge 270 --admin" },
      }),
    ).toBe("bypass_gates");
    expect(
      detectModePermissionAction({
        toolName: "Bash",
        toolInput: { command: "git push --force-with-lease" },
      }),
    ).toBe("bypass_gates");
  });

  it("renders mode envelopes that deny thin/prototype PRs and all merge bypass actions", () => {
    const thinPolicy = createModeScopedPermissionPolicy({
      mode: "thin",
      configuredApprovalPolicy: "full-auto",
      configuredThreadSandbox: "workspace-write",
      configuredTurnSandboxPolicy: { type: "workspace-write" },
      maxBudgetUsd: 50,
    });
    const fullPolicy = createModeScopedPermissionPolicy({
      mode: "full",
      configuredApprovalPolicy: "full-auto",
      configuredThreadSandbox: "workspace-write",
      configuredTurnSandboxPolicy: { type: "workspace-write" },
      maxBudgetUsd: 50,
    });

    expect(describeModePermissionEnvelope(thinPolicy)).toContain(
      "Pull requests: denied",
    );
    expect(describeModePermissionEnvelope(fullPolicy)).toContain(
      "Pull requests: allowed",
    );
    expect(describeModePermissionEnvelope(fullPolicy)).toContain(
      "Auto-merge: denied",
    );
    expect(describeModePermissionEnvelope(fullPolicy)).toContain(
      "Gate bypass: denied",
    );
  });
});
