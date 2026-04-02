import { describe, expect, it, vi } from "vitest";

import {
  PipelineNotifier,
  formatDurationMs,
  formatNotification,
  formatStageTimeline,
  formatTokensCompact,
} from "../../src/orchestrator/pipeline-notifier.js";
import type {
  NotificationPoster,
  PipelineNotificationEvent,
  SlackBlock,
} from "../../src/orchestrator/pipeline-notifier.js";

describe("formatDurationMs", () => {
  it("formats seconds only", () => {
    expect(formatDurationMs(45_000)).toBe("45s");
  });

  it("formats minutes and seconds", () => {
    expect(formatDurationMs(125_000)).toBe("2m 5s");
  });

  it("formats exact minutes without seconds", () => {
    expect(formatDurationMs(180_000)).toBe("3m");
  });

  it("formats hours and minutes", () => {
    expect(formatDurationMs(3_720_000)).toBe("1h 2m");
  });

  it("formats exact hours without minutes", () => {
    expect(formatDurationMs(7_200_000)).toBe("2h");
  });

  it("rounds sub-second durations to zero", () => {
    expect(formatDurationMs(499)).toBe("0s");
  });
});

describe("formatStageTimeline", () => {
  it("returns placeholder for empty history", () => {
    expect(formatStageTimeline([])).toBe("_No stage data_");
  });

  it("formats a single stage record", () => {
    const result = formatStageTimeline([
      {
        stageName: "investigate",
        durationMs: 90_000,
        totalTokens: 12345,
        turns: 3,
        outcome: "completed",
      },
    ]);
    expect(result).toContain("investigate");
    expect(result).toContain("1m 30s");
    expect(result).toContain("12,345 tokens");
    expect(result).toContain("completed");
  });

  it("formats multiple stages on separate lines", () => {
    const result = formatStageTimeline([
      {
        stageName: "investigate",
        durationMs: 60_000,
        totalTokens: 5000,
        turns: 2,
        outcome: "completed",
      },
      {
        stageName: "implement",
        durationMs: 120_000,
        totalTokens: 15000,
        turns: 5,
        outcome: "completed",
      },
    ]);
    const lines = result.split("\n");
    expect(lines).toHaveLength(2);
    expect(lines[0]).toContain("investigate");
    expect(lines[1]).toContain("implement");
  });
});

