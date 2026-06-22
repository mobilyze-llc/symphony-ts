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
export const DEFAULT_HARD_STOP_LIVE_BUDGET_GRACE_RATIO = 0.1;
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
export const DEFAULT_RATE_LIMIT_DEFER_UNTIL_RESET = false;
export const DEFAULT_RATE_LIMIT_EXPECTED_UNIT_BURN_PCT: number | null = null;
export const DEFAULT_RATE_LIMIT_DEFER_JITTER_MS = 0;
// SYMPH-778: a persisted rate-limit snapshot older than this (ms) can no longer
// close dispatch by itself when no worker is running to refresh telemetry.
// Defaults to 6h — longer than a primary window and any restart gap, so normal
// restart-bridging (SYMPH-336) is unaffected; only a multi-hour idle/deadlock
// trips the fail-open bypass. null disables the staleness bypass.
export const DEFAULT_RATE_LIMIT_SNAPSHOT_MAX_AGE_MS: number | null = 21_600_000;
// Budget-escalation ladder is opt-in (SYMPH-337): null max_steps keeps every
// budget pause operator-gated as before.
export const DEFAULT_BUDGET_ESCALATION_MAX_STEPS: number | null = null;
export const DEFAULT_BUDGET_ESCALATION_MULTIPLIER = 2;
// Pause triage (SYMPH-337 slice 2) is off until a WORKFLOW provides the
// local endpoint; verdict-authorized continuations are bounded per issue.
export const DEFAULT_PAUSE_TRIAGE_MAX_RESUMES = 2;
export const DEFAULT_RISK_PREDICATE_REASONING_EFFORT = null;

export const DEFAULT_RUNNER_KIND = "codex";
export const DEFAULT_CONTINUOUS_FEEDBACK_ENABLED = true;
export const DEFAULT_CONTINUOUS_FEEDBACK_EVENTS = ["checkpoint"] as const;
export const DEFAULT_CONTINUOUS_FEEDBACK_RUNNER = "pi";
export const DEFAULT_CONTINUOUS_FEEDBACK_MODEL =
  "ds4-studio2/deepseek-v4-flash";
export const DEFAULT_CONTINUOUS_FEEDBACK_ROLE = "continuous-feedback";
export const DEFAULT_CONTINUOUS_FEEDBACK_BOUNCE_ON_FINDING = true;
// Warn-not-block by default (SYMPH-761): an unavailable continuous-feedback
// model is surfaced at startup but does not refuse launch; operators opt into
// fail-closed via continuous_feedback.preflight_fail_closed.
export const DEFAULT_CONTINUOUS_FEEDBACK_PREFLIGHT_FAIL_CLOSED = false;

export const DEFAULT_CODEX_COMMAND = "codex app-server";
export const DEFAULT_CODEX_EPHEMERAL_HOME = false;
export const DEFAULT_CODEX_DISABLE_SKILLS = false;
export const DEFAULT_CODEX_TOOL_OUTPUT_TOKEN_LIMIT = 2_500;
export const DEFAULT_CODEX_MODEL_AUTO_COMPACT_TOKEN_LIMIT = 40_000;
export const DEFAULT_CODEX_MAX_HEALTHY_COMPACTIONS_PER_STAGE = 3;
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

// Verdict-event defaults (SYMPH-405)
export const DEFAULT_VERDICTS_PAGE_AFTER_TICKS = 10;

