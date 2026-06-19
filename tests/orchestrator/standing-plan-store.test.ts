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
  recordPlanControlDecision,
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

  it("projects the last-WRITTEN revision by sequence, not the largest revision id", async () => {
    const root = tmpRoot();
    try {
      // rev id 3 written first (sequence 1), rev id 2 written second (seq 2).
      const mkRevision = (revision: number, identifier: string) => ({
        revision,
        planId: "plan-1",
        contentHash: `h${revision}`,
        supersedes: null,
        createdAt: "2026-06-18T00:00:00.000Z",
        envelope: ENVELOPE,
        batches: [lookahead(`b${revision}`, identifier)],
        options: [],
        rationale: "r",
        source: "planner" as const,
      });
      await appendStandingPlanJournalEntriesWithLock(root, [
        {
          kind: "plan_revision",
          idempotencyKey: "plan-1:rev:3",
          timestamp: "2026-06-18T00:00:00.000Z",
          planId: "plan-1",
          revision: mkRevision(3, "SYMPH-3"),
        },
        {
          kind: "plan_revision",
          idempotencyKey: "plan-1:rev:2",
          timestamp: "2026-06-18T00:01:00.000Z",
          planId: "plan-1",
          revision: mkRevision(2, "SYMPH-2"),
        },
      ]);
      // The last-written (sequence 2 → revision id 2) is current, not rev id 3.
      expect((await loadStandingPlan(root))?.revision).toBe(2);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("recordPlanControlDecision resolves planId and records an approval (SYMPH-789)", async () => {
    const root = tmpRoot();
    try {
      await recordPlanRevision(root, body([lookahead("b1", "SYMPH-1")]), {
        planId: "plan-1",
        createdAt: "2026-06-18T00:00:00.000Z",
      });
      const result = await recordPlanControlDecision(root, {
        kind: "approve",
        revision: 1,
        batchId: "b1",
        actor: "operator@pro14",
        note: "release it",
        decisionId: "release_batch:b1:rev1:operator@pro14",
        createdAt: "2026-06-18T00:00:30.000Z",
      });
      expect(result.recorded).toBe(true);
      const honored = await listHonoredDecisions(root);
      expect(honored[0]?.kind).toBe("approve");
      expect(honored[0]?.planId).toBe("plan-1");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("recordPlanControlDecision rejects a stale-revision action and reports no_plan", async () => {
    const root = tmpRoot();
    try {
      // no plan yet → no_plan
      const noPlan = await recordPlanControlDecision(root, {
        kind: "approve",
        revision: 1,
        batchId: "b1",
        actor: "operator@pro14",
        note: "x",
        decisionId: "d0",
        createdAt: "2026-06-18T00:00:00.000Z",
      });
      expect(noPlan.reason).toBe("no_plan");

      await recordPlanRevision(root, body([lookahead("b1", "SYMPH-1")]), {
        planId: "plan-1",
        createdAt: "2026-06-18T00:00:00.000Z",
      });
      await recordPlanRevision(root, body([lookahead("b2", "SYMPH-2")]), {
        createdAt: "2026-06-18T00:01:00.000Z",
      });
      const stale = await recordPlanControlDecision(root, {
        kind: "approve",
        revision: 1, // superseded by rev 2
        batchId: "b1",
        actor: "operator@pro14",
        note: "x",
        decisionId: "d-stale",
        createdAt: "2026-06-18T00:02:00.000Z",
      });
      expect(stale.recorded).toBe(false);
      expect(stale.reason).toBe("stale_revision");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("recordPlanControlDecision rejects an unknown batchId (no false-positive control state)", async () => {
    const root = tmpRoot();
    try {
      await recordPlanRevision(root, body([lookahead("b1", "SYMPH-1")]), {
        planId: "plan-1",
        createdAt: "2026-06-18T00:00:00.000Z",
      });
      const result = await recordPlanControlDecision(root, {
        kind: "approve",
        revision: 1,
        batchId: "does-not-exist",
        actor: "operator@pro14",
        note: "x",
        decisionId: "d-ghost",
        createdAt: "2026-06-18T00:00:30.000Z",
      });
      expect(result.recorded).toBe(false);
      expect(result.reason).toBe("batch_not_found");
      expect((await listHonoredDecisions(root)).length).toBe(0);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("recordPlanControlDecision: a stale revision wins over an unknown batchId (precedence)", async () => {
    const root = tmpRoot();
    try {
      await recordPlanRevision(root, body([lookahead("b1", "SYMPH-1")]), {
        planId: "plan-1",
        createdAt: "2026-06-18T00:00:00.000Z",
      });
      await recordPlanRevision(root, body([lookahead("b2", "SYMPH-2")]), {
        createdAt: "2026-06-18T00:01:00.000Z",
      });
      // Revision 1 is superseded AND "b1" is not in the current (rev 2) plan;
      // the revision binding must take precedence over batch_not_found.
      const result = await recordPlanControlDecision(root, {
        kind: "approve",
        revision: 1,
        batchId: "b1",
        actor: "operator@pro14",
        note: "x",
        decisionId: "d-stale-unknown",
        createdAt: "2026-06-18T00:02:00.000Z",
      });
      expect(result.reason).toBe("stale_revision");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