describe("formatNotification", () => {
  it("formats pipeline_started", () => {
    const result = formatNotification({
      type: "pipeline_started",
      productName: "symphony",
      dashboardUrl: "http://localhost:3000",
    });
    expect(result.text).toContain("Pipeline started");
    expect(result.text).toContain("symphony");
    expect(result.text).toContain("http://localhost:3000");
  });

  it("formats pipeline_started without dashboard url", () => {
    const result = formatNotification({
      type: "pipeline_started",
      productName: "symphony",
      dashboardUrl: null,
    });
    expect(result.text).toContain("Pipeline started");
    expect(result.text).not.toContain("Dashboard");
  });

  it("formats pipeline_stopped", () => {
    const result = formatNotification({
      type: "pipeline_stopped",
      productName: "symphony",
      completedCount: 5,
      failedCount: 2,
      durationMs: 3_600_000,
    });
    expect(result.text).toContain("Pipeline stopped");
    expect(result.text).toContain("Completed: 5");
    expect(result.text).toContain("Failed: 2");
    expect(result.text).toContain("Total: 7");
    expect(result.text).toContain("1h");
  });

  it("formats issue_completed", () => {
    const result = formatNotification({
      type: "issue_completed",
      issueIdentifier: "SYMPH-42",
      issueTitle: "Add pagination",
      issueUrl: "https://linear.app/mobilyze-llc/issue/SYMPH-42",
      executionHistory: [
        {
          stageName: "investigate",
          durationMs: 60_000,
          totalTokens: 5000,
          turns: 2,
          outcome: "completed",
        },
        {
          stageName: "implement",
          durationMs: 120_000,
          totalTokens: 15000,
          turns: 5,
          outcome: "completed",
        },
      ],
      reworkCount: 1,
      totalTokens: 20000,
      totalDurationMs: 180_000,
    });
    expect(result.text).toContain("Issue completed");
    expect(result.text).toContain("SYMPH-42");
    expect(result.text).toContain("Add pagination");
    expect(result.text).toContain("investigate");
    expect(result.text).toContain("implement");
    expect(result.text).toContain("20,000 tokens");
    expect(result.text).toContain("Rework cycles: 1");
    // Structural assertions on Block Kit blocks
    expect(result.blocks).toBeDefined();
    const blocks = result.blocks!;
    // header, section (title link), divider, section (stage timeline), divider, section (totals + rework), context
    expect(blocks).toHaveLength(7);
    expect(blocks[0]?.type).toBe("header");
    expect(blocks[1]?.type).toBe("section");
    // issueUrl is set → title is a mrkdwn link
    const titleBlock = blocks[1] as {
      type: "section";
      text: { type: string; text: string };
    };
    expect(titleBlock.text.text).toContain(
      "<https://linear.app/mobilyze-llc/issue/SYMPH-42|Add pagination>",
    );
    // stage timeline section present (non-empty executionHistory)
    expect(blocks[2]?.type).toBe("divider");
    const stageBlock = blocks[3] as {
      type: "section";
      text: { type: string; text: string };
    };
    expect(stageBlock.type).toBe("section");
    expect(stageBlock.text.text).toContain("`investigate`");
    expect(stageBlock.text.text).toContain("`implement`");
    // totals section includes rework count
    expect(blocks[4]?.type).toBe("divider");
    const totalsBlock = blocks[5] as {
      type: "section";
      text: { type: string; text: string };
    };
    expect(totalsBlock.text.text).toContain("Total:");
    expect(totalsBlock.text.text).toContain("Rework cycles: 1");
    // context block with version
    expect(blocks[6]?.type).toBe("context");
  });

  it("formats issue_completed without rework", () => {
    const result = formatNotification({
      type: "issue_completed",
      issueIdentifier: "SYMPH-42",
      issueTitle: "Add pagination",
      issueUrl: null,
      executionHistory: [],
      reworkCount: 0,
      totalTokens: 10000,
      totalDurationMs: 60_000,
    });
    expect(result.text).not.toContain("Rework");
    // Structural assertions on blocks for null URL, empty history, no rework
    expect(result.blocks).toBeDefined();
    const blocks = result.blocks!;
    // header, section (plain title), divider, section (totals only), context
    // No stage timeline divider+section since executionHistory is empty
    expect(blocks).toHaveLength(5);
    expect(blocks[0]?.type).toBe("header");
    // issueUrl is null → plain title without link
    const titleBlock = blocks[1] as {
      type: "section";
      text: { type: string; text: string };
    };
    expect(titleBlock.type).toBe("section");
    expect(titleBlock.text.text).toBe("*Add pagination*");
    expect(titleBlock.text.text).not.toContain("<");
    // No stage timeline — jumps straight to divider + totals
    expect(blocks[2]?.type).toBe("divider");
    const totalsBlock = blocks[3] as {
      type: "section";
      text: { type: string; text: string };
    };
    expect(totalsBlock.text.text).toContain("Total:");
    expect(totalsBlock.text.text).not.toContain("Rework");
    expect(blocks[4]?.type).toBe("context");
  });

  it("formats issue_failed", () => {
    const result = formatNotification({
      type: "issue_failed",
      issueIdentifier: "SYMPH-42",
      issueTitle: "Add pagination",
      issueUrl: "https://linear.app/mobilyze-llc/issue/SYMPH-42",
      failureReason: "Max retries exceeded",
      retriesExhausted: true,
      retryAttempt: 3,
    });
    expect(result.text).toContain("Issue failed");
    expect(result.text).toContain("SYMPH-42");
    expect(result.text).toContain("Max retries exceeded");
    expect(result.text).toContain("Retries exhausted (attempt 3)");
  });

  it("formats issue_failed without exhaustion", () => {
    const result = formatNotification({
      type: "issue_failed",
      issueIdentifier: "SYMPH-42",
      issueTitle: "Fix bug",
      issueUrl: null,
      failureReason: "worker failed",
      retriesExhausted: false,
      retryAttempt: null,
    });
    expect(result.text).toContain("Issue failed");
    expect(result.text).not.toContain("Retries exhausted");
  });

  it("formats stall_killed", () => {
    const result = formatNotification({
      type: "stall_killed",
      issueIdentifier: "SYMPH-42",
      issueTitle: "Add pagination",
      stageName: "implement",
      stallDurationMs: 900_000,
    });
    expect(result.text).toContain("Stall killed");
    expect(result.text).toContain("SYMPH-42");
    expect(result.text).toContain("Stage: implement");
    expect(result.text).toContain("15m");
  });

  it("formats stall_killed without stage name", () => {
    const result = formatNotification({
      type: "stall_killed",
      issueIdentifier: "SYMPH-42",
      issueTitle: "Fix bug",
      stageName: null,
      stallDurationMs: 300_000,
    });
    expect(result.text).not.toContain("Stage:");
  });

  it("formats infra_error", () => {
    const result = formatNotification({
      type: "infra_error",
      issueIdentifier: "SYMPH-42",
      issueTitle: "Add pagination",
      errorReason: "Failed to start agent process",
    });
    expect(result.text).toContain("Infra error");
    expect(result.text).toContain("SYMPH-42");
    expect(result.text).toContain("Failed to start agent process");
  });

  it("formats issue_dispatched for first entry", () => {
    const result = formatNotification({
      type: "issue_dispatched",
      issueIdentifier: "SYMPH-42",
      issueTitle: "Add pagination",
      issueUrl: "https://linear.app/mobilyze-llc/issue/SYMPH-42",
      stageName: "investigate",
      reworkCount: 0,
    });
    expect(result.text).toContain("Issue dispatched");
    expect(result.text).toContain("SYMPH-42");
    expect(result.text).toContain("Add pagination");
    expect(result.text).toContain("Stage: investigate");
    expect(result.text).not.toContain("Rework");
  });

  it("formats issue_dispatched with rework count", () => {
    const result = formatNotification({
      type: "issue_dispatched",
      issueIdentifier: "SYMPH-42",
      issueTitle: "Add pagination",
      issueUrl: null,
      stageName: "implement",
      reworkCount: 2,
    });
    expect(result.text).toContain("Issue dispatched");
    expect(result.text).toContain("Rework #2");
    expect(result.text).toContain("Stage: implement");
  });

  it("formats issue_dropped", () => {
    const result = formatNotification({
      type: "issue_dropped",
      issueIdentifier: "SYMPH-42",
      issueTitle: "Add pagination",
      issueUrl: "https://linear.app/mobilyze-llc/issue/SYMPH-42",
      reason: "issue no longer in candidate list",
    });
    expect(result.text).toContain("Issue left pipeline");
    expect(result.text).toContain("SYMPH-42");
    expect(result.text).toContain("Add pagination");
    expect(result.text).toContain("issue no longer in candidate list");
  });

  it("returns text only with no blocks for non-issue_completed events", () => {
    const events: PipelineNotificationEvent[] = [
      { type: "pipeline_started", productName: "test", dashboardUrl: null },
      {
        type: "pipeline_stopped",
        productName: "test",
        completedCount: 1,
        failedCount: 0,
        durationMs: 5000,
      },
      {
        type: "issue_failed",
        issueIdentifier: "T-1",
        issueTitle: "t",
        issueUrl: null,
        failureReason: null,
        retriesExhausted: false,
        retryAttempt: null,
      },
      {
        type: "stall_killed",
        issueIdentifier: "T-1",
        issueTitle: "t",
        stageName: null,
        stallDurationMs: 1000,
      },
      {
        type: "infra_error",
        issueIdentifier: "T-1",
        issueTitle: "t",
        errorReason: "err",
      },
      {
        type: "issue_dispatched",
        issueIdentifier: "T-1",
        issueTitle: "t",
        issueUrl: null,
        stageName: null,
        reworkCount: 0,
      },
      {
        type: "issue_dropped",
        issueIdentifier: "T-1",
        issueTitle: "t",
        issueUrl: null,
        reason: "dropped",
      },
    ];
    for (const event of events) {
      const result = formatNotification(event);
      expect(result.text).toBeTruthy();
      expect(result).not.toHaveProperty("blocks");
    }
  });
});

