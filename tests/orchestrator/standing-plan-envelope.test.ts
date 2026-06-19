import { describe, expect, it } from "vitest";

import type {
  PlanBatch,
  PlanEnvelope,
} from "../../src/domain/standing-plan.js";
import {
  envelopeVersionChanged,
  resolveStandingPlanEnvelope,
  validatePlanAgainstEnvelope,
} from "../../src/orchestrator/standing-plan-envelope.js";

function batch(mode: PlanBatch["mode"]): PlanBatch {
  return {
    batchId: `b-${mode}`,
    mode,
    status: "lookahead",
    members: [{ issueId: "i", issueIdentifier: "SYMPH-1" }],
    rationale: "r",
    canary: null,
  };
}

describe("resolveStandingPlanEnvelope", () => {
  it("applies spine defaults: parallel-isolated + canary-chain (shared-surface still gated)", () => {
    const envelope = resolveStandingPlanEnvelope({ concurrencyCeiling: 3 });
    expect(envelope.version).toBe(1);
    expect(envelope.concurrencyCeiling).toBe(3);
    expect(envelope.allowedRisk).toBe("medium");
    expect(envelope.allowedModes).toEqual([
      "parallel-isolated",
      "canary-chain",
    ]);
  });

  it("honors explicit overrides", () => {
    const envelope = resolveStandingPlanEnvelope({
      version: 7,
      concurrencyCeiling: 5,
      allowedRisk: "high",
      allowedModes: ["parallel-isolated", "shared-surface"],
    });
    expect(envelope).toEqual<PlanEnvelope>({
      version: 7,
      concurrencyCeiling: 5,
      allowedRisk: "high",
      allowedModes: ["parallel-isolated", "shared-surface"],
    });
  });

  it("rejects an invalid concurrency ceiling", () => {
    expect(() =>
      resolveStandingPlanEnvelope({ concurrencyCeiling: 0 }),
    ).toThrow();
  });

  it("rejects an unknown batch mode", () => {
    expect(() =>
      resolveStandingPlanEnvelope({
        concurrencyCeiling: 2,
        allowedModes: ["nope" as PlanBatch["mode"]],
      }),
    ).toThrow();
  });
});

describe("validatePlanAgainstEnvelope", () => {
  const envelope: PlanEnvelope = {
    version: 1,
    concurrencyCeiling: 3,
    allowedRisk: "medium",
    allowedModes: ["parallel-isolated"],
  };

  it("passes when every batch mode is allowed", () => {
    const result = validatePlanAgainstEnvelope(
      [batch("parallel-isolated")],
      envelope,
    );
    expect(result.ok).toBe(true);
    expect(result.violations).toEqual([]);
  });

  it("flags a batch whose mode is outside the envelope", () => {
    const result = validatePlanAgainstEnvelope(
      [batch("parallel-isolated"), batch("shared-surface")],
      envelope,
    );
    expect(result.ok).toBe(false);
    expect(result.violations).toHaveLength(1);
    expect(result.violations[0]).toContain("shared-surface");
  });
});

describe("envelopeVersionChanged", () => {
  const base: PlanEnvelope = {
    version: 4,
    concurrencyCeiling: 3,
    allowedRisk: "medium",
    allowedModes: ["parallel-isolated"],
  };

  it("detects a version bump (a re-plan trigger)", () => {
    expect(envelopeVersionChanged(base, { ...base, version: 5 })).toBe(true);
  });

  it("ignores non-version changes (version is the contract surface)", () => {
    expect(
      envelopeVersionChanged(base, { ...base, concurrencyCeiling: 9 }),
    ).toBe(false);
  });
});
