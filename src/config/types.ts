import type { ReasoningEffort } from "../domain/model.js";
import type { PlanEnvelope } from "../domain/standing-plan.js";
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
  /**
   * Team keys scoping the dispatch candidate source (SYMPH-794 / SYMPH-819).
   * When non-empty, candidates are the team's eligible backlog rather than
   * `project` members, so a bare `project` field no longer arms dispatch; the
   * admitted-set gate is then mandatory (see runtime-host.computeAdmittedIdentifiers).
   * A list ⇒ multi-team-ready. Empty/absent ⇒ the legacy project-scoped source.
   * Always populated by resolveWorkflowConfig (defaults to `[]`).
   */
  teamKeys?: string[];
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
  /**
   * Extra live-telemetry budget headroom for an already-running turn, as a
   * ratio of the token/dollar ceilings. 0 disables grace and kills immediately.
   */
  liveBudgetGraceRatio: number;
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
  deferUntilReset?: boolean;
  expectedUnitBurnPct?: number | null;
  deferJitterMs?: number;
  /**
   * Maximum age (ms) a persisted rate-limit snapshot may reach before it can
   * no longer block dispatch *by itself* when no worker is running to refresh
   * telemetry (SYMPH-778). Once telemetry is older than this and the pipeline
   * is idle, the gate fails open so a single probe dispatch can refresh the
   * snapshot — breaking the restart self-deadlock where a stale, future-reset
   * window closes admission and nothing can ever supersede it. null disables
   * the staleness bypass (the gate then trusts any non-expired snapshot).
   */
  snapshotMaxAgeMs?: number | null;
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
 * Merge actuator (SYMPH-735). When disabled the live merge-stage dispatch
 * barrier keeps parking eligible candidates with `merge_actuator_unwired`
 * instead of driving the GitHub/Linear merge side effects. maxWaitMs bounds the
 * merge-queue wait; the failure ceilings bound bounded recovery (SYMPH-746/748).
 */
export interface WorkflowMergeActuatorConfig {
  /** Master switch. When false the actuator stays parked (merge_actuator_unwired). Default false. */
  enabled: boolean;
  /**
   * Actuator auto-merge permission (SYMPH-754), DISTINCT from `enabled`.
   * `enabled` lets the actuator run/observe; this permission lets it ENQUEUE
   * (auto-merge). Default-CLOSED: when `enabled` is true but this is false the
   * actuator parks any enqueue-ready candidate with `auto_merge_permission_denied`
   * instead of enqueuing, so turning the actuator on for a new product cannot
   * silently start auto-merging without an explicit per-workflow grant.
   *
   * This per-workflow permission — not the worker's Mode Permission Envelope — is
   * the coherent auto-merge envelope: the actuator (not the worker) is the SOLE
   * auto-merge/enqueue actor, so `ModeScopedPermissionPolicy.canAutoMerge` in
   * `src/policy/hard-stops.ts` governs the WORKER only and is advisory w.r.t. the
   * actuator. See `decideMergeActuation`'s `autoMergePermission` gate.
   */
  autoMerge: boolean;
  maxWaitMs: number;
  maxLiveStateFailures: number;
  maxSideEffectFailures: number;
  maxDraftWaitObservations: number;
  /**
   * Max bounded pending-checks waits for a fresh (pre-enqueue) candidate whose
   * required CI is still in-flight before parking with pending_checks_timeout
   * (SYMPH-755).
   */
  maxPendingChecksWaitObservations: number;
  /**
   * Max bounded UNKNOWN-mergeability waits for a fresh (pre-enqueue) candidate
   * before parking with mergeability_unknown (SYMPH-752).
   */
  maxUnknownMergeabilityWaitObservations: number;
}

/**
 * Spec-fidelity judge lane (SYMPH-971): at review-stage exit an adjacent
 * crabrunner Opus job renders an independent report-only verdict over the
 * actual diff vs the tagged acceptance criteria. v1 records journal + comment
 * evidence only; it emits no commit status and adds no merge-blocking gate.
 */
export interface WorkflowSpecFidelityConfig {
  enabled: boolean;
}

