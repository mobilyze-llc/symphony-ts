import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import {
  computeCalibrationReport,
  renderCalibrationDigest,
} from "../../src/calibration/digest.js";
import { parseCalibrationJournal } from "../../src/calibration/journal-reader.js";
import type { DispatcherRunJournalEntry } from "../../src/domain/model.js";

const FIXTURE_DIR = join(__dirname, "..", "fixtures", "calibration");
const CALIBRATION_SRC_DIR = join(__dirname, "..", "..", "src", "calibration");

function entry(input: {
  sequence: number;
  kind: DispatcherRunJournalEntry["kind"];
  issueId?: string;
  issueIdentifier?: string;
  idempotencyKey?: string;
  stage?: string | null;
  summary?: string;
  metadata?: Record<string, unknown>;
}): DispatcherRunJournalEntry {
  return {
    sequence: input.sequence,
    idempotencyKey: input.idempotencyKey ?? `${input.kind}:${input.sequence}`,
    timestamp: `2026-06-01T00:00:${String(input.sequence).padStart(2, "0")}.000Z`,
    kind: input.kind,
    issueId: input.issueId ?? "issue-1",
    issueIdentifier: input.issueIdentifier ?? "SYMPH-1",
    operation: "dispatcher",
    stage: input.stage ?? null,
    attempt: null,
    ownerId: "owner-1",
    lease: null,
    summary: input.summary ?? `${input.kind} at seq ${input.sequence}`,
    metadata: input.metadata ?? {},
  };
}

function triageVerdict(input: {
  sequence: number;
  issueId: string;
  issueIdentifier: string;
  action: string;
  classification?: string;
  parkKind?: string;
}): DispatcherRunJournalEntry {
  return entry({
    sequence: input.sequence,
    kind: "triage_verdict",
    issueId: input.issueId,
    issueIdentifier: input.issueIdentifier,
    metadata: {
      schema_version: 1,
      status: "applied",
      action: input.action,
      classification: input.classification ?? "transient_infra",
      parkKind: input.parkKind ?? "novelty",
      parkGeneration: 1,
      actor: { kind: "watchdog-l2", host: "test", session: null },
    },
  });
}

function terminalSuccess(input: {
  sequence: number;
  issueId: string;
  issueIdentifier: string;
}): DispatcherRunJournalEntry {
  return entry({
    sequence: input.sequence,
    kind: "tracker_write",
    issueId: input.issueId,
    issueIdentifier: input.issueIdentifier,
    idempotencyKey: `tracker_write:${input.issueId}:terminal:merge:Done:completed`,
    summary: `Move ${input.issueIdentifier} to terminal state Done.`,
    metadata: { action: "update_issue_state" },
  });
}

function rePark(input: {
  sequence: number;
  issueId: string;
  issueIdentifier: string;
  signature?: string;
  summary?: string;
}): DispatcherRunJournalEntry {
  return entry({
    sequence: input.sequence,
    kind: "failure_exhausted",
    issueId: input.issueId,
    issueIdentifier: input.issueIdentifier,
    ...(input.summary === undefined ? {} : { summary: input.summary }),
    metadata: {
      status: "completed",
      reason: "retries exhausted",
      ...(input.signature === undefined
        ? {}
        : { failure_signature: input.signature, failure_class: "unknown" }),
    },
  });
}

function operatorIntent(input: {
  sequence: number;
  issueId: string;
  issueIdentifier: string;
  verb: string;
  status?: string;
}): DispatcherRunJournalEntry {
  return entry({
    sequence: input.sequence,
    kind: "intent",
    issueId: input.issueId,
    issueIdentifier: input.issueIdentifier,
    metadata: {
      schema_version: 1,
      status: input.status ?? "applied",
      verb: input.verb,
      actor: { kind: "operator", host: "test", session: null },
    },
  });
}

function dispatchVerdict(input: {
  sequence: number;
  issueId: string;
  issueIdentifier: string;
  disposition: string;
  reasonCode?: string;
}): DispatcherRunJournalEntry {
  return entry({
    sequence: input.sequence,
    kind: "dispatch_verdict",
    issueId: input.issueId,
    issueIdentifier: input.issueIdentifier,
    metadata: {
      schema_version: 1,
      disposition: input.disposition,
      reason_code: input.reasonCode ?? "no_slots",
      remedy: null,
      actor: { kind: "dispatcher", host: "test" },
      details: {},
    },
  });
}

