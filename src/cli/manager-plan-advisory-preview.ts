import { renderStructuralAdvisoryDetails } from "../agent/structural-advisory-output.js";
import type { PlanBody } from "../orchestrator/standing-plan-supersession.js";

export function withoutStructuralAdvisoryPreview(body: PlanBody): PlanBody {
  const { structuralAdvisories: _previewOnly, ...persistedBody } = body;
  return persistedBody;
}

export interface ManagerPlanAdvisoryJournalSummary {
  root: string;
  source: string;
  journaledCount: number;
  skippedCount: number;
}

export function renderManagerPlanAdvisoryPreview(
  body: PlanBody,
  journal: ManagerPlanAdvisoryJournalSummary | null = null,
): string[] {
  const details = renderStructuralAdvisoryDetails(body.structuralAdvisories);
  if (details.length === 0) {
    return [];
  }
  const heading =
    journal === null
      ? "Structural advisories (preview only — not journaled by this command):"
      : `Structural advisories (journaled as ${journal.source} evidence — ${journal.journaledCount} new, ${journal.skippedCount} skipped; not a plan mutation):`;
  return ["", heading, ...details.map((line) => `  ${line}`)];
}
