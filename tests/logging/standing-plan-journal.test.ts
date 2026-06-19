import { promises as fs, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import type {
  PlanRevision,
  StandingPlanJournalEntryDraft,
} from "../../src/domain/standing-plan.js";
import {
  appendStandingPlanJournalEntriesWithLock,
  getStandingPlanJournalPath,
  readStandingPlanJournal,
} from "../../src/logging/standing-plan-journal.js";

function createRevision(revision: number): PlanRevision {
  return {
    revision,
    planId: "plan-1",
    contentHash: `hash-${revision}`,
    supersedes: revision > 1 ? revision - 1 : null,
    createdAt: "2026-06-18T00:00:00.000Z",
    envelope: {
      version: 1,
      concurrencyCeiling: 3,
      allowedRisk: "medium",
      allowedModes: ["parallel-isolated"],
    },
    batches: [
      {
        batchId: `batch-${revision}`,
        mode: "parallel-isolated",
        status: "lookahead",
        members: [{ issueId: "i1", issueIdentifier: "SYMPH-1" }],
        rationale: "top priority",
        canary: null,
      },
    ],
    options: [{ marker: "[opt-1]", label: "Release batch", intent: null }],
    rationale: "plan rationale",
    source: "planner",
  };
}

function revisionDraft(revision: number): StandingPlanJournalEntryDraft {
  return {
    kind: "plan_revision",
    idempotencyKey: `plan-1:rev:${revision}`,
    timestamp: "2026-06-18T00:00:00.000Z",
    planId: "plan-1",
    revision: createRevision(revision),
  };
}

describe("standing-plan journal", () => {
  it("appends revisions and reads them back sorted by monotonic sequence", async () => {
    const root = mkdtempSync(join(tmpdir(), "symph-standing-plan-"));
    try {
      await appendStandingPlanJournalEntriesWithLock(root, [
        revisionDraft(1),
        revisionDraft(2),
      ]);

      const journal = await readStandingPlanJournal(root);
      expect(journal.map((entry) => entry.sequence)).toEqual([1, 2]);
      expect(journal[0]?.kind).toBe("plan_revision");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("survives a restart: a fresh read sees prior appends", async () => {
    const root = mkdtempSync(join(tmpdir(), "symph-standing-plan-"));
    try {
      await appendStandingPlanJournalEntriesWithLock(root, [revisionDraft(1)]);
      // Simulate a restart: read fresh from disk, no in-memory carry.
      const reloaded = await readStandingPlanJournal(root);
      expect(reloaded).toHaveLength(1);
      const entry = reloaded[0];
      expect(entry?.kind).toBe("plan_revision");
      if (entry?.kind === "plan_revision") {
        expect(entry.revision.revision).toBe(1);
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("deduplicates entries by idempotency key across separate appends", async () => {
    const root = mkdtempSync(join(tmpdir(), "symph-standing-plan-"));
    try {
      const first = await appendStandingPlanJournalEntriesWithLock(root, [
        revisionDraft(1),
      ]);
      const second = await appendStandingPlanJournalEntriesWithLock(root, [
        revisionDraft(1),
      ]);

      expect(first.appendedEntries).toHaveLength(1);
      expect(second.appendedEntries).toHaveLength(0);
      expect(second.skippedEntries).toHaveLength(1);
      const journal = await readStandingPlanJournal(root);
      expect(journal).toHaveLength(1);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("ignores malformed rows so one bad line does not block recovery", async () => {
    const root = mkdtempSync(join(tmpdir(), "symph-standing-plan-"));
    try {
      await appendStandingPlanJournalEntriesWithLock(root, [revisionDraft(1)]);
      await fs.appendFile(
        getStandingPlanJournalPath(root),
        "this is not json\n",
        "utf8",
      );

      const journal = await readStandingPlanJournal(root);
      expect(journal).toHaveLength(1);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
