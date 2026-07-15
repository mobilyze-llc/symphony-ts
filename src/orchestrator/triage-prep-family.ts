import type { Issue, IssueRelationRef } from "../domain/model.js";
import type {
  ExtractedTriageFinding,
  TriagePrepAnchorEvidence,
  TriagePrepEvidenceBatch,
  TriagePrepEvidenceSheet,
  TriagePrepRepositoryInspection,
} from "./triage-prep-types.js";

export function recurrenceFor(
  extraction: ExtractedTriageFinding,
  all: ReadonlyMap<string, ExtractedTriageFinding>,
): TriagePrepEvidenceSheet["recurrence"] {
  if (extraction.recurrenceMetadata !== null) {
    return {
      source: "mob_1227_metadata",
      exact: true,
      ...extraction.recurrenceMetadata,
      visibleRecurrenceCommentCount: extraction.recurrenceObservationCount,
      relatedIssueIdentifiers: extraction.relatedIssueIdentifiers,
    };
  }
  if (extraction.recurrenceIdentityKeys.length === 0) {
    return {
      source: "unavailable",
      exact: false,
      recurrenceCount: null,
      sessionCount: null,
      postDoneRecurrenceCount: null,
      doneTwinCount: null,
      visibleRecurrenceCommentCount: extraction.recurrenceObservationCount,
      relatedIssueIdentifiers: extraction.relatedIssueIdentifiers,
    };
  }
  const identities = new Set(extraction.recurrenceIdentityKeys);
  const matchingIssues = [...all.values()].filter(
    (candidate) =>
      candidate.issueId !== extraction.issueId &&
      candidate.recurrenceIdentityKeys.some((key) => identities.has(key)),
  );
  return {
    source:
      extraction.findingsIntakeV2 === null
        ? "legacy_best_effort"
        : "findings_intake_v2_best_effort",
    exact: false,
    recurrenceCount:
      matchingIssues.length + extraction.recurrenceObservationCount,
    sessionCount: null,
    postDoneRecurrenceCount: null,
    doneTwinCount: null,
    visibleRecurrenceCommentCount: extraction.recurrenceObservationCount,
    relatedIssueIdentifiers: extraction.relatedIssueIdentifiers,
  };
}

export function coverageChecks(input: {
  extraction: ExtractedTriageFinding;
  inspections: readonly TriagePrepRepositoryInspection[];
  ledger: { available: boolean; reason: string };
  recurrence: TriagePrepEvidenceSheet["recurrence"];
}): TriagePrepEvidenceSheet["coverage"]["checks"] {
  const successfulRepos = input.inspections.filter(
    (item) => item.error === null,
  ).length;
  return {
    anchorDrift:
      input.extraction.anchors.length === 0
        ? { status: "n/a", reason: "no extractable anchor" }
        : successfulRepos === 0
          ? { status: "n/a", reason: "no repository checkout succeeded" }
          : successfulRepos < input.inspections.length
            ? { status: "partial", reason: "some repository checkouts failed" }
            : { status: "ran", reason: "fresh origin/main inspected" },
    classEmission:
      input.extraction.failureClasses.length === 0
        ? { status: "n/a", reason: "no deterministic failure class extracted" }
        : successfulRepos === 0
          ? { status: "n/a", reason: "no repository checkout succeeded" }
          : {
              status:
                successfulRepos < input.inspections.length ? "partial" : "ran",
              reason: "production trees scanned; weak signal only",
            },
    adjudicationHistory:
      input.extraction.anchors.length === 0
        ? { status: "n/a", reason: "no fingerprint or anchor extracted" }
        : {
            status: input.ledger.available ? "ran" : "n/a",
            reason: input.ledger.reason,
          },
    recurrence:
      input.recurrence.source === "mob_1227_metadata"
        ? { status: "ran", reason: "exact MOB-1227 metadata" }
        : input.recurrence.source === "legacy_best_effort"
          ? {
              status: "partial",
              reason:
                "legacy fingerprint sibling count; session and Done-twin fields unavailable",
            }
          : input.recurrence.source === "findings_intake_v2_best_effort"
            ? {
                status: "partial",
                reason:
                  "findings-intake v2 fkey siblings, visible recurrence comments, and related twins surfaced best-effort; metadata has no exact numeric recurrence fields",
              }
            : {
                status: "n/a",
                reason: "no recurrence metadata or deterministic identity",
              },
    family: {
      status: "ran",
      reason:
        "parent, relations, same-class, and same-anchor candidates compared",
    },
  };
}

