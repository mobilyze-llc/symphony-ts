import { describe, expect, it } from "vitest";

import type { WorkflowQueueTriageConfig } from "../../src/config/types.js";
import type {
  PlanBatch,
  PlanDecision,
  PlanEnvelope,
  StandingPlan,
} from "../../src/domain/standing-plan.js";
import {
  decidePlanDrivenDispatch,
  evaluateReplanPredicates,
  selectDispatchableBatchMembers,
  shouldDegradeToComparator,
} from "../../src/orchestrator/standing-plan-consumer.js";

const ENVELOPE: PlanEnvelope = {
  version: 1,
  concurrencyCeiling: 4,
  allowedRisk: "medium",
  allowedModes: ["parallel-isolated", "canary-chain"],
};

function batch(
  batchId: string,
  identifiers: string[],
  over: Partial<PlanBatch> = {},
): PlanBatch {
  return {
    batchId,
    mode: "parallel-isolated",
    status: "lookahead",
    members: identifiers.map((id) => ({ issueId: id, issueIdentifier: id })),
    rationale: "r",
    canary: null,
    ...over,
  };
}

function plan(
  batches: PlanBatch[],
  over: Partial<StandingPlan> = {},
): StandingPlan {
  return {
    planId: "plan-1",
    revision: 1,
    contentHash: "h",
    envelope: ENVELOPE,
    batches,
    options: [],
    rationale: "r",
    createdAt: "2026-06-18T00:00:00.000Z",
    updatedAt: "2026-06-18T00:00:00.000Z",
    ...over,
  };
}

function approve(batchId: string, revision = 1): PlanDecision {
  return {
    decisionId: `d-${batchId}`,
    planId: "plan-1",
    revision,
    batchId,
    kind: "approve",
    actor: "eric@litman.org",
    optionMarker: null,
    createdAt: "2026-06-18T00:00:30.000Z",
    note: null,
  };
}

