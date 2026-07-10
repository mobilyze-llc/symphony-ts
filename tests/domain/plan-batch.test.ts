import { describe, expect, it } from "vitest";

import {
  type PlannerContext,
  buildPlanBody,
} from "../../src/agent/triage-planner.js";
import {
  type RawPlanBatchForNormalization,
  isValidPlanBatch,
  normalizePlanBatch,
} from "../../src/domain/plan-batch.js";
import type {
  PlanBatch,
  PlanBatchMember,
  PlanEnvelope,
} from "../../src/domain/standing-plan.js";
import { legacyIsPlanBatch } from "../helpers/plan-batch-legacy.js";

const ENVELOPE: PlanEnvelope = {
  version: 1,
  concurrencyCeiling: 3,
  allowedRisk: "medium",
  allowedModes: ["parallel-isolated", "canary-chain", "shared-surface"],
};

const MEMBERS: PlanBatchMember[] = [
  { issueId: "u-1", issueIdentifier: "SYMPH-1" },
  { issueId: "u-2", issueIdentifier: "SYMPH-2" },
];

function context(): PlannerContext {
  return {
    backlog: [
      {
        issueId: "u-1",
        issueIdentifier: "SYMPH-1",
        title: "First",
        priority: 1,
        state: "Todo",
        blockedBy: [],
      },
      {
        issueId: "u-2",
        issueIdentifier: "SYMPH-2",
        title: "Second",
        priority: 2,
        state: "Todo",
        blockedBy: [],
      },
    ],
    openPrs: [],
    recentlyMerged: [],
    inFlight: [],
    envelope: ENVELOPE,
  };
}

function batch(overrides: Partial<PlanBatch> = {}): PlanBatch {
  return {
    batchId: "b-test",
    mode: "parallel-isolated",
    status: "lookahead",
    members: MEMBERS,
    rationale: "r",
    canary: null,
    ...overrides,
  };
}

function resolvedMembers(
  issueIdentifiers: readonly string[],
): PlanBatchMember[] {
  const byIdentifier = new Map(
    MEMBERS.map((member) => [member.issueIdentifier, member]),
  );
  return issueIdentifiers
    .map((identifier) => byIdentifier.get(identifier))
    .filter((member): member is PlanBatchMember => member !== undefined);
}

