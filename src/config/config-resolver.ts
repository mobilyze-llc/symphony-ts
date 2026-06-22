import { homedir, hostname } from "node:os";
import { isAbsolute, normalize, resolve, sep } from "node:path";

import { z } from "zod";

import {
  REASONING_EFFORTS,
  type ReasoningEffort,
  type WorkflowDefinition,
  normalizeIssueState,
} from "../domain/model.js";
import {
  type PlanBatchMode,
  type PlanRiskTier,
  resolveStandingPlanEnvelope,
} from "../domain/standing-plan.js";
import { ERROR_CODES } from "../errors/codes.js";
import { normalizeAccountEmail } from "../shared/account-email.js";
import {
  checkConfigContracts,
  formatContractViolations,
} from "./config-contracts.js";
import {
  DEFAULT_ACTIVE_STATES,
  DEFAULT_BUDGET_ESCALATION_MAX_STEPS,
  DEFAULT_BUDGET_ESCALATION_MULTIPLIER,
  DEFAULT_CODEX_COMMAND,
  DEFAULT_CODEX_MAX_HEALTHY_COMPACTIONS_PER_STAGE,
  DEFAULT_CODEX_MODEL_AUTO_COMPACT_TOKEN_LIMIT,
  DEFAULT_CODEX_SESSION_ROTATION_INPUT_TOKENS,
  DEFAULT_CODEX_TOOL_OUTPUT_TOKEN_LIMIT,
  DEFAULT_CODE_GROUNDING_BASE_DIR,
  DEFAULT_CODE_GROUNDING_ENABLED,
  DEFAULT_CODE_GROUNDING_MATERIALIZATION_TIMEOUT_MS,
  DEFAULT_CODE_GROUNDING_MAX_CHECKOUTS_PER_REPO,
  DEFAULT_CODE_GROUNDING_TTL_MS,
  DEFAULT_CONTINUOUS_FEEDBACK_BOUNCE_ON_FINDING,
  DEFAULT_CONTINUOUS_FEEDBACK_ENABLED,
  DEFAULT_CONTINUOUS_FEEDBACK_EVENTS,
  DEFAULT_CONTINUOUS_FEEDBACK_MODEL,
  DEFAULT_CONTINUOUS_FEEDBACK_PREFLIGHT_FAIL_CLOSED,
  DEFAULT_CONTINUOUS_FEEDBACK_ROLE,
  DEFAULT_CONTINUOUS_FEEDBACK_RUNNER,
  DEFAULT_HARD_STOP_CACHED_TOKEN_COST_RATIO,
  DEFAULT_HARD_STOP_ESTIMATED_COST_PER_1K_TOKENS_USD,
  DEFAULT_HARD_STOP_LIVE_BUDGET_GRACE_RATIO,
  DEFAULT_HARD_STOP_MAX_DOLLAR_BUDGET_USD,
  DEFAULT_HARD_STOP_MAX_ITERATIONS,
  DEFAULT_HARD_STOP_MAX_PRIMARY_WINDOW_PCT_PER_UNIT,
  DEFAULT_HARD_STOP_MAX_SECONDARY_WINDOW_PCT_PER_UNIT,
  DEFAULT_HARD_STOP_MAX_TOKENS_PER_UNIT,
  DEFAULT_HARD_STOP_NO_PROGRESS_TURNS,
  DEFAULT_HARD_STOP_PREMIUM_BUDGET_PAUSE_RATIO,
  DEFAULT_HOOK_TIMEOUT_MS,
  DEFAULT_LINEAR_ENDPOINT,
  DEFAULT_LINEAR_NETWORK_TIMEOUT_MS,
  DEFAULT_LINEAR_PAGE_SIZE,
  DEFAULT_MAX_CONCURRENT_AGENTS,
  DEFAULT_MAX_CONCURRENT_AGENTS_BY_STATE,
  DEFAULT_MAX_RETRY_ATTEMPTS,
  DEFAULT_MAX_RETRY_BACKOFF_MS,
  DEFAULT_MAX_TURNS,
  DEFAULT_MERGE_ACTUATOR_MAX_DRAFT_WAIT_OBSERVATIONS,
  DEFAULT_MERGE_ACTUATOR_MAX_LIVE_STATE_FAILURES,
  DEFAULT_MERGE_ACTUATOR_MAX_PENDING_CHECKS_WAIT_OBSERVATIONS,
  DEFAULT_MERGE_ACTUATOR_MAX_SIDE_EFFECT_FAILURES,
  DEFAULT_MERGE_ACTUATOR_MAX_UNKNOWN_MERGEABILITY_WAIT_OBSERVATIONS,
  DEFAULT_MERGE_ACTUATOR_MAX_WAIT_MS,
  DEFAULT_OBSERVABILITY_ENABLED,
  DEFAULT_OBSERVABILITY_REFRESH_MS,
  DEFAULT_OBSERVABILITY_RENDER_INTERVAL_MS,
  DEFAULT_PAUSE_TRIAGE_MAX_RESUMES,
  DEFAULT_POLL_INTERVAL_MS,
  DEFAULT_QUEUE_TRIAGE_ADMISSION_GUARDRAIL_ENABLED,
  DEFAULT_QUEUE_TRIAGE_AUTO_RELEASE_FRONTIER,
  DEFAULT_QUEUE_TRIAGE_COMMENT_ENRICHMENT_ENABLED,
  DEFAULT_QUEUE_TRIAGE_COMMENT_ENRICHMENT_MAX_CANDIDATES,
  DEFAULT_QUEUE_TRIAGE_COMMENT_ENRICHMENT_MAX_COMMENTS,
  DEFAULT_QUEUE_TRIAGE_COMMENT_ENRICHMENT_MAX_COMMENT_CHARS,
  DEFAULT_QUEUE_TRIAGE_COMMENT_ENRICHMENT_MAX_COMMENT_PAGES,
  DEFAULT_QUEUE_TRIAGE_COMMENT_ENRICHMENT_MAX_TOTAL_CHARS,
  DEFAULT_QUEUE_TRIAGE_CONTROL_DOC_ENABLED,
  DEFAULT_QUEUE_TRIAGE_ENABLED,
  DEFAULT_QUEUE_TRIAGE_HEARTBEAT_MS,
  DEFAULT_QUEUE_TRIAGE_PLANNER_MODEL,
  DEFAULT_QUEUE_TRIAGE_SHADOW_MODE,
  DEFAULT_RATE_LIMIT_DEFER_JITTER_MS,
  DEFAULT_RATE_LIMIT_DEFER_UNTIL_RESET,
  DEFAULT_RATE_LIMIT_EXPECTED_UNIT_BURN_PCT,
  DEFAULT_RATE_LIMIT_MIN_PRIMARY_HEADROOM_PCT,
  DEFAULT_RATE_LIMIT_MIN_SECONDARY_HEADROOM_PCT,
  DEFAULT_RATE_LIMIT_SNAPSHOT_MAX_AGE_MS,
  DEFAULT_READ_TIMEOUT_MS,
  DEFAULT_RISK_PREDICATE_REASONING_EFFORT,
  DEFAULT_RUNNER_KIND,
  DEFAULT_STALL_TIMEOUT_MS,
  DEFAULT_STUCK_TRIAGE_ENABLED,
  DEFAULT_STUCK_TRIAGE_TIMEOUT_MS,
  DEFAULT_TERMINAL_STATES,
  DEFAULT_TRACKER_KIND,
  DEFAULT_TURN_TIMEOUT_MS,
  DEFAULT_VERDICTS_PAGE_AFTER_TICKS,
  DEFAULT_WATCHDOG_CIRCUIT_BREAKER,
  DEFAULT_WATCHDOG_MAX_FILINGS_PER_HOUR,
  DEFAULT_WATCHDOG_SYSTEMIC_THRESHOLD,
  DEFAULT_WORKSPACE_ROOT,
} from "./defaults.js";
import { parseStageExecutionProfile } from "./stage-execution-profile.js";
import type {
  DispatchValidationResult,
  FastTrackConfig,
  GateType,
  ResolvedWorkflowConfig,
  ReviewerDefinition,
  StageDefinition,
  StageTransitions,
  StageType,
  StagesConfig,
  WorkflowContinuousFeedbackEvent,
  WorkflowHardStopsConfigOverride,
  WorkflowQueueTriageConfig,
  WorkflowStuckTriageConfig,
} from "./types.js";
import { GATE_TYPES, STAGE_TYPES } from "./types.js";

