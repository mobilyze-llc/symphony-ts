import { describe, expect, it } from "vitest";

import { parsePlanSelfReviewFindings } from "../../src/agent/plan-self-review.js";

describe("parsePlanSelfReviewFindings", () => {
  it("trims valid finding fields and drops whitespace-only findings", () => {
    const findings = parsePlanSelfReviewFindings(`\`\`\`json
{
  "findings": [
    { "title": "  Keep me  ", "planAnchor": "  batch-1  ", "severity": "P2" },
    { "title": " ", "planAnchor": "batch-2", "severity": "P2" },
    { "title": "Missing anchor", "planAnchor": " ", "severity": "Track" }
  ]
}
\`\`\``);

    expect(findings).toEqual([
      {
        title: "Keep me",
        planAnchor: "batch-1",
        severity: "P2",
      },
    ]);
  });
});
