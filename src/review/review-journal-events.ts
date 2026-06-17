import type {
  DispatcherRunJournal,
  DispatcherRunJournalEntry,
} from "../domain/model.js";
import { appendDispatcherRunJournalEntriesWithLock } from "../logging/run-journal.js";
import { buildMergeCandidateEntryFromReviewGate } from "../orchestrator/merge-candidate.js";
import type {
  CouncilTerminationAssessment,
  HeadlessCouncilGateResult,
  HeadlessLaneResult,
  StructuredReviewFamilySynthesis,
  StructuredReviewFinding,
  StructuredReviewerArtifact,
  TargetedConvergenceHypothesis,
} from "./headless-council-gate.js";

export const REVIEW_JOURNAL_SCHEMA_VERSION = 1;

export type ReviewJournalSource = "pipeline" | "interactive" | "replay";
export type ReviewJournalContractVersion = "markdown_v0" | "structured_v1";

export interface ReviewJournalActor {
  kind: "pipeline-worker" | "interactive-agent" | "replay" | "dispatcher";
  id: string;
}

export interface ReviewJournalEventOptions {
  issueId?: string;
  issueIdentifier?: string;
  ownerId?: string | null;
  stage?: string | null;
  attempt?: number | null;
  source?: ReviewJournalSource;
  actor?: ReviewJournalActor;
  idempotencyKeyPrefix?: string;
}

export interface AppendReviewJournalEventsInput {
  workspaceRoot: string;
  result: HeadlessCouncilGateResult;
  options?: ReviewJournalEventOptions;
}

export interface AppendReviewJournalEventsResult {
  journal: DispatcherRunJournal;
  entries: DispatcherRunJournalEntry[];
  appendedEntries: DispatcherRunJournalEntry[];
  skippedEntries: DispatcherRunJournalEntry[];
}

type ReviewJournalEntryDraft = Omit<DispatcherRunJournalEntry, "sequence">;

interface StructuredLaneArtifact {
  lane: HeadlessLaneResult;
  artifact: StructuredReviewerArtifact;
}

const SAFE_LABEL_MAX_LENGTH = 120;