/**
 * Crabrunner review job-group gate (SYMPH-855/SYMPH-812). Shipped Symphony
 * workflows opt in explicitly. When enabled, a crabrunner StageExecutionBackend
 * (SYMPHONY_CRABRUNNER_ROOT — SYMPH-853) and review dispatcher are required;
 * missing wiring fails closed instead of falling back to the removed local
 * review runtime. The dispatcher runs reviewer lanes (and optional browser QA)
 * through `runCrabrunnerReviewJobGroup`, producing the same review-result.json
 * + [REVIEW_GATE_RESULT_PATH:] marker the orchestrator already validates.
 */
export interface WorkflowReviewExecutionConfig {
  crabrunnerJobGroup: {
    enabled: boolean;
  };
  preReviewVerify?: WorkflowPreReviewVerifyConfig;
}

export type PreReviewVerifyCategory =
  | "typecheck"
  | "lint"
  | "build"
  | "unit"
  | "smoke";

export type PreReviewVerifyCommands = Readonly<
  Record<PreReviewVerifyCategory, string | null>
>;

export interface WorkflowPreReviewVerifyConfig {
  enabled: boolean;
  maxFixAttempts: number;
  commands: PreReviewVerifyCommands;
}

/**
 * Admission cards (SYMPH-379): on first dispatch the dispatcher publishes
 * its already-journaled admission + right-sizing decision to the issue as
 * one compact comment. Observability only; never gates dispatch.
 */
export interface WorkflowAdmissionCardConfig {
  enabled: boolean;
}

/**
 * Managed code-grounding for backlog hygiene (SYMPH-596). Grounding checkouts
 * live outside issue workspace keyspace and are bounded by TTL + per-repo cap.
 */
export interface WorkflowCodeGroundingConfig {
  enabled: boolean;
  baseDir: string;
  ttlMs: number;
  maxCheckoutsPerRepo: number;
  materializationTimeoutMs?: number;
}

export interface WorkflowPlannerGroundingConfig {
  enabled: boolean;
}

/**
 * Operator anchor ingestion (SYMPH-486). The allowlist gates Linear
 * field-edit ingestion; service account edits are explicitly inert so
 * agent-authored tracker writes cannot mint operator anchors.
 */
export interface WorkflowOperatorAnchorsConfig {
  operatorAllowlist: string[];
  serviceAccounts: string[];
  fieldName: string | null;
  ingestSecret: string | null;
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
  /** Runner provider selector; null means the runner kind's current default. */
  provider?: string | null;
}

export type WorkflowContinuousFeedbackEvent = "commit" | "diff" | "checkpoint";

export interface WorkflowContinuousFeedbackConfig {
  enabled: boolean;
  events: WorkflowContinuousFeedbackEvent[];
  runner: string;
  model: string | null;
  role: string;
  bounceOnFinding: boolean;
  /**
   * Startup model-availability preflight policy (SYMPH-761). When false
   * (default), an unavailable continuous-feedback model warns once at startup
   * and the runtime proceeds — the lane degrades gracefully at runtime. When
   * true, an unavailable model fails startup closed (RuntimeHostStartupError),
   * for operators who require the inner-loop reviewer to be live before launch.
   */
  preflightFailClosed: boolean;
}

export interface WorkflowCodexConfig {
  command: string;
  ephemeralHome?: boolean;
  disableSkills?: boolean;
  toolOutputTokenLimit?: number;
  modelAutoCompactTokenLimit?: number;
  maxHealthyCompactionsPerStage?: number;
  approvalPolicy: unknown;
  threadSandbox: unknown;
  turnSandboxPolicy: unknown;
  turnTimeoutMs: number;
  readTimeoutMs: number;
  stallTimeoutMs: number;
  /**
   * Proactive session rotation guard (SYMPH-412): when the cumulative input
   * tokens observed on a single Codex session exceed this threshold, the
   * runner rotates to a fresh session before the next turn instead of letting
   * accumulated thread context grow until the app-server dies mid-turn.
   * 0 disables the guard. Default: 1_500_000.
   */
  sessionRotationInputTokens?: number;
}

