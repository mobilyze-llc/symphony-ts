/**
 * Deploy drift capture (SYMPH-407 scope 3): "merged ≠ deployed" made visible
 * in the state document.
 *
 * STALENESS CONTRACT: both commits are captured ONCE, best-effort, at the
 * first snapshot after process start and never refreshed. `running_commit`
 * cannot change without a restart, so once-at-startup is exact.
 * `origin_main_commit` is read from the LOCAL origin/main ref (no network
 * call — `git rev-parse origin/main`), so it is only as fresh as the last
 * `git fetch` on the runtime checkout at process start; the deploy script
 * fetches before restarting, which is the supported refresh path. Consumers
 * must treat `captured_at` as the comparison's truth time, not "now".
 */

import { execFile as execFileCb } from "node:child_process";

export type ExecGit = (args: string[], cwd: string) => Promise<string>;

export interface DeployDriftStatus {
  /** Commit the running process was started from (git HEAD of the repo root). */
  running_commit: string | null;
  /** Local origin/main ref at capture time (no network; stale by design). */
  origin_main_commit: string | null;
  /** True when both commits resolved and differ; null when either is unknown. */
  drift: boolean | null;
  /** ISO timestamp both refs were captured (process startup, never refreshed). */
  captured_at: string;
  /** Human-readable staleness contract for one-read diagnosis. */
  note: string;
  /** Freshness of the captured refs at the time this status was projected. */
  freshness?: DeployDriftFreshness;
  /**
   * Operator-facing status after applying freshness. Raw `drift` remains the
   * compatibility field; stale aligned captures must not be rendered as fresh.
   */
  qualified_status?: DeployDriftQualifiedStatus;
}

export type DeployDriftQualifiedStatus =
  | "drift"
  | "aligned"
  | "aligned_stale"
  | "unknown"
  | "unknown_stale";

export interface DeployDriftFreshness {
  status: "fresh" | "stale" | "unknown";
  captured_age_seconds: number | null;
  threshold_seconds: number;
}

export const DEFAULT_DEPLOY_DRIFT_FRESHNESS_WINDOW_SECONDS = 10 * 60;

const STALENESS_NOTE =
  "captured once at startup; origin_main_commit is the local ref (no fetch) — redeploy/restart to refresh";

const defaultExecGit: ExecGit = (args, cwd) =>
  new Promise((resolve, reject) => {
    execFileCb(
      "git",
      args,
      { cwd, encoding: "utf-8", timeout: 5_000 },
      (error, stdout) => {
        if (error) {
          reject(error);
          return;
        }
        resolve(stdout);
      },
    );
  });

/**
 * Best-effort, never throws: a missing git binary, a non-repo root, or an
 * absent origin/main ref degrade to nulls rather than failing the snapshot.
 */
export async function captureDeployDrift(input: {
  repoRoot: string;
  execGit?: ExecGit;
  now?: () => Date;
}): Promise<DeployDriftStatus> {
  const execGit = input.execGit ?? defaultExecGit;
  const now = input.now ?? (() => new Date());

  const runningCommit = await revParse(execGit, input.repoRoot, "HEAD");
  const originMainCommit = await revParse(
    execGit,
    input.repoRoot,
    "origin/main",
  );

  return {
    running_commit: runningCommit,
    origin_main_commit: originMainCommit,
    drift:
      runningCommit !== null && originMainCommit !== null
        ? runningCommit !== originMainCommit
        : null,
    captured_at: now().toISOString(),
    note: STALENESS_NOTE,
  };
}

export function qualifyDeployDriftFreshness(
  status: DeployDriftStatus,
  input?: {
    now?: Date;
    freshnessWindowSeconds?: number;
  },
): DeployDriftStatus {
  const now = input?.now ?? new Date();
  const freshnessWindowSeconds =
    input?.freshnessWindowSeconds ??
    DEFAULT_DEPLOY_DRIFT_FRESHNESS_WINDOW_SECONDS;
  const capturedAtMs = Date.parse(status.captured_at);
  const capturedAgeSeconds = Number.isFinite(capturedAtMs)
    ? Math.max(0, Math.floor((now.getTime() - capturedAtMs) / 1000))
    : null;
  const freshnessStatus =
    capturedAgeSeconds === null
      ? "unknown"
      : capturedAgeSeconds > freshnessWindowSeconds
        ? "stale"
        : "fresh";
  const qualifiedStatus = qualifyRawDrift(status.drift, freshnessStatus);

  return {
    ...status,
    freshness: {
      status: freshnessStatus,
      captured_age_seconds: capturedAgeSeconds,
      threshold_seconds: freshnessWindowSeconds,
    },
    qualified_status: qualifiedStatus,
  };
}

function qualifyRawDrift(
  drift: DeployDriftStatus["drift"],
  freshnessStatus: DeployDriftFreshness["status"],
): DeployDriftQualifiedStatus {
  if (drift === true) {
    return "drift";
  }
  if (drift === false) {
    return freshnessStatus === "stale" ? "aligned_stale" : "aligned";
  }
  return freshnessStatus === "stale" ? "unknown_stale" : "unknown";
}

async function revParse(
  execGit: ExecGit,
  cwd: string,
  ref: string,
): Promise<string | null> {
  try {
    const stdout = await execGit(["rev-parse", ref], cwd);
    const sha = stdout.trim();
    return /^[0-9a-f]{7,40}$/i.test(sha) ? sha : null;
  } catch {
    return null;
  }
}
