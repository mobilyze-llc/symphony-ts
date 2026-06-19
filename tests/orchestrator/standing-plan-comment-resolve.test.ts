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

  it("resolves a revision-stamped marker for the current revision", () => {
    const result = resolveDocComment({
      comment: comment({ quotedText: "[opt-1:r4] Release b-aaa" }),
      plan: plan(),
      operatorAllowlist: ALLOWLIST,
    });
    expect(result.kind).toBe("intent");
    if (result.kind === "intent") {
      expect(result.optionMarker).toBe("[opt-1]");
    }
  });

  it("treats a stamped marker from a superseded revision as stale (closes the publish race)", () => {
    const result = resolveDocComment({
      comment: comment({
        // current plan is revision 4; this quotes revision 3's reused [opt-1]
        quotedText: "[opt-1:r3] Release some-other-batch",
      }),
      plan: plan(),
      operatorAllowlist: ALLOWLIST,
    });
    expect(result.kind).toBe("stale");
  });

  it("does not let a current-revision body stamp rescue a superseded quoted stamp", () => {
    // The operator quoted a SUPERSEDED option line ([opt-2:r3]); their free-typed
    // body happens to contain a current stamp ([opt-1:r4]). quotedText is the
    // authoritative action signal, so a stale quote must resolve to `stale` — the
    // body stamp must NOT rescue it into a current intent (council R2, Codex P1).
    const result = resolveDocComment({
      comment: comment({
        quotedText: "[opt-2:r3] Hold some-old-batch",
        body: "go [opt-1:r4]",
      }),
      plan: plan(),
      operatorAllowlist: ALLOWLIST,
    });
    expect(result.kind).toBe("stale");
  });

  it("falls back to body stamps only when the quoted line carries no stamp", () => {
    const result = resolveDocComment({
      comment: comment({
        quotedText: "looks good to me", // no stamped marker
        body: "approve [opt-1:r4]",
      }),
      plan: plan(),
      operatorAllowlist: ALLOWLIST,
    });
    expect(result.kind).toBe("intent");
    if (result.kind === "intent") {
      expect(result.optionMarker).toBe("[opt-1]");
    }
  });

  it("prefers the quoted line's marker over a different marker in the body", () => {
    const result = resolveDocComment({
      comment: comment({
        quotedText: "[opt-2] Hold b-bbb",
        body: "though [opt-1] should go first too",
      }),
      plan: plan(),
      operatorAllowlist: ALLOWLIST,
    });
    expect(result.kind).toBe("intent");
    if (result.kind === "intent") {
      expect(result.verb).toBe("hold"); // opt-2 (quoted), not opt-1 (body)
    }
  });

  it("does not extract a stamped marker embedded inside a longer word", () => {
    // The stamped extractor must apply the same word-boundary discipline as the
    // bare-marker path: "adopt-1:r4" contains the substring "opt-1:r4" but is not
    // an option reference, so it must NOT resolve to opt-1 (council R3, Pi P3).
    const result = resolveDocComment({
      comment: comment({ quotedText: "adopt-1:r4 sounds fine", body: "" }),
      plan: plan(),
      operatorAllowlist: ALLOWLIST,
    });
    expect(result.kind).toBe("free_text");
  });

  it("does not match opt-1 inside opt-10", () => {
    const p = plan();
    p.options = [
      {
        marker: "[opt-10]",
        label: "Release b-ten",
        intent: { verb: "release_batch", batchId: "b-ten" },
      },
    ];
    const result = resolveDocComment({
      comment: comment({ body: "approve [opt-1]" }),
      plan: p,
      operatorAllowlist: ALLOWLIST,
    });
    // opt-1 must NOT match the only option opt-10.
    expect(result.kind).toBe("free_text");
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
