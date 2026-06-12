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
