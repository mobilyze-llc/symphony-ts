import type { WorkflowHardStopsConfig } from "../config/types.js";
import type { RightSizingMode } from "../domain/model.js";

export type HardStopOutcome =
  | "DONE"
  | "BLOCKED-needs-human"
  | "STALLED"
  | "PAUSED-budget";

export type HardStopTrigger =
  | "iteration_cap"
  | "no_progress"
  | "token_budget"
  | "dollar_budget"
  | "premium_spend_near_ceiling"
  | "permission_denied";

export interface HardStopDecision {
  outcome: HardStopOutcome;
  trigger: HardStopTrigger;
  reason: string;
  turnCount: number;
  totalTokens: number;
  estimatedCostUsd: number;
}

export type ModePermissionAction =
  | "open_pull_request"
  | "auto_merge"
  | "bypass_gates";

export type ClaudePermissionMode =
  | "default"
  | "acceptEdits"
  | "bypassPermissions";

export interface ModeScopedPermissionPolicy {
  mode: RightSizingMode;
  approvalPolicy: unknown;
  threadSandbox: unknown;
  turnSandboxPolicy: unknown;
  claudePermissionMode: ClaudePermissionMode;
  canOpenPullRequest: boolean;
  canAutoMerge: false;
  canBypassGates: false;
  maxBudgetUsd: number;
}

export function resolveHardStopsConfig(
  config: WorkflowHardStopsConfig | undefined,
  fallback: WorkflowHardStopsConfig,
): WorkflowHardStopsConfig {
  return config ?? fallback;
}

export function createModeScopedPermissionPolicy(input: {
  mode: RightSizingMode;
  configuredApprovalPolicy: unknown;
  configuredThreadSandbox: unknown;
  configuredTurnSandboxPolicy: unknown;
  maxBudgetUsd: number;
}): ModeScopedPermissionPolicy {
  switch (input.mode) {
    case "prototype":
      return {
        mode: "prototype",
        approvalPolicy: "never",
        threadSandbox: "workspace-write",
        turnSandboxPolicy: {
          type: "workspace-write",
          networkAccess: false,
        },
        claudePermissionMode: "acceptEdits",
        canOpenPullRequest: false,
        canAutoMerge: false,
        canBypassGates: false,
        maxBudgetUsd: Math.min(input.maxBudgetUsd, 5),
      };

    case "thin":
      return {
        mode: "thin",
        approvalPolicy: input.configuredApprovalPolicy ?? "on-request",
        threadSandbox: input.configuredThreadSandbox ?? "workspace-write",
        turnSandboxPolicy: input.configuredTurnSandboxPolicy ?? {
          type: "workspace-write",
        },
        claudePermissionMode: "acceptEdits",
        canOpenPullRequest: false,
        canAutoMerge: false,
        canBypassGates: false,
        maxBudgetUsd: Math.min(input.maxBudgetUsd, 20),
      };

    case "full":
      return {
        mode: "full",
        approvalPolicy: input.configuredApprovalPolicy ?? "on-request",
        threadSandbox: input.configuredThreadSandbox ?? "workspace-write",
        turnSandboxPolicy: input.configuredTurnSandboxPolicy ?? {
          type: "workspace-write",
        },
        claudePermissionMode: "bypassPermissions",
        canOpenPullRequest: true,
        canAutoMerge: false,
        canBypassGates: false,
        maxBudgetUsd: input.maxBudgetUsd,
      };
  }
}

export function evaluateModePermission(input: {
  policy: ModeScopedPermissionPolicy;
  action: ModePermissionAction;
}):
  | {
      allowed: true;
    }
  | {
      allowed: false;
      hardStop: HardStopDecision;
    } {
  const allowed =
    input.action === "open_pull_request"
      ? input.policy.canOpenPullRequest
      : input.action === "auto_merge"
        ? input.policy.canAutoMerge
        : input.policy.canBypassGates;

  if (allowed) {
    return { allowed: true };
  }

  return {
    allowed: false,
    hardStop: {
      outcome: "BLOCKED-needs-human",
      trigger: "permission_denied",
      reason: `${input.action} is not allowed in ${input.policy.mode} mode.`,
      turnCount: 0,
      totalTokens: 0,
      estimatedCostUsd: 0,
    },
  };
}

