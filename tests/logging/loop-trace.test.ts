import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import type { LoopTraceJournal } from "../../src/domain/model.js";
import {
  LOOP_TRACE_JOURNAL_MAX_ENTRIES,
  appendLoopTraceJournalEntry,
  buildLoopTraceJournalPreview,
  readLoopTraceJournal,
} from "../../src/logging/loop-trace.js";

describe("loop trace journal", () => {
  it("bounds stored entries while preserving monotonic sequence numbers", () => {
    let journal: LoopTraceJournal = [];

    for (
      let index = 0;
      index < LOOP_TRACE_JOURNAL_MAX_ENTRIES + 5;
      index += 1
    ) {
      journal = appendLoopTraceJournalEntry(journal, seedEntry(index + 1));
    }

    expect(journal).toHaveLength(LOOP_TRACE_JOURNAL_MAX_ENTRIES);
    expect(journal[0]?.sequence).toBe(6);
    expect(journal.at(-1)?.sequence).toBe(LOOP_TRACE_JOURNAL_MAX_ENTRIES + 5);
  });

  it("builds preview metadata from the bounded journal", () => {
    let journal: LoopTraceJournal = [];

    for (
      let index = 0;
      index < LOOP_TRACE_JOURNAL_MAX_ENTRIES + 2;
      index += 1
    ) {
      journal = appendLoopTraceJournalEntry(journal, seedEntry(index + 1));
    }

    const preview = buildLoopTraceJournalPreview(journal);

    expect(preview).toMatchObject({
      total_entries: LOOP_TRACE_JOURNAL_MAX_ENTRIES + 2,
      stored_entries: LOOP_TRACE_JOURNAL_MAX_ENTRIES,
      truncated: true,
    });
    expect(preview.entries).toHaveLength(5);
    expect(preview.entries[0]?.sequence).toBe(
      LOOP_TRACE_JOURNAL_MAX_ENTRIES - 2,
    );
    expect(preview.entries.at(-1)?.sequence).toBe(
      LOOP_TRACE_JOURNAL_MAX_ENTRIES + 2,
    );
  });

  it("skips malformed artifact lines and unknown event kinds", async () => {
    const workspaceRoot = mkdtempSync(join(tmpdir(), "symph-loop-trace-"));
    try {
      const traceDirectory = join(workspaceRoot, ".symphony", "loop-traces");
      const storedEntry = { ...seedEntry(1), sequence: 1 };
      mkdirSync(traceDirectory, { recursive: true });
      writeFileSync(
        join(traceDirectory, "issue-1.jsonl"),
        [
          JSON.stringify(storedEntry),
          "{not valid json",
          JSON.stringify({
            ...seedEntry(2),
            sequence: 2,
            kind: "unknown_kind",
          }),
          JSON.stringify({
            ...seedEntry(3),
            sequence: 3,
            prompt: "not an object",
          }),
          "",
        ].join("\n"),
      );

      await expect(
        readLoopTraceJournal({
          workspaceRoot,
          workspaceKey: "issue-1",
        }),
      ).resolves.toEqual([storedEntry]);
    } finally {
      rmSync(workspaceRoot, { recursive: true, force: true });
    }
  });
});

function seedEntry(sequence: number) {
  return {
    timestamp: `2026-03-06T00:00:${String(sequence).padStart(2, "0")}.000Z`,
    kind: "feedback_event" as const,
    issueId: "issue-1",
    issueIdentifier: "ISSUE-1",
    stage: "implement",
    attempt: null,
    sessionId: "thread-1-turn-1",
    summary: `entry ${sequence}`,
  };
}
