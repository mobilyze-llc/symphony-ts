import type { DispatcherRunJournal } from "../domain/model.js";
import type {
  CouncilTrackFindingFiling,
  HeadlessLaneResult,
  StructuredReviewFinding,
} from "../review/headless-council-gate.js";
import { sanitizeForLinear } from "../shared/egress.js";

/**
 * Autonomous headless-council Track-finding filer (SYMPH-763).
 *
 * The council gate runs as a CLI inside the review worker with no Linear access,
 * so it records surviving Track findings as `unfiled` (SYMPH-760) and leaves the
 * actual filing to the orchestrator, which holds the tracker client + team
 * context. This module is the pure, tracker-agnostic layer shared by the
 * orchestrator (selection, journal reduction, journal metadata) and the
 * runtime-host filer (issue title/body formatting). All Linear I/O lives in the
 * runtime-host adapter behind {@link TrackFindingFiler}.
 */

/** Max length for a filed Track-finding issue title (Linear caps titles ~255). */
const TRACK_FINDING_TITLE_MAX_LEN = 250;

/**
 * A surviving Track finding the orchestrator must file, enriched from the
 * reviewer lanes' structured artifacts when the full finding is available.
 */
export interface TrackFindingToFile {
  fingerprint: string;
  title: string;
  category: string | null;
  rationale: string | null;
  evidence: ReadonlyArray<{
    path: string;
    lineStart: number | null;
    lineEnd: number | null;
  }>;
}

/** Durable Linear ref a filer attached/found for a Track finding. */
export interface TrackFindingFilingRef {
  fingerprint: string;
  issueId: string;
  identifier: string | null;
  url: string | null;
}

/** Source-issue context woven into each filed Track-finding issue body. */
export interface TrackFindingIssueContext {
  sourceIssueIdentifier: string;
  sourceIssueUrl: string | null;
  repo: string | null;
  prNumber: number | null;
  reviewedHeadSha: string | null;
}

/** One filing request handed to the injected {@link TrackFindingFiler}. */
export interface TrackFindingFilingRequest {
  issueId: string;
  issueIdentifier: string;
  issueTitle: string;
  issueUrl: string | null;
  stageName: string | null;
  reviewedHeadSha: string | null;
  repo: string | null;
  prNumber: number | null;
  findings: readonly TrackFindingToFile[];
}

/**
 * Result of one filing attempt. `filed` carries the durable refs the filer
 * created or found (dedup); `unfiled` carries the findings the tracker could not
 * file, each with the exact machine-readable reason so a degraded closeout never
 * silently drops a finding (SYMPH-760 invariant).
 */
export interface TrackFindingFilingResult {
  filed: readonly TrackFindingFilingRef[];
  unfiled: ReadonlyArray<{ fingerprint: string; reason: string }>;
}

/**
 * Injected filer (wired in runtime-host). Mirrors the
 * `requestTrackerIssueWrite` / `onSystemicCluster` injection pattern but returns
 * the durable refs so the orchestrator can journal them. Filing is best-effort:
 * the orchestrator never blocks the merge advance on it.
 */
export type TrackFindingFiler = (
  request: TrackFindingFilingRequest,
) => Promise<TrackFindingFilingResult> | TrackFindingFilingResult;

/** Machine-parseable dedup marker keyed on the finding fingerprint. */
export function trackFindingMarker(fingerprint: string): string {
  return `[track:${fingerprint}]`;
}

/**
 * Deterministic, dedup-friendly issue title: the stable fingerprint marker
 * followed by the (sanitized, single-line, truncated) finding title. The marker
 * prefix lets the runtime-host filer dedup by a `contains` search even when the
 * human-readable tail differs.
 */
export function buildTrackFindingIssueTitle(finding: {
  fingerprint: string;
  title: string;
}): string {
  const prefix = `${trackFindingMarker(finding.fingerprint)} `;
  const cleaned = sanitizeForLinear(finding.title, { maxLen: 10_000 })
    .replace(/\s+/g, " ")
    .trim();
  const budget = TRACK_FINDING_TITLE_MAX_LEN - prefix.length;
  if (budget <= 0) {
    // Pathological: marker alone exceeds the cap. Keep the marker; it is the
    // dedup key and matters more than the human tail.
    return prefix.trimEnd().slice(0, TRACK_FINDING_TITLE_MAX_LEN);
  }
  const tail =
    cleaned.length > budget
      ? `${cleaned.slice(0, Math.max(0, budget - 1)).trimEnd()}…`
      : cleaned;
  return `${prefix}${tail}`;
}

function formatEvidence(evidence: {
  path: string;
  lineStart: number | null;
  lineEnd: number | null;
}): string {
  if (evidence.lineStart === null) {
    return evidence.path;
  }
  if (evidence.lineEnd !== null && evidence.lineEnd !== evidence.lineStart) {
    return `${evidence.path}:${evidence.lineStart}-${evidence.lineEnd}`;
  }
  return `${evidence.path}:${evidence.lineStart}`;
}

