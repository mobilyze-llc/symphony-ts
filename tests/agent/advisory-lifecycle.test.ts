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

  it("advances shared lifecycle once for competing member-set hypotheses", async () => {
    const competing = [
      base,
      { ...base, rootCauseHypothesis: "competing root hypothesis" },
    ];
    const first = await applyAdvisoryLifecycle({
      emitted: competing,
      previous: [],
      presentedIssueIdentifiers: presented,
      config,
    });
    expect(
      new Set(first.advisories.map((item) => item.memberSetHash)).size,
    ).toBe(1);
    expect(
      new Set(first.advisories.map((item) => item.advisoryFingerprint)).size,
    ).toBe(2);

    const absent = await applyAdvisoryLifecycle({
      emitted: [],
      previous: first.advisories,
      presentedIssueIdentifiers: presented,
      config,
    });
    expect(absent.advisories).toHaveLength(2);
    expect(
      absent.advisories.map((item) => [
        item.lifecycleState,
        item.absentOkTicks,
      ]),
    ).toEqual([
      ["dormant", 1],
      ["dormant", 1],
    ]);
    expect(absent.events).toEqual([
      expect.objectContaining({
        kind: "transition",
        memberSetHash: first.advisories[0]?.memberSetHash,
        from: "active",
        to: "dormant",
      }),
    ]);

    const reEmitted = await applyAdvisoryLifecycle({
      emitted: competing,
      previous: absent.advisories,
      presentedIssueIdentifiers: presented,
      config,
    });
    expect(
      reEmitted.advisories.map((item) => [
        item.lifecycleState,
        item.absentOkTicks,
      ]),
    ).toEqual([
      ["active", 0],
      ["active", 0],
    ]);
    expect(reEmitted.events).toEqual([
      expect.objectContaining({
        kind: "transition",
        memberSetHash: first.advisories[0]?.memberSetHash,
        from: "dormant",
        to: "active",
      }),
    ]);
  });

  it("treats wording drift and rejection suppression as member-set observations", async () => {
    const first = await applyAdvisoryLifecycle({
      emitted: [base],
      previous: [],
      presentedIssueIdentifiers: presented,
      config,
    });
    const memberSetHash = first.advisories[0]?.memberSetHash;
    expect(memberSetHash).toBeDefined();

    const wordingDrift = await applyAdvisoryLifecycle({
      emitted: [{ ...base, rootCauseHypothesis: "Different root wording" }],
      previous: first.advisories,
      presentedIssueIdentifiers: presented,
      config,
    });
    expect(wordingDrift.advisories).toHaveLength(2);
    expect(wordingDrift.advisories).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          advisoryFingerprint: first.advisories[0]?.advisoryFingerprint,
          lifecycleState: "active",
          absentOkTicks: 0,
        }),
      ]),
    );
    expect(
      wordingDrift.events.some((event) => event.kind === "transition"),
    ).toBe(false);

    const suppressed = await applyAdvisoryLifecycle({
      emitted: [base],
      previous: first.advisories,
      presentedIssueIdentifiers: presented,
      config,
      rejectedMemberSets: [
        {
          advisoryId: "rejected-fingerprint",
          memberSetHash: memberSetHash!,
          memberActivityAtGrade: {
            "SYMPH-1": "2026-06-01T00:00:00.000Z",
            "SYMPH-2": "2026-06-01T00:00:00.000Z",
          },
          gradeSequence: 10,
        },
      ],
      issueActivity: new Map([
        ["SYMPH-1", "2026-06-01T00:00:00.000Z"],
        ["SYMPH-2", "2026-06-01T00:00:00.000Z"],
      ]),
    });
    expect(suppressed.advisories).toEqual([
      expect.objectContaining({
        advisoryFingerprint: first.advisories[0]?.advisoryFingerprint,
        lifecycleState: "active",
        absentOkTicks: 0,
      }),
    ]);
    expect(suppressed.events.some((event) => event.kind === "transition")).toBe(
      false,
    );
  });

  it("keeps terminal grades fingerprint-scoped while sharing member-set lifecycle", async () => {
    const first = await applyAdvisoryLifecycle({
      emitted: [
        base,
        { ...base, rootCauseHypothesis: "competing root hypothesis" },
      ],
      previous: [],
      presentedIssueIdentifiers: presented,
      config,
    });
    const previous = first.advisories.map((advisory, index) =>
      index === 0
        ? { ...advisory, lifecycleState: "graded" as const, rendered: false }
        : advisory,
    );
    const absent = await applyAdvisoryLifecycle({
      emitted: [],
      previous,
      presentedIssueIdentifiers: presented,
      config,
    });
    expect(absent.advisories).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          advisoryFingerprint: previous[0]?.advisoryFingerprint,
          lifecycleState: "graded",
        }),
        expect.objectContaining({
          advisoryFingerprint: previous[1]?.advisoryFingerprint,
          lifecycleState: "dormant",
        }),
      ]),
    );
    expect(absent.events).toHaveLength(1);
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

  it("suppresses an exact rejected member set and revives it on member activity", async () => {
    const memberSetHash = structuralAdvisoryMemberSetHash(
      base.memberIssueIdentifiers,
    );
    const rejection = {
      advisoryId: "prior-fingerprint",
      memberSetHash,
      memberActivityAtGrade: {
        "SYMPH-1": "2026-06-01T00:00:00.000Z",
        "SYMPH-2": "2026-06-01T00:00:00.000Z",
      },
      gradeSequence: 10,
    };
    const suppressed = await applyAdvisoryLifecycle({
      emitted: [base],
      previous: [],
      presentedIssueIdentifiers: presented,
      config,
      rejectedMemberSets: [rejection],
      issueActivity: new Map([
        ["SYMPH-1", "2026-06-01T00:00:00.000Z"],
        ["SYMPH-2", "2026-06-01T00:00:00.000Z"],
      ]),
    });
    expect(suppressed.advisories).toHaveLength(0);
    expect(suppressed.events).toContainEqual(
      expect.objectContaining({ kind: "suppressed", memberSetHash }),
    );

    const revived = await applyAdvisoryLifecycle({
      emitted: [base],
      previous: [],
      presentedIssueIdentifiers: presented,
      config,
      rejectedMemberSets: [rejection],
      issueActivity: new Map([
        ["SYMPH-1", "2026-06-02T00:00:00.000Z"],
        ["SYMPH-2", "2026-06-01T00:00:00.000Z"],
      ]),
    });
    expect(revived.advisories[0]?.previouslyRejectedWithNewEvidence).toBe(true);

    const changedMembership = await applyAdvisoryLifecycle({
      emitted: [
        { ...base, memberIssueIdentifiers: ["SYMPH-1", "SYMPH-2", "SYMPH-3"] },
      ],
      previous: [],
      presentedIssueIdentifiers: new Set(["SYMPH-1", "SYMPH-2", "SYMPH-3"]),
      config,
      rejectedMemberSets: [rejection],
    });
    expect(changedMembership.advisories).toHaveLength(1);
  });

  it("explicitly revives a graded rejected fingerprint when member activity advances", async () => {
    const first = await applyAdvisoryLifecycle({
      emitted: [base],
      previous: [],
      presentedIssueIdentifiers: presented,
      config,
    });
    const graded = {
      ...first.advisories[0]!,
      lifecycleState: "graded" as const,
      rendered: false,
    };
    const rejection = {
      advisoryId: graded.advisoryFingerprint!,
      memberSetHash: graded.memberSetHash!,
      memberActivityAtGrade: {
        "SYMPH-1": "2026-06-01T00:00:00.000Z",
        "SYMPH-2": null,
      },
      gradeSequence: 10,
    };

    const revived = await applyAdvisoryLifecycle({
      emitted: [base],
      previous: [graded],
      presentedIssueIdentifiers: presented,
      config,
      rejectedMemberSets: [rejection],
      issueActivity: new Map([
        ["SYMPH-1", "2026-06-01T00:00:00.000Z"],
        ["SYMPH-2", "2026-06-02T00:00:00.000Z"],
      ]),
    });
    expect(revived.advisories).toEqual([
      expect.objectContaining({
        advisoryFingerprint: graded.advisoryFingerprint,
        lifecycleState: "active",
        rendered: true,
        previouslyRejectedWithNewEvidence: true,
      }),
    ]);

    const unrelatedRejection = await applyAdvisoryLifecycle({
      emitted: [base],
      previous: [graded],
      presentedIssueIdentifiers: presented,
      config,
      rejectedMemberSets: [{ ...rejection, advisoryId: "other-fingerprint" }],
      issueActivity: new Map([
        ["SYMPH-1", "2026-06-02T00:00:00.000Z"],
        ["SYMPH-2", "2026-06-02T00:00:00.000Z"],
      ]),
    });
    expect(unrelatedRejection.advisories[0]).toMatchObject({
      lifecycleState: "graded",
      rendered: false,
    });
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
    expect(withdrawn.events).toContainEqual(
      expect.objectContaining({
        kind: "transition",
        from: "dormant",
        to: "withdrawn",
      }),
    );
  });

  it("preserves terminal member-set state across absences and re-emission", async () => {
    const first = await applyAdvisoryLifecycle({
      emitted: [base],
      previous: [],
      presentedIssueIdentifiers: presented,
      config,
    });
    let snapshot = first.advisories;
    for (let tick = 0; tick < config.dormantOkTicks; tick += 1) {
      snapshot = (
        await applyAdvisoryLifecycle({
          emitted: [],
          previous: snapshot,
          presentedIssueIdentifiers: presented,
          config,
        })
      ).advisories;
    }
    const afterExtraAbsence = await applyAdvisoryLifecycle({
      emitted: [],
      previous: snapshot,
      presentedIssueIdentifiers: presented,
      config,
    });
    const reEmitted = await applyAdvisoryLifecycle({
      emitted: [base],
      previous: afterExtraAbsence.advisories,
      presentedIssueIdentifiers: presented,
      config,
    });
    expect(afterExtraAbsence.advisories[0]).toMatchObject({
      lifecycleState: "withdrawn",
      rendered: false,
    });
    expect(reEmitted.advisories[0]).toMatchObject({
      lifecycleState: "withdrawn",
      rendered: false,
    });

    const graded = first.advisories.map((advisory) => ({
      ...advisory,
      lifecycleState: "graded" as const,
      rendered: false,
    }));
    const gradedAbsent = await applyAdvisoryLifecycle({
      emitted: [],
      previous: graded,
      presentedIssueIdentifiers: presented,
      config,
    });
    const gradedReEmitted = await applyAdvisoryLifecycle({
      emitted: [base],
      previous: gradedAbsent.advisories,
      presentedIssueIdentifiers: presented,
      config,
    });
    expect(gradedAbsent.advisories[0]?.lifecycleState).toBe("graded");
    expect(gradedReEmitted.advisories[0]).toMatchObject({
      lifecycleState: "graded",
      rendered: false,
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
