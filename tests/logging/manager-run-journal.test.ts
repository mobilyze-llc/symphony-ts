import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import type {
  ManagerRunJournal,
  ManagerRunStartedEntry,
} from "../../src/domain/model.js";
import {
  appendManagerRunJournalEntry,
  appendManagerRunJournalEntryToDisk,
  getManagerRunJournalPath,
  readManagerRunJournal,
} from "../../src/logging/manager-run-journal.js";

describe("manager run journal", () => {
  it("appends entries with monotonic sequence numbers and idempotency keys", () => {
    let journal: ManagerRunJournal = [];
    const first = appendManagerRunJournalEntry(
      journal,
      seedStartEntry("run-1"),
    );
    journal = first.journal;
    const duplicate = appendManagerRunJournalEntry(
      journal,
      seedStartEntry("run-1"),
    );
    const second = appendManagerRunJournalEntry(
      duplicate.journal,
      seedStartEntry("run-2"),
    );

    expect(first.appended).toBe(true);
    expect(first.entry.sequence).toBe(1);
    expect(duplicate.appended).toBe(false);
    expect(duplicate.entry.sequence).toBe(1);
    expect(second.entry.sequence).toBe(2);
    expect(second.journal).toHaveLength(2);
  });

  it("reads valid JSONL entries and skips malformed or unknown rows", async () => {
    const workspaceRoot = mkdtempSync(join(tmpdir(), "symph-manager-run-"));
    try {
      const artifactPath = getManagerRunJournalPath(workspaceRoot);
      mkdirSync(join(workspaceRoot, ".symphony", "run-journals"), {
        recursive: true,
      });
      const entry = { ...seedStartEntry("run-1"), sequence: 2 };
      writeFileSync(
        artifactPath,
        [
          JSON.stringify({ ...entry, type: "unknown" }),
          "{not json",
          JSON.stringify(entry),
          "",
        ].join("\n"),
      );

      await expect(readManagerRunJournal(workspaceRoot)).resolves.toEqual([
        entry,
      ]);
    } finally {
      rmSync(workspaceRoot, { recursive: true, force: true });
    }
  });

  it("writes entries to the manager-run journal path", async () => {
    const workspaceRoot = mkdtempSync(join(tmpdir(), "symph-manager-write-"));
    try {
      const entry = { ...seedStartEntry("run-1"), sequence: 1 };
      await appendManagerRunJournalEntryToDisk(workspaceRoot, entry);

      expect(
        readFileSync(getManagerRunJournalPath(workspaceRoot), "utf8"),
      ).toBe(`${JSON.stringify(entry)}\n`);
    } finally {
      rmSync(workspaceRoot, { recursive: true, force: true });
    }
  });
});

function seedStartEntry(
  runId: string,
): Omit<ManagerRunStartedEntry, "sequence"> {
  return {
    idempotencyKey: `${runId}:start`,
    timestamp: "2026-06-08T12:00:00.000Z",
    runId,
    sourceSessionId: "019ea700-80b7-7032-8ef5-dd8e638f0205",
    summary: "Manager run started.",
    type: "manager_run_started",
    managerThreadId: "019ea8a6-bc42-72a3-ade0-72be7663232e",
    title: "Manager run",
  };
}