// validateStagesConfig moved to config-contracts.ts (SYMPH-409); re-exported
// here so existing importers keep working.
export {
  type StagesValidationResult,
  validateStagesConfig,
} from "./config-contracts.js";

const LINEAR_CANONICAL_API_KEY_ENV = "LINEAR_API_KEY";

export function resolveWorkflowConfig(
  workflow: WorkflowDefinition & { workflowPath: string },
  environment: NodeJS.ProcessEnv = process.env,
): ResolvedWorkflowConfig {
  const config = workflow.config;
  const tracker = asRecord(config.tracker);
  const polling = asRecord(config.polling);
  const workspace = asRecord(config.workspace);
  const hooks = asRecord(config.hooks);
  const agent = asRecord(config.agent);
  const hardStops = asRecord(config.hard_stops);
  const hardStopOverrides = readHardStopsConfig(hardStops) ?? {};
  const rateLimitAdmission = asRecord(config.rate_limit_admission);
  const budgetEscalation = asRecord(config.budget_escalation);
  const pauseTriage = asRecord(config.pause_triage);
  const acGate = asRecord(config.ac_gate);
  const mergeActuator = asRecord(config.merge_actuator);
  const specFidelity = asRecord(config.spec_fidelity);
  const reviewExecution = asRecord(config.review_execution);
  const reviewCrabrunnerJobGroup = asRecord(
    reviewExecution.crabrunner_job_group,
  );
  const admissionCard = asRecord(config.admission_card);
  const codeGrounding = asRecord(config.code_grounding);
  const operatorAnchors = asRecord(config.operator_anchors);
  const watchdog = asRecord(config.watchdog);
  const verdicts = asRecord(config.verdicts);
  const runner = asRecord(config.runner);
  const continuousFeedback = asRecord(config.continuous_feedback);
  const codex = asRecord(config.codex);
  const server = asRecord(config.server);
  const notifications = asRecord(config.notifications);
  const observability = asRecord(config.observability);
  const contracts = asRecord(config.contracts);
  const queueTriage = asRecord(config.queue_triage);
  const maxConcurrentAgents =
    readPositiveInteger(agent.max_concurrent_agents) ??
    DEFAULT_MAX_CONCURRENT_AGENTS;

  return {
    workflowPath: workflow.workflowPath,
    promptTemplate: workflow.promptTemplate,
    tracker: {
      kind: readString(tracker.kind) ?? DEFAULT_TRACKER_KIND,
      endpoint: readString(tracker.endpoint) ?? DEFAULT_LINEAR_ENDPOINT,
      apiKey:
        resolveEnvReference(readString(tracker.api_key), environment) ??
        environment[LINEAR_CANONICAL_API_KEY_ENV] ??
        null,
      projectSlug: resolveEnvReference(
        readString(tracker.project_slug),
        environment,
      ),
      teamKeys: readStringList(tracker.team_keys, []),
      activeStates: readStringList(
        tracker.active_states,
        DEFAULT_ACTIVE_STATES,
      ),
      terminalStates: readStringList(
        tracker.terminal_states,
        DEFAULT_TERMINAL_STATES,
      ),
    },
    polling: {
      intervalMs: readInteger(polling.interval_ms) ?? DEFAULT_POLL_INTERVAL_MS,
    },
    workspace: {
      root:
        resolvePathValue(
          readString(workspace.root),
          workflow.workflowPath,
          environment,
        ) ?? DEFAULT_WORKSPACE_ROOT,
    },
    hooks: {
      afterCreate: readHookScript(
        hooks.after_create,
        workflow.workflowPath,
        environment,
      ),
      beforeRun: readHookScript(
        hooks.before_run,
        workflow.workflowPath,
        environment,
      ),
      afterRun: readHookScript(
        hooks.after_run,
        workflow.workflowPath,
        environment,
      ),
      beforeRemove: readHookScript(
        hooks.before_remove,
        workflow.workflowPath,
        environment,
      ),
      timeoutMs:
        readPositiveInteger(hooks.timeout_ms) ?? DEFAULT_HOOK_TIMEOUT_MS,
    },
    agent: {
      maxConcurrentAgents,
      maxTurns: readPositiveInteger(agent.max_turns) ?? DEFAULT_MAX_TURNS,
      maxRetryBackoffMs:
        readPositiveInteger(agent.max_retry_backoff_ms) ??
        DEFAULT_MAX_RETRY_BACKOFF_MS,
      maxRetryAttempts:
        readPositiveInteger(agent.max_retry_attempts) ??
        DEFAULT_MAX_RETRY_ATTEMPTS,
      maxConcurrentAgentsByState: readStateConcurrencyMap(
        agent.max_concurrent_agents_by_state,
      ),
    },
    hardStops: {
      maxIterations:
        hardStopOverrides.maxIterations ?? DEFAULT_HARD_STOP_MAX_ITERATIONS,
      noProgressTurns:
        hardStopOverrides.noProgressTurns ??
        DEFAULT_HARD_STOP_NO_PROGRESS_TURNS,
      maxTokensPerUnit:
        hardStopOverrides.maxTokensPerUnit ??
        DEFAULT_HARD_STOP_MAX_TOKENS_PER_UNIT,
      maxDollarBudgetUsd:
        hardStopOverrides.maxDollarBudgetUsd ??
        DEFAULT_HARD_STOP_MAX_DOLLAR_BUDGET_USD,
      premiumBudgetPauseRatio:
        hardStopOverrides.premiumBudgetPauseRatio ??
        DEFAULT_HARD_STOP_PREMIUM_BUDGET_PAUSE_RATIO,
      liveBudgetGraceRatio:
        hardStopOverrides.liveBudgetGraceRatio ??
        DEFAULT_HARD_STOP_LIVE_BUDGET_GRACE_RATIO,
      estimatedCostPer1kTokensUsd:
        hardStopOverrides.estimatedCostPer1kTokensUsd ??
        DEFAULT_HARD_STOP_ESTIMATED_COST_PER_1K_TOKENS_USD,
      cachedTokenCostRatio:
        hardStopOverrides.cachedTokenCostRatio ??
        DEFAULT_HARD_STOP_CACHED_TOKEN_COST_RATIO,
      maxPrimaryWindowPctPerUnit:
        hardStopOverrides.maxPrimaryWindowPctPerUnit ??
        DEFAULT_HARD_STOP_MAX_PRIMARY_WINDOW_PCT_PER_UNIT,
      maxSecondaryWindowPctPerUnit:
        hardStopOverrides.maxSecondaryWindowPctPerUnit ??
        DEFAULT_HARD_STOP_MAX_SECONDARY_WINDOW_PCT_PER_UNIT,
    },
    rateLimitAdmission: {
      minPrimaryHeadroomPct:
        readPercentPoints(rateLimitAdmission.min_primary_headroom_pct) ??
        DEFAULT_RATE_LIMIT_MIN_PRIMARY_HEADROOM_PCT,
      minSecondaryHeadroomPct:
        readPercentPoints(rateLimitAdmission.min_secondary_headroom_pct) ??
        DEFAULT_RATE_LIMIT_MIN_SECONDARY_HEADROOM_PCT,
      deferUntilReset:
        readBoolean(rateLimitAdmission.defer_until_reset) ??
        DEFAULT_RATE_LIMIT_DEFER_UNTIL_RESET,
      expectedUnitBurnPct:
        readPercentPoints(rateLimitAdmission.expected_unit_burn_pct) ??
        DEFAULT_RATE_LIMIT_EXPECTED_UNIT_BURN_PCT,
      deferJitterMs:
        readNonNegativeInteger(rateLimitAdmission.defer_jitter_ms) ??
        DEFAULT_RATE_LIMIT_DEFER_JITTER_MS,
      snapshotMaxAgeMs:
        "snapshot_max_age_ms" in rateLimitAdmission &&
        rateLimitAdmission.snapshot_max_age_ms === null
          ? null
          : (readNonNegativeInteger(rateLimitAdmission.snapshot_max_age_ms) ??
            DEFAULT_RATE_LIMIT_SNAPSHOT_MAX_AGE_MS),
    },
    budgetEscalation: {
      maxSteps:
        readPositiveInteger(budgetEscalation.max_steps) ??
        DEFAULT_BUDGET_ESCALATION_MAX_STEPS,
      multiplier:
        readEscalationMultiplier(budgetEscalation.multiplier) ??
        DEFAULT_BUDGET_ESCALATION_MULTIPLIER,
    },
    pauseTriage: {
      baseUrl: readString(pauseTriage.base_url),
      model: readString(pauseTriage.model),
      apiKey: resolveEnvReference(readString(pauseTriage.api_key), environment),
      maxResumes:
        readPositiveInteger(pauseTriage.max_resumes) ??
        DEFAULT_PAUSE_TRIAGE_MAX_RESUMES,
    },
    acGate: {
      enabled: acGate.enabled === true,
    },
    mergeActuator: {
      enabled: mergeActuator.enabled === true,
      // Default-CLOSED (SYMPH-754): only a strictly boolean `true` grants the
      // actuator the auto-merge/enqueue permission, mirroring `enabled` so a
      // truthy-but-non-boolean value (e.g. "true") does not silently open it.
      autoMerge: mergeActuator.auto_merge === true,
      maxWaitMs:
        readPositiveInteger(mergeActuator.max_wait_ms) ??
        DEFAULT_MERGE_ACTUATOR_MAX_WAIT_MS,
      maxLiveStateFailures:
        readPositiveInteger(mergeActuator.max_live_state_failures) ??
        DEFAULT_MERGE_ACTUATOR_MAX_LIVE_STATE_FAILURES,
      maxSideEffectFailures:
        readPositiveInteger(mergeActuator.max_side_effect_failures) ??
        DEFAULT_MERGE_ACTUATOR_MAX_SIDE_EFFECT_FAILURES,
      maxDraftWaitObservations:
        readPositiveInteger(mergeActuator.max_draft_wait_observations) ??
        DEFAULT_MERGE_ACTUATOR_MAX_DRAFT_WAIT_OBSERVATIONS,
      maxPendingChecksWaitObservations:
        readPositiveInteger(
          mergeActuator.max_pending_checks_wait_observations,
        ) ?? DEFAULT_MERGE_ACTUATOR_MAX_PENDING_CHECKS_WAIT_OBSERVATIONS,
      maxUnknownMergeabilityWaitObservations:
        readPositiveInteger(
          mergeActuator.max_unknown_mergeability_wait_observations,
        ) ?? DEFAULT_MERGE_ACTUATOR_MAX_UNKNOWN_MERGEABILITY_WAIT_OBSERVATIONS,
    },
    specFidelity: {
      enabled: specFidelity.enabled === true,
    },
    reviewExecution: {
      crabrunnerJobGroup: {
        // Explicit opt-in (SYMPH-855/SYMPH-812): shipped workflows set this
        // true. Custom workflows that leave it false keep their configured
        // runner path, but active Symphony review has no CMUX fallback.
        enabled: reviewCrabrunnerJobGroup.enabled === true,
      },
    },
    admissionCard: {
      enabled: admissionCard.enabled === true,
    },
    codeGrounding: {
      enabled:
        readBoolean(codeGrounding.enabled) ?? DEFAULT_CODE_GROUNDING_ENABLED,
      baseDir:
        readString(codeGrounding.base_dir) ?? DEFAULT_CODE_GROUNDING_BASE_DIR,
      ttlMs:
        readPositiveInteger(codeGrounding.ttl_ms) ??
        DEFAULT_CODE_GROUNDING_TTL_MS,
      maxCheckoutsPerRepo:
        readPositiveInteger(codeGrounding.max_checkouts_per_repo) ??
        DEFAULT_CODE_GROUNDING_MAX_CHECKOUTS_PER_REPO,
      materializationTimeoutMs:
        readPositiveInteger(codeGrounding.materialization_timeout_ms) ??
        DEFAULT_CODE_GROUNDING_MATERIALIZATION_TIMEOUT_MS,
    },
    operatorAnchors: {
      operatorAllowlist: readStringList(
        operatorAnchors.operator_allowlist,
        [],
      ).map(normalizeAccountEmail),
      serviceAccounts: readStringList(operatorAnchors.service_accounts, []).map(
        normalizeAccountEmail,
      ),
      fieldName: readString(operatorAnchors.field_name),
      ingestSecret: resolveEnvReference(
        readString(operatorAnchors.ingest_secret),
        environment,
      ),
    },
    watchdog: {
      systemicThreshold:
        readPositiveInteger(watchdog.systemic_threshold) ??
        DEFAULT_WATCHDOG_SYSTEMIC_THRESHOLD,
      circuitBreaker:
        readBoolean(watchdog.circuit_breaker) ??
        DEFAULT_WATCHDOG_CIRCUIT_BREAKER,
      maxFilingsPerHour:
        readPositiveInteger(watchdog.max_filings_per_hour) ??
        DEFAULT_WATCHDOG_MAX_FILINGS_PER_HOUR,
      stuckTriage: resolveStuckTriageConfig(watchdog.stuck_triage, environment),
    },
    verdicts: {
      pageAfterTicks:
        readPositiveInteger(verdicts.page_after_ticks) ??
        DEFAULT_VERDICTS_PAGE_AFTER_TICKS,
    },
    runner: {
      kind: readString(runner.kind) ?? DEFAULT_RUNNER_KIND,
      model: readString(runner.model),
      provider: readString(runner.provider) ?? null,
    },
    continuousFeedback: {
      enabled:
        readBoolean(continuousFeedback.enabled) ??
        DEFAULT_CONTINUOUS_FEEDBACK_ENABLED,
      events: readContinuousFeedbackEvents(continuousFeedback.events),
      runner:
        readString(continuousFeedback.runner) ??
        DEFAULT_CONTINUOUS_FEEDBACK_RUNNER,
      model:
        readString(continuousFeedback.model) ??
        DEFAULT_CONTINUOUS_FEEDBACK_MODEL,
      role:
        readString(continuousFeedback.role) ?? DEFAULT_CONTINUOUS_FEEDBACK_ROLE,
      bounceOnFinding:
        readBoolean(continuousFeedback.bounce_on_finding) ??
        DEFAULT_CONTINUOUS_FEEDBACK_BOUNCE_ON_FINDING,
      preflightFailClosed:
        readBoolean(continuousFeedback.preflight_fail_closed) ??
        DEFAULT_CONTINUOUS_FEEDBACK_PREFLIGHT_FAIL_CLOSED,
    },
    riskPredicateReasoning: {
      effort:
        readReasoningEffort(config.risk_predicate_reasoning_effort) ??
        DEFAULT_RISK_PREDICATE_REASONING_EFFORT,
    },
    codex: {
      command: readString(codex.command) ?? DEFAULT_CODEX_COMMAND,
      ephemeralHome: readBoolean(codex.ephemeral_home) ?? false,
      disableSkills: readBoolean(codex.disable_skills) ?? false,
      toolOutputTokenLimit:
        readPositiveInteger(codex.tool_output_token_limit) ??
        DEFAULT_CODEX_TOOL_OUTPUT_TOKEN_LIMIT,
      modelAutoCompactTokenLimit:
        readPositiveInteger(codex.model_auto_compact_token_limit) ??
        DEFAULT_CODEX_MODEL_AUTO_COMPACT_TOKEN_LIMIT,
      maxHealthyCompactionsPerStage:
        readNonNegativeInteger(codex.max_healthy_compactions_per_stage) ??
        DEFAULT_CODEX_MAX_HEALTHY_COMPACTIONS_PER_STAGE,
      approvalPolicy: codex.approval_policy,
      threadSandbox: codex.thread_sandbox,
      turnSandboxPolicy: codex.turn_sandbox_policy,
      turnTimeoutMs:
        readPositiveInteger(codex.turn_timeout_ms) ?? DEFAULT_TURN_TIMEOUT_MS,
      readTimeoutMs:
        readPositiveInteger(codex.read_timeout_ms) ?? DEFAULT_READ_TIMEOUT_MS,
      stallTimeoutMs:
        readInteger(codex.stall_timeout_ms) ?? DEFAULT_STALL_TIMEOUT_MS,
      sessionRotationInputTokens:
        readNonNegativeInteger(codex.session_rotation_input_tokens) ??
        DEFAULT_CODEX_SESSION_ROTATION_INPUT_TOKENS,
    },
    server: {
      port: readNonNegativeInteger(server.port),
      // Default null → dashboard server binds loopback. Non-loopback values
      // (e.g. "0.0.0.0") expose an unauthenticated mutating surface (SYMPH-449).
      // Blank/whitespace would reach listen(port, "") and bind WILDCARD in
      // Node — normalize to null so a quoted-blank YAML value stays loopback.
      host: readString(server.host)?.trim() || null,
      slackNotifyChannel:
        readString(server.slack_notify_channel) ??
        environment.SLACK_NOTIFY_CHANNEL ??
        null,
    },
    notifications: {
      slackEnabled: readBoolean(notifications.slack) ?? true,
    },
    observability: {
      dashboardEnabled:
        readBoolean(observability.dashboard_enabled) ??
        DEFAULT_OBSERVABILITY_ENABLED,
      refreshMs:
        readPositiveInteger(observability.refresh_ms) ??
        DEFAULT_OBSERVABILITY_REFRESH_MS,
      renderIntervalMs:
        readPositiveInteger(observability.render_interval_ms) ??
        DEFAULT_OBSERVABILITY_RENDER_INTERVAL_MS,
    },
    stages: resolveStagesConfig(config.stages),
    escalationState: readString(config.escalation_state),
    ownerHost: readString(config.owner_host),
    contracts: {
      override: readBoolean(contracts.override) ?? false,
    },
    queueTriage: resolveQueueTriageConfig(queueTriage, maxConcurrentAgents),
  };
}

