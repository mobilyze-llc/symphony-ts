import { describe, expect, it } from "vitest";

import {
  createModeScopedPermissionPolicy,
  describeModePermissionEnvelope,
  detectModePermissionAction,
  evaluateBudgetHardStop,
  evaluateIterationHardStop,
  evaluateModePermission,
  evaluateNoProgressHardStop,
  evaluateRateLimitBudgetHardStop,
  resolveHardStopsConfig,
} from "../../src/policy/hard-stops.js";

const CONFIG = {
  maxIterations: 3,
  noProgressTurns: 2,
  maxTokensPerUnit: 1000,
  maxDollarBudgetUsd: 10,
  premiumBudgetPauseRatio: 0.8,
  estimatedCostPer1kTokensUsd: 5,
  cachedTokenCostRatio: 0.1,
  maxPrimaryWindowPctPerUnit: null,
  maxSecondaryWindowPctPerUnit: null,
};

describe("hard-stop policy", () => {
  it("merges hard-stop overrides over fallback config", () => {
    expect(
      resolveHardStopsConfig(
        {
          maxTokensPerUnit: 80_000,
          maxDollarBudgetUsd: 4,
        },
        CONFIG,
      ),
    ).toEqual({
      ...CONFIG,
      maxTokensPerUnit: 80_000,
      maxDollarBudgetUsd: 4,
    });
  });

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

  it("pauses with rate_limit_budget when a unit burns its window share", () => {
    const decision = evaluateRateLimitBudgetHardStop({
      config: {
        ...CONFIG,
        maxSecondaryWindowPctPerUnit: 5,
      },
      turnCount: 3,
      totalTokens: 400,
      rateLimitUsage: {
        primary: null,
        secondary: {
          startPercent: 91,
          latestPercent: 96.5,
          lastResetsAt: 1781137743,
        },
      },
    });

    expect(decision).toMatchObject({
      outcome: "PAUSED-budget",
      trigger: "rate_limit_budget",
      turnCount: 3,
      totalTokens: 400,
    });
    expect(decision?.reason).toContain("secondary window burned 5.5%");
    expect(decision?.reason).toContain("91.0% -> 96.5%");
  });

  it("checks the primary window budget independently of the secondary", () => {
    const usage = {
      primary: {
        startPercent: 30,
        latestPercent: 56,
        lastResetsAt: 1781093929,
      },
      secondary: {
        startPercent: 90,
        latestPercent: 90.5,
        lastResetsAt: null,
      },
    };

    expect(
      evaluateRateLimitBudgetHardStop({
        config: { ...CONFIG, maxPrimaryWindowPctPerUnit: 25 },
        turnCount: 1,
        totalTokens: 100,
        rateLimitUsage: usage,
      }),
    ).toMatchObject({ trigger: "rate_limit_budget" });

    // Same usage with only the secondary budget configured stays under it.
    expect(
      evaluateRateLimitBudgetHardStop({
        config: { ...CONFIG, maxSecondaryWindowPctPerUnit: 5 },
        turnCount: 1,
        totalTokens: 100,
        rateLimitUsage: usage,
      }),
    ).toBeNull();
  });

  it("never pauses on rate limits when budgets are unconfigured or unobserved", () => {
    // Budgets off (defaults): heavy observed burn does not pause.
    expect(
      evaluateRateLimitBudgetHardStop({
        config: CONFIG,
        turnCount: 1,
        totalTokens: 100,
        rateLimitUsage: {
          primary: {
            startPercent: 0,
            latestPercent: 99,
            lastResetsAt: null,
          },
          secondary: null,
        },
      }),
    ).toBeNull();

    // Budget on but no snapshot observed yet: fail open.
    expect(
      evaluateRateLimitBudgetHardStop({
        config: {
          ...CONFIG,
          maxPrimaryWindowPctPerUnit: 1,
          maxSecondaryWindowPctPerUnit: 1,
        },
        turnCount: 1,
        totalTokens: 100,
        rateLimitUsage: { primary: null, secondary: null },
      }),
    ).toBeNull();
  });

  it("applies the cache discount to rate_limit_budget cost estimates", () => {
    const decision = evaluateRateLimitBudgetHardStop({
      config: { ...CONFIG, maxPrimaryWindowPctPerUnit: 10 },
      turnCount: 2,
      totalTokens: 1000,
      cacheReadTokens: 1000,
      rateLimitUsage: {
        primary: {
          startPercent: 10,
          latestPercent: 20,
          lastResetsAt: null,
        },
        secondary: null,
      },
    });

    // 1000 tokens fully cached at ratio 0.1 => 100 billable => $0.50 at $5/1k.
    expect(decision?.estimatedCostUsd).toBeCloseTo(0.5, 5);
  });

  it("discounts cached input tokens in the estimated dollar cost", () => {
    // Canary data from the SYMPH-319 run recorded after PR #314 landed:
    // 87,657 total tokens of which 60,672 were cache reads. Full-rate
    // pricing called this $4.38 and paused the worker; cache-aware pricing
    // is $1.65 of the $4 budget.
    const config = {
      ...CONFIG,
      maxTokensPerUnit: 240_000,
      maxDollarBudgetUsd: 4,
      premiumBudgetPauseRatio: 0.9,
      estimatedCostPer1kTokensUsd: 0.05,
      cachedTokenCostRatio: 0.1,
    };

    expect(
      evaluateBudgetHardStop({
        config,
        turnCount: 1,
        totalTokens: 87_657,
        cacheReadTokens: 60_672,
      }),
    ).toBeNull();

    expect(
      evaluateBudgetHardStop({
        config,
        turnCount: 1,
        totalTokens: 87_657,
      }),
    ).toMatchObject({
      outcome: "PAUSED-budget",
      trigger: "dollar_budget",
    });
  });

  it("clamps malformed cached token telemetry when estimating cost", () => {
    // Trigger via the token cap so the decision exposes estimatedCostUsd.
    const config = {
      ...CONFIG,
      maxTokensPerUnit: 1000,
      maxDollarBudgetUsd: 1_000_000,
      estimatedCostPer1kTokensUsd: 5,
      cachedTokenCostRatio: 0.1,
    };

    expect(
      evaluateBudgetHardStop({
        config,
        turnCount: 1,
        totalTokens: 1000,
        cacheReadTokens: 600,
      }),
    ).toMatchObject({
      trigger: "token_budget",
      estimatedCostUsd: expect.closeTo(2.3, 10),
    });

    expect(
      evaluateBudgetHardStop({
        config,
        turnCount: 1,
        totalTokens: 1000,
        cacheReadTokens: 5000,
      }),
    ).toMatchObject({
      trigger: "token_budget",
      estimatedCostUsd: expect.closeTo(0.5, 10),
    });

    expect(
      evaluateBudgetHardStop({
        config,
        turnCount: 1,
        totalTokens: 1000,
        cacheReadTokens: -100,
      }),
    ).toMatchObject({
      trigger: "token_budget",
      estimatedCostUsd: expect.closeTo(5, 10),
    });
  });

  it("applies the cache discount to iteration and no-progress decisions", () => {
    const config = {
      ...CONFIG,
      estimatedCostPer1kTokensUsd: 5,
      cachedTokenCostRatio: 0.1,
    };

    expect(
      evaluateIterationHardStop({
        config,
        turnCount: 3,
        totalTokens: 1000,
        cacheReadTokens: 600,
      }),
    ).toMatchObject({
      trigger: "iteration_cap",
      estimatedCostUsd: expect.closeTo(2.3, 10),
    });

    expect(
      evaluateNoProgressHardStop({
        config,
        repeatedNoProgressTurns: 2,
        turnCount: 2,
        totalTokens: 1000,
        cacheReadTokens: 600,
      }),
    ).toMatchObject({
      trigger: "no_progress",
      estimatedCostUsd: expect.closeTo(2.3, 10),
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
