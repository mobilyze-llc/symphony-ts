import { describe, expect, it } from "vitest";

import type { DispatcherRunJournalEntry } from "../../src/domain/model.js";
import {
  type TrackFindingFilingResult,
  buildTrackFindingFilingMetadata,
  buildTrackFindingIssueBody,
  buildTrackFindingIssueTitle,
  collectTrackFindingsToFile,
  reconcileFilingResult,
  reduceTrackFindingFilings,
  trackFindingMarker,
} from "../../src/orchestrator/track-finding-filing.js";
import type {
  CouncilTrackFindingFiling,
  HeadlessLaneResult,
  StructuredReviewFinding,
} from "../../src/review/headless-council-gate.js";

function finding(
  overrides: Partial<StructuredReviewFinding> & { fingerprint: string },
): StructuredReviewFinding {
  return {
    fingerprint: overrides.fingerprint,
    severity: overrides.severity ?? "Track",
    emittedSeverity: overrides.emittedSeverity ?? "Track",
    title: overrides.title ?? "finding title",
    titleStem: overrides.titleStem ?? "finding title",
    category: overrides.category ?? "correctness",
    confidence: overrides.confidence ?? 0.8,
    evidence: overrides.evidence ?? [],
    relatedPaths: overrides.relatedPaths ?? [],
    rationale: overrides.rationale ?? "because reasons",
    leadDisposition: overrides.leadDisposition ?? "track",
    repeatOf: overrides.repeatOf ?? null,
    introducedIn: overrides.introducedIn ?? "original_diff",
    dismissalReason: overrides.dismissalReason ?? null,
    family: overrides.family ?? null,
  };
}

function laneWithFindings(
  findings: StructuredReviewFinding[],
): HeadlessLaneResult {
  return {
    laneId: "lane-1",
    agent: "codex",
    role: "lead",
    model: "gpt",
    state: "complete",
    verdict: "pass",
    artifactPath: null,
    promptPath: null,
    stderrPath: null,
    cliJsonPath: null,
    reasoningEffort: null,
    independentReviewer: true,
    mergeAuthoritative: true,
    message: null,
    degradedReason: null,
    reviewBundle: null,
    wallTimeMs: null,
    tokenUsage: null,
    structuredArtifact: {
      schemaVersion: 1,
      kind: "symphony-headless-council-reviewer-artifact",
      lane: {
        laneId: "lane-1",
        agent: "codex",
        role: "lead",
        model: "gpt",
        modelFamily: "openai-codex",
        reasoningEffort: null,
        independentReviewer: true,
        mergeAuthoritative: true,
      },
      routing: { mode: "full", routingMode: "standard", round: 1 },
      reviewBundle: null,
      verdict: "pass",
      confidence: 0.9,
      parseStatus: "synthesized_from_markdown",
      rawArtifactPath: null,
      malformedReason: null,
      sections: {
        findings: "",
        p1: "",
        p2: "",
        track: "",
        dismissedOrTheoretical: "",
        triage: "",
      },
      findings,
    },
  };
}

function baseEntry(issueId: string): Omit<DispatcherRunJournalEntry, "kind"> {
  return {
    sequence: 1,
    idempotencyKey: `key-${issueId}`,
    timestamp: "2026-06-17T00:00:00.000Z",
    issueId,
    issueIdentifier: `ID-${issueId}`,
    operation: "tracker_write",
    stage: "review",
    attempt: 1,
    ownerId: "owner",
    lease: null,
    summary: "track finding filing",
    metadata: {},
  };
}

function filingEntry(
  issueId: string,
  metadata: Record<string, unknown>,
  sequence = 1,
): DispatcherRunJournalEntry {
  return {
    ...baseEntry(issueId),
    sequence,
    idempotencyKey: `track_finding_filing:${issueId}:${sequence}`,
    kind: "track_finding_filing",
    metadata,
  };
}

