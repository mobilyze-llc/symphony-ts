import type {
  HotFileGrowth,
  QueueHealth,
  TriageIntakeHealth,
} from "../agent/triage-planner.js";
import type { Issue } from "../domain/model.js";

/**
 * Recent-inflow window for Triage-intake (SYMPH-939): a Triage issue counts toward
 * `inflowRate` when its createdAt falls within this many ms before now. v1 bound - a
 * 7-day window; re-tune from observed intake once the signal is calibrated.
 */
export const TRIAGE_INFLOW_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * Residual-fingerprint title marker (SYMPH-939). The tracker stamps `[track:<fingerprint>]`
 * into the TITLE of every residual/tracked issue it auto-files (see
 * src/tracker/linear-client.ts:1163), so the residual share is the fraction of the
 * fetched population whose title contains this prefix.
 */
export const RESIDUAL_TRACK_MARKER = "[track:";

/**
 * Shape a Triage-intake reading (SYMPH-939) from the Triage-state issue population:
 * `depth` is the total count; `inflowRate` is the count created within
 * TRIAGE_INFLOW_WINDOW_MS before `nowMs`. Issue.createdAt is `string | null` - null /
 * unparseable timestamps are skipped (they never count toward inflow). A FUTURE-dated
 * timestamp (createdMs > nowMs, e.g. clock skew or non-server data) is likewise NOT
 * recent inflow: the window is constrained to the past (ageMs >= 0), so a negative age
 * cannot inflate the trusted queue-health signal. Pure: the caller owns the
 * (best-effort) fetch and degrades a throw to null.
 */
export function computeTriageIntake(
  issues: Issue[],
  nowMs: number,
): TriageIntakeHealth {
  let inflowRate = 0;
  for (const issue of issues) {
    if (issue.createdAt === null) {
      continue;
    }
    const createdMs = Date.parse(issue.createdAt);
    if (Number.isNaN(createdMs)) {
      continue;
    }
    const ageMs = nowMs - createdMs;
    if (ageMs >= 0 && ageMs <= TRIAGE_INFLOW_WINDOW_MS) {
      inflowRate += 1;
    }
  }
  return { depth: issues.length, inflowRate };
}

/**
 * Compute the residual share (SYMPH-939): the fraction of the fetched population whose
 * TITLE contains RESIDUAL_TRACK_MARKER. An empty population (0 issues) reads as `0` - a
 * valid "no residual" reading, NOT a degradation; only a fetch FAILURE (handled by the
 * caller) reads as null.
 *
 * REGRESSION GUARD (the original-defect guard): this MUST be fed from the state-aware
 * Backlog/Triage fetch (deps.fetchResidualIssues), NOT from the candidate backlog
 * (deps.fetchCandidates / context.backlog). The candidate backlog is the activeStates
 * set, which excludes Backlog/Triage and would read ~0 residual. Keeping this a pure
 * function over an explicitly-passed population is what makes the wrong source a
 * compile/test-visible choice rather than a silent miswire.
 */
export function computeResidualShare(issues: Issue[]): number {
  if (issues.length === 0) {
    return 0;
  }
  const residual = issues.filter((issue) =>
    issue.title.includes(RESIDUAL_TRACK_MARKER),
  ).length;
  return residual / issues.length;
}

/**
 * Assemble the QueueHealth bundle (SYMPH-939) from the four independently-computed parts.
 * Returns a QueueHealth ONLY when the three CORE signals - triageIntake, residualShare,
 * and hotFileGrowth - are all non-null (the plan's QueueHealth type requires them).
 * `reviewRoundDepth` is carried as-is (its `null` is a legitimate "no recent reviews"
 * reading, not a missing signal). Any core part being null -> `undefined` (health absent:
 * a tracker error degrades to no health, and the tick still completes).
 *
 * NON-FINITE DEFENSE (R7 + fire-and-forget never-throws): a `NaN`/`Infinity` in any
 * RENDERED numeric would otherwise reach the TRUSTED `## Queue health` prompt block
 * (e.g. "Residual share: NaN", an R7 leak) and would throw inside renderQueueHealthBlock's
 * `.toFixed(3)` - inside the fire-and-forget tick. Not reachable today, but any non-finite
 * core numeric degrades to health-absent (`undefined`) so it can never reach the trusted
 * block or throw the renderer.
 */
export function buildQueueHealth(parts: {
  triageIntake: TriageIntakeHealth | null;
  residualShare: number | null;
  hotFileGrowth: HotFileGrowth | null;
  reviewRoundDepth: number | null;
}): QueueHealth | undefined {
  const { triageIntake, residualShare, hotFileGrowth, reviewRoundDepth } =
    parts;
  if (
    triageIntake === null ||
    residualShare === null ||
    hotFileGrowth === null
  ) {
    return undefined;
  }
  if (
    !Number.isFinite(triageIntake.depth) ||
    !Number.isFinite(triageIntake.inflowRate) ||
    !Number.isFinite(residualShare) ||
    !Number.isFinite(hotFileGrowth.topFileChurnFraction) ||
    (reviewRoundDepth !== null && !Number.isFinite(reviewRoundDepth))
  ) {
    return undefined;
  }
  return {
    triageIntake,
    residualShare,
    hotFileGrowth,
    reviewRoundDepth,
  };
}