describe("selectDispatchableBatchMembers (posture-B)", () => {
  it("auto-releases up to the frontier bound and holds the rest", () => {
    const result = selectDispatchableBatchMembers({
      plan: plan([
        batch("b1", ["SYMPH-1"]),
        batch("b2", ["SYMPH-2"]),
        batch("b3", ["SYMPH-3"]),
      ]),
      honoredApprovals: [],
      runningIssueIdentifiers: new Set(),
      autoReleaseFrontier: 1,
      envelope: ENVELOPE,
    });
    expect(result.dispatchIssueIdentifiers).toEqual(["SYMPH-1"]);
    expect(result.releasedBatchIds).toEqual(["b1"]);
    expect(result.heldBatchIds).toEqual(["b2", "b3"]);
  });

  it("releases an operator-approved batch beyond the auto-release frontier", () => {
    const result = selectDispatchableBatchMembers({
      plan: plan([batch("b1", ["SYMPH-1"]), batch("b2", ["SYMPH-2"])]),
      honoredApprovals: [approve("b2")],
      runningIssueIdentifiers: new Set(),
      autoReleaseFrontier: 1,
      envelope: ENVELOPE,
    });
    // b1 auto-released (frontier), b2 approved → both dispatch.
    expect(result.dispatchIssueIdentifiers).toEqual(["SYMPH-1", "SYMPH-2"]);
    expect(result.releasedBatchIds).toEqual(["b1", "b2"]);
  });

  it("dispatches only the canary head, holding the contingent tail", () => {
    const canaryBatch = batch("b1", ["SYMPH-1", "SYMPH-2", "SYMPH-3"], {
      mode: "canary-chain",
      canary: {
        headIssueIdentifiers: ["SYMPH-1"],
        contingentIssueIdentifiers: ["SYMPH-2", "SYMPH-3"],
      },
    });
    const result = selectDispatchableBatchMembers({
      plan: plan([canaryBatch]),
      honoredApprovals: [],
      runningIssueIdentifiers: new Set(),
      autoReleaseFrontier: 1,
      envelope: ENVELOPE,
    });
    expect(result.dispatchIssueIdentifiers).toEqual(["SYMPH-1"]);
  });

  it("releases the contingent tail once every canary head has merged (SYMPH-800)", () => {
    const canaryBatch = batch("b1", ["SYMPH-1", "SYMPH-2", "SYMPH-3"], {
      mode: "canary-chain",
      canary: {
        headIssueIdentifiers: ["SYMPH-1"],
        contingentIssueIdentifiers: ["SYMPH-2", "SYMPH-3"],
      },
    });
    const result = selectDispatchableBatchMembers({
      plan: plan([canaryBatch]),
      honoredApprovals: [],
      runningIssueIdentifiers: new Set(),
      autoReleaseFrontier: 1,
      envelope: ENVELOPE,
      mergedIssueIdentifiers: new Set(["SYMPH-1"]), // head merged
    });
    // head validated → tail releases; the merged head is not re-dispatched.
    expect(result.dispatchIssueIdentifiers).toEqual(["SYMPH-2", "SYMPH-3"]);
  });

  it("holds the contingent tail while only SOME head members have merged", () => {
    const canaryBatch = batch("b1", ["SYMPH-1", "SYMPH-2", "SYMPH-3"], {
      mode: "canary-chain",
      canary: {
        headIssueIdentifiers: ["SYMPH-1", "SYMPH-2"],
        contingentIssueIdentifiers: ["SYMPH-3"],
      },
    });
    const result = selectDispatchableBatchMembers({
      plan: plan([canaryBatch]),
      honoredApprovals: [],
      runningIssueIdentifiers: new Set(["SYMPH-1"]), // head member 1 running
      autoReleaseFrontier: 1,
      envelope: ENVELOPE,
      mergedIssueIdentifiers: new Set(["SYMPH-1"]), // only 1 of 2 heads merged
    });
    // head not fully validated → still in the head phase; SYMPH-2 (head, not
    // running/merged) dispatches, the tail stays held.
    expect(result.dispatchIssueIdentifiers).toEqual(["SYMPH-2"]);
  });

  it("holds a canary-chain batch with no canary structure (defensive, SYMPH-800)", () => {
    const malformed = batch("b1", ["SYMPH-1", "SYMPH-2"], {
      mode: "canary-chain",
      canary: null, // would otherwise fall through and dispatch the whole batch
    });
    const result = selectDispatchableBatchMembers({
      plan: plan([malformed]),
      honoredApprovals: [],
      runningIssueIdentifiers: new Set(),
      autoReleaseFrontier: 1,
      envelope: ENVELOPE,
    });
    expect(result.dispatchIssueIdentifiers).toEqual([]);
    expect(result.heldBatchIds).toEqual(["b1"]);
  });

  it("does not re-dispatch an already-merged member of a parallel batch", () => {
    const result = selectDispatchableBatchMembers({
      plan: plan([batch("b1", ["SYMPH-1", "SYMPH-2"])]),
      honoredApprovals: [],
      runningIssueIdentifiers: new Set(),
      autoReleaseFrontier: 1,
      envelope: ENVELOPE,
      mergedIssueIdentifiers: new Set(["SYMPH-1"]),
    });
    expect(result.dispatchIssueIdentifiers).toEqual(["SYMPH-2"]);
  });

  it("excludes already-running members", () => {
    const result = selectDispatchableBatchMembers({
      plan: plan([batch("b1", ["SYMPH-1", "SYMPH-2"])]),
      honoredApprovals: [],
      runningIssueIdentifiers: new Set(["SYMPH-1"]),
      autoReleaseFrontier: 1,
      envelope: ENVELOPE,
    });
    expect(result.dispatchIssueIdentifiers).toEqual(["SYMPH-2"]);
  });

  it("caps dispatch at the envelope concurrency ceiling minus running", () => {
    const tight: PlanEnvelope = { ...ENVELOPE, concurrencyCeiling: 2 };
    const result = selectDispatchableBatchMembers({
      plan: plan([batch("b1", ["SYMPH-1", "SYMPH-2", "SYMPH-3", "SYMPH-4"])], {
        envelope: tight,
      }),
      honoredApprovals: [],
      runningIssueIdentifiers: new Set(["SYMPH-9"]), // 1 running
      autoReleaseFrontier: 5,
      envelope: tight,
    });
    // ceiling 2 - 1 running = 1 slot.
    expect(result.dispatchIssueIdentifiers).toEqual(["SYMPH-1"]);
  });

  it("never releases a batch whose mode is outside the envelope", () => {
    const result = selectDispatchableBatchMembers({
      plan: plan([batch("b1", ["SYMPH-1"], { mode: "shared-surface" })]),
      honoredApprovals: [],
      runningIssueIdentifiers: new Set(),
      autoReleaseFrontier: 5,
      envelope: ENVELOPE, // shared-surface not allowed
    });
    expect(result.dispatchIssueIdentifiers).toEqual([]);
    expect(result.heldBatchIds).toEqual(["b1"]);
  });

  it("honors an operator hold even within the auto-release frontier", () => {
    const held: PlanDecision = { ...approve("b1"), kind: "hold" };
    const result = selectDispatchableBatchMembers({
      plan: plan([batch("b1", ["SYMPH-1"])]),
      honoredApprovals: [held],
      runningIssueIdentifiers: new Set(),
      autoReleaseFrontier: 1,
      envelope: ENVELOPE,
    });
    expect(result.dispatchIssueIdentifiers).toEqual([]);
    expect(result.heldBatchIds).toEqual(["b1"]);
  });

  it("an operator reject revokes an approve and holds the batch (council R2, Codex P1)", () => {
    // [approve(b1), reject(b1)] must NOT release b1 — a reject revokes the
    // approve, parity with the admission guardrail (a rejected batch dispatching
    // on the plan path would bypass the no-ambient-control-surfaces invariant).
    const reject: PlanDecision = { ...approve("b1"), kind: "reject" };
    const result = selectDispatchableBatchMembers({
      plan: plan([batch("b1", ["SYMPH-1"])]),
      honoredApprovals: [approve("b1"), reject],
      runningIssueIdentifiers: new Set(),
      autoReleaseFrontier: 0, // no auto-release; only an (unrevoked) approve releases
      envelope: ENVELOPE,
    });
    expect(result.dispatchIssueIdentifiers).toEqual([]);
    expect(result.heldBatchIds).toEqual(["b1"]);
  });

  it("an operator reject also blocks auto-release within the frontier", () => {
    const reject: PlanDecision = { ...approve("b1"), kind: "reject" };
    const result = selectDispatchableBatchMembers({
      plan: plan([batch("b1", ["SYMPH-1"])]),
      honoredApprovals: [reject],
      runningIssueIdentifiers: new Set(),
      autoReleaseFrontier: 1, // would auto-release, but the reject holds it
      envelope: ENVELOPE,
    });
    expect(result.dispatchIssueIdentifiers).toEqual([]);
    expect(result.heldBatchIds).toEqual(["b1"]);
  });

  it("a modify does NOT revoke an approved batch (only hold/reject revoke)", () => {
    // modify is a re-plan signal, not a hold; an approved batch still releases
    // (council R3, Pi P3 regression guard — parity with the admission guardrail).
    const modify: PlanDecision = { ...approve("b1"), kind: "modify" };
    const result = selectDispatchableBatchMembers({
      plan: plan([batch("b1", ["SYMPH-1"])]),
      honoredApprovals: [approve("b1"), modify],
      runningIssueIdentifiers: new Set(),
      autoReleaseFrontier: 0, // only the (unrevoked) approve can release it
      envelope: ENVELOPE,
    });
    expect(result.dispatchIssueIdentifiers).toEqual(["SYMPH-1"]);
    expect(result.releasedBatchIds).toEqual(["b1"]);
  });
});

