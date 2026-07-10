import type { BacklogHygieneProposal } from "./backlog-hygiene.js";

export const DEFAULT_BACKLOG_HYGIENE_CARRY_FORWARD_HEARTBEATS = 3;

export type BacklogHygieneProposalTickResult =
  | { status: "ran"; proposals: readonly BacklogHygieneProposal[] }
  | {
      status: "skipped";
      reason: "in_flight" | "heartbeat" | "unconfigured";
    }
  | { status: "unavailable" };

export interface BacklogHygieneLastSuccessfulTick {
  completedAtMs: number;
  proposals: readonly BacklogHygieneProposal[];
}

export function createBacklogHygieneProposalState(): {
  inFlight: boolean;
  lastRunAtMs: number | null;
  lastSuccessful: BacklogHygieneLastSuccessfulTick | undefined;
} {
  return { inFlight: false, lastRunAtMs: null, lastSuccessful: undefined };
}

interface BacklogHygieneCoordinatorLogger {
  info(event: string, message: string, fields: object): Promise<unknown>;
  warn(event: string, message: string, fields: object): Promise<unknown>;
}

export async function recordBacklogHygieneProposals(input: {
  proposals: readonly BacklogHygieneProposal[];
  record: (proposal: BacklogHygieneProposal) => Promise<number | null>;
  logger: BacklogHygieneCoordinatorLogger;
}): Promise<{ recordedProposalCount: number; recordFailureCount: number }> {
  let recordedProposalCount = 0;
  let recordFailureCount = 0;
  for (const proposal of input.proposals) {
    try {
      const sequence = await input.record(proposal);
      if (sequence !== null) {
        recordedProposalCount += 1;
        continue;
      }
      recordFailureCount += 1;
      await logProposalRecordFailure(
        input.logger,
        proposal,
        "record returned no journal sequence",
      );
    } catch (error) {
      recordFailureCount += 1;
      await logProposalRecordFailure(
        input.logger,
        proposal,
        error instanceof Error && error.message.trim().length > 0
          ? error.message
          : "worker failed",
      );
    }
  }
  return { recordedProposalCount, recordFailureCount };
}

function logProposalRecordFailure(
  logger: BacklogHygieneCoordinatorLogger,
  proposal: BacklogHygieneProposal,
  detail: string,
): Promise<unknown> {
  return logger.warn(
    "backlog_hygiene_proposal_record_failed",
    "Failed to record backlog hygiene proposal (report-only; dispatch unaffected).",
    {
      outcome: "degraded",
      proposal_id: proposal.proposalId,
      issue_identifiers: proposal.issueIdentifiers,
      detail,
    },
  );
}

/**
 * Coordinate audit dispositions with the shadow planner. A skipped or failed
 * audit never looks like a clean backlog: use a bounded prior result or fail
 * closed for that shadow tick.
 */
export async function coordinateBacklogHygieneShadowTick(input: {
  tick: BacklogHygieneProposalTickResult;
  lastSuccessful: BacklogHygieneLastSuccessfulTick | undefined;
  heartbeatMs: number;
  maxCarryForwardHeartbeats: number;
  nowMs: number;
  logger: BacklogHygieneCoordinatorLogger;
  runShadow: (proposals: readonly BacklogHygieneProposal[]) => void;
}): Promise<void> {
  if (input.tick.status === "ran") {
    input.runShadow(input.tick.proposals);
    return;
  }
  if (input.tick.status === "skipped" && input.tick.reason === "unconfigured") {
    input.runShadow([]);
    return;
  }

  const carried = input.lastSuccessful;
  const ageMs =
    carried === undefined
      ? Number.POSITIVE_INFINITY
      : input.nowMs - carried.completedAtMs;
  const maxAgeMs = input.heartbeatMs * input.maxCarryForwardHeartbeats;
  if (carried !== undefined && ageMs <= maxAgeMs) {
    const fields = {
      outcome:
        input.tick.status === "unavailable"
          ? "degraded_carried_forward"
          : "carried_forward",
      status: input.tick.status,
      reason:
        input.tick.status === "unavailable" ? "unavailable" : input.tick.reason,
      proposal_count: carried.proposals.length,
      disposition_age_ms: ageMs,
    };
    const message =
      input.tick.status === "unavailable"
        ? "Backlog hygiene tick was unavailable; carrying the last successful dispositions."
        : "Backlog hygiene tick was skipped; carrying the last successful dispositions.";
    await input.logger[input.tick.status === "unavailable" ? "warn" : "info"](
      "backlog_hygiene_tick_skipped",
      message,
      fields,
    );
    input.runShadow(carried.proposals);
    return;
  }
  if (carried !== undefined) {
    await input.logger.warn(
      "backlog_hygiene_dispositions_expired",
      "Skipped shadow planning because carried hygiene dispositions exceeded their age bound.",
      {
        outcome: "degraded",
        status: input.tick.status,
        reason: "carry_forward_expired",
        disposition_age_ms: ageMs,
        max_age_ms: maxAgeMs,
      },
    );
  } else if (input.tick.status === "skipped") {
    await input.logger.info(
      "backlog_hygiene_tick_skipped",
      "Skipped shadow planning because no successful hygiene dispositions are available.",
      {
        outcome: "skipped",
        status: "skipped",
        reason: input.tick.reason,
        disposition_age_ms: null,
      },
    );
  } else {
    await input.logger.warn(
      "backlog_hygiene_tick_skipped",
      "Skipped shadow planning because the hygiene tick was unavailable and no successful dispositions are available to carry forward.",
      {
        outcome: "degraded",
        status: "unavailable",
        reason: "no_successful_dispositions",
        disposition_age_ms: null,
      },
    );
  }
}
