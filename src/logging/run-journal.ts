import { randomUUID } from "node:crypto";
import type { Stats } from "node:fs";
import { promises as fs } from "node:fs";
import { join } from "node:path";

import {
  DISPATCHER_RUN_JOURNAL_EVENT_KINDS,
  type DispatcherLease,
  type DispatcherRunJournal,
  type DispatcherRunJournalEntry,
} from "../domain/model.js";

const DISPATCHER_RUN_JOURNAL_DIR = join(".symphony", "run-journals");
const DISPATCHER_RUN_JOURNAL_FILENAME = "dispatcher.jsonl";
const DISPATCHER_RUN_JOURNAL_LOCK_DIR = `${DISPATCHER_RUN_JOURNAL_FILENAME}.lock`;
const DISPATCHER_RUN_JOURNAL_LOCK_OWNER_FILENAME = "owner.json";
const DISPATCHER_RUN_JOURNAL_LOCK_RECOVERY_DIR = "recovery.lock";
const DISPATCHER_RUN_JOURNAL_LOCK_TIMEOUT_MS = 30_000;
const DISPATCHER_RUN_JOURNAL_LOCK_POLL_MS = 25;

export type DispatcherRunJournalEntryDraft = Omit<
  DispatcherRunJournalEntry,
  "sequence"
>;

export interface AppendDispatcherRunJournalEntriesResult {
  journal: DispatcherRunJournal;
  entries: DispatcherRunJournalEntry[];
  appendedEntries: DispatcherRunJournalEntry[];
  skippedEntries: DispatcherRunJournalEntry[];
}

export function getDispatcherRunJournalPath(workspaceRoot: string): string {
  return join(
    workspaceRoot,
    DISPATCHER_RUN_JOURNAL_DIR,
    DISPATCHER_RUN_JOURNAL_FILENAME,
  );
}

export function getDispatcherRunJournalLockPath(workspaceRoot: string): string {
  return join(
    workspaceRoot,
    DISPATCHER_RUN_JOURNAL_DIR,
    DISPATCHER_RUN_JOURNAL_LOCK_DIR,
  );
}

export function appendDispatcherRunJournalEntry(
  journal: DispatcherRunJournal,
  entry: DispatcherRunJournalEntryDraft,
  minSequence = 1,
): {
  journal: DispatcherRunJournal;
  entry: DispatcherRunJournalEntry;
  appended: boolean;
} {
  const existing = journal.find(
    (candidate) => candidate.idempotencyKey === entry.idempotencyKey,
  );
  if (existing !== undefined) {
    return { journal, entry: existing, appended: false };
  }

  const nextEntry: DispatcherRunJournalEntry = {
    ...entry,
    sequence: Math.max((journal.at(-1)?.sequence ?? 0) + 1, minSequence),
  };
  return {
    journal: [...journal, nextEntry],
    entry: nextEntry,
    appended: true,
  };
}

export function rebuildDispatcherLeases(
  journal: DispatcherRunJournal,
): Record<string, DispatcherLease> {
  const leases: Record<string, DispatcherLease> = {};
  for (const entry of journal) {
    if (entry.lease === null) {
      continue;
    }
    leases[entry.lease.leaseId] = {
      ...entry.lease,
      lastJournalSequence: entry.sequence,
    };
  }
  return leases;
}

export async function readDispatcherRunJournal(
  workspaceRoot: string,
): Promise<DispatcherRunJournal> {
  const artifactPath = getDispatcherRunJournalPath(workspaceRoot);
  let raw: string;
  try {
    raw = await fs.readFile(artifactPath, "utf8");
  } catch (error) {
    if (isMissingPathError(error)) {
      return [];
    }
    throw error;
  }

  const entries: DispatcherRunJournal = [];
  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (trimmed.length === 0) {
      continue;
    }
    try {
      const parsed = JSON.parse(trimmed) as unknown;
      if (isDispatcherRunJournalEntry(parsed)) {
        entries.push(parsed);
      }
    } catch {
      // Ignore malformed rows so one bad line does not block recovery.
    }
  }

  return entries.sort((left, right) => left.sequence - right.sequence);
}

export async function appendDispatcherRunJournalEntryToDisk(
  workspaceRoot: string,
  entry: DispatcherRunJournalEntry,
): Promise<void> {
  const artifactPath = getDispatcherRunJournalPath(workspaceRoot);
  await fs.mkdir(join(workspaceRoot, DISPATCHER_RUN_JOURNAL_DIR), {
    recursive: true,
  });
  await fs.appendFile(artifactPath, `${JSON.stringify(entry)}\n`, "utf8");
}