export interface WorkflowRiskPredicateReasoningConfig {
  /**
   * Reasoning effort applied only to eligible risk-predicate stages:
   * `investigate` and `implement`. Other stage names keep the baseline command.
   */
  effort: ReasoningEffort | null;
}

export interface WorkflowServerConfig {
  port: number | null;
  /**
   * Bind address for the dashboard server (`server.host` in WORKFLOW
   * frontmatter). `null` (the default) binds loopback (127.0.0.1).
   *
   * WARNING (SYMPH-449): setting this to "0.0.0.0" (or any non-loopback
   * address) exposes an unauthenticated mutating HTTP surface — pipeline
   * pause/resume, issue stop, deploy — to the network. Only opt in on a
   * trusted network segment.
   */
  host: string | null;
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
 * Watchdog L2 stuck-ticket triage (SYMPH-399): when the deterministic
 * watchdog parks a ticket (retry-without-novelty or circuit-breaker park),
 * a local model classifies the failure and picks one bounded action.
 * Default-DISABLED per product until calibration; parsed via Zod.
 */
export interface WorkflowStuckTriageConfig {
  /** Master switch. When false the lane contributes zero side effects. */
  enabled: boolean;
  baseUrl: string | null;
  model: string | null;
  apiKey: string | null;
  /** Verdict deadline; null uses the module default (600s). */
  timeoutMs: number | null;
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
  /**
   * Watchdog L2 stuck-ticket triage (SYMPH-399). Optional so existing
   * configs and fixtures need no change; absent means disabled.
   */
  stuckTriage?: WorkflowStuckTriageConfig;
}

/**
 * Verdict-event configuration (SYMPH-405).
 */
export interface WorkflowVerdictsConfig {
  /**
   * Number of consecutive poll ticks with eligible candidates but zero
   * dispatches before the dispatch-starvation page alert fires. Default: 10.
   */
  pageAfterTicks: number;
}

export const STAGE_TYPES = ["agent", "gate", "terminal"] as const;
export type StageType = (typeof STAGE_TYPES)[number];

export const GATE_TYPES = ["ensemble", "human"] as const;
export type GateType = (typeof GATE_TYPES)[number];

export const STAGE_EXECUTION_ROLES = [
  "classifier",
  "investigator",
  "planner",
  "implementer",
  "review",
  "reviewer",
  "verifier",
  "qa",
  "fallback",
  "closeout",
] as const;
export type StageExecutionRole = (typeof STAGE_EXECUTION_ROLES)[number];

export const STAGE_EXECUTION_PHASES = [
  "classify",
  "investigate",
  "plan",
  "implement",
  "verify",
  "review",
  "qa",
  "fallback",
  "closeout",
] as const;
export type StageExecutionPhase = (typeof STAGE_EXECUTION_PHASES)[number];

export const STAGE_EXECUTION_BACKENDS = [
  "current-runner",
  "crabrunner",
  "manual",
] as const;
export type StageExecutionBackend = (typeof STAGE_EXECUTION_BACKENDS)[number];

export const STAGE_EXECUTION_MISSING_CAPSULE_POLICIES = [
  "fail",
  "degrade",
] as const;
export type StageExecutionMissingCapsulePolicy =
  (typeof STAGE_EXECUTION_MISSING_CAPSULE_POLICIES)[number];

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

export interface StageExecutionArtifactContract {
  requires: readonly string[];
  produces: readonly string[];
}

export interface StageExecutionBudgetPolicy {
  maxTokens: number | null;
  maxUsd: number | null;
}

export interface StageExecutionDependencyPolicy {
  stages: readonly string[];
  capsules: readonly string[];
  missingCapsule: StageExecutionMissingCapsulePolicy;
}

export interface StageExecutionRunGroupIdentity {
  id: string | null;
  key: string | null;
}

export interface StageExecutionCapsulePaths {
  consume: readonly string[];
  produce: readonly string[];
}

export interface StageExecutionProfile {
  role: StageExecutionRole | null;
  phase: StageExecutionPhase | null;
  backend: StageExecutionBackend;
  /**
   * When true, config loading fails closed unless the selected provider keeps
   * the current Codex app-server control semantics.
   */
  controlNeeding: boolean;
  provider: string | null;
  model: string | null;
  reasoningEffort: ReasoningEffort | null;
  profile: string | null;
  artifacts: StageExecutionArtifactContract;
  timeoutMs: number | null;
  budget: StageExecutionBudgetPolicy;
  dependencies: StageExecutionDependencyPolicy;
  runGroup: StageExecutionRunGroupIdentity;
  capsules: StageExecutionCapsulePaths;
  /**
   * Ordered, bounded sub-stages this stage decomposes into (SYMPH-835). Empty
   * for stages that run as a single execution. Each sub-stage carries its own
   * StageExecutionProfile (provider/model/budget/capsules) so per-sub-stage
   * budget isolation and capsule handoff are fully data-driven, never
   * hard-coded. Sub-stages cannot themselves declare sub-stages (bounded to one
   * level).
   */
  subStages: readonly StageExecutionSubStage[];
}

export interface StageExecutionSubStage {
  /** Stable sub-stage name, e.g. "patch-plan" or "first-patch". */
  name: string;
  /** The sub-stage's own execution profile (its own subStages is always empty). */
  execution: StageExecutionProfile;
}

export interface StageExecutionValidationError {
  path: string;
  value: string;
  message: string;
}

export interface StageDefinition {
  type: StageType;
  runner: string | null;
  model: string | null;
  reasoningEffort?: ReasoningEffort | null;
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
  execution?: StageExecutionProfile | null;
  executionValidationErrors?: readonly StageExecutionValidationError[];
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

/** Queue Triage v2 Manager configuration (SYMPH-784). */
export const QUEUE_TRIAGE_PLANNER_EFFORTS = [
  "low",
  "medium",
  "high",
  "max",
] as const;
export type QueueTriagePlannerEffort =
  (typeof QUEUE_TRIAGE_PLANNER_EFFORTS)[number];

export interface WorkflowQueueTriageConfig {
  enabled: boolean;
  shadowMode: boolean;
  structuralAdvisories?: boolean;
  structuralAdvisoryDormantOkTicks?: number;
  structuralAdvisoryRenderCap?: number;
  /** Version-floating planner model alias (do not pin). Default "opus". */
  plannerModel: string;
  /** Explicit Anthropic thinking level. Default "max"; never lane-inherited. */
  plannerEffort: QueueTriagePlannerEffort;
  /** Re-plan heartbeat cadence for the shadow/plan loop, in ms. */
  heartbeatMs: number;
  /**
   * Linear states eligible to seed the planner backlog (SYMPH-1142). State
   * filtering runs BEFORE planner prompt/lane creation and BEFORE comment
   * enrichment, so in-flight states (In Progress, In Review, Resume) never seed a
   * plan even when the runtime running set is momentarily empty. Runtime
   * running-subtraction remains as a belt. Defaults to ["Todo"].
   */
  plannerCandidateStates: string[];
  /**
   * Posture-B auto-release frontier (SYMPH-789): how many lookahead batches the
   * consumer may auto-dispatch unattended (within the envelope). The rest are
   * held until an operator approval releases them. Tunable; default 1.
   */
  autoReleaseFrontier: number;
  envelope: PlanEnvelope;
  /**
   * Living control doc surface (SYMPH-790/791). Default-DISABLED and separate
   * from `enabled` because it needs a Linear team UUID and live document-API
   * access; an operator turns it on per workflow once verified. When enabled,
   * the planner heartbeat renders/updates the "🚦Ticket Triage Controls" doc and
   * ingests operator comments as revision-bound plan-control intents.
   */
  controlDoc: WorkflowQueueTriageControlDocConfig;
  /**
   * No-ambient-control-surfaces admission guardrail (SYMPH-794). Default-DISABLED
   * and separate from `enabled`: when on, a bare Linear `project` field no longer
   * admits a ticket — dispatch requires an explicit, journaled, revocable admit
   * signal (a current-revision honored `approve` decision's batch members, or the
   * plan-released set this tick). Held candidates are journaled, never dispatched.
   * Off by default so the live pipeline is unaffected until an operator opts in
   * once the plan/control-surface is trusted to cover the queue.
   *
   * Operator note: while the standing plan is DEGRADING (no fresh plan), the
   * guardrail holds every candidate that lacks an explicit current-revision
   * `approve` — including issues a prior plan released but that had not yet
   * dispatched. Explicit batch approval is the way to keep the pipeline moving
   * during a Manager outage (council R1, Pi P3).
   */
  admissionGuardrail: WorkflowQueueTriageAdmissionGuardrailConfig;
  /**
   * Curated-comment planner enrichment (SYMPH-874 Tier 3 / SYMPH-896).
   * Default-DISABLED and separate from `enabled` because it is the only
   * enrichment that costs an N+1 comment fetch over the backlog — an unmeasured
   * recurring cost surface. When on, the shadow tick fetches + curates + injects
   * curated comments into the planner prompt AND logs a report-only cost
   * measurement; the topology (two-pass vs curated one-pass) is tuned from that
   * measurement, not guessed (design SYMPH-795 §9 / measure-before-caps).
   */
  commentEnrichment: WorkflowQueueTriageCommentEnrichmentConfig;
  /**
   * Report-only tier-2 plan review in the live standing-plan shadow tick.
   * Default-DISABLED because changed ticks can spend a crabrunner council round.
   */
  planReview: WorkflowQueueTriagePlanReviewConfig;
}

export interface WorkflowQueueTriageControlDocConfig {
  enabled: boolean;
  /** Linear team UUID the team-level control doc attaches to. */
  teamId: string | null;
}

export interface WorkflowQueueTriageAdmissionGuardrailConfig {
  enabled: boolean;
}

export interface WorkflowQueueTriageCommentEnrichmentConfig {
  /** Master switch for the comment fetch + curation + injection (default false). */
  enabled: boolean;
  /**
   * Max backlog candidates to fetch comments for per tick — bounds the N+1
   * fetch. Candidates beyond the cap are skipped and the truncation is logged
   * (no silent caps).
   */
  maxCandidates: number;
  /** Max comment pages fetched per issue (passed to fetchIssueComments). */
  maxCommentPages: number;
  /** Max curated comments kept per issue (newest-first). */
  maxComments: number;
  /** Max characters per curated comment body. */
  maxCommentChars: number;
  /** Max total curated characters per issue. */
  maxTotalChars: number;
}

export interface WorkflowQueueTriagePlanReviewConfig {
  /** Master switch for passing tier-2 review into the shadow tick. */
  enabled: boolean;
  /** Separately gates council execution on grounded scheduled evidence. */
  plannerGroundingEnabled: boolean;
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
  /**
   * Crabrunner review job-group cutover gate (SYMPH-855). Optional so older
   * hand-built fixtures keep compiling; resolveWorkflowConfig always sets it
   * (default-closed). Consumers treat absence as disabled.
   */
  reviewExecution?: WorkflowReviewExecutionConfig;
  admissionCard: WorkflowAdmissionCardConfig;
  /** Optional so older fixtures keep compiling; resolveWorkflowConfig always sets it. */
  mergeActuator?: WorkflowMergeActuatorConfig;
  /** Optional so older hand-built fixtures keep compiling; resolveWorkflowConfig always sets it. */
  codeGrounding?: WorkflowCodeGroundingConfig;
  /** Optional so older hand-built fixtures keep compiling; resolveWorkflowConfig always sets it. */
  plannerGrounding?: WorkflowPlannerGroundingConfig;
  operatorAnchors?: WorkflowOperatorAnchorsConfig;
  watchdog: WorkflowWatchdogConfig;
  /** Optional so existing fixtures keep compiling; consumers default to 10. */
  verdicts?: WorkflowVerdictsConfig;
  runner: WorkflowRunnerConfig;
  continuousFeedback?: WorkflowContinuousFeedbackConfig;
  /**
   * Optional so older hand-built fixtures keep compiling; resolveWorkflowConfig
   * always sets it. null effort means no per-run reasoning override.
   */
  riskPredicateReasoning?: WorkflowRiskPredicateReasoningConfig;
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
  /**
   * Queue Triage v2 Manager spine (SYMPH-784). Optional so existing hand-built
   * fixtures keep compiling; resolveWorkflowConfig always sets it (default-off).
   */
  queueTriage?: WorkflowQueueTriageConfig;
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
