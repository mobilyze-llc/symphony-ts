import { describe, expect, it } from "vitest";

import {
  type RateLimitWindowObservation,
  evaluateWindowHeadroom,
  observeRateLimitWindow,
  observedWindowDeltaPercent,
  parseRateLimitSnapshot,
} from "../../src/codex/rate-limits.js";

describe("parseRateLimitSnapshot", () => {
  it("parses the production snake_case codex payload shape", () => {
    // Captured verbatim from a SYMPH-319 canary rollout ledger entry.
    const snapshot = parseRateLimitSnapshot({
      limit_id: "codex",
      limit_name: null,
      primary: {
        used_percent: 39.0,
        window_minutes: 300,
        resets_at: 1781093929,
      },
      secondary: {
        used_percent: 97.0,
        window_minutes: 10080,
        resets_at: 1781137743,
      },
      credits: null,
      plan_type: "pro",
      rate_limit_reached_type: null,
    });

    expect(snapshot).toEqual({
      primary: {
        usedPercent: 39.0,
        windowMinutes: 300,
        resetsAt: 1781093929,
      },
      secondary: {
        usedPercent: 97.0,
        windowMinutes: 10080,
        resetsAt: 1781137743,
      },
    });
  });

  it("parses camelCase aliases independently of snake_case", () => {
    const snapshot = parseRateLimitSnapshot({
      primary: {
        usedPercent: 12.5,
        windowMinutes: 300,
        resetsAt: 1781093929,
      },
    });

    expect(snapshot?.primary).toEqual({
      usedPercent: 12.5,
      windowMinutes: 300,
      resetsAt: 1781093929,
    });
    expect(snapshot?.secondary).toBeNull();
  });

  it("parses the live camelCase codex payload shape with windowDurationMins", () => {
    const snapshot = parseRateLimitSnapshot({
      limitId: "codex",
      primary: {
        usedPercent: 0,
        windowDurationMins: 300,
        resetsAt: 1781132023,
      },
      secondary: {
        usedPercent: 98,
        windowDurationMins: 10080,
        resetsAt: 1781137743,
      },
      planType: "pro",
    });

    expect(snapshot).toEqual({
      primary: {
        usedPercent: 0,
        windowMinutes: 300,
        resetsAt: 1781132023,
      },
      secondary: {
        usedPercent: 98,
        windowMinutes: 10080,
        resetsAt: 1781137743,
      },
    });
  });

  it("normalizes epoch-millisecond resets_at to seconds", () => {
    const snapshot = parseRateLimitSnapshot({
      primary: { used_percent: 10, resets_at: 1781093929000 },
    });

    expect(snapshot?.primary?.resetsAt).toBe(1781093929);
  });

  it("clamps used_percent into the 0-100 range", () => {
    const snapshot = parseRateLimitSnapshot({
      primary: { used_percent: 130.2 },
      secondary: { used_percent: -4 },
    });

    expect(snapshot?.primary?.usedPercent).toBe(100);
    expect(snapshot?.secondary?.usedPercent).toBe(0);
  });

  it("returns null for blobs without a parsable window", () => {
    expect(parseRateLimitSnapshot(null)).toBeNull();
    expect(parseRateLimitSnapshot(undefined)).toBeNull();
    expect(parseRateLimitSnapshot("rate limited")).toBeNull();
    expect(parseRateLimitSnapshot({ requestsRemaining: 7 })).toBeNull();
    expect(
      parseRateLimitSnapshot({ primary: { window_minutes: 300 } }),
    ).toBeNull();
    expect(parseRateLimitSnapshot({ primary: { used_percent: "39" } })).toBe(
      null,
    );
  });

  it("tolerates a window missing optional fields", () => {
    const snapshot = parseRateLimitSnapshot({
      secondary: { used_percent: 98 },
    });

    expect(snapshot).toEqual({
      primary: null,
      secondary: { usedPercent: 98, windowMinutes: null, resetsAt: null },
    });
  });
});

describe("observeRateLimitWindow", () => {
  const window = (
    usedPercent: number,
    resetsAt: number | null = 1781093929,
  ) => ({
    usedPercent,
    windowMinutes: 300,
    resetsAt,
  });

  it("baselines start and latest on first observation", () => {
    const observation = observeRateLimitWindow(null, window(42));

    expect(observation).toEqual({
      startPercent: 42,
      latestPercent: 42,
      lastResetsAt: 1781093929,
    });
    expect(observedWindowDeltaPercent(observation)).toBe(0);
  });

  it("accumulates burn against a fixed baseline", () => {
    let observation: RateLimitWindowObservation | null = null;
    for (const used of [40, 41.5, 44]) {
      observation = observeRateLimitWindow(observation, window(used));
    }

    expect(observation?.startPercent).toBe(40);
    expect(observation?.latestPercent).toBe(44);
    expect(observedWindowDeltaPercent(observation)).toBe(4);
  });

  it("re-baselines when used_percent drops across a window reset", () => {
    let observation = observeRateLimitWindow(null, window(95));
    observation = observeRateLimitWindow(observation, window(97));
    // Window rolled over: usage falls back near zero.
    observation = observeRateLimitWindow(observation, window(2, 1781111929));
    observation = observeRateLimitWindow(observation, window(5, 1781111929));

    expect(observation.startPercent).toBe(2);
    expect(observation.latestPercent).toBe(5);
    expect(observedWindowDeltaPercent(observation)).toBe(3);
  });

  it("re-baselines on a later resets_at even when usage did not drop", () => {
    let observation = observeRateLimitWindow(null, window(50, 1781093929));
    observation = observeRateLimitWindow(observation, window(52, 1781111929));

    expect(observation.startPercent).toBe(52);
    expect(observedWindowDeltaPercent(observation)).toBe(0);
  });

  it("never reports a negative delta", () => {
    expect(observedWindowDeltaPercent(null)).toBe(0);
    expect(
      observedWindowDeltaPercent({
        startPercent: 50,
        latestPercent: 49,
        lastResetsAt: null,
      }),
    ).toBe(0);
  });
});

describe("evaluateWindowHeadroom", () => {
  it("computes remaining headroom from used percent", () => {
    const headroom = evaluateWindowHeadroom(
      { usedPercent: 98, windowMinutes: 10080, resetsAt: 1781137743 },
      (1781137743 - 3600) * 1000,
    );

    expect(headroom).toEqual({
      usedPercent: 98,
      remainingPercent: 2,
      resetsAt: 1781137743,
      expired: false,
    });
  });

  it("marks the snapshot expired once resets_at has passed", () => {
    const headroom = evaluateWindowHeadroom(
      { usedPercent: 98, windowMinutes: 10080, resetsAt: 1781137743 },
      (1781137743 + 1) * 1000,
    );

    expect(headroom?.expired).toBe(true);
  });

  it("treats a missing resets_at as never expiring", () => {
    const headroom = evaluateWindowHeadroom(
      { usedPercent: 50, windowMinutes: null, resetsAt: null },
      Date.parse("2026-06-10T17:00:00Z"),
    );

    expect(headroom?.expired).toBe(false);
  });

  it("returns null for a missing window", () => {
    expect(evaluateWindowHeadroom(null, 0)).toBeNull();
  });
});
