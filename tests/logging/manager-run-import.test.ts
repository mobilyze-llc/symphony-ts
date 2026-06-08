import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

import type { ManagerRunJournal } from "../../src/domain/model.js";
import {
  importManagerRunLedger,
  parseManagerRunImportLedger,
  renderManagerRunJournalJsonl,
} from "../../src/logging/manager-run-import.js";
import { isManagerRunJournalEntry } from "../../src/logging/manager-run-journal.js";
import { reduceManagerRunJournal } from "../../src/orchestrator/manager-run.js";

describe("manager-run import", () => {
  it("imports a sanitized lane ledger into valid manager-run journal rows", () => {
    const ledger = parseManagerRunImportLedger(
      readText(
        "../fixtures/manager-run-ledgers/019ea74a-0df6-7983-bbff-60c7df539e80.json",
      ),
    );

    const journal = importManagerRunLedger(ledger);

    expect(journal).toHaveLength(13);
    expect(journal.every((entry) => isManagerRunJournalEntry(entry))).toBe(
      true,
    );
    expect(renderManagerRunJournalJsonl(journal)).toContain(
      '"type":"review_gate_result"',
    );
  });

  it("replays to the same aggregate as the hand-curated MOB-87 fixture", () => {
    const ledger = parseManagerRunImportLedger(
      readText(
        "../fixtures/manager-run-ledgers/019ea74a-0df6-7983-bbff-60c7df539e80.json",
      ),
    );
    const importedJournal = importManagerRunLedger(ledger);
    const curatedJournal = readJsonlFixture(
      "../fixtures/manager-runs/019ea74a-0df6-7983-bbff-60c7df539e80.jsonl",
    );

    const importedRuns = reduceManagerRunJournal(importedJournal, {
      now: new Date("2026-06-08T13:55:00.000Z"),
    });
    const curatedRuns = reduceManagerRunJournal(curatedJournal, {
      now: new Date("2026-06-08T13:55:00.000Z"),
    });

    expect(importedRuns).toEqual(curatedRuns);
  });
});

function readText(relativePath: string): string {
  return readFileSync(resolve(import.meta.dirname, relativePath), "utf8");
}

function readJsonlFixture(relativePath: string): ManagerRunJournal {
  return readText(relativePath)
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .map((line) => {
      const parsed = JSON.parse(line) as unknown;
      if (!isManagerRunJournalEntry(parsed)) {
        throw new Error(`Invalid journal entry: ${line}`);
      }
      return parsed;
    });
}
