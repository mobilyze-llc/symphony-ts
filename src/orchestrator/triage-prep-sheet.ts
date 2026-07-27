import type { Issue } from "../domain/model.js";
import {
  coverageChecks,
  issueRelations,
  recurrenceFor,
  relationSummary,
  siblingsSharing,
} from "./triage-prep-family.js";
import type {
  ExtractedTriageFinding,
  TriagePrepEvidenceSheet,
  TriagePrepLedgerRow,
  TriagePrepRepositoryInspection,
} from "./triage-prep-types.js";

export function buildTriagePrepSheet(input: {
  issue: Issue;
  extraction: ExtractedTriageFinding;
  allIssues: readonly Issue[];
  extractionById: ReadonlyMap<string, ExtractedTriageFinding>;
  inspections: readonly TriagePrepRepositoryInspection[];
  ledger: {
    rows: TriagePrepLedgerRow[];
    available: boolean;
    reason: string;
  };
}): TriagePrepEvidenceSheet {
  const anchorKeys = new Set(input.extraction.anchors.map((item) => item.key));
  const anchorDrift = input.inspections.flatMap((inspection) =>
    inspection.anchors.filter((anchor) => anchorKeys.has(anchor.anchorKey)),
  );
  const classEmission = input.extraction.failureClasses.map((failureClass) => {
    const evidence = input.inspections.flatMap((inspection) =>
      inspection.classEmissions.filter(
        (item) => item.failureClass === failureClass,
      ),
    );
    const sites = evidence.flatMap((item) =>
      item.sites.map((site) => ({ repository: item.repository, ...site })),
    );
    return {
      failureClass,
      emittedInProduction:
        evidence.length === 0
          ? null
          : evidence.some((item) => item.emittedInProduction),
      emittedAtCitedSite:
        evidence.length === 0
          ? null
          : sites.some((site) =>
              input.extraction.anchors.some(
                (anchor) =>
                  anchor.path === site.path &&
                  (anchor.lineRange === null ||
                    (site.line >= anchor.lineRange[0] &&
                      site.line <= anchor.lineRange[1])),
              ),
            ),
      sites,
    };
  });
  const ledgerRows = input.ledger.rows.filter(
    (row) =>
      input.extraction.councilFingerprints.includes(row.fingerprint) ||
      input.extraction.anchors.some((anchor) =>
        ledgerLocationOverlapsAnchor(row.location, anchor),
      ),
  );
  const sameClass = siblingsSharing(input, "class");
  const sameAnchor = siblingsSharing(input, "anchor");
  const recurrence = recurrenceFor(input.extraction, input.extractionById);
  const checks = coverageChecks({
    extraction: input.extraction,
    inspections: input.inspections,
    ledger: input.ledger,
    recurrence,
  });
  return {
    issueIdentifier: input.issue.identifier,
    title: input.issue.title,
    filedAt: input.issue.createdAt,
    extraction: input.extraction,
    anchorDrift,
    classEmission: {
      strength: "weak_signal",
      note: "Emission is not defect liveness, and absence is not proof of a fix.",
      classes: classEmission,
    },
    adjudicationHistory: {
      confirmed: countVerdict(ledgerRows, "confirmed"),
      downgraded: countVerdict(ledgerRows, "downgraded"),
      refuted: countVerdict(ledgerRows, "refuted"),
      unknown: countVerdict(ledgerRows, "unknown"),
      rounds: [
        ...new Set(
          ledgerRows.flatMap((row) => (row.round === null ? [] : [row.round])),
        ),
      ],
    },
    recurrence,
    family: {
      parent: input.issue.parent ? relationSummary(input.issue.parent) : null,
      relations: issueRelations(input.issue),
      sameClassOpenSiblings: sameClass,
      sameAnchorOpenSiblings: sameAnchor,
      members: [
        ...new Set([
          input.issue.identifier,
          ...sameClass,
          ...sameAnchor,
          ...input.extraction.relatedIssueIdentifiers,
        ]),
      ].sort(),
    },
    coverage: {
      level: Object.values(checks).some((check) => check.status !== "ran")
        ? "partial"
        : "full",
      line: Object.entries(checks)
        .map(([key, value]) => `${key}=${value.status} (${value.reason})`)
        .join("; "),
      checks,
    },
  };
}

function ledgerLocationOverlapsAnchor(
  location: TriagePrepLedgerRow["location"],
  anchor: ExtractedTriageFinding["anchors"][number],
): boolean {
  if (
    location === null ||
    location.path !== anchor.path ||
    location.lineRange === null ||
    anchor.lineRange === null
  ) {
    return false;
  }
  return (
    location.lineRange[0] <= anchor.lineRange[1] &&
    anchor.lineRange[0] <= location.lineRange[1]
  );
}

function countVerdict(
  rows: TriagePrepLedgerRow[],
  verdict: TriagePrepLedgerRow["verdict"],
): number {
  return rows.filter((row) => row.verdict === verdict).length;
}
