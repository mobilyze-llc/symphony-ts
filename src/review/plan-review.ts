import { createHash } from "node:crypto";

import type {
  PlannerCandidate,
  PlannerContext,
} from "../agent/triage-planner.js";
import { renderCandidateGroundingEvidence } from "../agent/triage-planner.js";
import {
  type PlanReviewFinding,
  type PlanReviewRecord,
  computePlanContentHash,
} from "../domain/standing-plan.js";
import { decidePlanReviewGate } from "../orchestrator/plan-review-gate.js";
import type { PlanBody } from "../orchestrator/standing-plan-supersession.js";
import type {
  StructuredReviewFinding,
  StructuredReviewFindingSeverity,
} from "./headless-council-gate.js";
import {
  type PlanReviewLaneRunner,
  runPlanReviewLanes,
} from "./plan-review-lanes.js";
import { CrabboxSpineClient } from "./spine/crabbox-spine-client.js";
import {
  type AggregatedReview,
  ReviewAggregator,
} from "./spine/review-aggregator.js";
import type { TriageFinding } from "./spine/schemas.js";

export interface RunPlanTier2ReviewInput {
  context: PlannerContext;
  body: PlanBody;
  planId: string;
  artifactDir: string;
  workspace: string;
  plannerGroundingEnabled: boolean;
  lastReviewedContentHash?: string | null;
  env?: NodeJS.ProcessEnv;
}

export interface PlanTier2ReviewResult {
  findings: PlanReviewFinding[];
  structuredFindings: StructuredReviewFinding[];
  record: PlanReviewRecord;
}

export interface PlanTier2ReviewDependencies {
  runLane?: PlanReviewLaneRunner;
  aggregator?: ReviewAggregator;
}

export function appendPlanReviewCoverageGapEntry(
  record: PlanReviewRecord,
  entry: Omit<PlanReviewRecord["postHocEntries"][number], "kind">,
): PlanReviewRecord {
  return {
    ...record,
    postHocEntries: [
      ...record.postHocEntries,
      {
        kind: "coverage_gap",
        ...entry,
      },
    ],
  };
}

export async function runPlanTier2Review(
  input: RunPlanTier2ReviewInput,
  dependencies: PlanTier2ReviewDependencies = {},
): Promise<PlanTier2ReviewResult> {
  const diffHash = computePlanContentHash({
    planId: input.planId,
    batches: input.body.batches,
    dependencyEdges: input.body.dependencyEdges,
    options: input.body.options,
    envelope: input.body.envelope,
    rationale: input.body.rationale,
    source: input.body.source,
  });
  const gate = decidePlanReviewGate({
    currentContentHash: diffHash,
    lastReviewedContentHash: input.lastReviewedContentHash ?? null,
  });
  const coverage = collectGroundingCoverage(input.context, input.body);
  if (gate.action === "skip") {
    return emptyResult({
      status: "skipped",
      diffHash,
      gateReason: gate.reason,
      aggregateVerdict: null,
      note: "plan content hash already reviewed",
      coverage,
    });
  }
  if (
    !input.plannerGroundingEnabled ||
    !hasGroundedScheduledEvidence(coverage)
  ) {
    return emptyResult({
      status: "skipped",
      diffHash,
      gateReason: gate.reason,
      aggregateVerdict: null,
      note: "no grounded evidence",
      coverage,
    });
  }

  try {
    const laneDependencies =
      dependencies.runLane === undefined
        ? {}
        : { runLane: dependencies.runLane };
    const laneResult = await runPlanReviewLanes(
      {
        context: input.context,
        body: input.body,
        artifactDir: input.artifactDir,
        workspace: input.workspace,
        ...(input.env === undefined ? {} : { env: input.env }),
      },
      laneDependencies,
    );
    const aggregator =
      dependencies.aggregator ?? new ReviewAggregator(new CrabboxSpineClient());
    const aggregate = await aggregator.aggregate({
      laneArtifacts: laneResult.artifacts,
      currentDiffHash: diffHash,
    });
    const structuredFindings = adaptAggregateFindings(aggregate);
    const findings = structuredFindings.map(planFindingFromStructured);
    return {
      findings,
      structuredFindings,
      record: {
        tier: "tier-2",
        status: "reviewed",
        diffHash,
        gateReason: gate.reason,
        aggregateVerdict: aggregate.verdict,
        note: null,
        reviewedGroundingEvidence: coverage,
        findingFingerprints: structuredFindings.map(
          (finding) => finding.fingerprint,
        ),
        postHocEntries: [],
      },
    };
  } catch (error) {
    return emptyResult({
      status: "degraded",
      diffHash,
      gateReason: gate.reason,
      aggregateVerdict: "degraded",
      note: `tier-2 review degraded: ${errorMessage(error)}`,
      coverage,
    });
  }
}

