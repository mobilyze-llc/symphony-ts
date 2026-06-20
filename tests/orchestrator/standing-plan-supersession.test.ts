import { describe, expect, it } from "vitest";

import type {
  PlanBatch,
  PlanDecision,
  PlanEnvelope,
  StandingPlan,
} from "../../src/domain/standing-plan.js";
import {
  type PlanBody,
  honoredDecisions,
  rotateRevision,
} from "../../src/orchestrator/standing-plan-supersession.js";

const ENVELOPE: PlanEnvelope = {
  version: 1,
  concurrencyCeiling: 3,
  allowedRisk: "medium",
  allowedModes: ["parallel-isolated", "shared-surface", "canary-chain"],
};

function lookaheadBatch(id: string, identifier: string): PlanBatch {
  return {
    batchId: id,
    mode: "parallel-isolated",
    status: "lookahead",
    members: [{ issueId: id, issueIdentifier: identifier }],
    rationale: "r",
    canary: null,
  };
}

function inFlightBatch(id: string, identifier: string): PlanBatch {
  return { ...lookaheadBatch(id, identifier), status: "in_flight" };
}

function body(batches: PlanBatch[]): PlanBody {
  return {
    batches,
    options: [],
    envelope: ENVELOPE,
    rationale: "rationale",
    source: "planner",
    dependencyEdges: [],
  };
}

function planFrom(revision: number, batches: PlanBatch[]): StandingPlan {
  return {
    planId: "plan-1",
    revision,
    contentHash: `hash-${revision}`,
    envelope: ENVELOPE,
    batches,
    options: [],
    rationale: "r",
    createdAt: "2026-06-18T00:00:00.000Z",
    updatedAt: "2026-06-18T00:00:00.000Z",
  };
}

describe("rotateRevision", () => {
  it("stamps the first revision with monotonic id and null supersedes", () => {
    const next = rotateRevision(null, body([lookaheadBatch("b1", "SYMPH-1")]), {
      planId: "plan-1",
      createdAt: "2026-06-18T00:00:00.000Z",
    });
    expect(next.revision).toBe(1);
    expect(next.supersedes).toBeNull();
    expect(next.planId).toBe("plan-1");
    expect(next.contentHash).toMatch(/^[0-9a-f]{64}$/);
  });

  it("rotates monotonically and records the superseded revision", () => {
    const prior = planFrom(1, [lookaheadBatch("b1", "SYMPH-1")]);
    const next = rotateRevision(
      prior,
      body([lookaheadBatch("b2", "SYMPH-2")]),
      {
        createdAt: "2026-06-18T00:01:00.000Z",
      },
    );
    expect(next.revision).toBe(2);
    expect(next.supersedes).toBe(1);
    expect(next.planId).toBe("plan-1");
  });

  it("freely rewrites the undispatched lookahead tail", () => {
    const prior = planFrom(1, [lookaheadBatch("b1", "SYMPH-1")]);
    const next = rotateRevision(
      prior,
      body([lookaheadBatch("b2", "SYMPH-2")]),
      {
        createdAt: "2026-06-18T00:01:00.000Z",
      },
    );
    expect(next.batches.map((batch) => batch.batchId)).toEqual(["b2"]);
  });

  it("carries in-flight batches forward immutably and ignores a re-plan that tries to change them", () => {
    const committed = inFlightBatch("b1", "SYMPH-1");
    const prior = planFrom(2, [committed, lookaheadBatch("b9", "SYMPH-9")]);
    // The planner tries to restate b1 with different members AND proposes a new tail.
    const tampered: PlanBatch = {
      ...inFlightBatch("b1", "SYMPH-1"),
      members: [{ issueId: "evil", issueIdentifier: "SYMPH-666" }],
    };
    const next = rotateRevision(
      prior,
      body([tampered, lookaheadBatch("b2", "SYMPH-2")]),
      { createdAt: "2026-06-18T00:02:00.000Z" },
    );
    const carried = next.batches.find((batch) => batch.batchId === "b1");
    expect(carried).toEqual(committed); // unchanged, taken from prior
    // committed first, then the fresh lookahead; the old b9 tail is dropped.
    expect(next.batches.map((batch) => batch.batchId)).toEqual(["b1", "b2"]);
  });

  it("produces an identical content hash for an unchanged plan body (no churn)", () => {
    const first = rotateRevision(
      null,
      body([lookaheadBatch("b1", "SYMPH-1")]),
      {
        planId: "plan-1",
        createdAt: "2026-06-18T00:00:00.000Z",
      },
    );
    const prior = planFrom(1, first.batches);
    prior.contentHash = first.contentHash;
    const second = rotateRevision(
      prior,
      body([lookaheadBatch("b1", "SYMPH-1")]),
      { createdAt: "2026-06-18T00:05:00.000Z" },
    );
    expect(second.contentHash).toBe(first.contentHash);
  });
});

describe("honoredDecisions (approval-revision binding)", () => {
  const decisions: PlanDecision[] = [
    {
      decisionId: "d1",
      planId: "plan-1",
      revision: 1,
      batchId: "b1",
      kind: "approve",
      actor: "eric@litman.org",
      optionMarker: "[opt-1]",
      createdAt: "2026-06-18T00:00:00.000Z",
      note: null,
    },
    {
      decisionId: "d2",
      planId: "plan-1",
      revision: 2,
      batchId: "b2",
      kind: "approve",
      actor: "eric@litman.org",
      optionMarker: "[opt-1]",
      createdAt: "2026-06-18T00:02:00.000Z",
      note: null,
    },
  ];

  it("voids approvals bound to a superseded revision", () => {
    const honored = honoredDecisions(decisions, 2);
    expect(honored.map((decision) => decision.decisionId)).toEqual(["d2"]);
  });
});

describe("rotateRevision option filtering", () => {
  it("drops options targeting committed/dropped batches, keeps lookahead + null-intent options", () => {
    const committed = inFlightBatch("committed-1", "SYMPH-1");
    const prior = planFrom(1, [committed]);
    const bodyWithOptions: PlanBody = {
      batches: [lookaheadBatch("look-1", "SYMPH-2")],
      options: [
        {
          marker: "[opt-1]",
          label: "release surviving lookahead",
          intent: { verb: "release_batch", batchId: "look-1" },
        },
        {
          marker: "[opt-2]",
          label: "release committed (must drop)",
          intent: { verb: "release_batch", batchId: "committed-1" },
        },
        {
          marker: "[opt-3]",
          label: "modify plan (no batch)",
          intent: { verb: "modify_plan", batchId: null },
        },
      ],
      envelope: ENVELOPE,
      rationale: "r",
      source: "planner",
      dependencyEdges: [],
    };
    const next = rotateRevision(prior, bodyWithOptions, {
      createdAt: "2026-06-18T00:02:00.000Z",
    });
    expect(next.options.map((option) => option.marker)).toEqual([
      "[opt-1]",
      "[opt-3]",
    ]);
  });
});
