/**
 * Standalone dispatcher run-journal reader for the calibration digest
 * (SYMPH-411).
 *
 * Deliberately duplicates the tiny JSONL read logic from
 * src/logging/run-journal.ts instead of importing it: the calibration job is
 * a pure read-model that must stay deletable with zero coupling to the
 * orchestrator runtime. Imports are limited to type-only domain model types.
 */

import { promises as fs } from "node:fs";
import { join } from "node:path";

import {
  DISPATCHER_OPERATIONS,
  DISPATCHER_RUN_JOURNAL_EVENT_KINDS,
  type DispatcherRunJournalEntry,
} from "../domain/model.js";

const RUN_JOURNAL_RELATIVE_PATH = join(
  ".symphony",
  "run-journals",
  "dispatcher.jsonl",
);

export function getCalibrationJournalPath(workspaceRoot: string): string {
  return join(workspaceRoot, RUN_JOURNAL_RELATIVE_PATH);
}

/**
 * Read and parse the dispatcher run journal for calibration. Missing file
 * yields an empty journal; malformed lines are skipped (one bad row must not
 * block the digest). Entries are returned sorted by sequence.
 */
export async function readCalibrationJournal(
  workspaceRoot: string,
): Promise<DispatcherRunJournalEntry[]> {
  const journalPath = getCalibrationJournalPath(workspaceRoot);
  let raw: string;
  try {
    raw = await fs.readFile(journalPath, "utf8");
  } catch (error) {
    if (isMissingPathError(error)) {
      return [];
    }
    throw error;
  }
  return parseCalibrationJournal(raw);
}

/** Parse raw JSONL journal content. Exported for synthetic-journal tests. */
export function parseCalibrationJournal(
  raw: string,
): DispatcherRunJournalEntry[] {
  const entries: DispatcherRunJournalEntry[] = [];
  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (trimmed.length === 0) {
      continue;
    }
    try {
      const parsed = JSON.parse(trimmed) as unknown;
      if (isCalibrationJournalEntry(parsed)) {
        entries.push(parsed);
      }
    } catch {
      // Skip malformed rows.
    }
  }
  return entries.sort((left, right) => left.sequence - right.sequence);
}

function isCalibrationJournalEntry(
  value: unknown,
): value is DispatcherRunJournalEntry {
  if (!isRecord(value)) {
    return false;
  }
  return (
    Number.isFinite(value.sequence) &&
    typeof value.idempotencyKey === "string" &&
    typeof value.timestamp === "string" &&
    typeof value.kind === "string" &&
    (DISPATCHER_RUN_JOURNAL_EVENT_KINDS as readonly string[]).includes(
      value.kind,
    ) &&
    typeof value.issueId === "string" &&
    typeof value.issueIdentifier === "string" &&
    typeof value.operation === "string" &&
    (DISPATCHER_OPERATIONS as readonly string[]).includes(value.operation) &&
    (value.stage === null || typeof value.stage === "string") &&
    (value.attempt === null || Number.isFinite(value.attempt)) &&
    (value.ownerId === null || typeof value.ownerId === "string") &&
    (value.lease === null || isRecord(value.lease)) &&
    typeof value.summary === "string" &&
    isRecord(value.metadata)
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isMissingPathError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: unknown }).code === "ENOENT"
  );
}