describe("track-finding-filing pure helpers", () => {
  it("builds a stable fingerprint marker", () => {
    expect(trackFindingMarker("abc123def456")).toBe("[track:abc123def456]");
  });

  it("prefixes the finding title with the fingerprint marker", () => {
    expect(
      buildTrackFindingIssueTitle({
        fingerprint: "abc123",
        title: "Null deref in foo()",
      }),
    ).toBe("[track:abc123] Null deref in foo()");
  });

  it("truncates an overlong title while keeping the full marker", () => {
    const title = buildTrackFindingIssueTitle({
      fingerprint: "abc123",
      title: "x".repeat(500),
    });
    expect(title.startsWith("[track:abc123] ")).toBe(true);
    expect(title.length).toBeLessThanOrEqual(250);
  });

  it("includes the marker, source refs, rationale, and evidence in the body", () => {
    const body = buildTrackFindingIssueBody(
      {
        fingerprint: "abc123",
        title: "Null deref in foo()",
        category: "correctness",
        rationale: "foo() can be called with null when bar is empty.",
        evidence: [{ path: "src/foo.ts", lineStart: 42, lineEnd: 44 }],
      },
      {
        sourceIssueIdentifier: "SYMPH-700",
        sourceIssueUrl: "https://linear.app/x/issue/SYMPH-700",
        repo: "mobilyze-llc/symphony-ts",
        prNumber: 812,
        reviewedHeadSha: "deadbeef",
      },
    );
    expect(body).toContain("[track:abc123]");
    expect(body).toContain("SYMPH-700");
    expect(body).toContain("#812");
    expect(body).toContain("src/foo.ts:42");
    expect(body).toContain("foo() can be called with null when bar is empty.");
    expect(body).toContain("correctness");
  });

  it("selects only unfiled surviving track findings and enriches from lanes", () => {
    const trackFiling: CouncilTrackFindingFiling = {
      status: "unfiled",
      required: 2,
      filed: 1,
      reason: "track_findings_partially_filed",
      findings: [
        {
          fingerprint: "fp-already",
          title: "Already filed",
          issueId: "ISSUE-X",
          url: "u",
        },
        {
          fingerprint: "fp-new",
          title: "Needs filing",
          issueId: null,
          url: null,
        },
      ],
    };
    const lanes = [
      laneWithFindings([
        finding({
          fingerprint: "fp-new",
          title: "Needs filing",
          category: "perf",
          rationale: "slow loop",
          evidence: [
            { path: "a.ts", lineStart: 5, lineEnd: 5, changedPath: true },
          ],
        }),
      ]),
    ];

    const toFile = collectTrackFindingsToFile(trackFiling, lanes, new Set());

    expect(toFile).toHaveLength(1);
    expect(toFile[0]).toMatchObject({
      fingerprint: "fp-new",
      title: "Needs filing",
      category: "perf",
      rationale: "slow loop",
    });
    expect(toFile[0]?.evidence).toEqual([
      { path: "a.ts", lineStart: 5, lineEnd: 5 },
    ]);
  });

  it("skips findings already filed in the journal", () => {
    const trackFiling: CouncilTrackFindingFiling = {
      status: "unfiled",
      required: 1,
      filed: 0,
      reason: "track_findings_unfiled",
      findings: [{ fingerprint: "fp-1", title: "t", issueId: null, url: null }],
    };
    expect(
      collectTrackFindingsToFile(trackFiling, [], new Set(["fp-1"])),
    ).toEqual([]);
  });

  it("treats an empty-string issueId as unfiled (defensive)", () => {
    const trackFiling: CouncilTrackFindingFiling = {
      status: "unfiled",
      required: 1,
      filed: 0,
      reason: "track_findings_unfiled",
      findings: [{ fingerprint: "fp-1", title: "t", issueId: "", url: null }],
    };
    expect(
      collectTrackFindingsToFile(trackFiling, [], new Set()).map(
        (f) => f.fingerprint,
      ),
    ).toEqual(["fp-1"]);
  });

  it("falls back to title-only enrichment when a finding is absent from lanes", () => {
    const trackFiling: CouncilTrackFindingFiling = {
      status: "unfiled",
      required: 1,
      filed: 0,
      reason: "track_findings_unfiled",
      findings: [{ fingerprint: "fp-1", title: "t", issueId: null, url: null }],
    };
    expect(collectTrackFindingsToFile(trackFiling, [], new Set())).toEqual([
      {
        fingerprint: "fp-1",
        title: "t",
        category: null,
        rationale: null,
        evidence: [],
      },
    ]);
  });

  it("returns nothing when the filing status is none or fully filed", () => {
    expect(
      collectTrackFindingsToFile(
        { status: "none", required: 0, filed: 0, reason: null, findings: [] },
        [],
        new Set(),
      ),
    ).toEqual([]);
    expect(
      collectTrackFindingsToFile(
        {
          status: "filed",
          required: 1,
          filed: 1,
          reason: null,
          findings: [
            { fingerprint: "fp", title: "t", issueId: "I", url: null },
          ],
        },
        [],
        new Set(),
      ),
    ).toEqual([]);
  });

  it("reduces filed refs from track_finding_filing journal entries", () => {
    const journal = [
      filingEntry("issue-1", {
        filings: [
          {
            fingerprint: "fp-1",
            issue_id: "ID-1",
            identifier: "SYMPH-1",
            url: "u1",
            status: "filed",
          },
          { fingerprint: "fp-2", status: "unfiled", reason: "tracker timeout" },
        ],
      }),
    ];
    const map = reduceTrackFindingFilings(journal, "issue-1");
    expect(map.get("fp-1")).toEqual({
      fingerprint: "fp-1",
      issueId: "ID-1",
      identifier: "SYMPH-1",
      url: "u1",
    });
    expect(map.has("fp-2")).toBe(false);
  });

  it("lets a later filed entry win over an earlier unfiled one", () => {
    const journal = [
      filingEntry(
        "issue-1",
        {
          filings: [{ fingerprint: "fp-1", status: "unfiled", reason: "down" }],
        },
        1,
      ),
      filingEntry(
        "issue-1",
        {
          filings: [
            {
              fingerprint: "fp-1",
              issue_id: "ID-1",
              identifier: "SYMPH-1",
              url: "u",
              status: "filed",
            },
          ],
        },
        2,
      ),
    ];
    expect(
      reduceTrackFindingFilings(journal, "issue-1").get("fp-1")?.issueId,
    ).toBe("ID-1");
  });

  it("builds filed metadata and round-trips refs through reduce", () => {
    const metadata = buildTrackFindingFilingMetadata({
      required: 1,
      reviewedHeadSha: "head-sha",
      filed: [
        {
          fingerprint: "fp-1",
          issueId: "ID-1",
          identifier: "SYMPH-1",
          url: "u1",
        },
      ],
      unfiled: [],
    });
    expect(metadata.track_filing_status).toBe("filed");
    expect(metadata.track_filing_filed_count).toBe(1);
    expect(metadata.track_filing_required).toBe(1);
    expect(metadata.track_filing_reason).toBeUndefined();
    expect(metadata.reviewed_head_sha).toBe("head-sha");

    const map = reduceTrackFindingFilings(
      [{ ...baseEntry("issue-1"), kind: "track_finding_filing", metadata }],
      "issue-1",
    );
    expect(map.get("fp-1")).toEqual({
      fingerprint: "fp-1",
      issueId: "ID-1",
      identifier: "SYMPH-1",
      url: "u1",
    });
  });

  it("marks partially-filed metadata unfiled and preserves the exact per-finding reason", () => {
    const metadata = buildTrackFindingFilingMetadata({
      required: 2,
      reviewedHeadSha: "head-sha",
      filed: [
        {
          fingerprint: "fp-1",
          issueId: "ID-1",
          identifier: "SYMPH-1",
          url: "u1",
        },
      ],
      unfiled: [{ fingerprint: "fp-2", reason: "Linear 500: timeout" }],
    });
    expect(metadata.track_filing_status).toBe("unfiled");
    expect(metadata.track_filing_reason).toBe("track_findings_partially_filed");
    const filings = metadata.filings as Array<Record<string, unknown>>;
    const failed = filings.find((f) => f.fingerprint === "fp-2");
    expect(failed?.status).toBe("unfiled");
    expect(failed?.reason).toBe("Linear 500: timeout");
  });

  it("marks all-unfiled metadata with the track_findings_unfiled reason", () => {
    const metadata = buildTrackFindingFilingMetadata({
      required: 1,
      reviewedHeadSha: null,
      filed: [],
      unfiled: [
        { fingerprint: "fp-1", reason: "tracker is not Linear-backed" },
      ],
    });
    expect(metadata.track_filing_status).toBe("unfiled");
    expect(metadata.track_filing_reason).toBe("track_findings_unfiled");
    expect(metadata.track_filing_filed_count).toBe(0);
  });

  it("ignores entries for other issues and non-filing kinds", () => {
    const journal: DispatcherRunJournalEntry[] = [
      filingEntry("issue-2", {
        filings: [
          {
            fingerprint: "fp-x",
            issue_id: "IDX",
            identifier: "X",
            url: null,
            status: "filed",
          },
        ],
      }),
      { ...baseEntry("issue-1"), kind: "review_gate_result", metadata: {} },
    ];
    expect(reduceTrackFindingFilings(journal, "issue-1").size).toBe(0);
  });
});

