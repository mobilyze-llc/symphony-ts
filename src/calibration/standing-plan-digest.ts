import type {
  PlanBatchMode,
  PlanDecisionKind,
  StandingPlanJournal,
} from "../domain/standing-plan.js";

// ---------------------------------------------------------------------------
// Standing-plan calibration telemetry (SYMPH-792)
//
// Joins (recommendation → operator decision → batch outcome) over the
// standing-plan journal, mirroring the SYMPH-411 verdict↔outcome digest. This
// is the substrate that lets us raise autonomy LATER with evidence — it informs
// operator-declared graduation only; it confers NO automated authority and does
// NO statistical gating. Pure: reads the journal, returns queryable rollups.
// ---------------------------------------------------------------------------

export type StandingPlanOutcomeLabel =
  | "merged"
  | "parked"
  | "failed"
  | "pending";

export interface StandingPlanCalibrationRow {
  planId: string;
  batchId: string;
  mode: PlanBatchMode | "unknown";
  decisionKind: PlanDecisionKind;
  decisionSequence: number;
  outcome: StandingPlanOutcomeLabel;
  outcomeSequence: number | null;
}

export interface ApproveByModeRow {
  mode: PlanBatchMode | "unknown";
  approved: number;
  merged: number;
  /** merged / approved, or null when none approved. */
  approveMergeRate: number | null;
}

export interface StandingPlanCalibrationReport {
  rows: StandingPlanCalibrationRow[];
  approveByMode: ApproveByModeRow[];
}

const KNOWN_OUTCOMES: StandingPlanOutcomeLabel[] = [
  "merged",
  "parked",
  "failed",
];

export function computeStandingPlanCalibration(
  journal: StandingPlanJournal,
): StandingPlanCalibrationReport {
  const sorted = [...journal].sort((a, b) => a.sequence - b.sequence);

  // Batch mode is the mode of the batch in the most recent revision naming it.
  const modeByBatch = new Map<string, PlanBatchMode>();
  for (const entry of sorted) {
    if (entry.kind === "plan_revision") {
      for (const batch of entry.revision.batches) {
        modeByBatch.set(batch.batchId, batch.mode);
      }
    }
  }

  const rows: StandingPlanCalibrationRow[] = [];
  for (const entry of sorted) {
    if (entry.kind !== "plan_decision" || entry.decision.batchId === null) {
      continue;
    }
    const batchId = entry.decision.batchId;
    const joined = latestOutcomeAfter(sorted, batchId, entry.sequence);
    rows.push({
      planId: entry.decision.planId,
      batchId,
      mode: modeByBatch.get(batchId) ?? "unknown",
      decisionKind: entry.decision.kind,
      decisionSequence: entry.sequence,
      outcome: joined.outcome,
      outcomeSequence: joined.outcomeSequence,
    });
  }

  return { rows, approveByMode: rollupApproveByMode(rows) };
}

function latestOutcomeAfter(
  journal: StandingPlanJournal,
  batchId: string,
  afterSequence: number,
): { outcome: StandingPlanOutcomeLabel; outcomeSequence: number | null } {
  let result: {
    outcome: StandingPlanOutcomeLabel;
    outcomeSequence: number;
  } | null = null;
  for (const entry of journal) {
    if (
      entry.kind !== "plan_outcome" ||
      entry.outcome.batchId !== batchId ||
      entry.sequence <= afterSequence
    ) {
      continue;
    }
    const label = normalizeOutcome(entry.outcome.result);
    // Keep the latest by sequence (journal is sorted ascending).
    result = { outcome: label, outcomeSequence: entry.sequence };
  }
  return result ?? { outcome: "pending", outcomeSequence: null };
}

function normalizeOutcome(result: string): StandingPlanOutcomeLabel {
  const lowered = result.toLowerCase();
  return KNOWN_OUTCOMES.includes(lowered as StandingPlanOutcomeLabel)
    ? (lowered as StandingPlanOutcomeLabel)
    : "failed";
}

function rollupApproveByMode(
  rows: readonly StandingPlanCalibrationRow[],
): ApproveByModeRow[] {
  const byMode = new Map<string, { approved: number; merged: number }>();
  for (const row of rows) {
    if (row.decisionKind !== "approve") {
      continue;
    }
    const bucket = byMode.get(row.mode) ?? { approved: 0, merged: 0 };
    bucket.approved += 1;
    if (row.outcome === "merged") {
      bucket.merged += 1;
    }
    byMode.set(row.mode, bucket);
  }
  return [...byMode.entries()].map(([mode, bucket]) => ({
    mode: mode as PlanBatchMode | "unknown",
    approved: bucket.approved,
    merged: bucket.merged,
    approveMergeRate:
      bucket.approved === 0 ? null : bucket.merged / bucket.approved,
  }));
}
