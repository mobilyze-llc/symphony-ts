import { readFileSync } from "node:fs";
import { join } from "node:path";
import { gunzipSync } from "node:zlib";

import { describe, expect, it } from "vitest";

import {
  isValidPlanBatch,
  normalizePlanBatch,
} from "../../src/domain/plan-batch.js";
import {
  type PlanRevision,
  type StandingPlan,
  isStandingPlanJournalEntry,
} from "../../src/domain/standing-plan.js";
import { selectDispatchableBatchMembers } from "../../src/orchestrator/standing-plan-consumer.js";
import { legacyIsPlanBatch } from "../helpers/plan-batch-legacy.js";

interface RevisionFixture {
  kind: "plan_revision";
  timestamp: string;
  revision: PlanRevision;
}

const FIXTURE_PATH = join(
  process.cwd(),
  "tests/fixtures/standing-plan-journal.jsonl.gz",
);
const FIXTURE_REVISION_COUNT = 135;
const FIXTURE_BATCH_COUNT = 327;

function readFixtureRows(): unknown[] {
  return gunzipSync(readFileSync(FIXTURE_PATH))
    .toString("utf8")
    .trim()
    .split("\n")
    .filter((line) => line.trim() !== "")
    .map((line) => JSON.parse(line) as unknown);
}

function revisionRows(rows: readonly unknown[]): RevisionFixture[] {
  return rows.filter(isRevisionFixture);
}

function isRevisionFixture(value: unknown): value is RevisionFixture {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    (value as { kind?: unknown }).kind === "plan_revision"
  );
}

function standingPlanFromRevision(row: RevisionFixture): StandingPlan {
  return {
    planId: row.revision.planId,
    revision: row.revision.revision,
    contentHash: row.revision.contentHash,
    envelope: row.revision.envelope,
    batches: row.revision.batches,
    dependencyEdges: row.revision.dependencyEdges ?? [],
    options: row.revision.options,
    rationale: row.revision.rationale,
    createdAt: row.revision.createdAt,
    updatedAt: row.timestamp,
  };
}

describe("PlanBatchSchema journal replay", () => {
  it("keeps the wired read edge equivalent to the legacy batch predicate", () => {
    const rows = readFixtureRows();
    let batchCount = 0;

    for (const row of rows) {
      expect(isStandingPlanJournalEntry(row)).toBe(true);
      if (!isRevisionFixture(row)) {
        continue;
      }
      for (const batch of row.revision.batches) {
        batchCount += 1;
        expect(isValidPlanBatch(batch)).toBe(legacyIsPlanBatch(batch));
      }
    }

    expect(rows).toHaveLength(FIXTURE_REVISION_COUNT);
    expect(batchCount).toBe(FIXTURE_BATCH_COUNT);
  });

  it("replays recorded batches through the write normalizer byte-for-byte", () => {
    const revisions = revisionRows(readFixtureRows());
    let batchCount = 0;

    for (const { revision } of revisions) {
      for (const batch of revision.batches) {
        batchCount += 1;
        expect(batch.status).toBe("lookahead");
        const normalized = normalizePlanBatch(
          {
            mode: batch.mode,
            rationale: batch.rationale,
            canary: batch.canary,
          },
          batch.members,
          { allowedModes: revision.envelope.allowedModes },
        );
        expect(normalized.ok).toBe(true);
        if (normalized.ok) {
          expect(normalized.batch).toEqual(batch);
        }
      }
    }

    expect(revisions).toHaveLength(FIXTURE_REVISION_COUNT);
    expect(batchCount).toBe(FIXTURE_BATCH_COUNT);
  });

  it("does not trip the consumer projected-plan assertion over the corpus", () => {
    const revisions = revisionRows(readFixtureRows());

    for (const row of revisions) {
      const plan = standingPlanFromRevision(row);
      expect(() =>
        selectDispatchableBatchMembers({
          plan,
          honoredApprovals: [],
          runningIssueIdentifiers: new Set(),
          autoReleaseFrontier: Number.MAX_SAFE_INTEGER,
          envelope: plan.envelope,
          mergedIssueIdentifiers: new Set(),
        }),
      ).not.toThrow();
    }

    expect(revisions).toHaveLength(FIXTURE_REVISION_COUNT);
  });
});