/**
 * Queue Triage v2 Manager spine config (SYMPH-784). Default-DISABLED; shadow-on.
 * The envelope is validated by resolveStandingPlanEnvelope (throws on an invalid
 * envelope rather than silently widening the Manager's authority).
 */
function resolveQueueTriageConfig(
  queueTriage: Record<string, unknown>,
  maxConcurrentAgents: number,
): WorkflowQueueTriageConfig {
  const envelope = asRecord(queueTriage.envelope);
  const allowedModes = readStringList(envelope.allowed_modes, []);
  const allowedRisk = readString(envelope.allowed_risk);
  const commentEnrichment = asRecord(queueTriage.comment_enrichment);
  return {
    enabled: readBoolean(queueTriage.enabled) ?? DEFAULT_QUEUE_TRIAGE_ENABLED,
    shadowMode:
      readBoolean(queueTriage.shadow_mode) ?? DEFAULT_QUEUE_TRIAGE_SHADOW_MODE,
    plannerModel:
      readString(queueTriage.planner_model) ??
      DEFAULT_QUEUE_TRIAGE_PLANNER_MODEL,
    heartbeatMs:
      readPositiveInteger(queueTriage.heartbeat_ms) ??
      DEFAULT_QUEUE_TRIAGE_HEARTBEAT_MS,
    autoReleaseFrontier:
      readPositiveInteger(queueTriage.auto_release_frontier) ??
      DEFAULT_QUEUE_TRIAGE_AUTO_RELEASE_FRONTIER,
    controlDoc: {
      enabled:
        readBoolean(asRecord(queueTriage.control_doc).enabled) ??
        DEFAULT_QUEUE_TRIAGE_CONTROL_DOC_ENABLED,
      teamId: readString(asRecord(queueTriage.control_doc).team_id),
    },
    admissionGuardrail: {
      enabled:
        readBoolean(asRecord(queueTriage.admission_guardrail).enabled) ??
        DEFAULT_QUEUE_TRIAGE_ADMISSION_GUARDRAIL_ENABLED,
    },
    commentEnrichment: {
      enabled:
        readBoolean(commentEnrichment.enabled) ??
        DEFAULT_QUEUE_TRIAGE_COMMENT_ENRICHMENT_ENABLED,
      maxCandidates:
        readPositiveInteger(commentEnrichment.max_candidates) ??
        DEFAULT_QUEUE_TRIAGE_COMMENT_ENRICHMENT_MAX_CANDIDATES,
      maxCommentPages:
        readPositiveInteger(commentEnrichment.max_comment_pages) ??
        DEFAULT_QUEUE_TRIAGE_COMMENT_ENRICHMENT_MAX_COMMENT_PAGES,
      maxComments:
        readPositiveInteger(commentEnrichment.max_comments) ??
        DEFAULT_QUEUE_TRIAGE_COMMENT_ENRICHMENT_MAX_COMMENTS,
      maxCommentChars:
        readPositiveInteger(commentEnrichment.max_comment_chars) ??
        DEFAULT_QUEUE_TRIAGE_COMMENT_ENRICHMENT_MAX_COMMENT_CHARS,
      maxTotalChars:
        readPositiveInteger(commentEnrichment.max_total_chars) ??
        DEFAULT_QUEUE_TRIAGE_COMMENT_ENRICHMENT_MAX_TOTAL_CHARS,
    },
    envelope: resolveStandingPlanEnvelope({
      version: readPositiveInteger(envelope.version) ?? 1,
      concurrencyCeiling:
        readPositiveInteger(envelope.concurrency_ceiling) ??
        maxConcurrentAgents,
      ...(allowedRisk === null
        ? {}
        : { allowedRisk: allowedRisk as PlanRiskTier }),
      ...(allowedModes.length === 0
        ? {}
        : { allowedModes: allowedModes as PlanBatchMode[] }),
    }),
  };
}

