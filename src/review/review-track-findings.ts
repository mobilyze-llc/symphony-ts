import { CODEX_LEAD_LANE_ID } from "./review-lanes.js";
import type { ReviewGateVerdict } from "./review-verdict.js";

export interface ReviewTrackFinding {
  fingerprint: string;
  severity: string;
  title: string;
  leadDisposition: string;
}

export interface ReviewTrackArtifact<Finding extends ReviewTrackFinding> {
  findings: readonly Finding[];
}

export interface ReviewTrackLane<
  Finding extends ReviewTrackFinding,
  Artifact extends ReviewTrackArtifact<Finding> = ReviewTrackArtifact<Finding>,
> {
  laneId: string;
  mergeAuthoritative?: boolean;
  structuredArtifact?: Artifact | null;
}

export interface ReviewTrackFindingFilingEntry {
  fingerprint: string;
  title: string;
  issueId: string | null;
  url: string | null;
}

export interface ReviewTrackFindingFiling {
  status: "none" | "filed" | "unfiled";
  required: number;
  filed: number;
  reason: "track_findings_unfiled" | "track_findings_partially_filed" | null;
  findings: ReviewTrackFindingFilingEntry[];
}

export type ReviewTrackFindingFiler<Finding extends ReviewTrackFinding> = (
  findings: readonly Finding[],
) => Promise<
  ReadonlyArray<{ fingerprint: string; issueId: string; url?: string | null }>
>;

/**
 * Build the Track-filing record for the council's Track findings from the
 * durable Linear refs the caller resolved for them, keyed by fingerprint
 * (SYMPH-760). Findings absent from the map are reported `unfiled`.
 */
export function computeTrackFiling<Finding extends ReviewTrackFinding>(
  trackFindings: readonly Finding[],
  resolved: ReadonlyMap<string, { issueId: string; url: string | null }>,
): ReviewTrackFindingFiling {
  const required = trackFindings.length;
  if (required === 0) {
    return {
      status: "none",
      required: 0,
      filed: 0,
      reason: null,
      findings: [],
    };
  }
  const findings: ReviewTrackFindingFilingEntry[] = trackFindings.map(
    (finding) => {
      const ref = resolved.get(finding.fingerprint) ?? null;
      return {
        fingerprint: finding.fingerprint,
        title: finding.title,
        issueId: ref?.issueId ?? null,
        url: ref?.url ?? null,
      };
    },
  );
  const filed = findings.filter((entry) => entry.issueId !== null).length;
  if (filed === required) {
    return { status: "filed", required, filed, reason: null, findings };
  }
  return {
    status: "unfiled",
    required,
    filed,
    reason:
      filed === 0 ? "track_findings_unfiled" : "track_findings_partially_filed",
    findings,
  };
}

/**
 * Authoritative termination artifacts for a verdict + lane set: merge the
 * authoritative lanes, then select the current-round artifacts. This is the
 * single source of truth for both termination assessment and Track-finding
 * filing so they cannot derive divergent finding sets.
 */
export function authoritativeTerminationArtifacts<
  Finding extends ReviewTrackFinding,
  Artifact extends ReviewTrackArtifact<Finding>,
>(input: {
  verdict: ReviewGateVerdict;
  lanes: readonly ReviewTrackLane<Finding, Artifact>[];
}): Artifact[] {
  return currentTerminationArtifacts({
    verdict: input.verdict,
    lanes: mergeAuthoritativeTrackLanes(input.lanes),
  });
}

/**
 * The council's surviving Track findings (SYMPH-760), derived through the same
 * authoritative-termination path as the termination assessment's track count.
 */
export function collectTrackFindings<
  Finding extends ReviewTrackFinding,
>(input: {
  verdict: ReviewGateVerdict;
  lanes: readonly ReviewTrackLane<Finding>[];
}): Finding[] {
  return authoritativeTerminationArtifacts(input)
    .flatMap((artifact) => artifact.findings)
    .filter(isTrackDisposition);
}

/**
 * Invoke an optional Track-finding filer and reduce its durable refs into a
 * fingerprint -> ref map for termination assessment (SYMPH-760). Filing is
 * best-effort: a missing filer, a throw, or a finding with no returned ref all
 * leave the finding `unfiled` with an explicit status.
 */