export function siblingsSharing(
  input: {
    issue: Issue;
    extraction: ExtractedTriageFinding;
    allIssues: readonly Issue[];
    extractionById: ReadonlyMap<string, ExtractedTriageFinding>;
  },
  kind: "class" | "anchor",
): string[] {
  const keys = new Set(
    kind === "class"
      ? input.extraction.failureClasses
      : input.extraction.anchors.map((anchor) => anchor.key),
  );
  return input.allIssues
    .flatMap((issue) => {
      if (issue.id === input.issue.id) return [];
      const extracted = input.extractionById.get(issue.id);
      if (extracted === undefined) return [];
      const candidateKeys =
        kind === "class"
          ? extracted.failureClasses
          : extracted.anchors.map((anchor) => anchor.key);
      return candidateKeys.some((key) => keys.has(key))
        ? [issue.identifier]
        : [];
    })
    .sort();
}

export function buildFamilySummaries(
  findings: readonly ExtractedTriageFinding[],
  issueIdentifierById: ReadonlyMap<string, string>,
  relevantIssueIdentifiers: ReadonlySet<string>,
  anchorEvidence: readonly TriagePrepAnchorEvidence[],
): TriagePrepEvidenceBatch["families"] {
  const groups = new Map<string, TriagePrepEvidenceBatch["families"][number]>();
  for (const finding of findings) {
    const issueIdentifier = issueIdentifierById.get(finding.issueId);
    if (issueIdentifier === undefined) continue;
    const keys =
      finding.failureClasses.length > 0
        ? finding.failureClasses.map((failureClass) => `class:${failureClass}`)
        : finding.anchors.map((anchor) => `anchor:${anchor.key}`);
    for (const key of keys) {
      const existing = groups.get(key) ?? {
        key,
        sharedFailureClasses: [],
        sharedAnchors: [],
        members: [],
        allAnchorsLive: null,
      };
      existing.members = [
        ...new Set([
          ...existing.members,
          issueIdentifier,
          ...finding.relatedIssueIdentifiers,
        ]),
      ].sort();
      existing.sharedFailureClasses = [
        ...new Set([
          ...existing.sharedFailureClasses,
          ...finding.failureClasses,
        ]),
      ];
      existing.sharedAnchors = [
        ...new Set([
          ...existing.sharedAnchors,
          ...finding.anchors.map((anchor) => anchor.key),
        ]),
      ];
      const liveByAnchor = existing.sharedAnchors.map((anchorKey) =>
        anchorEvidence
          .filter((anchor) => anchor.anchorKey === anchorKey)
          .some((anchor) => anchor.status !== "gone"),
      );
      existing.allAnchorsLive =
        liveByAnchor.length === 0 ? null : liveByAnchor.every(Boolean);
      groups.set(key, existing);
    }
  }
  return [...groups.values()].filter(
    (family) =>
      family.members.length > 1 &&
      family.members.some((member) => relevantIssueIdentifiers.has(member)),
  );
}

export function issueRelations(
  issue: Issue,
): TriagePrepEvidenceSheet["family"]["relations"] {
  const groups: Array<[string, readonly IssueRelationRef[] | undefined]> = [
    ["relates_to", issue.relatesTo],
    ["duplicates", issue.duplicates],
    ["duplicated_by", issue.duplicatedBy],
    ["supersedes", issue.supersedes],
    ["superseded_by", issue.supersededBy],
    ["child", issue.children],
  ];
  return groups.flatMap(([type, refs]) =>
    (refs ?? []).map((ref) => ({ type, ...relationSummary(ref) })),
  );
}

export function relationSummary(ref: IssueRelationRef) {
  return {
    identifier: ref.identifier,
    title: ref.title,
    state: ref.state,
  };
}