/** First hostname label, case-folded: "PRO14.local" and "pro14" compare equal. */
function normalizeHostLabel(value: string): string {
  return value.trim().toLowerCase().split(".")[0] ?? "";
}

export function validateDispatchConfig(
  config: ResolvedWorkflowConfig,
  options?: { hostname?: string },
): DispatchValidationResult {
  const trackerKind = config.tracker.kind?.trim();
  if (!trackerKind) {
    return invalid(
      ERROR_CODES.configInvalid,
      "tracker.kind must be present before dispatch.",
    );
  }

  if (trackerKind !== DEFAULT_TRACKER_KIND) {
    return invalid(
      ERROR_CODES.unsupportedTrackerKind,
      `tracker.kind '${trackerKind}' is not supported.`,
    );
  }

  if (!config.tracker.apiKey || config.tracker.apiKey.trim() === "") {
    return invalid(
      ERROR_CODES.trackerCredentialsMissing,
      "tracker.api_key must be configured before dispatch.",
    );
  }

  // Dispatch needs a candidate scope: either a project slug (legacy) or at
  // least one team key (SYMPH-794/824 team-scoped mode). The adjacent
  // provenance/halt/by-states queries are team-scoped when team_keys is set, so
  // a project slug is no longer mandatory — but one of the two must be present.
  const hasProjectSlug =
    !!config.tracker.projectSlug && config.tracker.projectSlug.trim() !== "";
  const hasTeamKeys = (config.tracker.teamKeys?.length ?? 0) > 0;
  if (!hasProjectSlug && !hasTeamKeys) {
    return invalid(
      ERROR_CODES.configInvalid,
      "tracker.project_slug or tracker.team_keys must be configured before dispatch.",
    );
  }

  if (config.ownerHost !== null && config.ownerHost !== undefined) {
    const ownerHost = config.ownerHost.trim();
    if (ownerHost === "") {
      // A safety guard that is present but blank reads as intent to
      // restrict, not intent to disable — fail closed on the typo.
      return invalid(
        ERROR_CODES.configInvalid,
        "owner_host must be a non-empty hostname label when set; omit the key to allow any host.",
      );
    }
    const machine = options?.hostname ?? hostname();
    if (normalizeHostLabel(machine) !== normalizeHostLabel(ownerHost)) {
      return invalid(
        ERROR_CODES.ownerHostMismatch,
        `owner_host '${ownerHost}' does not match this machine '${machine}' — this workflow is single-homed to one orchestrator host (SYMPH-383); refusing to dispatch.`,
      );
    }
  }

  if (config.codex.command.trim() === "") {
    return invalid(
      ERROR_CODES.configInvalid,
      "codex.command must be present and non-empty before dispatch.",
    );
  }

  if (
    config.codex.disableSkills === true &&
    config.codex.ephemeralHome !== true
  ) {
    return invalid(
      ERROR_CODES.configInvalid,
      "codex.disable_skills requires codex.ephemeral_home before dispatch.",
    );
  }

  // Declared-vs-consumed config contracts (SYMPH-409). contracts.override
  // suppresses the failure but the violations ride along on the ok result so
  // the runtime host can re-warn loudly at every startup and reload.
  const contractViolations = checkConfigContracts(config);
  if (contractViolations.length > 0) {
    if (config.contracts?.override === true) {
      return { ok: true, suppressedContractViolations: contractViolations };
    }

    return invalid(
      ERROR_CODES.configContractViolation,
      `Config contract violation(s):\n${formatContractViolations(contractViolations)}`,
    );
  }

  return { ok: true };
}

