import { describe, expect, it } from "vitest";

import { decidePlanReviewGate } from "../../src/orchestrator/plan-review-gate.js";

describe("plan review diff gate", () => {
  it("fires when no durable reviewed baseline exists", () => {
    expect(
      decidePlanReviewGate({
        currentContentHash: "new",
        lastReviewedContentHash: null,
      }),
    ).toMatchObject({ action: "run", reason: "no_baseline" });
  });

  it("skips when the structural content hash is unchanged", () => {
    expect(
      decidePlanReviewGate({
        currentContentHash: "same",
        lastReviewedContentHash: "same",
      }),
    ).toMatchObject({ action: "skip", reason: "content_hash_unchanged" });
  });

  it("fires when the structural content hash changes", () => {
    expect(
      decidePlanReviewGate({
        currentContentHash: "new",
        lastReviewedContentHash: "old",
      }),
    ).toMatchObject({ action: "run", reason: "content_hash_changed" });
  });
});
