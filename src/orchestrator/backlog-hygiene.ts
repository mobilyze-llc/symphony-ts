import {
  BACKLOG_AUDIT_FINDING_TYPES,
  type BacklogAuditCullFinding,
  type BacklogAuditFinding,
  type BacklogAuditFindingType,
  type BacklogAuditReport,
  type RunBacklogAuditInput,
  runBacklogAudit,
} from "../audit/backlog-audit.js";
import type { ResolvedWorkflowConfig } from "../config/types.js";
import type {
  DispatcherRunJournalEntry,
  Issue,
  VerdictActor,
} from "../domain/model.js";
import {
  type CodeGroundingReport,
  type CodeGroundingTarget,
  type CodeGroundingVerificationStatus,
  type RunCodeGroundingInput,
  runManagedCodeGrounding,
} from "./code-grounding.js";

export const BACKLOG_HYGIENE_PROPOSAL_LABELS = {
  proposed: "hygiene:proposed",
  accepted: "hygiene:accepted",
  rejected: "hygiene:rejected",
} as const;

export const CONSERVATIVE_CULL_LABEL_PREFIXES = {
  killed: "killed:",
  downgraded: "downgraded:",
} as const;

export const QUEUE_TRIAGE_EVALUATION_DIMENSIONS = [
  "ordering",
  "obsolescence",
  "consolidation",
  "parallelization",
  "augmentation",
  "evidence_grounding",
  "review_round_lessons",
] as const;

export type QueueTriageEvaluationDimension =
  (typeof QUEUE_TRIAGE_EVALUATION_DIMENSIONS)[number];

export const QUEUE_TRIAGE_GOLDEN_CORPUS = [
  {
    id: "2026-06-13-queue-triage-wave",
    source:
      "https://linear.app/mobilyze-llc/document/2026-06-13-queue-triage-wave-execution-forward-triage-pov-10da9a6408b4",
    dimensions: QUEUE_TRIAGE_EVALUATION_DIMENSIONS,
  },
] as const;

export type BacklogHygieneModelTier =
  | "local_low_risk"
  | "frontier_high_judgment";

export interface QueueTriageEvaluationResult {
  corpusId: string;
  dimensionScores: Partial<Record<QueueTriageEvaluationDimension, number>>;
  threshold: number;
}

export interface BacklogHygieneModelTierDecision {
  tier: BacklogHygieneModelTier;
  reason: string;
  corpusId: string;
  failedDimensions: QueueTriageEvaluationDimension[];
}

export interface BacklogHygieneProposal {
  proposalId: string;
  findingId: string;
  findingType: BacklogAuditFindingType;
  issueIds: string[];
  issueIdentifiers: string[];
  summary: string;
  evidence: string;
  confidence: BacklogAuditFinding["confidence"];
  cull: BacklogAuditCullFinding | null;
  codeGroundingStatus: CodeGroundingVerificationStatus | null;
  codeGroundingEvidence: string | null;
  generatedAt: string;
  modelTier: BacklogHygieneModelTier;
}

export interface BacklogHygieneLaneResult {
  status: "completed" | "audit_failed" | "model_tier_blocked" | "disabled";
  report: BacklogAuditReport | null;
  proposals: BacklogHygieneProposal[];
  warnings: string[];
}

export interface BuildBacklogHygieneProposalsInput {
  report: BacklogAuditReport;
  candidateIssues: readonly Issue[];
  activeIssueIds?: Iterable<string>;
  openParkIssueIds?: Iterable<string>;
  findingTypes?: readonly BacklogAuditFindingType[];
  maxProposalsPerProductPerPoll: number;
  generatedAt?: string;
  modelTierDecision: BacklogHygieneModelTierDecision;
  codeGroundingReport?: CodeGroundingReport | null;
  proposalCandidates?: readonly BacklogHygieneProposalCandidate[];
}

export interface RunBacklogHygieneProposalLaneInput
  extends RunBacklogAuditInput {
  enabled: boolean;
  maxProposalsPerProductPerPoll: number;
  activeIssueIds?: Iterable<string>;
  openParkIssueIds?: Iterable<string>;
  evaluation: QueueTriageEvaluationResult;
  allowFrontierRecommendations?: boolean;
  codeGrounding?: Omit<RunCodeGroundingInput, "findings"> | null;
}

