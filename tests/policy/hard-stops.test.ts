import { describe, expect, it } from "vitest";

import {
  computeBillableTokens,
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

type BudgetHardStopInput = Parameters<typeof evaluateBudgetHardStop>[0];

const CONFIG = {
  maxIterations: 3,
  noProgressTurns: 2,
  maxTokensPerUnit: 1000,
  maxDollarBudgetUsd: 10,
  premiumBudgetPauseRatio: 0.8,
  liveBudgetGraceRatio: 0.1,
  estimatedCostPer1kTokensUsd: 5,
  cachedTokenCostRatio: 0.1,
  maxPrimaryWindowPctPerUnit: null,
  maxSecondaryWindowPctPerUnit: null,
};

function evaluateCodexBudget(
  input: Omit<
    BudgetHardStopInput,
    "provider" | "model" | "inputTokens" | "outputTokens"
  > &
    Partial<
      Pick<
        BudgetHardStopInput,
        | "provider"
        | "model"
        | "inputTokens"
        | "outputTokens"
        | "cacheWriteTokens"
      >
    >,
) {
  const {
    provider = "openai",
    model = "codex",
    inputTokens,
    outputTokens = 0,
    cacheReadTokens = 0,
    cacheWriteTokens = 0,
    ...rest
  } = input;

  return evaluateBudgetHardStop({
    ...rest,
    provider,
    model,
    inputTokens:
      inputTokens ??
      Math.max(
        rest.totalTokens - outputTokens - cacheReadTokens - cacheWriteTokens,
        0,
      ),
    outputTokens,
    cacheReadTokens,
    cacheWriteTokens,
  });
}

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
      evaluateCodexBudget({
        config: CONFIG,
        turnCount: 1,
        totalTokens: 1001,
      }),
    ).toMatchObject({
      outcome: "PAUSED-budget",
      trigger: "token_budget",
    });

    expect(
      evaluateCodexBudget({
        config: {
          ...CONFIG,
          maxTokensPerUnit: 10_000,
          maxDollarBudgetUsd: 10,
        },
        turnCount: 1,
        totalTokens: 1_100_000,
        provider: "openai",
        model: "gpt-5.5",
        inputTokens: 1_000_000,
        outputTokens: 100_001,
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
    expect(
      computeBillableTokens({
        totalTokens: 87_657,
        cacheReadTokens: 60_672,
        config: { cachedTokenCostRatio: 0.1 },
      }),
    ).toBe(33_052);
  });

  it("weights equal raw token counts differently by token family", () => {
    const config = {
      ...CONFIG,
      maxTokensPerUnit: 500,
      maxDollarBudgetUsd: 1_000_000,
    };

    expect(
      evaluateCodexBudget({
        config,
        turnCount: 1,
        totalTokens: 1000,
        inputTokens: 0,
        outputTokens: 0,
        cacheReadTokens: 1000,
      }),
    ).toBeNull();

    expect(
      evaluateCodexBudget({
        config,
        turnCount: 1,
        totalTokens: 1000,
        inputTokens: 0,
        outputTokens: 1000,
      }),
    ).toMatchObject({
      trigger: "token_budget",
      budgetDenomination: "weighted_tokens",
      budgetTotal: 6000,
    });
  });

  it("charges gross cache-read input as net input plus discounted cache read", () => {
    const decision = evaluateCodexBudget({
      config: {
        ...CONFIG,
        maxTokensPerUnit: 189,
        maxDollarBudgetUsd: 1_000_000,
      },
      turnCount: 1,
      totalTokens: 1000,
      inputTokens: 100,
      outputTokens: 0,
      cacheReadTokens: 900,
    });

    expect(decision).toMatchObject({
      trigger: "token_budget",
      budgetDenomination: "weighted_tokens",
      budgetTotal: 190,
    });
  });

  it("weights cache writes above cache reads for Codex credit budgets", () => {
    const config = {
      ...CONFIG,
      maxTokensPerUnit: 1249,
      maxDollarBudgetUsd: 1_000_000,
    };

    expect(
      evaluateCodexBudget({
        config,
        turnCount: 1,
        totalTokens: 1000,
        inputTokens: 0,
        outputTokens: 0,
        cacheReadTokens: 1000,
      }),
    ).toBeNull();

    expect(
      evaluateCodexBudget({
        config,
        turnCount: 1,
        totalTokens: 1000,
        inputTokens: 0,
        outputTokens: 0,
        cacheWriteTokens: 1000,
      }),
    ).toMatchObject({
      trigger: "token_budget",
      budgetDenomination: "weighted_tokens",
      budgetTotal: 1250,
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

    // The token trigger fires on weighted tokens; these cases supply enough
    // normalized usage to exceed the 1000-token cap.
    expect(
      evaluateCodexBudget({
        config,
        turnCount: 1,
        totalTokens: 1541,
        cacheReadTokens: 600,
      }),
    ).toMatchObject({
      trigger: "token_budget",
      budgetTotal: 1001,
      estimatedCostUsd: expect.closeTo(5.005, 10),
    });

    // cacheReadTokens above raw total clamps to the total.
    expect(
      evaluateCodexBudget({
        config: { ...config, maxTokensPerUnit: 999 },
        turnCount: 1,
        totalTokens: 10_000,
        cacheReadTokens: 50_000,
      }),
    ).toMatchObject({
      trigger: "token_budget",
      estimatedCostUsd: expect.closeTo(5, 10),
    });

    // Negative cache telemetry clamps to zero discount.
    expect(
      evaluateCodexBudget({
        config,
        turnCount: 1,
        totalTokens: 1001,
        inputTokens: 1001,
        cacheReadTokens: -100,
      }),
    ).toMatchObject({
      trigger: "token_budget",
      estimatedCostUsd: expect.closeTo(5.005, 10),
    });
  });

  it("clamps malformed cache-write telemetry in weighted usage", () => {
    expect(
      evaluateCodexBudget({
        config: {
          ...CONFIG,
          maxTokensPerUnit: 2000,
          maxDollarBudgetUsd: 1_000_000,
        },
        turnCount: 1,
        totalTokens: 1000,
        inputTokens: 0,
        outputTokens: 0,
        cacheWriteTokens: 50_000,
      }),
    ).toBeNull();

    expect(
      evaluateCodexBudget({
        config: {
          ...CONFIG,
          maxTokensPerUnit: 5000,
          maxDollarBudgetUsd: 1_000_000,
        },
        turnCount: 1,
        totalTokens: 1000,
        inputTokens: 0,
        outputTokens: 0,
        cacheWriteTokens: -100,
      }),
    ).toMatchObject({
      trigger: "token_budget",
      budgetTotal: 6000,
    });
  });

  it("evaluates the token trigger on weighted tokens", () => {
    const config = {
      ...CONFIG,
      maxTokensPerUnit: 250_000,
      maxDollarBudgetUsd: 1_000_000,
      estimatedCostPer1kTokensUsd: 5,
      cachedTokenCostRatio: 0.1,
    };

    // SYMPH-330 unit 3 shape: 1.03M raw, 90% cached — weighted usage still
    // stays under the 250K ceiling because cache-read tokens remain 0.1x.
    expect(
      evaluateCodexBudget({
        config,
        turnCount: 30,
        totalTokens: 1_032_161,
        cacheReadTokens: 921_344,
      }),
    ).toBeNull();

    // Genuinely uncached burn still pauses at the nominal ceiling.
    const uncached = evaluateCodexBudget({
      config,
      turnCount: 5,
      totalTokens: 250_001,
      cacheReadTokens: 0,
    });
    expect(uncached?.trigger).toBe("token_budget");
    expect(uncached?.reason).toContain("weighted_tokens > 250000");
    expect(uncached?.reason).toContain("legacy billable tokens");
    expect(uncached?.reason).toContain("raw 250001");

    // Missing cache telemetry degrades to raw totals (conservative).
    expect(
      evaluateCodexBudget({
        config,
        turnCount: 5,
        totalTokens: 250_001,
      })?.trigger,
    ).toBe("token_budget");

    // Discounted crossing reports both measures and keeps raw totals in
    // the decision for observability.
    const crossed = evaluateCodexBudget({
      config,
      turnCount: 60,
      totalTokens: 1_500_000,
      cacheReadTokens: 1_200_000,
    });
    expect(crossed).toMatchObject({
      trigger: "token_budget",
      totalTokens: 1_500_000,
    });
    expect(crossed?.reason).toContain("legacy billable tokens");
    expect(crossed?.billableTokens).toBe(420_000);
    expect(crossed?.budgetTotal).toBe(420_000);
  });

  it("uses strict crucible budget boundaries for weighted stops", () => {
    expect(
      evaluateCodexBudget({
        config: {
          ...CONFIG,
          maxTokensPerUnit: 1000,
          maxDollarBudgetUsd: 1_000_000,
        },
        turnCount: 1,
        totalTokens: 1000,
      }),
    ).toBeNull();

    expect(
      evaluateCodexBudget({
        config: {
          ...CONFIG,
          maxTokensPerUnit: 1000,
          maxDollarBudgetUsd: 1_000_000,
        },
        turnCount: 1,
        totalTokens: 1001,
      }),
    ).toMatchObject({
      trigger: "token_budget",
      budgetTotal: 1001,
    });
  });

  it("uses strict crucible budget boundaries for dollar stops", () => {
    const config = {
      ...CONFIG,
      maxTokensPerUnit: 1_000_000_000,
      maxDollarBudgetUsd: 5,
      premiumBudgetPauseRatio: 1,
    };

    expect(
      evaluateCodexBudget({
        config,
        turnCount: 1,
        totalTokens: 1_000_000,
        provider: "openai",
        model: "gpt-5.5",
        inputTokens: 1_000_000,
        outputTokens: 0,
      }),
    ).toBeNull();

    expect(
      evaluateCodexBudget({
        config,
        turnCount: 1,
        totalTokens: 1_000_001,
        provider: "openai",
        model: "gpt-5.5",
        inputTokens: 1_000_001,
        outputTokens: 0,
      }),
    ).toMatchObject({
      trigger: "dollar_budget",
      budgetDenomination: "usd",
      budgetTotal: expect.closeTo(5.000005, 9),
    });
  });

  it("records budget-not-enforced notes without pausing", () => {
    const notes: Array<{
      provider: string;
      model: string;
      note: string;
      billingMode: string | null;
    }> = [];

    expect(
      evaluateBudgetHardStop({
        config: CONFIG,
        turnCount: 1,
        totalTokens: 1_000_000,
        provider: "deepseek",
        model: "deepseek-v4-pro",
        inputTokens: 1_000_000,
        outputTokens: 0,
        onBudgetNotEnforced: (event) => notes.push(event),
      }),
    ).toBeNull();

    expect(notes).toEqual([
      {
        provider: "deepseek",
        model: "deepseek-v4-pro",
        note: "budget_not_enforced:diagnostic_only",
        billingMode: "diagnostic_only",
      },
    ]);
  });

  it("locks the discount clamp contract at the extremes", () => {
    const config = {
      ...CONFIG,
      maxTokensPerUnit: 1000,
      maxDollarBudgetUsd: 1_000_000,
      estimatedCostPer1kTokensUsd: 5,
    };

    // Fully-cached unit at max discount: billable is 0 — never fires.
    expect(
      evaluateCodexBudget({
        config: { ...config, cachedTokenCostRatio: 0 },
        turnCount: 1,
        totalTokens: 1000,
        cacheReadTokens: 5000,
      }),
    ).toBeNull();

    expect(
      computeBillableTokens({
        totalTokens: 1000,
        cacheReadTokens: 900,
        config: { cachedTokenCostRatio: undefined as unknown as number },
      }),
    ).toBe(1000);

    // null ALSO fails closed: Number.isFinite does not coerce (unlike the
    // global isFinite), so null gets no discount in the legacy billable view.
    expect(
      computeBillableTokens({
        totalTokens: 1000,
        cacheReadTokens: 1000,
        config: { cachedTokenCostRatio: null as unknown as number },
      }),
    ).toBe(1000);
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

  it("allows thin and full implement PR handoff while denying prototype PRs", () => {
    const prototypePolicy = createModeScopedPermissionPolicy({
      mode: "prototype",
      stageName: "implement",
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

    const thinPolicy = createModeScopedPermissionPolicy({
      mode: "thin",
      stageName: "implement",
      configuredApprovalPolicy: "full-auto",
      configuredThreadSandbox: { type: "fullAccess" },
      configuredTurnSandboxPolicy: { type: "fullAccess" },
      maxBudgetUsd: 50,
    });
    expect(thinPolicy).toMatchObject({
      canOpenPullRequest: true,
      canAutoMerge: false,
      canBypassGates: false,
      maxBudgetUsd: 20,
    });
    expect(
      evaluateModePermission({
        policy: thinPolicy,
        action: "open_pull_request",
      }),
    ).toEqual({ allowed: true });
    expect(
      evaluateModePermission({
        policy: thinPolicy,
        action: "open_ready_pull_request",
      }),
    ).toMatchObject({
      allowed: false,
      hardStop: {
        outcome: "BLOCKED-needs-human",
        trigger: "permission_denied",
        reason: expect.stringContaining(
          "Re-run the PR creation command with `--draft`",
        ),
      },
    });
    expect(
      evaluateModePermission({
        policy: thinPolicy,
        action: "mark_pull_request_ready",
      }),
    ).toMatchObject({
      allowed: false,
      hardStop: {
        outcome: "BLOCKED-needs-human",
        trigger: "permission_denied",
        reason: expect.stringContaining(
          "marking a pipeline-owned pull request ready is not allowed",
        ),
      },
    });

    const fullPolicy = createModeScopedPermissionPolicy({
      mode: "full",
      stageName: "implement",
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
  });

  it("denies non-implement PRs and all auto-merge or gate-bypass attempts", () => {
    const thinMergePolicy = createModeScopedPermissionPolicy({
      mode: "thin",
      stageName: "merge",
      configuredApprovalPolicy: "full-auto",
      configuredThreadSandbox: { type: "fullAccess" },
      configuredTurnSandboxPolicy: { type: "fullAccess" },
      maxBudgetUsd: 50,
    });
    expect(
      evaluateModePermission({
        policy: thinMergePolicy,
        action: "open_pull_request",
      }),
    ).toMatchObject({
      allowed: false,
      hardStop: {
        outcome: "BLOCKED-needs-human",
        trigger: "permission_denied",
        reason:
          "open_pull_request is not allowed in thin mode during the merge stage.",
      },
    });

    const fullMergePolicy = createModeScopedPermissionPolicy({
      mode: "full",
      stageName: "merge",
      configuredApprovalPolicy: "full-auto",
      configuredThreadSandbox: { type: "fullAccess" },
      configuredTurnSandboxPolicy: { type: "fullAccess" },
      maxBudgetUsd: 50,
    });
    expect(
      evaluateModePermission({
        policy: fullMergePolicy,
        action: "open_pull_request",
      }),
    ).toMatchObject({
      allowed: false,
      hardStop: {
        outcome: "BLOCKED-needs-human",
        trigger: "permission_denied",
        reason:
          "open_pull_request is not allowed in full mode during the merge stage.",
      },
    });
    expect(
      evaluateModePermission({
        policy: fullMergePolicy,
        action: "mark_pull_request_ready",
      }),
    ).toMatchObject({
      allowed: false,
      hardStop: {
        outcome: "BLOCKED-needs-human",
        trigger: "permission_denied",
        reason: expect.stringContaining(
          "marking a pipeline-owned pull request ready is not allowed",
        ),
      },
    });

    const unscopedFullPolicy = createModeScopedPermissionPolicy({
      mode: "full",
      configuredApprovalPolicy: "full-auto",
      configuredThreadSandbox: { type: "fullAccess" },
      configuredTurnSandboxPolicy: { type: "fullAccess" },
      maxBudgetUsd: 50,
    });
    expect(unscopedFullPolicy.canOpenPullRequest).toBe(false);
    expect(
      evaluateModePermission({
        policy: unscopedFullPolicy,
        action: "open_pull_request",
      }),
    ).toMatchObject({
      allowed: false,
      hardStop: {
        outcome: "BLOCKED-needs-human",
        trigger: "permission_denied",
        reason:
          "open_pull_request is not allowed in full mode without an active stage.",
      },
    });

    const fullImplementPolicy = createModeScopedPermissionPolicy({
      mode: "full",
      stageName: "implement",
      configuredApprovalPolicy: "full-auto",
      configuredThreadSandbox: { type: "fullAccess" },
      configuredTurnSandboxPolicy: { type: "fullAccess" },
      maxBudgetUsd: 50,
    });
    expect(
      evaluateModePermission({
        policy: fullImplementPolicy,
        action: "auto_merge",
      }),
    ).toMatchObject({
      allowed: false,
      hardStop: {
        outcome: "BLOCKED-needs-human",
        trigger: "permission_denied",
      },
    });
    expect(
      evaluateModePermission({
        policy: fullImplementPolicy,
        action: "bypass_gates",
      }),
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

  it("classifies PR creation, readiness flips, auto-merge, and bypass commands for active runner enforcement", () => {
    expect(
      detectModePermissionAction({
        toolName: "Bash",
        toolInput: { command: "gh pr create --fill --draft" },
      }),
    ).toBe("open_pull_request");
    expect(
      detectModePermissionAction({
        toolName: "Bash",
        toolInput: { command: "gh pr create -d --fill" },
      }),
    ).toBe("open_pull_request");
    expect(
      detectModePermissionAction({
        toolName: "Bash",
        toolInput: { command: "gh pr create --Draft --fill" },
      }),
    ).toBe("open_pull_request");
    expect(
      detectModePermissionAction({
        toolName: "Bash",
        toolInput: { command: "gh pr create --fill" },
      }),
    ).toBe("open_ready_pull_request");
    expect(
      detectModePermissionAction({
        toolName: "Bash",
        toolInput: { command: "gh pr create --draft=false" },
      }),
    ).toBe("open_ready_pull_request");
    expect(
      detectModePermissionAction({
        toolName: "Bash",
        toolInput: { command: "gh pr create --draft false" },
      }),
    ).toBe("open_ready_pull_request");
    expect(
      detectModePermissionAction({
        toolName: "Bash",
        toolInput: { command: "hub pull-request --draft" },
      }),
    ).toBe("open_pull_request");
    expect(
      detectModePermissionAction({
        toolName: "Bash",
        toolInput: { command: "hub pull-request -d" },
      }),
    ).toBe("open_pull_request");
    expect(
      detectModePermissionAction({
        toolName: "Bash",
        toolInput: { command: "hub pull-request --message 'ship it'" },
      }),
    ).toBe("open_ready_pull_request");
    expect(
      detectModePermissionAction({
        toolName: "Bash",
        toolInput: { command: "gh pr ready 270" },
      }),
    ).toBe("mark_pull_request_ready");
    expect(
      detectModePermissionAction({
        toolName: "Bash",
        toolInput: { command: "gh pr edit 270 --draft=false" },
      }),
    ).toBe("mark_pull_request_ready");
    expect(
      detectModePermissionAction({
        toolName: "Bash",
        toolInput: { command: "gh pr edit 270 --draft false" },
      }),
    ).toBe("mark_pull_request_ready");
    expect(
      detectModePermissionAction({
        toolName: "Bash",
        toolInput: { command: "gh pr edit 270 --draft" },
      }),
    ).toBeNull();
    expect(
      detectModePermissionAction({
        toolName: "Bash",
        toolInput: { command: "gh pr edit 270 --draft=true" },
      }),
    ).toBeNull();
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

  it("renders mode envelopes that allow thin implement PRs and deny merge bypass actions", () => {
    const thinPolicy = createModeScopedPermissionPolicy({
      mode: "thin",
      stageName: "implement",
      configuredApprovalPolicy: "full-auto",
      configuredThreadSandbox: "workspace-write",
      configuredTurnSandboxPolicy: { type: "workspace-write" },
      maxBudgetUsd: 50,
    });
    const fullPolicy = createModeScopedPermissionPolicy({
      mode: "full",
      stageName: "merge",
      configuredApprovalPolicy: "full-auto",
      configuredThreadSandbox: "workspace-write",
      configuredTurnSandboxPolicy: { type: "workspace-write" },
      maxBudgetUsd: 50,
    });

    expect(describeModePermissionEnvelope(thinPolicy)).toContain(
      "Stage: implement",
    );
    expect(describeModePermissionEnvelope(thinPolicy)).toContain(
      "Pull requests: allowed to open a draft PR",
    );
    expect(describeModePermissionEnvelope(thinPolicy)).toContain(
      "gh pr create --draft",
    );
    expect(describeModePermissionEnvelope(fullPolicy)).toContain(
      "Stage: merge",
    );
    expect(describeModePermissionEnvelope(fullPolicy)).toContain(
      "Pull requests: denied",
    );
    expect(describeModePermissionEnvelope(fullPolicy)).toContain(
      "Auto-merge / merge-queue enqueue: denied",
    );
    expect(describeModePermissionEnvelope(fullPolicy)).toContain(
      "Gate bypass: denied",
    );
    expect(describeModePermissionEnvelope(fullPolicy)).toContain(
      "[BLOCKED_NEEDS_HUMAN_BLOCKERS: {...}]",
    );
  });
});
