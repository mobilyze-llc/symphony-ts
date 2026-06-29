import type { RateLimitWindowObservation } from "../codex/rate-limits.js";
import { observedWindowDeltaPercent } from "../codex/rate-limits.js";
import type {
  WorkflowHardStopsConfig,
  WorkflowHardStopsConfigOverride,
} from "../config/types.js";
import type { HumanBlockOperation, RightSizingMode } from "../domain/model.js";
import {
  type UsageTokens,
  evaluateBudget,
  loadPricingCatalog,
} from "./pricing.js";

export type HardStopOutcome =
  | "BLOCKED-needs-human"
  | "STALLED"
  | "PAUSED-budget";

export type HardStopTrigger =
  | "iteration_cap"
  | "no_progress"
  | "token_budget"
  | "dollar_budget"
  | "premium_spend_near_ceiling"
  | "rate_limit_budget"
  | "permission_denied"
  | "worker_reported_block";

export interface HardStopDecision {
  outcome: HardStopOutcome;
  trigger: HardStopTrigger;
  reason: string;
  turnCount: number;
  /** Raw cumulative unit tokens, cache reads at full weight (observability). */
  totalTokens: number;
  /** Cache-discounted tokens kept for observability and legacy estimates. */
  billableTokens?: number;
  /** Budget basis used by the current provider/model resolver. */
  budgetDenomination?: "weighted_tokens" | "usd" | "none";
  /** Weighted-token or USD total used for the budget decision. */
  budgetTotal?: number | null;
  /** Configured limit in the same denomination as `budgetTotal`. */
  budgetLimit?: number;
  /** Catalog billing mode for the active provider/model. */
  billingMode?: string | null;
  /** Resolver note when a configured budget is not enforceable. */
  budgetNote?: string;
  /** Parsed operation for worker-reported human blocks; avoids re-parsing prose. */
  humanBlockOperation?: HumanBlockOperation;
  /** Structured blocker summary reported by the worker at a human boundary. */
  humanBlockBlockers?: string | null;
  estimatedCostUsd: number;
}

export type ModePermissionAction =
  | "open_pull_request"
  | "open_ready_pull_request"
  | "mark_pull_request_ready"
  | "auto_merge"
  | "bypass_gates";

export type ClaudePermissionMode =
  | "default"
  | "acceptEdits"
  | "bypassPermissions";

export interface ModeScopedPermissionPolicy {
  mode: RightSizingMode;
  stageName: string | null;
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
  config: WorkflowHardStopsConfigOverride | null | undefined,
  fallback: WorkflowHardStopsConfig,
): WorkflowHardStopsConfig {
  return {
    maxIterations: config?.maxIterations ?? fallback.maxIterations,
    noProgressTurns: config?.noProgressTurns ?? fallback.noProgressTurns,
    maxTokensPerUnit: config?.maxTokensPerUnit ?? fallback.maxTokensPerUnit,
    maxDollarBudgetUsd:
      config?.maxDollarBudgetUsd ?? fallback.maxDollarBudgetUsd,
    premiumBudgetPauseRatio:
      config?.premiumBudgetPauseRatio ?? fallback.premiumBudgetPauseRatio,
    liveBudgetGraceRatio:
      config?.liveBudgetGraceRatio ?? fallback.liveBudgetGraceRatio,
    estimatedCostPer1kTokensUsd:
      config?.estimatedCostPer1kTokensUsd ??
      fallback.estimatedCostPer1kTokensUsd,
    cachedTokenCostRatio:
      config?.cachedTokenCostRatio ?? fallback.cachedTokenCostRatio,
    maxPrimaryWindowPctPerUnit:
      config?.maxPrimaryWindowPctPerUnit ?? fallback.maxPrimaryWindowPctPerUnit,
    maxSecondaryWindowPctPerUnit:
      config?.maxSecondaryWindowPctPerUnit ??
      fallback.maxSecondaryWindowPctPerUnit,
  };
}

