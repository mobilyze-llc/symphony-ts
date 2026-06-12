import type { ContractViolation } from "./config-contracts.js";

export interface WorkflowHooksConfig {
  afterCreate: string | null;
  beforeRun: string | null;
  afterRun: string | null;
  beforeRemove: string | null;
  timeoutMs: number;
}

export interface WorkflowTrackerConfig {
  kind: string | null;
  endpoint: string;
  apiKey: string | null;
  projectSlug: string | null;
  activeStates: string[];
  terminalStates: string[];
  /** Linear team ID for issue creation (pipeline-halt). Resolved from project context. */
  teamId?: string;
  /** Linear project ID for issue creation (pipeline-halt). Resolved from project context. */
  projectId?: string;
  /** Linear label ID for the pipeline-halt label. Resolved from project context. */
  haltLabelId?: string;
  /** Linear team key (e.g. "ENG") for workflow state resolution. */
  teamKey?: string;
}

export interface WorkflowPollingConfig {
  intervalMs: number;
}

export interface WorkflowWorkspaceConfig {
  root: string;
}

export interface WorkflowAgentConfig {
  maxConcurrentAgents: number;
  maxTurns: number;
  maxRetryBackoffMs: number;
  maxRetryAttempts: number;
  maxConcurrentAgentsByState: Readonly<Record<string, number>>;
}

export interface WorkflowHardStopsConfig {
  maxIterations: number;
  noProgressTurns: number;
  maxTokensPerUnit: number;
  maxDollarBudgetUsd: number;
  premiumBudgetPauseRatio: number;
  estimatedCostPer1kTokensUsd: number;
  cachedTokenCostRatio: number;
  /**
   * Max share of the Codex primary (5-hour) rate-limit window one unit of
   * work may burn, in percent points (0, 100]. null (the key omitted in
   * YAML) disables the check; 0 is rejected by config parsing because it
   * would pause on the first observed snapshot.
   */
  maxPrimaryWindowPctPerUnit: number | null;
  /** Same budget for the secondary (weekly) window. null disables. */
  maxSecondaryWindowPctPerUnit: number | null;
}

export type WorkflowHardStopsConfigOverride = Partial<WorkflowHardStopsConfig>;

/**
 * Global dispatch admission floor keyed on observed Codex rate-limit
 * headroom (SYMPH-333). When the remaining share of a window drops below the
 * configured floor, the dispatcher refuses new admissions until the window
 * resets. null floors disable the guard (default).
 */
export interface WorkflowRateLimitAdmissionConfig {
  minPrimaryHeadroomPct: number | null;
  minSecondaryHeadroomPct: number | null;
}

/**
 * Deterministic budget-escalation ladder (SYMPH-337 slice 1). When a worker
 * pauses on a budget hard stop, the orchestrator may auto-resume it with a
 * multiplied unit budget up to maxSteps times per issue. null maxSteps
 * disables the ladder (default); pauses then park for the operator as
 * before. Escalated unit budget = base * multiplier^step, so the cumulative
 * per-issue ceiling is base * (1 + m + m^2 + ...) bounded by maxSteps.
 */
export interface WorkflowBudgetEscalationConfig {
  maxSteps: number | null;
  multiplier: number;
}

/**
 * LLM pause triage (SYMPH-337 slice 2). When a budget pause survives the
 * deterministic escalation ladder, a local OpenAI-compatible model renders a
 * structured continue/split/hold verdict over harness-digested evidence.
 * Disabled unless baseUrl and model are both set; any endpoint or schema
 * failure fails closed to the operator pause. maxResumes bounds how many
 * triage-authorized continuations one issue may receive.
 */
/**
 * AC falsifiability gate (SYMPH-354): at investigate exit the local model
 * scores the workpad's acceptance criteria. Uses the pause_triage endpoint
 * settings; FAIL-OPEN — a judge hiccup advances the stage with a warning,
 * only a rendered "rework" verdict bounces.
 */
export interface WorkflowAcGateConfig {
  enabled: boolean;
}

/**
 * Spec-fidelity judge lane (SYMPH-343): at review-stage exit the local
 * model renders an independent verdict over the actual diff vs the tagged
 * acceptance criteria. Advisory in this slice (journal + comment); becomes
 * enforcing when SYMPH-355 publishes it as a required commit status.
 */
export interface WorkflowSpecFidelityConfig {
  enabled: boolean;
}

/**
 * Admission cards (SYMPH-379): on first dispatch the dispatcher publishes
 * its already-journaled admission + right-sizing decision to the issue as
 * one compact comment. Observability only; never gates dispatch.
 */
export interface WorkflowAdmissionCardConfig {
  enabled: boolean;
}

export interface WorkflowPauseTriageConfig {
  baseUrl: string | null;
  model: string | null;
  apiKey: string | null;
  maxResumes: number;
}

export interface WorkflowRunnerConfig {
  kind: string;
  model: string | null;
}

export type WorkflowContinuousFeedbackEvent = "commit" | "diff" | "checkpoint";

export interface WorkflowContinuousFeedbackConfig {
  enabled: boolean;
  events: WorkflowContinuousFeedbackEvent[];
  runner: string;
  model: string | null;
  role: string;
  bounceOnFinding: boolean;
}

export interface WorkflowCodexConfig {
  command: string;
  ephemeralHome?: boolean;
  disableSkills?: boolean;
  approvalPolicy: unknown;
  threadSandbox: unknown;
  turnSandboxPolicy: unknown;
  turnTimeoutMs: number;
  readTimeoutMs: number;
  stallTimeoutMs: number;
}

