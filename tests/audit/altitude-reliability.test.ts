import { describe, expect, it } from "vitest";

import {
  ALTITUDE_RELIABILITY_CORPUS,
  buildAltitudeReliabilityLedgerEntry,
  runAltitudeReliabilityRetest,
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
});