export function createModeScopedPermissionPolicy(input: {
  mode: RightSizingMode;
  stageName?: string | null;
  configuredApprovalPolicy: unknown;
  configuredThreadSandbox: unknown;
  configuredTurnSandboxPolicy: unknown;
  maxBudgetUsd: number;
}): ModeScopedPermissionPolicy {
  const stageName = input.stageName ?? null;
  const canOpenPullRequest =
    stageName === "implement" &&
    (input.mode === "thin" || input.mode === "full");

  switch (input.mode) {
    case "prototype":
      return {
        mode: "prototype",
        stageName,
        approvalPolicy: "never",
        threadSandbox: "workspace-write",
        turnSandboxPolicy: {
          type: "workspace-write",
          networkAccess: false,
        },
        claudePermissionMode: "acceptEdits",
        canOpenPullRequest,
        canAutoMerge: false,
        canBypassGates: false,
        maxBudgetUsd: Math.min(input.maxBudgetUsd, 5),
      };

    case "thin":
      return {
        mode: "thin",
        stageName,
        approvalPolicy: input.configuredApprovalPolicy ?? "on-request",
        threadSandbox: input.configuredThreadSandbox ?? "workspace-write",
        turnSandboxPolicy: input.configuredTurnSandboxPolicy ?? {
          type: "workspace-write",
        },
        claudePermissionMode: "acceptEdits",
        canOpenPullRequest,
        canAutoMerge: false,
        canBypassGates: false,
        maxBudgetUsd: Math.min(input.maxBudgetUsd, 20),
      };

    case "full":
      return {
        mode: "full",
        stageName,
        approvalPolicy: input.configuredApprovalPolicy ?? "on-request",
        threadSandbox: input.configuredThreadSandbox ?? "workspace-write",
        turnSandboxPolicy: input.configuredTurnSandboxPolicy ?? {
          type: "workspace-write",
        },
        claudePermissionMode: "bypassPermissions",
        canOpenPullRequest,
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
      : input.action === "open_ready_pull_request" ||
          input.action === "mark_pull_request_ready"
        ? false
        : input.action === "auto_merge"
          ? input.policy.canAutoMerge
          : input.policy.canBypassGates;

  if (allowed) {
    return { allowed: true };
  }

  const reason =
    input.action === "open_pull_request"
      ? `${input.action} is not allowed in ${input.policy.mode} mode${formatStageDenialContext(input.policy.stageName)}.`
      : input.action === "open_ready_pull_request"
        ? "non-draft pull request creation is not allowed for pipeline-owned work. Re-run the PR creation command with `--draft` and keep the PR draft until review gates pass."
        : input.action === "mark_pull_request_ready"
          ? "marking a pipeline-owned pull request ready is not allowed until review gates pass. Keep the PR draft."
          : `${input.action} is not allowed in ${input.policy.mode} mode.`;

  return {
    allowed: false,
    hardStop: {
      outcome: "BLOCKED-needs-human",
      trigger: "permission_denied",
      reason,
      turnCount: 0,
      totalTokens: 0,
      estimatedCostUsd: 0,
    },
  };
}

function formatStageDenialContext(stageName: string | null): string {
  return stageName === null
    ? " without an active stage"
    : ` during the ${stageName} stage`;
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

  const tokens = normalized.split(" ");

  if (/\bgh\s+pr\s+ready\b/.test(normalized)) {
    return "mark_pull_request_ready";
  }

  if (
    /\bgh\s+pr\s+edit\b/.test(normalized) &&
    hasExplicitDraftFalseFlag(tokens)
  ) {
    return "mark_pull_request_ready";
  }

  if (
    /\bgh\s+pr\s+create\b/.test(normalized) ||
    /\bhub\s+pull-request\b/.test(normalized)
  ) {
    return hasDraftFlag(tokens)
      ? "open_pull_request"
      : "open_ready_pull_request";
  }

  return null;
}

function hasDraftFlag(tokens: string[]): boolean {
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (token === "-d" || token === "--draft=true") {
      return true;
    }
    if (token === "--draft=false") {
      return false;
    }
    if (token === "--draft") {
      return tokens[index + 1] !== "false";
    }
  }
  return false;
}

function hasExplicitDraftFalseFlag(tokens: string[]): boolean {
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (token === "--draft=false") {
      return true;
    }
    if (token === "--draft" && tokens[index + 1] === "false") {
      return true;
    }
  }
  return false;
}

