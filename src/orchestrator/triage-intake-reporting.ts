import type { TriageIntakeHealth } from "../agent/triage-planner.js";
import type { Issue } from "../domain/model.js";
import { computeTriageIntake } from "./standing-plan-queue-health.js";

export type TriageIntakePublisher = (
  intake: TriageIntakeHealth | null,
) => void | Promise<void>;

export interface TriageIntakeReportSnapshot extends TriageIntakeHealth {
  alertThreshold: number | null;
}

export class TriageIntakeReportState {
  private snapshot: TriageIntakeReportSnapshot | null = null;
  private alertBreached = false;

  get latest(): TriageIntakeReportSnapshot | null {
    return this.snapshot;
  }

  async record(input: {
    intake: TriageIntakeHealth | null;
    thresholdRaw: string | undefined;
    warn(
      event: string,
      message: string,
      fields: Record<string, unknown>,
    ): undefined | Promise<unknown>;
  }): Promise<void> {
    if (input.intake === null) {
      this.snapshot = null;
      this.alertBreached = false;
      return;
    }
    const alertThreshold = parseOptionalPositiveIntegerEnv(input.thresholdRaw);
    this.snapshot = { ...input.intake, alertThreshold };
    const breached =
      alertThreshold !== null && input.intake.depth > alertThreshold;
    if (breached && !this.alertBreached) {
      await input.warn(
        "queue_triage_intake_threshold_breached",
        "Triage intake depth exceeded its observed-inflow-derived threshold (report-only).",
        {
          outcome: "report_only",
          depth: input.intake.depth,
          recent_inflow: input.intake.inflowRate,
          alert_threshold: alertThreshold,
          threshold_derivation: "observed_intake_passes",
        },
      );
    }
    this.alertBreached = breached;
  }
}

export async function collectTriageIntakeHealth(input: {
  fetch: (() => Promise<Issue[]>) | undefined;
  nowMs: number;
  publish: TriageIntakePublisher | undefined;
}): Promise<TriageIntakeHealth | null> {
  let intake: TriageIntakeHealth | null = null;
  try {
    const issues = (await input.fetch?.()) ?? null;
    intake = issues === null ? null : computeTriageIntake(issues, input.nowMs);
  } catch {
    intake = null;
  }
  try {
    await input.publish?.(intake);
  } catch {
    // Report-only propagation must never fail the planner tick.
  }
  return intake;
}

export function parseOptionalPositiveIntegerEnv(
  raw: string | undefined,
): number | null {
  if (raw === undefined || raw.trim() === "") return null;
  if (!/^[1-9]\d*$/.test(raw.trim())) return null;
  return Number.parseInt(raw, 10);
}
