import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

/**
 * Durable copy of the last observed Codex rate-limit snapshot (SYMPH-336).
 *
 * The dispatch admission floor (SYMPH-333) reads rate limits from in-memory
 * orchestrator state, which is empty after a restart — the floor failed open
 * until the first worker emitted telemetry. Persisting the last snapshot
 * lets the floor engage from the first poll tick after a restart. Loading a
 * stale snapshot is safe: the gate already ignores windows whose `resets_at`
 * has passed, so old data can never block dispatch past a window reset.
 */
export interface PersistedRateLimitSnapshot {
  /** ISO timestamp of the observation that produced the snapshot. */
  observedAt: string;
  /** The opaque rate-limit blob exactly as the Codex app-server emitted it. */
  rateLimits: Record<string, unknown>;
}

const SNAPSHOT_SCHEMA = "symphony.rate-limit-snapshot.v1";

export function getRateLimitSnapshotPath(workspaceRoot: string): string {
  return join(workspaceRoot, ".symphony", "rate-limits.json");
}

/**
 * Best-effort atomic write (tmp + rename). Callers are expected to catch and
 * log failures; persistence must never disturb the event path.
 */
export async function persistRateLimitSnapshot(
  workspaceRoot: string,
  snapshot: PersistedRateLimitSnapshot,
): Promise<void> {
  const path = getRateLimitSnapshotPath(workspaceRoot);
  await mkdir(dirname(path), { recursive: true });
  const payload = JSON.stringify(
    {
      schema: SNAPSHOT_SCHEMA,
      observed_at: snapshot.observedAt,
      rate_limits: snapshot.rateLimits,
    },
    null,
    2,
  );
  const tmpPath = `${path}.tmp`;
  await writeFile(tmpPath, `${payload}\n`, "utf8");
  await rename(tmpPath, path);
}

/**
 * Returns null for a missing, unreadable, or malformed file — corrupt
 * persistence degrades to the pre-SYMPH-336 fail-open behavior.
 */
export async function loadPersistedRateLimitSnapshot(
  workspaceRoot: string,
): Promise<PersistedRateLimitSnapshot | null> {
  let raw: string;
  try {
    raw = await readFile(getRateLimitSnapshotPath(workspaceRoot), "utf8");
  } catch {
    return null;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }

  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    return null;
  }
  const record = parsed as Record<string, unknown>;
  if (record.schema !== SNAPSHOT_SCHEMA) {
    return null;
  }
  const observedAt = record.observed_at;
  const rateLimits = record.rate_limits;
  if (typeof observedAt !== "string" || observedAt.length === 0) {
    return null;
  }
  if (
    rateLimits === null ||
    typeof rateLimits !== "object" ||
    Array.isArray(rateLimits)
  ) {
    return null;
  }

  return {
    observedAt,
    rateLimits: rateLimits as Record<string, unknown>,
  };
}