describe("PlanBatchSchema", () => {
  it("is boolean-equivalent to the current isPlanBatch edge cases", () => {
    const rows: Array<{ name: string; row: unknown }> = [
      {
        name: "valid canary-chain",
        row: batch({
          mode: "canary-chain",
          canary: {
            headIssueIdentifiers: ["SYMPH-1"],
            contingentIssueIdentifiers: ["SYMPH-2"],
          },
        }),
      },
      {
        name: "empty head",
        row: batch({
          mode: "canary-chain",
          canary: {
            headIssueIdentifiers: [],
            contingentIssueIdentifiers: ["SYMPH-2"],
          },
        }),
      },
      {
        name: "out-of-member head ref",
        row: batch({
          mode: "canary-chain",
          canary: {
            headIssueIdentifiers: ["SYMPH-404"],
            contingentIssueIdentifiers: ["SYMPH-2"],
          },
        }),
      },
      {
        name: "out-of-member contingent ref",
        row: batch({
          mode: "canary-chain",
          canary: {
            headIssueIdentifiers: ["SYMPH-1"],
            contingentIssueIdentifiers: ["SYMPH-404"],
          },
        }),
      },
      {
        name: "null canary on canary-chain",
        row: batch({ mode: "canary-chain", canary: null }),
      },
      {
        name: "null canary on parallel-isolated",
        row: batch({ mode: "parallel-isolated", canary: null }),
      },
      {
        name: "valid canary on parallel-isolated",
        row: batch({
          mode: "parallel-isolated",
          canary: {
            headIssueIdentifiers: ["SYMPH-1"],
            contingentIssueIdentifiers: ["SYMPH-2"],
          },
        }),
      },
      {
        name: "empty members on parallel-isolated",
        row: batch({ mode: "parallel-isolated", members: [], canary: null }),
      },
      {
        name: "canary-chain with empty members",
        row: batch({
          mode: "canary-chain",
          members: [],
          canary: {
            headIssueIdentifiers: ["SYMPH-1"],
            contingentIssueIdentifiers: [],
          },
        }),
      },
    ];

    for (const { name, row } of rows) {
      expect(isValidPlanBatch(row), name).toBe(legacyIsPlanBatch(row));
    }
  });

  it("is boolean-equivalent to isPlanBatch over generated row variants", () => {
    const bodyFixture = buildPlanBody(
      {
        rationale: "plan",
        batches: [
          {
            mode: "canary-chain",
            issueIdentifiers: ["SYMPH-1", "SYMPH-2"],
            rationale: "chain",
            canary: {
              headIssueIdentifiers: ["SYMPH-1"],
              contingentIssueIdentifiers: ["SYMPH-2"],
            },
          },
        ],
      },
      context(),
    );
    const canaryVariants = [
      null,
      {
        headIssueIdentifiers: ["SYMPH-1"],
        contingentIssueIdentifiers: ["SYMPH-2"],
      },
      {
        headIssueIdentifiers: [],
        contingentIssueIdentifiers: ["SYMPH-2"],
      },
      {
        headIssueIdentifiers: ["SYMPH-404"],
        contingentIssueIdentifiers: ["SYMPH-2"],
      },
      {
        headIssueIdentifiers: ["SYMPH-1"],
        contingentIssueIdentifiers: ["SYMPH-404"],
      },
      {
        headIssueIdentifiers: ["SYMPH-1"],
        contingentIssueIdentifiers: [7],
      },
      undefined,
    ];
    const memberVariants = [
      MEMBERS,
      [MEMBERS[0]],
      [],
      [{ issueId: "u-1" }],
      [{ issueId: "u-1", issueIdentifier: 7 }],
    ];
    const rows: unknown[] = [
      ...bodyFixture.batches,
      null,
      [],
      "not a batch",
      batch({ batchId: 7 as unknown as string }),
      batch({ mode: "bogus" as unknown as PlanBatch["mode"] }),
      batch({ status: "bogus" as unknown as PlanBatch["status"] }),
      batch({ rationale: 7 as unknown as string }),
    ];

    for (const mode of [
      "parallel-isolated",
      "shared-surface",
      "canary-chain",
    ] as const) {
      for (const status of [
        "lookahead",
        "released",
        "in_flight",
        "completed",
        "superseded",
      ] as const) {
        for (const members of memberVariants) {
          for (const canary of canaryVariants) {
            rows.push({
              batchId: "b-generated",
              mode,
              status,
              members,
              rationale: "",
              canary,
              extra: "tolerated",
            });
          }
        }
      }
    }

    for (const row of rows) {
      expect(isValidPlanBatch(row), JSON.stringify(row) ?? String(row)).toBe(
        legacyIsPlanBatch(row),
      );
    }
  });
});

