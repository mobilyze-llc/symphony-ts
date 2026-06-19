import { describe, expect, it } from "vitest";

import {
  aggregateHeadlessVerdict,
  collectRoutingGuaranteeDegradedConditions,
  hasReviewSubstrateDegradation,
  reviewVerdictWithRoutingGuarantees,
  routingGuaranteeEscalationPredicates,
} from "../../src/review/review-verdict.js";

describe("review verdict contracts", () => {
  it("aggregates only merge-authoritative lane verdicts", () => {
    expect(aggregateHeadlessVerdict([])).toBe("error");
    expect(
      aggregateHeadlessVerdict([
        { verdict: "fail", mergeAuthoritative: false },
        { verdict: "pass", mergeAuthoritative: true },
      ]),
    ).toBe("pass");
    expect(
      aggregateHeadlessVerdict([
        { verdict: "pass", mergeAuthoritative: true },
        { verdict: "fail", mergeAuthoritative: true },
      ]),
    ).toBe("fail");
    expect(
      aggregateHeadlessVerdict([
        { verdict: "fail", mergeAuthoritative: true },
        { verdict: "error", mergeAuthoritative: true },
      ]),
    ).toBe("error");
  });

  it("downgrades an otherwise-passing verdict when routing guarantees fail", () => {
    expect(
      reviewVerdictWithRoutingGuarantees({
        laneVerdict: "pass",
        routingGuaranteeConditions: [
          "routing_absent_decorrelated_reviewer_artifact",
        ],
      }),
    ).toBe("error");
    expect(
      reviewVerdictWithRoutingGuarantees({
        laneVerdict: "fail",
        routingGuaranteeConditions: [
          "routing_absent_decorrelated_reviewer_artifact",
        ],
      }),
    ).toBe("fail");
  });

  it("collects routing substrate degradation without treating reviewer FAIL as substrate failure", () => {
    const routing = {
      decorrelationBasis: {
        authorFamilies: [],
        requiredNonAuthorFamilyReviewer: true,
        requiredReviewerLaneIds: ["pi-deepseek", "claude-opus"],
        decorrelatedReviewerArtifacts: [{ laneId: "pi-deepseek" }],
        mergeEligible: false,
      },
    };

    expect(
      collectRoutingGuaranteeDegradedConditions(routing, [
        {
          laneId: "pi-deepseek",
          state: "complete",
          verdict: "fail",
          degradedReason: null,
        },
        {
          laneId: "claude-opus",
          state: "complete",
          verdict: "error",
          degradedReason: "malformed_artifact",
        },
      ]),
    ).toEqual([
      "routing_required_lane_malformed:claude-opus",
      "routing_author_provenance_missing",
      "routing_absent_decorrelated_reviewer_artifact",
      "routing_required_lane_not_decorrelated:claude-opus",
    ]);
  });

  it("maps routing degradation conditions to unique escalation predicates", () => {
    expect(
      routingGuaranteeEscalationPredicates([
        "routing_required_lane_missing:pi-deepseek",
        "routing_required_lane_not_decorrelated:pi-deepseek",
        "routing_absent_decorrelated_reviewer_artifact",
      ]),
    ).toEqual([
      "missing_required_lane",
      "absent_decorrelated_reviewer_artifact",
    ]);
  });

  it("separates review-substrate degradation from expected routing-only conditions", () => {
    expect(
      hasReviewSubstrateDegradation({
        lanes: [
          {
            laneId: "pi-deepseek",
            state: "complete",
            verdict: "pass",
            degradedReason: null,
          },
        ],
        degradedConditions: ["routing_absent_decorrelated_reviewer_artifact"],
      }),
    ).toBe(false);
    expect(
      hasReviewSubstrateDegradation({
        lanes: [
          {
            laneId: "pi-deepseek",
            state: "complete",
            verdict: "pass",
            degradedReason: null,
          },
        ],
        degradedConditions: ["workspace_mutation_detected:pi-deepseek"],
      }),
    ).toBe(true);
  });
});