/** Render the Linear issue body for a filed Track finding (sanitized for egress). */
export function buildTrackFindingIssueBody(
  finding: TrackFindingToFile,
  context: TrackFindingIssueContext,
): string {
  const marker = trackFindingMarker(finding.fingerprint);
  const source =
    context.sourceIssueUrl !== null
      ? `[${context.sourceIssueIdentifier}](${context.sourceIssueUrl})`
      : context.sourceIssueIdentifier;
  const prRef =
    context.repo !== null && context.prNumber !== null
      ? ` (PR ${context.repo}#${context.prNumber})`
      : context.prNumber !== null
        ? ` (PR #${context.prNumber})`
        : "";
  const headRef =
    context.reviewedHeadSha !== null
      ? ` at reviewed head \`${context.reviewedHeadSha}\``
      : "";

  const lines: string[] = [
    marker,
    "",
    "## Track finding from headless council review",
    "",
    `Surfaced during review of ${source}${prRef}${headRef}. Track findings do not block merge; triage and prioritize.`,
    "",
  ];
  if (finding.category !== null) {
    lines.push(`**Category:** ${finding.category}`, "");
  }
  if (finding.rationale !== null) {
    lines.push("## Rationale", "", finding.rationale, "");
  }
  if (finding.evidence.length > 0) {
    lines.push("## Evidence", "");
    for (const e of finding.evidence) {
      lines.push(`- \`${formatEvidence(e)}\``);
    }
    lines.push("");
  }
  lines.push(
    "## Notes",
    "",
    "- Machine-filed by the Symphony headless-council Track-finding filer (SYMPH-763).",
    `- Dedup marker: \`${marker}\` (keyed on the council finding fingerprint).`,
  );
  return sanitizeForLinear(lines.join("\n"));
}

/**
 * Select the surviving Track findings that still need a durable Linear ID: those
 * the in-process seam left `unfiled` (entry `issueId === null`) AND that the
 * journal has not already filed on a prior closeout/replay. Each is enriched
 * from the reviewer lanes (rationale/category/evidence) when the full finding is
 * present, falling back to title-only otherwise.
 */
export function collectTrackFindingsToFile(
  trackFiling: CouncilTrackFindingFiling,
  lanes: readonly HeadlessLaneResult[],
  alreadyFiled: ReadonlySet<string>,
): TrackFindingToFile[] {
  const byFingerprint = new Map<string, StructuredReviewFinding>();
  for (const lane of lanes) {
    const artifact = lane.structuredArtifact;
    if (artifact === undefined || artifact === null) {
      continue;
    }
    for (const candidate of artifact.findings) {
      if (!byFingerprint.has(candidate.fingerprint)) {
        byFingerprint.set(candidate.fingerprint, candidate);
      }
    }
  }

  const toFile: TrackFindingToFile[] = [];
  for (const entry of trackFiling.findings) {
    // A present, non-empty issueId means the in-process seam already filed it;
    // an empty string is treated as unfiled (defensive — the gate never emits
    // one, but a malformed artifact must not silently drop the finding).
    const alreadyHasDurableId =
      entry.issueId !== null && entry.issueId.length > 0;
    if (alreadyHasDurableId || alreadyFiled.has(entry.fingerprint)) {
      continue;
    }
    const full = byFingerprint.get(entry.fingerprint);
    toFile.push({
      fingerprint: entry.fingerprint,
      title: entry.title,
      category: full?.category ?? null,
      rationale: full?.rationale ?? null,
      evidence:
        full?.evidence.map((e) => ({
          path: e.path,
          lineStart: e.lineStart,
          lineEnd: e.lineEnd,
        })) ?? [],
    });
  }
  return toFile;
}

/**
 * Reconcile a filer's result against the exact set of findings it was asked to
 * file (SYMPH-763, council R1 P1). The injected filer is an external contract:
 * it may return fewer entries than requested, malformed/duplicate/unknown refs,
 * or a ref with an empty issueId. Trusting it verbatim could journal a finding
 * as `filed` (or omit it entirely) while it actually has no durable ID — a
 * silent clean closeout (violates the SYMPH-760 invariant). This guarantees
 * every requested fingerprint lands in exactly one of `filed` (with a validated,
 * non-empty issueId) or `unfiled` (with the filer's exact reason, or a synthesized
 * default), and drops any ref the caller did not request.
 */
