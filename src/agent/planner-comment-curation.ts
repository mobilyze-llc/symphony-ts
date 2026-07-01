import type { WorkflowOperatorAnchorsConfig } from "../config/types.js";
import {
  DEFAULT_GROUNDING_EXTRACTOR_CONFIG,
  type GroundingCommentRelevanceDecision,
  isGroundingCommentStatusUpdate,
  scoreGroundingCommentRelevance,
} from "../orchestrator/grounding-extractor.js";
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
// module is the bounded curation + measurement core: score relevance with the
// central extractor path, keep actor allow/deny as overrides, bound size, and
// quantify the added context REPORT-ONLY so the topology can be tuned from data.
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
  /** Report-only relevance score from the central grounding extractor. */
  relevanceScore: number;
  relevanceRationale: string;
}

export interface PlannerCommentCurationConfig {
  /** Max curated comments kept per issue (newest-first). */
  maxComments: number;
  /** Max characters per curated comment body (truncated with an ellipsis). */
  maxCommentChars: number;
  /** Max total curated characters per issue (oldest kept dropped until under). */
  maxTotalChars: number;
  /** Minimum central-extractor relevance score required unless allowlisted. */
  minRelevanceScore?: number;
}

export const DEFAULT_PLANNER_COMMENT_CURATION_CONFIG: PlannerCommentCurationConfig =
  {
    maxComments: 6,
    maxCommentChars: 25_000,
    maxTotalChars: 25_000,
  };

export interface PlannerCommentCurationResult {
  comments: CuratedPlannerComment[];
  /** Comments considered (input length). */
  consideredCount: number;
  /** Dropped as noise (bot / service-account / automation dump / empty). */
  droppedNoiseCount: number;
  /** Dropped because the relevance/value score was below threshold. */
  droppedLowRelevanceCount: number;
  /** Dropped to satisfy the count / total-size budget. */
  droppedForBudgetCount: number;
  /** Report-only baseline: comments the retired actor rule would have dropped. */
  baselineDroppedActorCount: number;
  /** Report-only delta: baseline-dropped actor comments now kept by relevance. */
  relevanceKeptActorDroppedCount: number;
}

export type PlannerCommentRelevanceScorer = (input: {
  comment: PlannerCommentInput;
  normalizedBody: string;
  authorClass: TicketFeatureActorClass;
  automationNoise: boolean;
}) => GroundingCommentRelevanceDecision;

/**
 * Automation / council-dump body markers. These are relevance features rather
 * than an actor-class blanket drop: agent-authored design summaries are common
 * signal in this pipeline, while status dumps remain low-value by content.
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
  return (
    AUTOMATION_NOISE_PATTERNS.some((pattern) => pattern.test(body)) ||
    isGroundingCommentStatusUpdate(body)
  );
}

function normalizeCommentBody(body: string): string {
  return body.replace(/\s+/g, " ").trim();
}

/**
 * Curate an issue's comments for the planner prompt: drop blank bodies, explicit
 * service-account deny overrides, and low-relevance automation/content; keep the
 * newest `maxComments` relevant comments, truncate each to `maxCommentChars`, and
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
    relevanceScorer?: PlannerCommentRelevanceScorer;
  } = {},
): PlannerCommentCurationResult {
  const config = options.config ?? DEFAULT_PLANNER_COMMENT_CURATION_CONFIG;
  const accountSets = normalizeOperatorConfig(options.operatorConfig);
  const relevanceThreshold =
    config.minRelevanceScore ??
    DEFAULT_GROUNDING_EXTRACTOR_CONFIG.minCommentRelevanceScore;
  const relevanceScorer = options.relevanceScorer ?? defaultRelevanceScorer;

  let droppedNoiseCount = 0;
  let droppedLowRelevanceCount = 0;
  let baselineDroppedActorCount = 0;
  let relevanceKeptActorDroppedCount = 0;
  const survivors: CuratedPlannerComment[] = [];
  for (const comment of comments) {
    const authorClass = classifyActor(comment.actor, accountSets);
    const normalizedBody = normalizeCommentBody(comment.body);
    const baselineActorDropped =
      authorClass === "bot" || authorClass === "service_account";
    if (baselineActorDropped) {
      baselineDroppedActorCount += 1;
    }
    if (normalizedBody === "" || authorClass === "service_account") {
      droppedNoiseCount += 1;
      continue;
    }
    const automationNoise = isAutomationNoise(comment.body);
    const allowOverride = authorClass === "operator";
    const relevance = allowOverride
      ? {
          score: 1,
          rationale: "operator allowlist override",
          modelRoute: scoreGroundingCommentRelevance({
            body: normalizedBody,
            automationNoise,
          }).modelRoute,
        }
      : relevanceScorer({
          comment,
          normalizedBody,
          authorClass,
          automationNoise,
        });
    if (!allowOverride && relevance.score < relevanceThreshold) {
      droppedLowRelevanceCount += 1;
      droppedNoiseCount += 1;
      continue;
    }
    if (baselineActorDropped) {
      relevanceKeptActorDroppedCount += 1;
    }
    survivors.push({
      id: comment.id,
      authorClass,
      createdAt: comment.createdAt,
      // Hard per-comment cap: the ellipsis counts toward maxCommentChars, so a
      // truncated body is exactly maxCommentChars chars, never +1 (council Track).
      body:
        normalizedBody.length > config.maxCommentChars
          ? `${normalizedBody.slice(0, Math.max(0, config.maxCommentChars - 1))}…`
          : normalizedBody,
      relevanceScore: relevance.score,
      relevanceRationale: relevance.rationale,
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
    droppedLowRelevanceCount,
    droppedForBudgetCount,
    baselineDroppedActorCount,
    relevanceKeptActorDroppedCount,
  };
}

function defaultRelevanceScorer(input: {
  normalizedBody: string;
  automationNoise: boolean;
}): GroundingCommentRelevanceDecision {
  return scoreGroundingCommentRelevance({
    body: input.normalizedBody,
    automationNoise: input.automationNoise,
  });
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
  totalDroppedLowRelevance: number;
  totalDroppedForBudget: number;
  baselineDroppedActorCount: number;
  relevanceKeptActorDroppedCount: number;
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
  let totalDroppedLowRelevance = 0;
  let totalDroppedForBudget = 0;
  let baselineDroppedActorCount = 0;
  let relevanceKeptActorDroppedCount = 0;
  let totalCuratedChars = 0;
  for (const result of input.results) {
    totalCommentsFetched += result.consideredCount;
    totalCommentsKept += result.comments.length;
    totalDroppedNoise += result.droppedNoiseCount;
    totalDroppedLowRelevance += result.droppedLowRelevanceCount;
    totalDroppedForBudget += result.droppedForBudgetCount;
    baselineDroppedActorCount += result.baselineDroppedActorCount;
    relevanceKeptActorDroppedCount += result.relevanceKeptActorDroppedCount;
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
    totalDroppedLowRelevance,
    totalDroppedForBudget,
    baselineDroppedActorCount,
    relevanceKeptActorDroppedCount,
    totalCuratedChars,
    estimatedAddedTokens: Math.ceil(totalCuratedChars / 4),
  };
}
