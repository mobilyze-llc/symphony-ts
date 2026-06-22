import type { WorkflowOperatorAnchorsConfig } from "../config/types.js";
import {
  type TicketFeatureActor,
  type TicketFeatureActorClass,
  classifyActor,
  normalizeOperatorConfig,
} from "../tracker/ticket-feature.js";

// ---------------------------------------------------------------------------
// Planner comment curation (SYMPH-874 Tier 3 / SYMPH-896)
//
// Curated issue comments are the richest same-surface signal the Manager can
// read (file/PR refs, "overlaps with X"), but they are also the noisiest tracker
// surface and the ONLY enrichment that costs an N+1 fetch over the backlog. This
// module is the deterministic (zero-LLM) curation + measurement core: drop bot /
// service-account / automation-dump noise, bound size, and quantify the added
// context REPORT-ONLY so the two-pass-vs-curated-one-pass topology can be decided
// from data (design SYMPH-795 §9 / measure-before-caps), never a guess.
// ---------------------------------------------------------------------------

/** Minimal comment shape the curator needs (decoupled from the Linear client). */
export interface PlannerCommentInput {
  id: string;
  body: string;
  createdAt: string;
  /** Comment author for noise classification; null when the payload had none. */
  actor: TicketFeatureActor | null;
}

export interface CuratedPlannerComment {
  id: string;
  authorClass: TicketFeatureActorClass;
  createdAt: string;
  /** Whitespace-normalized + length-capped comment body. */
  body: string;
}

export interface PlannerCommentCurationConfig {
  /** Max curated comments kept per issue (newest-first). */
  maxComments: number;
  /** Max characters per curated comment body (truncated with an ellipsis). */
  maxCommentChars: number;
  /** Max total curated characters per issue (oldest kept dropped until under). */
  maxTotalChars: number;
}

export const DEFAULT_PLANNER_COMMENT_CURATION_CONFIG: PlannerCommentCurationConfig =
  {
    maxComments: 6,
    maxCommentChars: 400,
    maxTotalChars: 1200,
  };

export interface PlannerCommentCurationResult {
  comments: CuratedPlannerComment[];
  /** Comments considered (input length). */
  consideredCount: number;
  /** Dropped as noise (bot / service-account / automation dump / empty). */
  droppedNoiseCount: number;
  /** Dropped to satisfy the count / total-size budget. */
  droppedForBudgetCount: number;
}

/**
 * Automation / council-dump body markers (SYMPH-896). Conservative by design —
 * the strongest noise signal is actor-based (bot / service_account); these only
 * catch automation dumps a human-looking actor can still author: council review
 * dumps, pipeline stage / human-block markers, the planner/council untrusted
 * fence token, and the control-doc surface. Tune from the measurement.
 */
