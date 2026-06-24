import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import { CrabboxSpineClient } from "./crabbox-spine-client.js";
import {
  type AggregatedReview,
  ReviewAggregator,
} from "./review-aggregator.js";
import { ReviewQualityLedgerClient } from "./review-quality-ledger-client.js";

/**
 * SYMPH-927 — the gate-side seam that runs the deterministic `ReviewAggregator`
 * (with the SYMPH-924 review-quality ledger + the SYMPH-925 judge-family
 * decorrelation precondition) ALONGSIDE the live headless-council-gate verdict
 * path.
 *
 * CUTOVER SHAPE (measure-before-caps): the aggregator is wired REPORT-ONLY by
 * default. Its sole side-effect is the ledger capture (data-only; a capture
 * failure is swallowed and can never alter or block the merge decision — the
 * no-vote invariant). The aggregator's own verdict (including SYMPH-926
 * `"degraded"`) is recorded for observability but does NOT override the gate's
 * existing lane-based decision UNLESS the operator explicitly opts in to make it
 * authoritative (`authoritative: true`). When authoritative, a non-pass aggregator
 * verdict (`"fail"` or `"degraded"`) escalates the gate to non-pass — never a
 * silent pass — satisfying SYMPH-927 (e) / SYMPH-926.
 *
 * SPINE-PRESENCE GATE: the capture runs only when the crucible spine entrypoint is
 * present on the host (mirrors the `existsSync` gate the live-spine conformance
 * tests use). In CI / hosts without the spine, the capture is a no-op, so the gate
 * is unchanged. The whole feature is additionally behind a flag (resolved by the
 * caller from `SYMPHONY_REVIEW_AGGREGATOR_CAPTURE`).
 */

const DEFAULT_SPINE_PATH = join(
  homedir(),
  "projects/crucible/skills/session-orchestrator/scripts/production-rollout.mjs",
);

/** One merge-authoritative reviewer lane's on-disk crucible-contract markdown. */
export interface GateReviewLaneArtifact {
  reviewer: string;
  markdown: string;
}

export interface GateAggregatorCaptureInput {
  /** The merge-authoritative reviewer lanes' artifacts (reviewer + markdown). */
  laneArtifacts: readonly GateReviewLaneArtifact[];
  /** A stable per-round diff identity (head SHA or a diff hash). */
  currentDiffHash: string;
  /**
   * The author/executor model family from EXPLICIT review provenance
   * (`inferAuthorFamilies(provenance)` / `SYMPHONY_COUNCIL_AUTHOR_FAMILY`), NEVER
   * ambient `process.env` (MOB-399/392). Used as the judge-decorrelation author
   * basis. `null` when provenance is unkeyable → the judge precondition fails
   * closed (more conservative, never less).
   */
  authorFamily: string | null;
  /** The escalate-bucket judge's own model family, when a judge is available. */
  judgeFamily?: string | null;
  /** Ledger row identity. */
  pr?: string;
  headSha?: string;
  round?: number;
  runId?: string;
  reviewTier?: string;
  /**
   * When `true`, a non-pass aggregator verdict (`"fail"`/`"degraded"`) makes the
   * gate non-pass. Default `false` (report-only) per measure-before-caps.
   */
  authoritative?: boolean;
}

export interface GateAggregatorCaptureResult {
  /** The aggregator's review (verdict + degradedLanes + findings). */
  review: AggregatedReview;
  /**
   * `true` iff `authoritative` was set AND the aggregator verdict is non-pass
   * (`"fail"` or `"degraded"`). The gate uses this to escalate to non-pass; it is
   * `false` whenever report-only, so the merge decision is unchanged.
   */
  shouldEscalateToNonPass: boolean;
}

/**
 * A capture function injectable into the gate for tests (no real spine shelling)
 * and overridable in production. Returns `null` when the capture was skipped (flag
 * off, spine absent, or no lanes), and never throws — capture failures are
 * swallowed so the merge decision is untouched.
 */
export type GateAggregatorCapture = (
  input: GateAggregatorCaptureInput,
) => Promise<GateAggregatorCaptureResult | null>;

