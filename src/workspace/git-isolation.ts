import { execFile } from "node:child_process";
import { promises as fs } from "node:fs";
import { dirname, join, resolve } from "node:path";

import { ERROR_CODES } from "../errors/codes.js";
import { WorkspacePathError } from "./path-safety.js";

const GIT_COMMAND_TIMEOUT_MS = 10_000;

/**
 * Environment variables that confine git repository discovery to the
 * workspace itself (SYMPH-373).
 *
 * Workspace directories live inside a larger checkout on some deployments.
 * When worktree setup fails and leaves a git-less directory, any `git`
 * command run from that cwd walks up the tree and operates on the enclosing
 * repository — in production this let an agent commit to the live runtime
 * repo. Setting GIT_CEILING_DIRECTORIES to the workspace parent stops the
 * upward walk cold while leaving every legitimate operation intact:
 * worktree `.git` files point directly at their gitdir, and bare clones
 * under the workspace root are discovered at their own level, never by
 * ascending past the root.
 */
export function gitIsolationEnv(
  workspacePath: string,
  baseEnv: NodeJS.ProcessEnv = process.env,
): Record<string, string> {
  const ceiling = dirname(resolve(workspacePath));
  const existing = baseEnv.GIT_CEILING_DIRECTORIES;
  return {
    GIT_CEILING_DIRECTORIES: existing ? `${existing}:${ceiling}` : ceiling,
  };
}

/**
 * Remove environment variables that point git at an explicit repository.
 *
 * GIT_CEILING_DIRECTORIES only bounds upward DISCOVERY — an inherited
 * GIT_DIR/GIT_WORK_TREE bypasses discovery entirely and would aim agent
 * and hook git commands at the operator's repo. Every workspace-scoped
 * spawn env must pass through this scrub. Mutates and returns `env`.
 */
export function scrubGitPointerEnv<T extends NodeJS.ProcessEnv>(env: T): T {
  delete env.GIT_DIR;
  delete env.GIT_WORK_TREE;
  return env;
}

export interface GitProbeResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

export type GitProbe = (
  args: string[],
  options: { cwd: string; env: NodeJS.ProcessEnv },
) => Promise<GitProbeResult>;

export type WorkspaceIsolationVerifier = (
  workspacePath: string,
) => Promise<void>;

const execFileGitProbe: GitProbe = (args, options) =>
  new Promise((resolvePromise, rejectPromise) => {
    execFile(
      "git",
      args,
      {
        cwd: options.cwd,
        env: options.env,
        timeout: GIT_COMMAND_TIMEOUT_MS,
      },
      (error, stdout, stderr) => {
        if (error && typeof error.code !== "number") {
          // Spawn-level failure (e.g. git binary missing) rather than a
          // nonzero git exit — surface it distinctly.
          rejectPromise(error);
          return;
        }
        resolvePromise({
          exitCode: error && typeof error.code === "number" ? error.code : 0,
          stdout: stdout.toString(),
          stderr: stderr.toString(),
        });
      },
    );
  });

function probeEnv(workspacePath: string): NodeJS.ProcessEnv {
  // Force on-disk discovery: an inherited GIT_DIR/GIT_WORK_TREE would make
  // the probe report the operator's repo instead of the workspace's.
  return scrubGitPointerEnv({
    ...process.env,
    ...gitIsolationEnv(workspacePath),
  });
}

async function hasGitEntryAt(workspacePath: string): Promise<boolean> {
  try {
    await fs.lstat(join(workspacePath, ".git"));
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return false;
    }
    // EACCES and friends: we cannot tell whether git metadata exists, so
    // we cannot certify isolation — fail closed with the real cause.
    throw new WorkspacePathError(
      ERROR_CODES.workspaceVerifyFailed,
      `Cannot inspect workspace git metadata at ${workspacePath}: ${String(error)}`,
      { cause: error },
    );
  }
}

function isSpawnEnoent(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as NodeJS.ErrnoException).code === "ENOENT"
  );
}

async function directoryExists(path: string): Promise<boolean> {
  try {
    return (await fs.lstat(path)).isDirectory();
  } catch {
    return false;
  }
}

async function realpathOrSelf(path: string): Promise<string> {
  try {
    return await fs.realpath(path);
  } catch {
    return resolve(path);
  }
}

/**
 * Fail-closed check that a workspace is git-isolated (SYMPH-373).
 *
 * - Workspace has a `.git` entry: `git rev-parse --show-toplevel` must
 *   succeed and resolve to the workspace itself. A stale worktree pointer or
 *   a toplevel outside the workspace fails the unit before any agent runs.
 * - Workspace has no `.git` entry: repository discovery from inside the
 *   workspace (under the isolation env this module injects) must fail. If
 *   discovery still resolves a repository, the workspace can reach an
 *   enclosing checkout and must not be handed to an agent.
 *
 * Throws WorkspacePathError(workspace_verify_failed) on violation.
 */
export async function verifyWorkspaceGitIsolation(
  workspacePath: string,
  options?: { probe?: GitProbe },
): Promise<void> {
  const probe = options?.probe ?? execFileGitProbe;
  const env = probeEnv(workspacePath);
  const hasGitEntry = await hasGitEntryAt(workspacePath);

  let result: GitProbeResult;
  try {
    result = await probe(
      hasGitEntry
        ? ["rev-parse", "--show-toplevel"]
        : ["rev-parse", "--git-dir"],
      { cwd: workspacePath, env },
    );
  } catch (error) {
    if (
      !hasGitEntry &&
      isSpawnEnoent(error) &&
      (await directoryExists(workspacePath))
    ) {
      // Spawn ENOENT with the workspace still present means the git
      // binary itself is absent: nothing an agent runs can perform git
      // discovery either, so isolation holds. (A vanished workspace also
      // spawns ENOENT — that case falls through and fails closed.)
      return;
    }
    // Any other probe failure (timeout, EACCES, vanished cwd) leaves the
    // workspace unverified — fail closed rather than assume safety.
    throw new WorkspacePathError(
      ERROR_CODES.workspaceVerifyFailed,
      `Workspace git isolation could not be verified (probe failed): ${workspacePath}`,
      { cause: error },
    );
  }

  if (hasGitEntry) {
    if (result.exitCode !== 0) {
      throw new WorkspacePathError(
        ERROR_CODES.workspaceVerifyFailed,
        `Workspace .git does not resolve to a usable repository (stale worktree pointer?): ${workspacePath} — ${result.stderr.trim()}`,
      );
    }
    const toplevel = await realpathOrSelf(result.stdout.trim());
    const workspace = await realpathOrSelf(workspacePath);
    if (toplevel !== workspace) {
      throw new WorkspacePathError(
        ERROR_CODES.workspaceVerifyFailed,
        `Workspace git toplevel escapes the workspace: ${workspacePath} resolves to ${toplevel}`,
      );
    }
    return;
  }

  if (result.exitCode === 0) {
    throw new WorkspacePathError(
      ERROR_CODES.workspaceVerifyFailed,
      `Workspace without .git resolves to an enclosing repository (gitdir: ${result.stdout.trim()}): ${workspacePath}`,
    );
  }
}