function queueBaseline(input: {
  sequence: number;
  consideredIssueIds: string[];
  dispatchPicks: string[];
}): DispatcherRunJournalEntry {
  return entry({
    sequence: input.sequence,
    kind: "queue_baseline",
    issueId: "__dispatch__",
    issueIdentifier: "__dispatch__",
    metadata: {
      schema_version: 1,
      comparator_version: "priority-fifo-control-v0",
      considered_issue_ids: input.consideredIssueIds,
      dispatch_picks: input.dispatchPicks,
      manual_jumps_reorders: [{ sequence: 1, verb: "release" }],
      quiet_death_outcomes: [{ sequence: 2, issue_identifier: "SYMPH-101" }],
      urgent_reopen_outcomes: [],
      delivery_outcomes: [
        {
          issue_identifier: "SYMPH-100",
          spend: { total_tokens: 1234, turns: 3, stages: 1 },
        },
      ],
    },
  });
}

function hygieneProposal(input: {
  sequence: number;
  issueId: string;
  issueIdentifier: string;
  proposalId: string;
  findingType: string;
}): DispatcherRunJournalEntry {
  return entry({
    sequence: input.sequence,
    kind: "hygiene_proposal",
    issueId: input.issueId,
    issueIdentifier: input.issueIdentifier,
    metadata: {
      schema_version: 1,
      status: "proposed",
      proposal_id: input.proposalId,
      finding_type: input.findingType,
      actor: { kind: "dispatcher", host: "test" },
    },
  });
}

function hygieneProposalDecision(input: {
  sequence: number;
  issueId: string;
  issueIdentifier: string;
  proposalId: string;
  decision: "accepted" | "rejected";
}): DispatcherRunJournalEntry {
  return entry({
    sequence: input.sequence,
    kind: "hygiene_proposal_decision",
    issueId: input.issueId,
    issueIdentifier: input.issueIdentifier,
    metadata: {
      schema_version: 1,
      status: "applied",
      proposal_id: input.proposalId,
      decision: input.decision,
      mutation_authority: "calibration_label_only",
      issue_state_mutation: false,
      actor: { kind: "operator", host: "test" },
    },
  });
}