describe("shouldDegradeToComparator", () => {
  it("degrades when there is no plan", () => {
    expect(
      shouldDegradeToComparator({ plan: null, nowMs: 1000, heartbeatMs: 100 }),
    ).toBe(true);
  });

  it("degrades when the plan is stale (Manager not producing fresh plans)", () => {
    const stale = plan([batch("b1", ["SYMPH-1"])], {
      updatedAt: "2026-06-18T00:00:00.000Z",
    });
    const nowMs = Date.parse("2026-06-18T01:00:00.000Z"); // 1h later
    expect(
      shouldDegradeToComparator({ plan: stale, nowMs, heartbeatMs: 900_000 }),
    ).toBe(true);
  });

  it("does not degrade for a fresh plan", () => {
    const fresh = plan([batch("b1", ["SYMPH-1"])], {
      updatedAt: "2026-06-18T00:00:00.000Z",
    });
    const nowMs = Date.parse("2026-06-18T00:05:00.000Z");
    expect(
      shouldDegradeToComparator({ plan: fresh, nowMs, heartbeatMs: 900_000 }),
    ).toBe(false);
  });
});

describe("evaluateReplanPredicates", () => {
  it("forces a re-plan when the envelope version changed", () => {
    const result = evaluateReplanPredicates({
      plan: plan([batch("b1", ["SYMPH-1"])]),
      currentEnvelope: { ...ENVELOPE, version: 2 },
      candidateIdentifiers: new Set(["SYMPH-1"]),
    });
    expect(result.forceReplan).toBe(true);
    expect(result.reasons.join(" ")).toMatch(/envelope/);
  });

  it("forces a re-plan when no lookahead batch member is still a candidate", () => {
    const result = evaluateReplanPredicates({
      plan: plan([batch("b1", ["SYMPH-1"])]),
      currentEnvelope: ENVELOPE,
      candidateIdentifiers: new Set(["SYMPH-99"]), // SYMPH-1 gone
    });
    expect(result.forceReplan).toBe(true);
  });

  it("does not force a re-plan when the plan is fresh and aligned", () => {
    const result = evaluateReplanPredicates({
      plan: plan([batch("b1", ["SYMPH-1"])]),
      currentEnvelope: ENVELOPE,
      candidateIdentifiers: new Set(["SYMPH-1"]),
    });
    expect(result.forceReplan).toBe(false);
  });

  // SYMPH-801 — new-work-outranks-by-priority-band
  it("forces a re-plan when un-planned new work outranks the plan by a priority band", () => {
    const result = evaluateReplanPredicates({
      plan: plan([batch("b1", ["SYMPH-1"])]),
      currentEnvelope: ENVELOPE,
      candidateIdentifiers: new Set(["SYMPH-1", "SYMPH-2"]),
      candidatePriorityBands: new Map([
        ["SYMPH-1", 3], // planned: medium
        ["SYMPH-2", 1], // un-planned: urgent → outranks
      ]),
    });
    expect(result.forceReplan).toBe(true);
    expect(result.reasons.join(" ")).toMatch(/outranks|priority/i);
  });

  it("does NOT re-plan when un-planned work is the same or lower band than the plan", () => {
    const result = evaluateReplanPredicates({
      plan: plan([batch("b1", ["SYMPH-1"])]),
      currentEnvelope: ENVELOPE,
      candidateIdentifiers: new Set(["SYMPH-1", "SYMPH-2"]),
      candidatePriorityBands: new Map([
        ["SYMPH-1", 1], // planned: urgent
        ["SYMPH-2", 2], // un-planned: high, does not outrank urgent
      ]),
    });
    expect(result.forceReplan).toBe(false);
  });

  // SYMPH-801 — merge-moved-the-world
  it("forces a re-plan when enough merges landed since the plan (the base moved)", () => {
    const result = evaluateReplanPredicates({
      plan: plan([batch("b1", ["SYMPH-1"])]),
      currentEnvelope: ENVELOPE,
      candidateIdentifiers: new Set(["SYMPH-1"]),
      mergedSincePlanCount: 3,
    });
    expect(result.forceReplan).toBe(true);
    expect(result.reasons.join(" ")).toMatch(/merge/i);
  });

  it("does NOT re-plan for a sub-threshold number of merges since the plan", () => {
    const result = evaluateReplanPredicates({
      plan: plan([batch("b1", ["SYMPH-1"])]),
      currentEnvelope: ENVELOPE,
      candidateIdentifiers: new Set(["SYMPH-1"]),
      mergedSincePlanCount: 1,
    });
    expect(result.forceReplan).toBe(false);
  });
});