const AUTOMATION_NOISE_PATTERNS: readonly RegExp[] = [
  /\[STAGE_(?:COMPLETE|FAILED)/,
  /\bBLOCKED_NEEDS_HUMAN/,
  /SYMPHONY_UNTRUSTED_[A-Z]+_/,
  /\bcrabbox-council\b/i,
  /^\s*##?\s*council\b/im,
  /^\s*🚦/m,
];

function isAutomationNoise(body: string): boolean {
  return AUTOMATION_NOISE_PATTERNS.some((pattern) => pattern.test(body));
}

function normalizeCommentBody(body: string): string {
  return body.replace(/\s+/g, " ").trim();
}

/**
 * Curate an issue's comments for the planner prompt: drop noise (bot /
 * service-account authors, automation dumps, blank bodies), keep the newest
 * `maxComments` human/operator comments, truncate each to `maxCommentChars`, and
 * enforce a per-issue `maxTotalChars` budget by dropping the oldest kept first.
 * Pure and deterministic; surviving order is newest-first by (createdAt, id).
 */
export function curatePlannerComments(
  comments: readonly PlannerCommentInput[],
  options: {
    config?: PlannerCommentCurationConfig;
    operatorConfig?: Pick<
      WorkflowOperatorAnchorsConfig,
      "operatorAllowlist" | "serviceAccounts"
    >;
  } = {},
): PlannerCommentCurationResult {
  const config = options.config ?? DEFAULT_PLANNER_COMMENT_CURATION_CONFIG;
  const accountSets = normalizeOperatorConfig(options.operatorConfig);

  let droppedNoiseCount = 0;
  const survivors: CuratedPlannerComment[] = [];
  for (const comment of comments) {
    const authorClass = classifyActor(comment.actor, accountSets);
    const normalizedBody = normalizeCommentBody(comment.body);
    if (
      authorClass === "bot" ||
      authorClass === "service_account" ||
      normalizedBody === "" ||
      isAutomationNoise(comment.body)
    ) {
      droppedNoiseCount += 1;
      continue;
    }
    survivors.push({
      id: comment.id,
      authorClass,
      createdAt: comment.createdAt,
      body:
        normalizedBody.length > config.maxCommentChars
          ? `${normalizedBody.slice(0, config.maxCommentChars)}…`
          : normalizedBody,
    });
  }

  // Newest-first, deterministic tiebreak by id (descending).
  survivors.sort((left, right) => {
    if (left.createdAt !== right.createdAt) {
      return left.createdAt < right.createdAt ? 1 : -1;
    }
    return left.id < right.id ? 1 : left.id > right.id ? -1 : 0;
  });

  let droppedForBudgetCount = 0;
  const kept = survivors.slice(0, Math.max(0, config.maxComments));
  droppedForBudgetCount += survivors.length - kept.length;

  // Enforce the per-issue total-size budget by dropping the oldest kept first.
  while (
    kept.length > 0 &&
    kept.reduce((total, comment) => total + comment.body.length, 0) >
      config.maxTotalChars
  ) {
    kept.pop();
    droppedForBudgetCount += 1;
  }

  return {
    comments: kept,
    consideredCount: comments.length,
    droppedNoiseCount,
    droppedForBudgetCount,
  };
}

/**
 * Report-only measurement of the comment enrichment (SYMPH-896): roll up the
 * per-candidate curation results into the fetch + context cost, so the recurring
 * N+1 fetch and the prompt bloat are observable BEFORE the topology is tuned.
 * `estimatedAddedTokens` uses the same chars/4 heuristic as the loop-trace
 * prompt summary.
 */
export interface PlannerCommentEnrichmentMeasurement {
  /** Backlog candidates eligible for comment enrichment this tick. */
  candidatesConsidered: number;
  /** Candidates fetched + curated successfully (bounded by the per-tick cap). */
  candidatesFetched: number;
  /** Candidates skipped because the per-tick candidate cap was reached. */
  candidatesTruncated: number;
  /**
   * Candidates whose comment fetch threw and was swallowed (best-effort). The
   * N+1 cost was still paid, so this is reported separately to keep the cost
   * surface honest: considered = fetched + failed + truncated.
   */
  candidatesFailed: number;
  totalCommentsFetched: number;
  totalCommentsKept: number;
  totalDroppedNoise: number;
  totalDroppedForBudget: number;
  totalCuratedChars: number;
  estimatedAddedTokens: number;
}

export function measurePlannerCommentEnrichment(input: {
  candidatesConsidered: number;
  candidatesTruncated: number;
  candidatesFailed: number;
  results: readonly PlannerCommentCurationResult[];
}): PlannerCommentEnrichmentMeasurement {
  let totalCommentsFetched = 0;
  let totalCommentsKept = 0;
  let totalDroppedNoise = 0;
  let totalDroppedForBudget = 0;
  let totalCuratedChars = 0;
  for (const result of input.results) {
    totalCommentsFetched += result.consideredCount;
    totalCommentsKept += result.comments.length;
    totalDroppedNoise += result.droppedNoiseCount;
    totalDroppedForBudget += result.droppedForBudgetCount;
    totalCuratedChars += result.comments.reduce(
      (total, comment) => total + comment.body.length,
      0,
    );
  }
  return {
    candidatesConsidered: input.candidatesConsidered,
    candidatesFetched: input.results.length,
    candidatesTruncated: input.candidatesTruncated,
    candidatesFailed: input.candidatesFailed,
    totalCommentsFetched,
    totalCommentsKept,
    totalDroppedNoise,
    totalDroppedForBudget,
    totalCuratedChars,
    estimatedAddedTokens: Math.ceil(totalCuratedChars / 4),
  };
}