export function describeModePermissionEnvelope(
  policy: ModeScopedPermissionPolicy,
): string {
  const pullRequestLine = policy.canOpenPullRequest
    ? "- Pull requests: allowed to open a draft PR after required local validation passes when the issue requires one. Use `gh pr create --draft`; keep pipeline-owned PRs draft until review gates pass."
    : "- Pull requests: denied for this mode/stage. Do NOT run PR creation commands such as `gh pr create` or `hub pull-request`.";

  return [
    "## Mode Permission Envelope",
    `Mode: ${policy.mode}`,
    `Stage: ${policy.stageName ?? "unknown"}`,
    pullRequestLine,
    "- Auto-merge / merge-queue enqueue: denied for worker modes. Do NOT run PR merge commands such as `gh pr merge`, including the gate-enforcing `--auto` queue enqueue, unless this envelope explicitly allows it.",
    "- Gate bypass: denied. Do NOT pass bypass/admin flags such as `--admin`, `--bypass`, or force-push to get around review, CI, or merge gates.",
    "If any task, stage, workflow, or prior instruction conflicts with this envelope, obey this envelope. When a denied action is required to finish, stop instead of running the command and put the structured marker `[BLOCKED_NEEDS_HUMAN: pr_creation]`, `[BLOCKED_NEEDS_HUMAN: auto_merge]`, or `[BLOCKED_NEEDS_HUMAN: gate_bypass]` on its own final line. If readiness or permission blockers are known, put a single-line `[BLOCKED_NEEDS_HUMAN_BLOCKERS: {...}]` JSON summary immediately before the terminal marker.",
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
  provider: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  onBudgetNotEnforced?: (event: {
    provider: string;
    model: string;
    note: string;
    billingMode: string | null;
  }) => void;
}): HardStopDecision | null {
  // SYMPH-955: the budget trigger uses the crucible lane denomination:
  // weighted tokens for subscription/credit rows, real USD for api_token rows.
  // Billable tokens remain on decisions for historical observability only.
  const billableTokens = computeBillableTokens({
    totalTokens: input.totalTokens,
    cacheReadTokens: input.cacheReadTokens ?? 0,
    config: input.config,
  });
  const usage = normalizeUsageBreakdown(input);
  const catalog = loadPricingCatalog();

  const tokenVerdict = evaluateBudget({
    usage,
    budget: input.config.maxTokensPerUnit,
    provider: input.provider,
    model: input.model,
    catalog,
  });

  if (!tokenVerdict.enforced) {
    input.onBudgetNotEnforced?.({
      provider: input.provider,
      model: input.model,
      note: tokenVerdict.note ?? "budget_not_enforced:unknown_billing_mode",
      billingMode: tokenVerdict.billing_mode,
    });
    return null;
  }

  if (tokenVerdict.denomination === "weighted_tokens") {
    if (tokenVerdict.exceeded) {
      const total = tokenVerdict.total ?? 0;
      return {
        outcome: "PAUSED-budget",
        trigger: "token_budget",
        reason: `Weighted token budget exceeded: ${formatMeasure(total)} weighted_tokens > ${input.config.maxTokensPerUnit} for ${input.provider}/${input.model} (${tokenVerdict.billing_mode}; raw ${input.totalTokens}, legacy billable tokens for observability ${billableTokens}).`,
        turnCount: input.turnCount,
        totalTokens: input.totalTokens,
        billableTokens,
        budgetDenomination: "weighted_tokens",
        budgetTotal: total,
        budgetLimit: tokenVerdict.budget,
        billingMode: tokenVerdict.billing_mode,
        estimatedCostUsd: costFromWeightedTokens(total, input.config),
      };
    }

    return null;
  }

  if (tokenVerdict.denomination === "usd") {
    const dollarVerdict = evaluateBudget({
      usage,
      budget: input.config.maxDollarBudgetUsd,
      provider: input.provider,
      model: input.model,
      catalog,
    });
    if (dollarVerdict.enforced && dollarVerdict.exceeded) {
      const usd = dollarVerdict.total ?? 0;
      return {
        outcome: "PAUSED-budget",
        trigger: "dollar_budget",
        reason: `Dollar budget exceeded: ${formatCost(usd)} > ${formatCost(input.config.maxDollarBudgetUsd)} for ${input.provider}/${input.model} (${dollarVerdict.billing_mode}; raw ${input.totalTokens}, legacy billable tokens for observability ${billableTokens}).`,
        turnCount: input.turnCount,
        totalTokens: input.totalTokens,
        billableTokens,
        budgetDenomination: "usd",
        budgetTotal: usd,
        budgetLimit: dollarVerdict.budget,
        billingMode: dollarVerdict.billing_mode,
        estimatedCostUsd: usd,
      };
    }

    const premiumBudget =
      input.config.maxDollarBudgetUsd * input.config.premiumBudgetPauseRatio;
    const premiumVerdict = evaluateBudget({
      usage,
      budget: premiumBudget,
      provider: input.provider,
      model: input.model,
      catalog,
    });
    if (premiumVerdict.enforced && premiumVerdict.exceeded) {
      const usd = premiumVerdict.total ?? 0;
      return {
        outcome: "PAUSED-budget",
        trigger: "premium_spend_near_ceiling",
        reason: `Premium spend is near ceiling: ${formatCost(usd)} > ${formatCost(premiumBudget)} for ${input.provider}/${input.model} (${premiumVerdict.billing_mode}; ceiling ${formatCost(input.config.maxDollarBudgetUsd)}).`,
        turnCount: input.turnCount,
        totalTokens: input.totalTokens,
        billableTokens,
        budgetDenomination: "usd",
        budgetTotal: usd,
        budgetLimit: premiumVerdict.budget,
        billingMode: premiumVerdict.billing_mode,
        estimatedCostUsd: usd,
      };
    }

    return null;
  }

  return null;
}

