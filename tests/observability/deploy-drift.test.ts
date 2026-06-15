import { describe, expect, it } from "vitest";

import {
  captureDeployDrift,
  qualifyDeployDriftFreshness,
} from "../../src/observability/deploy-drift.js";

const NOW = () => new Date("2026-06-12T10:00:00.000Z");

describe("captureDeployDrift (SYMPH-407)", () => {
  it("reports drift when running commit differs from origin/main", async () => {
    const status = await captureDeployDrift({
      repoRoot: "/repo",
      now: NOW,
      execGit: async (args) => {
        expect(args[0]).toBe("rev-parse");
        return args[1] === "HEAD" ? "aaa1111\n" : "bbb2222\n";
      },
    });
    expect(status).toEqual({
      running_commit: "aaa1111",
      origin_main_commit: "bbb2222",
      drift: true,
      captured_at: "2026-06-12T10:00:00.000Z",
      note: expect.stringContaining("captured once at startup"),
    });
  });

  it("reports no drift when commits match", async () => {
    const status = await captureDeployDrift({
      repoRoot: "/repo",
      now: NOW,
      execGit: async () => "abc1234\n",
    });
    expect(status.drift).toBe(false);
  });

  it("qualifies stale aligned captures without changing the raw drift boolean", () => {
    const status = qualifyDeployDriftFreshness(
      {
        running_commit: "abc1234",
        origin_main_commit: "abc1234",
        drift: false,
        captured_at: "2026-06-12T10:00:00.000Z",
        note: "captured once at startup",
      },
      {
        now: new Date("2026-06-12T10:15:01.000Z"),
        freshnessWindowSeconds: 600,
      },
    );

    expect(status.drift).toBe(false);
    expect(status.qualified_status).toBe("aligned_stale");
    expect(status.freshness).toEqual({
      status: "stale",
      captured_age_seconds: 901,
      threshold_seconds: 600,
    });
  });

  it("leaves stale positive drift as a drift signal", () => {
    const status = qualifyDeployDriftFreshness(
      {
        running_commit: "abc1234",
        origin_main_commit: "def5678",
        drift: true,
        captured_at: "2026-06-12T10:00:00.000Z",
        note: "captured once at startup",
      },
      {
        now: new Date("2026-06-12T10:15:01.000Z"),
        freshnessWindowSeconds: 600,
      },
    );

    expect(status.drift).toBe(true);
    expect(status.qualified_status).toBe("drift");
    expect(status.freshness?.status).toBe("stale");
  });

  it("degrades to nulls when git fails (best-effort, never throws)", async () => {
    const status = await captureDeployDrift({
      repoRoot: "/repo",
      now: NOW,
      execGit: async (args) => {
        if (args[1] === "origin/main") {
          throw new Error("unknown revision");
        }
        return "abc1234\n";
      },
    });
    expect(status.running_commit).toBe("abc1234");
    expect(status.origin_main_commit).toBeNull();
    expect(status.drift).toBeNull();
  });

  it("rejects non-sha output", async () => {
    const status = await captureDeployDrift({
      repoRoot: "/repo",
      now: NOW,
      execGit: async () => "fatal: not a git repository\n",
    });
    expect(status.running_commit).toBeNull();
    expect(status.drift).toBeNull();
  });
});
