import { tmpdir } from "node:os";
import { join } from "node:path";

export const DEFAULT_LINEAR_ENDPOINT = "https://api.linear.app/graphql";
export const DEFAULT_TRACKER_KIND = "linear";
export const DEFAULT_ACTIVE_STATES = [
  "Todo",
  "In Progress",
  "In Review",
  "Resume",
] as const;
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
export const DEFAULT_HARD_STOP_MAX_TOKENS_PER_UNIT = 1_000_000;
export const DEFAULT_HARD_STOP_MAX_DOLLAR_BUDGET_USD = 50;
export const DEFAULT_HARD_STOP_PREMIUM_BUDGET_PAUSE_RATIO = 0.8;
export const DEFAULT_HARD_STOP_ESTIMATED_COST_PER_1K_TOKENS_USD = 0.05;
// Cached input tokens are billed at a fraction of the full input rate
// (OpenAI prompt caching discounts repeated prefixes ~90%).
export const DEFAULT_HARD_STOP_CACHED_TOKEN_COST_RATIO = 0.1;
// Rate-limit window budgets are opt-in: null keeps behavior unchanged until
// a WORKFLOW configures them (SYMPH-333).
export const DEFAULT_HARD_STOP_MAX_PRIMARY_WINDOW_PCT_PER_UNIT: number | null =
  null;
export const DEFAULT_HARD_STOP_MAX_SECONDARY_WINDOW_PCT_PER_UNIT:
  | number
  | null = null;
export const DEFAULT_RATE_LIMIT_MIN_PRIMARY_HEADROOM_PCT: number | null = null;
export const DEFAULT_RATE_LIMIT_MIN_SECONDARY_HEADROOM_PCT: number | null =
  null;
// Budget-escalation ladder is opt-in (SYMPH-337): null max_steps keeps every
// budget pause operator-gated as before.
export const DEFAULT_BUDGET_ESCALATION_MAX_STEPS: number | null = null;
export const DEFAULT_BUDGET_ESCALATION_MULTIPLIER = 2;
// Pause triage (SYMPH-337 slice 2) is off until a WORKFLOW provides the
// local endpoint; verdict-authorized continuations are bounded per issue.
export const DEFAULT_PAUSE_TRIAGE_MAX_RESUMES = 2;

export const DEFAULT_RUNNER_KIND = "codex";
export const DEFAULT_CONTINUOUS_FEEDBACK_ENABLED = true;
export const DEFAULT_CONTINUOUS_FEEDBACK_EVENTS = ["checkpoint"] as const;
export const DEFAULT_CONTINUOUS_FEEDBACK_RUNNER = "pi";
export const DEFAULT_CONTINUOUS_FEEDBACK_MODEL = "local-flash";
export const DEFAULT_CONTINUOUS_FEEDBACK_ROLE = "continuous-feedback";
export const DEFAULT_CONTINUOUS_FEEDBACK_BOUNCE_ON_FINDING = true;

export const DEFAULT_CODEX_COMMAND = "codex app-server";
export const DEFAULT_CODEX_EPHEMERAL_HOME = false;
export const DEFAULT_CODEX_DISABLE_SKILLS = false;
export const DEFAULT_TURN_TIMEOUT_MS = 3_600_000;
export const DEFAULT_READ_TIMEOUT_MS = 5_000;
export const DEFAULT_STALL_TIMEOUT_MS = 300_000;
// SYMPH-412: rotate to a fresh Codex session once cumulative session input
// tokens cross this threshold. Observed mid-turn closures clustered at
// 0.9M-2.5M cumulative input tokens; 1.5M keeps headroom while bounding
// accumulated thread context. 0 disables proactive rotation.
export const DEFAULT_CODEX_SESSION_ROTATION_INPUT_TOKENS = 1_500_000;
export const DEFAULT_OBSERVABILITY_ENABLED = true;
export const DEFAULT_OBSERVABILITY_REFRESH_MS = 1_000;
export const DEFAULT_OBSERVABILITY_RENDER_INTERVAL_MS = 16;

export const DEFAULT_LINEAR_PAGE_SIZE = 50;
export const DEFAULT_LINEAR_NETWORK_TIMEOUT_MS = 30_000;

export const WORKFLOW_FILENAME = "WORKFLOW.md";

// Watchdog L1c defaults (SYMPH-398)
export const DEFAULT_WATCHDOG_SYSTEMIC_THRESHOLD = 2;
export const DEFAULT_WATCHDOG_CIRCUIT_BREAKER = true;
export const DEFAULT_WATCHDOG_MAX_FILINGS_PER_HOUR = 3;

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
    cachedTokenCostRatio: DEFAULT_HARD_STOP_CACHED_TOKEN_COST_RATIO,
    maxPrimaryWindowPctPerUnit:
      DEFAULT_HARD_STOP_MAX_PRIMARY_WINDOW_PCT_PER_UNIT,
    maxSecondaryWindowPctPerUnit:
      DEFAULT_HARD_STOP_MAX_SECONDARY_WINDOW_PCT_PER_UNIT,
  },
  rateLimitAdmission: {
    minPrimaryHeadroomPct: DEFAULT_RATE_LIMIT_MIN_PRIMARY_HEADROOM_PCT,
    minSecondaryHeadroomPct: DEFAULT_RATE_LIMIT_MIN_SECONDARY_HEADROOM_PCT,
  },
  budgetEscalation: {
    maxSteps: DEFAULT_BUDGET_ESCALATION_MAX_STEPS,
    multiplier: DEFAULT_BUDGET_ESCALATION_MULTIPLIER,
  },
  pauseTriage: {
    maxResumes: DEFAULT_PAUSE_TRIAGE_MAX_RESUMES,
  },
  acGate: {
    enabled: false,
  },
  specFidelity: {
    enabled: false,
  },
  admissionCard: {
    enabled: false,
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
    ephemeralHome: DEFAULT_CODEX_EPHEMERAL_HOME,
    disableSkills: DEFAULT_CODEX_DISABLE_SKILLS,
    turnTimeoutMs: DEFAULT_TURN_TIMEOUT_MS,
    readTimeoutMs: DEFAULT_READ_TIMEOUT_MS,
    stallTimeoutMs: DEFAULT_STALL_TIMEOUT_MS,
    sessionRotationInputTokens: DEFAULT_CODEX_SESSION_ROTATION_INPUT_TOKENS,
  },
  observability: {
    dashboardEnabled: DEFAULT_OBSERVABILITY_ENABLED,
    refreshMs: DEFAULT_OBSERVABILITY_REFRESH_MS,
    renderIntervalMs: DEFAULT_OBSERVABILITY_RENDER_INTERVAL_MS,
  },
} as const);