export interface RateLimitUsageObservations {
  primary: RateLimitWindowObservation | null;
  secondary: RateLimitWindowObservation | null;
}

function normalizeUsageBreakdown(input: {
  totalTokens: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
}): UsageTokens {
  const totalTokens = nonNegativeNumber(input.totalTokens) ?? 0;
  const inputTokens = nonNegativeNumber(input.inputTokens) ?? 0;
  const outputTokens = nonNegativeNumber(input.outputTokens) ?? 0;
  const cacheReadTokens = clampTokenCount(input.cacheReadTokens, totalTokens);
  const cacheWriteTokens = clampTokenCount(input.cacheWriteTokens, totalTokens);
  const knownTokens =
    inputTokens + outputTokens + cacheReadTokens + cacheWriteTokens;
  const unclassifiedTokens = Math.max(totalTokens - knownTokens, 0);

  return {
    input_tokens: inputTokens,
    // Missing split telemetry fails closed by treating any raw-token remainder
    // as output, the most expensive weighted component.
    output_tokens: outputTokens + unclassifiedTokens,
    cache_read_tokens: cacheReadTokens,
    cache_write_tokens: cacheWriteTokens,
  };
}

function nonNegativeNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? value
    : null;
}

function clampTokenCount(value: unknown, totalTokens: number): number {
  const count = nonNegativeNumber(value) ?? 0;
  return Math.min(count, totalTokens);
}

/**
 * Pause when a single unit of work consumed more than its configured share
 * of a Codex subscription window (SYMPH-333). The snapshot is account-level,
 * so under concurrent workers the per-unit delta over-attributes shared burn;
 * the budget is therefore a protective ceiling, not an exact meter.
 */