export interface BuildBacklogHygieneCodeGroundingInput {
  workflowConfig: Pick<ResolvedWorkflowConfig, "codeGrounding" | "workspace">;
  runId: string;
  target: CodeGroundingTarget;
  workspaceRoot?: string;
  commandRunner?: RunCodeGroundingInput["commandRunner"];
  afterDeterministicScan?: RunCodeGroundingInput["afterDeterministicScan"];
}

export type BacklogHygieneProposalDecision = "accepted" | "rejected";

export type ConservativeCullOperatorDecision = "none" | "agreed" | "disagreed";

export interface ConservativeCullApplicationPlan {
  proposalId: string;
  classification: BacklogAuditCullFinding["classification"] | null;
  requiresOperatorAgree: boolean;
  cancelIssue: boolean;
  markerLabels: string[];
  blockedBy: Array<{ issueIdentifier: string; rootIssueIdentifier: string }>;
}

const BACKLOG_HYGIENE_SCOPE_ID = "__backlog_hygiene__";
const BACKLOG_HYGIENE_SCOPE_IDENTIFIER = "__backlog_hygiene__";

interface BacklogHygieneProposalCandidate {
  finding: BacklogAuditFinding;
  issues: Issue[];
}

export function decideBacklogHygieneModelTier(
  evaluation: QueueTriageEvaluationResult,
): BacklogHygieneModelTierDecision {
  const corpus =
    QUEUE_TRIAGE_GOLDEN_CORPUS.find(
      (candidate) => candidate.id === evaluation.corpusId,
    ) ?? null;
  if (corpus === null) {
    return {
      tier: "frontier_high_judgment",
      reason:
        "Evaluation corpus is not in the queue-triage golden corpus registry; high-judgment recommendations require frontier review.",
      corpusId: evaluation.corpusId,
      failedDimensions: [...QUEUE_TRIAGE_EVALUATION_DIMENSIONS],
    };
  }

  const failedDimensions = corpus.dimensions.filter(
    (dimension) =>
      (evaluation.dimensionScores[dimension] ?? 0) < evaluation.threshold,
  );
  if (failedDimensions.length === 0) {
    return {
      tier: "local_low_risk",
      reason: `Local model cleared queue-triage golden corpus ${corpus.id} for low-risk proposal drafting.`,
      corpusId: evaluation.corpusId,
      failedDimensions,
    };
  }
  return {
    tier: "frontier_high_judgment",
    reason: `Local model did not clear queue-triage golden corpus ${corpus.id}; high-judgment recommendations require frontier review.`,
    corpusId: evaluation.corpusId,
    failedDimensions,
  };
}

export async function runBacklogHygieneProposalLane(
  input: RunBacklogHygieneProposalLaneInput,
): Promise<BacklogHygieneLaneResult> {
  if (!input.enabled) {
    return {
      status: "disabled",
      report: null,
      proposals: [],
      warnings: ["backlog hygiene proposal lane disabled"],
    };
  }

  const modelTierDecision = decideBacklogHygieneModelTier(input.evaluation);
  if (
    modelTierDecision.tier === "frontier_high_judgment" &&
    input.allowFrontierRecommendations !== true
  ) {
    return {
      status: "model_tier_blocked",
      report: null,
      proposals: [],
      warnings: [modelTierDecision.reason],
    };
  }

  let report: BacklogAuditReport;
  try {
    report = await runBacklogAudit(input);
  } catch (error) {
    return {
      status: "audit_failed",
      report: null,
      proposals: [],
      warnings: [
        `backlog audit failed before proposal emission: ${toErrorMessage(error)}`,
      ],
    };
  }

  const proposalInput: BuildBacklogHygieneProposalsInput = {
    report,
    candidateIssues: input.issues,
    maxProposalsPerProductPerPoll: input.maxProposalsPerProductPerPoll,
    modelTierDecision,
    ...(input.activeIssueIds === undefined
      ? {}
      : { activeIssueIds: input.activeIssueIds }),
    ...(input.openParkIssueIds === undefined
      ? {}
      : { openParkIssueIds: input.openParkIssueIds }),
    ...(input.findingTypes === undefined
      ? {}
      : { findingTypes: input.findingTypes }),
  };
  const proposalCandidates =
    selectBacklogHygieneProposalCandidates(proposalInput);
  const proposalFindings = proposalCandidates.map(
    (candidate) => candidate.finding,
  );
  const groundingResult = await runCodeGroundingForProposalLane(
    input,
    proposalFindings,
  );
  proposalInput.codeGroundingReport = groundingResult.report;
  proposalInput.proposalCandidates = proposalCandidates;

  return {
    status: "completed",
    report,
    proposals: buildBacklogHygieneProposals(proposalInput),
    warnings: groundingResult.warnings,
  };
}

