import { describe, expect, it } from "vitest";

import type { RightSizingDecision } from "../../src/domain/model.js";
import { formatAdmissionCard } from "../../src/orchestrator/admission-card.js";

function decision(
  overrides: Partial<RightSizingDecision> = {},
): RightSizingDecision {
  const riskPredicate: RightSizingDecision["riskPredicate"] = {
    triggerHits: [],
    matchedPaths: [],
    matches: [],
  };
  const baseDecision: RightSizingDecision = {
    classifier: "deterministic-v1",
    mode: "thin",
    stageName: "investigate",
    reason: "small declared scope, no high-risk files",
    rationale: ["scope under threshold"],
    triggerHits: [],
    riskPredicate,
    reasoningEffort: {
      configuredEffort: null,
      selectedEffort: null,
      escalated: false,
      reason: "not_configured",
      stageEligible: true,
      riskPredicateTriggers: [],
      matchedPaths: [],
      sameFamilyTripwire: false,
    },
    signals: {
      explicitModeHint: null,
      declaredScopeFiles: ["src/a.ts", "src/b.ts"],
      changedFiles: [],
      impactSurface: "narrow",
      highRiskFiles: [],
      riskPredicate,
      stageCount: 4,
      gateCount: 1,
      reviewerCount: 1,
      humanGateCount: 0,
      blockedByCount: 0,
      retryCount: 0,
      priority: 2,
      labels: [],
      plannedTurns: 8,
      budget: "low",
    },
    modelRouting: { allowed: false, reason: "not_needed" },
  };

  return {
    ...baseDecision,
    ...overrides,
  };
}

describe("formatAdmissionCard (SYMPH-379)", () => {
  it("renders the decision the dispatcher journaled — route, scope, budget, verification path", () => {
    const card = formatAdmissionCard({
      issueIdentifier: "SYMPH-999",
      stageName: "investigate",
      decision: decision(),
      budgetMultiplier: 1,
      hasFrozenAcceptanceCriteria: false,
    });

    expect(card).toContain("## Admission Card");
    expect(card).toContain("**Decision:** admit → investigate");
    expect(card).toContain("`thin` via `deterministic-v1`");
    expect(card).toContain("small declared scope, no high-risk files");
    expect(card).toContain("deterministic route sufficed");
    expect(card).toContain("thin ceilings");
    expect(card).not.toContain("escalated");
    expect(card).toContain("src/a.ts, src/b.ts");
    expect(card).toContain("acceptance criteria not yet frozen");
    expect(card).toContain("no model calls");
  });

  it("surfaces escalated budgets, risk files, frozen ACs, and bounds the scope list", () => {
    const manyFiles = Array.from({ length: 12 }, (_, i) => `src/f${i}.ts`);
    const card = formatAdmissionCard({
      issueIdentifier: "SYMPH-998",
      stageName: null,
      decision: decision({
        signals: {
          ...decision().signals,
          declaredScopeFiles: manyFiles,
          highRiskFiles: ["src/orchestrator/core.ts"],
        },
        modelRouting: { allowed: true, reason: "risk_trigger" },
      }),
      budgetMultiplier: 2,
      hasFrozenAcceptanceCriteria: true,
    });

    expect(card).toContain("admit → initial stage");
    expect(card).toContain("× 2 (escalated)");
    expect(card).toContain("(+4 more)");
    expect(card).toContain("model consult allowed: risk trigger");
    expect(card).toContain(
      "**Risk surface:** touches high-risk files — src/orchestrator/core.ts",
    );
    expect(card).toContain("frozen acceptance criteria on record");
  });

  it("renders the ambiguous-routing consult line and bounds the risk-file list", () => {
    const manyRiskFiles = Array.from({ length: 10 }, (_, i) => `src/r${i}.ts`);
    const card = formatAdmissionCard({
      issueIdentifier: "SYMPH-996",
      stageName: "implement",
      decision: decision({
        signals: {
          ...decision().signals,
          highRiskFiles: manyRiskFiles,
        },
        modelRouting: { allowed: true, reason: "ambiguous_routing" },
      }),
      budgetMultiplier: 1,
      hasFrozenAcceptanceCriteria: false,
    });

    expect(card).toContain(
      "model consult allowed: deterministic signals were ambiguous",
    );
    expect(card).toContain("**Risk surface:**");
    expect(card).toContain("src/r7.ts (+2 more)");
    expect(card).not.toContain("src/r8.ts");
  });

  it("renders 'none declared' when the decision carries no declared scope", () => {
    const card = formatAdmissionCard({
      issueIdentifier: "SYMPH-997",
      stageName: "investigate",
      decision: decision({
        signals: {
          ...decision().signals,
          declaredScopeFiles: [],
        },
      }),
      budgetMultiplier: 1,
      hasFrozenAcceptanceCriteria: false,
    });

    expect(card).toContain("**Declared scope:** none declared");
  });
});