export function evaluateBudgetHardStop(input: {
  config: WorkflowHardStopsConfig;
  turnCount: number;
  totalTokens: number;
}): HardStopDecision | null {
  const estimatedCostUsd = estimateCostUsd({
    totalTokens: input.totalTokens,
    estimatedCostPer1kTokensUsd: input.config.estimatedCostPer1kTokensUsd,
  });

  if (input.totalTokens >= input.config.maxTokensPerUnit) {
    return {
      outcome: "PAUSED-budget",
      trigger: "token_budget",
      reason: `Token budget exceeded: ${input.totalTokens} >= ${input.config.maxTokensPerUnit}.`,
      turnCount: input.turnCount,
      totalTokens: input.totalTokens,
      estimatedCostUsd,
    };
  }

  if (estimatedCostUsd >= input.config.maxDollarBudgetUsd) {
    return {
      outcome: "PAUSED-budget",
      trigger: "dollar_budget",
      reason: `Estimated dollar budget exceeded: ${formatCost(estimatedCostUsd)} >= ${formatCost(input.config.maxDollarBudgetUsd)}.`,
      turnCount: input.turnCount,
      totalTokens: input.totalTokens,
      estimatedCostUsd,
    };
  }

  if (
    estimatedCostUsd >=
    input.config.maxDollarBudgetUsd * input.config.premiumBudgetPauseRatio
  ) {
    return {
      outcome: "PAUSED-budget",
      trigger: "premium_spend_near_ceiling",
      reason: `Estimated premium spend is near ceiling: ${formatCost(estimatedCostUsd)} of ${formatCost(input.config.maxDollarBudgetUsd)}.`,
      turnCount: input.turnCount,
      totalTokens: input.totalTokens,
      estimatedCostUsd,
    };
  }

  return null;
}

export function evaluateIterationHardStop(input: {
  config: WorkflowHardStopsConfig;
  turnCount: number;
  totalTokens: number;
}): HardStopDecision | null {
  if (input.turnCount < input.config.maxIterations) {
    return null;
  }

  return {
    outcome: "STALLED",
    trigger: "iteration_cap",
    reason: `Iteration cap reached: ${input.turnCount} >= ${input.config.maxIterations}.`,
    turnCount: input.turnCount,
    totalTokens: input.totalTokens,
    estimatedCostUsd: estimateCostUsd({
      totalTokens: input.totalTokens,
      estimatedCostPer1kTokensUsd: input.config.estimatedCostPer1kTokensUsd,
    }),
  };
}

export function evaluateNoProgressHardStop(input: {
  config: WorkflowHardStopsConfig;
  repeatedNoProgressTurns: number;
  turnCount: number;
  totalTokens: number;
}): HardStopDecision | null {
  if (
    input.config.noProgressTurns <= 0 ||
    input.repeatedNoProgressTurns < input.config.noProgressTurns
  ) {
    return null;
  }

  return {
    outcome: "STALLED",
    trigger: "no_progress",
    reason: `No-progress cap reached after ${input.repeatedNoProgressTurns} unchanged turns.`,
    turnCount: input.turnCount,
    totalTokens: input.totalTokens,
    estimatedCostUsd: estimateCostUsd({
      totalTokens: input.totalTokens,
      estimatedCostPer1kTokensUsd: input.config.estimatedCostPer1kTokensUsd,
    }),
  };
}

function estimateCostUsd(input: {
  totalTokens: number;
  estimatedCostPer1kTokensUsd: number;
}): number {
  return (input.totalTokens / 1000) * input.estimatedCostPer1kTokensUsd;
}

function formatCost(cost: number): string {
  return `$${cost.toFixed(2)}`;
}