export async function resolveTrackFindingFilings<
  Finding extends ReviewTrackFinding,
>(
  trackFindings: readonly Finding[],
  filer: ReviewTrackFindingFiler<Finding> | undefined,
): Promise<Map<string, { issueId: string; url: string | null }>> {
  const resolved = new Map<string, { issueId: string; url: string | null }>();
  if (filer === undefined || trackFindings.length === 0) {
    return resolved;
  }
  let refs: ReadonlyArray<{
    fingerprint: string;
    issueId: string;
    url?: string | null;
  }>;
  try {
    refs = await filer(trackFindings);
  } catch (error) {
    // Fail closed (findings stay unfiled), but surface WHY so an operator can
    // tell a thrown filer from no filer being configured (council R1 P2).
    console.warn(
      `[council] track-finding filer threw; ${trackFindings.length} finding(s) remain unfiled: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
    return resolved;
  }
  // The filer is external: narrow each ref as `unknown` so a malformed element
  // leaves its finding unfiled rather than throwing and aborting the gate.
  for (const ref of refs as readonly unknown[]) {
    const record =
      typeof ref === "object" && ref !== null
        ? (ref as { fingerprint?: unknown; issueId?: unknown; url?: unknown })
        : null;
    if (
      record !== null &&
      typeof record.fingerprint === "string" &&
      typeof record.issueId === "string" &&
      record.issueId.length > 0
    ) {
      resolved.set(record.fingerprint, {
        issueId: record.issueId,
        url: typeof record.url === "string" ? record.url : null,
      });
    } else {
      console.warn(
        "[council] track-finding filer returned an invalid ref; finding remains unfiled",
      );
    }
  }
  return resolved;
}

export function isOpenBlockingFinding(finding: {
  severity: string;
  leadDisposition: string;
}): boolean {
  return (
    (finding.severity === "P1" || finding.severity === "P2") &&
    finding.leadDisposition === "open"
  );
}

export function isTrackDisposition<Finding extends ReviewTrackFinding>(
  finding: Finding,
): boolean {
  return finding.severity === "Track" || finding.leadDisposition === "track";
}

function currentTerminationArtifacts<
  Finding extends ReviewTrackFinding,
  Artifact extends ReviewTrackArtifact<Finding>,
>(input: {
  verdict: ReviewGateVerdict;
  lanes: readonly ReviewTrackLane<Finding, Artifact>[];
}): Artifact[] {
  const allArtifacts = input.lanes.flatMap((lane) =>
    lane.structuredArtifact === undefined || lane.structuredArtifact === null
      ? []
      : [lane.structuredArtifact],
  );
  const codexLeadArtifact = input.lanes.find(
    (lane) =>
      lane.laneId === CODEX_LEAD_LANE_ID &&
      lane.structuredArtifact !== undefined &&
      lane.structuredArtifact !== null,
  )?.structuredArtifact;
  if (codexLeadArtifact !== undefined && codexLeadArtifact !== null) {
    if (input.verdict === "error") {
      return allArtifacts;
    }
    const leadBlockingFindings = codexLeadArtifact.findings.filter(
      isOpenBlockingFinding,
    );
    const nonLeadBlockingFindings = allArtifacts
      .filter((artifact) => artifact !== codexLeadArtifact)
      .flatMap((artifact) => artifact.findings)
      .filter(isOpenBlockingFinding);
    if (
      input.verdict === "fail" &&
      leadBlockingFindings.length === 0 &&
      nonLeadBlockingFindings.length > 0
    ) {
      return allArtifacts;
    }
    return [codexLeadArtifact];
  }
  return allArtifacts;
}

function mergeAuthoritativeTrackLanes<
  Finding extends ReviewTrackFinding,
  Artifact extends ReviewTrackArtifact<Finding>,
>(
  lanes: readonly ReviewTrackLane<Finding, Artifact>[],
): Array<ReviewTrackLane<Finding, Artifact>> {
  return lanes.filter((lane) => lane.mergeAuthoritative !== false);
}