export interface WorkflowServerConfig {
  port: number | null;
  slackNotifyChannel: string | null;
}

/**
 * Per-product notification settings. Controls whether Slack alerts are
 * delivered for this WORKFLOW regardless of whether the webhook env var is
 * set globally.
 */
export interface WorkflowNotificationsConfig {
  /** When false, all Slack alerts are suppressed for this product. Default: true. */
  slackEnabled: boolean;
}

export interface WorkflowObservabilityConfig {
  dashboardEnabled: boolean;
  refreshMs: number;
  renderIntervalMs: number;
}

/**
 * Watchdog L1c configuration (SYMPH-398): cross-ticket signature clustering,
 * stage circuit breaker, and watchdog ticket filer.
 */
export interface WorkflowWatchdogConfig {
  /**
   * Minimum number of distinct issues sharing a failure signature before it
   * is declared SYSTEMIC. Default: 2.
   */
  systemicThreshold: number;
  /**
   * Whether to open the stage circuit breaker when a signature becomes
   * SYSTEMIC. Default: true.
   */
  circuitBreaker: boolean;
  /**
   * Maximum watchdog tickets filed per signature per hour. Default: 3.
   */
  maxFilingsPerHour: number;
}

export const STAGE_TYPES = ["agent", "gate", "terminal"] as const;
export type StageType = (typeof STAGE_TYPES)[number];

export const GATE_TYPES = ["ensemble", "human"] as const;
export type GateType = (typeof GATE_TYPES)[number];

export interface StageTransitions {
  onComplete: string | null;
  onApprove: string | null;
  onRework: string | null;
}

export interface ReviewerDefinition {
  runner: string;
  model: string | null;
  role: string;
  prompt: string | null;
}

export interface StageDefinition {
  type: StageType;
  runner: string | null;
  model: string | null;
  prompt: string | null;
  maxTurns: number | null;
  timeoutMs: number | null;
  hardStops?: WorkflowHardStopsConfigOverride | null;
  concurrency: number | null;
  gateType: GateType | null;
  maxRework: number | null;
  reviewers: ReviewerDefinition[];
  transitions: StageTransitions;
  linearState: string | null;
}

export interface FastTrackConfig {
  label: string;
  labels: readonly string[];
  initialStage: string;
}

export interface StagesConfig {
  initialStage: string;
  fastTrack: FastTrackConfig | null;
  stages: Readonly<Record<string, StageDefinition>>;
}

export interface ResolvedWorkflowConfig {
  workflowPath: string;
  promptTemplate: string;
  tracker: WorkflowTrackerConfig;
  polling: WorkflowPollingConfig;
  workspace: WorkflowWorkspaceConfig;
  hooks: WorkflowHooksConfig;
  agent: WorkflowAgentConfig;
  hardStops?: WorkflowHardStopsConfig;
  rateLimitAdmission: WorkflowRateLimitAdmissionConfig;
  budgetEscalation: WorkflowBudgetEscalationConfig;
  pauseTriage: WorkflowPauseTriageConfig;
  acGate: WorkflowAcGateConfig;
  specFidelity: WorkflowSpecFidelityConfig;
  admissionCard: WorkflowAdmissionCardConfig;
  watchdog: WorkflowWatchdogConfig;
  runner: WorkflowRunnerConfig;
  continuousFeedback?: WorkflowContinuousFeedbackConfig;
  codex: WorkflowCodexConfig;
  server: WorkflowServerConfig;
  notifications: WorkflowNotificationsConfig;
  observability: WorkflowObservabilityConfig;
  stages: StagesConfig | null;
  escalationState: string | null;
  /**
   * Single-homing guard (SYMPH-383): when set, only the machine whose
   * hostname's first label matches may dispatch this workflow. A second
   * host fails loudly at startup instead of silently racing the first
   * for the same tracker project. Absent/null means any host may run it.
   */
  ownerHost?: string | null;
  /**
   * Config-contract escape hatch (SYMPH-409). `contracts.override: true`
   * turns contract violations from dispatch-validation failures into
   * suppressed warnings that are re-logged loudly at every startup and
   * config reload. Optional so hand-built test fixtures keep compiling;
   * resolveWorkflowConfig always sets it.
   */
  contracts?: WorkflowContractsConfig;
}

/** See {@link ResolvedWorkflowConfig.contracts}. */
export interface WorkflowContractsConfig {
  override: boolean;
}

export interface DispatchValidationFailure {
  code: string;
  message: string;
}

export type DispatchValidationResult =
  | {
      ok: true;
      /**
       * Contract violations suppressed by `contracts.override: true`
       * (SYMPH-409). Present (non-empty) only when the override is active;
       * the runtime host re-warns about each entry at every startup and
       * config reload until the override is removed.
       */
      suppressedContractViolations?: ContractViolation[];
    }
  | {
      ok: false;
      error: DispatchValidationFailure;
    };

export interface WorkflowSnapshot {
  definition: {
    workflowPath: string;
    baseConfigPath?: string;
    config: Record<string, unknown>;
    promptTemplate: string;
  };
  config: ResolvedWorkflowConfig;
  dispatchValidation: DispatchValidationResult;
  loadedAt: string;
}

export type WorkflowReloadReason = "manual" | "filesystem_event";

export type WorkflowReloadResult =
  | {
      ok: true;
      reason: WorkflowReloadReason;
      previousSnapshot: WorkflowSnapshot;
      snapshot: WorkflowSnapshot;
    }
  | {
      ok: false;
      reason: WorkflowReloadReason;
      currentSnapshot: WorkflowSnapshot;
      error: unknown;
    };
