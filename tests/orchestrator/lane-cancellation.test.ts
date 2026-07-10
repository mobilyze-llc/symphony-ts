import { describe, expect, it } from "vitest";

import type { StopRequest } from "../../src/orchestrator/core.js";
import { normalizeAndAggregateLaneCancellations } from "../../src/orchestrator/lane-cancellation.js";
import { isEmergencyStopTerminationConfirmed } from "../../src/orchestrator/stop-signal-delivery.js";
import type { CrabrunnerCancellationRequest } from "../../src/stage-execution/crabrunner-backend.js";

describe("lane cancellation aggregation", () => {
  it("keeps a two-lane emergency stop unconfirmed when one lane fails", async () => {
    const cancelCalls: string[] = [];
    const request = {
      issueId: "issue-1",
      issueIdentifier: "ISSUE-1",
      cleanupWorkspace: false,
      reason: "emergency_stop",
    } satisfies StopRequest;
    const cancellationRequest = {
      reason: "operator_stop",
      signal: "SIGTERM",
      processGroup: true,
      killGraceMs: 1_000,
    } satisfies CrabrunnerCancellationRequest;

    const delivery = await normalizeAndAggregateLaneCancellations({
      laneJobIds: ["lane-a", "lane-b"],
      request,
      cancellationRequest,
      attemptedAt: new Date("2026-07-10T15:10:00.000Z"),
      cancel: async (jobId) => {
        cancelCalls.push(jobId);
        if (jobId === "lane-b") {
          return {
            state: "kill_failed" as const,
            message: "lane b remained active",
            cancellation: {
              requested: true as const,
              signal: "SIGTERM" as const,
              processGroup: true as const,
              killed: false as const,
              failure: "lane b remained active" as const,
            },
          };
        }
        return {
          state: "canceled" as const,
          workspacePath: null,
          cancellation: {
            requested: true as const,
            signal: "SIGTERM" as const,
            processGroup: true as const,
            killed: true as const,
            failure: null,
          },
        };
      },
    });

    expect(cancelCalls).toEqual(["lane-a", "lane-b"]);
    expect(delivery.status).toBe("partial");
    expect(delivery.laneJobId).toBeNull();
    expect(delivery.laneCancellations).toEqual([
      expect.objectContaining({ laneJobId: "lane-a", status: "delivered" }),
      expect.objectContaining({ laneJobId: "lane-b", status: "failed" }),
    ]);
    expect(isEmergencyStopTerminationConfirmed(delivery)).toBe(false);
  });
});