export function reconcileFilingResult(
  toFile: readonly TrackFindingToFile[],
  result: { filed?: unknown; unfiled?: unknown },
): {
  filed: TrackFindingFilingRef[];
  unfiled: Array<{ fingerprint: string; reason: string }>;
} {
  const requested = new Set(toFile.map((finding) => finding.fingerprint));
  const filed: TrackFindingFilingRef[] = [];
  const filedFingerprints = new Set<string>();
  for (const raw of Array.isArray(result.filed) ? result.filed : []) {
    const record =
      typeof raw === "object" && raw !== null
        ? (raw as Record<string, unknown>)
        : null;
    if (record === null) {
      continue;
    }
    const fingerprint = record.fingerprint;
    const issueId = record.issueId;
    if (
      typeof fingerprint === "string" &&
      requested.has(fingerprint) &&
      !filedFingerprints.has(fingerprint) &&
      typeof issueId === "string" &&
      issueId.length > 0
    ) {
      filed.push({
        fingerprint,
        issueId,
        identifier:
          typeof record.identifier === "string" ? record.identifier : null,
        url: typeof record.url === "string" ? record.url : null,
      });
      filedFingerprints.add(fingerprint);
    }
  }

  const unfiledReason = new Map<string, string>();
  for (const raw of Array.isArray(result.unfiled) ? result.unfiled : []) {
    const record =
      typeof raw === "object" && raw !== null
        ? (raw as Record<string, unknown>)
        : null;
    if (record === null) {
      continue;
    }
    const fingerprint = record.fingerprint;
    if (
      typeof fingerprint === "string" &&
      requested.has(fingerprint) &&
      !filedFingerprints.has(fingerprint) &&
      !unfiledReason.has(fingerprint)
    ) {
      unfiledReason.set(
        fingerprint,
        typeof record.reason === "string" && record.reason.length > 0
          ? record.reason
          : "filer reported the finding unfiled without a reason",
      );
    }
  }

  const unfiled = toFile
    .filter((finding) => !filedFingerprints.has(finding.fingerprint))
    .map((finding) => ({
      fingerprint: finding.fingerprint,
      reason:
        unfiledReason.get(finding.fingerprint) ??
        "filer returned no durable ref for this finding",
    }));

  return { filed, unfiled };
}

/**
 * Reduce all `track_finding_filing` journal entries for an issue into a
 * fingerprint→ref map of the findings that carry a durable Linear ID. Journal
 * order is preserved, so a later filed entry supersedes an earlier unfiled one
 * (the replay/retry case). This is the orchestrator's fingerprint idempotency
 * source on replay (AC: keyed on finding fingerprint).
 */
export function reduceTrackFindingFilings(
  journal: DispatcherRunJournal,
  issueId: string,
): Map<string, TrackFindingFilingRef> {
  const refs = new Map<string, TrackFindingFilingRef>();
  for (const entry of journal) {
    if (entry.kind !== "track_finding_filing" || entry.issueId !== issueId) {
      continue;
    }
    const filings = entry.metadata.filings;
    if (!Array.isArray(filings)) {
      continue;
    }
    for (const raw of filings) {
      if (typeof raw !== "object" || raw === null) {
        continue;
      }
      const record = raw as Record<string, unknown>;
      const fingerprint = record.fingerprint;
      const issueIdValue = record.issue_id;
      if (
        typeof fingerprint !== "string" ||
        typeof issueIdValue !== "string" ||
        issueIdValue.length === 0
      ) {
        continue;
      }
      refs.set(fingerprint, {
        fingerprint,
        issueId: issueIdValue,
        identifier:
          typeof record.identifier === "string" ? record.identifier : null,
        url: typeof record.url === "string" ? record.url : null,
      });
    }
  }
  return refs;
}

/**
 * Build the `track_finding_filing` journal entry metadata for one filing
 * attempt. Stores the durable refs (read back by {@link reduceTrackFindingFilings})
 * and the exact per-finding reason for any tracker failure, plus an aggregate
 * status that reconciles the `track_filing_status` carried on the originating
 * `review_gate_result` entry (SYMPH-760).
 */
export function buildTrackFindingFilingMetadata(input: {
  required: number;
  reviewedHeadSha: string | null;
  filed: readonly TrackFindingFilingRef[];
  unfiled: ReadonlyArray<{ fingerprint: string; reason: string }>;
}): Record<string, unknown> {
  const status = input.unfiled.length === 0 ? "filed" : "unfiled";
  const reason =
    status === "filed"
      ? undefined
      : input.filed.length === 0
        ? "track_findings_unfiled"
        : "track_findings_partially_filed";
  const filings: Array<Record<string, unknown>> = [
    ...input.filed.map((ref) => ({
      fingerprint: ref.fingerprint,
      issue_id: ref.issueId,
      ...(ref.identifier !== null ? { identifier: ref.identifier } : {}),
      ...(ref.url !== null ? { url: ref.url } : {}),
      status: "filed",
    })),
    ...input.unfiled.map((entry) => ({
      fingerprint: entry.fingerprint,
      status: "unfiled",
      reason: entry.reason,
    })),
  ];
  const metadata: Record<string, unknown> = {
    track_filing_status: status,
    track_filing_required: input.required,
    track_filing_filed_count: input.filed.length,
    filings,
  };
  if (reason !== undefined) {
    metadata.track_filing_reason = reason;
  }
  if (input.reviewedHeadSha !== null) {
    metadata.reviewed_head_sha = input.reviewedHeadSha;
  }
  return metadata;
}
