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
}

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
