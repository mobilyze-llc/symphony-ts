import { promises as fs } from "node:fs";
import { join } from "node:path";

import {
  type StandingPlanJournal,
  type StandingPlanJournalEntry,
  type StandingPlanJournalEntryDraft,
  isStandingPlanJournalEntry,
} from "../domain/standing-plan.js";
import { withDispatcherRunJournalWriteLock } from "./run-journal.js";

// The standing-plan journal lives alongside the dispatcher run journal and
// shares its single-writer lock (SYMPH-784 design: one writer boundary). It is
// append-only and NOT compacted in v2 — the full revision + decision history is
// the calibration substrate (SYMPH-792).
const STANDING_PLAN_JOURNAL_DIR = join(".symphony", "run-journals");
const STANDING_PLAN_JOURNAL_FILENAME = "standing-plan.jsonl";

export interface AppendStandingPlanJournalEntriesResult {
  journal: StandingPlanJournal;
  entries: StandingPlanJournalEntry[];
  appendedEntries: StandingPlanJournalEntry[];
  skippedEntries: StandingPlanJournalEntry[];
}

export function getStandingPlanJournalPath(workspaceRoot: string): string {
  return join(
    workspaceRoot,
    STANDING_PLAN_JOURNAL_DIR,
    STANDING_PLAN_JOURNAL_FILENAME,
  );
}

export function appendStandingPlanJournalEntry(
  journal: StandingPlanJournal,
  draft: StandingPlanJournalEntryDraft,
): {
  journal: StandingPlanJournal;
  entry: StandingPlanJournalEntry;
  appended: boolean;
} {
  const existing = journal.find(
    (candidate) => candidate.idempotencyKey === draft.idempotencyKey,
  );
  if (existing !== undefined) {
    return { journal, entry: existing, appended: false };
  }

  const nextEntry = {
    ...draft,
    sequence: (journal.at(-1)?.sequence ?? 0) + 1,
  } as StandingPlanJournalEntry;
  return {
    journal: [...journal, nextEntry],
    entry: nextEntry,
    appended: true,
  };
}

export async function readStandingPlanJournal(
  workspaceRoot: string,
): Promise<StandingPlanJournal> {
  const artifactPath = getStandingPlanJournalPath(workspaceRoot);
  let raw: string;
  try {
    raw = await fs.readFile(artifactPath, "utf8");
  } catch (error) {
    if (isMissingPathError(error)) {
      return [];
    }
    throw error;
  }

  const entries: StandingPlanJournal = [];
  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (trimmed.length === 0) {
      continue;
    }
    try {
      const parsed = JSON.parse(trimmed) as unknown;
      if (isStandingPlanJournalEntry(parsed)) {
        entries.push(parsed);
      }
    } catch {
      // Ignore malformed rows so one bad line does not block recovery.
    }
  }

  return entries.sort((left, right) => left.sequence - right.sequence);
}

export async function appendStandingPlanJournalEntryToDisk(
  workspaceRoot: string,
  entry: StandingPlanJournalEntry,
): Promise<void> {
  const artifactPath = getStandingPlanJournalPath(workspaceRoot);
  const journalDir = join(workspaceRoot, STANDING_PLAN_JOURNAL_DIR);
  await fs.mkdir(journalDir, { recursive: true });
  await fs.appendFile(artifactPath, `${JSON.stringify(entry)}\n`, "utf8");
}

/**
 * Append drafts under the shared single-writer lock: read → allocate sequences
 * → append to disk, so independent writers cannot allocate from the same stale
 * snapshot. Idempotent by `idempotencyKey`.
 */
export async function appendStandingPlanJournalEntriesWithLock(
  workspaceRoot: string,
  drafts: readonly StandingPlanJournalEntryDraft[],
): Promise<AppendStandingPlanJournalEntriesResult> {
  return withDispatcherRunJournalWriteLock(workspaceRoot, async () => {
    let journal = await readStandingPlanJournal(workspaceRoot);
    const entries: StandingPlanJournalEntry[] = [];
    const appendedEntries: StandingPlanJournalEntry[] = [];
    const skippedEntries: StandingPlanJournalEntry[] = [];

    for (const draft of drafts) {
      const appended = appendStandingPlanJournalEntry(journal, draft);
      journal = appended.journal;
      entries.push(appended.entry);
      if (appended.appended) {
        appendedEntries.push(appended.entry);
        await appendStandingPlanJournalEntryToDisk(
          workspaceRoot,
          appended.entry,
        );
      } else {
        skippedEntries.push(appended.entry);
      }
    }

    return { journal, entries, appendedEntries, skippedEntries };
  });
}

function isMissingPathError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: unknown }).code === "ENOENT"
  );
}