export function buildReviewJournalEntries(
  result: HeadlessCouncilGateResult,
  options: ReviewJournalEventOptions = {},
): ReviewJournalEntryDraft[] {
  const context = buildJournalContext(result, options);
  const entries: ReviewJournalEntryDraft[] = [];
  const structuredArtifacts = collectStructuredArtifacts(result);
  const authoritativeStructuredArtifacts =
    collectMergeAuthoritativeStructuredArtifacts(result);
  const contractVersion =
    structuredArtifacts.length > 0 ? "structured_v1" : "markdown_v0";
  const findings = authoritativeStructuredArtifacts.flatMap(
    ({ lane, artifact }) =>
      artifact.findings.map((finding) => ({ lane, artifact, finding })),
  );
  const termination = result.termination ?? null;

  entries.push(
    entryFor(context, {
      kind: "review_round",
      timestamp: normalizeTimestamp(result.startedAt, result.completedAt),
      keyParts: ["round"],
      summary: `Council review round ${context.round} started for ${context.issueIdentifier}.`,
      metadata: {
        ...baseMetadata(context, contractVersion),
        ...terminationTelemetryMetadata(termination),
        ...targetedConvergenceMetadata(result.targeted_convergence),
        started_at: normalizeTimestamp(result.startedAt, result.completedAt),
        completed_at: normalizeTimestamp(result.completedAt, result.startedAt),
        lane_count: result.lanes.length,
        finding_count: findings.length,
      },
    }),
  );

  if (isFixRound(result)) {
    entries.push(
      entryFor(context, {
        kind: "fix_round",
        timestamp: normalizeTimestamp(result.startedAt, result.completedAt),
        keyParts: ["fix", context.round],
        summary: `Council fix round ${context.round} anchored for ${context.issueIdentifier}.`,
        metadata: {
          ...baseMetadata(context, contractVersion),
          ...terminationTelemetryMetadata(termination),
          ...targetedConvergenceMetadata(result.targeted_convergence),
          fix_round: context.round,
          previous_head_sha:
            result.review_metadata.previous_reviewed_head_sha ?? undefined,
          reviewed_head_sha:
            result.review_metadata.reviewed_head_sha ?? undefined,
        },
      }),
    );
  }

  const reworkFindings = findings.filter(
    ({ finding }) => finding.introducedIn !== "original_diff",
  );
  if (reworkFindings.length > 0) {
    entries.push(
      entryFor(context, {
        kind: "review_rework",
        timestamp: normalizeTimestamp(result.completedAt, result.startedAt),
        keyParts: [
          "rework",
          ...stableUnique(
            reworkFindings.map(({ finding }) => finding.introducedIn),
          ),
        ],
        summary: `Council review round ${context.round} captured ${reworkFindings.length} rework finding(s).`,
        metadata: {
          ...baseMetadata(context, "structured_v1"),
          ...terminationTelemetryMetadata(termination),
          rework_finding_count: reworkFindings.length,
          introduced_in: stableUnique(
            reworkFindings.map(({ finding }) => finding.introducedIn),
          ),
        },
      }),
    );
  }

  for (const lane of result.lanes) {
    const laneContractVersion =
      lane.structuredArtifact === undefined || lane.structuredArtifact === null
        ? "markdown_v0"
        : "structured_v1";
    entries.push(
      entryFor(context, {
        kind: "review_lane",
        timestamp: normalizeTimestamp(result.completedAt, result.startedAt),
        keyParts: ["lane", lane.laneId],
        summary: `Council review lane ${lane.laneId} ended ${lane.state}/${lane.verdict}.`,
        metadata: {
          ...baseMetadata(context, laneContractVersion),
          ...laneMetadata(lane),
        },
      }),
    );
  }

  for (const { lane, artifact, finding } of findings) {
    entries.push(
      entryFor(context, {
        kind: "review_finding",
        timestamp: normalizeTimestamp(result.completedAt, result.startedAt),
        keyParts: ["finding", lane.laneId, finding.fingerprint],
        summary: `Council review finding ${finding.fingerprint} recorded as ${finding.severity}/${finding.leadDisposition}.`,
        metadata: {
          ...baseMetadata(context, "structured_v1"),
          lane_id: lane.laneId,
          lane_agent: artifact.lane.agent,
          lane_role: artifact.lane.role,
          ...findingMetadata(finding),
        },
      }),
    );
  }

  for (const { lane, artifact } of authoritativeStructuredArtifacts) {
    for (const synthesis of artifact.familySyntheses) {
      entries.push(
        entryFor(context, {
          kind: "review_synthesis",
          timestamp: normalizeTimestamp(result.completedAt, result.startedAt),
          keyParts: ["synthesis", lane.laneId, synthesis.name],
          summary: `Council review synthesis ${safeLabel(synthesis.name)} recorded for ${context.issueIdentifier}.`,
          metadata: {
            ...baseMetadata(context, "structured_v1"),
            lane_id: lane.laneId,
            lane_agent: artifact.lane.agent,
            lane_role: artifact.lane.role,
            family: safeLabel(synthesis.name),
            finding_fingerprints: [...synthesis.findingFingerprints].sort(),
            fixed_symptom_count: synthesis.fixedSymptoms.length,
            remaining_symptom_count: synthesis.remainingSymptoms.length,
            narrowing_status:
              synthesis.remainingSymptoms.length === 0 ? "narrowed" : "open",
            narrowing_rationale: narrowingRationaleForSynthesis(
              result.targeted_convergence,
              synthesis,
            ),
            ...targetedConvergenceMetadataForSynthesis(
              result.targeted_convergence,
              synthesis,
            ),
          },
        }),
      );
    }
  }

  if (
    shouldEscalate(
      result,
      findings.map(({ finding }) => finding),
    )
  ) {
    const escalationReason = escalationReasonFor(
      result,
      findings.map(({ finding }) => finding),
    );
    entries.push(
      entryFor(context, {
        kind: "review_escalation",
        timestamp: normalizeTimestamp(result.completedAt, result.startedAt),
        keyParts: ["escalation", escalationReason],
        summary: `Council review escalation recorded for ${context.issueIdentifier}: ${escalationReason}.`,
        metadata: {
          ...baseMetadata(context, contractVersion),
          ...terminationMetadata(termination),
          escalation_reason: escalationReason,
          gate_verdict: result.verdict,
          blocking_finding_count: blockingFindingCount(
            findings.map(({ finding }) => finding),
          ),
          degraded_condition_count: result.degradedConditions.length,
          degraded_conditions: result.degradedConditions.map(safeLabel),
        },
      }),
    );
  }

  const reviewGateResultEntry = entryFor(context, {
    kind: "review_gate_result",
    timestamp: normalizeTimestamp(result.completedAt, result.startedAt),
    keyParts: ["gate", result.verdict],
    summary: `Council review gate ${result.verdict} for ${context.issueIdentifier}.`,
    metadata: {
      ...baseMetadata(context, contractVersion),
      ...terminationMetadata(termination),
      ...targetedConvergenceMetadata(result.targeted_convergence),
      gate_verdict: result.verdict,
      lane_count: result.lanes.length,
      finding_count: findings.length,
      blocking_finding_count: blockingFindingCount(
        findings.map(({ finding }) => finding),
      ),
      degraded_condition_count: result.degradedConditions.length,
    },
  });
  entries.push(reviewGateResultEntry);

  const mergeCandidateEntry = buildMergeCandidateEntryFromReviewGate({
    ...reviewGateResultEntry,
    sequence: 0,
  });
  if (mergeCandidateEntry !== null) {
    entries.push(mergeCandidateEntry);
  }

  return entries;
}