function invalid(code: string, message: string): DispatchValidationResult {
  return {
    ok: false,
    error: {
      code,
      message,
    },
  };
}

function asRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return {};
  }

  return value as Record<string, unknown>;
}

function readString(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }

  return value;
}

function readScript(value: unknown): string | null {
  const script = readString(value);
  if (script === null) {
    return null;
  }

  return script === "" ? null : script;
}

function readHookScript(
  value: unknown,
  workflowPath: string,
  environment: NodeJS.ProcessEnv,
): string | null {
  const script = readScript(value);
  if (script === null) {
    return null;
  }

  // A hook can be configured as `$HOOK_SCRIPT`; resolve that when present.
  // Missing top-level env refs and embedded shell refs stay verbatim so the
  // hook still runs with the process environment in the workspace shell.
  const resolvedScript = resolveEnvReference(script, environment) ?? script;
  const trimmedScript = resolvedScript.trim();
  if (!isSinglePathHookScript(trimmedScript)) {
    return resolvedScript;
  }

  const resolvedPath = resolvePathValue(
    trimmedScript,
    workflowPath,
    environment,
  );
  if (resolvedPath === null) {
    return resolvedScript;
  }

  return quoteHookScriptPath(resolvedPath);
}

function quoteHookScriptPath(path: string): string {
  // The configured value had no whitespace (isSinglePathHookScript), but the
  // workflow directory it resolved against may introduce spaces or other
  // shell-special characters, and the hook runs through `sh -lc` where a bare
  // word would split or glob (SYMPH-285). Bare-word-safe paths stay
  // byte-identical with prior behavior; `$` is in the safe set so env refs
  // like `./$PRODUCT/hooks/x.sh` keep their historical bare-word expansion
  // semantics (bare expansion word-splits its result; quoted does not).
  if (/^[A-Za-z0-9_\-./~+@%:,=$]+$/.test(path)) {
    return path;
  }

  // Double quotes, NOT single: `$VAR` segments left for the shell (e.g.
  // `./$PRODUCT/hooks/before-run.sh`) must keep expanding at execution time.
  return `"${path.replace(/([\\"`])/g, "\\$1")}"`;
}

