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
  enrichPlannerContextWithComments,
  runShadowPlanCycle,
  runStandingPlanShadowTick,
  shouldRunShadowPlanCycle,
} from "../../src/orchestrator/standing-plan-shadow.js";
import {
  loadStandingPlan,
  recordPlanRevision,
} from "../../src/orchestrator/standing-plan-store.js";
import type { LinearIssueComment } from "../../src/tracker/linear-client.js";

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

function linearComment(
  over: Partial<LinearIssueComment> = {},
): LinearIssueComment {
  return {
    id: "lc1",
    body: "human comment",
    createdAt: "2026-06-20T00:00:00.000Z",
    updatedAt: "2026-06-20T00:00:00.000Z",
    user: {
      kind: "user",
      id: "u",
      name: "Dev",
      displayName: "Dev",
      email: "dev@example.com",
      botType: null,
      botSubType: null,
    },
    botActor: null,
    ...over,
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

  it("carries the issue description and labels onto the candidate (SYMPH-874)", () => {
    const enriched: Issue = {
      ...issue("u1", "SYMPH-1"),
      description: "Body mentions src/orchestrator/core.ts",
      labels: ["area:scheduling", "kind:bug"],
    };
    const context = assembleShadowPlannerContext({
      candidates: [enriched],
      inFlight: [],
      envelope: ENVELOPE,
    });
    expect(context.backlog[0]?.description).toBe(
      "Body mentions src/orchestrator/core.ts",
    );
    expect(context.backlog[0]?.labels).toEqual(["area:scheduling", "kind:bug"]);
  });

  it("derives code-grounding path hints from the candidate body (SYMPH-895)", () => {
    const enriched: Issue = {
      ...issue("u1", "SYMPH-1"),
      description:
        "Reworks `src/orchestrator/core.ts` and `src/agent/triage-planner.ts`.",
    };
    const context = assembleShadowPlannerContext({
      candidates: [enriched],
      inFlight: [],
      envelope: ENVELOPE,
    });
    expect(context.backlog[0]?.pathHints).toEqual([
      "src/orchestrator/core.ts",
      "src/agent/triage-planner.ts",
    ]);
  });

  it("yields empty path hints when the body cites no paths (SYMPH-895)", () => {
    const context = assembleShadowPlannerContext({
      candidates: [issue("u1", "SYMPH-1")],
      inFlight: [],
      envelope: ENVELOPE,
    });
    expect(context.backlog[0]?.pathHints).toEqual([]);
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
    commentEnrichment: {
      enabled: false,
      maxCandidates: 25,
      maxCommentPages: 3,
      maxComments: 6,
      maxCommentChars: 400,
      maxTotalChars: 1200,
    },
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
      // After SYMPH-828 this within-window skip is served by the attempted-run
      // gate (the marker advanced on the no-op cycle) → reason "cadence".
      expect(third).toEqual({ status: "skipped", reason: "cadence" });
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

describe("runStandingPlanShadowTick — error rate-limiting (SYMPH-828)", () => {
  it("rate-limits a persistently throwing cycle to the heartbeat cadence", async () => {
    const root = mkdtempSync(join(tmpdir(), "symph-shadow-tick-err-"));
    let fetchCalls = 0;
    const logs: string[] = [];
    const tick = (iso: string) =>
      runStandingPlanShadowTick({
        config: triageConfig(), // heartbeatMs 900_000 (15m)
        workspaceRoot: root,
        fetchCandidates: async () => {
          fetchCalls += 1;
          throw new Error("tracker down");
        },
        getInFlight: () => [],
        createPlannerRunner: () => okPlanner().runClaude,
        log: (event) => {
          logs.push(event);
        },
        now: () => new Date(iso),
      });
    try {
      const first = await tick("2026-06-18T01:00:00.000Z"); // attempts → throws
      const second = await tick("2026-06-18T01:01:00.000Z"); // <15m → skip
      const third = await tick("2026-06-18T01:05:00.000Z"); // <15m → skip
      const fourth = await tick("2026-06-18T01:20:00.000Z"); // 20m → attempts

      expect(first).toEqual({ status: "skipped", reason: "error" });
      // Rate-limited by the attempted-run gate (reason "cadence"), distinct from
      // the plan-freshness "heartbeat" gate.
      expect(second).toEqual({ status: "skipped", reason: "cadence" });
      expect(third).toEqual({ status: "skipped", reason: "cadence" });
      expect(fourth).toEqual({ status: "skipped", reason: "error" });
      // The expensive fetch ran once per heartbeat window, NOT every poll. The
      // pre-SYMPH-828 tick advanced the marker only on success and ignored it
      // when no plan exists, so it would have re-fetched on all four ticks.
      expect(fetchCalls).toBe(2);
      // …and the operator-visible degradation log fired only on real attempts.
      expect(
        logs.filter((e) => e === "queue_triage_shadow_failed").length,
      ).toBe(2);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("a forced tick bypasses the error cadence (operator re-plan still runs)", async () => {
    const root = mkdtempSync(join(tmpdir(), "symph-shadow-tick-err-"));
    let fetchCalls = 0;
    const failingFetch = async (): Promise<Issue[]> => {
      fetchCalls += 1;
      throw new Error("tracker down");
    };
    try {
      await runStandingPlanShadowTick({
        config: triageConfig(),
        workspaceRoot: root,
        fetchCandidates: failingFetch,
        getInFlight: () => [],
        createPlannerRunner: () => okPlanner().runClaude,
        log: () => undefined,
        now: () => new Date("2026-06-18T01:00:00.000Z"),
      });
      // 1 minute later (inside the cadence) but FORCED → must still attempt.
      const forced = await runStandingPlanShadowTick({
        config: triageConfig(),
        workspaceRoot: root,
        fetchCandidates: failingFetch,
        getInFlight: () => [],
        createPlannerRunner: () => okPlanner().runClaude,
        log: () => undefined,
        now: () => new Date("2026-06-18T01:01:00.000Z"),
        force: true,
      });
      expect(forced).toEqual({ status: "skipped", reason: "error" });
      expect(fetchCalls).toBe(2);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("after a restart (marker lost), a fresh plan within the window skips via the plan-freshness gate", async () => {
    // The attempted-run marker is in-memory, so a restart loses it. The next poll
    // then falls through to shouldRunShadowPlanCycle, which skips on the plan's
    // own freshness — reason "heartbeat", distinct from the "cadence" rate-limit
    // gate. Covers the old gate's integration, which the cadence gate now fronts.
    const root = mkdtempSync(join(tmpdir(), "symph-shadow-tick-restart-"));
    let plannerBuilt = false;
    try {
      // Persist a fresh plan directly (no tick → no in-memory marker = restart).
      await recordPlanRevision(
        root,
        {
          batches: [
            {
              batchId: "b1",
              mode: "parallel-isolated",
              status: "lookahead",
              members: [{ issueId: "1", issueIdentifier: "SYMPH-1" }],
              rationale: "r",
              canary: null,
            },
          ],
          options: [],
          envelope: ENVELOPE,
          rationale: "seed",
          source: "planner",
          dependencyEdges: [],
        },
        { planId: "plan-1", createdAt: "2026-06-18T01:00:00.000Z" },
      );
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
        // 1 min after the recorded plan — inside the 15m heartbeat window.
        now: () => new Date("2026-06-18T01:01:00.000Z"),
      });
      expect(result).toEqual({ status: "skipped", reason: "heartbeat" });
      expect(plannerBuilt).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("enrichPlannerContextWithComments (SYMPH-896)", () => {
  const COMMENT_CONFIG = {
    enabled: true,
    maxCandidates: 25,
    maxCommentPages: 3,
    maxComments: 6,
    maxCommentChars: 400,
    maxTotalChars: 1200,
  };

  it("attaches curated comments and reports a measurement", async () => {
    const context = assembleShadowPlannerContext({
      candidates: [issue("u1", "SYMPH-1"), issue("u2", "SYMPH-2")],
      inFlight: [],
      envelope: ENVELOPE,
    });
    const fetched: string[] = [];
    const result = await enrichPlannerContextWithComments({
      context,
      config: COMMENT_CONFIG,
      fetchIssueComments: async (issueId) => {
        fetched.push(issueId);
        return issueId === "u1"
          ? [linearComment({ id: "a", body: "overlaps with SYMPH-2" })]
          : [];
      },
    });
    expect(fetched).toEqual(["u1", "u2"]);
    expect(result.context.backlog[0]?.comments?.map((c) => c.body)).toEqual([
      "overlaps with SYMPH-2",
    ]);
    expect(result.context.backlog[1]?.comments).toBeUndefined();
    expect(result.measurement.candidatesConsidered).toBe(2);
    expect(result.measurement.candidatesFetched).toBe(2);
    expect(result.measurement.totalCommentsKept).toBe(1);
    expect(result.measurement.estimatedAddedTokens).toBeGreaterThan(0);
  });

  it("bounds the fetch to maxCandidates and reports truncation", async () => {
    const context = assembleShadowPlannerContext({
      candidates: [
        issue("u1", "SYMPH-1"),
        issue("u2", "SYMPH-2"),
        issue("u3", "SYMPH-3"),
      ],
      inFlight: [],
      envelope: ENVELOPE,
    });
    const fetched: string[] = [];
    const result = await enrichPlannerContextWithComments({
      context,
      config: { ...COMMENT_CONFIG, maxCandidates: 2 },
      fetchIssueComments: async (issueId) => {
        fetched.push(issueId);
        return [];
      },
    });
    expect(fetched).toEqual(["u1", "u2"]);
    expect(result.measurement.candidatesConsidered).toBe(3);
    expect(result.measurement.candidatesFetched).toBe(2);
    expect(result.measurement.candidatesTruncated).toBe(1);
  });

  it("drops service-account noise via the operator config", async () => {
    const context = assembleShadowPlannerContext({
      candidates: [issue("u1", "SYMPH-1")],
      inFlight: [],
      envelope: ENVELOPE,
    });
    const result = await enrichPlannerContextWithComments({
      context,
      config: COMMENT_CONFIG,
      operatorConfig: {
        operatorAllowlist: [],
        serviceAccounts: ["svc@bot.com"],
      },
      fetchIssueComments: async () => [
        linearComment({
          id: "svc",
          body: "automated note",
          user: {
            kind: "user",
            id: "s",
            name: "svc",
            displayName: "svc",
            email: "svc@bot.com",
            botType: null,
            botSubType: null,
          },
        }),
        linearComment({ id: "human", body: "real signal" }),
      ],
    });
    expect(result.context.backlog[0]?.comments?.map((c) => c.body)).toEqual([
      "real signal",
    ]);
    expect(result.measurement.totalDroppedNoise).toBe(1);
  });

  it("swallows a per-candidate fetch failure (best-effort)", async () => {
    const context = assembleShadowPlannerContext({
      candidates: [issue("u1", "SYMPH-1"), issue("u2", "SYMPH-2")],
      inFlight: [],
      envelope: ENVELOPE,
    });
    const result = await enrichPlannerContextWithComments({
      context,
      config: COMMENT_CONFIG,
      fetchIssueComments: async (issueId) => {
        if (issueId === "u1") {
          throw new Error("boom");
        }
        return [linearComment({ id: "ok", body: "fine" })];
      },
    });
    expect(result.context.backlog[0]?.comments).toBeUndefined();
    expect(result.context.backlog[1]?.comments?.map((c) => c.body)).toEqual([
      "fine",
    ]);
    expect(result.measurement.candidatesFetched).toBe(1);
    // the failed fetch still cost a round trip — counted, not silently dropped.
    expect(result.measurement.candidatesFailed).toBe(1);
  });
});

describe("runStandingPlanShadowTick comment enrichment (SYMPH-896)", () => {
  it("does not fetch comments or log a measurement when disabled (default)", async () => {
    const root = mkdtempSync(join(tmpdir(), "symph-shadow-tick-"));
    let commentFetches = 0;
    const events: string[] = [];
    try {
      const result = await runStandingPlanShadowTick({
        config: triageConfig(), // commentEnrichment.enabled = false (default)
        workspaceRoot: root,
        fetchCandidates: async () => [issue("u1", "SYMPH-1")],
        getInFlight: () => [],
        createPlannerRunner: () => okPlanner().runClaude,
        fetchIssueComments: async () => {
          commentFetches += 1;
          return [];
        },
        log: (event) => {
          events.push(event);
        },
        now: () => new Date("2026-06-18T01:00:00.000Z"),
      });
      expect(result.status).toBe("ok");
      expect(commentFetches).toBe(0);
      expect(events).not.toContain("queue_triage_comment_enrichment_measure");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("fetches, injects curated comments, and logs a measurement when enabled", async () => {
    const root = mkdtempSync(join(tmpdir(), "symph-shadow-tick-"));
    let capturedPrompt = "";
    const logged: Array<{ event: string; fields: Record<string, unknown> }> =
      [];
    try {
      const result = await runStandingPlanShadowTick({
        config: triageConfig({
          commentEnrichment: {
            enabled: true,
            maxCandidates: 25,
            maxCommentPages: 3,
            maxComments: 6,
            maxCommentChars: 400,
            maxTotalChars: 1200,
          },
        }),
        workspaceRoot: root,
        fetchCandidates: async () => [issue("u1", "SYMPH-1")],
        getInFlight: () => [],
        createPlannerRunner: () => async (prompt: string) => {
          capturedPrompt = prompt;
          return okPlanner().runClaude();
        },
        fetchIssueComments: async () => [
          linearComment({ id: "a", body: "overlaps with SYMPH-2" }),
        ],
        log: (event, _message, fields) => {
          logged.push({ event, fields });
        },
        now: () => new Date("2026-06-18T01:00:00.000Z"),
      });
      expect(result.status).toBe("ok");
      const measure = logged.find(
        (entry) => entry.event === "queue_triage_comment_enrichment_measure",
      );
      expect(measure).toBeDefined();
      expect(measure?.fields.totalCommentsKept).toBe(1);
      expect(capturedPrompt).toContain("- [human] overlaps with SYMPH-2");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("does not fetch or log a measurement on an empty backlog (council P2)", async () => {
    const root = mkdtempSync(join(tmpdir(), "symph-shadow-tick-"));
    let commentFetches = 0;
    const events: string[] = [];
    try {
      const result = await runStandingPlanShadowTick({
        config: triageConfig({
          commentEnrichment: {
            enabled: true,
            maxCandidates: 25,
            maxCommentPages: 3,
            maxComments: 6,
            maxCommentChars: 400,
            maxTotalChars: 1200,
          },
        }),
        workspaceRoot: root,
        fetchCandidates: async () => [],
        getInFlight: () => [],
        createPlannerRunner: () => okPlanner().runClaude,
        fetchIssueComments: async () => {
          commentFetches += 1;
          return [];
        },
        log: (event) => {
          events.push(event);
        },
        now: () => new Date("2026-06-18T01:00:00.000Z"),
      });
      expect(result.status).toBe("ok");
      expect(commentFetches).toBe(0);
      expect(events).not.toContain("queue_triage_comment_enrichment_measure");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("logs a skip when enabled but no comment fetch is wired (council Track)", async () => {
    const root = mkdtempSync(join(tmpdir(), "symph-shadow-tick-"));
    const events: string[] = [];
    try {
      const result = await runStandingPlanShadowTick({
        config: triageConfig({
          commentEnrichment: {
            enabled: true,
            maxCandidates: 25,
            maxCommentPages: 3,
            maxComments: 6,
            maxCommentChars: 400,
            maxTotalChars: 1200,
          },
        }),
        workspaceRoot: root,
        fetchCandidates: async () => [issue("u1", "SYMPH-1")],
        getInFlight: () => [],
        createPlannerRunner: () => okPlanner().runClaude,
        // fetchIssueComments deliberately NOT wired (e.g. non-Linear tracker).
        log: (event) => {
          events.push(event);
        },
        now: () => new Date("2026-06-18T01:00:00.000Z"),
      });
      expect(result.status).toBe("ok");
      expect(events).toContain("queue_triage_comment_enrichment_skipped");
      expect(events).not.toContain("queue_triage_comment_enrichment_measure");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
