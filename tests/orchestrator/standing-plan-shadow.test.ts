import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import type { PlannerRunResult } from "../../src/agent/triage-planner.js";
import type { WorkflowQueueTriageConfig } from "../../src/config/types.js";
import type { Issue } from "../../src/domain/model.js";
import type { PlanEnvelope } from "../../src/domain/standing-plan.js";
import {
  assembleShadowPlannerContext,
  runShadowPlanCycle,
  runStandingPlanShadowTick,
  shouldRunShadowPlanCycle,
} from "../../src/orchestrator/standing-plan-shadow.js";
import { loadStandingPlan } from "../../src/orchestrator/standing-plan-store.js";

const ENVELOPE: PlanEnvelope = {
  version: 1,
  concurrencyCeiling: 2,
  allowedRisk: "medium",
  allowedModes: ["parallel-isolated"],
};

function issue(id: string, identifier: string): Issue {
  return {
    id,
    identifier,
    title: `Title ${identifier}`,
    description: null,
    priority: 1,
    state: "Todo",
    branchName: null,
    url: null,
    labels: [],
    blockedBy: [],
    createdAt: "2026-06-18T00:00:00.000Z",
    updatedAt: "2026-06-18T00:00:00.000Z",
  };
}

function okPlanner(): { runClaude: () => Promise<PlannerRunResult> } {
  return {
    runClaude: async () => ({
      status: "ok",
      markdown:
        '# Plan\n```json\n{"rationale":"go","batches":[{"mode":"parallel-isolated","issueIdentifiers":["SYMPH-1"],"rationale":"first"}]}\n```\n',
    }),
  };
}

describe("assembleShadowPlannerContext", () => {
  it("builds the backlog from candidates, excluding in-flight issues", () => {
    const context = assembleShadowPlannerContext({
      candidates: [issue("u1", "SYMPH-1"), issue("u2", "SYMPH-2")],
      inFlight: [{ issueIdentifier: "SYMPH-2", stage: "implement" }],
      envelope: ENVELOPE,
    });
    expect(context.backlog.map((c) => c.issueIdentifier)).toEqual(["SYMPH-1"]);
    expect(context.inFlight).toEqual([
      { issueIdentifier: "SYMPH-2", stage: "implement" },
    ]);
    expect(context.envelope).toBe(ENVELOPE);
  });

  it("carries recorded blockedBy identifiers onto the candidate (SYMPH-841)", () => {
    const blocked: Issue = {
      ...issue("u1", "SYMPH-1"),
      blockedBy: [{ id: "b1", identifier: "SYMPH-9", state: "Todo" }],
    };
    const context = assembleShadowPlannerContext({
      candidates: [blocked],
      inFlight: [],
      envelope: ENVELOPE,
    });
    expect(context.backlog[0]?.blockedBy).toEqual(["SYMPH-9"]);
  });
});

describe("shouldRunShadowPlanCycle", () => {
  it("runs when there is no plan yet", () => {
    expect(
      shouldRunShadowPlanCycle({ plan: null, nowMs: 1000, heartbeatMs: 100 }),
    ).toBe(true);
  });

  it("skips when the last plan is within the heartbeat window", () => {
    const plan = {
      planId: "p",
      revision: 1,
      contentHash: "h",
      envelope: ENVELOPE,
      batches: [],
      options: [],
      rationale: "r",
      createdAt: "2026-06-18T00:00:00.000Z",
      updatedAt: "2026-06-18T00:00:00.000Z",
    };
    const nowMs = Date.parse("2026-06-18T00:00:30.000Z");
    expect(shouldRunShadowPlanCycle({ plan, nowMs, heartbeatMs: 60_000 })).toBe(
      false,
    );
  });

  it("runs when the heartbeat window has elapsed", () => {
    const plan = {
      planId: "p",
      revision: 1,
      contentHash: "h",
      envelope: ENVELOPE,
      batches: [],
      options: [],
      rationale: "r",
      createdAt: "2026-06-18T00:00:00.000Z",
      updatedAt: "2026-06-18T00:00:00.000Z",
    };
    const nowMs = Date.parse("2026-06-18T00:20:00.000Z");
    expect(shouldRunShadowPlanCycle({ plan, nowMs, heartbeatMs: 60_000 })).toBe(
      true,
    );
  });

  it("uses the last planner run time when a no-op plan leaves updatedAt unchanged", () => {
    const plan = {
      planId: "p",
      revision: 1,
      contentHash: "h",
      envelope: ENVELOPE,
      batches: [],
      options: [],
      rationale: "r",
      createdAt: "2026-06-18T00:00:00.000Z",
      updatedAt: "2026-06-18T00:00:00.000Z",
    };
    const nowMs = Date.parse("2026-06-18T00:20:00.000Z");
    const lastRunAtMs = Date.parse("2026-06-18T00:19:30.000Z");
    expect(
      shouldRunShadowPlanCycle({
        plan,
        nowMs,
        heartbeatMs: 60_000,
        lastRunAtMs,
      }),
    ).toBe(false);
  });
});

