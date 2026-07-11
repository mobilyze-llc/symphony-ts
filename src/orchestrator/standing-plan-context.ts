import type {
  PlannerCandidate,
  PlannerCandidateGroundingEvidence,
  PlannerContext,
  PlannerInFlight,
  PlannerPrInfo,
  QueueHealth,
} from "../agent/triage-planner.js";
import type { Issue } from "../domain/model.js";
import type { PlanEnvelope } from "../domain/standing-plan.js";
import { extractGroundingPathHints } from "./code-grounding.js";
import {
  type ShadowPlannerAuditDisposition,
  buildShadowPlannerAuditDispositionIndex,
} from "./standing-plan-audit-dispositions.js";

export interface AssembleShadowPlannerContextInput {
  candidates: Issue[];
  advisoryInputCandidates?: Issue[];
  structuralAdvisoriesEnabled?: boolean;
  inFlight: PlannerInFlight[];
  envelope: PlanEnvelope;
  openPrs?: PlannerPrInfo[];
  recentlyMerged?: PlannerPrInfo[];
  auditDispositions?: readonly ShadowPlannerAuditDisposition[];
  triageHealthInput?: QueueHealth;
  groundingEvidenceByIssueId?:
    | ReadonlyMap<string, PlannerCandidateGroundingEvidence>
    | Readonly<Record<string, PlannerCandidateGroundingEvidence>>;
}

export function assembleShadowPlannerContext(
  input: AssembleShadowPlannerContextInput,
): PlannerContext {
  const inFlightIdentifiers = new Set(
    input.inFlight.map((entry) => entry.issueIdentifier),
  );
  const index = buildShadowPlannerAuditDispositionIndex(
    input.auditDispositions ?? [],
  );
  const toCandidate = (issue: Issue): PlannerCandidate => {
    const groundingEvidence = readGroundingEvidence(
      input.groundingEvidenceByIssueId,
      issue,
    );
    return {
      issueId: issue.id,
      issueIdentifier: issue.identifier,
      title: issue.title,
      priority: issue.priority,
      state: issue.state,
      blockedBy: issue.blockedBy
        .map((ref) => ref.identifier)
        .filter((identifier): identifier is string => identifier !== null),
      advisoryRelations: {
        relatesTo: issue.relatesTo?.flatMap(toRelationIdentifier) ?? [],
        duplicates: issue.duplicates?.flatMap(toRelationIdentifier) ?? [],
        duplicatedBy: issue.duplicatedBy?.flatMap(toRelationIdentifier) ?? [],
        supersedes: issue.supersedes?.flatMap(toRelationIdentifier) ?? [],
        supersededBy: issue.supersededBy?.flatMap(toRelationIdentifier) ?? [],
        relationsTruncated: issue.advisoryRelationsTruncated === true,
        parent: issue.parent?.identifier ?? null,
        children: issue.children?.flatMap(toRelationIdentifier) ?? [],
        childrenTruncated: issue.childrenTruncated === true,
      },
      description: issue.description,
      labels: issue.labels,
      ...(groundingEvidence === undefined ? {} : { groundingEvidence }),
      pathHints: extractGroundingPathHints(
        [issue.title, issue.description]
          .filter(
            (value): value is string =>
              typeof value === "string" && value.trim() !== "",
          )
          .join("\n"),
      ),
      ...(index.duplicateClustersByIdentifier.has(issue.identifier)
        ? {
            duplicateClusterIdentifiers:
              index.duplicateClustersByIdentifier.get(issue.identifier) ?? [],
          }
        : {}),
      ...(index.auditAnnotationsByIdentifier.has(issue.identifier)
        ? {
            auditAnnotations:
              index.auditAnnotationsByIdentifier.get(issue.identifier) ?? [],
          }
        : {}),
      ...(index.dispatchExclusionsByIdentifier.has(issue.identifier)
        ? {
            dispatchExclusionReasons:
              index.dispatchExclusionsByIdentifier.get(issue.identifier) ?? [],
          }
        : {}),
    };
  };
  return {
    backlog: input.candidates
      .filter((issue) => !inFlightIdentifiers.has(issue.identifier))
      .filter((issue) => !index.excludedIdentifiers.has(issue.identifier))
      .map(toCandidate),
    advisoryInput: (input.advisoryInputCandidates ?? [])
      .filter((issue) => !index.excludedIdentifiers.has(issue.identifier))
      .map(toCandidate),
    ...(input.structuralAdvisoriesEnabled === undefined
      ? {}
      : { structuralAdvisoriesEnabled: input.structuralAdvisoriesEnabled }),
    inFlight: input.inFlight,
    openPrs: input.openPrs ?? [],
    recentlyMerged: input.recentlyMerged ?? [],
    envelope: input.envelope,
    ...(input.triageHealthInput === undefined
      ? {}
      : { health: input.triageHealthInput }),
  };
}

function toRelationIdentifier(ref: { identifier: string | null }): string[] {
  return ref.identifier === null ? [] : [ref.identifier];
}

function readGroundingEvidence(
  evidence:
    | ReadonlyMap<string, PlannerCandidateGroundingEvidence>
    | Readonly<Record<string, PlannerCandidateGroundingEvidence>>
    | undefined,
  issue: Issue,
): PlannerCandidateGroundingEvidence | undefined {
  if (evidence === undefined) return undefined;
  if (typeof (evidence as { get?: unknown }).get === "function") {
    const mapped = evidence as ReadonlyMap<
      string,
      PlannerCandidateGroundingEvidence
    >;
    return mapped.get(issue.id) ?? mapped.get(issue.identifier);
  }
  const record = evidence as Readonly<
    Record<string, PlannerCandidateGroundingEvidence>
  >;
  return record[issue.id] ?? record[issue.identifier];
}