describe("normalizePlanBatch", () => {
  it("matches buildPlanBody's current canary repair, downgrade, and batch id behavior", () => {
    const cases: Array<{
      rawBatch: RawPlanBatchForNormalization;
      issueIdentifiers: string[];
    }> = [
      {
        rawBatch: {
          mode: "parallel-isolated",
          rationale: "plain",
        },
        issueIdentifiers: ["SYMPH-1"],
      },
      {
        rawBatch: {
          mode: "canary-chain",
          rationale: "valid chain",
          canary: {
            headIssueIdentifiers: ["SYMPH-1"],
            contingentIssueIdentifiers: ["SYMPH-2"],
          },
        },
        issueIdentifiers: ["SYMPH-1", "SYMPH-2"],
      },
      {
        rawBatch: {
          mode: "canary-chain",
          rationale: "filtered chain",
          canary: {
            headIssueIdentifiers: ["SYMPH-1", "SYMPH-404"],
            contingentIssueIdentifiers: ["SYMPH-2", "SYMPH-999"],
          },
        },
        issueIdentifiers: ["SYMPH-1", "SYMPH-2"],
      },
      {
        rawBatch: {
          mode: "canary-chain",
          rationale: "downgrade",
          canary: {
            headIssueIdentifiers: ["SYMPH-404"],
            contingentIssueIdentifiers: ["SYMPH-1"],
          },
        },
        issueIdentifiers: ["SYMPH-1"],
      },
      {
        rawBatch: {
          mode: "parallel-isolated",
          rationale: "valid canary on non-chain",
          canary: {
            headIssueIdentifiers: ["SYMPH-1"],
            contingentIssueIdentifiers: ["SYMPH-2"],
          },
        },
        issueIdentifiers: ["SYMPH-1", "SYMPH-2"],
      },
      {
        rawBatch: {
          mode: "parallel-isolated",
          rationale: "drop non-chain canary with no surviving head",
          canary: {
            headIssueIdentifiers: ["SYMPH-404"],
            contingentIssueIdentifiers: ["SYMPH-1"],
          },
        },
        issueIdentifiers: ["SYMPH-1"],
      },
    ];

    for (const { rawBatch, issueIdentifiers } of cases) {
      const oracle = buildPlanBody(
        {
          rationale: "plan",
          batches: [{ ...rawBatch, issueIdentifiers }],
        },
        context(),
      );
      const normalized = normalizePlanBatch(
        rawBatch,
        resolvedMembers(issueIdentifiers),
      );

      expect(normalized.ok).toBe(true);
      if (normalized.ok) {
        expect(normalized.batch).toEqual(oracle.batches[0]);
        expect(normalized.batch.batchId).toMatch(/^b-[0-9a-f]{12}$/);
        expect(isValidPlanBatch(normalized.batch)).toBe(true);
      }
    }
  });

  it("drops zero-member and post-downgrade out-of-envelope batches", () => {
    const empty = normalizePlanBatch(
      { mode: "parallel-isolated", rationale: "empty" },
      [],
      { allowedModes: ["parallel-isolated"] },
    );
    expect(empty).toEqual({ ok: false, rejection: "empty batch members" });

    const downgradedOutsideEnvelope = normalizePlanBatch(
      {
        mode: "canary-chain",
        rationale: "downgrades outside envelope",
        canary: {
          headIssueIdentifiers: ["SYMPH-404"],
          contingentIssueIdentifiers: ["SYMPH-1"],
        },
      },
      resolvedMembers(["SYMPH-1"]),
      { allowedModes: ["canary-chain"] },
    );
    expect(downgradedOutsideEnvelope).toEqual({
      ok: false,
      rejection: "batch mode outside envelope",
    });
  });

  it("rejects malformed direct canary input without throwing", () => {
    const malformedCanaries: unknown[] = [
      "not-a-canary",
      7,
      [],
      { headIssueIdentifiers: "SYMPH-1", contingentIssueIdentifiers: [] },
      { headIssueIdentifiers: ["SYMPH-1"], contingentIssueIdentifiers: [7] },
    ];

    for (const canary of malformedCanaries) {
      const rawBatch = {
        mode: "canary-chain",
        rationale: "malformed direct canary",
        canary,
      } as unknown as RawPlanBatchForNormalization;
      expect(() =>
        normalizePlanBatch(rawBatch, resolvedMembers(["SYMPH-1"])),
      ).not.toThrow();
      expect(
        normalizePlanBatch(rawBatch, resolvedMembers(["SYMPH-1"])),
      ).toEqual({ ok: false, rejection: "invalid canary" });
    }
  });

  it("rejects an audit-annotated member at the batch eligibility boundary", () => {
    expect(
      normalizePlanBatch(
        {
          mode: "parallel-isolated",
          rationale: "must not dispatch advisory kill",
        },
        MEMBERS,
        { ineligibleIssueIdentifiers: ["SYMPH-2"] },
      ),
    ).toEqual({
      ok: false,
      rejection: "dispatch-ineligible batch member",
    });
  });
});
