import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import type {
  DispatcherDecisionEvent,
  DispatcherRunJournal,
} from "../../src/domain/model.js";
import {
  evaluateDispatcherDecisionQuality,
  extractDispatcherDecisionEvents,
} from "../../src/orchestrator/decision-quality.js";

const FIXTURE_DIR = join(import.meta.dirname, "../fixtures/decision-quality");

describe("dispatcher decision-quality runner", () => {
  it("scores true positives, false positives, false negatives, and routing misses from fixtures", () => {
    const events = [
      readFixture("true-positive.json"),
      readFixture("false-positive.json"),
      readFixture("false-negative.json"),
      readFixture("cost-sensitive-routing-miss.json"),
    ];

    const summary = evaluateDispatcherDecisionQuality(events);

    expect(summary).toMatchObject({
      total: 4,
      measured: 4,
      pending: 0,
      exactMatches: 1,
      corrected: 3,
      truePositive: 1,
      falsePositive: 1,
      falseNegative: 2,
      trueNegative: 0,
      unclassified: 0,
      costSensitiveRoutingMisses: 1,
    });
    expect(summary.categories.admission).toMatchObject({
      total: 3,
      truePositive: 1,
      falsePositive: 1,
      falseNegative: 1,
    });
    expect(summary.categories.model_routing).toMatchObject({
      total: 1,
      falseNegative: 1,
      costSensitiveRoutingMisses: 1,
    });
  });

  it("extracts typed dispatcher decision events from journal entries", () => {
    const event = readFixture("true-positive.json");
    const journal: DispatcherRunJournal = [
      {
        sequence: 1,
        idempotencyKey: `dispatcher_decision:${event.decisionId}`,
        timestamp: event.timestamp,
        kind: "dispatcher_decision",
        issueId: event.issueId,
        issueIdentifier: event.issueIdentifier,
        operation: event.operation,
        stage: event.stage,
        attempt: event.attempt,
        ownerId: "worker-1",
        lease: null,
        summary: "fixture decision",
        metadata: {
          status: "completed",
          decisionEvent: event,
        },
      },
    ];

    expect(extractDispatcherDecisionEvents(journal)).toEqual([event]);
  });

  it("extracts checkpointed decision events as the covered prefix and only adds later raw decisions", () => {
    const checkpointed = readFixture("true-positive.json");
    const coveredTailDuplicate = readFixture("false-positive.json");
    const afterCheckpoint = readFixture("false-negative.json");
    const journal: DispatcherRunJournal = [
      {
        sequence: 10,
        idempotencyKey: "journal_checkpoint:12",
        timestamp: "2026-06-13T00:00:12.000Z",
        kind: "journal_checkpoint",
        issueId: "__dispatcher__",
        issueIdentifier: "DISPATCHER",
        operation: "dispatcher",
        stage: null,
        attempt: null,
        ownerId: "worker-1",
        lease: null,
        summary: "checkpoint",
        metadata: {
          schema_version: 1,
          checkpoint_type: "dispatcher_run_journal",
          coveredThroughSequence: 12,
          decisionQualityEvents: [checkpointed],
        },
      },
      {
        sequence: 11,
        idempotencyKey: `dispatcher_decision:${coveredTailDuplicate.decisionId}`,
        timestamp: coveredTailDuplicate.timestamp,
        kind: "dispatcher_decision",
        issueId: coveredTailDuplicate.issueId,
        issueIdentifier: coveredTailDuplicate.issueIdentifier,
        operation: coveredTailDuplicate.operation,
        stage: coveredTailDuplicate.stage,
        attempt: coveredTailDuplicate.attempt,
        ownerId: "worker-1",
        lease: null,
        summary: "covered duplicate",
        metadata: {
          status: "completed",
          decisionEvent: coveredTailDuplicate,
        },
      },
      {
        sequence: 13,
        idempotencyKey: `dispatcher_decision:${afterCheckpoint.decisionId}`,
        timestamp: afterCheckpoint.timestamp,
        kind: "dispatcher_decision",
        issueId: afterCheckpoint.issueId,
        issueIdentifier: afterCheckpoint.issueIdentifier,
        operation: afterCheckpoint.operation,
        stage: afterCheckpoint.stage,
        attempt: afterCheckpoint.attempt,
        ownerId: "worker-1",
        lease: null,
        summary: "post-checkpoint decision",
        metadata: {
          status: "completed",
          decisionEvent: afterCheckpoint,
        },
      },
    ];

    expect(extractDispatcherDecisionEvents(journal)).toEqual([
      checkpointed,
      afterCheckpoint,
    ]);
  });
});

function readFixture(filename: string): DispatcherDecisionEvent {
  return JSON.parse(
    readFileSync(join(FIXTURE_DIR, filename), "utf8"),
  ) as DispatcherDecisionEvent;
}