describe("calibration digest (SYMPH-411)", () => {
  it("retry_once → success plus retry_once → re-park yields 50% precision with both cursors", () => {
    const journal = [
      triageVerdict({
        sequence: 10,
        issueId: "issue-a",
        issueIdentifier: "SYMPH-100",
        action: "retry_once",
      }),
      triageVerdict({
        sequence: 11,
        issueId: "issue-b",
        issueIdentifier: "SYMPH-101",
        action: "retry_once",
      }),
      terminalSuccess({
        sequence: 20,
        issueId: "issue-a",
        issueIdentifier: "SYMPH-100",
      }),
      rePark({
        sequence: 21,
        issueId: "issue-b",
        issueIdentifier: "SYMPH-101",
      }),
    ];

    const report = computeCalibrationReport(journal);
    const row = report.triagePrecisionByAction.find(
      (candidate) => candidate.key === "retry_once",
    );
    expect(row).toBeDefined();
    expect(row?.recovered).toBe(1);
    expect(row?.reParked).toBe(1);
    expect(row?.precision).toBe(0.5);
    expect(row?.cursors).toEqual([
      { verdictSequence: 10, outcomeSequence: 20 },
      { verdictSequence: 11, outcomeSequence: 21 },
    ]);

    const digest = renderCalibrationDigest(report, {
      generatedAt: "2026-06-12T00:00:00.000Z",
      journalLabel: "synthetic",
    });
    expect(digest).toContain("50.0%");
    expect(digest).toContain("seq 10→20");
    expect(digest).toContain("seq 11→21");
  });

  it("leaves a verdict with no later terminal event unresolved (excluded from precision)", () => {
    const report = computeCalibrationReport([
      triageVerdict({
        sequence: 5,
        issueId: "issue-a",
        issueIdentifier: "SYMPH-100",
        action: "retry_once",
      }),
    ]);
    const row = report.triagePrecisionByAction.find(
      (candidate) => candidate.key === "retry_once",
    );
    expect(row?.unresolved).toBe(1);
    expect(row?.precision).toBeNull();
  });

  it("classifies a novelty park that succeeded on operator resume as a false park", () => {
    const report = computeCalibrationReport([
      triageVerdict({
        sequence: 1,
        issueId: "issue-a",
        issueIdentifier: "SYMPH-100",
        action: "park",
        parkKind: "novelty",
      }),
      operatorIntent({
        sequence: 2,
        issueId: "issue-a",
        issueIdentifier: "SYMPH-100",
        verb: "release",
      }),
      terminalSuccess({
        sequence: 3,
        issueId: "issue-a",
        issueIdentifier: "SYMPH-100",
      }),
      // Second park: never resumed by the operator → unjudged.
      triageVerdict({
        sequence: 4,
        issueId: "issue-b",
        issueIdentifier: "SYMPH-101",
        action: "park",
        parkKind: "novelty",
      }),
    ]);

    expect(report.noveltyParks).toEqual([
      {
        issueId: "issue-a",
        issueIdentifier: "SYMPH-100",
        parkSequence: 1,
        resumeSequence: 2,
        judgement: "false_park",
        outcomeSequence: 3,
      },
      {
        issueId: "issue-b",
        issueIdentifier: "SYMPH-101",
        parkSequence: 4,
        resumeSequence: null,
        judgement: "unjudged",
        outcomeSequence: null,
      },
    ]);
  });

  it("ignores non-operator and non-applied intents when judging parks", () => {
    const report = computeCalibrationReport([
      triageVerdict({
        sequence: 1,
        issueId: "issue-a",
        issueIdentifier: "SYMPH-100",
        action: "park",
        parkKind: "novelty",
      }),
      // Watchdog-issued intent must not count as an operator resume.
      entry({
        sequence: 2,
        kind: "intent",
        issueId: "issue-a",
        issueIdentifier: "SYMPH-100",
        metadata: {
          status: "applied",
          verb: "release",
          actor: { kind: "watchdog-l2", host: "test" },
        },
      }),
      // Rejected operator intent must not count either.
      operatorIntent({
        sequence: 3,
        issueId: "issue-a",
        issueIdentifier: "SYMPH-100",
        verb: "release",
        status: "rejected_stale",
      }),
    ]);
    expect(report.noveltyParks[0]?.judgement).toBe("unjudged");
  });

  it("attributes breaker-window parks and judges true saves after resume", () => {
    const report = computeCalibrationReport([
      entry({
        sequence: 1,
        kind: "breaker_transition",
        issueId: "issue-a",
        issueIdentifier: "SYMPH-100",
        stage: "implement",
        metadata: {
          transition: "opened",
          stage: "implement",
          signature: "sig-1",
        },
      }),
      rePark({
        sequence: 2,
        issueId: "issue-b",
        issueIdentifier: "SYMPH-101",
        signature: "sig-1",
      }),
      entry({
        sequence: 3,
        kind: "breaker_transition",
        issueId: "issue-a",
        issueIdentifier: "SYMPH-100",
        stage: "implement",
        metadata: {
          transition: "closed",
          stage: "implement",
          signature: "sig-1",
        },
      }),
      // Park outside the window: must not be attributed to the breaker.
      rePark({
        sequence: 4,
        issueId: "issue-c",
        issueIdentifier: "SYMPH-102",
        signature: "sig-1",
      }),
      operatorIntent({
        sequence: 5,
        issueId: "issue-b",
        issueIdentifier: "SYMPH-101",
        verb: "release",
      }),
      rePark({
        sequence: 6,
        issueId: "issue-b",
        issueIdentifier: "SYMPH-101",
        signature: "sig-1",
      }),
    ]);

    expect(report.breakerWindows).toHaveLength(1);
    const window = report.breakerWindows[0];
    expect(window?.openedSequence).toBe(1);
    expect(window?.closedSequence).toBe(3);
    expect(window?.saves).toEqual([
      {
        issueId: "issue-b",
        issueIdentifier: "SYMPH-101",
        parkSequence: 2,
        resumeSequence: 5,
        judgement: "true_park",
        outcomeSequence: 6,
      },
    ]);
  });

  it("attributes parks by failure_signature only, never by summary text, across overlapping breaker windows", () => {
    const report = computeCalibrationReport([
      entry({
        sequence: 1,
        kind: "breaker_transition",
        issueId: "issue-a",
        issueIdentifier: "SYMPH-100",
        stage: "implement",
        metadata: {
          transition: "opened",
          stage: "implement",
          signature: "sig-1",
        },
      }),
      entry({
        sequence: 2,
        kind: "breaker_transition",
        issueId: "issue-b",
        issueIdentifier: "SYMPH-101",
        stage: "review",
        metadata: { transition: "opened", stage: "review", signature: "sig-2" },
      }),
      // No failure_signature metadata, only summary text: with both windows
      // open this used to be double-counted into every window.
      rePark({
        sequence: 3,
        issueId: "issue-c",
        issueIdentifier: "SYMPH-102",
        summary:
          "Retries exhausted for SYMPH-102: circuit breaker open. Parked for operator.",
      }),
      // Signature-matched park: attributed to exactly its own window.
      rePark({
        sequence: 4,
        issueId: "issue-d",
        issueIdentifier: "SYMPH-103",
        signature: "sig-1",
      }),
    ]);

    expect(report.breakerWindows).toHaveLength(2);
    const sig1 = report.breakerWindows.find((w) => w.signature === "sig-1");
    const sig2 = report.breakerWindows.find((w) => w.signature === "sig-2");
    expect(sig1?.saves.map((s) => s.issueId)).toEqual(["issue-d"]);
    expect(sig2?.saves).toEqual([]);
  });

  it("classifies a park that re-parked after the first resume as true_park even when a later resume eventually succeeds", () => {
    // park → resume → re-park → resume → success: the metric is
    // recovered-on-FIRST-resume, so the first park is a true park, with
    // cursors at the first resume and the re-park.
    const report = computeCalibrationReport([
      triageVerdict({
        sequence: 1,
        issueId: "issue-a",
        issueIdentifier: "SYMPH-100",
        action: "park",
        parkKind: "novelty",
      }),
      operatorIntent({
        sequence: 2,
        issueId: "issue-a",
        issueIdentifier: "SYMPH-100",
        verb: "release",
      }),
      rePark({
        sequence: 3,
        issueId: "issue-a",
        issueIdentifier: "SYMPH-100",
      }),
      operatorIntent({
        sequence: 4,
        issueId: "issue-a",
        issueIdentifier: "SYMPH-100",
        verb: "release",
      }),
      terminalSuccess({
        sequence: 5,
        issueId: "issue-a",
        issueIdentifier: "SYMPH-100",
      }),
    ]);

    expect(report.noveltyParks).toEqual([
      {
        issueId: "issue-a",
        issueIdentifier: "SYMPH-100",
        parkSequence: 1,
        resumeSequence: 2,
        judgement: "true_park",
        outcomeSequence: 3,
      },
    ]);
  });

  it("escapes pipes and newlines in journal-derived strings so table column counts stay intact", () => {
    const digest = renderCalibrationDigest(
      computeCalibrationReport([
        triageVerdict({
          sequence: 1,
          issueId: "issue-a",
          issueIdentifier: "SYMPH|100\nextra",
          action: "park",
          classification: "weird|class\rification",
          parkKind: "novelty",
        }),
      ]),
      { generatedAt: "2026-06-12T00:00:00.000Z", journalLabel: "synthetic" },
    );

    expect(digest).not.toContain("SYMPH|100");
    expect(digest).toContain("weird\\|class ification");
    // Every row within a table block must have the same number of
    // (unescaped) column separators as its header.
    let blockPipeCount: number | null = null;
    for (const line of digest.split("\n")) {
      if (!line.startsWith("|")) {
        blockPipeCount = null;
        continue;
      }
      const pipes = (line.match(/(?<!\\)\|/g) ?? []).length;
      if (blockPipeCount === null) {
        blockPipeCount = pipes;
      } else {
        expect(pipes).toBe(blockPipeCount);
      }
    }
  });

  it("tallies alert volume per disposition tier against operator actions", () => {
    const report = computeCalibrationReport([
      dispatchVerdict({
        sequence: 1,
        issueId: "issue-a",
        issueIdentifier: "SYMPH-100",
        disposition: "skip",
      }),
      dispatchVerdict({
        sequence: 2,
        issueId: "issue-b",
        issueIdentifier: "SYMPH-101",
        disposition: "gate",
      }),
      dispatchVerdict({
        sequence: 3,
        issueId: "issue-c",
        issueIdentifier: "SYMPH-102",
        disposition: "gate",
      }),
      operatorIntent({
        sequence: 4,
        issueId: "issue-b",
        issueIdentifier: "SYMPH-101",
        verb: "release",
      }),
    ]);

    expect(report.alertVolume).toEqual([
      {
        disposition: "gate",
        alerting: true,
        count: 2,
        firstSequence: 2,
        lastSequence: 3,
      },
      {
        disposition: "skip",
        alerting: false,
        count: 1,
        firstSequence: 1,
        lastSequence: 1,
      },
    ]);
    expect(report.operatorActions).toEqual([
      { verb: "release", count: 1, sequences: [4] },
    ]);
  });

  it("surfaces week-zero queue baseline samples from journaled read-model rows", () => {
    const report = computeCalibrationReport([
      queueBaseline({
        sequence: 10,
        consideredIssueIds: ["issue-a", "issue-b"],
        dispatchPicks: ["issue-a"],
      }),
    ]);

    expect(report.queueBaseline).toEqual([
      {
        sequence: 10,
        comparatorVersion: "priority-fifo-control-v0",
        consideredIssueIds: ["issue-a", "issue-b"],
        dispatchPicks: ["issue-a"],
        manualJumpsReorders: [{ sequence: 1, verb: "release" }],
        quietDeathOutcomes: [{ sequence: 2, issue_identifier: "SYMPH-101" }],
        urgentReopenOutcomes: [],
        deliveryOutcomes: [
          {
            issue_identifier: "SYMPH-100",
            spend: { total_tokens: 1234, turns: 3, stages: 1 },
          },
        ],
      },
    ]);

    const digest = renderCalibrationDigest(report, {
      generatedAt: "2026-06-12T00:00:00.000Z",
      journalLabel: "synthetic",
    });
    expect(digest).toContain("## Queue baseline (week zero)");
    expect(digest).toContain(
      "| seq 10 | priority-fifo-control-v0 | 2 | 1 | 1 | 1 | 0 | 1 |",
    );
  });

  it("tallies backlog hygiene proposal precision by finding type", () => {
    const report = computeCalibrationReport([
      hygieneProposal({
        sequence: 10,
        issueId: "issue-a",
        issueIdentifier: "SYMPH-100",
        proposalId: "p-1",
        findingType: "duplicate",
      }),
      hygieneProposal({
        sequence: 11,
        issueId: "issue-b",
        issueIdentifier: "SYMPH-101",
        proposalId: "p-2",
        findingType: "duplicate",
      }),
      hygieneProposal({
        sequence: 12,
        issueId: "issue-c",
        issueIdentifier: "SYMPH-102",
        proposalId: "p-3",
        findingType: "stale",
      }),
      hygieneProposalDecision({
        sequence: 20,
        issueId: "issue-a",
        issueIdentifier: "SYMPH-100",
        proposalId: "p-1",
        decision: "accepted",
      }),
      hygieneProposalDecision({
        sequence: 21,
        issueId: "issue-b",
        issueIdentifier: "SYMPH-101",
        proposalId: "p-2",
        decision: "rejected",
      }),
    ]);

    expect(report.hygieneProposalPrecisionByFindingType).toEqual([
      {
        findingType: "duplicate",
        accepted: 1,
        rejected: 1,
        undecided: 0,
        precision: 0.5,
        cursors: [
          { proposalSequence: 10, decisionSequence: 20 },
          { proposalSequence: 11, decisionSequence: 21 },
        ],
      },
      {
        findingType: "stale",
        accepted: 0,
        rejected: 0,
        undecided: 1,
        precision: null,
        cursors: [{ proposalSequence: 12, decisionSequence: null }],
      },
    ]);

    const digest = renderCalibrationDigest(report, {
      generatedAt: "2026-06-12T00:00:00.000Z",
      journalLabel: "synthetic",
    });
    expect(digest).toContain("## Backlog hygiene proposal precision");
    expect(digest).toContain(
      "| duplicate | 1 | 1 | 0 | 50.0% | seq 10→20, seq 11→21 |",
    );
    expect(digest).toContain("| stale | 0 | 0 | 1 | n/a | seq 12→? |");
  });

  it("joins structural grades, dedupes re-emissions, counts flips, and buckets orphan grades", () => {
    const advisory = (sequence: number, from: string | null, to: string) =>
      entry({
        sequence,
        kind: "structural_advisory",
        metadata: {
          advisory_id: "fp-1",
          advisory_class: "3-5:existing-root",
          lifecycle_from: from,
          lifecycle_to: to,
        },
      });
    const report = computeCalibrationReport([
      advisory(1, null, "active"),
      advisory(2, "active", "dormant"),
      advisory(3, "dormant", "active"),
      entry({
        sequence: 4,
        kind: "structural_advisory_grade",
        metadata: { advisory_id: "fp-1", decision: "partial" },
      }),
      entry({
        sequence: 5,
        kind: "structural_advisory_grade",
        metadata: { advisory_id: "orphan", decision: "reject" },
      }),
    ]);

    expect(report.structuralAdvisoryDecisions).toEqual([
      {
        advisoryId: "fp-1",
        advisoryClass: "3-5:existing-root",
        advisorySequence: 1,
        decision: "partial",
        gradeSequence: 4,
        flipCount: 2,
      },
    ]);
    expect(report.structuralAdvisoryPrecisionByClass[0]).toMatchObject({
      accepted: 0,
      partial: 1,
      rejected: 0,
      undecided: 0,
      precision: 1,
    });
    expect(report.structuralAdvisoryPrecisionByClass[0]).not.toHaveProperty(
      "flipRate",
    );
    expect(report.structuralAdvisoryStability).toEqual([
      {
        advisoryId: "fp-1",
        advisoryClass: "3-5:existing-root",
        firstSeenAt: "2026-06-01T00:00:01.000Z",
        lastSeenAt: "2026-06-01T00:00:03.000Z",
        flipCount: 2,
        decision: "partial",
        undecidedAgeMs: null,
      },
    ]);
    expect(report.orphanStructuralAdvisoryGrades).toEqual([
      { advisoryId: "orphan", gradeSequence: 5, decision: "reject" },
    ]);
  });

  it("projects graded-to-active revival without counting it as an active/dormant flip", () => {
    const advisory = (sequence: number, from: string | null, to: string) =>
      entry({
        sequence,
        kind: "structural_advisory",
        metadata: {
          advisory_id: "fp-revived",
          advisory_class: "3-5:existing-root",
          lifecycle_from: from,
          lifecycle_to: to,
        },
      });
    const report = computeCalibrationReport([
      advisory(1, null, "active"),
      entry({
        sequence: 2,
        kind: "structural_advisory_grade",
        metadata: { advisory_id: "fp-revived", decision: "reject" },
      }),
      advisory(3, "graded", "active"),
    ]);

    expect(report.structuralAdvisoryDecisions).toEqual([
      {
        advisoryId: "fp-revived",
        advisoryClass: "3-5:existing-root",
        advisorySequence: 1,
        decision: "rejected",
        gradeSequence: 2,
        flipCount: 0,
      },
    ]);
    expect(report.structuralAdvisoryStability).toEqual([
      expect.objectContaining({
        advisoryId: "fp-revived",
        firstSeenAt: "2026-06-01T00:00:01.000Z",
        lastSeenAt: "2026-06-01T00:00:03.000Z",
        flipCount: 0,
        decision: "rejected",
      }),
    ]);
  });

  it("joins structural advisory grades from indexes across a large synthetic journal", () => {
    const journal: DispatcherRunJournalEntry[] = [];
    for (let index = 0; index < 1_000; index += 1) {
      const sequence = index * 3 + 1;
      journal.push(
        entry({
          sequence,
          kind: "structural_advisory",
          metadata: {
            advisory_id: `fp-${index}`,
            advisory_class:
              index % 2 === 0 ? "3-5:existing-root" : "2:new-root",
            lifecycle_from: null,
            lifecycle_to: "active",
          },
        }),
        entry({
          sequence: sequence + 1,
          kind: "structural_advisory_grade",
          metadata: {
            advisory_id: `fp-${index}`,
            decision: index % 3 === 0 ? "accept" : "reject",
          },
        }),
        entry({
          sequence: sequence + 2,
          kind: "structural_advisory_grade",
          metadata: {
            advisory_id: `orphan-${index}`,
            decision: "reject",
          },
        }),
      );
    }

    const report = computeCalibrationReport(journal);

    expect(report.structuralAdvisoryDecisions).toHaveLength(1_000);
    expect(report.orphanStructuralAdvisoryGrades).toHaveLength(1_000);
    expect(
      report.structuralAdvisoryDecisions.filter(
        (row) => row.decision === "accepted",
      ),
    ).toHaveLength(334);
    expect(
      report.structuralAdvisoryDecisions.filter(
        (row) => row.decision === "rejected",
      ),
    ).toHaveLength(666);
    expect(report.structuralAdvisoryDecisions.at(-1)).toMatchObject({
      advisoryId: "fp-999",
      gradeSequence: 2999,
    });
  });

  it("renders the synthetic journal to the expected golden digest", () => {
    const raw = readFileSync(
      join(FIXTURE_DIR, "synthetic-journal.jsonl"),
      "utf8",
    );
    const journal = parseCalibrationJournal(raw);
    const digest = renderCalibrationDigest(computeCalibrationReport(journal), {
      generatedAt: "2026-06-12T00:00:00.000Z",
      journalLabel: ".symphony/run-journals/dispatcher.jsonl (synthetic)",
    });
    const expected = readFileSync(
      join(FIXTURE_DIR, "expected-digest.md"),
      "utf8",
    );
    expect(digest.trimEnd()).toBe(expected.trimEnd());
  });

  it("states the digest is graduation evidence for SYMPH-399 in the header", () => {
    const digest = renderCalibrationDigest(computeCalibrationReport([]), {
      generatedAt: "2026-06-12T00:00:00.000Z",
      journalLabel: "empty",
    });
    expect(digest).toContain("Graduation evidence for SYMPH-399");
    expect(digest).toContain("default-disabled per product until calibrated");
  });
});

