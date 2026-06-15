import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import type { LoopTraceJournal } from "../../src/domain/model.js";
import {
  LOOP_TRACE_ARTIFACT_RETENTION_MAX_FILES,
  LOOP_TRACE_JOURNAL_MAX_ENTRIES,
  appendLoopTraceJournalEntry,
  buildLoopTraceJournalPreview,
  buildLoopTraceJournalResponse,
  findLoopTraceJournalByIssueIdentifier,
  getLoopTraceIssueIndexPath,
  readLoopTraceJournal,
  writeLoopTraceJournal,
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

  it("preserves unavailable continuous-feedback entries after persistence", async () => {
    const workspaceRoot = mkdtempSync(join(tmpdir(), "symph-loop-trace-"));
    try {
      const entry: LoopTraceJournal[number] = {
        ...seedEntry(1),
        sequence: 1,
        kind: "continuous_feedback",
        summary:
          'Continuous feedback unavailable. Continuous feedback provider exited with 1: Error: Model "local-flash" not found.',
        continuousFeedback: {
          event: "checkpoint",
          status: "unavailable",
          unavailableSummary:
            'Continuous feedback provider exited with 1: Error: Model "local-flash" not found.',
          reviewerRunner: "pi",
          reviewerModel: "local-flash",
          findingSignatures: [],
        },
      };

      await writeLoopTraceJournal(
        {
          workspaceRoot,
          workspaceKey: "issue-1",
        },
        [entry],
      );

      await expect(
        readLoopTraceJournal({
          workspaceRoot,
          workspaceKey: "issue-1",
        }),
      ).resolves.toEqual([entry]);
      expect(
        buildLoopTraceJournalResponse([entry], {
          workspaceRoot,
          workspaceKey: "issue-1",
        }).entries[0],
      ).toMatchObject({
        continuous_feedback: {
          status: "unavailable",
          unavailable_summary:
            'Continuous feedback provider exited with 1: Error: Model "local-flash" not found.',
        },
      });
    } finally {
      rmSync(workspaceRoot, { recursive: true, force: true });
    }
  });

  it("uses the issue index for cold identifier lookup", async () => {
    const workspaceRoot = mkdtempSync(join(tmpdir(), "symph-loop-index-"));
    try {
      const completedEntry = {
        ...seedEntry(1),
        sequence: 1,
        issueIdentifier: "ISSUE-1",
      };
      const failedEntry = {
        ...seedEntry(2),
        sequence: 2,
        issueIdentifier: "ISSUE-2",
        stageTransition: {
          from: "implement",
          to: null,
          status: "failed",
        },
      };
      await writeLoopTraceJournal(
        {
          workspaceRoot,
          workspaceKey: "issue-1",
        },
        [completedEntry, failedEntry],
      );

      await expect(
        findLoopTraceJournalByIssueIdentifier(workspaceRoot, "ISSUE-1"),
      ).resolves.toMatchObject({
        artifactPath: join(
          workspaceRoot,
          ".symphony",
          "loop-traces",
          "issue-1.jsonl",
        ),
        journal: [completedEntry, failedEntry],
      });
      await expect(
        findLoopTraceJournalByIssueIdentifier(workspaceRoot, "ISSUE-2"),
      ).resolves.toMatchObject({
        journal: [completedEntry, failedEntry],
      });

      const index = JSON.parse(
        readFileSync(getLoopTraceIssueIndexPath(workspaceRoot), "utf8"),
      ) as {
        entries: Record<string, { issueId: string; artifact: string }>;
      };
      expect(index.entries["ISSUE-1"]).toEqual({
        issueId: "issue-1",
        artifact: "issue-1.jsonl",
        updatedAt: failedEntry.timestamp,
      });
      expect(index.entries["ISSUE-2"]).toEqual({
        issueId: "issue-1",
        artifact: "issue-1.jsonl",
        updatedAt: failedEntry.timestamp,
      });
    } finally {
      rmSync(workspaceRoot, { recursive: true, force: true });
    }
  });

  it("does not scan unindexed artifacts for missing identifiers", async () => {
    const workspaceRoot = mkdtempSync(join(tmpdir(), "symph-loop-missing-"));
    try {
      const traceDirectory = join(workspaceRoot, ".symphony", "loop-traces");
      mkdirSync(traceDirectory, { recursive: true });
      writeFileSync(
        join(traceDirectory, "orphan.jsonl"),
        `${JSON.stringify({
          ...seedEntry(1),
          sequence: 1,
          issueIdentifier: "ORPHAN-1",
        })}\n`,
      );

      await expect(
        findLoopTraceJournalByIssueIdentifier(workspaceRoot, "ORPHAN-1"),
      ).resolves.toBeNull();
    } finally {
      rmSync(workspaceRoot, { recursive: true, force: true });
    }
  });

  it("keeps valid index entries when neighboring entries are malformed", async () => {
    const workspaceRoot = mkdtempSync(
      join(tmpdir(), "symph-loop-mixed-index-"),
    );
    try {
      const traceDirectory = join(workspaceRoot, ".symphony", "loop-traces");
      mkdirSync(traceDirectory, { recursive: true });
      const goodEntry = {
        ...seedEntry(1),
        sequence: 1,
        issueId: "good",
        issueIdentifier: "GOOD-1",
      };
      writeFileSync(
        join(traceDirectory, "good.jsonl"),
        `${JSON.stringify(goodEntry)}\n`,
      );
      writeFileSync(
        getLoopTraceIssueIndexPath(workspaceRoot),
        `${JSON.stringify({
          version: 1,
          entries: {
            "GOOD-1": {
              issueId: "good",
              artifact: "good.jsonl",
              updatedAt: goodEntry.timestamp,
            },
            "BAD-1": {
              issueId: "bad",
              artifact: "../bad.jsonl",
              updatedAt: goodEntry.timestamp,
            },
            "BAD-2": "not an index entry",
          },
        })}\n`,
      );

      await expect(
        findLoopTraceJournalByIssueIdentifier(workspaceRoot, "GOOD-1"),
      ).resolves.toMatchObject({
        journal: [goodEntry],
      });
      await expect(
        findLoopTraceJournalByIssueIdentifier(workspaceRoot, "BAD-1"),
      ).resolves.toBeNull();
      await expect(
        findLoopTraceJournalByIssueIdentifier(workspaceRoot, "BAD-2"),
      ).resolves.toBeNull();
    } finally {
      rmSync(workspaceRoot, { recursive: true, force: true });
    }
  });

  it("rebuilds a corrupt issue index on the next journal write", async () => {
    const workspaceRoot = mkdtempSync(join(tmpdir(), "symph-loop-corrupt-"));
    try {
      const traceDirectory = join(workspaceRoot, ".symphony", "loop-traces");
      mkdirSync(traceDirectory, { recursive: true });
      writeFileSync(getLoopTraceIssueIndexPath(workspaceRoot), "{not json");

      const entry = {
        ...seedEntry(1),
        sequence: 1,
        issueId: "issue-1",
        issueIdentifier: "ISSUE-1",
      };
      await writeLoopTraceJournal(
        {
          workspaceRoot,
          workspaceKey: "issue-1",
        },
        [entry],
      );

      await expect(
        findLoopTraceJournalByIssueIdentifier(workspaceRoot, "ISSUE-1"),
      ).resolves.toMatchObject({
        journal: [entry],
      });
    } finally {
      rmSync(workspaceRoot, { recursive: true, force: true });
    }
  });

  it("preserves issue index entries across concurrent journal writes", async () => {
    const workspaceRoot = mkdtempSync(join(tmpdir(), "symph-loop-concurrent-"));
    try {
      const issueCount = 20;
      await Promise.all(
        Array.from({ length: issueCount }, async (_, index) => {
          const issueId = `issue-${index}`;
          const issueIdentifier = `ISSUE-${index}`;
          await writeLoopTraceJournal(
            {
              workspaceRoot,
              workspaceKey: issueId,
            },
            [
              {
                ...seedEntry(index + 1),
                sequence: 1,
                issueId,
                issueIdentifier,
              },
            ],
          );
        }),
      );

      const issueIndex = JSON.parse(
        readFileSync(getLoopTraceIssueIndexPath(workspaceRoot), "utf8"),
      ) as {
        entries: Record<string, { issueId: string; artifact: string }>;
      };
      expect(Object.keys(issueIndex.entries)).toHaveLength(issueCount);

      for (let index = 0; index < issueCount; index += 1) {
        const issueId = `issue-${index}`;
        const issueIdentifier = `ISSUE-${index}`;
        expect(issueIndex.entries[issueIdentifier]).toEqual(
          expect.objectContaining({
            issueId,
            artifact: `${issueId}.jsonl`,
          }),
        );
        await expect(
          findLoopTraceJournalByIssueIdentifier(workspaceRoot, issueIdentifier),
        ).resolves.toMatchObject({
          artifactPath: join(
            workspaceRoot,
            ".symphony",
            "loop-traces",
            `${issueId}.jsonl`,
          ),
        });
      }
    } finally {
      rmSync(workspaceRoot, { recursive: true, force: true });
    }
  });

  it("prunes old artifacts and removes their index entries", async () => {
    const workspaceRoot = mkdtempSync(join(tmpdir(), "symph-loop-retain-"));
    try {
      const traceDirectory = join(workspaceRoot, ".symphony", "loop-traces");
      mkdirSync(traceDirectory, { recursive: true });
      const oldDate = new Date("2026-03-06T00:00:00.000Z");
      const newerDate = new Date("2026-03-06T00:01:00.000Z");
      for (
        let index = 0;
        index < LOOP_TRACE_ARTIFACT_RETENTION_MAX_FILES;
        index += 1
      ) {
        const filename = `old-${index}.jsonl`;
        writeFileSync(
          join(traceDirectory, filename),
          `${JSON.stringify({
            ...seedEntry(index + 1),
            sequence: 1,
            issueIdentifier: `OLD-${index}`,
          })}\n`,
        );
        const timestamp = index === 0 ? oldDate : newerDate;
        utimesSync(join(traceDirectory, filename), timestamp, timestamp);
      }
      writeFileSync(
        getLoopTraceIssueIndexPath(workspaceRoot),
        `${JSON.stringify({
          version: 1,
          entries: {
            "OLD-0": {
              issueId: "old-0",
              artifact: "old-0.jsonl",
              updatedAt: oldDate.toISOString(),
            },
          },
        })}\n`,
      );

      await writeLoopTraceJournal(
        {
          workspaceRoot,
          workspaceKey: "new",
        },
        [
          {
            ...seedEntry(1),
            sequence: 1,
            issueId: "new",
            issueIdentifier: "NEW-1",
          },
        ],
      );

      const artifacts = readdirSync(traceDirectory).filter((filename) =>
        filename.endsWith(".jsonl"),
      );
      expect(artifacts).toHaveLength(LOOP_TRACE_ARTIFACT_RETENTION_MAX_FILES);
      expect(artifacts).not.toContain("old-0.jsonl");
      expect(artifacts).toContain("new.jsonl");
      const index = JSON.parse(
        readFileSync(getLoopTraceIssueIndexPath(workspaceRoot), "utf8"),
      ) as { entries: Record<string, unknown> };
      expect(index.entries["OLD-0"]).toBeUndefined();
      expect(index.entries["NEW-1"]).toMatchObject({
        artifact: "new.jsonl",
      });
      await expect(
        findLoopTraceJournalByIssueIdentifier(workspaceRoot, "OLD-0"),
      ).resolves.toBeNull();
      await expect(
        findLoopTraceJournalByIssueIdentifier(workspaceRoot, "OLD-1"),
      ).resolves.toBeNull();
      await expect(
        findLoopTraceJournalByIssueIdentifier(workspaceRoot, "NEW-1"),
      ).resolves.toMatchObject({
        artifactPath: join(traceDirectory, "new.jsonl"),
      });
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