describe("decidePlanDrivenDispatch (hot-path composition)", () => {
  function config(
    over: Partial<WorkflowQueueTriageConfig> = {},
  ): WorkflowQueueTriageConfig {
    return {
      enabled: true,
      shadowMode: false,
      plannerModel: "opus",
      heartbeatMs: 900_000,
      autoReleaseFrontier: 1,
      controlDoc: { enabled: false, teamId: null },
      admissionGuardrail: { enabled: false },
      envelope: ENVELOPE,
      ...over,
    };
  }
  const freshPlan = () =>
    plan([batch("b1", ["SYMPH-1"]), batch("b2", ["SYMPH-2"])], {
      updatedAt: "2026-06-18T00:00:00.000Z",
    });
  const nowMs = Date.parse("2026-06-18T00:05:00.000Z");

  it("degrades when disabled", () => {
    const d = decidePlanDrivenDispatch({
      config: config({ enabled: false }),
      plan: freshPlan(),
      honoredApprovals: [],
      candidateIdentifiers: new Set(["SYMPH-1", "SYMPH-2"]),
      runningIssueIdentifiers: new Set(),
      nowMs,
    });
    expect(d.action).toBe("degrade");
    expect(d.forceReplan).toBe(false);
  });

  it("degrades in shadow mode (plan computed but does not drive dispatch)", () => {
    const d = decidePlanDrivenDispatch({
      config: config({ shadowMode: true }),
      plan: freshPlan(),
      honoredApprovals: [],
      candidateIdentifiers: new Set(["SYMPH-1", "SYMPH-2"]),
      runningIssueIdentifiers: new Set(),
      nowMs,
    });
    expect(d.action).toBe("degrade");
  });

  it("drives dispatch from a fresh, aligned plan (posture-B head)", () => {
    const d = decidePlanDrivenDispatch({
      config: config(),
      plan: freshPlan(),
      honoredApprovals: [],
      candidateIdentifiers: new Set(["SYMPH-1", "SYMPH-2"]),
      runningIssueIdentifiers: new Set(),
      nowMs,
    });
    expect(d.action).toBe("plan");
    expect(d.orderedIssueIdentifiers).toEqual(["SYMPH-1"]); // frontier=1
  });

  it("degrades + requests a re-plan when the plan is misaligned with candidates", () => {
    const d = decidePlanDrivenDispatch({
      config: config(),
      plan: freshPlan(),
      honoredApprovals: [],
      candidateIdentifiers: new Set(["SYMPH-99"]), // plan members all gone
      runningIssueIdentifiers: new Set(),
      nowMs,
    });
    expect(d.action).toBe("degrade");
    expect(d.forceReplan).toBe(true);
  });

  it("degrades when the plan is stale (Manager presumed down)", () => {
    const d = decidePlanDrivenDispatch({
      config: config(),
      plan: freshPlan(),
      honoredApprovals: [],
      candidateIdentifiers: new Set(["SYMPH-1"]),
      runningIssueIdentifiers: new Set(),
      nowMs: Date.parse("2026-06-18T02:00:00.000Z"), // 2h later > 2×heartbeat
    });
    expect(d.action).toBe("degrade");
    expect(d.forceReplan).toBe(false);
  });
});
