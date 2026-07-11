import { renderStructuralAdvisoryDetails } from "../agent/structural-advisory-output.js";
import type { PlanBody } from "../orchestrator/standing-plan-supersession.js";

export function withoutStructuralAdvisoryPreview(body: PlanBody): PlanBody {
  const { structuralAdvisories: _previewOnly, ...persistedBody } = body;
  return persistedBody;
}

export function renderManagerPlanAdvisoryPreview(body: PlanBody): string[] {
  const details = renderStructuralAdvisoryDetails(body.structuralAdvisories);
  if (details.length === 0) {
    return [];
  }
  return [
    "",
    "Structural advisories (preview only — not journaled by this command):",
    ...details.map((line) => `  ${line}`),
  ];
}