export async function appendReviewJournalEventsToDispatcherJournal(
  input: AppendReviewJournalEventsInput,
): Promise<AppendReviewJournalEventsResult> {
  return appendDispatcherRunJournalEntriesWithLock(
    input.workspaceRoot,
    buildReviewJournalEntries(input.result, input.options),
  );
}

function collectStructuredArtifacts(
  result: HeadlessCouncilGateResult,
): StructuredLaneArtifact[] {
  return result.lanes.flatMap((lane) =>
    lane.structuredArtifact === undefined || lane.structuredArtifact === null
      ? []
      : [{ lane, artifact: lane.structuredArtifact }],
  );
}

function collectMergeAuthoritativeStructuredArtifacts(
  result: HeadlessCouncilGateResult,
): StructuredLaneArtifact[] {
  return collectStructuredArtifacts(result).filter(
    ({ lane, artifact }) =>
      lane.mergeAuthoritative !== false &&
      artifact.lane.mergeAuthoritative !== false,
  );
}

function buildJournalContext(
  result: HeadlessCouncilGateResult,
  options: ReviewJournalEventOptions,
) {
  const issueId = options.issueId ?? result.issueId;
  const issueIdentifier = options.issueIdentifier ?? result.issueId;
  const source = options.source ?? "pipeline";
  const actor = options.actor ?? defaultActor(source, options.ownerId ?? null);
  return {
    issueId,
    issueIdentifier,
    ownerId: options.ownerId ?? null,
    stage: options.stage ?? "review",
    attempt: options.attempt ?? null,
    source,
    actor,
    round: result.review_metadata.round,
    routingMode:
      result.review_routing?.mode ??
      result.review_metadata.routing_mode ??
      result.review_metadata.mode,
    reviewRouting: result.review_routing,
    baseSha: result.review_metadata.base_sha,
    headSha: result.review_metadata.reviewed_head_sha,
    repo: result.pr.repo,
    prNumber: result.pr.number,
    baseRef: result.pr.baseRef,
    headRef: result.pr.headRef,
    reviewResultPath: result.artifactPaths.resultJson,
    bundleHash: result.review_bundle?.bundleHash ?? null,
    idempotencyKeyPrefix: options.idempotencyKeyPrefix ?? "review",
  };
}

