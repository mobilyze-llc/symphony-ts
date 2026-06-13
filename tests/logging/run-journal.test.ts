import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import type {
  DispatcherRunJournal,
  DispatcherRunJournalEntry,
} from "../../src/domain/model.js";
import {
  type DispatcherRunJournalEntryDraft,
  appendDispatcherRunJournalEntryToDisk,
  compactDispatcherRunJournalFileWithLock,
  compactDispatcherRunJournalWithCheckpoint,
  readDispatcherRunJournal,
} from "../../src/logging/run-journal.js";

describe("dispatcher run-journal compaction", () => {
  it("replaces a historical prefix with a checkpoint and keeps a raw tail", () => {
    const journal = [1, 2, 3, 4, 5, 6].map((sequence) => createEntry(sequence));

    const result = compactDispatcherRunJournalWithCheckpoint(
      journal,
      createCheckpointDraft(6),
      { tailEntryCount: 2, minEntryCount: 3 },
    );

    expect(result.compacted).toBe(true);
    expect(result.journal.map((entry) => entry.sequence)).toEqual([4, 5, 6]);
    expect(result.journal[0]).toMatchObject({
      kind: "journal_checkpoint",
      idempotencyKey: "journal_checkpoint:6",
      metadata: expect.objectContaining({
        coveredThroughSequence: 6,
        checkpointSequence: 4,
        originalEntryCount: 6,
        retainedTailEntries: 2,
        coveredPrefixEntryCount: 4,
        droppedEntryCount: 3,
      }),
    });
    expect(result.retainedEntryCount).toBe(3);
    expect(result.droppedEntryCount).toBe(3);
  });

  it("rewrites the on-disk journal under the write lock", async () => {
    const root = mkdtempSync(join(tmpdir(), "symph-run-journal-"));
    try {
      for (const sequence of [1, 2, 3, 4, 5, 6]) {
        await appendDispatcherRunJournalEntryToDisk(
          root,
          createEntry(sequence),
        );
      }

      const result = await compactDispatcherRunJournalFileWithLock(
        root,
        createCheckpointDraft(6),
        { tailEntryCount: 2, minEntryCount: 3 },
      );
      const persisted = await readDispatcherRunJournal(root);

      expect(result.compacted).toBe(true);
      expect(persisted.map((entry) => entry.sequence)).toEqual([4, 5, 6]);
      expect(persisted[0]?.kind).toBe("journal_checkpoint");
      expect(persisted[1]?.summary).toBe("entry 5");
      expect(persisted[2]?.summary).toBe("entry 6");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("skips a locked rewrite when the checkpoint cursor is stale", async () => {
    const root = mkdtempSync(join(tmpdir(), "symph-run-journal-"));
    try {
      for (const sequence of [1, 2, 3, 4, 5, 6, 7]) {
        await appendDispatcherRunJournalEntryToDisk(
          root,
          createEntry(sequence),
        );
      }

      const result = await compactDispatcherRunJournalFileWithLock(
        root,
        createCheckpointDraft(6),
        { tailEntryCount: 2, minEntryCount: 3 },
      );
      const persisted = await readDispatcherRunJournal(root);

      expect(result.compacted).toBe(false);
      expect(result.skippedReason).toBe("stale_checkpoint");
      expect(persisted).toHaveLength(7);
      expect(persisted[0]?.kind).toBe("admission");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

function createCheckpointDraft(
  coveredThroughSequence: number,
): DispatcherRunJournalEntryDraft {
  return {
    idempotencyKey: `journal_checkpoint:${coveredThroughSequence}`,
    timestamp: "2026-06-13T00:00:10.000Z",
    kind: "journal_checkpoint",
    issueId: "__dispatcher__",
    issueIdentifier: "DISPATCHER",
    operation: "dispatcher",
    stage: null,
    attempt: null,
    ownerId: "test",
    lease: null,
    summary: `Checkpoint through seq ${coveredThroughSequence}.`,
    metadata: {
      schema_version: 1,
      checkpoint_type: "dispatcher_run_journal",
      coveredThroughSequence,
      state: {},
      privateState: {},
      decisionQualityEvents: [],
    },
  };
}

function createEntry(sequence: number): DispatcherRunJournalEntry {
  return {
    sequence,
    idempotencyKey: `entry:${sequence}`,
    timestamp: `2026-06-13T00:00:0${sequence}.000Z`,
    kind: "admission",
    issueId: "issue-1",
    issueIdentifier: "SYMPH-1",
    operation: "dispatcher",
    stage: null,
    attempt: null,
    ownerId: "test",
    lease: null,
    summary: `entry ${sequence}`,
    metadata: { status: "completed" },
  };
}
