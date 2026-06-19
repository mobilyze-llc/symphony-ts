import { describe, expect, it } from "vitest";

import {
  type CouncilRoutingEvidenceResult,
  councilRoutingEvidenceError,
} from "../../src/review/review-provenance.js";

function validResult(): CouncilRoutingEvidenceResult {
  return {
    review_metadata: { routing_mode: "standard" },
    review_routing: {
      schemaVersion: 1,
      mode: "standard",
      decorrelationBasis: {
        authorFamilies: ["openai-codex"],
        requiredNonAuthorFamilyReviewer: true,
        requiredReviewerLaneIds: ["pi-deepseek"],
        decorrelatedReviewerArtifacts: [
          {
            laneId: "pi-deepseek",
            agent: "pi",
            modelFamily: "deepseek",
          },
        ],
        mergeEligible: true,
      },
    },
    lanes: [
      {
        laneId: "pi-deepseek",
        agent: "pi",
        state: "complete",
        verdict: "pass",
        degradedReason: null,
        independentReviewer: true,
        mergeAuthoritative: true,
        structuredArtifact: {
          lane: {
            laneId: "pi-deepseek",
            agent: "pi",
            modelFamily: "deepseek",
            independentReviewer: true,
            mergeAuthoritative: true,
          },
          verdict: "pass",
        },
      },
    ],
  };
}

describe("review provenance contracts", () => {
  it("accepts a clean non-author-family routing proof", () => {
    expect(councilRoutingEvidenceError(validResult())).toBeNull();
  });

  it("rejects missing and malformed routing evidence without throwing", () => {
    expect(
      councilRoutingEvidenceError({
        ...validResult(),
        review_routing: null,
      }),
    ).toContain("missing Council v2 review_routing evidence");

    expect(
      councilRoutingEvidenceError({
        ...validResult(),
        review_routing: { schemaVersion: 1, mode: "standard" },
      }),
    ).toContain("malformed Council v2 review_routing");
  });

  it("rejects routing evidence without a clean required lane proof", () => {
    const result = validResult();
    result.lanes = [];

    expect(councilRoutingEvidenceError(result)).toContain(
      "lacks lane evidence for required reviewer lane: pi-deepseek",
    );
  });

  it("rejects same-family required reviewer artifacts", () => {
    const result = validResult();
    const routing = result.review_routing;
    if (typeof routing !== "object" || routing === null) {
      throw new Error("fixture");
    }
    (
      routing as {
        decorrelationBasis: {
          authorFamilies: string[];
          decorrelatedReviewerArtifacts: Array<{
            laneId: string;
            agent: string;
            modelFamily: string;
          }>;
        };
      }
    ).decorrelationBasis.authorFamilies = ["deepseek"];

    expect(councilRoutingEvidenceError(result)).toContain(
      "same-family with the recorded author provenance",
    );
  });
});
