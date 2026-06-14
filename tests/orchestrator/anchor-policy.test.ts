import { describe, expect, it } from "vitest";

import type { IssueAnchorRecord } from "../../src/domain/model.js";
import {
  formatInvalidAnchorPlacementDetail,
  isIssueAnchorExpired,
  validateAnchorPlacementForIssue,
} from "../../src/orchestrator/anchor-policy.js";

const NOW = new Date("2026-06-13T12:00:00.000Z");

describe("anchor policy", () => {
  it("expires until-merged anchors from terminal completion evidence", () => {
    const anchor = createAnchor({ expiry: { kind: "until_merged" } });

    expect(
      isIssueAnchorExpired(anchor, {
        completedIssueIds: new Set(),
        now: NOW,
      }),
    ).toBe(false);
    expect(
      isIssueAnchorExpired(anchor, {
        completedIssueIds: new Set(["1"]),
        now: NOW,
      }),
    ).toBe(true);
  });

  it("expires until-date anchors at the evaluation clock and fails closed for malformed dates", () => {
    expect(
      isIssueAnchorExpired(
        createAnchor({
          expiry: { kind: "until_date", at: "2026-06-13T12:00:01.000Z" },
        }),
        { completedIssueIds: new Set(), now: NOW },
      ),
    ).toBe(false);
    expect(
      isIssueAnchorExpired(
        createAnchor({
          expiry: { kind: "until_date", at: "2026-06-13T12:00:00.000Z" },
        }),
        { completedIssueIds: new Set(), now: NOW },
      ),
    ).toBe(true);
    expect(
      isIssueAnchorExpired(
        createAnchor({ expiry: { kind: "until_date", at: "not-a-date" } }),
        { completedIssueIds: new Set(), now: NOW },
      ),
    ).toBe(true);
  });

  it("rejects self and pipeline-sentinel relative placements", () => {
    const self = validateAnchorPlacementForIssue(
      { kind: "above", issueIdentifier: "issue-1" },
      "ISSUE-1",
    );
    expect(self).toMatchObject({ valid: false, reason: "self_reference" });
    if (!self.valid) {
      expect(
        formatInvalidAnchorPlacementDetail(
          self.placement,
          "ISSUE-1",
          self.reason,
        ),
      ).toContain("references ISSUE-1 itself");
    }

    expect(
      validateAnchorPlacementForIssue(
        { kind: "below", issueIdentifier: "PIPELINE" },
        "ISSUE-1",
      ),
    ).toMatchObject({
      valid: false,
      reason: "pipeline_sentinel_reference",
    });
  });
});

function createAnchor(
  overrides: Partial<IssueAnchorRecord> = {},
): IssueAnchorRecord {
  return {
    issueId: "1",
    issueIdentifier: "ISSUE-1",
    placement: { kind: "top" },
    expiry: { kind: "until_merged" },
    actor: { kind: "operator", host: "local", session: null },
    reason: { class: "operator_anchor", human: "pin" },
    source: "api",
    fieldName: null,
    editorEmail: null,
    setAt: "2026-06-13T12:00:00.000Z",
    setBySequence: 1,
    ...overrides,
  };
}