export function evaluateRateLimitBudgetHardStop(input: {
  config: WorkflowHardStopsConfig;
  turnCount: number;
  totalTokens: number;
  cacheReadTokens?: number;
  rateLimitUsage: RateLimitUsageObservations;
}): HardStopDecision | null {
  const windows: Array<{
    label: "primary" | "secondary";
    budgetPct: number | null;
    observation: RateLimitWindowObservation | null;
  }> = [
    {
      label: "primary",
      budgetPct: input.config.maxPrimaryWindowPctPerUnit,
      observation: input.rateLimitUsage.primary,
    },
    {
      label: "secondary",
      budgetPct: input.config.maxSecondaryWindowPctPerUnit,
      observation: input.rateLimitUsage.secondary,
    },
  ];

  for (const window of windows) {
    if (window.budgetPct === null || window.observation === null) {
      continue;
    }

    const deltaPct = observedWindowDeltaPercent(window.observation);
    if (deltaPct < window.budgetPct) {
      continue;
    }

    return {
      outcome: "PAUSED-budget",
      trigger: "rate_limit_budget",
      reason: `Rate-limit budget exceeded: ${window.label} window burned ${formatPct(deltaPct)} of the configured ${formatPct(window.budgetPct)} per-unit share (window ${formatPct(window.observation.startPercent)} -> ${formatPct(window.observation.latestPercent)} used).`,
      turnCount: input.turnCount,
      totalTokens: input.totalTokens,
      estimatedCostUsd: estimateCostUsd({
        totalTokens: input.totalTokens,
        cacheReadTokens: input.cacheReadTokens ?? 0,
        config: input.config,
      }),
    };
  }

  return null;
}

export function evaluateIterationHardStop(input: {
  config: WorkflowHardStopsConfig;
  turnCount: number;
  totalTokens: number;
  cacheReadTokens?: number;
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
      cacheReadTokens: input.cacheReadTokens ?? 0,
      config: input.config,
    }),
  };
}

export function evaluateNoProgressHardStop(input: {
  config: WorkflowHardStopsConfig;
  repeatedNoProgressTurns: number;
  turnCount: number;
  totalTokens: number;
  cacheReadTokens?: number;
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
      cacheReadTokens: input.cacheReadTokens ?? 0,
      config: input.config,
    }),
  };
}

// Cached input tokens are re-reads of an unchanged prefix and are billed
// at a fraction of the full rate; charging them at full weight overstated
// spend by the cached share (~70% on observed worker turns, SYMPH-319).
// Shared by legacy dollar estimates and observability (SYMPH-351). The budget
// trigger now uses the provider/model catalog basis in evaluateBudgetHardStop.
export function computeBillableTokens(input: {
  totalTokens: number;
  cacheReadTokens: number;
  config: Pick<WorkflowHardStopsConfig, "cachedTokenCostRatio">;
}): number {
  const cacheReadTokens = Math.min(
    Math.max(input.cacheReadTokens, 0),
    input.totalTokens,
  );
  // A malformed ratio must fail closed (no discount), never disable the
  // budget checks via NaN comparisons.
  const configuredRatio = input.config.cachedTokenCostRatio;
  const cachedTokenCostRatio = Number.isFinite(configuredRatio)
    ? Math.min(Math.max(configuredRatio, 0), 1)
    : 1;
  // Math.round makes the >= cap comparison fire up to half a token early
  // at fractional boundaries — negligible against real ceilings (>=10K)
  // and preferable to surfacing fractional token counts to operators.
  return Math.round(
    input.totalTokens - cacheReadTokens * (1 - cachedTokenCostRatio),
  );
}

function costFromBillableTokens(
  billableTokens: number,
  config: Pick<WorkflowHardStopsConfig, "estimatedCostPer1kTokensUsd">,
): number {
  return (billableTokens / 1000) * config.estimatedCostPer1kTokensUsd;
}

function costFromWeightedTokens(
  weightedTokens: number,
  config: Pick<WorkflowHardStopsConfig, "estimatedCostPer1kTokensUsd">,
): number {
  return (weightedTokens / 1000) * config.estimatedCostPer1kTokensUsd;
}

export function estimateCostUsd(input: {
  totalTokens: number;
  cacheReadTokens: number;
  config: Pick<
    WorkflowHardStopsConfig,
    "estimatedCostPer1kTokensUsd" | "cachedTokenCostRatio"
  >;
}): number {
  return costFromBillableTokens(computeBillableTokens(input), input.config);
}

function formatCost(cost: number): string {
  return `$${cost.toFixed(2)}`;
}

function formatMeasure(value: number): string {
  return Number.isInteger(value) ? String(value) : value.toFixed(2);
}

function formatPct(value: number): string {
  return `${value.toFixed(1)}%`;
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
