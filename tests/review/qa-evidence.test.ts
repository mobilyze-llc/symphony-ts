import { describe, expect, it } from "vitest";

import {
  type BrowserQaEvidence,
  assessBrowserQaEvidence,
  parseBrowserQaEvidence,
} from "../../src/review/qa-evidence.js";

function completeEvidence(
  overrides: Partial<BrowserQaEvidence> = {},
): BrowserQaEvidence {
  return {
    schemaVersion: 1,
    kind: "symphony-browser-qa-evidence",
    targetUrl: "http://localhost:3000/checkout",
    headSha: "abc123def456",
    scenario: "checkout happy path",
    assertions: [
      { description: "submit button is enabled", passed: true },
      { description: "order summary renders total", passed: true },
    ],
    mediaRefs: [
      { kind: "screenshot", path: "/artifacts/qa/checkout.png", sha256: null },
    ],
    consoleFindings: [],
    networkFindings: [],
    failureRule: {
      id: "no-console-errors",
      description: "no console errors and all assertions pass",
      violated: false,
    },
    ...overrides,
  };
}

describe("assessBrowserQaEvidence", () => {
  it("passes complete evidence with all assertions passing and no rule violation", () => {
    const assessment = assessBrowserQaEvidence(completeEvidence());
    expect(assessment.disposition).toBe("pass");
    expect(assessment.reasons).toEqual([]);
    expect(assessment.blocking).toBe(false);
  });

  it("blocks (fail-closed) when the failure rule is violated", () => {
    const assessment = assessBrowserQaEvidence(
      completeEvidence({
        consoleFindings: [
          { level: "error", message: "Uncaught TypeError: x is undefined" },
        ],
        failureRule: {
          id: "no-console-errors",
          description: "no console errors and all assertions pass",
          violated: true,
        },
      }),
    );
    expect(assessment.disposition).toBe("block");
    expect(assessment.blocking).toBe(true);
    expect(assessment.reasons).toContain(
      "qa_failure_rule_violated:no-console-errors",
    );
  });

  it("blocks when an assertion failed even if the rule flag was not set", () => {
    const assessment = assessBrowserQaEvidence(
      completeEvidence({
        assertions: [
          { description: "submit button is enabled", passed: true },
          { description: "order summary renders total", passed: false },
        ],
      }),
    );
    expect(assessment.disposition).toBe("block");
    expect(assessment.blocking).toBe(true);
    expect(assessment.reasons).toContain("qa_assertion_failed");
  });

  it("blocks when there are no assertions (no evidence of what was checked)", () => {
    const assessment = assessBrowserQaEvidence(
      completeEvidence({ assertions: [] }),
    );
    expect(assessment.disposition).toBe("block");
    expect(assessment.reasons).toContain("qa_no_assertions");
  });

  it("degrades explicitly when evidence is null (missing QA artifact)", () => {
    const assessment = assessBrowserQaEvidence(null, { policy: "degrade" });
    expect(assessment.disposition).toBe("degrade");
    expect(assessment.blocking).toBe(true);
    expect(assessment.reasons).toContain("qa_evidence_missing");
  });

  it("fails closed (block) when evidence is null under the default policy", () => {
    const assessment = assessBrowserQaEvidence(null);
    expect(assessment.disposition).toBe("block");
    expect(assessment.blocking).toBe(true);
    expect(assessment.reasons).toContain("qa_evidence_missing");
  });

  it("blocks when required structured fields are absent (malformed)", () => {
    // A target URL is load-bearing: without it the QA evidence cannot be
    // tied to what was exercised, so it must not silently pass.
    const assessment = assessBrowserQaEvidence(
      completeEvidence({ targetUrl: "" }),
    );
    expect(assessment.disposition).toBe("block");
    expect(assessment.reasons).toContain("qa_evidence_malformed:targetUrl");
  });

  it("blocks when the reviewed head sha is absent (cannot tie QA to a commit)", () => {
    const assessment = assessBrowserQaEvidence(
      completeEvidence({ headSha: "" }),
    );
    expect(assessment.disposition).toBe("block");
    expect(assessment.reasons).toContain("qa_evidence_malformed:headSha");
  });

  it("passes when the QA head sha matches the expected current head (freshness)", () => {
    const assessment = assessBrowserQaEvidence(
      completeEvidence({ headSha: "abc123def456" }),
      { currentHeadSha: "abc123def456" },
    );
    expect(assessment.disposition).toBe("pass");
    expect(assessment.reasons).toEqual([]);
  });

  it("blocks (fail closed) when the QA artifact targets a stale head", () => {
    // A QA run captured against an older commit must not count toward a PASS,
    // even if every assertion passed and the failure rule is not violated.
    const assessment = assessBrowserQaEvidence(
      completeEvidence({ headSha: "stale-head-zzz" }),
      { currentHeadSha: "current-head-aaa" },
    );
    expect(assessment.disposition).toBe("block");
    expect(assessment.blocking).toBe(true);
    expect(assessment.reasons).toContain("qa_stale_review");
  });
});