describe("runShadowPlanCycle", () => {
  it("records a revision and logs the plan (shadow, no dispatch)", async () => {
    const root = mkdtempSync(join(tmpdir(), "symph-shadow-"));
    const logs: Array<{ event: string; fields: Record<string, unknown> }> = [];
    try {
      const context = assembleShadowPlannerContext({
        candidates: [issue("u1", "SYMPH-1")],
        inFlight: [],
        envelope: ENVELOPE,
      });
      const result = await runShadowPlanCycle({
        workspaceRoot: root,
        context,
        planner: okPlanner(),
        log: (event, _message, fields) => {
          logs.push({ event, fields });
        },
        now: () => new Date("2026-06-18T01:00:00.000Z"),
        planId: "plan-1",
      });
      expect(result.status).toBe("ok");
      if (result.status === "ok") {
        expect(result.revision).toBe(1);
        expect(result.batchCount).toBe(1);
      }
      expect(logs.map((l) => l.event)).toContain("queue_triage_shadow_plan");
      // Persisted + queryable after the cycle.
      const plan = await loadStandingPlan(root);
      expect(plan?.revision).toBe(1);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("degrades and records nothing when the planner is unavailable", async () => {
    const root = mkdtempSync(join(tmpdir(), "symph-shadow-"));
    const logs: string[] = [];
    try {
      const context = assembleShadowPlannerContext({
        candidates: [issue("u1", "SYMPH-1")],
        inFlight: [],
        envelope: ENVELOPE,
      });
      const result = await runShadowPlanCycle({
        workspaceRoot: root,
        context,
        planner: {
          runClaude: async () => ({
            status: "unavailable",
            detail: "cmux down",
          }),
        },
        log: (event) => {
          logs.push(event);
        },
        now: () => new Date("2026-06-18T01:00:00.000Z"),
        planId: "plan-1",
      });
      expect(result.status).toBe("unavailable");
      expect(logs).toContain("queue_triage_planner_unavailable");
      expect(await loadStandingPlan(root)).toBeNull();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("records one stable empty plan across empty-backlog heartbeats without planner degradation logs", async () => {
    const root = mkdtempSync(join(tmpdir(), "symph-shadow-"));
    const logs: string[] = [];
    const context = assembleShadowPlannerContext({
      candidates: [],
      inFlight: [],
      envelope: ENVELOPE,
    });
    try {
      const planner = {
        runClaude: async (): Promise<PlannerRunResult> => {
          throw new Error("empty backlog should not invoke the model runner");
        },
      };
      const first = await runShadowPlanCycle({
        workspaceRoot: root,
        context,
        planner,
        log: (event) => {
          logs.push(event);
        },
        now: () => new Date("2026-06-18T01:00:00.000Z"),
        planId: "plan-1",
      });
      const second = await runShadowPlanCycle({
        workspaceRoot: root,
        context,
        planner,
        log: (event) => {
          logs.push(event);
        },
        now: () => new Date("2026-06-18T01:15:00.000Z"),
        planId: "plan-1",
      });

      expect(first).toMatchObject({
        status: "ok",
        recorded: true,
        revision: 1,
        batchCount: 0,
      });
      expect(second).toMatchObject({
        status: "ok",
        recorded: false,
        revision: 1,
        batchCount: 0,
      });
      expect(logs).not.toContain("queue_triage_planner_unavailable");
      expect(logs).not.toContain("queue_triage_planner_invalid");
      expect(await loadStandingPlan(root)).toMatchObject({
        revision: 1,
        batches: [],
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

function triageConfig(
  over: Partial<WorkflowQueueTriageConfig> = {},
): WorkflowQueueTriageConfig {
  return {
    enabled: true,
    shadowMode: true,
    plannerModel: "opus",
    heartbeatMs: 900_000,
    autoReleaseFrontier: 1,
    controlDoc: { enabled: false, teamId: null },
    admissionGuardrail: { enabled: false },
    envelope: ENVELOPE,
    ...over,
  };
}

describe("runStandingPlanShadowTick", () => {
  it("does nothing when the feature is disabled", async () => {
    const root = mkdtempSync(join(tmpdir(), "symph-shadow-tick-"));
    let fetched = false;
    try {
      const result = await runStandingPlanShadowTick({
        config: triageConfig({ enabled: false }),
        workspaceRoot: root,
        fetchCandidates: async () => {
          fetched = true;
          return [];
        },
        getInFlight: () => [],
        createPlannerRunner: () => okPlanner().runClaude,
        log: () => undefined,
        now: () => new Date("2026-06-18T01:00:00.000Z"),
      });
      expect(result.status).toBe("skipped");
      expect(fetched).toBe(false);
      expect(await loadStandingPlan(root)).toBeNull();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("runs the cycle when enabled and no prior plan exists", async () => {
    const root = mkdtempSync(join(tmpdir(), "symph-shadow-tick-"));
    let requestedModel: string | null = null;
    try {
      const result = await runStandingPlanShadowTick({
        config: triageConfig(),
        workspaceRoot: root,
        fetchCandidates: async () => [issue("u1", "SYMPH-1")],
        getInFlight: () => [],
        createPlannerRunner: (model) => {
          requestedModel = model;
          return okPlanner().runClaude;
        },
        log: () => undefined,
        now: () => new Date("2026-06-18T01:00:00.000Z"),
      });
      expect(result.status).toBe("ok");
      expect(requestedModel).toBe("opus");
      expect((await loadStandingPlan(root))?.revision).toBe(1);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("skips on the heartbeat window and never invokes the planner", async () => {
    const root = mkdtempSync(join(tmpdir(), "symph-shadow-tick-"));
    let plannerBuilt = false;
    try {
      // First tick records a plan.
      await runStandingPlanShadowTick({
        config: triageConfig(),
        workspaceRoot: root,
        fetchCandidates: async () => [issue("u1", "SYMPH-1")],
        getInFlight: () => [],
        createPlannerRunner: () => okPlanner().runClaude,
        log: () => undefined,
        now: () => new Date("2026-06-18T01:00:00.000Z"),
      });
      // Second tick 1 minute later is inside the 15m heartbeat window.
      const result = await runStandingPlanShadowTick({
        config: triageConfig(),
        workspaceRoot: root,
        fetchCandidates: async () => [issue("u1", "SYMPH-1")],
        getInFlight: () => [],
        createPlannerRunner: () => {
          plannerBuilt = true;
          return okPlanner().runClaude;
        },
        log: () => undefined,
        now: () => new Date("2026-06-18T01:01:00.000Z"),
      });
      expect(result.status).toBe("skipped");
      expect(plannerBuilt).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("does not rerun every tick after an unchanged non-empty plan no-ops", async () => {
    const root = mkdtempSync(join(tmpdir(), "symph-shadow-tick-"));
    let plannerCalls = 0;
    try {
      const createPlannerRunner = () => {
        plannerCalls += 1;
        return okPlanner().runClaude;
      };

      await runStandingPlanShadowTick({
        config: triageConfig(),
        workspaceRoot: root,
        fetchCandidates: async () => [issue("u1", "SYMPH-1")],
        getInFlight: () => [],
        createPlannerRunner,
        log: () => undefined,
        now: () => new Date("2026-06-18T01:00:00.000Z"),
      });
      const second = await runStandingPlanShadowTick({
        config: triageConfig(),
        workspaceRoot: root,
        fetchCandidates: async () => [issue("u1", "SYMPH-1")],
        getInFlight: () => [],
        createPlannerRunner,
        log: () => undefined,
        now: () => new Date("2026-06-18T01:20:00.000Z"),
      });
      const third = await runStandingPlanShadowTick({
        config: triageConfig(),
        workspaceRoot: root,
        fetchCandidates: async () => [issue("u1", "SYMPH-1")],
        getInFlight: () => [],
        createPlannerRunner,
        log: () => undefined,
        now: () => new Date("2026-06-18T01:21:00.000Z"),
      });

      expect(second.status).toBe("ok");
      if (second.status === "ok") {
        expect(second.recorded).toBe(false);
        expect(second.revision).toBe(1);
      }
      expect(third).toEqual({ status: "skipped", reason: "heartbeat" });
      expect(plannerCalls).toBe(2);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("force bypasses the heartbeat gate and re-plans now (SYMPH-787/789)", async () => {
    const root = mkdtempSync(join(tmpdir(), "symph-shadow-tick-"));
    let plannerBuilt = false;
    try {
      // First tick records a plan.
      await runStandingPlanShadowTick({
        config: triageConfig(),
        workspaceRoot: root,
        fetchCandidates: async () => [issue("u1", "SYMPH-1")],
        getInFlight: () => [],
        createPlannerRunner: () => okPlanner().runClaude,
        log: () => undefined,
        now: () => new Date("2026-06-18T01:00:00.000Z"),
      });
      // 1 minute later (inside the heartbeat window) but FORCED → must run.
      const result = await runStandingPlanShadowTick({
        config: triageConfig(),
        workspaceRoot: root,
        fetchCandidates: async () => [issue("u1", "SYMPH-1")],
        getInFlight: () => [],
        createPlannerRunner: () => {
          plannerBuilt = true;
          return okPlanner().runClaude;
        },
        log: () => undefined,
        now: () => new Date("2026-06-18T01:01:00.000Z"),
        force: true,
      });
      expect(result.status).toBe("ok");
      expect(plannerBuilt).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("swallows errors so the poll is never broken", async () => {
    const root = mkdtempSync(join(tmpdir(), "symph-shadow-tick-"));
    const logs: string[] = [];
    try {
      const result = await runStandingPlanShadowTick({
        config: triageConfig(),
        workspaceRoot: root,
        fetchCandidates: async () => {
          throw new Error("tracker down");
        },
        getInFlight: () => [],
        createPlannerRunner: () => okPlanner().runClaude,
        log: (event) => {
          logs.push(event);
        },
        now: () => new Date("2026-06-18T01:00:00.000Z"),
      });
      expect(result.status).toBe("skipped");
      expect(logs).toContain("queue_triage_shadow_failed");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
