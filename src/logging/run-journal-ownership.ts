import { randomUUID } from "node:crypto";
import type { Stats } from "node:fs";
import { promises as fs } from "node:fs";
import { join } from "node:path";

const JOURNAL_DIR = join(".symphony", "run-journals");
const OWNERSHIP_DIR = "dispatcher.jsonl.writer-owner";
const OWNER_FILENAME = "owner.json";
const RECOVERY_DIR = "recovery.lock";
const STALE_METADATA_MS = 30_000;

export interface DispatcherRunJournalRuntimeOwnership {
  readonly workspaceRoot: string;
  release(): Promise<void>;
}

/**
 * Claim authoritative dispatcher-journal ownership for a live runtime host.
 * The claim is intentionally longer-lived than the append lock: standalone
 * tools must not race the host's in-memory sequence allocator between flushes.
 */
export async function acquireDispatcherRunJournalRuntimeOwnership(
  workspaceRoot: string,
): Promise<DispatcherRunJournalRuntimeOwnership> {
  const ownerToken = await acquireOwnership(workspaceRoot, "runtime");
  let released = false;
  return {
    workspaceRoot,
    async release() {
      if (released) return;
      released = true;
      await releaseOwnership(ownershipPath(workspaceRoot), ownerToken);
    },
  };
}

/**
 * Run one standalone mutation only when no runtime host owns the root. This
 * gate is held across the caller's complete read/sequence/write batch; the
 * shorter append lock still serializes supported standalone writers inside it.
 */
export async function withDispatcherRunJournalStandaloneWriteAccess<T>(
  workspaceRoot: string,
  write: () => Promise<T>,
): Promise<T> {
  const ownerToken = await acquireOwnership(workspaceRoot, "standalone");
  const path = ownershipPath(workspaceRoot);
  let result: T | undefined;
  let writeError: unknown;
  try {
    result = await write();
  } catch (error) {
    writeError = error;
  }

  try {
    await releaseOwnership(path, ownerToken);
  } catch (error) {
    if (writeError === undefined) throw error;
  }
  if (writeError !== undefined) throw writeError;
  return result as T;
}

async function acquireOwnership(
  workspaceRoot: string,
  claimant: "runtime" | "standalone",
): Promise<string> {
  const artifactDir = join(workspaceRoot, JOURNAL_DIR);
  const path = ownershipPath(workspaceRoot);
  await fs.mkdir(artifactDir, { recursive: true });
  const ownerToken = randomUUID();
  while (true) {
    try {
      await fs.mkdir(path);
      await writeOwner(path, ownerToken);
      return ownerToken;
    } catch (error) {
      if (!isAlreadyExistsError(error)) throw error;
      if (await removeAbandonedOwnership(path)) continue;
      const owner = await readOwner(path);
      const ownerDetail = owner === null ? "" : ` (pid ${owner.pid})`;
      if (claimant === "standalone") {
        throw new Error(
          `Unsafe standalone dispatcher journal write rejected for ${workspaceRoot}: an active runtime host or maintenance writer owns the root${ownerDetail}. Use --no-journal for a Manager preview, or route the mutation through symphonyctl/the runtime host.`,
        );
      }
      throw new Error(
        `Cannot start runtime dispatcher journal ownership for ${workspaceRoot}: another live runtime host or maintenance writer owns the root${ownerDetail}. Stop the other writer before starting this runtime.`,
      );
    }
  }
}

function ownershipPath(workspaceRoot: string): string {
  return join(workspaceRoot, JOURNAL_DIR, OWNERSHIP_DIR);
}

async function writeOwner(path: string, ownerToken: string): Promise<void> {
  try {
    await fs.writeFile(
      join(path, OWNER_FILENAME),
      `${JSON.stringify({
        pid: process.pid,
        ownerToken,
        acquiredAt: new Date().toISOString(),
      })}\n`,
      "utf8",
    );
  } catch (error) {
    await fs.rm(path, { recursive: true, force: true });
    throw error;
  }
}

async function releaseOwnership(
  path: string,
  ownerToken: string,
): Promise<void> {
  const owner = await readOwner(path);
  if (owner?.ownerToken === ownerToken) {
    await fs.rm(path, { recursive: true, force: true });
  }
}

async function removeAbandonedOwnership(path: string): Promise<boolean> {
  const candidate = await recoveryCandidate(path);
  if (candidate === null) return false;

  const before = await fs.stat(path).catch(() => null);
  const recoveryPath = join(path, RECOVERY_DIR);
  try {
    await fs.mkdir(recoveryPath);
  } catch (error) {
    if (isMissingError(error)) return true;
    if (
      isAlreadyExistsError(error) &&
      (await removeStaleRecovery(recoveryPath))
    ) {
      return true;
    }
    return false;
  }

  let removing = false;
  try {
    const after = await fs.stat(path).catch(() => null);
    if (!sameDirectory(before, after)) return false;
    const owner = await readOwner(path);
    removing =
      owner !== null
        ? !isProcessRunning(owner.pid)
        : candidate === "stale-metadata" || isStale(before);
    if (!removing) return false;
    await fs.rm(path, { recursive: true, force: true });
    return true;
  } finally {
    if (!removing) {
      await fs.rm(recoveryPath, { recursive: true, force: true });
    }
  }
}

async function removeStaleRecovery(path: string): Promise<boolean> {
  const stats = await fs.stat(path).catch(() => null);
  if (!isStale(stats)) return false;
  await fs.rm(path, { recursive: true, force: true });
  return true;
}

async function recoveryCandidate(
  path: string,
): Promise<"dead-owner" | "stale-metadata" | null> {
  const owner = await readOwner(path);
  if (owner !== null) {
    return isProcessRunning(owner.pid) ? null : "dead-owner";
  }
  return isStale(await fs.stat(path).catch(() => null))
    ? "stale-metadata"
    : null;
}

async function readOwner(
  path: string,
): Promise<{ pid: number; ownerToken?: string } | null> {
  try {
    const parsed = JSON.parse(
      await fs.readFile(join(path, OWNER_FILENAME), "utf8"),
    ) as unknown;
    if (
      typeof parsed === "object" &&
      parsed !== null &&
      !Array.isArray(parsed) &&
      "pid" in parsed &&
      typeof parsed.pid === "number" &&
      Number.isInteger(parsed.pid) &&
      parsed.pid > 0
    ) {
      return "ownerToken" in parsed && typeof parsed.ownerToken === "string"
        ? { pid: parsed.pid, ownerToken: parsed.ownerToken }
        : { pid: parsed.pid };
    }
    return null;
  } catch (error) {
    if (isMissingError(error) || error instanceof SyntaxError) return null;
    throw error;
  }
}

function isStale(stats: Stats | null): boolean {
  return stats === null || Date.now() - stats.mtimeMs >= STALE_METADATA_MS;
}

function sameDirectory(left: Stats | null, right: Stats | null): boolean {
  return (
    left !== null &&
    right !== null &&
    left.dev === right.dev &&
    left.ino === right.ino
  );
}

function isProcessRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return isErrorCode(error, "EPERM");
  }
}

function isAlreadyExistsError(error: unknown): boolean {
  return isErrorCode(error, "EEXIST");
}

function isMissingError(error: unknown): boolean {
  return isErrorCode(error, "ENOENT");
}

function isErrorCode(error: unknown, code: string): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === code
  );
}