function isSinglePathHookScript(script: string): boolean {
  // `$HOOK_SCRIPT` reaches this branch only when config-time env resolution
  // missed; keep it shell-resolved instead of treating it as a path.
  if (script === "" || /\s/.test(script) || script.startsWith("$")) {
    return false;
  }

  return (
    isAbsolute(script) ||
    script.startsWith(".") ||
    script.startsWith("~") ||
    script.includes("/") ||
    script.includes("\\")
  );
}

function readInteger(value: unknown): number | null {
  if (typeof value === "number" && Number.isInteger(value)) {
    return value;
  }

  if (typeof value === "string" && /^-?\d+$/.test(value.trim())) {
    return Number.parseInt(value.trim(), 10);
  }

  return null;
}

function readBoolean(value: unknown): boolean | null {
  if (typeof value === "boolean") {
    return value;
  }

  if (typeof value === "string") {
    const normalized = value.trim().toLowerCase();
    if (normalized === "true") {
      return true;
    }
    if (normalized === "false") {
      return false;
    }
  }

  return null;
}

function readPositiveInteger(value: unknown): number | null {
  const parsed = readInteger(value);
  if (parsed === null || parsed <= 0) {
    return null;
  }

  return parsed;
}

function readPositiveNumber(value: unknown): number | null {
  const parsed = readNumber(value);
  if (parsed === null || parsed <= 0) {
    return null;
  }

  return parsed;
}

function readNonNegativeInteger(value: unknown): number | null {
  const parsed = readInteger(value);
  if (parsed === null || parsed < 0) {
    return null;
  }

  return parsed;
}

function readRatio(value: unknown): number | null {
  const parsed = readNumber(value);
  if (parsed === null || parsed <= 0 || parsed > 1) {
    return null;
  }

  return parsed;
}

// Escalation multipliers must grow the budget but stay sane: (1, 10].
function readEscalationMultiplier(value: unknown): number | null {
  const parsed = readNumber(value);
  if (parsed === null || parsed <= 1 || parsed > 10) {
    return null;
  }

  return parsed;
}

// Percent points in (0, 100] matching Codex rate-limit `used_percent` units.
// Zero is rejected on purpose: a 0 budget would pause on the first snapshot
// (delta >= 0 always holds) and a 0 headroom floor is a no-op — "disabled"
// is expressed by omitting the key, never by 0.
function readPercentPoints(value: unknown): number | null {
  const parsed = readNumber(value);
  if (parsed === null || parsed <= 0 || parsed > 100) {
    return null;
  }

  return parsed;
}

