import { describe, expect, it } from "vitest";

import { computeCalibrationReport } from "../../src/calibration/digest.js";
import type { DispatcherRunJournalEntry } from "../../src/domain/model.js";
import type { StructuralAdvisory } from "../../src/domain/structural-advisory.js";
import { compactDispatcherRunJournalWithCheckpoint } from "../../src/logging/run-journal.js";
import {
  buildBacklogManagerCalibrationProjection,
  buildStructuralAdvisoryGradeJournalEntry,
  buildStructuralAdvisoryJournalEntry,
  expandBacklogManagerCalibrationJournal,
  projectStructuralAdvisoryGradeEvidence,
  projectStructuralAdvisoryRejections,
} from "../../src/orchestrator/structural-advisory-journal.js";

const advisory: StructuralAdvisory = {
  memberIssueIdentifiers: ["SYMPH-1", "SYMPH-2"],
  rootCauseHypothesis: "Shared parser",
  structuralFix: "Fix the parser once",
  confidenceNote: "high",
  memberSetHash: "members-1",
  advisoryFingerprint: "fp-1",
  lifecycleState: "active",
  rootIssueIdentifier: "SYMPH-99",
};

function atSequence(
  draft: Omit<DispatcherRunJournalEntry, "sequence">,
  sequence: number,
): DispatcherRunJournalEntry {
  return { ...draft, sequence };
}

