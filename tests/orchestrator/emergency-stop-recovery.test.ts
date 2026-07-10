import { describe, expect, it } from "vitest";

import type { DispatcherRunJournal } from "../../src/domain/model.js";
import { collectUnconfirmedEmergencyStopCleanupPlans } from "../../src/orchestrator/emergency-stop-recovery.js";

describe("emergency-stop recovery planning", () => {
  it("retains a cleanup plan when the completed stop explicitly lacks termination proof", () => {
    const journal = [
      {
        sequence: 1,
        idempotencyKey: "stop-1",
        timestamp: "2026-07-10T12:00:00.000Z",
        kind: "intent",
        issueId: "__pipeline__",
        issueIdentifier: "PIPELINE",
        operation: "dispatcher",
        stage: null,
        attempt: null,
        ownerId: "operator",
        lease: null,
        summary: "Emergency stop applied.",
        metadata: {
          status: "applied",
          verb: "pipeline_stop",
          interruptedIssues: [
            {
              issueId: "issue-1",
              issueIdentifier: "ISSUE-1",
              codexAppServerPid: null,
              codexAppServerIdentity: null,
              laneJobId: "lane-1",
              laneCancellationSupported: true,
            },
          ],
        },
      },
      {
        sequence: 2,
        idempotencyKey: "hard-stop-1",
        timestamp: "2026-07-10T12:00:01.000Z",
        kind: "hard_stop_trigger",
        issueId: "issue-1",
        issueIdentifier: "ISSUE-1",
        operation: "dispatcher",
        stage: "implement",
        attempt: null,
        ownerId: "operator",
        lease: null,
        summary: "Emergency stop completed.",
        metadata: {
          status: "completed",
          reason: "emergency_stop",
          sourceSequence: 1,
          emergencyStopTerminationConfirmed: false,
        },
      },
    ] as DispatcherRunJournal;

    expect(collectUnconfirmedEmergencyStopCleanupPlans(journal)).toEqual([
      expect.objectContaining({
        issueId: "issue-1",
        laneJobId: "lane-1",
        laneCancellationSupported: true,
        setBySequence: 1,
      }),
    ]);
  });
});
