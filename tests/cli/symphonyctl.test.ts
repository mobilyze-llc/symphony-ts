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

  it("parses anchor with placement and until-merged expiry", () => {
    const parsed = parseSymphonyctlArgs(
      [
        "anchor",
        "SYMPH-42",
        "--above",
        "SYMPH-41",
        "--until-merged",
        "--reason",
        "operator veto",
      ],
      {},
    );
    expect(parsed).toEqual({
      command: "anchor",
      baseUrl: DEFAULT_BASE_URL,
      issue: "SYMPH-42",
      anchorPlacement: { kind: "above", issueIdentifier: "SYMPH-41" },
      anchorExpiry: { kind: "until_merged" },
      reason: "operator veto",
    });
  });

  it("parses boolean anchor flags without consuming following positional tokens", () => {
    const parsed = parseSymphonyctlArgs(
      ["anchor", "--top", "SYMPH-42", "--until-merged"],
      {},
    );
    expect(parsed).toEqual({
      command: "anchor",
      baseUrl: DEFAULT_BASE_URL,
      issue: "SYMPH-42",
      anchorPlacement: { kind: "top" },
      anchorExpiry: { kind: "until_merged" },
    });
  });

  it("parses anchor until timestamps only when they include an explicit timezone", () => {
    const parsed = parseSymphonyctlArgs(
      ["anchor", "SYMPH-42", "--top", "--until", "2026-06-11T07:30:00-04:00"],
      {},
    );
    expect(parsed.anchorExpiry).toEqual({
      kind: "until_date",
      at: "2026-06-11T11:30:00.000Z",
    });
  });

  it("rejects date-only, local-time, free-form, and invalid-calendar anchor until values", () => {
    for (const until of [
      "2026-06-11",
      "2026-06-11T11:30:00",
      "June 11 2026 11:30 UTC",
      "2026-02-30T11:30:00.000Z",
    ]) {
      expect(() =>
        parseSymphonyctlArgs(
          ["anchor", "SYMPH-42", "--top", "--until", until],
          {},
        ),
      ).toThrow(SymphonyctlUsageError);
    }
  });

  it("parses unanchor", () => {
    expect(parseSymphonyctlArgs(["unanchor", "SYMPH-42"], {})).toEqual({
      command: "unanchor",
      baseUrl: DEFAULT_BASE_URL,
      issue: "SYMPH-42",
    });
  });

  it("rejects ambiguous anchor placement or expiry", () => {
    expect(() =>
      parseSymphonyctlArgs(
        ["anchor", "SYMPH-1", "--top", "--above", "SYMPH-0", "--until-merged"],
        {},
      ),
    ).toThrow(SymphonyctlUsageError);
    expect(() =>
      parseSymphonyctlArgs(["anchor", "SYMPH-1", "--top"], {}),
    ).toThrow(SymphonyctlUsageError);
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

  it("rejects a non-positive-integer --fence value", () => {
    for (const fence of ["abc", "3.5", "-1", "3abc", "1e3", "", "0", "01"]) {
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

  it("parses hard emergency stop with a reason", () => {
    expect(
      parseSymphonyctlArgs(["stop", "--hard", "--reason", "runaway spend"], {}),
    ).toEqual({
      command: "stop",
      baseUrl: DEFAULT_BASE_URL,
      hard: true,
      reason: "runaway spend",
    });
  });

  it("rejects stop without --hard", () => {
    expect(() => parseSymphonyctlArgs(["stop"], {})).toThrow(
      SymphonyctlUsageError,
    );
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
      anchors: [
        {
          issue_identifier: "SYMPH-8",
          placement: { kind: "below", issue_identifier: "SYMPH-7" },
          expiry: { kind: "until_merged" },
          provenance: {
            actor: { kind: "operator", host: "pro14", session: "symphonyctl" },
            source: "linear_field_edit",
            field_name: "Queue Anchor",
            editor_email: "operator@mobilyze.com",
            reason: { human: "field edit" },
          },
        },
      ],
    });
    expect(summary).toContain("running=1");
    expect(summary).toContain("SYMPH-7 working");
    expect(summary).toContain("9 intent:park:operator_pause");
    expect(summary).toContain("SYMPH-8 below SYMPH-7 until merged");
    expect(summary).toContain(
      "operator@pro14#symphonyctl · linear_field_edit · operator@mobilyze.com · Queue Anchor · field edit",
    );
  });

  it("reports an idle runtime", () => {
    expect(formatStateSummary({})).toBe("(no runtime activity)");
  });
});
