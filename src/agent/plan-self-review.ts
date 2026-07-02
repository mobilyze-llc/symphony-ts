import { z } from "zod";

import {
  PLAN_REVIEW_FINDING_SEVERITIES,
  type PlanReviewFinding,
} from "../domain/plan-review-finding.js";
import type { PlanBody } from "../orchestrator/standing-plan-supersession.js";
import type { PlannerContext, PlannerRunResult } from "./triage-planner.js";

const SELF_REVIEW_OUTPUT_SCHEMA = z.object({
  findings: z.array(
    z.object({
      title: z.string().min(1),
      planAnchor: z.string().min(1),
      severity: z.enum(PLAN_REVIEW_FINDING_SEVERITIES),
    }),
  ),
});

export interface PlanSelfReviewDeps {
  runClaude: (prompt: string) => Promise<PlannerRunResult>;
}

export async function runPlanSelfReview(
  context: PlannerContext,
  body: PlanBody,
  deps: PlanSelfReviewDeps,
): Promise<PlanReviewFinding[]> {
  if (body.batches.length === 0) {
    return [];
  }
  const run = await deps.runClaude(buildPlanSelfReviewPrompt(context, body));
  if (run.status === "unavailable") {
    return [];
  }
  return parsePlanSelfReviewFindings(run.markdown);
}

export function buildPlanSelfReviewPrompt(
  context: PlannerContext,
  body: PlanBody,
): string {
  const candidateStates = context.backlog.map((candidate) => ({
    issueIdentifier: candidate.issueIdentifier,
    state: candidate.state,
  }));
  const plan = {
    rationale: body.rationale,
    batches: body.batches.map((batch) => ({
      batchId: batch.batchId,
      mode: batch.mode,
      members: batch.members.map((member) => member.issueIdentifier),
      rationale: batch.rationale,
      canary: batch.canary,
    })),
    dependencyEdges: body.dependencyEdges,
    envelope: body.envelope,
    candidateStates,
  };
  return [
    "Review this already-produced standing plan. This is report-only: do not rewrite the plan.",
    "Return only a fenced JSON object with this exact shape:",
    '```json\n{"findings":[{"title":"short issue","planAnchor":"batch-or-issue","severity":"P2"}]}\n```',
    "Severity must be one of P1, P2, Track, Dismissed. Use an empty findings array when clean.",
    "Plan and candidate state snapshot:",
    "```json",
    JSON.stringify(plan, null, 2),
    "```",
  ].join("\n");
}

export function parsePlanSelfReviewFindings(
  markdown: string,
): PlanReviewFinding[] {
  const json = extractFencedJson(markdown) ?? markdown.trim();
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    return [];
  }
  const result = SELF_REVIEW_OUTPUT_SCHEMA.safeParse(parsed);
  return result.success ? result.data.findings : [];
}

function extractFencedJson(markdown: string): string | null {
  const match = markdown.match(/```json\s*\n([\s\S]*?)\n```/);
  return match?.[1] ?? null;
}