describe("calibration journal reader (SYMPH-411)", () => {
  it("skips malformed and unknown-kind lines and sorts by sequence", () => {
    const raw = [
      JSON.stringify(
        terminalSuccess({
          sequence: 2,
          issueId: "issue-a",
          issueIdentifier: "SYMPH-100",
        }),
      ),
      "not json",
      JSON.stringify({ sequence: 9, kind: "not_a_kind" }),
      JSON.stringify(
        triageVerdict({
          sequence: 1,
          issueId: "issue-a",
          issueIdentifier: "SYMPH-100",
          action: "retry_once",
        }),
      ),
    ].join("\n");
    const parsed = parseCalibrationJournal(raw);
    expect(parsed.map((e) => e.sequence)).toEqual([1, 2]);
  });

  it("skips rows missing required entry fields such as stage", () => {
    const { stage: _stage, ...withoutStage } = terminalSuccess({
      sequence: 1,
      issueId: "issue-a",
      issueIdentifier: "SYMPH-100",
    });
    expect(parseCalibrationJournal(JSON.stringify(withoutStage))).toEqual([]);
  });

  it("skips rows with a non-finite sequence", () => {
    const valid = terminalSuccess({
      sequence: 1,
      issueId: "issue-a",
      issueIdentifier: "SYMPH-100",
    });
    // 1e999 overflows JSON.parse to Infinity; JSON cannot carry NaN directly,
    // so non-finite numbers are the realistic malformed shape.
    const nonFinite = JSON.stringify(valid).replace(
      '"sequence":1',
      '"sequence":1e999',
    );
    expect(parseCalibrationJournal(nonFinite)).toEqual([]);
  });
});

describe("calibration module removability (SYMPH-411)", () => {
  it("imports nothing from the orchestrator runtime", () => {
    const files = readdirSync(CALIBRATION_SRC_DIR).filter((name) =>
      name.endsWith(".ts"),
    );
    expect(files.length).toBeGreaterThan(0);
    for (const file of files) {
      const source = readFileSync(join(CALIBRATION_SRC_DIR, file), "utf8");
      expect(
        source,
        `${file} must not import from src/orchestrator`,
      ).not.toMatch(/from\s+["'][^"']*orchestrator/);
      expect(source, `${file} must not import from src/logging`).not.toMatch(
        /from\s+["'][^"']*\/logging\//,
      );
    }
  });
});
