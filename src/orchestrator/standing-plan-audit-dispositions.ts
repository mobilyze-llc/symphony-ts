import type { PlannerCandidateAuditAnnotation } from "../agent/planner-candidate-audit.js";
import type { Issue } from "../domain/model.js";
import type { BacklogHygieneProposal } from "./backlog-hygiene.js";

type ShadowPlannerAuditDispositionType =
  | "kill"
  | "advisory"
  | "stale"
  | "duplicate"
  | "supersession";

export interface ShadowPlannerAuditDisposition {
  type: ShadowPlannerAuditDispositionType;
  issueIdentifiers: readonly string[];
  classification?: PlannerCandidateAuditAnnotation["classification"];
  rootIssueIdentifier?: string | null;
}

export interface ShadowPlannerAuditDispositionIndex {
  excludedIdentifiers: Set<string>;
  duplicateClustersByIdentifier: Map<string, string[]>;
  auditAnnotationsByIdentifier: Map<string, PlannerCandidateAuditAnnotation[]>;
  dispatchExclusionsByIdentifier: Map<string, string[]>;
}

export function buildShadowPlannerAuditDispositions(
  proposals: readonly BacklogHygieneProposal[],
): ShadowPlannerAuditDisposition[] {
  const dispositions: ShadowPlannerAuditDisposition[] = [];
  for (const proposal of proposals) {
    const issueIdentifiers = uniqueNonBlankIdentifiers(
      proposal.issueIdentifiers,
    );
    if (issueIdentifiers.length === 0) continue;
    if (proposal.cull?.classification === "kill") {
      dispositions.push({
        type: "kill",
        issueIdentifiers,
        classification: proposal.cull.classification,
        rootIssueIdentifier: proposal.cull.rootIssueIdentifier,
      });
    } else if (proposal.findingType === "stale") {
      dispositions.push({ type: "stale", issueIdentifiers });
    } else if (proposal.findingType === "supersession") {
      dispositions.push({ type: "supersession", issueIdentifiers });
    } else if (proposal.findingType === "duplicate") {
      dispositions.push({ type: "duplicate", issueIdentifiers });
    } else if (proposal.cull !== null) {
      dispositions.push({
        type: "advisory",
        issueIdentifiers,
        classification: proposal.cull.classification,
        rootIssueIdentifier: proposal.cull.rootIssueIdentifier,
      });
    }
  }
  return dispositions;
}

export function buildShadowPlannerSupersessionRelationDispositions(
  issues: readonly Issue[],
): ShadowPlannerAuditDisposition[] {
  return issues
    .filter((issue) =>
      (issue.supersededBy ?? []).some((ref) =>
        isCompletedSupersedingIssueState(ref.state),
      ),
    )
    .map((issue) => ({
      type: "supersession" as const,
      issueIdentifiers: [issue.identifier],
    }));
}

export function buildShadowPlannerAuditDispositionIndex(
  dispositions: readonly ShadowPlannerAuditDisposition[],
): ShadowPlannerAuditDispositionIndex {
  const index: ShadowPlannerAuditDispositionIndex = {
    excludedIdentifiers: new Set<string>(),
    duplicateClustersByIdentifier: new Map<string, string[]>(),
    auditAnnotationsByIdentifier: new Map<
      string,
      PlannerCandidateAuditAnnotation[]
    >(),
    dispatchExclusionsByIdentifier: new Map<string, string[]>(),
  };
  for (const disposition of dispositions) {
    const identifiers = uniqueNonBlankIdentifiers(disposition.issueIdentifiers);
    if (identifiers.length === 0) continue;
    if (disposition.type === "stale" || disposition.type === "supersession") {
      for (const identifier of identifiers) {
        index.excludedIdentifiers.add(identifier);
      }
    } else if (disposition.type === "kill" || disposition.type === "advisory") {
      addAuditAnnotations(index, disposition, identifiers);
    } else {
      for (const identifier of identifiers) {
        const existing =
          index.duplicateClustersByIdentifier.get(identifier) ?? [];
        index.duplicateClustersByIdentifier.set(
          identifier,
          uniqueNonBlankIdentifiers([...existing, ...identifiers]),
        );
      }
    }
  }
  return index;
}

function addAuditAnnotations(
  index: ShadowPlannerAuditDispositionIndex,
  disposition: ShadowPlannerAuditDisposition,
  identifiers: readonly string[],
): void {
  for (const identifier of identifiers) {
    if (disposition.classification !== undefined) {
      const existing = index.auditAnnotationsByIdentifier.get(identifier) ?? [];
      index.auditAnnotationsByIdentifier.set(identifier, [
        ...existing,
        {
          classification: disposition.classification,
          rootIssueIdentifier: disposition.rootIssueIdentifier ?? null,
        },
      ]);
    }
    if (disposition.type === "kill") {
      index.dispatchExclusionsByIdentifier.set(identifier, ["audit:kill"]);
    }
  }
}

function isCompletedSupersedingIssueState(state: string | null): boolean {
  const normalized = state?.trim().toLowerCase();
  return (
    normalized === "done" ||
    normalized === "complete" ||
    normalized === "completed" ||
    normalized === "closed" ||
    normalized === "merged" ||
    normalized === "released" ||
    normalized === "shipped"
  );
}

function uniqueNonBlankIdentifiers(identifiers: readonly string[]): string[] {
  return [
    ...new Set(identifiers.map((identifier) => identifier.trim())),
  ].filter((identifier) => identifier !== "");
}