export function buildBacklogHygieneCodeGroundingInput(
  input: BuildBacklogHygieneCodeGroundingInput,
): Omit<RunCodeGroundingInput, "findings"> | null {
  if (input.workflowConfig.codeGrounding?.enabled !== true) {
    return null;
  }
  return {
    workspaceRoot: input.workspaceRoot ?? input.workflowConfig.workspace.root,
    runId: input.runId,
    config: input.workflowConfig.codeGrounding,
    target: input.target,
    ...(input.commandRunner === undefined
      ? {}
      : { commandRunner: input.commandRunner }),
    ...(input.afterDeterministicScan === undefined
      ? {}
      : { afterDeterministicScan: input.afterDeterministicScan }),
  };
}

export function buildBacklogHygieneProposals(
  input: BuildBacklogHygieneProposalsInput,
): BacklogHygieneProposal[] {
  const generatedAt = input.generatedAt ?? input.report.generatedAt;
  const codeGroundingByFindingId = new Map(
    (input.codeGroundingReport?.entries ?? []).map((entry) => [
      entry.findingId,
      entry,
    ]),
  );

  const proposals: BacklogHygieneProposal[] = [];
  const proposalCandidates =
    input.proposalCandidates ?? selectBacklogHygieneProposalCandidates(input);
  for (const { finding, issues } of proposalCandidates) {
    const codeGrounding = codeGroundingByFindingId.get(finding.findingId);
    proposals.push({
      proposalId: `${input.report.generatedAt}:${finding.findingId}`,
      findingId: finding.findingId,
      findingType: finding.type,
      issueIds: issues.map((issue) => issue.id),
      issueIdentifiers: issues.map((issue) => issue.identifier),
      summary: finding.summary,
      evidence: finding.evidence,
      confidence: finding.confidence,
      cull: finding.cull ?? null,
      codeGroundingStatus: codeGrounding?.status ?? null,
      codeGroundingEvidence:
        codeGrounding === undefined
          ? null
          : summarizeCodeGroundingEvidence(codeGrounding),
      generatedAt,
      modelTier: input.modelTierDecision.tier,
    });
  }

  return proposals;
}

export function selectBacklogHygieneProposalFindings(
  input: Pick<
    BuildBacklogHygieneProposalsInput,
    | "report"
    | "candidateIssues"
    | "activeIssueIds"
    | "openParkIssueIds"
    | "findingTypes"
    | "maxProposalsPerProductPerPoll"
  >,
): BacklogAuditFinding[] {
  return selectBacklogHygieneProposalCandidates(input).map(
    (candidate) => candidate.finding,
  );
}

function selectBacklogHygieneProposalCandidates(
  input: Pick<
    BuildBacklogHygieneProposalsInput,
    | "report"
    | "candidateIssues"
    | "activeIssueIds"
    | "openParkIssueIds"
    | "findingTypes"
    | "maxProposalsPerProductPerPoll"
  >,
): BacklogHygieneProposalCandidate[] {
  if (!Number.isInteger(input.maxProposalsPerProductPerPoll)) {
    throw new Error("maxProposalsPerProductPerPoll must be an integer.");
  }
  if (input.maxProposalsPerProductPerPoll <= 0) {
    return [];
  }

  const allowedTypes = new Set(
    input.findingTypes ?? BACKLOG_AUDIT_FINDING_TYPES,
  );
  const issuesByIdentifier = new Map(
    input.candidateIssues.map((issue) => [issue.identifier, issue]),
  );
  const activeIssueIds = new Set(input.activeIssueIds ?? []);
  const openParkIssueIds = new Set(input.openParkIssueIds ?? []);
  const candidates: BacklogHygieneProposalCandidate[] = [];
  for (const finding of input.report.verdict.findings) {
    if (!allowedTypes.has(finding.type)) {
      continue;
    }
    const issues = finding.issueIdentifiers.flatMap((identifier) => {
      const issue = issuesByIdentifier.get(identifier);
      return issue === undefined ? [] : [issue];
    });
    if (issues.length === 0) {
      continue;
    }
    if (
      issues.some(
        (issue) =>
          activeIssueIds.has(issue.id) || openParkIssueIds.has(issue.id),
      )
    ) {
      continue;
    }
    candidates.push({ finding, issues });
    if (candidates.length >= input.maxProposalsPerProductPerPoll) {
      break;
    }
  }
  return candidates;
}

