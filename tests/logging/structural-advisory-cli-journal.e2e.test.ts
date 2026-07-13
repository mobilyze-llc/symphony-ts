import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { applyAdvisoryLifecycle } from "../../src/agent/advisory-lifecycle.js";
import type { PlannerRunResult } from "../../src/agent/triage-planner.js";
import { computeCalibrationReport } from "../../src/calibration/digest.js";
import { readCalibrationJournal } from "../../src/calibration/journal-reader.js";
import {
  ADVISORY_GRADE_EXIT,
  runAdvisoryGradeCli,
} from "../../src/cli/advisory-grade.js";
import {
  MANAGER_PLAN_EXIT,
  runManagerPlanCli,
} from "../../src/cli/manager-plan.js";
import type { Issue } from "../../src/domain/model.js";
import { acquireDispatcherRunJournalRuntimeOwnership } from "../../src/logging/run-journal-ownership.js";
import {
  appendDispatcherRunJournalEntry,
  appendDispatcherRunJournalEntryToDisk,
  compactDispatcherRunJournalFileWithLock,
  readDispatcherRunJournal,
} from "../../src/logging/run-journal.js";
import { journalCliStructuralAdvisories } from "../../src/logging/structural-advisory-cli-journal.js";
import {
  buildBacklogManagerCalibrationProjection,
  expandBacklogManagerCalibrationJournal,
  projectStructuralAdvisoryRejections,
} from "../../src/orchestrator/structural-advisory-journal.js";

// SYMPH-1140 end-to-end: a CLI-journaled advisory (symphony-manager-plan,
// source cli-session) -> the interactive session agent's journal grade
// (symphony-advisory-grade, source cli-session) -> a calibration-digest
// decided precision row attributed to the interactive source.

function issue(
  id: string,
  identifier: string,
  overrides: Partial<Issue> = {},
): Issue {
  return {
    id,
    identifier,
    title: `Title ${identifier}`,
    description: null,
    priority: 2,
    state: "Backlog",
    branchName: null,
    url: null,
    labels: [],
    blockedBy: [],
    createdAt: null,
    updatedAt: null,
    ...overrides,
  };
}

const ADVISORY_ARTIFACT = `# Plan
\`\`\`json
${JSON.stringify({
  rationale: "go",
  batches: [
    {
      mode: "parallel-isolated",
      issueIdentifiers: ["MOB-1"],
      rationale: "first",
    },
  ],
  structural_advisories: [
    {
      memberIssueIdentifiers: ["MOB-1", "MOB-2"],
      rootCauseHypothesis: "Shared root",
      structuralFix: "Centralize the fix",
      confidenceNote: "High",
    },
  ],
})}
\`\`\`
`;

function captureIo() {
  const out: string[] = [];
  const err: string[] = [];
  return {
    io: {
      stdout: (message: string) => out.push(message),
      stderr: (message: string) => err.push(message),
    },
    out: () => out.join(""),
    err: () => err.join(""),
  };
}

async function journalCompactionFillers(root: string): Promise<void> {
  await journalCliStructuralAdvisories({
    root,
    advisories: [
      {
        memberIssueIdentifiers: ["MOB-3", "MOB-4"],
        rootCauseHypothesis: "Filler root one",
        structuralFix: "Filler fix one",
        confidenceNote: "High",
      },
      {
        memberIssueIdentifiers: ["MOB-5", "MOB-6"],
        rootCauseHypothesis: "Filler root two",
        structuralFix: "Filler fix two",
        confidenceNote: "High",
      },
    ],
    presentedIssueIdentifiers: new Set(["MOB-3", "MOB-4", "MOB-5", "MOB-6"]),
  });
}