export async function appendDispatcherRunJournalEntriesWithLock(
  workspaceRoot: string,
  drafts: readonly DispatcherRunJournalEntryDraft[],
): Promise<AppendDispatcherRunJournalEntriesResult> {
  // Standalone writer boundary: hold the lock across read, sequence allocation,
  // and disk append so independent gate/operator tools cannot allocate from
  // the same stale snapshot.
  return withDispatcherRunJournalWriteLock(workspaceRoot, async () => {
    let journal = await readDispatcherRunJournal(workspaceRoot);
    const entries: DispatcherRunJournalEntry[] = [];
    const appendedEntries: DispatcherRunJournalEntry[] = [];
    const skippedEntries: DispatcherRunJournalEntry[] = [];

    for (const draft of drafts) {
      const appended = appendDispatcherRunJournalEntry(journal, draft);
      journal = appended.journal;
      entries.push(appended.entry);
      if (appended.appended) {
        appendedEntries.push(appended.entry);
        await appendDispatcherRunJournalEntryToDisk(
          workspaceRoot,
          appended.entry,
        );
      } else {
        skippedEntries.push(appended.entry);
      }
    }

    return { journal, entries, appendedEntries, skippedEntries };
  });
}

async function withDispatcherRunJournalWriteLock<T>(
  workspaceRoot: string,
  write: () => Promise<T>,
): Promise<T> {
  const artifactDir = join(workspaceRoot, DISPATCHER_RUN_JOURNAL_DIR);
  const lockPath = getDispatcherRunJournalLockPath(workspaceRoot);
  await fs.mkdir(artifactDir, { recursive: true });
  const ownerToken = await acquireDispatcherRunJournalWriteLock(lockPath);
  let result: T | undefined;
  let writeError: unknown;
  try {
    result = await write();
  } catch (error) {
    writeError = error;
  }

  try {
    await releaseDispatcherRunJournalWriteLock(lockPath, ownerToken);
  } catch (error) {
    if (writeError === undefined) {
      throw error;
    }
  }

  if (writeError !== undefined) {
    throw writeError;
  }
  return result as T;
}

async function acquireDispatcherRunJournalWriteLock(
  lockPath: string,
): Promise<string> {
  const startedAt = Date.now();
  const ownerToken = randomUUID();
  while (true) {
    try {
      await fs.mkdir(lockPath);
      await writeDispatcherRunJournalLockOwner(lockPath, ownerToken);
      return ownerToken;
    } catch (error) {
      if (!isAlreadyExistsPathError(error)) {
        throw error;
      }
      if (await removeAbandonedDispatcherRunJournalWriteLock(lockPath)) {
        continue;
      }
      if (Date.now() - startedAt >= DISPATCHER_RUN_JOURNAL_LOCK_TIMEOUT_MS) {
        throw new Error(
          `Timed out waiting for dispatcher journal write lock at ${lockPath}`,
        );
      }
      await sleep(DISPATCHER_RUN_JOURNAL_LOCK_POLL_MS);
    }
  }
}

async function writeDispatcherRunJournalLockOwner(
  lockPath: string,
  ownerToken: string,
): Promise<void> {
  try {
    await fs.writeFile(
      join(lockPath, DISPATCHER_RUN_JOURNAL_LOCK_OWNER_FILENAME),
      `${JSON.stringify({
        pid: process.pid,
        ownerToken,
        acquiredAt: new Date().toISOString(),
      })}\n`,
      "utf8",
    );
  } catch (error) {
    await fs.rm(lockPath, { recursive: true, force: true });
    throw error;
  }
}

async function releaseDispatcherRunJournalWriteLock(
  lockPath: string,
  ownerToken: string,
): Promise<void> {
  const owner = await readDispatcherRunJournalLockOwner(lockPath);
  if (owner?.ownerToken === ownerToken) {
    await fs.rm(lockPath, { recursive: true, force: true });
  }
}

async function removeAbandonedDispatcherRunJournalWriteLock(
  lockPath: string,
): Promise<boolean> {
  const recoveryCandidate =
    await getDispatcherRunJournalLockRecoveryCandidate(lockPath);
  if (recoveryCandidate === null) {
    return false;
  }

  const preClaimStats = await fs.stat(lockPath).catch(() => null);
  const recoveryPath = join(lockPath, DISPATCHER_RUN_JOURNAL_LOCK_RECOVERY_DIR);
  try {
    await fs.mkdir(recoveryPath);
  } catch (error) {
    if (isMissingPathError(error)) {
      return true;
    }
    if (
      isAlreadyExistsPathError(error) &&
      (await removeStaleDispatcherRunJournalRecoveryLock(recoveryPath))
    ) {
      return true;
    }
    return false;
  }

  let removingLock = false;
  try {
    const postClaimStats = await fs.stat(lockPath).catch(() => null);
    if (!isSameLockDirectory(preClaimStats, postClaimStats)) {
      return false;
    }

    const owner = await readDispatcherRunJournalLockOwner(lockPath);
    if (owner !== null) {
      removingLock = !isProcessRunning(owner.pid);
    } else {
      removingLock =
        recoveryCandidate.reason === "stale-metadata" ||
        isStaleDispatcherRunJournalLock(preClaimStats);
    }

    if (removingLock) {
      await fs.rm(lockPath, { recursive: true, force: true });
      return true;
    }
    return false;
  } finally {
    if (!removingLock) {
      await fs.rm(recoveryPath, { recursive: true, force: true });
    }
  }
}

