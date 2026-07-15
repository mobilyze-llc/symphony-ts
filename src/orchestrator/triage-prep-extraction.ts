import type { Issue } from "../domain/model.js";
import { extractGroundingEvidenceCandidates } from "./code-grounding.js";
import { containsAsciiIdentifierBoundedLiteral } from "./triage-prep-literal.js";
import {
  type ExtractedFindingsIntakeV2Metadata,
  type ExtractedRecurrenceMetadata,
  type ExtractedTriageFinding,
  SUPERVISOR_FAILURE_CLASSES,
  TRIAGE_PREP_REPOSITORIES_ENV,
  type TriagePrepRepository,
} from "./triage-prep-types.js";

export { loadTriagePrepLedgerRows } from "./triage-prep-ledger.js";

/**
 * Shared, read-time-only extraction front-step for current intake and legacy
 * tickets.
 */
export function extractTriageFinding(issue: Issue): ExtractedTriageFinding;
export function extractTriageFinding(
  issue: Issue,
  additionalEvidence: readonly string[],
): ExtractedTriageFinding;
export function extractTriageFinding(
  issue: Issue,
  additionalEvidence: readonly string[] = [],
): ExtractedTriageFinding {
  const text = [
    issue.title,
    issue.description ?? "",
    ...additionalEvidence,
  ].join("\n");
  const findingsIntakeV2 = extractFindingsIntakeV2Metadata(text);
  const anchors = new Map<string, ExtractedTriageFinding["anchors"][number]>();
  for (const match of text.matchAll(
    /\b((?:[A-Za-z0-9._@+-]+\/)+[A-Za-z0-9._@+-]+)(?::(\d+)(?:-(\d+))?)?::([A-Za-z0-9][A-Za-z0-9._/-]*)/g,
  )) {
    const path = match[1];
    const startLine = match[2];
    const endLine = match[3];
    const fingerprint = match[4];
    if (path === undefined || fingerprint === undefined) continue;
    const lineRange: [number, number] | null =
      startLine === undefined
        ? null
        : [Number(startLine), Number(endLine ?? startLine)];
    const raw = match[0];
    anchors.set(raw, {
      key: raw,
      raw,
      path,
      fingerprint,
      lineRange,
    });
  }
  for (const candidate of extractGroundingEvidenceCandidates(text).paths) {
    if (candidate.lineRange === undefined) continue;
    if (
      [...anchors.values()].some(
        (anchor) =>
          anchor.path === candidate.path &&
          anchor.lineRange?.[0] === candidate.lineRange?.[0] &&
          anchor.lineRange?.[1] === candidate.lineRange?.[1],
      )
    ) {
      continue;
    }
    const key = `${candidate.path}:${candidate.lineRange[0]}-${candidate.lineRange[1]}`;
    anchors.set(key, {
      key,
      raw: candidate.raw,
      path: candidate.path,
      fingerprint: null,
      lineRange: candidate.lineRange,
    });
  }
  for (const raw of findingsIntakeV2?.anchors ?? []) {
    const anchor = parseFindingsIntakeAnchor(raw);
    if (anchor !== null) anchors.set(anchor.key, anchor);
  }
  const failureClasses = [
    ...new Set([
      ...SUPERVISOR_FAILURE_CLASSES.filter((failureClass) =>
        containsAsciiIdentifierBoundedLiteral(text, failureClass),
      ),
      ...(findingsIntakeV2 === null ? [] : [findingsIntakeV2.failureClass]),
    ]),
  ];
  const recurrenceMetadata = extractRecurrenceMetadata(text);
  const councilFingerprints = [
    ...new Set(
      [...anchors.values()].flatMap((anchor) =>
        anchor.fingerprint === null ? [] : [anchor.key],
      ),
    ),
  ];
  return {
    issueId: issue.id,
    issueIdentifier: issue.identifier,
    format:
      findingsIntakeV2 !== null
        ? "findings_intake_v2"
        : recurrenceMetadata === null
          ? "legacy"
          : "mob_1227_metadata",
    anchors: [...anchors.values()],
    failureClasses,
    councilFingerprints,
    recurrenceIdentityKeys:
      findingsIntakeV2 === null ? councilFingerprints : [findingsIntakeV2.fkey],
    recurrenceObservationCount: additionalEvidence.filter((value) =>
      /^Recurrence observed\b/im.test(value),
    ).length,
    relatedIssueIdentifiers: extractRelatedIssueIdentifiers(text),
    recurrenceMetadata,
    findingsIntakeV2,
  };
}

