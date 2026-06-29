import { describe, expect, it } from "vitest";

import {
  ALTITUDE_RELIABILITY_CORPUS,
  buildAltitudeReliabilityLedgerEntry,
  runAltitudeReliabilityRetest,
  scoreAltitudeReliability,
} from "../../src/audit/altitude-reliability.js";

describe("altitude reliability re-test protocol", () => {
  it("ships a fixed corpus with kill, keep, and reframe outcomes", () => {
    expect(
      ALTITUDE_RELIABILITY_CORPUS.map((entry) => entry.issueIdentifier),
    ).toEqual([
      "SYMPH-941",
      "SYMPH-944",
      "SYMPH-958",
      "SYMPH-956",
      "SYMPH-957",
    ]);
    expect(
      new Set(
        ALTITUDE_RELIABILITY_CORPUS.map((entry) => entry.expectedVerdict),
      ),
    ).toEqual(new Set(["kill", "keep", "reframe"]));
  });

  it("scores unattended per-model verdicts with kill precision and false-kill pressure", async () => {
    const result = await runAltitudeReliabilityRetest({
      model: "local-skeptic-v1",
      generatedAt: "2026-06-29T00:00:00.000Z",
      runVerdict: async (testCase) =>
        testCase.issueIdentifier === "SYMPH-956"
          ? "kill"
          : testCase.expectedVerdict,
    });

    expect(result.unattended).toBe(true);
    expect(result.metrics.falseKills).toBe(1);
    expect(result.metrics.killPrecision).toBe(0.75);
    expect(result.capabilityArrived).toBe(false);
    expect(buildAltitudeReliabilityLedgerEntry(result)).toMatchObject({
      kind: "altitude_reliability_retest",
      model: "local-skeptic-v1",
      capability_arrived: false,
      metrics: { falseKills: 1 },
    });
  });

  it("denies capability to a model that makes no kills when the corpus expects them", async () => {
    const result = await runAltitudeReliabilityRetest({
      model: "do-nothing-v0",
      generatedAt: "2026-06-29T00:00:00.000Z",
      runVerdict: async () => "keep",
    });

    // A model that never kills must not be rewarded with perfect kill precision
    // (the zero-denominator trap) and must not pass the capability bar.
    expect(result.metrics.killPrecision).toBe(0);
    expect(result.capabilityArrived).toBe(false);
  });

  it("refuses to score an empty corpus instead of reporting phantom capability", async () => {
    await expect(
      runAltitudeReliabilityRetest({
        model: "x",
        corpus: [],
        runVerdict: async () => "keep",
      }),
    ).rejects.toThrow(/corpus must be non-empty/);
  });

  it("refuses direct empty-result scoring instead of reporting perfect metrics", () => {
    expect(() => scoreAltitudeReliability([])).toThrow(
      /zero observations cannot measure capability/,
    );
  });
});