function baseMetadata(
  context: ReturnType<typeof buildJournalContext>,
  contractVersion: ReviewJournalContractVersion,
): Record<string, unknown> {
  return compactMetadata({
    schema_version: REVIEW_JOURNAL_SCHEMA_VERSION,
    actor: context.actor,
    actor_kind: context.actor.kind,
    actor_id: context.actor.id,
    source: context.source,
    contract_version: contractVersion,
    repo: context.repo ?? undefined,
    pr_number: context.prNumber ?? undefined,
    base_ref: context.baseRef ?? undefined,
    head_ref: context.headRef ?? undefined,
    base_sha: context.baseSha ?? undefined,
    head_sha: context.headSha ?? undefined,
    reviewed_head_sha: context.headSha ?? undefined,
    review_result_path: context.reviewResultPath,
    bundle_hash: context.bundleHash ?? undefined,
    routing_mode: context.routingMode,
    round: context.round,
    selected_lanes: context.reviewRouting?.selectedLanes.map(
      (lane) => lane.laneId,
    ),
    skipped_lanes: context.reviewRouting?.skippedLanes.map(
      (lane) => `${lane.laneId}:${lane.reason}`,
    ),
    escalation_predicates: context.reviewRouting?.escalationPredicates,
    operator_override_reason:
      context.reviewRouting?.operatorOverrideReason ?? undefined,
    decorrelation_merge_eligible:
      context.reviewRouting?.decorrelationBasis.mergeEligible,
    decorrelation_summary:
      context.reviewRouting?.decorrelationBasis.summary ?? undefined,
    decorrelated_reviewer_lanes:
      context.reviewRouting?.decorrelationBasis.decorrelatedReviewerArtifacts.map(
        (artifact) => artifact.laneId,
      ),
    direct_signal_lanes:
      context.reviewRouting?.decorrelationBasis.directSignalLaneIds,
    author_families: context.reviewRouting?.decorrelationBasis.authorFamilies,
    high_risk_predicate_triggers:
      context.reviewRouting?.highRiskPredicate.triggerHits,
    high_risk_predicate_paths:
      context.reviewRouting?.highRiskPredicate.matchedPaths,
  });
}

function entryFor(
  context: ReturnType<typeof buildJournalContext>,
  input: {
    kind: DispatcherRunJournalEntry["kind"];
    timestamp: string;
    keyParts: readonly unknown[];
    summary: string;
    metadata: Record<string, unknown>;
  },
): ReviewJournalEntryDraft {
  return {
    idempotencyKey: [
      context.idempotencyKeyPrefix,
      context.issueId,
      context.issueIdentifier,
      `round-${context.round}`,
      context.bundleHash ?? context.headSha ?? input.timestamp,
      input.kind,
      ...input.keyParts,
    ]
      .map(keyPart)
      .join(":"),
    timestamp: input.timestamp,
    kind: input.kind,
    issueId: context.issueId,
    issueIdentifier: context.issueIdentifier,
    operation: "gate",
    stage: context.stage,
    attempt: context.attempt,
    ownerId: context.ownerId,
    lease: null,
    summary: input.summary,
    metadata: compactMetadata(input.metadata),
  };
}

function laneMetadata(lane: HeadlessLaneResult): Record<string, unknown> {
  const dynamicLane = lane as unknown as Record<string, unknown>;
  const tokenUsage = tokenUsageFrom(dynamicLane);
  return compactMetadata({
    lane_id: lane.laneId,
    lane_agent: lane.agent,
    lane_role: lane.role,
    lane_model: lane.model,
    lane_reasoning_effort: lane.reasoningEffort ?? undefined,
    lane_state: lane.state,
    lane_verdict: lane.verdict,
    independent_reviewer: lane.independentReviewer,
    degraded_reason: lane.degradedReason ?? undefined,
    artifact_path:
      lane.artifactPath === null ? undefined : safeLabel(lane.artifactPath),
    structured_artifact_path:
      lane.structuredArtifactPath === undefined ||
      lane.structuredArtifactPath === null
        ? undefined
        : safeLabel(lane.structuredArtifactPath),
    review_bundle_file_hash: lane.reviewBundle?.hash,
    review_bundle_hash: lane.reviewBundle?.bundleHash,
    parse_status: lane.structuredArtifact?.parseStatus,
    finding_count: lane.structuredArtifact?.findings.length,
    wall_time_ms: numberField(
      dynamicLane.wallTimeMs ?? dynamicLane.wall_time_ms,
    ),
    input_tokens: tokenUsage.input_tokens,
    output_tokens: tokenUsage.output_tokens,
    total_tokens: tokenUsage.total_tokens,
  });
}

function tokenUsageFrom(metadata: Record<string, unknown>): {
  input_tokens?: number;
  output_tokens?: number;
  total_tokens?: number;
} {
  const tokenUsage =
    recordField(metadata.tokenUsage) ?? recordField(metadata.token_usage);
  if (tokenUsage === undefined) {
    return {};
  }
  return compactMetadata({
    input_tokens: numberField(
      tokenUsage.inputTokens ?? tokenUsage.input_tokens,
    ),
    output_tokens: numberField(
      tokenUsage.outputTokens ?? tokenUsage.output_tokens,
    ),
    total_tokens: numberField(
      tokenUsage.totalTokens ?? tokenUsage.total_tokens,
    ),
  }) as {
    input_tokens?: number;
    output_tokens?: number;
    total_tokens?: number;
  };
}