function extractFindingsIntakeV2Metadata(
  text: string,
): ExtractedFindingsIntakeV2Metadata | null {
  for (const match of text.matchAll(
    /<!--\s*findings-intake-metadata:v2\s*([\s\S]*?)-->/gi,
  )) {
    const block = match[1] ?? "";
    const jsonStart = block.indexOf("{");
    const jsonEnd = block.lastIndexOf("}");
    if (jsonStart === -1 || jsonEnd < jsonStart) continue;
    let raw: unknown;
    try {
      raw = JSON.parse(block.slice(jsonStart, jsonEnd + 1));
    } catch {
      continue;
    }
    if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
      continue;
    }
    const row = raw as Record<string, unknown>;
    const anchors = Array.isArray(row.anchors)
      ? row.anchors.flatMap((value) => {
          const anchor = readString(value);
          return anchor === null ? [] : [anchor];
        })
      : [];
    const schema = readString(row.schema);
    const failureClass = readString(row.failure_class);
    const anchorFingerprint = readString(row.anchor_fingerprint);
    const fkey = block
      .slice(jsonEnd + 1)
      .split(/\r?\n/)
      .map((line) => line.trim())
      .find((line) => /^fkey[0-9a-f]{16}$/i.test(line));
    if (
      schema !== "crucible.findings-intake.v2" ||
      failureClass === null ||
      anchorFingerprint === null ||
      anchors.length === 0 ||
      fkey === undefined
    ) {
      continue;
    }
    return {
      schema,
      failureClass,
      anchorFingerprint,
      anchors,
      fkey,
    };
  }
  return null;
}