async function compactCalibrationJournal(root: string) {
  const journal = await readDispatcherRunJournal(root);
  return compactDispatcherRunJournalFileWithLock(
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
}

describe("CLI advisory evidence pipeline (SYMPH-1140)", () => {
  it("rejects a CLI write before append while a runtime host owns the sequence allocator", async () => {
    const root = await mkdtemp(join(tmpdir(), "cli-advisory-owned-root-"));
    const ownership = await acquireDispatcherRunJournalRuntimeOwnership(root);
    try {
      const hostAtN = appendDispatcherRunJournalEntry([], {
        idempotencyKey: "host:at-n",
        timestamp: "2026-07-13T10:00:00.000Z",
        kind: "intent",
        issueId: "host-issue",
        issueIdentifier: "MOB-HOST",
        operation: "dispatcher",
        stage: null,
        attempt: null,
        ownerId: "runtime-host",
        lease: null,
        summary: "Host entry at N.",
        metadata: {},
      });
      await appendDispatcherRunJournalEntryToDisk(root, hostAtN.entry);

      const plan = captureIo();
      const planCode = await runManagerPlanCli(
        ["--team", "MOB", "--state", "Backlog", "--json"],
        {
          io: plan.io,
          env: {},
          cwd: root,
          loadCandidates: async () => [
            issue("u1", "MOB-1"),
            issue("u2", "MOB-2"),
          ],
          createPlannerRunner: () => async (): Promise<PlannerRunResult> => ({
            status: "ok",
            markdown: ADVISORY_ARTIFACT,
          }),
        },
      );
      expect(planCode).toBe(MANAGER_PLAN_EXIT.loadFailed);
      expect(plan.err()).toContain(
        "Unsafe standalone dispatcher journal write",
      );
      expect(plan.err()).toContain("--no-journal");
      expect(plan.err()).toContain("symphonyctl");
      expect(await readDispatcherRunJournal(root)).toEqual([hostAtN.entry]);

      const hostNext = appendDispatcherRunJournalEntry(hostAtN.journal, {
        idempotencyKey: "host:next",
        timestamp: "2026-07-13T10:01:00.000Z",
        kind: "intent",
        issueId: "host-issue",
        issueIdentifier: "MOB-HOST",
        operation: "dispatcher",
        stage: null,
        attempt: null,
        ownerId: "runtime-host",
        lease: null,
        summary: "Host next entry.",
        metadata: {},
      });
      await appendDispatcherRunJournalEntryToDisk(root, hostNext.entry);
      expect(
        (await readDispatcherRunJournal(root)).map((entry) => entry.sequence),
      ).toEqual([1, 2]);
    } finally {
      await ownership.release();
      await rm(root, { recursive: true, force: true });
    }
  });

  it("journals a CLI advisory, grades it via the session agent, and surfaces a cli-session decided row", async () => {
    const root = await mkdtemp(join(tmpdir(), "cli-advisory-e2e-"));
    try {
      // 1) symphony-manager-plan journals the emitted advisory as cli-session
      //    evidence into the dispatcher run journal.
      const plan = captureIo();
      const planCode = await runManagerPlanCli(
        [
          "--team",
          "MOB",
          "--state",
          "Backlog",
          "--journal",
          "--journal-root",
          root,
          "--json",
        ],
        {
          io: plan.io,
          env: {},
          loadCandidates: async () => [
            issue("u1", "MOB-1"),
            issue("u2", "MOB-2"),
          ],
          createPlannerRunner: () => async (): Promise<PlannerRunResult> => ({
            status: "ok",
            markdown: ADVISORY_ARTIFACT,
          }),
        },
      );
      expect(planCode).toBe(0);
      const planJson = JSON.parse(plan.out());
      expect(planJson.structuralAdvisoryDisposition).toBe(
        "journaled_cli_session",
      );
      expect(planJson.structuralAdvisoryJournal).toMatchObject({
        source: "cli-session",
        journaledCount: 1,
      });

      const afterEmission = await readCalibrationJournal(root);
      const emission = afterEmission.find(
        (entry) => entry.kind === "structural_advisory",
      );
      expect(emission?.metadata.source).toBe("cli-session");

      // 2) The interactive session agent grades the same advisory (same member
      //    set + root hypothesis reproduce the fingerprint identity).
      const grade = captureIo();
      const gradeCode = await runAdvisoryGradeCli(
        [
          "--members",
          "MOB-1,MOB-2",
          "--root",
          "Shared root",
          "--decision",
          "accept",
          "--reason",
          "same root confirmed",
          "--actor-host",
          "pro14",
          "--actor-session",
          "s1",
          "--journal-root",
          root,
        ],
        { io: grade.io },
      );
      expect(gradeCode).toBe(0);
      expect(grade.out()).toContain("cli-session evidence");

      const journal = await readCalibrationJournal(root);
      const gradeEntry = journal.find(
        (entry) => entry.kind === "structural_advisory_grade",
      );
      expect(gradeEntry?.metadata.source).toBe("cli-session");
      expect(gradeEntry?.metadata.advisory_id).toBe(
        emission?.metadata.advisory_id,
      );

      // 3) The calibration digest attributes the decided row to cli-session.
      const report = computeCalibrationReport(journal);
      const cliRows = report.structuralAdvisoryPrecisionByClass.filter(
        (row) => row.source === "cli-session",
      );
      expect(cliRows).toHaveLength(1);
      expect(cliRows[0]).toMatchObject({
        source: "cli-session",
        accepted: 1,
        precision: 1,
      });
      expect(report.orphanStructuralAdvisoryGrades).toHaveLength(0);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("idempotently skips the same CLI advisory when Manager timestamps advance", async () => {
    const root = await mkdtemp(join(tmpdir(), "cli-advisory-idempotent-"));
    let clock = new Date("2026-07-13T12:00:00.000Z");
    const run = async () => {
      const output = captureIo();
      const code = await runManagerPlanCli(
        [
          "--team",
          "MOB",
          "--state",
          "Backlog",
          "--journal",
          "--journal-root",
          root,
          "--json",
        ],
        {
          io: output.io,
          env: {},
          now: () => clock,
          loadCandidates: async () => [
            issue("u1", "MOB-1"),
            issue("u2", "MOB-2"),
          ],
          createPlannerRunner: () => async (): Promise<PlannerRunResult> => ({
            status: "ok",
            markdown: ADVISORY_ARTIFACT,
          }),
        },
      );
      expect(code).toBe(0);
      return JSON.parse(output.out());
    };
    try {
      const first = await run();
      clock = new Date("2026-07-13T12:30:00.000Z");
      const second = await run();

      expect(first.structuralAdvisoryJournal).toMatchObject({
        journaledCount: 1,
        skippedCount: 0,
      });
      expect(second.structuralAdvisoryJournal).toMatchObject({
        journaledCount: 0,
        skippedCount: 1,
      });
      expect(
        (await readCalibrationJournal(root)).filter(
          (entry) => entry.kind === "structural_advisory",
        ),
      ).toHaveLength(1);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("idempotently skips a tick-first CLI advisory after checkpoint compaction", async () => {
    const root = await mkdtemp(join(tmpdir(), "cli-advisory-compacted-idem-"));
    let clock = new Date("2026-07-13T12:00:00.000Z");
    const run = async () => {
      const output = captureIo();
      expect(
        await runManagerPlanCli(
          [
            "--team",
            "MOB",
            "--state",
            "Backlog",
            "--journal",
            "--journal-root",
            root,
            "--json",
          ],
          {
            io: output.io,
            env: {},
            now: () => clock,
            loadCandidates: async () => [
              issue("u1", "MOB-1"),
              issue("u2", "MOB-2"),
            ],
            createPlannerRunner: () => async (): Promise<PlannerRunResult> => ({
              status: "ok",
              markdown: ADVISORY_ARTIFACT,
            }),
          },
        ),
      ).toBe(0);
      return JSON.parse(output.out());
    };
    try {
      const tick = await journalCliStructuralAdvisories({
        root,
        advisories: [
          {
            memberIssueIdentifiers: ["MOB-1", "MOB-2"],
            rootCauseHypothesis: "Shared root",
            structuralFix: "Centralize the fix",
            confidenceNote: "High",
          },
        ],
        presentedIssueIdentifiers: new Set(["MOB-1", "MOB-2"]),
        source: "tick",
        now: () => new Date("2026-07-13T11:00:00.000Z"),
      });
      expect(tick.appended).toHaveLength(1);
      expect((await run()).structuralAdvisoryJournal).toMatchObject({
        journaledCount: 1,
        skippedCount: 0,
      });
      const emission = (await readDispatcherRunJournal(root)).find(
        (entry) => entry.metadata.source === "cli-session",
      );
      expect(emission).toBeDefined();
      await journalCompactionFillers(root);
      expect((await compactCalibrationJournal(root)).compacted).toBe(true);
      const before = await readDispatcherRunJournal(root);
      expect(before).not.toContainEqual(emission);

      clock = new Date("2026-07-13T12:30:00.000Z");
      expect((await run()).structuralAdvisoryJournal).toMatchObject({
        journaledCount: 0,
        skippedCount: 1,
      });
      const after = await readDispatcherRunJournal(root);
      expect(after).toEqual(before);
      const projected = buildBacklogManagerCalibrationProjection(after);
      const advisoryId = emission?.metadata.advisory_id as string;
      expect(projected.advisories[advisoryId]?.transitionOccurrenceCount).toBe(
        2,
      );
      expect(
        expandBacklogManagerCalibrationJournal(after).filter(
          (entry) =>
            entry.kind === "structural_advisory" &&
            entry.metadata.advisory_id === advisoryId,
        ),
      ).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ idempotencyKey: emission?.idempotencyKey }),
        ]),
      );
      expect(
        expandBacklogManagerCalibrationJournal(after).filter(
          (entry) =>
            entry.kind === "structural_advisory" &&
            entry.metadata.advisory_id === advisoryId,
        ),
      ).toHaveLength(2);
      expect(
        computeCalibrationReport(after).structuralAdvisoryStability.filter(
          (row) => row.advisoryId === advisoryId,
        ),
      ).toHaveLength(1);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("uses the grade boundary instead of emission activity for suppression and revival", async () => {
    const root = await mkdtemp(join(tmpdir(), "cli-advisory-rejection-"));
    const activity = new Map<string, string | null>([
      ["MOB-1", "2026-07-13T10:00:00.000Z"],
      ["MOB-2", "2026-07-13T10:05:00.000Z"],
    ]);
    try {
      const tick = await journalCliStructuralAdvisories({
        root,
        advisories: [
          {
            memberIssueIdentifiers: ["MOB-1", "MOB-2"],
            rootCauseHypothesis: "Shared root",
            structuralFix: "Centralize the fix",
            confidenceNote: "High",
          },
        ],
        presentedIssueIdentifiers: new Set(["MOB-1", "MOB-2"]),
        source: "tick",
        now: () => new Date("2026-07-13T09:00:00.000Z"),
      });
      expect(tick.appended[0]?.metadata.member_activity).toBeUndefined();
      const plan = captureIo();
      expect(
        await runManagerPlanCli(
          [
            "--team",
            "MOB",
            "--state",
            "Backlog",
            "--journal",
            "--journal-root",
            root,
          ],
          {
            io: plan.io,
            env: {},
            loadCandidates: async () => [
              issue("u1", "MOB-1", {
                updatedAt: activity.get("MOB-1") ?? null,
              }),
              issue("u2", "MOB-2", {
                updatedAt: activity.get("MOB-2") ?? null,
              }),
            ],
            createPlannerRunner: () => async (): Promise<PlannerRunResult> => ({
              status: "ok",
              markdown: ADVISORY_ARTIFACT,
            }),
          },
        ),
      ).toBe(0);

      const emission = (await readDispatcherRunJournal(root)).find(
        (entry) =>
          entry.kind === "structural_advisory" &&
          entry.metadata.member_activity !== undefined,
      );
      const advisoryId = emission?.metadata.advisory_id;
      expect(typeof advisoryId).toBe("string");
      await journalCompactionFillers(root);
      const compacted = await compactCalibrationJournal(root);
      expect(compacted.compacted).toBe(true);
      expect(
        compacted.journal.find(
          (entry) =>
            entry.kind === "structural_advisory" &&
            entry.metadata.advisory_id === advisoryId,
        ),
      ).toBeUndefined();
      const projectedEmission = expandBacklogManagerCalibrationJournal(
        compacted.journal,
      ).find(
        (entry) =>
          entry.kind === "structural_advisory" &&
          entry.metadata.advisory_id === advisoryId &&
          entry.metadata.source === "cli-session",
      );
      expect(projectedEmission?.metadata.member_activity).toEqual([
        expect.objectContaining({
          identifier: "MOB-1",
          activityAt: activity.get("MOB-1"),
        }),
        expect.objectContaining({
          identifier: "MOB-2",
          activityAt: activity.get("MOB-2"),
        }),
      ]);

      // Both members advance after emission but before the reject grade. This
      // evidence must be inside the immutable grade baseline, not mistaken for
      // a later reason to revive the advisory.
      activity.set("MOB-1", "2026-07-13T11:00:00.000Z");
      activity.set("MOB-2", "2026-07-13T11:05:00.000Z");
      const gradeTime = "2026-07-13T12:00:00.000Z";

      const grade = captureIo();
      expect(
        await runAdvisoryGradeCli(
          [
            "--members",
            "MOB-1,MOB-2",
            "--root",
            "Shared root",
            "--decision",
            "reject",
            "--actor-host",
            "pro14",
            "--journal-root",
            root,
          ],
          { io: grade.io, now: () => new Date(gradeTime) },
        ),
      ).toBe(0);

      const gradedJournal = await readCalibrationJournal(root);
      const gradeEntry = gradedJournal.find(
        (entry) => entry.kind === "structural_advisory_grade",
      );
      expect(gradeEntry?.metadata.member_activity_at_grade).toBeUndefined();
      expect(gradeEntry?.metadata.activity_baseline_at_grade).toEqual({
        kind: "grade_timestamp",
        timestamp: gradeTime,
      });
      const rejections = projectStructuralAdvisoryRejections(gradedJournal);
      expect(rejections[0]?.memberActivityAtGrade).toEqual(
        Object.fromEntries([
          ["MOB-1", gradeTime],
          ["MOB-2", gradeTime],
        ]),
      );
      const lifecycle = await applyAdvisoryLifecycle({
        emitted: [
          {
            memberIssueIdentifiers: ["MOB-1", "MOB-2"],
            rootCauseHypothesis: "Shared root",
            structuralFix: "Centralize the fix",
            confidenceNote: "High",
          },
        ],
        previous: [],
        presentedIssueIdentifiers: new Set(["MOB-1", "MOB-2"]),
        config: { dormantOkTicks: 2, renderCap: 5 },
        rejectedMemberSets: rejections,
        issueActivity: activity,
      });
      expect(lifecycle.advisories).toEqual([]);
      expect(lifecycle.events).toEqual([
        expect.objectContaining({ kind: "suppressed" }),
      ]);

      const revived = await applyAdvisoryLifecycle({
        emitted: [
          {
            memberIssueIdentifiers: ["MOB-1", "MOB-2"],
            rootCauseHypothesis: "Shared root",
            structuralFix: "Centralize the fix",
            confidenceNote: "High",
          },
        ],
        previous: [],
        presentedIssueIdentifiers: new Set(["MOB-1", "MOB-2"]),
        config: { dormantOkTicks: 2, renderCap: 5 },
        rejectedMemberSets: rejections,
        issueActivity: new Map([
          ["MOB-1", "2026-07-13T13:00:00.000Z"],
          ["MOB-2", "2026-07-13T11:05:00.000Z"],
        ]),
      });
      expect(revived.advisories[0]).toMatchObject({
        previouslyRejectedWithNewEvidence: true,
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("keeps a checkpointed first actor grade immutable", async () => {
    const root = await mkdtemp(join(tmpdir(), "cli-advisory-compacted-grade-"));
    const gradeArgs = [
      "--members",
      "MOB-1,MOB-2",
      "--root",
      "Shared root",
      "--decision",
      "accept",
      "--actor-host",
      "pro14",
      "--journal-root",
      root,
    ];
    try {
      await journalCliStructuralAdvisories({
        root,
        advisories: [
          {
            memberIssueIdentifiers: ["MOB-1", "MOB-2"],
            rootCauseHypothesis: "Shared root",
            structuralFix: "Centralize the fix",
            confidenceNote: "High",
          },
        ],
        presentedIssueIdentifiers: new Set(["MOB-1", "MOB-2"]),
      });
      expect(await runAdvisoryGradeCli(gradeArgs, { io: captureIo().io })).toBe(
        0,
      );
      await journalCliStructuralAdvisories({
        root,
        advisories: [
          {
            memberIssueIdentifiers: ["MOB-3", "MOB-4"],
            rootCauseHypothesis: "Another root",
            structuralFix: "Another fix",
            confidenceNote: "High",
          },
        ],
        presentedIssueIdentifiers: new Set(["MOB-3", "MOB-4"]),
      });

      const journal = await readDispatcherRunJournal(root);
      const projection = buildBacklogManagerCalibrationProjection(journal);
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
          metadata: { backlogManagerCalibration: projection },
        },
        { tailEntryCount: 1, minEntryCount: 2 },
      );
      expect(compacted.compacted).toBe(true);
      expect(
        compacted.journal.some(
          (entry) => entry.kind === "structural_advisory_grade",
        ),
      ).toBe(false);

      const before = await readDispatcherRunJournal(root);
      const output = captureIo();
      expect(await runAdvisoryGradeCli(gradeArgs, { io: output.io })).toBe(
        ADVISORY_GRADE_EXIT.conflict,
      );
      expect(output.out()).toContain("already graded");
      const after = await readDispatcherRunJournal(root);
      expect(after).toEqual(before);
      expect(
        expandBacklogManagerCalibrationJournal(after).filter(
          (entry) => entry.kind === "structural_advisory_grade",
        ),
      ).toHaveLength(1);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