// Queue Triage v2 Manager spine (SYMPH-784). Default-DISABLED; shadow-on so the
// first enablement computes/logs plans without changing dispatch.
export const DEFAULT_QUEUE_TRIAGE_ENABLED = false;
export const DEFAULT_QUEUE_TRIAGE_SHADOW_MODE = true;
export const DEFAULT_QUEUE_TRIAGE_PLANNER_MODEL = "opus";
export const DEFAULT_QUEUE_TRIAGE_HEARTBEAT_MS = 900_000; // 15 minutes
// Posture-B: auto-dispatch only the plan's head batch unattended by default;
// hold the rest for operator approval (SYMPH-789).
export const DEFAULT_QUEUE_TRIAGE_AUTO_RELEASE_FRONTIER = 1;
// Control doc surface (SYMPH-790/791): off until an operator sets a team id.
export const DEFAULT_QUEUE_TRIAGE_CONTROL_DOC_ENABLED = false;
// Admission guardrail (SYMPH-794): off by default so a bare `project` field keeps
// admitting until an operator opts into explicit-signal-only dispatch.
export const DEFAULT_QUEUE_TRIAGE_ADMISSION_GUARDRAIL_ENABLED = false;

// Curated-comment enrichment (SYMPH-874 Tier 3 / SYMPH-896): off by default —
// it is the only enrichment that costs an N+1 comment fetch over the backlog, so
// an operator opts in once the report-only cost measurement is trusted. The size
// bounds below are safety rails (the AC requires size caps), tuned from the
// measurement rather than guessed.
export const DEFAULT_QUEUE_TRIAGE_COMMENT_ENRICHMENT_ENABLED = false;
export const DEFAULT_QUEUE_TRIAGE_COMMENT_ENRICHMENT_MAX_CANDIDATES = 25;
export const DEFAULT_QUEUE_TRIAGE_COMMENT_ENRICHMENT_MAX_COMMENT_PAGES = 3;
export const DEFAULT_QUEUE_TRIAGE_COMMENT_ENRICHMENT_MAX_COMMENTS = 6;
export const DEFAULT_QUEUE_TRIAGE_COMMENT_ENRICHMENT_MAX_COMMENT_CHARS = 400;
export const DEFAULT_QUEUE_TRIAGE_COMMENT_ENRICHMENT_MAX_TOTAL_CHARS = 1200;

// Watchdog L2 stuck-ticket triage defaults (SYMPH-399). Disabled until the
// operator opts a product in (calibration gate).
export const DEFAULT_STUCK_TRIAGE_ENABLED = false;
export const DEFAULT_STUCK_TRIAGE_TIMEOUT_MS = 600_000;

// Managed code-grounding defaults (SYMPH-596). Default-disabled until a
// product opts in, with checkouts kept under the configured workspace root.
export const DEFAULT_CODE_GROUNDING_ENABLED = false;
// Fragment resolved against workspace.root; keep the literal stable across OSes.
export const DEFAULT_CODE_GROUNDING_BASE_DIR = ".symphony/code-grounding";
export const DEFAULT_CODE_GROUNDING_TTL_MS = 86_400_000;
export const DEFAULT_CODE_GROUNDING_MAX_CHECKOUTS_PER_REPO = 5;
export const DEFAULT_CODE_GROUNDING_MATERIALIZATION_TIMEOUT_MS = 600_000;

