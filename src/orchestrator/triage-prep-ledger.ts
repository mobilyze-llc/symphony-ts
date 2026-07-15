import { promises as fs } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import type { TriagePrepLedgerRow } from "./triage-prep-types.js";

export async function loadTriagePrepLedgerRows(
  env: NodeJS.ProcessEnv,
): Promise<{
  rows: TriagePrepLedgerRow[];
  available: boolean;
  reason: string;
}> {
  const path =
    env.SYMPHONY_REVIEW_QUALITY_LEDGER ??
    join(
      homedir(),
      ".local/share/crucible/session-orchestrator/review-quality-ledger.jsonl",
    );
  let content: string;
  try {
    content = await fs.readFile(path, "utf8");
  } catch (error) {
    return {
      rows: [],
      available: false,
      reason: `ledger unavailable: ${errorMessage(error)}`,
    };
  }
  const rows = content.split("\n").flatMap((line) => {
    if (line.trim() === "") return [];
    try {
      const value = JSON.parse(line) as Record<string, unknown>;
      const fingerprint =
        readString(value.fp) ??
        readString(value.fingerprint) ??
        readString(value.finding_fp);
      if (fingerprint === null) return [];
      const location = readLedgerLocation(value, fingerprint);
      return [
        {
          fingerprint,
          location,
          verdict: normalizeLedgerVerdict(value),
          round:
            typeof value.round === "number" || typeof value.round === "string"
              ? value.round
              : null,
        } satisfies TriagePrepLedgerRow,
      ];
    } catch {
      return [];
    }
  });
  return { rows, available: true, reason: `read-only ledger ${path}` };
}

function normalizeLedgerVerdict(
  row: Record<string, unknown>,
): TriagePrepLedgerRow["verdict"] {
  const value =
    [
      row.final_classification,
      row.finalClassification,
      row.cross_exam_verdict,
      row.crossExamVerdict,
      row.verdict,
      row.classification,
      row.disposition,
      row.bucket,
    ]
      .map(readString)
      .find((item): item is string => item !== null)
      ?.toLowerCase() ?? "";
  if (/confirm|\bp1\b|\bp2\b/.test(value)) return "confirmed";
  if (/refute|dismiss/.test(value)) return "refuted";
  if (/downgrade|extend|track/.test(value)) return "downgraded";
  return "unknown";
}

function readLedgerLocation(
  row: Record<string, unknown>,
  fingerprint: string,
): TriagePrepLedgerRow["location"] {
  const region = readRecord(row.region);
  const regionFile = readString(region?.file);
  const parsedRegion =
    regionFile === null ? null : parseLedgerLocationText(regionFile);
  const regionLine = readNonNegativeInteger(region?.line);
  const parsedFingerprint = parseLedgerLocationText(fingerprint);
  if (parsedRegion !== null) {
    return {
      path: parsedRegion.path,
      lineRange:
        regionLine === null
          ? (parsedRegion.lineRange ??
            (parsedFingerprint?.path === parsedRegion.path
              ? parsedFingerprint.lineRange
              : null))
          : [regionLine, regionLine],
    };
  }
  return parsedFingerprint;
}

function parseLedgerLocationText(
  value: string,
): TriagePrepLedgerRow["location"] {
  const location = value.split("::", 1)[0]?.trim();
  if (location === undefined || location === "") return null;
  const rangeMatch = /^(.*?):~?(\d+)(?:-(\d+)|,(\d+))?$/.exec(location);
  if (rangeMatch === null) return { path: location, lineRange: null };
  const path = rangeMatch[1];
  const startText = rangeMatch[2];
  if (path === undefined || path === "" || startText === undefined) {
    return null;
  }
  const start = Number(startText);
  const end = Number(rangeMatch[3] ?? rangeMatch[4] ?? startText);
  return {
    path,
    lineRange: [Math.min(start, end), Math.max(start, end)],
  };
}

function readRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function readNonNegativeInteger(value: unknown): number | null {
  return typeof value === "number" && Number.isInteger(value) && value >= 0
    ? value
    : null;
}

function readString(value: unknown): string | null {
  return typeof value === "string" && value.trim() !== "" ? value.trim() : null;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
