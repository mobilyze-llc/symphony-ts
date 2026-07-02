import { runPlanSelfReview } from "../agent/plan-self-review.js";
import type {
  PlannerContext,
  PlannerRunResult,
} from "../agent/triage-planner.js";
import { runDeterministicPlanReviewChecks } from "../domain/plan-review-checks.js";
import type {
  PlanReviewFinding,
  PlanReviewRecord,
} from "../domain/plan-review-finding.js";
import {
  type PlanTier2ReviewDependencies,
  runPlanTier2Review,
} from "../review/plan-review.js";
import type { PlanBody } from "./standing-plan-supersession.js";

export interface PlanPostEmitReviewDeps {
  context: PlannerContext;
  body: PlanBody;
  runClaude: (prompt: string) => Promise<PlannerRunResult>;
  tier2?: {
    enabled: boolean;
    planId: string;
    artifactDir: string;
    workspace: string;
    plannerGroundingEnabled: boolean;
    lastReviewedContentHash?: string | null;
    env?: NodeJS.ProcessEnv;
    dependencies?: PlanTier2ReviewDependencies;
  };
}

export interface PlanPostEmitReviewResult {
  findings: PlanReviewFinding[];
  reviewRecords: PlanReviewRecord[];
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
  if (deps.tier2 === undefined || !deps.tier2.enabled) {
    return { findings: [...deterministic, ...selfReview], reviewRecords: [] };
  }
  const tier2 = await runPlanTier2Review(
    {
      context: deps.context,
      body: deps.body,
      planId: deps.tier2.planId,
      artifactDir: deps.tier2.artifactDir,
      workspace: deps.tier2.workspace,
      plannerGroundingEnabled: deps.tier2.plannerGroundingEnabled,
      ...(deps.tier2.lastReviewedContentHash === undefined
        ? {}
        : { lastReviewedContentHash: deps.tier2.lastReviewedContentHash }),
      ...(deps.tier2.env === undefined ? {} : { env: deps.tier2.env }),
    },
    deps.tier2.dependencies,
  );
  return {
    findings: [...deterministic, ...selfReview, ...tier2.findings],
    reviewRecords: [tier2.record],
  };
}