export interface GateAggregatorCaptureConfig {
  /** Path to the crucible spine entrypoint; defaults to the canonical location. */
  spinePath?: string;
  ledgerScriptPath?: string;
  ledgerFile?: string;
  /** Threaded env (gate `input.env`), used by the clients; never ambient. */
  env?: NodeJS.ProcessEnv;
  /** Observability sink for a swallowed ledger-capture error (report-only). */
  onLedgerError?: (error: unknown) => void;
  /** Test seam: override the spine-presence check. */
  spineExists?: (path: string) => boolean;
  /** Test seam: inject a pre-built aggregator instead of a real spine client. */
  aggregator?: ReviewAggregator;
  /** Test seam: inject a pre-built ledger client instead of a real one. */
  ledgerClient?: ReviewQualityLedgerClient;
}

/**
 * Build the default, production gate-aggregator capture. It constructs a real
 * `CrabboxSpineClient` + `ReviewQualityLedgerClient` against the live spine (or
 * the injected test doubles), runs the aggregator, and records the ledger row as a
 * report-only side-effect. Always returns a function that never throws.
 */
export function createGateAggregatorCapture(
  config: GateAggregatorCaptureConfig = {},
): GateAggregatorCapture {
  const spinePath =
    config.spinePath ??
    config.env?.SYMPHONY_REVIEW_SPINE_PATH ??
    DEFAULT_SPINE_PATH;
  const spineExists = config.spineExists ?? existsSync;

  return async (input) => {
    if (input.laneArtifacts.length === 0) {
      return null;
    }
    // Spine-presence gate: skip entirely when the spine entrypoint is absent so
    // the gate is unchanged on hosts/CI without crucible.
    if (config.aggregator === undefined && !spineExists(spinePath)) {
      return null;
    }
    const aggregator =
      config.aggregator ??
      new ReviewAggregator(
        new CrabboxSpineClient({
          spinePath,
          ...(config.env === undefined ? {} : { env: config.env }),
        }),
      );
    const ledgerClient =
      config.ledgerClient ??
      new ReviewQualityLedgerClient({
        ...(config.ledgerScriptPath === undefined
          ? {}
          : { ledgerScriptPath: config.ledgerScriptPath }),
        ...(config.ledgerFile === undefined
          ? {}
          : { ledgerFile: config.ledgerFile }),
        ...(config.env === undefined ? {} : { env: config.env }),
      });

    try {
      const review = await aggregator.aggregate({
        laneArtifacts: input.laneArtifacts.map((lane) => ({
          reviewer: lane.reviewer,
          markdown: lane.markdown,
        })),
        currentDiffHash: input.currentDiffHash,
        // SYMPH-925: the judge-decorrelation author basis comes from EXPLICIT
        // provenance only (resolved by the caller), never ambient process env.
        judgeDecorrelation: {
          authorFamily: input.authorFamily,
          judgeFamily: input.judgeFamily ?? null,
        },
        // SYMPH-924: report-only ledger capture. A capture failure is swallowed
        // inside the aggregator and routed to onError; it never alters the verdict.
        ledger: {
          client: ledgerClient,
          ...(input.pr === undefined ? {} : { pr: input.pr }),
          ...(input.headSha === undefined ? {} : { headSha: input.headSha }),
          ...(input.round === undefined ? {} : { round: input.round }),
          ...(input.runId === undefined ? {} : { runId: input.runId }),
          ...(input.reviewTier === undefined
            ? {}
            : { reviewTier: input.reviewTier }),
          ...(config.onLedgerError === undefined
            ? {}
            : { onError: config.onLedgerError }),
        },
      });
      const nonPass = review.verdict !== "pass";
      return {
        review,
        shouldEscalateToNonPass: (input.authoritative ?? false) && nonPass,
      };
    } catch (error) {
      // Fail-closed-on-capture is REPORT-ONLY: a spine/aggregator failure must
      // NEVER block or alter the merge decision (no-vote invariant). Swallow it,
      // surface it for observability, and return null so the gate is unchanged.
      //
      // SYMPH-927 (council P2): the observer hook is itself untrusted — if
      // `onLedgerError` THROWS, an unguarded call here would reject the capture and
      // break the documented "never throws" contract (re-entering the gate decision
      // path). Guard it with a nested try/catch that swallows, mirroring
      // `ReviewAggregator.captureLedger()`. The observability hook can never alter
      // the verdict or make the capture throw.
      try {
        config.onLedgerError?.(error);
      } catch {
        // intentionally ignored — the observability hook cannot break the contract.
      }
      return null;
    }
  };
}