function findingMetadata(
  finding: StructuredReviewFinding,
): Record<string, unknown> {
  return compactMetadata({
    finding_fingerprint: safeLabel(finding.fingerprint),
    finding_severity: finding.severity,
    emitted_severity: finding.emittedSeverity,
    finding_disposition: finding.leadDisposition,
    repeat_of:
      finding.repeatOf === null ? undefined : safeLabel(finding.repeatOf),
    introduced_in: finding.introducedIn,
    family:
      finding.family === null ? undefined : safeLabel(finding.family.name),
    category: safeLabel(finding.category),
    confidence: finding.confidence,
    related_paths: finding.relatedPaths.map(safeLabel),
    evidence_locations: finding.evidence.map((evidence) =>
      compactMetadata({
        path: safeLabel(evidence.path),
        line_start: evidence.lineStart ?? undefined,
        line_end: evidence.lineEnd ?? undefined,
        changed_path: evidence.changedPath,
      }),
    ),
  });
}

function isFixRound(result: HeadlessCouncilGateResult): boolean {
  return (
    result.review_metadata.round > 1 ||
    result.review_metadata.mode === "convergence" ||
    result.review_metadata.previous_reviewed_head_sha !== null
  );
}

function shouldEscalate(
  result: HeadlessCouncilGateResult,
  findings: readonly StructuredReviewFinding[],
): boolean {
  return (
    isEscalatingTermination(result.termination) ||
    result.verdict !== "pass" ||
    result.degradedConditions.length > 0 ||
    blockingFindingCount(findings) > 0
  );
}

function escalationReasonFor(
  result: HeadlessCouncilGateResult,
  findings: readonly StructuredReviewFinding[],
): string {
  if (isEscalatingTermination(result.termination)) {
    return result.termination.reason;
  }
  if (blockingFindingCount(findings) > 0) {
    return "blocking_findings";
  }
  if (result.degradedConditions.length > 0) {
    return "degraded_review_substrate";
  }
  return result.verdict === "error" ? "gate_error" : "gate_failed";
}

function isEscalatingTermination(
  termination: CouncilTerminationAssessment | undefined,
): termination is CouncilTerminationAssessment & {
  reason: "same_family_reopen" | "round_cap_hit";
} {
  return (
    termination?.reason === "same_family_reopen" ||
    termination?.reason === "round_cap_hit"
  );
}

function terminationTelemetryMetadata(
  termination: CouncilTerminationAssessment | null,
): Record<string, unknown> {
  if (termination === null) {
    return {};
  }
  return compactMetadata({
    rounds_per_cycle: termination.roundsPerCycle,
    round_warning_threshold: termination.thresholds.roundWarning,
    round_cap: termination.thresholds.roundCap,
    termination_alert_level: termination.alertLevel,
  });
}

function terminationMetadata(
  termination: CouncilTerminationAssessment | null,
): Record<string, unknown> {
  if (termination === null) {
    return {};
  }
  return compactMetadata({
    ...terminationTelemetryMetadata(termination),
    termination_status: termination.status,
    termination_reason: termination.reason,
    termination_action: termination.action,
    tripwire_family_count: termination.tripwireFamilyNames.length,
    synthesis_count: termination.familySynthesisCount,
    blocking_finding_count: termination.blockingFindingCount,
    non_blocking_finding_count: termination.nonBlockingFindingCount,
    track_finding_count: termination.trackFindingCount,
    // SYMPH-760: the Track-finding filing status rides into the durable journal
    // so the merge gate never silently treats trackFindingCount > 0 with
    // missing issue IDs as a clean closeout. `reason` is null when none/filed
    // and is dropped by compactMetadata.
    track_filing_status: termination.trackFiling.status,
    track_filing_filed_count: termination.trackFiling.filed,
    track_filing_reason: termination.trackFiling.reason ?? undefined,
  });
}

