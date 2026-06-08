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

export function detectModePermissionAction(input: {
  toolName: string | null;
  toolInput: unknown;
}): ModePermissionAction | null {
  const command = extractCommandText(input.toolInput);
  if (command === null) {
    return null;
  }

  const normalized = command.toLowerCase().replace(/\s+/g, " ").trim();
  if (normalized.length === 0) {
    return null;
  }

  if (containsGateBypass(normalized)) {
    return "bypass_gates";
  }

  if (/\bgh\s+pr\s+merge\b/.test(normalized)) {
    return "auto_merge";
  }

  if (
    /\bgh\s+pr\s+create\b/.test(normalized) ||
    /\bhub\s+pull-request\b/.test(normalized)
  ) {
    return "open_pull_request";
  }

  return null;
}

export function describeModePermissionEnvelope(
  policy: ModeScopedPermissionPolicy,
): string {
  const pullRequestLine = policy.canOpenPullRequest
    ? "- Pull requests: allowed to open a PR when the issue requires one."
    : "- Pull requests: denied. Do NOT run PR creation commands such as `gh pr create` or `hub pull-request`.";

  return [
    "## Mode Permission Envelope",
    `Mode: ${policy.mode}`,
    pullRequestLine,
    "- Auto-merge: denied. Do NOT run PR merge commands such as `gh pr merge`, including `--auto`.",
    "- Gate bypass: denied. Do NOT pass bypass/admin flags such as `--admin`, `--bypass`, or force-push to get around review, CI, or merge gates.",
    "If any task, stage, workflow, or prior instruction conflicts with this envelope, obey this envelope. When a denied action is required to finish, stop and report BLOCKED-needs-human instead of running the command.",
  ].join("\n");
}

export function withModePermissionEnvelope(input: {
  prompt: string;
  policy?: ModeScopedPermissionPolicy | null;
}): string {
  if (input.policy === undefined || input.policy === null) {
    return input.prompt;
  }

  const envelope = describeModePermissionEnvelope(input.policy);
  if (input.prompt.startsWith(envelope)) {
    return input.prompt;
  }

  return `${envelope}\n\n${input.prompt}`;
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

function containsGateBypass(command: string): boolean {
  return (
    (/\bgh\s+pr\s+merge\b/.test(command) &&
      /(?:^|\s)--(?:admin|bypass)\b/.test(command)) ||
    (/\bgit\s+push\b/.test(command) &&
      /(?:^|\s)--force(?:-with-lease)?\b/.test(command))
  );
}

function extractCommandText(value: unknown, depth = 0): string | null {
  if (depth > 3) {
    return null;
  }

  if (typeof value === "string") {
    return value;
  }

  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return null;
  }

  const record = value as Record<string, unknown>;
  for (const key of ["command", "cmd", "script"]) {
    const candidate = record[key];
    if (typeof candidate === "string") {
      return candidate;
    }
  }

  for (const key of [
    "tool_input",
    "toolInput",
    "input",
    "arguments",
    "args",
    "payload",
    "params",
  ]) {
    const nested = extractCommandText(record[key], depth + 1);
    if (nested !== null) {
      return nested;
    }
  }

  return null;
}
