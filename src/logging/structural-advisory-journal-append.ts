import type { DispatcherRunJournalEntry } from "../domain/model.js";
import { expandBacklogManagerCalibrationJournal } from "../orchestrator/structural-advisory-journal.js";
import {
  type DispatcherRunJournalEntryDraft,
  appendDispatcherRunJournalEntry,
  appendDispatcherRunJournalEntryToDisk,
  readDispatcherRunJournal,
  withDispatcherRunJournalWriteLock,
} from "./run-journal.js";

interface ProjectedAwareAppendResult {
  appendedEntries: DispatcherRunJournalEntry[];
  skippedEntries: DispatcherRunJournalEntry[];
}

/** Append CLI advisory emissions while honoring identities inside checkpoints. */
export async function appendStructuralAdvisoryEntriesWithProjectionDedup(
  root: string,
  drafts: readonly DispatcherRunJournalEntryDraft[],
): Promise<ProjectedAwareAppendResult> {
  return withDispatcherRunJournalWriteLock(root, async () => {
    let journal = await readDispatcherRunJournal(root);
    const known = expandBacklogManagerCalibrationJournal(journal);
    const appendedEntries: DispatcherRunJournalEntry[] = [];
    const skippedEntries: DispatcherRunJournalEntry[] = [];
    for (const draft of drafts) {
      const existing = known.find(
        (entry) => entry.idempotencyKey === draft.idempotencyKey,
      );
      if (existing !== undefined) {
        skippedEntries.push(existing);
        continue;
      }
      const appended = appendDispatcherRunJournalEntry(journal, draft);
      journal = appended.journal;
      if (!appended.appended) {
        skippedEntries.push(appended.entry);
        continue;
      }
      appendedEntries.push(appended.entry);
      known.push(appended.entry);
      await appendDispatcherRunJournalEntryToDisk(root, appended.entry);
    }
    return { appendedEntries, skippedEntries };
  });
}
