import { runPlanSelfReview } from "../agent/plan-self-review.js";
import type {
  PlannerContext,
  PlannerRunResult,
} from "../agent/triage-planner.js";
import { runDeterministicPlanReviewChecks } from "../domain/plan-review-checks.js";
import type { PlanReviewFinding } from "../domain/plan-review-finding.js";
import type { PlanBody } from "./standing-plan-supersession.js";

export interface PlanPostEmitReviewDeps {
  context: PlannerContext;
  body: PlanBody;
  runClaude: (prompt: string) => Promise<PlannerRunResult>;
}

export interface PlanPostEmitReviewResult {
  findings: PlanReviewFinding[];
}

/**
 * Shared tier-1 floor: deterministic checks plus one report-only self-review
 * pass. The returned findings are recorded beside the revision; this hook never
 * mutates the emitted PlanBody.
 */
export async function runPlanPostEmitReview(
  deps: PlanPostEmitReviewDeps,
): Promise<PlanPostEmitReviewResult> {
  const deterministic = runDeterministicPlanReviewChecks({
    body: deps.body,
    candidates: deps.context.backlog,
  });
  let selfReview: PlanReviewFinding[] = [];
  try {
    selfReview = await runPlanSelfReview(deps.context, deps.body, {
      runClaude: deps.runClaude,
    });
  } catch {
    selfReview = [];
  }
  return { findings: [...deterministic, ...selfReview] };
}
