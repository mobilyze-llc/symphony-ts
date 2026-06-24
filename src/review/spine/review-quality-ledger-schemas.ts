import { z } from "zod";

/**
 * Zod schemas for crucible's review-quality-ledger (MOB-384) `record` and
 * `summary` subcommands
 * (`review-quality-ledger.mjs record | summary`).
 *
 * SYMPH-924 consumes this ledger over the same fail-closed seam pattern Symphony
 * uses for the deterministic council spine (`crabbox-spine-client.ts`). The ledger
 * is DATA CAPTURE ONLY — it has no vote in the convergence/merge decision (the
 * crucible determinism-boundary invariant: measuring review quality must never feed
 * back into deciding convergence). These schemas pin the `schema` literal and the
 * fields Symphony reads, while tolerating additive producer fields via
 * `.passthrough()`, so a benign crucible addition is not a false drift alarm and a
 * changed `schema` id is a hard validation failure at the call site.
 */

export const RQL_RECORD_RESULT_SCHEMA =
  "crucible.review-quality-ledger.record-result.v1";
export const RQL_SUMMARY_SCHEMA = "crucible.review-quality-ledger.summary.v1";

export const recordResultSchema = z
  .object({
    schema: z.literal(RQL_RECORD_RESULT_SCHEMA),
    ledger_file: z.string(),
    ledger_source: z.string(),
    dry_run: z.boolean(),
    finding_count: z.number(),
    appended: z.number(),
    deduped: z.number(),
    classification_counts: z.record(z.string(), z.number()),
  })
  .passthrough();

const perModelSummarySchema = z
  .object({
    model: z.string(),
    raised: z.number(),
    confirmed: z.number(),
    track: z.number(),
    dismissed: z.number(),
    p1: z.number(),
    p2: z.number(),
    unique_confirmed: z.number(),
    unique_raised: z.number(),
    /** confirmed (P1|P2) / raised; null when the model raised nothing. */
    precision: z.number().nullable(),
    /** share of all corpus-wide confirmed findings this model alone caught. */
    unique_recall: z.number().nullable(),
  })
  .passthrough();

export const summaryResultSchema = z
  .object({
    schema: z.literal(RQL_SUMMARY_SCHEMA),
    generated_at: z.string(),
    totals: z
      .object({
        rows: z.number(),
        distinct_findings: z.number(),
        confirmed_findings: z.number(),
        by_classification: z.record(z.string(), z.number()),
        by_source: z.record(z.string(), z.number()),
      })
      .passthrough(),
    per_model: z.array(perModelSummarySchema),
    ledger_file: z.string().optional(),
    ledger_source: z.string().optional(),
  })
  .passthrough();

export type RqlRecordResult = z.infer<typeof recordResultSchema>;
export type RqlSummaryResult = z.infer<typeof summaryResultSchema>;
export type RqlPerModelSummary = z.infer<typeof perModelSummarySchema>;