function readZeroInclusiveRatio(value: unknown): number | null {
  const parsed = readNumber(value);
  if (parsed === null || parsed < 0 || parsed > 1) {
    return null;
  }

  return parsed;
}

function readNumber(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }

  if (typeof value === "string") {
    const parsed = Number(value.trim());
    return Number.isFinite(parsed) ? parsed : null;
  }

  return null;
}

function readStringList(value: unknown, fallback: readonly string[]): string[] {
  if (Array.isArray(value)) {
    const items = value.filter(
      (entry): entry is string => typeof entry === "string",
    );
    if (items.length > 0) {
      return items.map((entry) => entry.trim()).filter((entry) => entry !== "");
    }
  }

  if (typeof value === "string") {
    const items = value
      .split(",")
      .map((entry) => entry.trim())
      .filter((entry) => entry !== "");
    if (items.length > 0) {
      return items;
    }
  }

  return [...fallback];
}

function readContinuousFeedbackEvents(
  value: unknown,
): WorkflowContinuousFeedbackEvent[] {
  const valid = new Set<WorkflowContinuousFeedbackEvent>([
    "commit",
    "diff",
    "checkpoint",
  ]);
  const items = readStringList(value, DEFAULT_CONTINUOUS_FEEDBACK_EVENTS)
    .map((entry) => entry.toLowerCase())
    .filter((entry): entry is WorkflowContinuousFeedbackEvent =>
      valid.has(entry as WorkflowContinuousFeedbackEvent),
    );
  return items.length > 0 ? [...new Set(items)] : ["checkpoint"];
}

function readReasoningEffort(value: unknown): ReasoningEffort | null {
  const raw = readString(value);
  if (raw === null) {
    return null;
  }
  const normalized = raw.trim().toLowerCase();
  return (REASONING_EFFORTS as readonly string[]).includes(normalized)
    ? (normalized as ReasoningEffort)
    : null;
}

function readStateConcurrencyMap(
  value: unknown,
): Readonly<Record<string, number>> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return DEFAULT_MAX_CONCURRENT_AGENTS_BY_STATE;
  }

  const normalizedEntries = Object.entries(value).flatMap(([state, limit]) => {
    const parsedLimit = readPositiveInteger(limit);
    if (parsedLimit === null) {
      return [];
    }

    return [[normalizeIssueState(state), parsedLimit] as const];
  });

  return Object.freeze(Object.fromEntries(normalizedEntries));
}

/**
 * Watchdog L2 stuck-triage block (SYMPH-399), validated with Zod at the
 * I/O boundary. Default-disabled: an absent block resolves to
 * `{enabled: false, ...}` and the lane contributes zero side effects.
 * A malformed block fails loudly at load (config-contract philosophy —
 * a silently-dropped `enabled: true` would present as a watchdog that
 * never triages).
 */
const STUCK_TRIAGE_SCHEMA = z
  .object({
    enabled: z.boolean().optional(),
    base_url: z.string().min(1).optional().nullable(),
    model: z.string().min(1).optional().nullable(),
    api_key: z.string().min(1).optional().nullable(),
    timeout_ms: z.number().int().positive().optional().nullable(),
  })
  .strict();

function resolveStuckTriageConfig(
  value: unknown,
  environment: NodeJS.ProcessEnv,
): WorkflowStuckTriageConfig {
  const disabled: WorkflowStuckTriageConfig = {
    enabled: DEFAULT_STUCK_TRIAGE_ENABLED,
    baseUrl: null,
    model: null,
    apiKey: null,
    timeoutMs: DEFAULT_STUCK_TRIAGE_TIMEOUT_MS,
  };
  if (value === undefined || value === null) {
    return disabled;
  }

  const parsed = STUCK_TRIAGE_SCHEMA.safeParse(value);
  if (!parsed.success) {
    throw new Error(
      `Invalid watchdog.stuck_triage config: ${parsed.error.issues
        .map((issue) => `${issue.path.join(".")}: ${issue.message}`)
        .join("; ")}`,
    );
  }

  return {
    enabled: parsed.data.enabled ?? DEFAULT_STUCK_TRIAGE_ENABLED,
    baseUrl: parsed.data.base_url ?? null,
    model: parsed.data.model ?? null,
    apiKey: resolveEnvReference(parsed.data.api_key ?? null, environment),
    timeoutMs: parsed.data.timeout_ms ?? DEFAULT_STUCK_TRIAGE_TIMEOUT_MS,
  };
}

function resolveEnvReference(
  value: string | null,
  environment: NodeJS.ProcessEnv,
): string | null {
  if (!value) {
    return null;
  }

  if (!value.startsWith("$")) {
    return value;
  }

  const envName = value.slice(1);
  const resolvedValue = environment[envName];
  if (!resolvedValue || resolvedValue.trim() === "") {
    return null;
  }

  return resolvedValue;
}

function resolvePathValue(
  value: string | null,
  workflowPath: string,
  environment: NodeJS.ProcessEnv,
): string | null {
  const rawPath = resolveEnvReference(value, environment);
  if (!rawPath) {
    return null;
  }

  let expanded = rawPath.startsWith("~")
    ? `${homedir()}${rawPath.slice(1)}`
    : rawPath;

  if (
    !expanded.includes(sep) &&
    !expanded.includes("/") &&
    !expanded.includes("\\")
  ) {
    return expanded;
  }

  if (isAbsolute(expanded)) {
    return normalize(expanded);
  }

  expanded = resolve(resolve(workflowPath, ".."), expanded);
  return normalize(expanded);
}