function targetedConvergenceMetadata(
  targetedConvergence: TargetedConvergenceHypothesis | null,
): Record<string, unknown> {
  if (targetedConvergence === null) {
    return {};
  }
  return compactMetadata({
    targeting_hypothesis_version: targetedConvergence.hypothesisVersion,
    targeting_trigger: targetedConvergence.trigger,
    targeting_family: safeLabel(targetedConvergence.family),
    targeting_invariant: safeLabel(targetedConvergence.namedInvariant),
    targeting_fix_delta_range:
      targetedConvergence.scope.fixDeltaRange ?? undefined,
    targeting_merge_base_sha:
      targetedConvergence.scope.mergeBaseSha ?? undefined,
    narrowing_rationale: targetedConvergence.narrowingRationale,
    fix_delta_path_count: targetedConvergence.scope.fixDeltaPaths.length,
    semantic_neighborhood_path_count:
      targetedConvergence.scope.semanticNeighborhoodPaths.length,
    producer_path_count: targetedConvergence.scope.producerPaths.length,
    consumer_path_count: targetedConvergence.scope.consumerPaths.length,
    skip_unchanged_remainder: targetedConvergence.scope.skipUnchangedRemainder,
  });
}

function targetedConvergenceMetadataForSynthesis(
  targetedConvergence: TargetedConvergenceHypothesis | null,
  synthesis: StructuredReviewFamilySynthesis,
): Record<string, unknown> {
  return targetedConvergenceAppliesToSynthesis(targetedConvergence, synthesis)
    ? targetedConvergenceMetadata(targetedConvergence)
    : {};
}

function narrowingRationaleForSynthesis(
  targetedConvergence: TargetedConvergenceHypothesis | null,
  synthesis: StructuredReviewFamilySynthesis,
): string {
  return targetedConvergenceAppliesToSynthesis(targetedConvergence, synthesis)
    ? targetedConvergence.narrowingRationale
    : narrowingRationale(synthesis);
}

function targetedConvergenceAppliesToSynthesis(
  targetedConvergence: TargetedConvergenceHypothesis | null,
  synthesis: StructuredReviewFamilySynthesis,
): targetedConvergence is TargetedConvergenceHypothesis {
  return (
    targetedConvergence !== null &&
    normalizeFamilyKey(targetedConvergence.family) ===
      normalizeFamilyKey(synthesis.name)
  );
}

function blockingFindingCount(
  findings: readonly StructuredReviewFinding[],
): number {
  return findings.filter(
    (finding) =>
      (finding.severity === "P1" || finding.severity === "P2") &&
      finding.leadDisposition === "open",
  ).length;
}

function narrowingRationale(
  synthesis: StructuredReviewFamilySynthesis,
): string {
  const fixed = synthesis.fixedSymptoms.length;
  const remaining = synthesis.remainingSymptoms.length;
  if (remaining === 0) {
    return `family narrowed: ${fixed} fixed symptom(s), 0 remaining`;
  }
  return `family retained: ${remaining} remaining symptom(s), ${fixed} fixed`;
}

function defaultActor(
  source: ReviewJournalSource,
  ownerId: string | null,
): ReviewJournalActor {
  if (source === "interactive") {
    return { kind: "interactive-agent", id: ownerId ?? "council-review-gate" };
  }
  if (source === "replay") {
    return { kind: "replay", id: ownerId ?? "council-review-gate" };
  }
  return { kind: "pipeline-worker", id: ownerId ?? "council-review-gate" };
}

function normalizeTimestamp(primary: string, fallback: string): string {
  return Number.isNaN(Date.parse(primary)) ? fallback : primary;
}

function stableUnique(values: readonly string[]): string[] {
  return [...new Set(values)].sort();
}

function normalizeFamilyKey(value: string): string {
  return value.trim().toLowerCase().replace(/\s+/g, " ");
}

function compactMetadata(
  metadata: Record<string, unknown>,
): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(metadata).filter(([, value]) => value !== undefined),
  );
}

function recordField(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function numberField(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value)
    ? value
    : undefined;
}

function keyPart(value: unknown): string {
  const raw = String(value ?? "none");
  const cleaned = raw.replace(/[^A-Za-z0-9._/-]+/g, "_");
  return cleaned.length > SAFE_LABEL_MAX_LENGTH
    ? cleaned.slice(0, SAFE_LABEL_MAX_LENGTH)
    : cleaned;
}

function safeLabel(value: string): string {
  const collapsed = value.replace(/\s+/g, " ").trim();
  return collapsed.length > SAFE_LABEL_MAX_LENGTH
    ? collapsed.slice(0, SAFE_LABEL_MAX_LENGTH)
    : collapsed;
}