export function buildBacklogHygieneProposalJournalEntry(input: {
  proposal: BacklogHygieneProposal;
  actor: VerdictActor;
  ownerId: string | null;
  timestamp?: string;
}): Omit<DispatcherRunJournalEntry, "sequence"> {
  const timestamp = input.timestamp ?? input.proposal.generatedAt;
  return {
    idempotencyKey: `hygiene_proposal:${input.proposal.proposalId}`,
    timestamp,
    kind: "hygiene_proposal",
    issueId: input.proposal.issueIds[0] ?? BACKLOG_HYGIENE_SCOPE_ID,
    issueIdentifier:
      input.proposal.issueIdentifiers[0] ?? BACKLOG_HYGIENE_SCOPE_IDENTIFIER,
    operation: "dispatcher",
    stage: null,
    attempt: null,
    ownerId: input.ownerId,
    lease: null,
    summary: `Backlog hygiene proposal ${input.proposal.findingId}: ${input.proposal.summary}`,
    metadata: {
      schema_version: 1,
      status: "proposed",
      proposal_id: input.proposal.proposalId,
      finding_id: input.proposal.findingId,
      finding_type: input.proposal.findingType,
      issue_ids: input.proposal.issueIds,
      issue_identifiers: input.proposal.issueIdentifiers,
      confidence: input.proposal.confidence,
      evidence: input.proposal.evidence,
      code_grounding_status: input.proposal.codeGroundingStatus,
      code_grounding_evidence: input.proposal.codeGroundingEvidence,
      model_tier: input.proposal.modelTier,
      cull: input.proposal.cull,
      cull_marker_label: input.proposal.cull?.marker ?? null,
      label: BACKLOG_HYGIENE_PROPOSAL_LABELS.proposed,
      actor: actorMetadata(input.actor),
    },
  };
}

export function buildBacklogHygieneDecisionJournalEntry(input: {
  proposal: BacklogHygieneProposal;
  decision: BacklogHygieneProposalDecision;
  actor: VerdictActor;
  ownerId: string | null;
  reason: string;
  timestamp: string;
}): Omit<DispatcherRunJournalEntry, "sequence"> {
  const decisionLabel =
    input.decision === "accepted"
      ? BACKLOG_HYGIENE_PROPOSAL_LABELS.accepted
      : BACKLOG_HYGIENE_PROPOSAL_LABELS.rejected;
  const cullPlan = buildConservativeCullApplicationPlan({
    proposal: input.proposal,
    decision: input.decision === "accepted" ? "agreed" : "disagreed",
  });
  const labelTransitionAdd = [decisionLabel, ...cullPlan.markerLabels].filter(
    (label, index, labels) => labels.indexOf(label) === index,
  );
  return {
    idempotencyKey: `hygiene_proposal_decision:${input.proposal.proposalId}:${input.decision}:${input.actor.kind}@${input.actor.host}`,
    timestamp: input.timestamp,
    kind: "hygiene_proposal_decision",
    issueId: input.proposal.issueIds[0] ?? BACKLOG_HYGIENE_SCOPE_ID,
    issueIdentifier:
      input.proposal.issueIdentifiers[0] ?? BACKLOG_HYGIENE_SCOPE_IDENTIFIER,
    operation: "dispatcher",
    stage: null,
    attempt: null,
    ownerId: input.ownerId,
    lease: null,
    summary: `Backlog hygiene proposal ${input.proposal.findingId} ${input.decision}: ${input.reason}`,
    metadata: {
      schema_version: 1,
      status: "applied",
      proposal_id: input.proposal.proposalId,
      finding_id: input.proposal.findingId,
      finding_type: input.proposal.findingType,
      decision: input.decision,
      reason: input.reason,
      mutation_authority:
        input.proposal.cull?.classification === "kill"
          ? "operator_agree_required"
          : "calibration_label_only",
      issue_state_mutation: cullPlan.cancelIssue,
      cull: input.proposal.cull,
      cull_application: cullPlan,
      label_transition: {
        remove: [BACKLOG_HYGIENE_PROPOSAL_LABELS.proposed],
        add: labelTransitionAdd,
      },
      relation_transition:
        cullPlan.blockedBy.length === 0
          ? null
          : {
              add_blocked_by: cullPlan.blockedBy,
            },
      actor: actorMetadata(input.actor),
    },
  };
}

