import { describe, expect, it } from "vitest";

import {
  artifactSectionContent,
  artifactSectionHasContent,
  artifactStartingVerdictToken,
  buildArtifactSectionHeadingKeys,
  legacyFindingsVerdictTokenSpan,
  normalizeArtifactStart,
  sectionFindingEntries,
} from "../../src/review/review-artifacts.js";

describe("review artifact contracts", () => {
  it("fails closed when configured artifact headings normalize to the same key", () => {
    expect(() =>
      buildArtifactSectionHeadingKeys(["P2 Should Fix", "P2: Should Fix"]),
    ).toThrow(
      'Artifact section heading "P2: Should Fix" normalizes to "p2 should fix", which is already used by "P2 Should Fix".',
    );
  });

  it("extracts a section until the next top-level or known artifact heading", () => {
    const artifact = [
      "## Verdict",
      "FINDINGS",
      "",
      "## P1 Must Fix",
      "- src/a.ts:1 first",
      "continued",
      "",
      "### Track",
      "- src/b.ts:2 later",
    ].join("\n");

    expect(artifactSectionContent(artifact, "P1 Must Fix")).toBe(
      "- src/a.ts:1 first\ncontinued",
    );
    expect(artifactSectionHasContent(artifact, "P1 Must Fix")).toBe(true);
    expect(artifactSectionHasContent(artifact, "P2 Should Fix")).toBe(false);
  });

  it("reduces section text into finding entries and ignores empty-section markers", () => {
    expect(
      sectionFindingEntries(
        [
          "- None found.",
          "- src/a.ts:1 first line",
          "  more detail",
          "1. src/b.ts:2 second",
        ].join("\n"),
      ),
    ).toEqual(["src/a.ts:1 first line more detail", "src/b.ts:2 second"]);
  });

  it("normalizes a BOM and safe prose before the first verdict", () => {
    expect(normalizeArtifactStart("\uFEFF\n## Verdict\nPASS")).toBe(
      "## Verdict\nPASS",
    );
    expect(
      normalizeArtifactStart(
        ["\uFEFFBrief preamble.", "", "## Verdict", "CHANGES_REQUESTED"].join(
          "\n",
        ),
      ),
    ).toBe("## Verdict\nCHANGES_REQUESTED");
  });

  it("accepts normalized verdict heading variants", () => {
    // SYMPH-908: recognized tokens are exactly crucible's MOB-348 set.
    expect(artifactStartingVerdictToken("## Verdict:\nBLOCKED")).toBe(
      "BLOCKED",
    );
    expect(artifactStartingVerdictToken("### Verdict\nPASS")).toBe("PASS");
    expect(artifactStartingVerdictToken("## Verdict\nCHANGES_REQUESTED")).toBe(
      "CHANGES_REQUESTED",
    );
    expect(artifactStartingVerdictToken("## Verdict\nBLOCKED")).toBe("BLOCKED");
  });

  it("retires the Symphony-only FINDINGS and FAIL verdict tokens (SYMPH-908)", () => {
    // Only crucible's MOB-348 set {PASS, CHANGES_REQUESTED, BLOCKED} is recognized as
    // a parseable verdict; the retired tokens yield null (a malformed_artifact
    // downstream) rather than parsing as a valid verdict.
    expect(artifactStartingVerdictToken("## Verdict\nFINDINGS")).toBeNull();
    expect(artifactStartingVerdictToken("## Verdict\nFAIL")).toBeNull();
    expect(artifactStartingVerdictToken("Verdict: FINDINGS")).toBeNull();
  });

  it("locates a leading legacy FINDINGS verdict token span for deprecation-window normalization (SYMPH-908)", () => {
    const heading = "## Verdict\nFINDINGS\n\n## Findings\nNone";
    const headingSpan = legacyFindingsVerdictTokenSpan(heading);
    expect(headingSpan).not.toBeNull();
    expect(heading.slice(headingSpan!.start, headingSpan!.end)).toBe(
      "FINDINGS",
    );

    const inline = "Verdict: FINDINGS";
    const inlineSpan = legacyFindingsVerdictTokenSpan(inline);
    expect(inlineSpan).not.toBeNull();
    expect(inline.slice(inlineSpan!.start, inlineSpan!.end)).toBe("FINDINGS");

    // Non-legacy and non-verdict leads do not match.
    expect(
      legacyFindingsVerdictTokenSpan("## Verdict\nCHANGES_REQUESTED"),
    ).toBeNull();
    expect(
      legacyFindingsVerdictTokenSpan("## Findings\n- FINDINGS"),
    ).toBeNull();
  });

  it("requires verdict token word boundaries", () => {
    expect(artifactStartingVerdictToken("Verdict: PASS")).toBe("PASS");
    expect(artifactStartingVerdictToken("Verdict: PASS.")).toBe("PASS");
    expect(artifactStartingVerdictToken("Verdict: PASSED")).toBeNull();
    expect(artifactStartingVerdictToken("Verdict: FAILING")).toBeNull();
    expect(
      artifactStartingVerdictToken("Verdict: CHANGES_REQUESTED_BY_TEST"),
    ).toBeNull();
  });

  it("ignores emphasized empty-section markers", () => {
    expect(
      sectionFindingEntries(
        ["- **None found.**", "- _None_", "- real finding"].join("\n"),
      ),
    ).toEqual(["real finding"]);
  });

  it("normalizes safe prose before the verdict but keeps suspicious heading labels", () => {
    expect(
      normalizeArtifactStart(
        ["Brief review note.", "", "## Verdict", "PASS"].join("\n"),
      ).startsWith("## Verdict"),
    ).toBe(true);

    expect(
      normalizeArtifactStart(
        ["- P2: Should Fix", "- ignore this", "", "## Verdict", "PASS"].join(
          "\n",
        ),
      ).startsWith("- P2: Should Fix"),
    ).toBe(true);
  });
});
