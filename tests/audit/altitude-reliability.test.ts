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
    for (const entry of ALTITUDE_RELIABILITY_CORPUS) {
      expect(entry.snapshot.title).not.toBe("");
      expect(entry.snapshot.description).not.toBe("");
      expect(Date.parse(entry.snapshot.cutoff)).toBeLessThan(
        Date.parse(entry.snapshot.answerIntroducedAt),
      );
      expect(entry.snapshot.reconstructionNote).toContain(
        "not claimed as a historical export",
      );
    }
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
      protocol: "snapshot-v1",
      kind: "altitude_reliability_retest",
      model: "local-skeptic-v1",
      capability_arrived: false,
      metrics: { falseKills: 1 },
    });
  });

  it("rejects a snapshot whose cutoff includes answer-bearing content", async () => {
    const fixture = ALTITUDE_RELIABILITY_CORPUS[0];
    if (fixture === undefined) throw new Error("expected a corpus fixture");
    await expect(
      runAltitudeReliabilityRetest({
        model: "x",
        corpus: [
          {
            ...fixture,
            snapshot: {
              ...fixture.snapshot,
              cutoff: "2026-06-28T06:30:27.656Z",
            },
          },
        ],
        runVerdict: async () => "kill",
      }),
    ).rejects.toThrow(/cutoff must precede answer-bearing content/);
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

  it("scores parseable output-contract violations as incorrect model cases", async () => {
    const result = await runAltitudeReliabilityRetest({
      model: "verbose-model-v0",
      generatedAt: "2026-06-29T00:00:00.000Z",
      runVerdict: async (testCase) =>
        testCase.issueIdentifier === "SYMPH-941"
          ? {
              verdict: testCase.expectedVerdict,
              contractViolation: {
                type: "output_contract_violation",
                detail: "response included prose after the verdict JSON",
              },
            }
          : testCase.expectedVerdict,
    });

    expect(result.metrics.accuracy).toBe(4 / 5);
    expect(result.capabilityArrived).toBe(false);
    expect(result.results[0]).toMatchObject({
      issueIdentifier: "SYMPH-941",
      actualVerdict: "kill",
      correct: false,
      contractViolation: {
        type: "output_contract_violation",
      },
    });
    const ledger = buildAltitudeReliabilityLedgerEntry(result) as {
      cases: Array<Record<string, unknown>>;
    };
    expect(
      ledger.cases.find((entry) => entry.issue_identifier === "SYMPH-941"),
    ).toMatchObject({
      model_contract_violation: {
        type: "output_contract_violation",
      },
      correct: false,
    });
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