describe("reconcileFilingResult", () => {
  const toFile = [
    {
      fingerprint: "fp-1",
      title: "A",
      category: null,
      rationale: null,
      evidence: [],
    },
    {
      fingerprint: "fp-2",
      title: "B",
      category: null,
      rationale: null,
      evidence: [],
    },
  ];

  it("synthesizes an unfiled entry for a requested fingerprint the filer omitted", () => {
    const { filed, unfiled } = reconcileFilingResult(toFile, {
      filed: [
        { fingerprint: "fp-1", issueId: "ID-1", identifier: "S-1", url: "u" },
      ],
      unfiled: [],
    });
    expect(filed).toEqual([
      { fingerprint: "fp-1", issueId: "ID-1", identifier: "S-1", url: "u" },
    ]);
    expect(unfiled).toEqual([
      { fingerprint: "fp-2", reason: expect.any(String) },
    ]);
  });

  it("drops a filed ref with an empty or non-string issueId and marks it unfiled", () => {
    const { filed, unfiled } = reconcileFilingResult(toFile, {
      filed: [
        { fingerprint: "fp-1", issueId: "", identifier: "S-1", url: "u" },
        { fingerprint: "fp-2", issueId: "ID-2", identifier: null, url: null },
      ],
      unfiled: [],
    });
    expect(filed).toEqual([
      { fingerprint: "fp-2", issueId: "ID-2", identifier: null, url: null },
    ]);
    expect(unfiled.map((u) => u.fingerprint)).toEqual(["fp-1"]);
  });

  it("drops refs for fingerprints that were not requested", () => {
    const { filed, unfiled } = reconcileFilingResult(toFile, {
      filed: [
        { fingerprint: "fp-1", issueId: "ID-1", identifier: null, url: null },
        {
          fingerprint: "fp-unknown",
          issueId: "ID-X",
          identifier: null,
          url: null,
        },
      ],
      unfiled: [],
    });
    expect(filed.map((f) => f.fingerprint)).toEqual(["fp-1"]);
    expect(unfiled.map((u) => u.fingerprint)).toEqual(["fp-2"]);
  });

  it("preserves the filer's exact unfiled reason and defaults the rest", () => {
    const { filed, unfiled } = reconcileFilingResult(toFile, {
      filed: [],
      unfiled: [{ fingerprint: "fp-1", reason: "Linear 500" }],
    });
    expect(filed).toEqual([]);
    expect(unfiled).toContainEqual({
      fingerprint: "fp-1",
      reason: "Linear 500",
    });
    expect(unfiled.find((u) => u.fingerprint === "fp-2")?.reason).toBeTruthy();
  });

  it("ignores duplicate filed refs for the same fingerprint", () => {
    const single = toFile[0];
    if (single === undefined) throw new Error("fixture");
    const { filed } = reconcileFilingResult([single], {
      filed: [
        { fingerprint: "fp-1", issueId: "ID-1", identifier: null, url: null },
        { fingerprint: "fp-1", issueId: "ID-DUP", identifier: null, url: null },
      ],
      unfiled: [],
    });
    expect(filed).toEqual([
      { fingerprint: "fp-1", issueId: "ID-1", identifier: null, url: null },
    ]);
  });

  it("tolerates a malformed filer result by marking every requested finding unfiled", () => {
    const { filed, unfiled } = reconcileFilingResult(toFile, {
      filed: null,
      unfiled: undefined,
    } as unknown as TrackFindingFilingResult);
    expect(filed).toEqual([]);
    expect(unfiled.map((u) => u.fingerprint).sort()).toEqual(["fp-1", "fp-2"]);
  });
});
