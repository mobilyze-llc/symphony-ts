/**
 * symphonyctl is a deliberately disposable thin client (SYMPH-408b): these
 * tests cover only the argument-parsing and formatting seams — the verb
 * semantics live behind the endpoints and are tested there.
 */
import { describe, expect, it } from "vitest";

import {
  DEFAULT_BASE_URL,
  SymphonyctlUsageError,
  formatStateSummary,
  parseSymphonyctlArgs,
} from "../../src/cli/symphonyctl.js";

describe("parseSymphonyctlArgs", () => {
  it("parses state with the default base URL", () => {
    expect(parseSymphonyctlArgs(["state"], {})).toEqual({
      command: "state",
      baseUrl: DEFAULT_BASE_URL,
    });
  });

  it("honors --base-url over the environment default", () => {
    const parsed = parseSymphonyctlArgs(
      ["state", "--base-url", "http://10.0.0.5:4327/"],
      { SYMPHONYCTL_BASE_URL: "http://ignored:1" },
    );
    expect(parsed.baseUrl).toBe("http://10.0.0.5:4327");
  });

  it("falls back to SYMPHONYCTL_BASE_URL", () => {
    const parsed = parseSymphonyctlArgs(["state"], {
      SYMPHONYCTL_BASE_URL: "http://pro14:4321",
    });
    expect(parsed.baseUrl).toBe("http://pro14:4321");
  });

  it("parses a full intent command", () => {
    const parsed = parseSymphonyctlArgs(
      [
        "intent",
        "rework_with_hint",
        "--issue",
        "SYMPH-42",
        "--reason",
        "wrong lockfile",
        "--hint",
        "regenerate pnpm-lock",
        "--fence",
        "3",
        "--stage",
        "review",
      ],
      {},
    );
    expect(parsed).toEqual({
      command: "intent",
      baseUrl: DEFAULT_BASE_URL,
      verb: "rework_with_hint",
      issue: "SYMPH-42",
      reason: "wrong lockfile",
      hint: "regenerate pnpm-lock",
      fence: 3,
      stage: "review",
    });
  });

  it("rejects an unknown intent verb", () => {
    expect(() =>
      parseSymphonyctlArgs(
        ["intent", "obliterate", "--issue", "SYMPH-1", "--reason", "x"],
        {},
      ),
    ).toThrow(SymphonyctlUsageError);
  });

  it("rejects intent without --issue or --reason", () => {
    expect(() =>
      parseSymphonyctlArgs(["intent", "park", "--issue", "SYMPH-1"], {}),
    ).toThrow(SymphonyctlUsageError);
  });

  it("rejects an unknown command", () => {
    expect(() => parseSymphonyctlArgs(["explode"], {})).toThrow(
      SymphonyctlUsageError,
    );
  });

  it("rejects a non-digit --fence value", () => {
    for (const fence of ["abc", "3.5", "-1", "3abc", "1e3", ""]) {
      expect(() =>
        parseSymphonyctlArgs(
          [
            "intent",
            "release",
            "--issue",
            "SYMPH-1",
            "--reason",
            "x",
            "--fence",
            fence,
          ],
          {},
        ),
      ).toThrow(SymphonyctlUsageError);
    }
  });

  it("parses pause with a reason", () => {
    expect(
      parseSymphonyctlArgs(["pause", "--reason", "deploy window"], {}),
    ).toEqual({
      command: "pause",
      baseUrl: DEFAULT_BASE_URL,
      reason: "deploy window",
    });
  });
});

describe("formatStateSummary", () => {
  it("summarizes counts, running lanes, and parked issues", () => {
    const summary = formatStateSummary({
      counts: { running: 1, retrying: 0, completed: 3, failed: 1 },
      running: [{ issue_identifier: "SYMPH-7", state: "working" }],
      explicit_resume_required: {
        "9": { reason: "intent:park:operator_pause" },
      },
    });
    expect(summary).toContain("running=1");
    expect(summary).toContain("SYMPH-7 working");
    expect(summary).toContain("9 intent:park:operator_pause");
  });

  it("reports an idle runtime", () => {
    expect(formatStateSummary({})).toBe("(no runtime activity)");
  });
});
