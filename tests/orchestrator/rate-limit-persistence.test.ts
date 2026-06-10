import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  getRateLimitSnapshotPath,
  loadPersistedRateLimitSnapshot,
  persistRateLimitSnapshot,
} from "../../src/orchestrator/rate-limit-persistence.js";

const RATE_LIMITS = {
  limit_id: "codex",
  primary: { used_percent: 39, window_minutes: 300, resets_at: 1781093929 },
  secondary: {
    used_percent: 97,
    window_minutes: 10080,
    resets_at: 1781137743,
  },
};

describe("rate-limit snapshot persistence", () => {
  let workspaceRoot: string;

  beforeEach(async () => {
    workspaceRoot = await mkdtemp(join(tmpdir(), "symphony-rl-persist-"));
  });

  afterEach(async () => {
    await rm(workspaceRoot, { recursive: true, force: true });
  });

  it("round-trips a snapshot through persist and load", async () => {
    await persistRateLimitSnapshot(workspaceRoot, {
      observedAt: "2026-06-10T18:30:00.000Z",
      rateLimits: RATE_LIMITS,
    });

    const loaded = await loadPersistedRateLimitSnapshot(workspaceRoot);
    expect(loaded).toEqual({
      observedAt: "2026-06-10T18:30:00.000Z",
      rateLimits: RATE_LIMITS,
    });
  });

  it("stores the snapshot under .symphony in the workspace root", async () => {
    const path = getRateLimitSnapshotPath(workspaceRoot);
    expect(path).toBe(join(workspaceRoot, ".symphony", "rate-limits.json"));

    await persistRateLimitSnapshot(workspaceRoot, {
      observedAt: "2026-06-10T18:30:00.000Z",
      rateLimits: RATE_LIMITS,
    });
    const raw = JSON.parse(await readFile(path, "utf8"));
    expect(raw.schema).toBe("symphony.rate-limit-snapshot.v1");
    expect(dirname(path).endsWith(".symphony")).toBe(true);
  });

  it("overwrites the previous snapshot in place", async () => {
    await persistRateLimitSnapshot(workspaceRoot, {
      observedAt: "2026-06-10T18:30:00.000Z",
      rateLimits: RATE_LIMITS,
    });
    const updated = {
      ...RATE_LIMITS,
      primary: { ...RATE_LIMITS.primary, used_percent: 41 },
    };
    await persistRateLimitSnapshot(workspaceRoot, {
      observedAt: "2026-06-10T18:31:00.000Z",
      rateLimits: updated,
    });

    const loaded = await loadPersistedRateLimitSnapshot(workspaceRoot);
    expect(loaded?.observedAt).toBe("2026-06-10T18:31:00.000Z");
    expect(
      (loaded?.rateLimits.primary as Record<string, unknown>).used_percent,
    ).toBe(41);
  });

  it("returns null when no snapshot file exists", async () => {
    expect(await loadPersistedRateLimitSnapshot(workspaceRoot)).toBeNull();
  });

  it("fails open on corrupt or foreign file contents", async () => {
    const path = getRateLimitSnapshotPath(workspaceRoot);
    await persistRateLimitSnapshot(workspaceRoot, {
      observedAt: "2026-06-10T18:30:00.000Z",
      rateLimits: RATE_LIMITS,
    });

    await writeFile(path, "{not json", "utf8");
    expect(await loadPersistedRateLimitSnapshot(workspaceRoot)).toBeNull();

    await writeFile(path, JSON.stringify({ schema: "other.v9" }), "utf8");
    expect(await loadPersistedRateLimitSnapshot(workspaceRoot)).toBeNull();

    await writeFile(
      path,
      JSON.stringify({
        schema: "symphony.rate-limit-snapshot.v1",
        observed_at: "",
        rate_limits: RATE_LIMITS,
      }),
      "utf8",
    );
    expect(await loadPersistedRateLimitSnapshot(workspaceRoot)).toBeNull();

    await writeFile(
      path,
      JSON.stringify({
        schema: "symphony.rate-limit-snapshot.v1",
        observed_at: "2026-06-10T18:30:00.000Z",
        rate_limits: [1, 2],
      }),
      "utf8",
    );
    expect(await loadPersistedRateLimitSnapshot(workspaceRoot)).toBeNull();
  });
});
