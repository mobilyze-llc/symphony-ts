import { promises as fs } from "node:fs";
import { join } from "node:path";

import {
  DISPATCHER_RUN_JOURNAL_EVENT_KINDS,
  type DispatcherLease,
  type DispatcherRunJournal,
  type DispatcherRunJournalEntry,
} from "../domain/model.js";

const DISPATCHER_RUN_JOURNAL_DIR = join(".symphony", "run-journals");
const DISPATCHER_RUN_JOURNAL_FILENAME = "dispatcher.jsonl";

export function getDispatcherRunJournalPath(workspaceRoot: string): string {
  return join(
    workspaceRoot,
    DISPATCHER_RUN_JOURNAL_DIR,
    DISPATCHER_RUN_JOURNAL_FILENAME,
  );
}

export function appendDispatcherRunJournalEntry(
  journal: DispatcherRunJournal,
  entry: Omit<DispatcherRunJournalEntry, "sequence">,
  minSequence = 1,
): {
  journal: DispatcherRunJournal;
  entry: DispatcherRunJournalEntry;
  appended: boolean;
} {
  const existing = journal.find(
    (candidate) => candidate.idempotencyKey === entry.idempotencyKey,
  );
  if (existing !== undefined) {
    return { journal, entry: existing, appended: false };
  }

  const nextEntry: DispatcherRunJournalEntry = {
    ...entry,
    sequence: Math.max((journal.at(-1)?.sequence ?? 0) + 1, minSequence),
  };
  return {
    journal: [...journal, nextEntry],
    entry: nextEntry,
    appended: true,
  };
}

export function rebuildDispatcherLeases(
  journal: DispatcherRunJournal,
): Record<string, DispatcherLease> {
  const leases: Record<string, DispatcherLease> = {};
  for (const entry of journal) {
    if (entry.lease === null) {
      continue;
    }
    leases[entry.lease.leaseId] = {
      ...entry.lease,
      lastJournalSequence: entry.sequence,
    };
  }
  return leases;
}

export async function readDispatcherRunJournal(
  workspaceRoot: string,
): Promise<DispatcherRunJournal> {
  const artifactPath = getDispatcherRunJournalPath(workspaceRoot);
  let raw: string;
  try {
    raw = await fs.readFile(artifactPath, "utf8");
  } catch (error) {
    if (isMissingPathError(error)) {
      return [];
    }
    throw error;
  }

  const entries: DispatcherRunJournal = [];
  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (trimmed.length === 0) {
      continue;
    }
    try {
      const parsed = JSON.parse(trimmed) as unknown;
      if (isDispatcherRunJournalEntry(parsed)) {
        entries.push(parsed);
      }
    } catch {
      // Ignore malformed rows so one bad line does not block recovery.
    }
  }

  return entries.sort((left, right) => left.sequence - right.sequence);
}

export async function appendDispatcherRunJournalEntryToDisk(
  workspaceRoot: string,
  entry: DispatcherRunJournalEntry,
): Promise<void> {
  const artifactPath = getDispatcherRunJournalPath(workspaceRoot);
  await fs.mkdir(join(workspaceRoot, DISPATCHER_RUN_JOURNAL_DIR), {
    recursive: true,
  });
  await fs.appendFile(artifactPath, `${JSON.stringify(entry)}\n`, "utf8");
}

function isDispatcherRunJournalEntry(
  value: unknown,
): value is DispatcherRunJournalEntry {
  if (!isRecord(value)) {
    return false;
  }
  return (
    typeof value.sequence === "number" &&
    typeof value.idempotencyKey === "string" &&
    typeof value.timestamp === "string" &&
    typeof value.kind === "string" &&
    DISPATCHER_RUN_JOURNAL_EVENT_KINDS.includes(
      value.kind as DispatcherRunJournalEntry["kind"],
    ) &&
    typeof value.issueId === "string" &&
    typeof value.issueIdentifier === "string" &&
    typeof value.operation === "string" &&
    typeof value.summary === "string" &&
    isRecord(value.metadata) &&
    (value.lease === null || isDispatcherLease(value.lease))
  );
}

function isDispatcherLease(value: unknown): value is DispatcherLease {
  if (!isRecord(value)) {
    return false;
  }
  return (
    typeof value.leaseId === "string" &&
    typeof value.issueId === "string" &&
    typeof value.issueIdentifier === "string" &&
    typeof value.operation === "string" &&
    typeof value.ownerId === "string" &&
    typeof value.status === "string" &&
    typeof value.acquiredAt === "string" &&
    typeof value.expiresAt === "string" &&
    (value.completedAt === null || typeof value.completedAt === "string") &&
    (value.stage === null || typeof value.stage === "string") &&
    (value.attempt === null || typeof value.attempt === "number") &&
    typeof value.lastJournalSequence === "number"
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