describe("parseBrowserQaEvidence", () => {
  it("returns structured evidence for a well-formed record", () => {
    const evidence = parseBrowserQaEvidence(
      JSON.parse(JSON.stringify(completeEvidence())),
    );
    expect(evidence).not.toBeNull();
    expect(evidence?.targetUrl).toBe("http://localhost:3000/checkout");
    expect(evidence?.assertions).toHaveLength(2);
    expect(evidence?.failureRule.violated).toBe(false);
  });

  it("returns null for non-object / wrong-kind / wrong-schema input (fail closed)", () => {
    expect(parseBrowserQaEvidence(null)).toBeNull();
    expect(parseBrowserQaEvidence("nope")).toBeNull();
    expect(
      parseBrowserQaEvidence({ kind: "other", schemaVersion: 1 }),
    ).toBeNull();
    expect(
      parseBrowserQaEvidence({
        kind: "symphony-browser-qa-evidence",
        schemaVersion: 2,
      }),
    ).toBeNull();
  });

  it("coerces malformed nested arrays without throwing", () => {
    const raw = JSON.parse(JSON.stringify(completeEvidence())) as Record<
      string,
      unknown
    >;
    raw.assertions = [{ description: "ok", passed: true }, "garbage", null];
    raw.consoleFindings = "not-an-array";
    const evidence = parseBrowserQaEvidence(raw);
    expect(evidence).not.toBeNull();
    // The single well-formed assertion survives; malformed entries are dropped.
    expect(evidence?.assertions).toHaveLength(1);
    expect(evidence?.consoleFindings).toEqual([]);
  });

  it("treats a failed parse-able assertion as a violated rule via the assessor", () => {
    const raw = JSON.parse(JSON.stringify(completeEvidence())) as Record<
      string,
      unknown
    >;
    raw.assertions = [{ description: "must pass", passed: false }];
    const evidence = parseBrowserQaEvidence(raw);
    expect(evidence).not.toBeNull();
    const assessment = assessBrowserQaEvidence(evidence);
    expect(assessment.disposition).toBe("block");
  });

  it("fails closed (null) when failureRule.violated is omitted", () => {
    // An omitted `violated` must NOT silently parse as false (which would let a
    // malformed artifact PASS). The contract is fail-closed on malformed QA.
    const raw = JSON.parse(JSON.stringify(completeEvidence())) as Record<
      string,
      unknown
    >;
    raw.failureRule = {
      id: "no-console-errors",
      description: "no console errors and all assertions pass",
    };
    const evidence = parseBrowserQaEvidence(raw);
    expect(evidence).toBeNull();
    // The missing artifact then fails closed at the assessor.
    expect(assessBrowserQaEvidence(evidence).disposition).toBe("block");
  });

  it("fails closed (null) when failureRule.violated is a string instead of a boolean", () => {
    const raw = JSON.parse(JSON.stringify(completeEvidence())) as Record<
      string,
      unknown
    >;
    raw.failureRule = {
      id: "no-console-errors",
      description: "no console errors and all assertions pass",
      violated: "true",
    };
    expect(parseBrowserQaEvidence(raw)).toBeNull();
  });

  it("accepts an explicit boolean violated of either value", () => {
    const rawTrue = JSON.parse(JSON.stringify(completeEvidence())) as Record<
      string,
      unknown
    >;
    rawTrue.failureRule = {
      id: "no-console-errors",
      description: "rule",
      violated: true,
    };
    expect(parseBrowserQaEvidence(rawTrue)?.failureRule.violated).toBe(true);

    const rawFalse = JSON.parse(JSON.stringify(completeEvidence())) as Record<
      string,
      unknown
    >;
    rawFalse.failureRule = {
      id: "no-console-errors",
      description: "rule",
      violated: false,
    };
    expect(parseBrowserQaEvidence(rawFalse)?.failureRule.violated).toBe(false);
  });
});
