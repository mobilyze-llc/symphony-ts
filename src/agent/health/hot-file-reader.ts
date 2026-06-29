import { execFile } from "node:child_process";
import { promisify } from "node:util";

import type { GodFileConcentration, HotFileGrowth } from "../triage-planner.js";

const execFileAsync = promisify(execFile);

/** Default window bound by commit count. */
const DEFAULT_MAX_COMMITS = 500;
/** Default window bound by age in days. */
const DEFAULT_MAX_DAYS = 30;
/** Default hard subprocess timeout (ms); breach degrades to null. */
const DEFAULT_TIMEOUT_MS = 5_000;
/**
 * Bound on `git log` stdout. The numstat stream is small per commit, but a deep
 * window over a churny repo can still be large; cap it so a pathological repo
 * degrades to null instead of buffering unbounded memory.
 */
const MAX_BUFFER_BYTES = 32 * 1024 * 1024;

/**
 * God-file concentration thresholds (v1 heuristic, SYMPH-939). Tuned coarse on
 * purpose — this is a planner health *hint*, not a precise metric. Revisit once
 * we have observed distributions across real backlogs.
 */
/** At/above this share in one file → the window is dominated by a single hot file. */
const HIGH_CONCENTRATION_THRESHOLD = 0.5;
/** At/above this share → churn is notably concentrated but not extreme. */
const MEDIUM_CONCENTRATION_THRESHOLD = 0.25;

export const DEFAULT_DEFENSIVE_SHARE_TRIPWIRE_CONFIG = {
  defensiveShareThreshold: 0.26,
  hotFileChurnFractionThreshold: 0.28,
  reportOnly: true,
  reopenIssueIdentifier: "SYMPH-948",
} as const;

export interface ReadHotFileGrowthInput {
  repoPath: string;
  /** Bound the window by commit count (default 500). */
  maxCommits?: number;
  /** Bound the window by age in days (default 30). */
  maxDays?: number;
  /** Hard subprocess timeout (ms); breach → null (default 5000). */
  timeoutMs?: number;
  /**
   * Internal test seam (SYMPH-939): the subprocess runner, defaulting to the real
   * promisified execFile. Production callers MUST NOT set this. Tests inject a fake
   * to exercise the timeout/error degradation deterministically — a real 1ms timeout
   * races the git spawn and is flaky.
   */
  execFileImpl?: typeof execFileAsync;
}

export interface DefensiveShareTripwireConfig {
  /** Current defensive backlog share threshold. Initial calibration: ~26%. */
  defensiveShareThreshold: number;
  /** Existing SYMPH-939 hot-file share threshold. Initial calibration: ~28%. */
  hotFileChurnFractionThreshold: number;
  /** Calibration mode: measure and report, but do not emit a reopen action. */
  reportOnly: boolean;
  /** The deferred altitude-root issue to reopen/flag when actioning. */
  reopenIssueIdentifier: string;
}

export interface DefensiveShareTripwireInput {
  defensiveShare: number;
  hotFileGrowth: HotFileGrowth | null;
  config?: Partial<DefensiveShareTripwireConfig>;
  measuredAt?: string;
}

export interface DefensiveShareTripwireResult {
  measuredAt: string;
  defensiveShare: number;
  defensiveShareThreshold: number;
  hotFileChurnFraction: number | null;
  hotFileChurnFractionThreshold: number;
  crossed: boolean;
  reportOnly: boolean;
  action:
    | { kind: "none"; reason: "threshold_not_crossed" }
    | { kind: "report_only"; issueIdentifier: string }
    | { kind: "reopen_root_deferral"; issueIdentifier: string };
}

/**
 * Bucket a hottest-file churn share into a coarse concentration enum.
 *
 * NEVER receives or returns a file path — only the precomputed ratio (R7).
 */
function bucketConcentration(
  topFileChurnFraction: number,
): GodFileConcentration {
  if (topFileChurnFraction >= HIGH_CONCENTRATION_THRESHOLD) {
    return "high";
  }
  if (topFileChurnFraction >= MEDIUM_CONCENTRATION_THRESHOLD) {
    return "medium";
  }
  return "low";
}

/**
 * Read a coarse hot-file growth signal from a repo's recent git history.
 *
 * Runs a single bounded `git log --numstat`, aggregates added+deleted line
 * churn per file over the window, and reduces it to a ratio + bucket. The git
 * args are passed as an array to `execFile` (NEVER a shell string), confined to
 * `cwd: repoPath`, and hard-bounded by `timeout` + `maxBuffer`.
 *
 * R7 (SYMPH-939): the return value carries ONLY a number and an enum — never a
 * file path, commit hash, or any other untrusted string. The result is rendered
 * in the TRUSTED region of the planner prompt, so leaking a path here would be a
 * prompt-injection vector into an autonomous dispatcher. No file name ever
 * leaves this function, and nothing is logged.
 *
 * Degrades to `null` (never throws) on any failure: non-git directory, missing
 * git binary, non-zero exit, timeout/kill, empty output, zero commits, or zero
 * total churn (which would divide-by-zero). The entire body is wrapped so no
 * error escapes.
 */