async function removeStaleDispatcherRunJournalRecoveryLock(
  recoveryPath: string,
): Promise<boolean> {
  const stats = await fs.stat(recoveryPath).catch(() => null);
  if (!isStaleDispatcherRunJournalLock(stats)) {
    return false;
  }
  await fs.rm(recoveryPath, { recursive: true, force: true });
  return true;
}

async function getDispatcherRunJournalLockRecoveryCandidate(
  lockPath: string,
): Promise<{ reason: "dead-owner" | "stale-metadata" } | null> {
  const owner = await readDispatcherRunJournalLockOwner(lockPath);
  if (owner !== null) {
    return isProcessRunning(owner.pid) ? null : { reason: "dead-owner" };
  }

  const stats = await fs.stat(lockPath).catch(() => null);
  if (isStaleDispatcherRunJournalLock(stats)) {
    return { reason: "stale-metadata" };
  }
  return null;
}

async function readDispatcherRunJournalLockOwner(
  lockPath: string,
): Promise<{ pid: number; ownerToken?: string } | null> {
  const ownerPath = join(lockPath, DISPATCHER_RUN_JOURNAL_LOCK_OWNER_FILENAME);
  try {
    return parseDispatcherRunJournalLockOwner(
      await fs.readFile(ownerPath, "utf8"),
    );
  } catch (error) {
    if (isMissingPathError(error)) {
      return null;
    }
    throw error;
  }
}

function isStaleDispatcherRunJournalLock(stats: Stats | null): boolean {
  return (
    stats === null ||
    Date.now() - stats.mtimeMs >= DISPATCHER_RUN_JOURNAL_LOCK_TIMEOUT_MS
  );
}

function isSameLockDirectory(left: Stats | null, right: Stats | null): boolean {
  return (
    left !== null &&
    right !== null &&
    left.dev === right.dev &&
    left.ino === right.ino
  );
}

function parseDispatcherRunJournalLockOwner(
  raw: string,
): { pid: number; ownerToken?: string } | null {
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (
      isRecord(parsed) &&
      typeof parsed.pid === "number" &&
      Number.isInteger(parsed.pid) &&
      parsed.pid > 0
    ) {
      const owner = { pid: parsed.pid };
      if (typeof parsed.ownerToken === "string") {
        return { ...owner, ownerToken: parsed.ownerToken };
      }
      return owner;
    }
  } catch {
    return null;
  }
  return null;
}

function isProcessRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (
      typeof error === "object" &&
      error !== null &&
      "code" in error &&
      (error as { code?: unknown }).code === "EPERM"
    );
  }
}

function isDispatcherRunJournalEntry(
  value: unknown,
): value is DispatcherRunJournalEntry {
  if (!isRecord(value)) {
    return false;
  }
  return (
    typeof value.sequence === "number" &&
    typeof value.idempotencyKey === "string" &&
    typeof value.timestamp === "string" &&
    typeof value.kind === "string" &&
    DISPATCHER_RUN_JOURNAL_EVENT_KINDS.includes(
      value.kind as DispatcherRunJournalEntry["kind"],
    ) &&
    typeof value.issueId === "string" &&
    typeof value.issueIdentifier === "string" &&
    typeof value.operation === "string" &&
    typeof value.summary === "string" &&
    isRecord(value.metadata) &&
    (value.lease === null || isDispatcherLease(value.lease))
  );
}

function isDispatcherLease(value: unknown): value is DispatcherLease {
  if (!isRecord(value)) {
    return false;
  }
  return (
    typeof value.leaseId === "string" &&
    typeof value.issueId === "string" &&
    typeof value.issueIdentifier === "string" &&
    typeof value.operation === "string" &&
    typeof value.ownerId === "string" &&
    typeof value.status === "string" &&
    typeof value.acquiredAt === "string" &&
    typeof value.expiresAt === "string" &&
    (value.completedAt === null || typeof value.completedAt === "string") &&
    (value.stage === null || typeof value.stage === "string") &&
    (value.attempt === null || typeof value.attempt === "number") &&
    typeof value.lastJournalSequence === "number"
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isMissingPathError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: unknown }).code === "ENOENT"
  );
}

function isAlreadyExistsPathError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: unknown }).code === "EEXIST"
  );
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