// Merge actuator defaults (SYMPH-735). Default-disabled: the live merge-stage
// dispatch barrier keeps parking candidates (merge_actuator_unwired) until a
// product opts in. The remaining values bound the merge-queue wait and the
// bounded recovery ceilings (SYMPH-746/748).
export const DEFAULT_MERGE_ACTUATOR_ENABLED = false;
// Actuator auto-merge permission (SYMPH-754). Distinct from `enabled`: `enabled`
// lets the actuator run/observe; this permission lets it ENQUEUE (auto-merge).
// Default-CLOSED so enabling the actuator for a new product cannot silently
// start auto-merging without an explicit per-workflow grant — a denied
// permission parks the candidate with `auto_merge_permission_denied` instead of
// enqueuing. Granted only where the WORKFLOW frontmatter sets it.
export const DEFAULT_MERGE_ACTUATOR_AUTO_MERGE = false;
export const DEFAULT_MERGE_ACTUATOR_MAX_WAIT_MS = 3_600_000;
export const DEFAULT_MERGE_ACTUATOR_MAX_LIVE_STATE_FAILURES = 5;
export const DEFAULT_MERGE_ACTUATOR_MAX_SIDE_EFFECT_FAILURES = 3;
export const DEFAULT_MERGE_ACTUATOR_MAX_DRAFT_WAIT_OBSERVATIONS = 20;
// Bounded pre-enqueue waits (SYMPH-752/755). With the SYMPH-753 backoff capped
// at 5m, 30 pending-checks waits bound a fresh PR's in-flight-CI window to a few
// hours before parking; 20 UNKNOWN-mergeability waits cover GitHub's async
// mergeability computation, which normally resolves within seconds.
export const DEFAULT_MERGE_ACTUATOR_MAX_PENDING_CHECKS_WAIT_OBSERVATIONS = 30;
export const DEFAULT_MERGE_ACTUATOR_MAX_UNKNOWN_MERGEABILITY_WAIT_OBSERVATIONS = 20;

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
    liveBudgetGraceRatio: DEFAULT_HARD_STOP_LIVE_BUDGET_GRACE_RATIO,
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
  mergeActuator: {
    enabled: DEFAULT_MERGE_ACTUATOR_ENABLED,
    autoMerge: DEFAULT_MERGE_ACTUATOR_AUTO_MERGE,
    maxWaitMs: DEFAULT_MERGE_ACTUATOR_MAX_WAIT_MS,
    maxLiveStateFailures: DEFAULT_MERGE_ACTUATOR_MAX_LIVE_STATE_FAILURES,
    maxSideEffectFailures: DEFAULT_MERGE_ACTUATOR_MAX_SIDE_EFFECT_FAILURES,
    maxDraftWaitObservations:
      DEFAULT_MERGE_ACTUATOR_MAX_DRAFT_WAIT_OBSERVATIONS,
    maxPendingChecksWaitObservations:
      DEFAULT_MERGE_ACTUATOR_MAX_PENDING_CHECKS_WAIT_OBSERVATIONS,
    maxUnknownMergeabilityWaitObservations:
      DEFAULT_MERGE_ACTUATOR_MAX_UNKNOWN_MERGEABILITY_WAIT_OBSERVATIONS,
  },
  specFidelity: {
    enabled: false,
  },
  reviewExecution: {
    crabrunnerJobGroup: {
      enabled: false,
    },
  },
  admissionCard: {
    enabled: false,
  },
  codeGrounding: {
    enabled: DEFAULT_CODE_GROUNDING_ENABLED,
    baseDir: DEFAULT_CODE_GROUNDING_BASE_DIR,
    ttlMs: DEFAULT_CODE_GROUNDING_TTL_MS,
    maxCheckoutsPerRepo: DEFAULT_CODE_GROUNDING_MAX_CHECKOUTS_PER_REPO,
    materializationTimeoutMs: DEFAULT_CODE_GROUNDING_MATERIALIZATION_TIMEOUT_MS,
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
    preflightFailClosed: DEFAULT_CONTINUOUS_FEEDBACK_PREFLIGHT_FAIL_CLOSED,
  },
  riskPredicateReasoning: {
    effort: DEFAULT_RISK_PREDICATE_REASONING_EFFORT,
  },
  codex: {
    command: DEFAULT_CODEX_COMMAND,
    ephemeralHome: DEFAULT_CODEX_EPHEMERAL_HOME,
    disableSkills: DEFAULT_CODEX_DISABLE_SKILLS,
    toolOutputTokenLimit: DEFAULT_CODEX_TOOL_OUTPUT_TOKEN_LIMIT,
    modelAutoCompactTokenLimit: DEFAULT_CODEX_MODEL_AUTO_COMPACT_TOKEN_LIMIT,
    maxHealthyCompactionsPerStage:
      DEFAULT_CODEX_MAX_HEALTHY_COMPACTIONS_PER_STAGE,
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
