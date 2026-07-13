import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { applyAdvisoryLifecycle } from "../../src/agent/advisory-lifecycle.js";
import { acquireDispatcherRunJournalRuntimeOwnership } from "../../src/logging/run-journal-ownership.js";
import {
  appendDispatcherRunJournalEntry,
  appendDispatcherRunJournalEntryToDisk,
  compactDispatcherRunJournalFileWithLock,
  readDispatcherRunJournal,
} from "../../src/logging/run-journal.js";
import {
  journalCliStructuralAdvisories,
  journalCliStructuralAdvisoryGrade,
} from "../../src/logging/structural-advisory-cli-journal.js";
import {
  buildBacklogManagerCalibrationProjection,
  projectStructuralAdvisoryRejections,
} from "../../src/orchestrator/structural-advisory-journal.js";

const advisory = {
  memberIssueIdentifiers: ["MOB-1", "MOB-2"],
  rootCauseHypothesis: "Shared root",
  structuralFix: "Centralize the fix",
  confidenceNote: "High",
};

describe("CLI structural-advisory journal safety", () => {
  it("canonicalizes resolved and unresolved roots before identity, dedup, and grading", async () => {
    const resolvedRoot = await mkdtemp(join(tmpdir(), "cli-journal-root-ok-"));
    const proposedRoot = await mkdtemp(
      join(tmpdir(), "cli-journal-root-proposed-"),
    );
    const rootedAdvisory = {
      ...advisory,
      rootIssueIdentifier: " MOB-10 ",
    };
    try {
      const resolved = await journalCliStructuralAdvisories({
        root: resolvedRoot,
        advisories: [rootedAdvisory],
        presentedIssueIdentifiers: new Set(["MOB-1", "MOB-2"]),
        resolveRootIssueIdentifier: async (identifier) =>
          identifier === "MOB-10",
      });
      expect(resolved.appended[0]?.metadata).toMatchObject({
        advisory_class: "2:existing-root",
        root_hypothesis_kind: "existing-root",
        root_issue_identifier: "MOB-10",
      });

      const proposed = await journalCliStructuralAdvisories({
        root: proposedRoot,
        advisories: [rootedAdvisory],
        presentedIssueIdentifiers: new Set(["MOB-1", "MOB-2"]),
        resolveRootIssueIdentifier: async () => false,
      });
      const advisoryId = proposed.appended[0]?.metadata.advisory_id;
      expect(proposed.appended[0]?.metadata).toMatchObject({
        advisory_class: "2:proposed-new-root",
        root_hypothesis_kind: "proposed-new-root",
        root_issue_identifier: null,
      });

      const repeated = await journalCliStructuralAdvisories({
        root: proposedRoot,
        advisories: [rootedAdvisory],
        presentedIssueIdentifiers: new Set(["MOB-1", "MOB-2"]),
        resolveRootIssueIdentifier: async () => false,
      });
      expect(repeated.appended).toEqual([]);
      expect(repeated.skipped[0]?.metadata.advisory_id).toBe(advisoryId);

      const grade = await journalCliStructuralAdvisoryGrade({
        root: proposedRoot,
        advisory,
        decision: "accept",
        actor: { kind: "interactive-agent", host: "pro14" },
        reason: "confirmed proposed root cluster",
      });
      expect(grade.entry.metadata.advisory_id).toBe(advisoryId);
    } finally {
      await rm(resolvedRoot, { recursive: true, force: true });
      await rm(proposedRoot, { recursive: true, force: true });
    }
  });

  it("rejects the host-at-N CLI race before append", async () => {
    const root = await mkdtemp(join(tmpdir(), "cli-journal-owner-"));
    const ownership = await acquireDispatcherRunJournalRuntimeOwnership(root);
    try {
      const hostAtN = appendDispatcherRunJournalEntry([], hostDraft("at-n"));
      await appendDispatcherRunJournalEntryToDisk(root, hostAtN.entry);

      await expect(
        journalCliStructuralAdvisories({
          root,
          advisories: [advisory],
          presentedIssueIdentifiers: new Set(["MOB-1", "MOB-2"]),
        }),
      ).rejects.toThrow(/Unsafe standalone.*symphonyctl/);
      expect(await readDispatcherRunJournal(root)).toEqual([hostAtN.entry]);

      const hostNext = appendDispatcherRunJournalEntry(
        hostAtN.journal,
        hostDraft("next"),
      );
      await appendDispatcherRunJournalEntryToDisk(root, hostNext.entry);
      expect(
        (await readDispatcherRunJournal(root)).map((entry) => entry.sequence),
      ).toEqual([1, 2]);
    } finally {
      await ownership.release();
      await rm(root, { recursive: true, force: true });
    }
  });

  it("suppresses pre-grade activity and revives only post-grade activity", async () => {
    const root = await mkdtemp(join(tmpdir(), "cli-journal-grade-"));
    const gradeTime = "2026-07-13T12:00:00.000Z";
    try {
      const emission = await journalCliStructuralAdvisories({
        root,
        advisories: [advisory],
        presentedIssueIdentifiers: new Set(["MOB-1", "MOB-2"]),
        memberActivityByIdentifier: new Map([
          ["MOB-1", activity("MOB-1", "2026-07-13T10:00:00.000Z")],
          ["MOB-2", activity("MOB-2", "2026-07-13T10:05:00.000Z")],
        ]),
        now: () => new Date("2026-07-13T09:00:00.000Z"),
      });
      expect(emission.appended).toHaveLength(1);

      await journalCliStructuralAdvisoryGrade({
        root,
        advisory,
        decision: "reject",
        actor: { kind: "interactive-agent", host: "pro14" },
        reason: "wrong cluster",
        now: () => new Date(gradeTime),
      });

      const journal = await readDispatcherRunJournal(root);
      const grade = journal.find(
        (entry) => entry.kind === "structural_advisory_grade",
      );
      expect(grade?.metadata.member_activity_at_grade).toBeUndefined();
      expect(grade?.metadata.activity_baseline_at_grade).toEqual({
        kind: "grade_timestamp",
        timestamp: gradeTime,
      });
      const rejections = projectStructuralAdvisoryRejections(journal);
      expect(rejections[0]?.memberActivityAtGrade).toEqual({
        "MOB-1": gradeTime,
        "MOB-2": gradeTime,
      });

      const preGradeOnly = await applyAdvisoryLifecycle({
        emitted: [advisory],
        previous: [],
        presentedIssueIdentifiers: new Set(["MOB-1", "MOB-2"]),
        config: { dormantOkTicks: 2, renderCap: 5 },
        rejectedMemberSets: rejections,
        issueActivity: new Map([
          ["MOB-1", "2026-07-13T11:00:00.000Z"],
          ["MOB-2", "2026-07-13T11:05:00.000Z"],
        ]),
      });
      expect(preGradeOnly.advisories).toEqual([]);
      expect(preGradeOnly.events).toEqual([
        expect.objectContaining({ kind: "suppressed" }),
      ]);

      const postGrade = await applyAdvisoryLifecycle({
        emitted: [advisory],
        previous: [],
        presentedIssueIdentifiers: new Set(["MOB-1", "MOB-2"]),
        config: { dormantOkTicks: 2, renderCap: 5 },
        rejectedMemberSets: rejections,
        issueActivity: new Map([
          ["MOB-1", "2026-07-13T13:00:00.000Z"],
          ["MOB-2", "2026-07-13T11:05:00.000Z"],
        ]),
      });
      expect(postGrade.advisories[0]).toMatchObject({
        previouslyRejectedWithNewEvidence: true,
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("accepts a grade when the matching advisory exists only in checkpoint projection", async () => {
    const root = await mkdtemp(join(tmpdir(), "cli-journal-grade-checkpoint-"));
    try {
      const emission = await journalCliStructuralAdvisories({
        root,
        advisories: [advisory],
        presentedIssueIdentifiers: new Set(["MOB-1", "MOB-2"]),
      });
      const advisoryId = emission.appended[0]?.metadata.advisory_id;
      await journalCliStructuralAdvisories({
        root,
        advisories: [
          {
            ...advisory,
            memberIssueIdentifiers: ["MOB-3", "MOB-4"],
            rootCauseHypothesis: "Filler root",
          },
          {
            ...advisory,
            memberIssueIdentifiers: ["MOB-5", "MOB-6"],
            rootCauseHypothesis: "Second filler root",
          },
        ],
        presentedIssueIdentifiers: new Set([
          "MOB-3",
          "MOB-4",
          "MOB-5",
          "MOB-6",
        ]),
      });

      const journal = await readDispatcherRunJournal(root);
      const compacted = await compactDispatcherRunJournalFileWithLock(
        root,
        {
          idempotencyKey: "checkpoint-draft",
          timestamp: "2026-07-13T13:00:00.000Z",
          kind: "journal_checkpoint",
          issueId: "__journal__",
          issueIdentifier: "JOURNAL",
          operation: "dispatcher",
          stage: null,
          attempt: null,
          ownerId: null,
          lease: null,
          summary: "Checkpoint Manager calibration.",
          metadata: {
            backlogManagerCalibration:
              buildBacklogManagerCalibrationProjection(journal),
          },
        },
        { tailEntryCount: 1, minEntryCount: 2 },
      );
      expect(compacted.compacted).toBe(true);
      expect(
        compacted.journal.some(
          (entry) =>
            entry.kind === "structural_advisory" &&
            entry.metadata.advisory_id === advisoryId,
        ),
      ).toBe(false);

      const result = await journalCliStructuralAdvisoryGrade({
        root,
        advisory,
        decision: "accept",
        actor: { kind: "interactive-agent", host: "pro14" },
        reason: "confirmed cluster",
      });
      expect(result.status).toBe("applied");
      expect(result.entry.metadata.advisory_id).toBe(advisoryId);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("does not match an advisory by member-set hash when the root differs", async () => {
    const root = await mkdtemp(join(tmpdir(), "cli-journal-grade-root-"));
    try {
      await journalCliStructuralAdvisories({
        root,
        advisories: [advisory],
        presentedIssueIdentifiers: new Set(["MOB-1", "MOB-2"]),
      });
      const before = await readDispatcherRunJournal(root);

      await expect(
        journalCliStructuralAdvisoryGrade({
          root,
          advisory: {
            ...advisory,
            rootCauseHypothesis: "Different root",
          },
          decision: "reject",
          actor: { kind: "interactive-agent", host: "pro14" },
          reason: "wrong cluster",
        }),
      ).rejects.toThrow(/unknown structural advisory/);
      expect(await readDispatcherRunJournal(root)).toEqual(before);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

function hostDraft(suffix: string) {
  return {
    idempotencyKey: `host:${suffix}`,
    timestamp: `2026-07-13T10:0${suffix === "at-n" ? "0" : "1"}:00.000Z`,
    kind: "intent" as const,
    issueId: "host-issue",
    issueIdentifier: "MOB-HOST",
    operation: "dispatcher" as const,
    stage: null,
    attempt: null,
    ownerId: "runtime-host",
    lease: null,
    summary: `Host ${suffix} entry.`,
    metadata: {},
  };
}

function activity(identifier: string, activityAt: string) {
  return {
    identifier,
    state: "Backlog",
    stateUpdatedAt: activityAt,
    latestCommentAt: null,
    activityAt,
  };
}