export function resolveStagesConfig(value: unknown): StagesConfig | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }

  const raw = value as Record<string, unknown>;
  const stageEntries: Record<string, StageDefinition> = {};
  let firstStageName: string | null = null;

  for (const [name, stageValue] of Object.entries(raw)) {
    if (name === "initial_stage" || name === "fast_track") {
      continue;
    }

    const stageRecord = asRecord(stageValue);
    const rawType = readString(stageRecord.type);
    const stageType = parseStageType(rawType);
    if (stageType === null) {
      continue;
    }

    if (firstStageName === null) {
      firstStageName = name;
    }

    const execution = parseStageExecutionProfile(
      stageRecord.execution,
      `stages.${name}.execution`,
    );

    stageEntries[name] = {
      type: stageType,
      runner: readString(stageRecord.runner),
      model: readString(stageRecord.model),
      reasoningEffort: readReasoningEffort(stageRecord.reasoning_effort),
      prompt: readString(stageRecord.prompt),
      maxTurns: readPositiveInteger(stageRecord.max_turns),
      timeoutMs: readPositiveInteger(stageRecord.timeout_ms),
      hardStops: readHardStopsConfig(stageRecord.hard_stops),
      concurrency: readPositiveInteger(stageRecord.concurrency),
      gateType: parseGateType(readString(stageRecord.gate_type)),
      maxRework: readPositiveInteger(stageRecord.max_rework),
      reviewers: parseReviewers(stageRecord.reviewers),
      transitions: {
        onComplete: readString(stageRecord.on_complete),
        onApprove: readString(stageRecord.on_approve),
        onRework: readString(stageRecord.on_rework),
      },
      linearState: readString(stageRecord.linear_state),
      execution: execution.profile,
      executionValidationErrors: execution.errors,
    };
  }

  if (Object.keys(stageEntries).length === 0) {
    return null;
  }

  // biome-ignore lint/style/noNonNullAssertion: firstStageName guaranteed non-null when stageEntries is non-empty
  const initialStage = readString(raw.initial_stage) ?? firstStageName!;

  const fastTrackRaw = asRecord(raw.fast_track);
  const fastTrackLabels = readFastTrackLabels(fastTrackRaw);
  const primaryFastTrackLabel = fastTrackLabels[0];
  const fastTrackInitialStage = readString(fastTrackRaw.initial_stage);
  const fastTrack: FastTrackConfig | null =
    primaryFastTrackLabel !== undefined && fastTrackInitialStage !== null
      ? {
          label: primaryFastTrackLabel,
          labels: fastTrackLabels,
          initialStage: fastTrackInitialStage,
        }
      : null;

  return Object.freeze({
    initialStage,
    fastTrack,
    stages: Object.freeze(stageEntries),
  });
}

function readHardStopsConfig(
  value: unknown,
): WorkflowHardStopsConfigOverride | null {
  const hardStops = asRecord(value);
  const parsed: WorkflowHardStopsConfigOverride = {};

  const maxIterations = readPositiveInteger(hardStops.max_iterations);
  if (maxIterations !== null) {
    parsed.maxIterations = maxIterations;
  }

  const noProgressTurns = readNonNegativeInteger(hardStops.no_progress_turns);
  if (noProgressTurns !== null) {
    parsed.noProgressTurns = noProgressTurns;
  }

  const maxTokensPerUnit = readPositiveInteger(hardStops.max_tokens_per_unit);
  if (maxTokensPerUnit !== null) {
    parsed.maxTokensPerUnit = maxTokensPerUnit;
  }

  const maxDollarBudgetUsd = readPositiveNumber(
    hardStops.max_dollar_budget_usd,
  );
  if (maxDollarBudgetUsd !== null) {
    parsed.maxDollarBudgetUsd = maxDollarBudgetUsd;
  }

  const premiumBudgetPauseRatio = readRatio(
    hardStops.premium_budget_pause_ratio,
  );
  if (premiumBudgetPauseRatio !== null) {
    parsed.premiumBudgetPauseRatio = premiumBudgetPauseRatio;
  }

  const liveBudgetGraceRatio = readZeroInclusiveRatio(
    hardStops.live_budget_grace_ratio,
  );
  if (liveBudgetGraceRatio !== null) {
    parsed.liveBudgetGraceRatio = liveBudgetGraceRatio;
  }

  const estimatedCostPer1kTokensUsd = readPositiveNumber(
    hardStops.estimated_cost_per_1k_tokens_usd,
  );
  if (estimatedCostPer1kTokensUsd !== null) {
    parsed.estimatedCostPer1kTokensUsd = estimatedCostPer1kTokensUsd;
  }

  // Unlike premium_budget_pause_ratio, a ratio of exactly 0 is meaningful
  // here: cached input is free.
  const cachedTokenCostRatio = readZeroInclusiveRatio(
    hardStops.cached_token_cost_ratio,
  );
  if (cachedTokenCostRatio !== null) {
    parsed.cachedTokenCostRatio = cachedTokenCostRatio;
  }

  const maxPrimaryWindowPctPerUnit = readPercentPoints(
    hardStops.max_primary_window_pct_per_unit,
  );
  if (maxPrimaryWindowPctPerUnit !== null) {
    parsed.maxPrimaryWindowPctPerUnit = maxPrimaryWindowPctPerUnit;
  }

  const maxSecondaryWindowPctPerUnit = readPercentPoints(
    hardStops.max_secondary_window_pct_per_unit,
  );
  if (maxSecondaryWindowPctPerUnit !== null) {
    parsed.maxSecondaryWindowPctPerUnit = maxSecondaryWindowPctPerUnit;
  }

  return Object.keys(parsed).length === 0 ? null : parsed;
}

function readFastTrackLabels(
  fastTrackRaw: Record<string, unknown>,
): readonly string[] {
  const labels = new Set<string>();
  const legacyLabel = readString(fastTrackRaw.label);
  if (legacyLabel !== null && legacyLabel.trim() !== "") {
    labels.add(legacyLabel.trim());
  }
  for (const label of readStringList(fastTrackRaw.labels, [])) {
    labels.add(label);
  }
  return [...labels];
}

function parseReviewers(value: unknown): ReviewerDefinition[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return value.flatMap((entry) => {
    const record = asRecord(entry);
    const runner = readString(record.runner);
    const role = readString(record.role);
    if (runner === null || role === null) {
      return [];
    }

    return [
      {
        runner,
        model: readString(record.model),
        role,
        prompt: readString(record.prompt),
      },
    ];
  });
}

function parseStageType(value: string | null): StageType | null {
  if (value === null) {
    return null;
  }
  const normalized = value.trim().toLowerCase();
  return (STAGE_TYPES as readonly string[]).includes(normalized)
    ? (normalized as StageType)
    : null;
}

function parseGateType(value: string | null): GateType | null {
  if (value === null) {
    return null;
  }
  const normalized = value.trim().toLowerCase();
  return (GATE_TYPES as readonly string[]).includes(normalized)
    ? (normalized as GateType)
    : null;
}

export const LINEAR_DEFAULTS = Object.freeze({
  endpoint: DEFAULT_LINEAR_ENDPOINT,
  pageSize: DEFAULT_LINEAR_PAGE_SIZE,
  networkTimeoutMs: DEFAULT_LINEAR_NETWORK_TIMEOUT_MS,
});
