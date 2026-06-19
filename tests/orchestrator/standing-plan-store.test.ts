import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import type {
  PlanBatch,
  PlanDecision,
  PlanEnvelope,
} from "../../src/domain/standing-plan.js";
import { appendStandingPlanJournalEntriesWithLock } from "../../src/logging/standing-plan-journal.js";
import {
  listHonoredDecisions,
  loadStandingPlan,
  recordPlanDecision,
  recordPlanRevision,
} from "../../src/orchestrator/standing-plan-store.js";
import type { PlanBody } from "../../src/orchestrator/standing-plan-supersession.js";

const ENVELOPE: PlanEnvelope = {
  version: 1,
  concurrencyCeiling: 3,
  allowedRisk: "medium",
  allowedModes: ["parallel-isolated"],
};

function lookahead(id: string, identifier: string): PlanBatch {
  return {
    batchId: id,
    mode: "parallel-isolated",
    status: "lookahead",
    members: [{ issueId: id, issueIdentifier: identifier }],
    rationale: "r",
    canary: null,
  };
}

function body(batches: PlanBatch[]): PlanBody {
  return {
    batches,
    options: [{ marker: "[opt-1]", label: "Release", intent: null }],
    envelope: ENVELOPE,
    rationale: "rationale",
    source: "planner",
  };
}

function tmpRoot(): string {
  return mkdtempSync(join(tmpdir(), "symph-standing-plan-store-"));
}

