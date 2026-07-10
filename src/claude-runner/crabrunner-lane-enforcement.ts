import {
  DEFAULT_HARD_STOP_CACHED_TOKEN_COST_RATIO,
  DEFAULT_HARD_STOP_ESTIMATED_COST_PER_1K_TOKENS_USD,
  DEFAULT_HARD_STOP_LIVE_BUDGET_GRACE_RATIO,
  DEFAULT_HARD_STOP_MAX_DOLLAR_BUDGET_USD,
  DEFAULT_HARD_STOP_MAX_ITERATIONS,
  DEFAULT_HARD_STOP_MAX_TOKENS_PER_UNIT,
  DEFAULT_HARD_STOP_NO_PROGRESS_TURNS,
  DEFAULT_STALL_TIMEOUT_MS,
} from "../config/defaults.js";
import {
  type CrabrunnerJobSpec,
  validateCrabrunnerLaneEnforcementContract,
} from "../stage-execution/crabrunner-backend.js";

const HEARTBEAT_INTERVAL_MS = 30_000;
const PROGRESS_INTERVAL_MS = 30_000;
const USAGE_INTERVAL_MS = 30_000;
const KILL_GRACE_MS = 5_000;

export function buildClaudeCrabrunnerLaneEnforcement(
  timeoutSeconds: number,
): CrabrunnerJobSpec["enforcement"] {
  return {
    required: true,
    budget: {
      maxTokens: DEFAULT_HARD_STOP_MAX_TOKENS_PER_UNIT,
      maxUsd: DEFAULT_HARD_STOP_MAX_DOLLAR_BUDGET_USD,
      estimatedCostPer1kTokensUsd:
        DEFAULT_HARD_STOP_ESTIMATED_COST_PER_1K_TOKENS_USD,
      cachedTokenCostRatio: DEFAULT_HARD_STOP_CACHED_TOKEN_COST_RATIO,
      liveBudgetGraceRatio: DEFAULT_HARD_STOP_LIVE_BUDGET_GRACE_RATIO,
    },
    timing: {
      timeoutMs: timeoutSeconds * 1_000,
      stallTimeoutMs: DEFAULT_STALL_TIMEOUT_MS,
      noProgressTurns: DEFAULT_HARD_STOP_NO_PROGRESS_TURNS,
      maxIterations: DEFAULT_HARD_STOP_MAX_ITERATIONS,
    },
    telemetry: {
      heartbeatIntervalMs: HEARTBEAT_INTERVAL_MS,
      progressIntervalMs: PROGRESS_INTERVAL_MS,
      usageIntervalMs: USAGE_INTERVAL_MS,
    },
    cancellation: {
      jobIdRequired: true,
      cooperativeAbort: true,
      processGroupKill: true,
      killGraceMs: KILL_GRACE_MS,
    },
  };
}

export function assertClaudeCrabrunnerLaneEnforcement(
  spec: CrabrunnerJobSpec,
): void {
  const failure = validateCrabrunnerLaneEnforcementContract(spec);
  if (failure !== null) {
    throw new Error(
      failure.message ?? "invalid crabrunner enforcement contract",
    );
  }
}