function parseFindingsIntakeAnchor(
  raw: string,
): ExtractedTriageFinding["anchors"][number] | null {
  const pathMatch =
    /^((?:[A-Za-z0-9._@+-]+\/)*[A-Za-z0-9._@+-]+\.(?:[cm]?[jt]sx?|py|sh|json|ya?ml|md))(?=$|[:/])/.exec(
      raw,
    );
  const path = pathMatch?.[1];
  if (path === undefined) return null;
  const suffix = raw.slice(path.length);
  const lineMatch =
    /^:(\d+)(?:-(\d+))?(?:::([A-Za-z0-9][A-Za-z0-9._/-]*))?$/.exec(suffix);
  if (lineMatch !== null) {
    const startLine = Number(lineMatch[1]);
    return {
      key: raw,
      raw,
      path,
      fingerprint: lineMatch[3] ?? null,
      lineRange: [startLine, Number(lineMatch[2] ?? startLine)],
    };
  }
  const fingerprint = /^(?:::|:|\/)([A-Za-z0-9][A-Za-z0-9._/#-]*)$/.exec(
    suffix,
  )?.[1];
  if (suffix !== "" && fingerprint === undefined) return null;
  return {
    key: raw,
    raw,
    path,
    fingerprint: fingerprint ?? null,
    lineRange: null,
  };
}

export function parseTriagePrepRepositories(
  raw: string | undefined,
): TriagePrepRepository[] {
  if (raw === undefined || raw.trim() === "") return [];
  const parsed = JSON.parse(raw) as unknown;
  if (!Array.isArray(parsed)) {
    throw new Error(`${TRIAGE_PREP_REPOSITORIES_ENV} must be a JSON array`);
  }
  return parsed.map((value, index) => {
    if (value === null || typeof value !== "object" || Array.isArray(value)) {
      throw new Error(
        `${TRIAGE_PREP_REPOSITORIES_ENV}[${index}] must be an object`,
      );
    }
    const row = value as Record<string, unknown>;
    const key = readString(row.key);
    const repoUrl = readString(row.repoUrl) ?? readString(row.repo_url);
    if (key === null || repoUrl === null) {
      throw new Error(
        `${TRIAGE_PREP_REPOSITORIES_ENV}[${index}] requires key and repoUrl`,
      );
    }
    return {
      key,
      target: {
        repoUrl,
        repoScope: /(?:^|[/:])symphony(?:-ts)?(?:\.git)?$/i.test(repoUrl)
          ? "symphony"
          : "non_symphony",
      },
    };
  });
}

function extractRecurrenceMetadata(
  text: string,
): ExtractedRecurrenceMetadata | null {
  const blocks = [
    ...[...text.matchAll(/<!--([\s\S]*?)-->/g)].map((match) => match[1] ?? ""),
    ...[...text.matchAll(/```[^\n]*\n([\s\S]*?)```/g)].map(
      (match) => match[1] ?? "",
    ),
  ].filter((block) =>
    /(?:mob-1227|finding[_ -]metadata|recurrence[_ -]metadata)/i.test(block),
  );
  for (const block of blocks) {
    const recurrenceCount = readMetadataInteger(block, [
      "recurrence_count",
      "recurrences",
      "occurrences",
    ]);
    if (recurrenceCount === null) continue;
    return {
      recurrenceCount,
      sessionCount: readMetadataInteger(block, [
        "session_count",
        "sessions",
        "distinct_sessions",
      ]),
      postDoneRecurrenceCount: readMetadataInteger(block, [
        "post_done_recurrence_count",
        "post_done_recurrences",
      ]),
      doneTwinCount: readMetadataInteger(block, [
        "done_twin_count",
        "done_twins",
      ]),
    };
  }
  return null;
}

function readMetadataInteger(
  block: string,
  keys: readonly MetadataIntegerKey[],
): number | null {
  for (const key of keys) {
    const match = METADATA_INTEGER_PATTERNS[key].exec(block);
    if (match?.[1] !== undefined) return Number(match[1]);
  }
  return null;
}

type MetadataIntegerKey = keyof typeof METADATA_INTEGER_PATTERNS;

const METADATA_INTEGER_PATTERNS = {
  recurrence_count:
    /(?:^|[^A-Za-z0-9_])["']?recurrence_count["']?\s*[:=]\s*(\d+)/i,
  recurrences: /(?:^|[^A-Za-z0-9_])["']?recurrences["']?\s*[:=]\s*(\d+)/i,
  occurrences: /(?:^|[^A-Za-z0-9_])["']?occurrences["']?\s*[:=]\s*(\d+)/i,
  session_count: /(?:^|[^A-Za-z0-9_])["']?session_count["']?\s*[:=]\s*(\d+)/i,
  sessions: /(?:^|[^A-Za-z0-9_])["']?sessions["']?\s*[:=]\s*(\d+)/i,
  distinct_sessions:
    /(?:^|[^A-Za-z0-9_])["']?distinct_sessions["']?\s*[:=]\s*(\d+)/i,
  post_done_recurrence_count:
    /(?:^|[^A-Za-z0-9_])["']?post_done_recurrence_count["']?\s*[:=]\s*(\d+)/i,
  post_done_recurrences:
    /(?:^|[^A-Za-z0-9_])["']?post_done_recurrences["']?\s*[:=]\s*(\d+)/i,
  done_twin_count:
    /(?:^|[^A-Za-z0-9_])["']?done_twin_count["']?\s*[:=]\s*(\d+)/i,
  done_twins: /(?:^|[^A-Za-z0-9_])["']?done_twins["']?\s*[:=]\s*(\d+)/i,
} as const;

function extractRelatedIssueIdentifiers(text: string): string[] {
  return [
    ...new Set(
      [
        ...text.matchAll(
          /(?:Related Done twin:|fresh visible intake|concurrent intake)\s+(?:\[)?([A-Z][A-Z0-9]+-\d+)\b/gi,
        ),
      ].flatMap((match) => {
        const identifier = match[1];
        return identifier === undefined ? [] : [identifier.toUpperCase()];
      }),
    ),
  ].sort();
}

function readString(value: unknown): string | null {
  return typeof value === "string" && value.trim() !== "" ? value.trim() : null;
}
