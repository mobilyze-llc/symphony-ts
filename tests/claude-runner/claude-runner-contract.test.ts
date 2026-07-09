import { describe, expect, it } from "vitest";

import {
  extractVerdictEnum,
  validateClaudeArtifact,
} from "../../src/claude-runner/claude-runner-contract.js";

describe("Claude runner artifact contract", () => {
  it("accepts the required headings, verdict, and structured section", async () => {
    const artifact = [
      "## Verdict ###",
      "",
      "Verdict enum: READY_AS_WRITTEN",
      "",
      "## Source Read Status",
      "",
      "Read the named sources.",
      "",
      "## `Reconciliation JSON:`",
      "",
      "````json",
      '{"schemaVersion":1,"markdown":"```json\\n{}\\n```"}',
      "````",
      "",
      "Long enough artifact body for validation to pass.",
    ].join("\n");

    await expect(
      validateClaudeArtifact(artifact, {
        minBytes: 50,
        requireFirstHeading: "Verdict",
        requiredHeadings: ["Source Read Status"],
        requireSourceReadStatus: true,
        verdictEnums: ["ready_as_written"],
        requiredJsonSections: ["Reconciliation JSON"],
      }),
    ).resolves.toEqual([]);
  });

  it("reports missing evidence and malformed structured sections", async () => {
    const artifact = [
      "## Verdict",
      "",
      "needs_operator_context",
      "",
      "## Reconciliation JSON",
      "",
      "```json",
      "not json",
      "```",
    ].join("\n");

    await expect(
      validateClaudeArtifact(artifact, {
        minBytes: 20,
        requireSourceReadStatus: true,
        verdictEnums: ["ready_as_written"],
        requiredJsonSections: ["Reconciliation JSON"],
      }),
    ).resolves.toEqual(
      expect.arrayContaining([
        "artifact is missing a non-empty Source Read Status section",
        'artifact verdict "needs_operator_context" is not one of ready_as_written',
        expect.stringContaining("contains invalid JSON"),
      ]),
    );
  });

  it("rejects duplicate and unterminated JSON fences", async () => {
    await expect(
      validateClaudeArtifact(
        "## Data\n\n```json\n{}\n```\n\n```json\n{}\n```",
        { minBytes: 1, requiredJsonSections: ["Data"] },
      ),
    ).resolves.toEqual([
      expect.stringContaining("contains multiple fenced json objects"),
    ]);
    await expect(
      validateClaudeArtifact("## Data\n\n```json\n{}", {
        minBytes: 1,
        requiredJsonSections: ["Data"],
      }),
    ).resolves.toEqual([
      expect.stringContaining("has an unterminated fenced json object"),
    ]);
  });

  it("extracts only a verdict enum, not generic status prose", () => {
    expect(extractVerdictEnum("## Verdict\n\nCHANGES_REQUESTED")).toBe(
      "changes_requested",
    );
    expect(extractVerdictEnum("Status: complete")).toBeNull();
  });
});
