import {
  DEFAULT_QUEUE_TRIAGE_STRUCTURAL_ADVISORIES,
  DEFAULT_QUEUE_TRIAGE_STRUCTURAL_ADVISORY_DORMANT_OK_TICKS,
  DEFAULT_QUEUE_TRIAGE_STRUCTURAL_ADVISORY_RENDER_CAP,
} from "./defaults.js";

export function resolveStructuralAdvisoryConfig(
  queueTriage: Record<string, unknown>,
): {
  structuralAdvisories: boolean;
  structuralAdvisoryDormantOkTicks: number;
  structuralAdvisoryRenderCap: number;
} {
  return {
    structuralAdvisories:
      readBoolean(queueTriage.structural_advisories) ??
      DEFAULT_QUEUE_TRIAGE_STRUCTURAL_ADVISORIES,
    structuralAdvisoryDormantOkTicks:
      readPositiveInteger(queueTriage.structural_advisory_dormant_ok_ticks) ??
      DEFAULT_QUEUE_TRIAGE_STRUCTURAL_ADVISORY_DORMANT_OK_TICKS,
    structuralAdvisoryRenderCap:
      readPositiveInteger(queueTriage.structural_advisory_render_cap) ??
      DEFAULT_QUEUE_TRIAGE_STRUCTURAL_ADVISORY_RENDER_CAP,
  };
}

function readBoolean(value: unknown): boolean | null {
  return typeof value === "boolean" ? value : null;
}

function readPositiveInteger(value: unknown): number | null {
  return typeof value === "number" && Number.isInteger(value) && value > 0
    ? value
    : null;
}
