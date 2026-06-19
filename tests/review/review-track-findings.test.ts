import { describe, expect, it, vi } from "vitest";

import {
  collectTrackFindings,
  computeTrackFiling,
  resolveTrackFindingFilings,
} from "../../src/review/review-track-findings.js";

interface TestFinding {
  fingerprint: string;
  severity: "P1" | "P2" | "Track" | "Dismissed";
  title: string;
  leadDisposition: "open" | "track" | "dismissed" | "refuted";
}

function finding(overrides: Partial<TestFinding> = {}): TestFinding {
  return {
    fingerprint: overrides.fingerprint ?? "fp-1",
    severity: overrides.severity ?? "Track",
    title: overrides.title ?? "Track me",
    leadDisposition: overrides.leadDisposition ?? "track",
  };
}

function lane(input: {
  laneId: string;
  findings: readonly TestFinding[];
  mergeAuthoritative?: boolean;
}) {
  return {
    laneId: input.laneId,
    mergeAuthoritative: input.mergeAuthoritative ?? true,
    structuredArtifact: { findings: input.findings },
  };
}

describe("review Track-finding contracts", () => {
  it("derives surviving Track findings from merge-authoritative artifacts only", () => {
    expect(
      collectTrackFindings({
        verdict: "pass",
        lanes: [
          lane({
            laneId: "pi-deepseek",
            findings: [
              finding({ fingerprint: "track-severity", severity: "Track" }),
              finding({
                fingerprint: "track-disposition",
                severity: "P2",
                leadDisposition: "track",
              }),
              finding({
                fingerprint: "open-blocker",
                severity: "P2",
                leadDisposition: "open",
              }),
            ],
          }),
          lane({
            laneId: "shadow",
            mergeAuthoritative: false,
            findings: [finding({ fingerprint: "ignored-shadow" })],
          }),
        ],
      }).map((item) => item.fingerprint),
    ).toEqual(["track-severity", "track-disposition"]);
  });

  it("records none, filed, and partially filed states from durable refs", () => {
    expect(computeTrackFiling([], new Map())).toMatchObject({
      status: "none",
      required: 0,
      filed: 0,
      reason: null,
    });

    const trackFindings = [
      finding({ fingerprint: "fp-1", title: "one" }),
      finding({ fingerprint: "fp-2", title: "two" }),
    ];
    expect(
      computeTrackFiling(
        trackFindings,
        new Map([["fp-1", { issueId: "SYMPH-1", url: null }]]),
      ),
    ).toMatchObject({
      status: "unfiled",
      required: 2,
      filed: 1,
      reason: "track_findings_partially_filed",
      findings: [
        { fingerprint: "fp-1", issueId: "SYMPH-1" },
        { fingerprint: "fp-2", issueId: null },
      ],
    });

    expect(
      computeTrackFiling(
        trackFindings,
        new Map([
          ["fp-1", { issueId: "SYMPH-1", url: null }],
          ["fp-2", { issueId: "SYMPH-2", url: "https://linear.test/2" }],
        ]),
      ),
    ).toMatchObject({ status: "filed", required: 2, filed: 2, reason: null });
  });

  it("treats malformed filer refs as unresolved without throwing", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const resolved = await resolveTrackFindingFilings(
      [finding({ fingerprint: "fp-1" })],
      async () =>
        [
          { fingerprint: "fp-1", issueId: "", url: null },
          { fingerprint: "fp-1", issueId: "SYMPH-1", url: null },
        ] as Array<{
          fingerprint: string;
          issueId: string;
          url: string | null;
        }>,
    );

    expect(resolved.get("fp-1")).toEqual({ issueId: "SYMPH-1", url: null });
    expect(warn).toHaveBeenCalledWith(
      "[council] track-finding filer returned an invalid ref; finding remains unfiled",
    );
    warn.mockRestore();
  });
});