describe("structural advisory journal", () => {
  it("uses occurrence-aware transition keys and carries the fingerprint", () => {
    const first = buildStructuralAdvisoryJournalEntry({
      record: {
        advisory,
        from: "active",
        to: "dormant",
        timestamp: "2026-06-12T00:00:00.000Z",
        occurrence: 1,
      },
      ownerId: "owner",
    });
    const second = buildStructuralAdvisoryJournalEntry({
      record: {
        advisory,
        from: "active",
        to: "dormant",
        timestamp: "2026-06-12T00:00:00.000Z",
        occurrence: 3,
      },
      ownerId: "owner",
    });
    expect(first.idempotencyKey).not.toBe(second.idempotencyKey);
    expect(first.metadata).toMatchObject({
      advisory_id: "fp-1",
      member_set_hash: "members-1",
      advisory_class: "2:existing-root",
    });
  });

  it("keys grades per fingerprint and actor, excluding the decision value", () => {
    const build = (decision: "accept" | "reject") =>
      buildStructuralAdvisoryGradeJournalEntry({
        advisory,
        decision,
        acceptedIdentifiers: decision === "accept" ? ["SYMPH-1"] : [],
        membersAtGrade: [
          {
            identifier: "SYMPH-1",
            state: "Backlog",
            stateUpdatedAt: "2026-06-12T00:00:00.000Z",
            latestCommentAt: null,
            activityAt: "2026-06-12T00:00:00.000Z",
          },
        ],
        droppedIdentifiers: ["SYMPH-2"],
        actor: { kind: "operator", host: "pro14", session: "ctl" },
        reason: "grade",
        ownerId: "owner",
        timestamp: "2026-06-12T00:00:00.000Z",
      });
    expect(build("accept").idempotencyKey).toBe(build("reject").idempotencyKey);
  });

  it("projects exact rejected member sets with their activity snapshot", () => {
    const grade = buildStructuralAdvisoryGradeJournalEntry({
      advisory,
      decision: "reject",
      acceptedIdentifiers: [],
      membersAtGrade: [
        {
          identifier: "SYMPH-1",
          state: "Backlog",
          stateUpdatedAt: "2026-06-12T00:00:00.000Z",
          latestCommentAt: null,
          activityAt: "2026-06-12T00:00:00.000Z",
        },
      ],
      droppedIdentifiers: [],
      actor: { kind: "operator", host: "pro14" },
      reason: "wrong cluster",
      ownerId: "owner",
      timestamp: "2026-06-12T00:00:00.000Z",
    });
    const journal = [{ ...grade, sequence: 7 } as DispatcherRunJournalEntry];
    expect(projectStructuralAdvisoryRejections(journal)).toEqual([
      {
        advisoryId: "fp-1",
        memberSetHash: "members-1",
        memberActivityAtGrade: {
          "SYMPH-1": "2026-06-12T00:00:00.000Z",
          "SYMPH-2": null,
        },
        gradeSequence: 7,
      },
    ]);
  });

  it("retains dropped originals in rejection delta and activity with null evidence", () => {
    const grade = buildStructuralAdvisoryGradeJournalEntry({
      advisory,
      decision: "reject",
      acceptedIdentifiers: [],
      membersAtGrade: [
        {
          identifier: "SYMPH-1",
          state: "Backlog",
          stateUpdatedAt: "2026-06-12T00:00:00.000Z",
          latestCommentAt: null,
          activityAt: "2026-06-12T00:00:00.000Z",
        },
      ],
      droppedIdentifiers: ["SYMPH-2"],
      actor: { kind: "operator", host: "pro14" },
      reason: "wrong cluster",
      ownerId: "owner",
      timestamp: "2026-06-12T00:00:00.000Z",
    });
    expect(grade.metadata).toMatchObject({
      member_delta: ["SYMPH-1", "SYMPH-2"],
      member_activity_at_grade: {
        "SYMPH-1": "2026-06-12T00:00:00.000Z",
        "SYMPH-2": null,
      },
    });
    expect(
      projectStructuralAdvisoryRejections([
        { ...grade, sequence: 7 } as DispatcherRunJournalEntry,
      ]),
    ).toEqual([
      expect.objectContaining({
        memberActivityAtGrade: {
          "SYMPH-1": "2026-06-12T00:00:00.000Z",
          "SYMPH-2": null,
        },
      }),
    ]);
  });

  it("rehydrates authoritative grades, rejection evidence, and stability after checkpoint compaction", () => {
    const partialAdvisory = advisory;
    const rejectedAdvisory: StructuralAdvisory = {
      ...advisory,
      memberIssueIdentifiers: ["SYMPH-3", "SYMPH-4"],
      memberSetHash: "members-2",
      advisoryFingerprint: "fp-2",
      rootCauseHypothesis: "Shared serializer",
    };
    const tailAdvisory: StructuralAdvisory = {
      ...advisory,
      memberIssueIdentifiers: ["SYMPH-5", "SYMPH-6"],
      memberSetHash: "members-tail",
      advisoryFingerprint: "fp-tail",
      rootCauseHypothesis: "Tail advisory",
    };
    const partialGrade = buildStructuralAdvisoryGradeJournalEntry({
      advisory: partialAdvisory,
      decision: "partial",
      acceptedIdentifiers: ["SYMPH-1"],
      membersAtGrade: [
        {
          identifier: "SYMPH-1",
          state: "Backlog",
          stateUpdatedAt: "2026-06-12T00:00:03.000Z",
          latestCommentAt: null,
          activityAt: "2026-06-12T00:00:03.000Z",
        },
        {
          identifier: "SYMPH-2",
          state: "Backlog",
          stateUpdatedAt: "2026-06-12T00:00:03.000Z",
          latestCommentAt: null,
          activityAt: "2026-06-12T00:00:03.000Z",
        },
      ],
      droppedIdentifiers: [],
      actor: { kind: "operator", host: "pro14", session: "ctl" },
      reason: "keep one member",
      ownerId: "owner",
      timestamp: "2026-06-12T00:00:03.000Z",
    });
    const rejectedGrade = buildStructuralAdvisoryGradeJournalEntry({
      advisory: rejectedAdvisory,
      decision: "reject",
      acceptedIdentifiers: [],
      membersAtGrade: [
        {
          identifier: "SYMPH-3",
          state: "Backlog",
          stateUpdatedAt: "2026-06-12T00:00:05.000Z",
          latestCommentAt: null,
          activityAt: "2026-06-12T00:00:05.000Z",
        },
        {
          identifier: "SYMPH-4",
          state: "Backlog",
          stateUpdatedAt: "2026-06-12T00:00:05.000Z",
          latestCommentAt: null,
          activityAt: "2026-06-12T00:00:05.000Z",
        },
      ],
      droppedIdentifiers: [],
      actor: { kind: "operator", host: "pro14", session: "ctl" },
      reason: "wrong cluster",
      ownerId: "owner",
      timestamp: "2026-06-12T00:00:05.000Z",
    });
    const raw = [
      atSequence(
        buildStructuralAdvisoryJournalEntry({
          record: {
            advisory: partialAdvisory,
            from: null,
            to: "active",
            timestamp: "2026-06-12T00:00:01.000Z",
          },
          ownerId: "owner",
        }),
        1,
      ),
      atSequence(
        buildStructuralAdvisoryJournalEntry({
          record: {
            advisory: partialAdvisory,
            from: "active",
            to: "dormant",
            timestamp: "2026-06-12T00:00:02.000Z",
          },
          ownerId: "owner",
        }),
        2,
      ),
      atSequence(partialGrade, 3),
      atSequence(
        buildStructuralAdvisoryJournalEntry({
          record: {
            advisory: rejectedAdvisory,
            from: null,
            to: "active",
            timestamp: "2026-06-12T00:00:04.000Z",
          },
          ownerId: "owner",
        }),
        4,
      ),
      atSequence(rejectedGrade, 5),
      atSequence(
        buildStructuralAdvisoryJournalEntry({
          record: {
            advisory: tailAdvisory,
            from: null,
            to: "active",
            timestamp: "2026-06-12T00:00:06.000Z",
          },
          ownerId: "owner",
        }),
        6,
      ),
    ];
    const projection = buildBacklogManagerCalibrationProjection(raw);
    const compacted = compactDispatcherRunJournalWithCheckpoint(
      raw,
      {
        idempotencyKey: "checkpoint-draft",
        timestamp: "2026-06-12T00:00:07.000Z",
        kind: "journal_checkpoint",
        issueId: "__journal__",
        issueIdentifier: "JOURNAL",
        operation: "dispatcher",
        stage: null,
        attempt: null,
        ownerId: "owner",
        lease: null,
        summary: "Checkpoint Manager calibration.",
        metadata: { backlogManagerCalibration: projection },
      },
      { tailEntryCount: 1, minEntryCount: 2 },
    );
    expect(compacted.compacted).toBe(true);
    expect(compacted.journal.map((entry) => entry.kind)).toEqual([
      "journal_checkpoint",
      "structural_advisory",
    ]);

    const expanded = expandBacklogManagerCalibrationJournal(compacted.journal);
    expect(
      expanded.find(
        (entry) =>
          entry.kind === "structural_advisory_grade" &&
          entry.metadata.advisory_id === "fp-1",
      )?.idempotencyKey,
    ).toBe(partialGrade.idempotencyKey);
    expect(projectStructuralAdvisoryGradeEvidence(compacted.journal)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          advisoryId: "fp-1",
          decision: "partial",
          acceptedIdentifiers: ["SYMPH-1"],
          memberDelta: ["SYMPH-2"],
        }),
        expect.objectContaining({
          advisoryId: "fp-2",
          decision: "reject",
        }),
      ]),
    );
    expect(projectStructuralAdvisoryRejections(compacted.journal)).toEqual([
      expect.objectContaining({
        advisoryId: "fp-2",
        memberSetHash: "members-2",
        memberActivityAtGrade: {
          "SYMPH-3": "2026-06-12T00:00:05.000Z",
          "SYMPH-4": "2026-06-12T00:00:05.000Z",
        },
      }),
    ]);

    const report = computeCalibrationReport(compacted.journal);
    expect(report.structuralAdvisoryStability).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          advisoryId: "fp-1",
          firstSeenAt: "2026-06-12T00:00:01.000Z",
          lastSeenAt: "2026-06-12T00:00:02.000Z",
          flipCount: 1,
          decision: "partial",
        }),
      ]),
    );

    const laterActor = atSequence(
      buildStructuralAdvisoryGradeJournalEntry({
        advisory: partialAdvisory,
        decision: "reject",
        acceptedIdentifiers: [],
        membersAtGrade: [],
        droppedIdentifiers: [],
        actor: { kind: "operator", host: "pro16", session: "second" },
        reason: "later opinion",
        ownerId: "owner",
        timestamp: "2026-06-12T00:00:08.000Z",
      }),
      8,
    );
    expect(
      projectStructuralAdvisoryGradeEvidence([
        ...compacted.journal,
        laterActor,
      ]).find((grade) => grade.advisoryId === "fp-1"),
    ).toMatchObject({ decision: "partial", gradeSequence: 3 });
  });

  it.each([
    ["null advisory record", "null_advisory"],
    ["malformed nested grade", "bad_grade"],
    ["malformed nested hygiene decision", "bad_decision"],
  ] as const)(
    "rejects a latest checkpoint with %s and falls back to the earlier valid projection",
    (_label, malformedKind) => {
      const source = atSequence(
        buildStructuralAdvisoryJournalEntry({
          record: {
            advisory,
            from: null,
            to: "active",
            timestamp: "2026-06-12T00:00:01.000Z",
          },
          ownerId: "owner",
        }),
        1,
      );
      const projection = buildBacklogManagerCalibrationProjection([source]);
      const projectedAdvisory = projection.advisories["fp-1"]!;
      const malformedProjection = {
        ...projection,
        advisories:
          malformedKind === "null_advisory"
            ? { "fp-1": null }
            : malformedKind === "bad_grade"
              ? { "fp-1": { ...projectedAdvisory, grades: [null] } }
              : projection.advisories,
        hygieneProposals:
          malformedKind === "bad_decision"
            ? {
                proposal: {
                  proposalId: "proposal",
                  sequence: 1,
                  timestamp: "2026-06-12T00:00:01.000Z",
                  summary: "proposal",
                  issueId: "issue-1",
                  issueIdentifier: "SYMPH-1",
                  metadata: {},
                  decisions: [null],
                },
              }
            : projection.hygieneProposals,
      };
      const checkpoint = (
        sequence: number,
        coveredThroughSequence: number,
        backlogManagerCalibration: unknown,
      ): DispatcherRunJournalEntry => ({
        sequence,
        idempotencyKey: `checkpoint:${sequence}`,
        timestamp: `2026-06-12T00:00:0${sequence}.000Z`,
        kind: "journal_checkpoint",
        issueId: "__journal__",
        issueIdentifier: "JOURNAL",
        operation: "dispatcher",
        stage: null,
        attempt: null,
        ownerId: "owner",
        lease: null,
        summary: "checkpoint",
        metadata: { coveredThroughSequence, backlogManagerCalibration },
      });
      const rawTail = atSequence(
        buildStructuralAdvisoryJournalEntry({
          record: {
            advisory: { ...advisory, lifecycleState: "dormant" },
            from: "active",
            to: "dormant",
            timestamp: "2026-06-12T00:00:04.000Z",
          },
          ownerId: "owner",
        }),
        4,
      );

      const journal = [
        checkpoint(2, 1, projection),
        checkpoint(3, 3, malformedProjection),
        rawTail,
      ];
      expect(() =>
        expandBacklogManagerCalibrationJournal(journal),
      ).not.toThrow();
      const expanded = expandBacklogManagerCalibrationJournal(journal);
      expect(expanded.map((entry) => entry.sequence)).toEqual([1, 4]);
      expect(
        buildBacklogManagerCalibrationProjection(journal).advisories["fp-1"],
      ).toMatchObject({
        firstSeenSequence: 1,
        lastSeenSequence: 4,
        latestLifecycleTo: "dormant",
      });
      expect(
        computeCalibrationReport(journal).structuralAdvisoryStability[0],
      ).toMatchObject({
        advisoryId: "fp-1",
        firstSeenAt: "2026-06-12T00:00:01.000Z",
        lastSeenAt: "2026-06-12T00:00:04.000Z",
      });
    },
  );
});