describe("standing-plan store", () => {
  it("returns null when no plan has been recorded", async () => {
    const root = tmpRoot();
    try {
      expect(await loadStandingPlan(root)).toBeNull();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("persists a revision and projects it back after a restart", async () => {
    const root = tmpRoot();
    try {
      const result = await recordPlanRevision(
        root,
        body([lookahead("b1", "SYMPH-1")]),
        { planId: "plan-1", createdAt: "2026-06-18T00:00:00.000Z" },
      );
      expect(result.recorded).toBe(true);
      expect(result.plan.revision).toBe(1);

      // Fresh read = restart.
      const reloaded = await loadStandingPlan(root);
      expect(reloaded?.revision).toBe(1);
      expect(reloaded?.batches.map((batch) => batch.batchId)).toEqual(["b1"]);
      expect(reloaded?.options[0]?.marker).toBe("[opt-1]");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("is idempotent: re-recording an unchanged body does not rotate the revision", async () => {
    const root = tmpRoot();
    try {
      await recordPlanRevision(root, body([lookahead("b1", "SYMPH-1")]), {
        planId: "plan-1",
        createdAt: "2026-06-18T00:00:00.000Z",
      });
      const again = await recordPlanRevision(
        root,
        body([lookahead("b1", "SYMPH-1")]),
        { createdAt: "2026-06-18T00:10:00.000Z" },
      );
      expect(again.recorded).toBe(false);
      expect(again.plan.revision).toBe(1);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("rotates the revision when the plan body changes", async () => {
    const root = tmpRoot();
    try {
      await recordPlanRevision(root, body([lookahead("b1", "SYMPH-1")]), {
        planId: "plan-1",
        createdAt: "2026-06-18T00:00:00.000Z",
      });
      const changed = await recordPlanRevision(
        root,
        body([lookahead("b2", "SYMPH-2")]),
        { createdAt: "2026-06-18T00:01:00.000Z" },
      );
      expect(changed.recorded).toBe(true);
      expect(changed.plan.revision).toBe(2);
      expect((await loadStandingPlan(root))?.batches[0]?.batchId).toBe("b2");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("records an operator decision bound to the current revision", async () => {
    const root = tmpRoot();
    try {
      await recordPlanRevision(root, body([lookahead("b1", "SYMPH-1")]), {
        planId: "plan-1",
        createdAt: "2026-06-18T00:00:00.000Z",
      });
      const decision: PlanDecision = {
        decisionId: "d1",
        planId: "plan-1",
        revision: 1,
        batchId: "b1",
        kind: "approve",
        actor: "eric@litman.org",
        optionMarker: "[opt-1]",
        createdAt: "2026-06-18T00:00:30.000Z",
        note: null,
      };
      const result = await recordPlanDecision(root, decision);
      expect(result.recorded).toBe(true);
      const honored = await listHonoredDecisions(root);
      expect(honored.map((entry) => entry.decisionId)).toEqual(["d1"]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("rejects a decision bound to a superseded revision", async () => {
    const root = tmpRoot();
    try {
      await recordPlanRevision(root, body([lookahead("b1", "SYMPH-1")]), {
        planId: "plan-1",
        createdAt: "2026-06-18T00:00:00.000Z",
      });
      await recordPlanRevision(root, body([lookahead("b2", "SYMPH-2")]), {
        createdAt: "2026-06-18T00:01:00.000Z",
      });
      // Decision against the now-superseded revision 1.
      const stale: PlanDecision = {
        decisionId: "d-stale",
        planId: "plan-1",
        revision: 1,
        batchId: "b1",
        kind: "approve",
        actor: "eric@litman.org",
        optionMarker: "[opt-1]",
        createdAt: "2026-06-18T00:02:00.000Z",
        note: null,
      };
      const result = await recordPlanDecision(root, stale);
      expect(result.recorded).toBe(false);
      expect(result.reason).toBe("stale_revision");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("carries an in-flight batch forward immutably across a re-plan", async () => {
    const root = tmpRoot();
    try {
      // Seed a revision that already has an in-flight (committed) batch by
      // writing it directly to the journal, simulating a PR2 dispatch.
      const inFlight: PlanBatch = {
        batchId: "live",
        mode: "parallel-isolated",
        status: "in_flight",
        members: [{ issueId: "live", issueIdentifier: "SYMPH-100" }],
        rationale: "running",
        canary: null,
      };
      await appendStandingPlanJournalEntriesWithLock(root, [
        {
          kind: "plan_revision",
          idempotencyKey: "plan-1:rev:1",
          timestamp: "2026-06-18T00:00:00.000Z",
          planId: "plan-1",
          revision: {
            revision: 1,
            planId: "plan-1",
            contentHash: "seed",
            supersedes: null,
            createdAt: "2026-06-18T00:00:00.000Z",
            envelope: ENVELOPE,
            batches: [inFlight, lookahead("old", "SYMPH-9")],
            options: [],
            rationale: "seed",
            source: "planner",
          },
        },
      ]);

      const replan = await recordPlanRevision(
        root,
        body([lookahead("new", "SYMPH-2")]),
        { createdAt: "2026-06-18T00:01:00.000Z" },
      );
      expect(replan.recorded).toBe(true);
      const plan = await loadStandingPlan(root);
      expect(plan?.batches.map((batch) => batch.batchId)).toEqual([
        "live",
        "new",
      ]);
      expect(plan?.batches.find((batch) => batch.batchId === "live")).toEqual(
        inFlight,
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("serializes concurrent re-plans so neither distinct body is dropped", async () => {
    const root = tmpRoot();
    try {
      const [a, b] = await Promise.all([
        recordPlanRevision(root, body([lookahead("b1", "SYMPH-1")]), {
          planId: "plan-1",
          createdAt: "2026-06-18T00:00:00.000Z",
        }),
        recordPlanRevision(root, body([lookahead("b2", "SYMPH-2")]), {
          planId: "plan-1",
          createdAt: "2026-06-18T00:00:01.000Z",
        }),
      ]);
      // Both distinct bodies must land as distinct, monotonically-rotated
      // revisions — neither silently dropped on a colliding revision id.
      expect(a.recorded).toBe(true);
      expect(b.recorded).toBe(true);
      expect([a.plan.revision, b.plan.revision].sort()).toEqual([1, 2]);
      const plan = await loadStandingPlan(root);
      expect(plan?.revision).toBe(2);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("records a decision idempotently (recorded=false on replay)", async () => {
    const root = tmpRoot();
    try {
      await recordPlanRevision(root, body([lookahead("b1", "SYMPH-1")]), {
        planId: "plan-1",
        createdAt: "2026-06-18T00:00:00.000Z",
      });
      const decision: PlanDecision = {
        decisionId: "d1",
        planId: "plan-1",
        revision: 1,
        batchId: "b1",
        kind: "approve",
        actor: "eric@litman.org",
        optionMarker: "[opt-1]",
        createdAt: "2026-06-18T00:00:30.000Z",
        note: null,
      };
      const first = await recordPlanDecision(root, decision);
      const replay = await recordPlanDecision(root, decision);
      expect(first.recorded).toBe(true);
      expect(replay.recorded).toBe(false);
      expect((await listHonoredDecisions(root)).length).toBe(1);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