export async function readHotFileGrowth(
  input: ReadHotFileGrowthInput,
): Promise<HotFileGrowth | null> {
  try {
    const maxCommits = input.maxCommits ?? DEFAULT_MAX_COMMITS;
    const maxDays = input.maxDays ?? DEFAULT_MAX_DAYS;
    const timeoutMs = input.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    // Resolve the subprocess runner once. Production leaves this unset, so the
    // real promisified execFile is used and behavior is byte-identical; tests
    // inject a fake to drive timeout/error degradation deterministically.
    const run = input.execFileImpl ?? execFileAsync;

    // %x00 emits a bare NUL per commit header and nothing else, so the only
    // non-empty, tab-bearing lines in stdout are numstat rows
    // (added<TAB>deleted<TAB>path). --no-renames keeps each path on one line.
    const { stdout } = await run(
      "git",
      [
        "log",
        "--numstat",
        "--no-renames",
        `--max-count=${maxCommits}`,
        `--since=${maxDays} days ago`,
        "--pretty=format:%x00",
      ],
      {
        cwd: input.repoPath,
        timeout: timeoutMs,
        maxBuffer: MAX_BUFFER_BYTES,
        windowsHide: true,
      },
    );

    // Aggregate total line churn (added + deleted) per file. We track only the
    // running total and the single largest file's churn — never the path keys
    // beyond what the Map needs internally, and none of them escape this scope.
    const churnByFile = new Map<string, number>();
    let total = 0;
    let maxChurn = 0;

    for (const rawLine of stdout.split("\n")) {
      // numstat row: added<TAB>deleted<TAB>path. Binary files render as
      // "-\t-\tpath" → treat added/deleted as 0. Anything else (the NUL
      // header lines, blanks) is skipped.
      const match = rawLine.match(/^(\d+|-)\t(\d+|-)\t(.+)$/);
      if (match === null) {
        continue;
      }
      const added = match[1] === "-" ? 0 : Number(match[1]);
      const deleted = match[2] === "-" ? 0 : Number(match[2]);
      const path = match[3];
      if (path === undefined) {
        continue;
      }
      const churn = added + deleted;
      if (churn === 0) {
        continue;
      }
      const next = (churnByFile.get(path) ?? 0) + churn;
      churnByFile.set(path, next);
      total += churn;
      if (next > maxChurn) {
        maxChurn = next;
      }
    }

    // Empty window / zero commits / all-binary or no-op churn → no signal.
    if (total === 0) {
      return null;
    }

    const topFileChurnFraction = maxChurn / total;
    return {
      topFileChurnFraction,
      godFileConcentration: bucketConcentration(topFileChurnFraction),
    };
  } catch {
    // Any failure — non-git dir, missing binary, non-zero exit, timeout/kill,
    // oversized buffer — degrades to null. Never throw, never log (R7).
    return null;
  }
}

export function evaluateDefensiveShareTripwire(
  input: DefensiveShareTripwireInput,
): DefensiveShareTripwireResult {
  const config = {
    ...DEFAULT_DEFENSIVE_SHARE_TRIPWIRE_CONFIG,
    ...input.config,
  };
  assertUnitInterval(input.defensiveShare, "defensiveShare");
  assertUnitInterval(config.defensiveShareThreshold, "defensiveShareThreshold");
  assertUnitInterval(
    config.hotFileChurnFractionThreshold,
    "hotFileChurnFractionThreshold",
  );
  const hotFileChurnFraction =
    input.hotFileGrowth?.topFileChurnFraction ?? null;
  if (hotFileChurnFraction !== null) {
    assertUnitInterval(hotFileChurnFraction, "hotFileChurnFraction");
  }
  const crossed =
    input.defensiveShare >= config.defensiveShareThreshold ||
    (hotFileChurnFraction !== null &&
      hotFileChurnFraction >= config.hotFileChurnFractionThreshold);
  return {
    measuredAt: input.measuredAt ?? new Date().toISOString(),
    defensiveShare: input.defensiveShare,
    defensiveShareThreshold: config.defensiveShareThreshold,
    hotFileChurnFraction,
    hotFileChurnFractionThreshold: config.hotFileChurnFractionThreshold,
    crossed,
    reportOnly: config.reportOnly,
    action: crossed
      ? config.reportOnly
        ? {
            kind: "report_only",
            issueIdentifier: config.reopenIssueIdentifier,
          }
        : {
            kind: "reopen_root_deferral",
            issueIdentifier: config.reopenIssueIdentifier,
          }
      : { kind: "none", reason: "threshold_not_crossed" },
  };
}

function assertUnitInterval(value: number, name: string): void {
  if (!Number.isFinite(value) || value < 0 || value > 1) {
    throw new Error(`${name} must be a finite number in [0, 1]`);
  }
}
