import { describe, expect, it } from "vitest";

import { extractAcceptanceCriteria } from "../../src/agent/ac-gate.js";

describe("extractAcceptanceCriteria", () => {
  it("extracts the heading plus body up to the next same-level heading", () => {
    const message = [
      "Investigation workpad posted.",
      "### Acceptance Criteria",
      "- [ ] `test: tests/foo.test.ts covers bar`",
      "- [ ] `check: npx tsc --noEmit exits 0`",
      "### Validation",
      "- npx vitest run tests/foo.test.ts",
    ].join("\n");

    expect(extractAcceptanceCriteria(message)).toBe(
      [
        "### Acceptance Criteria",
        "- [ ] `test: tests/foo.test.ts covers bar`",
        "- [ ] `check: npx tsc --noEmit exits 0`",
      ].join("\n"),
    );
  });

  it("stops at a higher-level heading and keeps deeper subheadings", () => {
    const message = [
      "## Acceptance Criteria",
      "- [ ] `judge: pause reasons report billable tokens`",
      "#### Notes on evidence",
      "- visible in the hard-stop comment",
      "# Next Section",
      "ignored",
    ].join("\n");

    expect(extractAcceptanceCriteria(message)).toBe(
      [
        "## Acceptance Criteria",
        "- [ ] `judge: pause reasons report billable tokens`",
        "#### Notes on evidence",
        "- visible in the hard-stop comment",
      ].join("\n"),
    );
  });

  it("matches case-insensitively and tolerates heading suffixes", () => {
    const message = [
      "### acceptance criteria (final)",
      "- [ ] `check: pnpm lint exits 0`",
    ].join("\n");

    expect(extractAcceptanceCriteria(message)).toBe(
      [
        "### acceptance criteria (final)",
        "- [ ] `check: pnpm lint exits 0`",
      ].join("\n"),
    );
  });

  it("runs to end of message when no later heading exists", () => {
    const message = [
      "### Acceptance Criteria",
      "- [ ] `check: pnpm build exits 0`",
      "",
      "[STAGE_COMPLETE]",
    ].join("\n");

    expect(extractAcceptanceCriteria(message)).toBe(
      [
        "### Acceptance Criteria",
        "- [ ] `check: pnpm build exits 0`",
        "",
        "[STAGE_COMPLETE]",
      ].join("\n"),
    );
  });

  it("returns null for null messages, missing headings, and empty bodies", () => {
    expect(extractAcceptanceCriteria(null)).toBeNull();
    expect(extractAcceptanceCriteria("No criteria here.")).toBeNull();
    expect(
      extractAcceptanceCriteria(
        "### Acceptance Criteria\n\n### Validation\n- x",
      ),
    ).toBeNull();
    expect(
      extractAcceptanceCriteria("### Acceptance Criteria\n   \n"),
    ).toBeNull();
  });

  it("bounds the snapshot at 8000 characters", () => {
    const body = `- [ ] \`check: ${"x".repeat(9000)}\``;
    const snapshot = extractAcceptanceCriteria(
      `### Acceptance Criteria\n${body}`,
    );

    expect(snapshot).not.toBeNull();
    expect(snapshot?.length).toBe(8000);
    expect(snapshot?.startsWith("### Acceptance Criteria")).toBe(true);
  });
});
