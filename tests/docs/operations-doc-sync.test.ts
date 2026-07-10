import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import {
  AUTOGEN,
  CAPABILITY_RETEST_AUTOGEN,
  helpBlock,
  replaceAutogenRegion,
} from "../../scripts/docs-sync.mjs";
import { renderUsage as renderCapabilityRetestUsage } from "../../src/cli/capability-retest.js";
import { renderUsage } from "../../src/cli/manager-plan.js";

const DOC_PATH = fileURLToPath(
  new URL("../../docs/operations/02-symphony-manager-plan.md", import.meta.url),
);
const CAPABILITY_RETEST_DOC_PATH = fileURLToPath(
  new URL(
    "../../docs/operations/07-symphony-capability-retest.md",
    import.meta.url,
  ),
);

describe("docs-sync helpers", () => {
  it("replaceAutogenRegion swaps the body between markers, preserving the markers", () => {
    const content = `pre\n${AUTOGEN.start}\nOLD BODY\n${AUTOGEN.end}\npost`;
    expect(
      replaceAutogenRegion(content, AUTOGEN.start, AUTOGEN.end, "NEW BODY"),
    ).toBe(`pre\n${AUTOGEN.start}\nNEW BODY\n${AUTOGEN.end}\npost`);
  });

  it("replaceAutogenRegion throws when a marker is missing", () => {
    expect(() =>
      replaceAutogenRegion("no markers here", AUTOGEN.start, AUTOGEN.end, "x"),
    ).toThrow(/marker/i);
  });

  it("helpBlock wraps text in a fenced code block and trims trailing whitespace", () => {
    expect(helpBlock("line one\nline two\n\n")).toBe(
      "```text\nline one\nline two\n```",
    );
  });
});

describe("02-symphony-manager-plan.md usage block (SYMPH-870 build-time gate)", () => {
  it("is in sync with renderUsage() — if this fails run `pnpm build && pnpm docs:sync`", () => {
    const doc = readFileSync(DOC_PATH, "utf8");
    const expected = replaceAutogenRegion(
      doc,
      AUTOGEN.start,
      AUTOGEN.end,
      helpBlock(renderUsage()),
    );
    expect(doc).toBe(expected);
  });
});

describe("07-symphony-capability-retest.md usage block", () => {
  it("is in sync with renderUsage()", () => {
    const doc = readFileSync(CAPABILITY_RETEST_DOC_PATH, "utf8");
    const expected = replaceAutogenRegion(
      doc,
      CAPABILITY_RETEST_AUTOGEN.start,
      AUTOGEN.end,
      helpBlock(renderCapabilityRetestUsage()),
    );
    expect(doc).toBe(expected);
  });
});
