import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

import type { ManagerRunJournal } from "../../src/domain/model.js";
import { isManagerRunJournalEntry } from "../../src/logging/manager-run-journal.js";
import {
  DEFAULT_MANAGER_RUN_STALE_AFTER_MS,
  reduceManagerRunJournal,
} from "../../src/orchestrator/manager-run.js";

describe("manager-run reducer", () => {
  it("replays a manager lane ledger into deterministic run state", () => {
    const journal = readFixture("019ea700-80b7-7032-8ef5-dd8e638f0205.jsonl");

    const runs = reduceManagerRunJournal(journal, {
      now: new Date("2026-06-08T13:00:00.000Z"),
      staleAfterMs: 2 * 60 * 60_000,
    });

    const run = runs["wave-1"];
    expect(run).toBeDefined();
    expect(run?.managerThreadId).toBe("019ea8a6-bc42-72a3-ade0-72be7663232e");
    expect(run?.modelCallPolicy.ledgerIsSourceOfTruth).toBe(true);
    expect(run?.lanes["lane-mob-53"]).toMatchObject({
      issueIdentifier: "MOB-53",
      status: "active",
      prStatus: "merged",
      validationArtifactIds: ["artifact-mob-53-tests"],
      reviewGateIds: ["gate-mob-53-review"],
    });
    expect(run?.lanes["lane-mob-63"]).toMatchObject({
      issueIdentifier: "MOB-63",
      status: "active",
      blockedBy: [],
      prStatus: "merged",
    });
    expect(run?.dependencies["dep-mob-63-after-mob-53"]?.unblocked).toBe(true);
    expect(run?.closeout).toEqual({
      ready: true,
      missingEvidence: [],
    });
  });

  it("tracks degraded review compensation, spawned follow-ups, and model-check limits", () => {
    const journal = readFixture("019ea74a-0df6-7983-bbff-60c7df539e80.jsonl");

    const runs = reduceManagerRunJournal(journal, {
      now: new Date("2026-06-08T13:55:00.000Z"),
    });

    const run = runs["wave-2"];
    expect(run).toBeDefined();
    expect(run?.reviewGates["gate-mob-87-review"]).toMatchObject({
      status: "degraded",
      compensationRequired: true,
      compensated: true,
    });
    expect(run?.followUps["SYMPH-262"]).toMatchObject({
      issueIdentifier: "SYMPH-262",
      parentIssueIdentifier: "MOB-87",
      laneId: "lane-mob-87",
    });
    expect(run?.modelCallPolicy.ledgerIsSourceOfTruth).toBe(true);
    expect(run?.modelCallPolicy.allowedReasons).toEqual([
      "ambiguity",
      "decision_quality_check",
    ]);
    expect(run?.modelCallPolicy.pendingChecks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          reason: "decision_quality_check",
          laneId: "lane-mob-87",
        }),
      ]),
    );
    expect(run?.modelCallPolicy.pendingChecks).toHaveLength(2);
    expect(run?.lanes["lane-mob-65"]).toMatchObject({
      status: "blocked",
      blockedBy: ["dep-mob-65-runtime-host-scope"],
    });
    expect(run?.closeout.ready).toBe(false);
    expect(run?.closeout.missingEvidence).toContain("lane:lane-mob-87:pr");
  });

  it("marks stale lanes deterministically without model authority", () => {
    const journal = readFixture("019ea74a-0df6-7983-bbff-60c7df539e80.jsonl");

    const runs = reduceManagerRunJournal(journal, {
      now: new Date(
        Date.parse("2026-06-08T13:05:00.000Z") +
          DEFAULT_MANAGER_RUN_STALE_AFTER_MS +
          1,
      ),
    });

    const lane = runs["wave-2"]?.lanes["lane-mob-87"];
    expect(lane?.status).toBe("degraded");
    expect(lane?.degradedReasons).toContain("stale_heartbeat");
    expect(runs["wave-2"]?.escalations).toContainEqual(
      expect.objectContaining({
        laneId: "lane-mob-87",
        kind: "stale_worker",
      }),
    );
  });
});

function readFixture(filename: string): ManagerRunJournal {
  const path = resolve(
    import.meta.dirname,
    "../fixtures/manager-runs",
    filename,
  );
  return readFileSync(path, "utf8")
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .map((line) => {
      const parsed = JSON.parse(line) as unknown;
      if (!isManagerRunJournalEntry(parsed)) {
        throw new Error(`Invalid fixture entry in ${filename}: ${line}`);
      }
      return parsed;
    });
}
