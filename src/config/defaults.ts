import { tmpdir } from "node:os";
import { join } from "node:path";

export const DEFAULT_LINEAR_ENDPOINT = "https://api.linear.app/graphql";
export const DEFAULT_TRACKER_KIND = "linear";
export const DEFAULT_ACTIVE_STATES = ["Todo", "In Progress"] as const;
export const DEFAULT_TERMINAL_STATES = [
  "Closed",
  "Cancelled",
  "Canceled",
  "Duplicate",
  "Done",
] as const;

export const DEFAULT_POLL_INTERVAL_MS = 30_000;
export const DEFAULT_WORKSPACE_ROOT = join(tmpdir(), "symphony_workspaces");
export const DEFAULT_HOOK_TIMEOUT_MS = 60_000;

export const DEFAULT_MAX_CONCURRENT_AGENTS = 10;
export const DEFAULT_MAX_TURNS = 20;
export const DEFAULT_MAX_RETRY_BACKOFF_MS = 300_000;
export const DEFAULT_MAX_RETRY_ATTEMPTS = 5;
export const DEFAULT_MAX_CONCURRENT_AGENTS_BY_STATE = Object.freeze(
  {},
) as Readonly<Record<string, number>>;
export const DEFAULT_HARD_STOP_MAX_ITERATIONS = DEFAULT_MAX_TURNS;
export const DEFAULT_HARD_STOP_NO_PROGRESS_TURNS = 3;
export const DEFAULT_HARD_STOP_MAX_TOKENS_PER_UNIT = 200_000;
export const DEFAULT_HARD_STOP_MAX_DOLLAR_BUDGET_USD = 50;
export const DEFAULT_HARD_STOP_PREMIUM_BUDGET_PAUSE_RATIO = 0.8;
export const DEFAULT_HARD_STOP_ESTIMATED_COST_PER_1K_TOKENS_USD = 0.05;

export const DEFAULT_RUNNER_KIND = "codex";
export const DEFAULT_CONTINUOUS_FEEDBACK_ENABLED = true;
export const DEFAULT_CONTINUOUS_FEEDBACK_EVENTS = ["checkpoint"] as const;
export const DEFAULT_CONTINUOUS_FEEDBACK_RUNNER = "pi";
export const DEFAULT_CONTINUOUS_FEEDBACK_MODEL = "local-flash";
export const DEFAULT_CONTINUOUS_FEEDBACK_ROLE = "continuous-feedback";
export const DEFAULT_CONTINUOUS_FEEDBACK_BOUNCE_ON_FINDING = true;

export const DEFAULT_CODEX_COMMAND = "codex app-server";
export const DEFAULT_TURN_TIMEOUT_MS = 3_600_000;
export const DEFAULT_READ_TIMEOUT_MS = 5_000;
export const DEFAULT_STALL_TIMEOUT_MS = 300_000;
export const DEFAULT_OBSERVABILITY_ENABLED = true;
export const DEFAULT_OBSERVABILITY_REFRESH_MS = 1_000;
export const DEFAULT_OBSERVABILITY_RENDER_INTERVAL_MS = 16;

export const DEFAULT_LINEAR_PAGE_SIZE = 50;
export const DEFAULT_LINEAR_NETWORK_TIMEOUT_MS = 30_000;

export const WORKFLOW_FILENAME = "WORKFLOW.md";

export const SPEC_DEFAULTS = Object.freeze({
  tracker: {
    kind: DEFAULT_TRACKER_KIND,
    endpoint: DEFAULT_LINEAR_ENDPOINT,
    activeStates: DEFAULT_ACTIVE_STATES,
    terminalStates: DEFAULT_TERMINAL_STATES,
    pageSize: DEFAULT_LINEAR_PAGE_SIZE,
    networkTimeoutMs: DEFAULT_LINEAR_NETWORK_TIMEOUT_MS,
  },
  polling: {
    intervalMs: DEFAULT_POLL_INTERVAL_MS,
  },
  workspace: {
    root: DEFAULT_WORKSPACE_ROOT,
  },
  hooks: {
    timeoutMs: DEFAULT_HOOK_TIMEOUT_MS,
  },
  agent: {
    maxConcurrentAgents: DEFAULT_MAX_CONCURRENT_AGENTS,
    maxTurns: DEFAULT_MAX_TURNS,
    maxRetryBackoffMs: DEFAULT_MAX_RETRY_BACKOFF_MS,
    maxRetryAttempts: DEFAULT_MAX_RETRY_ATTEMPTS,
    maxConcurrentAgentsByState: DEFAULT_MAX_CONCURRENT_AGENTS_BY_STATE,
  },
  hardStops: {
    maxIterations: DEFAULT_HARD_STOP_MAX_ITERATIONS,
    noProgressTurns: DEFAULT_HARD_STOP_NO_PROGRESS_TURNS,
    maxTokensPerUnit: DEFAULT_HARD_STOP_MAX_TOKENS_PER_UNIT,
    maxDollarBudgetUsd: DEFAULT_HARD_STOP_MAX_DOLLAR_BUDGET_USD,
    premiumBudgetPauseRatio: DEFAULT_HARD_STOP_PREMIUM_BUDGET_PAUSE_RATIO,
    estimatedCostPer1kTokensUsd:
      DEFAULT_HARD_STOP_ESTIMATED_COST_PER_1K_TOKENS_USD,
  },
  runner: {
    kind: DEFAULT_RUNNER_KIND,
  },
  continuousFeedback: {
    enabled: DEFAULT_CONTINUOUS_FEEDBACK_ENABLED,
    events: DEFAULT_CONTINUOUS_FEEDBACK_EVENTS,
    runner: DEFAULT_CONTINUOUS_FEEDBACK_RUNNER,
    model: DEFAULT_CONTINUOUS_FEEDBACK_MODEL,
    role: DEFAULT_CONTINUOUS_FEEDBACK_ROLE,
    bounceOnFinding: DEFAULT_CONTINUOUS_FEEDBACK_BOUNCE_ON_FINDING,
  },
  codex: {
    command: DEFAULT_CODEX_COMMAND,
    turnTimeoutMs: DEFAULT_TURN_TIMEOUT_MS,
    readTimeoutMs: DEFAULT_READ_TIMEOUT_MS,
    stallTimeoutMs: DEFAULT_STALL_TIMEOUT_MS,
  },
  observability: {
    dashboardEnabled: DEFAULT_OBSERVABILITY_ENABLED,
    refreshMs: DEFAULT_OBSERVABILITY_REFRESH_MS,
    renderIntervalMs: DEFAULT_OBSERVABILITY_RENDER_INTERVAL_MS,
  },
} as const);