export function buildConservativeCullApplicationPlan(input: {
  proposal: BacklogHygieneProposal;
  decision: ConservativeCullOperatorDecision;
}): ConservativeCullApplicationPlan {
  const cull = input.proposal.cull;
  if (cull === null) {
    return {
      proposalId: input.proposal.proposalId,
      classification: null,
      requiresOperatorAgree: false,
      cancelIssue: false,
      markerLabels: [],
      blockedBy: [],
    };
  }
  const agreed = input.decision === "agreed";
  // Only kill/downgrade classifications emit a join-key marker (SYMPH-966 AC#4).
  // Gate on classification, not just the label prefix, so a keep/symptomatic
  // finding carrying a stray `killed:`/`downgraded:` marker (e.g. a
  // model-supplied marker) can never add a kill/downgrade label.
  const markerEligible =
    cull.classification === "kill" || cull.classification === "downgrade";
  const markerLabels =
    agreed && markerEligible && isCullMarkerLabel(cull.marker)
      ? [cull.marker]
      : [];
  const rootIssueIdentifier = cull.rootIssueIdentifier;
  // A kill may only cancel when it carries a valid stable-reason marker
  // (SYMPH-966 AC#4): a kill normalized to killReason:null has no marker and
  // must not cancel a ticket, or a reasonless kill could drop a real defect.
  const killWithValidMarker =
    cull.classification === "kill" && isCullMarkerLabel(cull.marker);
  return {
    proposalId: input.proposal.proposalId,
    classification: cull.classification,
    requiresOperatorAgree: killWithValidMarker,
    cancelIssue: killWithValidMarker && agreed,
    markerLabels,
    blockedBy:
      cull.classification === "symptomatic_of_root" &&
      agreed &&
      rootIssueIdentifier !== null
        ? input.proposal.issueIdentifiers.map((issueIdentifier) => ({
            issueIdentifier,
            rootIssueIdentifier,
          }))
        : [],
  };
}

function isCullMarkerLabel(value: string | null): value is string {
  return (
    value !== null &&
    (value.startsWith(CONSERVATIVE_CULL_LABEL_PREFIXES.killed) ||
      value.startsWith(CONSERVATIVE_CULL_LABEL_PREFIXES.downgraded))
  );
}

function actorMetadata(actor: VerdictActor): {
  kind: VerdictActor["kind"];
  host: string;
  session: string | null;
} {
  return {
    kind: actor.kind,
    host: actor.host,
    session: actor.session ?? null,
  };
}

function summarizeCodeGroundingEvidence(
  entry: CodeGroundingReport["entries"][number],
): string {
  const citations = entry.citations
    .slice(0, 5)
    .map(
      (citation) =>
        `${citation.path}:${citation.lineRange[0]}-${citation.lineRange[1]}#${citation.contentHash.slice(0, 12)}`,
    );
  const missing = entry.missing.slice(0, 5);
  return [
    entry.summary,
    citations.length === 0 ? null : `citations=${citations.join(", ")}`,
    missing.length === 0 ? null : `missing=${missing.join(", ")}`,
  ]
    .filter((part): part is string => part !== null)
    .join(" ");
}

async function runCodeGroundingForProposalLane(
  input: RunBacklogHygieneProposalLaneInput,
  findings: readonly BacklogAuditFinding[],
): Promise<{
  report: CodeGroundingReport | null;
  warnings: string[];
}> {
  if (input.codeGrounding === null || input.codeGrounding === undefined) {
    return { report: null, warnings: [] };
  }
  if (findings.length === 0) {
    return { report: null, warnings: [] };
  }
  try {
    const groundingReport = await runManagedCodeGrounding({
      ...input.codeGrounding,
      findings,
    });
    return {
      report: groundingReport,
      warnings: groundingReport.warnings,
    };
  } catch (error) {
    return {
      report: null,
      warnings: [
        `code grounding failed; proposals emitted without grounding metadata: ${toErrorMessage(error)}`,
      ],
    };
  }
}

function toErrorMessage(error: unknown, seen = new WeakSet<object>()): string {
  if (!(error instanceof Error)) {
    return String(error);
  }
  if (seen.has(error)) {
    return `${error.message}; cause: [circular cause]`;
  }
  seen.add(error);
  if (error.cause === undefined) {
    return error.message;
  }
  return `${error.message}; cause: ${toErrorMessage(error.cause, seen)}`;
}
