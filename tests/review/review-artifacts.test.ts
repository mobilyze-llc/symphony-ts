import { describe, expect, it } from "vitest";

import {
  artifactSectionContent,
  artifactSectionHasContent,
  buildArtifactSectionHeadingKeys,
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
