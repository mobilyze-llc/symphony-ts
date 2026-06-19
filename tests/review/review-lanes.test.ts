import { describe, expect, it } from "vitest";

import {
  CODEX_LEAD_LANE_ID,
  isMergeAuthoritative,
} from "../../src/review/review-lanes.js";

describe("review lane contracts", () => {
  it("pins the Codex lead lane id used by gate and Track reducers", () => {
    expect(CODEX_LEAD_LANE_ID).toBe("codex-high-lead");
  });

  it("uses one merge-authoritative predicate for missing and explicit values", () => {
    expect(isMergeAuthoritative({})).toBe(true);
    expect(isMergeAuthoritative({ mergeAuthoritative: true })).toBe(true);
    expect(isMergeAuthoritative({ mergeAuthoritative: false })).toBe(false);
  });
});
