import { z } from "zod";

/**
 * Zod schemas for crucible's deterministic crabbox-council "spine" subcommands
 * (`production-rollout.mjs council-triage | cross-exam-select | convergence-decision`).
 *
 * Symphony consumes these versioned JSON contracts as the single source of review
 * truth (SYMPH-908 / KTD1). The schemas pin the `schema` literal and the required
 * fields — the surface that would drift and silently break the gate — while
 * tolerating additive fields via `.passthrough()`, so a benign producer addition is
 * not a false drift alarm. A changed `schema` id or a missing required field is a
 * hard `SpineUnavailableError` at the call site.
 */

export const COUNCIL_TRIAGE_SCHEMA =
  "crucible.session-orchestrator.council-triage.v1";
export const CROSS_EXAM_SELECT_SCHEMA =
  "crucible.session-orchestrator.cross-exam-select.v1";
export const CONVERGENCE_DECISION_SCHEMA =
  "crucible.session-orchestrator.convergence-decision.v1";

const triageFindingSchema = z
  .object({
    severity: z.string(),
    location: z.string(),
    summary: z.string(),
    evidence: z.string(),
    failure: z.string(),
    test: z.string(),
    fp: z.string(),
    reviewer: z.string(),
    family: z.string().optional(),
    safety_claim: z.string().optional(),
    next_round_question: z.string().optional(),
    fixed_symptoms: z.array(z.string()).optional(),
    remaining_symptoms: z.array(z.string()).optional(),
  })
  .passthrough();

const familyTrailerFieldsSchema = {
  family: z.string().optional(),
  safety_claim: z.string().optional(),
  next_round_question: z.string().optional(),
  fixed_symptoms: z.array(z.string()).optional(),
  remaining_symptoms: z.array(z.string()).optional(),
};

export const councilTriageResultSchema = z
  .object({
    schema: z.literal(COUNCIL_TRIAGE_SCHEMA),
    lanes: z.array(
      z
        .object({
          reviewer: z.string(),
          file: z.string(),
          verdict: z.string(),
          parse_quality: z.string(),
          finding_count: z.number(),
          none: z.boolean(),
          fail_open: z.boolean(),
        })
        .passthrough(),
    ),
    summary: z
      .object({
        lanes: z.number(),
        track: z.number(),
        escalate: z.number(),
        unparseable_lanes: z.number(),
        blocked_lanes: z.number(),
        partial_lanes: z.number(),
      })
      .passthrough(),
    track: z.array(triageFindingSchema),
    escalate: z.array(triageFindingSchema),
    next_action: z.string(),
  })
  .passthrough();

export const crossExamSelectResultSchema = z
  .object({
    schema: z.literal(CROSS_EXAM_SELECT_SCHEMA),
    cross_exam_required: z.boolean(),
    reason: z.string(),
    fix_diff_changed: z.boolean(),
    fix_size_lines: z.number().nullable(),
    fix_trivial: z.boolean().nullable(),
    parseable_lanes: z.number(),
    target_count: z.number(),
    targets: z.array(
      z
        .object({
          fp: z.string(),
          severity: z.string(),
          location: z.string(),
          summary: z.string(),
          reviewers: z.array(z.string()),
          lane_count: z.number(),
          agreement: z.string(),
          ...familyTrailerFieldsSchema,
        })
        .passthrough(),
    ),
  })
  .passthrough();

export const CONVERGENCE_STATES = [
  "converged",
  "continue",
  "escalate",
] as const;

export const convergenceDecisionResultSchema = z
  .object({
    schema: z.literal(CONVERGENCE_DECISION_SCHEMA),
    input_rounds: z.number(),
    state: z.enum(CONVERGENCE_STATES),
    reason: z.string(),
    rounds: z.number(),
    fingerprints: z.array(z.string()).optional(),
    backstop: z.boolean().optional(),
  })
  .passthrough();

export type CouncilTriageResult = z.infer<typeof councilTriageResultSchema>;
export type CrossExamSelectResult = z.infer<typeof crossExamSelectResultSchema>;
export type ConvergenceDecisionResult = z.infer<
  typeof convergenceDecisionResultSchema
>;
export type ConvergenceState = (typeof CONVERGENCE_STATES)[number];
export type TriageFinding = z.infer<typeof triageFindingSchema>;