describe("PipelineNotifier", () => {
  function createMockPoster(): NotificationPoster & {
    calls: Array<{ channel: string; text: string; blocks?: SlackBlock[] }>;
  } {
    const calls: Array<{
      channel: string;
      text: string;
      blocks?: SlackBlock[];
    }> = [];
    return {
      calls,
      async post(
        channel: string,
        text: string,
        blocks?: SlackBlock[],
      ): Promise<void> {
        if (blocks !== undefined) {
          calls.push({ channel, text, blocks });
        } else {
          calls.push({ channel, text });
        }
      },
    };
  }

  it("posts formatted notification to configured channel", async () => {
    const poster = createMockPoster();
    const notifier = new PipelineNotifier({
      channel: "C12345",
      poster,
    });

    notifier.notify({
      type: "pipeline_started",
      productName: "symphony",
      dashboardUrl: null,
    });

    // Wait for the async post
    await new Promise((resolve) => setTimeout(resolve, 10));

    expect(poster.calls).toHaveLength(1);
    expect(poster.calls[0]?.channel).toBe("C12345");
    expect(poster.calls[0]?.text).toContain("Pipeline started");
  });

  it("swallows errors and calls onError callback", async () => {
    const errors: unknown[] = [];
    const failingPoster: NotificationPoster = {
      async post(): Promise<void> {
        throw new Error("Slack API down");
      },
    };
    const notifier = new PipelineNotifier({
      channel: "C12345",
      poster: failingPoster,
      onError: (err) => errors.push(err),
    });

    notifier.notify({
      type: "pipeline_started",
      productName: "symphony",
      dashboardUrl: null,
    });

    // Wait for the async rejection
    await new Promise((resolve) => setTimeout(resolve, 10));

    expect(errors).toHaveLength(1);
    expect(errors[0]).toBeInstanceOf(Error);
    expect((errors[0] as Error).message).toBe("Slack API down");
  });

  it("swallows errors silently when no onError callback provided", async () => {
    const failingPoster: NotificationPoster = {
      async post(): Promise<void> {
        throw new Error("Slack API down");
      },
    };
    const notifier = new PipelineNotifier({
      channel: "C12345",
      poster: failingPoster,
    });

    // Should not throw
    notifier.notify({
      type: "pipeline_started",
      productName: "symphony",
      dashboardUrl: null,
    });

    await new Promise((resolve) => setTimeout(resolve, 10));
  });

  it("sends multiple events to the same channel", async () => {
    const poster = createMockPoster();
    const notifier = new PipelineNotifier({
      channel: "C12345",
      poster,
    });

    const events: PipelineNotificationEvent[] = [
      { type: "pipeline_started", productName: "test", dashboardUrl: null },
      {
        type: "issue_completed",
        issueIdentifier: "TEST-1",
        issueTitle: "Test",
        issueUrl: null,
        executionHistory: [],
        reworkCount: 0,
        totalTokens: 100,
        totalDurationMs: 1000,
      },
      {
        type: "pipeline_stopped",
        productName: "test",
        completedCount: 1,
        failedCount: 0,
        durationMs: 5000,
      },
    ];

    for (const event of events) {
      notifier.notify(event);
    }

    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(poster.calls).toHaveLength(3);
    expect(poster.calls.every((c) => c.channel === "C12345")).toBe(true);
  });

  it("flush resolves immediately when no in-flight notifications", async () => {
    const poster = createMockPoster();
    const notifier = new PipelineNotifier({
      channel: "C12345",
      poster,
    });

    await notifier.flush();
    // No error = pass
  });

  it("flush awaits in-flight notifications", async () => {
    let resolvePost: (() => void) | undefined;
    const slowPoster: NotificationPoster = {
      async post(): Promise<void> {
        await new Promise<void>((resolve) => {
          resolvePost = resolve;
        });
      },
    };
    const notifier = new PipelineNotifier({
      channel: "C12345",
      poster: slowPoster,
    });

    notifier.notify({
      type: "pipeline_started",
      productName: "test",
      dashboardUrl: null,
    });

    let flushed = false;
    const flushPromise = notifier.flush().then(() => {
      flushed = true;
    });

    // Not yet flushed — post is still pending
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(flushed).toBe(false);

    // Resolve the post
    resolvePost!();
    await flushPromise;
    expect(flushed).toBe(true);
  });

  it("flush resolves after timeout even if poster hangs", async () => {
    const hangingPoster: NotificationPoster = {
      async post(): Promise<void> {
        await new Promise<void>(() => {}); // never resolves
      },
    };
    const notifier = new PipelineNotifier({
      channel: "C12345",
      poster: hangingPoster,
    });

    notifier.notify({
      type: "pipeline_started",
      productName: "test",
      dashboardUrl: null,
    });

    // flush with a short timeout should resolve despite hanging poster
    await notifier.flush(100);
  });

  it("passes blocks to poster for issue_completed events", async () => {
    const poster = createMockPoster();
    const notifier = new PipelineNotifier({
      channel: "C12345",
      poster,
    });

    notifier.notify({
      type: "issue_completed",
      issueIdentifier: "SYMPH-42",
      issueTitle: "Add pagination",
      issueUrl: "https://linear.app/mobilyze-llc/issue/SYMPH-42",
      executionHistory: [
        {
          stageName: "implement",
          durationMs: 120_000,
          totalTokens: 15000,
          turns: 5,
          outcome: "completed",
        },
      ],
      reworkCount: 0,
      totalTokens: 15000,
      totalDurationMs: 120_000,
    });

    await new Promise((resolve) => setTimeout(resolve, 10));

    expect(poster.calls).toHaveLength(1);
    expect(poster.calls[0]?.text).toContain("Issue completed");
    expect(poster.calls[0]?.blocks).toBeDefined();
    expect(Array.isArray(poster.calls[0]?.blocks)).toBe(true);
  });
});

describe("formatTokensCompact", () => {
  it("formats tokens below 1k as plain numbers", () => {
    expect(formatTokensCompact(999)).toBe("999");
    expect(formatTokensCompact(0)).toBe("0");
  });

  it("formats tokens in thousands with k suffix", () => {
    expect(formatTokensCompact(1000)).toBe("1k");
    expect(formatTokensCompact(5000)).toBe("5k");
    expect(formatTokensCompact(12300)).toBe("12.3k");
    expect(formatTokensCompact(999_999)).toBe("1000k");
  });

  it("formats tokens in millions with M suffix", () => {
    expect(formatTokensCompact(1_000_000)).toBe("1M");
    expect(formatTokensCompact(1_200_000)).toBe("1.2M");
    expect(formatTokensCompact(10_000_000)).toBe("10M");
  });
});
