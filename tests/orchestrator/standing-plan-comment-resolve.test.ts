import { describe, expect, it } from "vitest";

import type {
  PlanEnvelope,
  StandingPlan,
} from "../../src/domain/standing-plan.js";
import { resolveDocComment } from "../../src/orchestrator/standing-plan-comment-resolve.js";

const ENVELOPE: PlanEnvelope = {
  version: 1,
  concurrencyCeiling: 3,
  allowedRisk: "medium",
  allowedModes: ["parallel-isolated"],
};

function plan(): StandingPlan {
  return {
    planId: "plan-1",
    revision: 4,
    contentHash: "h",
    envelope: ENVELOPE,
    batches: [],
    options: [
      {
        marker: "[opt-1]",
        label: "Release b-aaa (parallel-isolated): SYMPH-1",
        intent: { verb: "release_batch", batchId: "b-aaa" },
      },
      {
        marker: "[opt-2]",
        label: "Hold b-bbb",
        intent: { verb: "hold", batchId: "b-bbb" },
      },
    ],
    rationale: "r",
    createdAt: "2026-06-18T00:00:00.000Z",
    updatedAt: "2026-06-18T00:05:00.000Z",
  };
}

const ALLOWLIST = new Set(["eric@litman.org"]);

function comment(
  over: Partial<{
    body: string;
    quotedText: string | null;
    authorEmail: string | null;
    createdAt: string;
  }>,
) {
  return {
    body: "",
    quotedText: null,
    authorEmail: "eric@litman.org",
    createdAt: "2026-06-18T00:10:00.000Z",
    ...over,
  };
}

describe("resolveDocComment (6b)", () => {
  it("resolves a quotedText option line to its typed intent", () => {
    const result = resolveDocComment({
      comment: comment({
        quotedText: "[opt-1] Release b-aaa (parallel-isolated): SYMPH-1",
        body: "yes do it",
      }),
      plan: plan(),
      operatorAllowlist: ALLOWLIST,
    });
    expect(result).toEqual({
      kind: "intent",
      optionMarker: "[opt-1]",
      verb: "release_batch",
      batchId: "b-aaa",
    });
  });

  it("matches a marker typed in the comment body when quotedText is absent", () => {
    const result = resolveDocComment({
      comment: comment({ body: "go with [opt-2]" }),
      plan: plan(),
      operatorAllowlist: ALLOWLIST,
    });
    expect(result.kind).toBe("intent");
    if (result.kind === "intent") {
      expect(result.verb).toBe("hold");
      expect(result.batchId).toBe("b-bbb");
    }
  });

  it("ignores a non-operator author (agent identity cannot self-approve)", () => {
    const result = resolveDocComment({
      comment: comment({
        authorEmail: "agents@mobilyze.com", // not on the allowlist
        quotedText: "[opt-1] Release b-aaa (parallel-isolated): SYMPH-1",
      }),
      plan: plan(),
      operatorAllowlist: ALLOWLIST,
    });
    expect(result).toEqual({ kind: "ignored", reason: "non_operator" });
  });

  it("treats a comment predating the current revision as stale (revision binding)", () => {
    const result = resolveDocComment({
      comment: comment({
        createdAt: "2026-06-18T00:01:00.000Z", // before plan.updatedAt 00:05
        quotedText: "[opt-1] ...",
      }),
      plan: plan(),
      operatorAllowlist: ALLOWLIST,
    });
    expect(result.kind).toBe("stale");
  });

  it("returns free_text for a non-marker comment (interpret-then-confirm)", () => {
    const result = resolveDocComment({
      comment: comment({ body: "actually, can we prioritize the auth work?" }),
      plan: plan(),
      operatorAllowlist: ALLOWLIST,
    });
    expect(result.kind).toBe("free_text");
  });

  it("is ambiguous when multiple markers match", () => {
    const result = resolveDocComment({
      comment: comment({ body: "[opt-1] and also [opt-2]" }),
      plan: plan(),
      operatorAllowlist: ALLOWLIST,
    });
    expect(result.kind).toBe("ambiguous");
  });

  it("normalizes markdown so backtick-stripped quotedText still matches", () => {
    const result = resolveDocComment({
      comment: comment({
        // Linear strips backticks/formatting from quotedText.
        quotedText: "opt-1 Release b-aaa (parallel-isolated): SYMPH-1",
        body: "",
      }),
      plan: plan(),
      operatorAllowlist: ALLOWLIST,
    });
    expect(result.kind).toBe("intent");
    if (result.kind === "intent") {
      expect(result.optionMarker).toBe("[opt-1]");
    }
  });
});