function emptyResult(input: {
  status: PlanReviewRecord["status"];
  diffHash: string;
  gateReason: PlanReviewRecord["gateReason"];
  aggregateVerdict: PlanReviewRecord["aggregateVerdict"];
  note: string;
  coverage: PlanReviewRecord["reviewedGroundingEvidence"];
}): PlanTier2ReviewResult {
  return {
    findings: [],
    structuredFindings: [],
    record: {
      tier: "tier-2",
      status: input.status,
      diffHash: input.diffHash,
      gateReason: input.gateReason,
      aggregateVerdict: input.aggregateVerdict,
      note: input.note,
      reviewedGroundingEvidence: input.coverage,
      findingFingerprints: [],
      postHocEntries: [],
    },
  };
}

function collectGroundingCoverage(
  context: PlannerContext,
  body: PlanBody,
): PlanReviewRecord["reviewedGroundingEvidence"] {
  const scheduled = new Set(
    body.batches.flatMap((batch) =>
      batch.members.map((member) => member.issueIdentifier),
    ),
  );
  return context.backlog
    .filter((candidate) => scheduled.has(candidate.issueIdentifier))
    .map((candidate) => coverageForCandidate(candidate));
}

function coverageForCandidate(
  candidate: PlannerCandidate,
): PlanReviewRecord["reviewedGroundingEvidence"][number] {
  const rendered = renderCandidateGroundingEvidence(
    candidate.groundingEvidence,
  ).join("\n");
  return {
    issueId: candidate.issueId,
    issueIdentifier: candidate.issueIdentifier,
    status: candidate.groundingEvidence?.status ?? "ungrounded",
    renderedHash: createHash("sha256").update(rendered, "utf8").digest("hex"),
    renderedChars: rendered.length,
    claimIds:
      candidate.groundingEvidence?.claims.map((claim) => claim.id) ?? [],
    unitIds:
      candidate.groundingEvidence?.units.map((unit) => unit.unitId) ?? [],
    warnings: [...(candidate.groundingEvidence?.warnings ?? [])],
  };
}

function hasGroundedScheduledEvidence(
  coverage: PlanReviewRecord["reviewedGroundingEvidence"],
): boolean {
  return coverage.some((item) => item.status === "grounded");
}

function adaptAggregateFindings(
  aggregate: AggregatedReview,
): StructuredReviewFinding[] {
  return [...aggregate.blockingFindings, ...aggregate.trackFindings].map(
    structuredFindingFromTriage,
  );
}

function structuredFindingFromTriage(
  finding: TriageFinding,
): StructuredReviewFinding {
  const severity = normalizeSeverity(finding.severity);
  const planPath = normalizePlanPath(finding.location);
  return {
    fingerprint: finding.fp,
    severity,
    emittedSeverity: severity,
    title: finding.summary,
    titleStem: titleStem(finding.summary),
    category: "tier-2-plan-review",
    confidence: 1,
    evidence: [
      {
        path: planPath,
        lineStart: null,
        lineEnd: null,
        changedPath: true,
      },
    ],
    relatedPaths: [planPath],
    rationale: finding.evidence || finding.failure || finding.summary,
    leadDisposition: severity === "Track" ? "track" : "open",
    repeatOf: null,
    introducedIn: "original_diff",
    dismissalReason: null,
    family:
      finding.family === undefined
        ? null
        : {
            name: finding.family,
            safetyClaim: finding.safety_claim ?? null,
            nextRoundQuestion: finding.next_round_question ?? null,
            fixedSymptoms: finding.fixed_symptoms ?? [],
            remainingSymptoms: finding.remaining_symptoms ?? [],
          },
  };
}

function planFindingFromStructured(
  finding: StructuredReviewFinding,
): PlanReviewFinding {
  return {
    title: finding.title,
    planAnchor: finding.evidence[0]?.path ?? "plan:review/tier-2",
    severity: finding.severity,
    source: "tier-2",
    tags: ["misinterpretation"],
    structuredFingerprint: finding.fingerprint,
  };
}

function normalizeSeverity(value: string): StructuredReviewFindingSeverity {
  return value === "P1" || value === "P2" ? value : "Track";
}

function normalizePlanPath(location: string): string {
  const trimmed = location.trim();
  if (trimmed.startsWith("plan:")) {
    return trimmed.replace(/:\d+(?::\d+)?$/, "");
  }
  const identifier = trimmed.match(/[A-Z]+-\d+/)?.[0];
  if (identifier !== undefined) {
    return `plan:issue/${identifier}`;
  }
  return "plan:review/tier-2";
}

function titleStem(title: string): string {
  return title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .replace(/\s+/g, " ");
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
