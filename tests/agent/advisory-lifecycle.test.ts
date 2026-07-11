import { describe, expect, it } from "vitest";

import {
  applyAdvisoryLifecycle,
  structuralAdvisoryFingerprint,
  structuralAdvisoryMemberSetHash,
} from "../../src/agent/advisory-lifecycle.js";
import type { StructuralAdvisory } from "../../src/domain/structural-advisory.js";

const base: StructuralAdvisory = {
  memberIssueIdentifiers: ["SYMPH-2", "SYMPH-1"],
  rootCauseHypothesis: "Shared config parser!",
  structuralFix: "Centralize parsing",
  confidenceNote: "medium",
};

const config = { dormantOkTicks: 3, renderCap: 3 };
const presented = new Set(["SYMPH-1", "SYMPH-2", "SYMPH-3", "SYMPH-4"]);

describe("structural advisory lifecycle", () => {
  it("keys lifecycle on sorted members while wording changes only the fingerprint", () => {
    const hash = structuralAdvisoryMemberSetHash(["SYMPH-2", "SYMPH-1"]);
    expect(hash).toBe(structuralAdvisoryMemberSetHash(["SYMPH-1", "SYMPH-2"]));
    expect(structuralAdvisoryFingerprint(hash, "Shared config parser!")).toBe(
      structuralAdvisoryFingerprint(hash, "shared config parser"),
    );
    expect(structuralAdvisoryFingerprint(hash, "A different root")).not.toBe(
      structuralAdvisoryFingerprint(hash, "shared config parser"),
    );
    expect(structuralAdvisoryMemberSetHash(["SYMPH-1", "SYMPH-3"])).not.toBe(
      hash,
    );
  });

  it("drops a whole advisory when any member was not presented", async () => {
    const result = await applyAdvisoryLifecycle({
      emitted: [{ ...base, memberIssueIdentifiers: ["SYMPH-1", "SYMPH-999"] }],
      previous: [],
      presentedIssueIdentifiers: presented,
      config,
    });
    expect(result.advisories).toEqual([]);
    expect(result.events).toContainEqual({
      kind: "invalid_members",
      memberCount: 2,
      invalidMemberCount: 1,
    });
  });

  it("computes all emissions before the render cap", async () => {
    const emitted = ["SYMPH-1", "SYMPH-2", "SYMPH-3", "SYMPH-4"].map(
      (identifier) => ({
        ...base,
        memberIssueIdentifiers: [identifier],
        rootCauseHypothesis: `root ${identifier}`,
      }),
    );
    const first = await applyAdvisoryLifecycle({
      emitted,
      previous: [],
      presentedIssueIdentifiers: presented,
      config: { ...config, renderCap: 3 },
    });
    expect(first.advisories).toHaveLength(4);
    expect(
      first.advisories.filter((advisory) => advisory.rendered),
    ).toHaveLength(3);
    expect(first.advisories[3]).toMatchObject({
      lifecycleState: "active",
      absentOkTicks: 0,
      rendered: false,
    });
    expect(first.events).toContainEqual({
      kind: "truncated",
      emittedCount: 4,
      renderedCount: 3,
    });
  });

  it("enforces the render cap across competing hypotheses for one member set", async () => {
    const result = await applyAdvisoryLifecycle({
      emitted: [
        base,
        { ...base, rootCauseHypothesis: "competing root hypothesis" },
      ],
      previous: [],
      presentedIssueIdentifiers: presented,
      config: { ...config, renderCap: 1 },
    });
    expect(result.advisories).toHaveLength(2);
    expect(
      result.advisories.filter((advisory) => advisory.rendered),
    ).toHaveLength(1);
  });

  it("does not journal an unchanged re-emission twice", async () => {
    const first = await applyAdvisoryLifecycle({
      emitted: [base],
      previous: [],
      presentedIssueIdentifiers: presented,
      config,
    });
    const second = await applyAdvisoryLifecycle({
      emitted: [base],
      previous: first.advisories,
      presentedIssueIdentifiers: presented,
      config,
    });
    expect(second.events.some((event) => event.kind === "emitted")).toBe(false);
  });

  it("advances dormancy only for successful lifecycle evaluations", async () => {
    const first = await applyAdvisoryLifecycle({
      emitted: [base],
      previous: [],
      presentedIssueIdentifiers: presented,
      config,
    });
    const skippedSnapshot = first.advisories;
    expect(skippedSnapshot[0]?.absentOkTicks).toBe(0);
    const absentOnce = await applyAdvisoryLifecycle({
      emitted: [],
      previous: skippedSnapshot,
      presentedIssueIdentifiers: presented,
      config,
    });
    expect(absentOnce.advisories[0]).toMatchObject({
      lifecycleState: "dormant",
      absentOkTicks: 1,
    });
    const absentTwice = await applyAdvisoryLifecycle({
      emitted: [],
      previous: absentOnce.advisories,
      presentedIssueIdentifiers: presented,
      config,
    });
    const withdrawn = await applyAdvisoryLifecycle({
      emitted: [],
      previous: absentTwice.advisories,
      presentedIssueIdentifiers: presented,
      config,
    });
    expect(withdrawn.advisories[0]).toMatchObject({
      lifecycleState: "withdrawn",
      absentOkTicks: 3,
    });
  });

  it("preserves active state when the advisory-input scan is incomplete", async () => {
    const first = await applyAdvisoryLifecycle({
      emitted: [base],
      previous: [],
      presentedIssueIdentifiers: presented,
      config,
    });
    const failedScan = await applyAdvisoryLifecycle({
      emitted: [],
      previous: first.advisories,
      presentedIssueIdentifiers: new Set(["SYMPH-1"]),
      config,
      scanComplete: false,
    });
    expect(failedScan.advisories).toEqual(first.advisories);
    expect(failedScan.events).toEqual([]);
  });

  it("auto-withdraws a majority-terminal cluster and tags kill conflicts", async () => {
    const result = await applyAdvisoryLifecycle({
      emitted: [base],
      previous: [],
      presentedIssueIdentifiers: presented,
      terminalIssueIdentifiers: new Set(["SYMPH-1", "SYMPH-2"]),
      conflictIssueIdentifiers: new Set(["SYMPH-2"]),
      config,
    });
    expect(result.advisories[0]).toMatchObject({
      lifecycleState: "withdrawn",
      conflictIssueIdentifiers: ["SYMPH-2"],
      rendered: false,
    });
    expect(result.events.some((event) => event.kind === "conflict")).toBe(true);
  });

  it("retains only Linear-resolved root identifiers as linkable roots", async () => {
    const resolved = await applyAdvisoryLifecycle({
      emitted: [{ ...base, rootIssueIdentifier: "SYMPH-10" }],
      previous: [],
      presentedIssueIdentifiers: presented,
      config,
      resolveRootIssueIdentifier: async () => true,
    });
    expect(resolved.advisories[0]).toMatchObject({
      rootIssueIdentifier: "SYMPH-10",
      proposedRootIssueIdentifier: null,
    });
    const unresolved = await applyAdvisoryLifecycle({
      emitted: [{ ...base, rootIssueIdentifier: "SYMPH-404" }],
      previous: [],
      presentedIssueIdentifiers: presented,
      config,
      resolveRootIssueIdentifier: async () => false,
    });
    expect(unresolved.advisories[0]).toMatchObject({
      rootIssueIdentifier: null,
      proposedRootIssueIdentifier: "SYMPH-404",
    });
  });
});
