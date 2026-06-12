import { describe, expect, it, vi } from "vitest";

import {
  PipelineNotifier,
  createWebhookPoster,
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

  it("formats issue_dispatched with right-sizing details in text", () => {
    const result = formatNotification({
      type: "issue_dispatched",
      issueIdentifier: "SYMPH-42",
      issueTitle: "Add pagination",
      issueUrl: null,
      stageName: "implement",
      reworkCount: 0,
      rightSizingDecision: createRightSizingDecision({
        mode: "thin",
        modelRouting: {
          allowed: true,
          reason: "ambiguous_routing",
        },
        triggerHits: ["merge_path", "scope_overlap"],
      }),
    });

    expect(result.text).toContain("Mode: thin");
    expect(result.text).toContain("Model routing: allowed (ambiguous_routing)");
    expect(result.text).toContain("Triggers: merge_path, scope_overlap");
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

  // --- Block Kit tests for pipeline_stopped ---

  it("pipeline_stopped returns Block Kit with header containing stop sign and product name", () => {
    const result = formatNotification({
      type: "pipeline_stopped",
      productName: "symphony",
      completedCount: 5,
      failedCount: 2,
      durationMs: 3_600_000,
    });
    expect(result.blocks).toBeDefined();
    const blocks = result.blocks!;
    // header, divider, section (count fields), section (duration field), context
    expect(blocks).toHaveLength(5);

    const header = blocks[0] as { type: "header"; text: { text: string } };
    expect(header.type).toBe("header");
    expect(header.text.text).toContain("Pipeline stopped");
    expect(header.text.text).toContain("symphony");

    expect(blocks[1]?.type).toBe("divider");
    expect(blocks[4]?.type).toBe("context");
  });

  it("pipeline_stopped includes count fields for completed, failed, and total", () => {
    const result = formatNotification({
      type: "pipeline_stopped",
      productName: "test",
      completedCount: 3,
      failedCount: 1,
      durationMs: 60_000,
    });
    const blocks = result.blocks!;
    const statsBlock = blocks[2] as {
      type: "section";
      fields: Array<{ text: string }>;
    };
    expect(statsBlock.type).toBe("section");
    expect(statsBlock.fields).toHaveLength(3);
    expect(statsBlock.fields[0]?.text).toContain("3 completed");
    expect(statsBlock.fields[1]?.text).toContain("1 failed");
    expect(statsBlock.fields[2]?.text).toContain("4 total");
  });

  it("pipeline_stopped includes duration field", () => {
    const result = formatNotification({
      type: "pipeline_stopped",
      productName: "test",
      completedCount: 1,
      failedCount: 0,
      durationMs: 3_600_000,
    });
    const blocks = result.blocks!;
    const durationBlock = blocks[3] as {
      type: "section";
      fields: Array<{ text: string }>;
    };
    expect(durationBlock.type).toBe("section");
    expect(durationBlock.fields).toHaveLength(1);
    expect(durationBlock.fields[0]?.text).toContain("1h");
  });

  // --- Block Kit tests for issue_failed ---

  it("issue_failed returns Block Kit with header containing X emoji and identifier", () => {
    const result = formatNotification({
      type: "issue_failed",
      issueIdentifier: "SYMPH-42",
      issueTitle: "Add pagination",
      issueUrl: "https://linear.app/mobilyze-llc/issue/SYMPH-42",
      failureReason: "Max retries exceeded",
      retriesExhausted: true,
      retryAttempt: 3,
    });
    expect(result.blocks).toBeDefined();
    const blocks = result.blocks!;

    const header = blocks[0] as { type: "header"; text: { text: string } };
    expect(header.type).toBe("header");
    expect(header.text.text).toContain("Issue failed");
    expect(header.text.text).toContain("SYMPH-42");
  });

  it("issue_failed includes title with Linear link when URL is present", () => {
    const result = formatNotification({
      type: "issue_failed",
      issueIdentifier: "SYMPH-42",
      issueTitle: "Add pagination",
      issueUrl: "https://linear.app/mobilyze-llc/issue/SYMPH-42",
      failureReason: null,
      retriesExhausted: false,
      retryAttempt: null,
    });
    const blocks = result.blocks!;
    const titleBlock = blocks[1] as {
      type: "section";
      text: { text: string };
    };
    expect(titleBlock.type).toBe("section");
    expect(titleBlock.text.text).toContain("*Add pagination*");
    expect(titleBlock.text.text).toContain(
      "<https://linear.app/mobilyze-llc/issue/SYMPH-42|View in Linear>",
    );
  });

  it("issue_failed without URL omits View in Linear link", () => {
    const result = formatNotification({
      type: "issue_failed",
      issueIdentifier: "SYMPH-42",
      issueTitle: "Fix bug",
      issueUrl: null,
      failureReason: null,
      retriesExhausted: false,
      retryAttempt: null,
    });
    const blocks = result.blocks!;
    const titleBlock = blocks[1] as {
      type: "section";
      text: { text: string };
    };
    expect(titleBlock.text.text).toBe("*Fix bug*");
    expect(titleBlock.text.text).not.toContain("View in Linear");
  });

  it("issue_failed includes failure reason section when present", () => {
    const result = formatNotification({
      type: "issue_failed",
      issueIdentifier: "SYMPH-42",
      issueTitle: "Fix bug",
      issueUrl: null,
      failureReason: "Max retries exceeded",
      retriesExhausted: false,
      retryAttempt: null,
    });
    const blocks = result.blocks!;
    // header, section (title), divider, section (reason), context
    expect(blocks).toHaveLength(5);
    const reasonBlock = blocks[3] as {
      type: "section";
      text: { text: string };
    };
    expect(reasonBlock.type).toBe("section");
    expect(reasonBlock.text.text).toContain("Reason: Max retries exceeded");
  });

  it("issue_failed omits failure reason section when null", () => {
    const result = formatNotification({
      type: "issue_failed",
      issueIdentifier: "SYMPH-42",
      issueTitle: "Fix bug",
      issueUrl: null,
      failureReason: null,
      retriesExhausted: false,
      retryAttempt: null,
    });
    const blocks = result.blocks!;
    // header, section (title), divider, context — no reason, no retries
    expect(blocks).toHaveLength(4);
    // Last block is context
    expect(blocks[blocks.length - 1]?.type).toBe("context");
  });

  it("issue_failed includes retries exhausted field with attempt number", () => {
    const result = formatNotification({
      type: "issue_failed",
      issueIdentifier: "SYMPH-42",
      issueTitle: "Fix bug",
      issueUrl: null,
      failureReason: "Max retries exceeded",
      retriesExhausted: true,
      retryAttempt: 3,
    });
    const blocks = result.blocks!;
    // header, section (title), divider, section (reason), section (retries field), context
    expect(blocks).toHaveLength(6);
    const retriesBlock = blocks[4] as {
      type: "section";
      fields: Array<{ text: string }>;
    };
    expect(retriesBlock.type).toBe("section");
    expect(retriesBlock.fields[0]?.text).toContain(
      "Retries exhausted (attempt 3)",
    );
  });

  it("issue_failed without exhaustion omits retries field", () => {
    const result = formatNotification({
      type: "issue_failed",
      issueIdentifier: "SYMPH-42",
      issueTitle: "Fix bug",
      issueUrl: null,
      failureReason: null,
      retriesExhausted: false,
      retryAttempt: null,
    });
    const blocks = result.blocks!;
    // No retries block — check no block has "Retries exhausted" text
    for (const block of blocks) {
      if ("fields" in block && block.fields) {
        for (const field of block.fields) {
          expect(field.text).not.toContain("Retries exhausted");
        }
      }
    }
  });

  // --- Block Kit tests for issue_dispatched ---

  it("issue_dispatched returns Block Kit with header containing play emoji and identifier", () => {
    const result = formatNotification({
      type: "issue_dispatched",
      issueIdentifier: "SYMPH-42",
      issueTitle: "Add pagination",
      issueUrl: "https://linear.app/mobilyze-llc/issue/SYMPH-42",
      stageName: "investigate",
      reworkCount: 0,
    });
    expect(result.blocks).toBeDefined();
    const blocks = result.blocks!;

    const header = blocks[0] as { type: "header"; text: { text: string } };
    expect(header.type).toBe("header");
    expect(header.text.text).toContain("Issue dispatched");
    expect(header.text.text).toContain("SYMPH-42");
  });

  it("issue_dispatched includes title with Linear link when URL is present", () => {
    const result = formatNotification({
      type: "issue_dispatched",
      issueIdentifier: "SYMPH-42",
      issueTitle: "Add pagination",
      issueUrl: "https://linear.app/mobilyze-llc/issue/SYMPH-42",
      stageName: "investigate",
      reworkCount: 0,
    });
    const blocks = result.blocks!;
    const titleBlock = blocks[1] as {
      type: "section";
      text: { text: string };
    };
    expect(titleBlock.type).toBe("section");
    expect(titleBlock.text.text).toContain("*Add pagination*");
    expect(titleBlock.text.text).toContain(
      "<https://linear.app/mobilyze-llc/issue/SYMPH-42|View in Linear>",
    );
  });

  it("issue_dispatched without URL omits View in Linear link", () => {
    const result = formatNotification({
      type: "issue_dispatched",
      issueIdentifier: "SYMPH-42",
      issueTitle: "Add pagination",
      issueUrl: null,
      stageName: "investigate",
      reworkCount: 0,
    });
    const blocks = result.blocks!;
    const titleBlock = blocks[1] as {
      type: "section";
      text: { text: string };
    };
    expect(titleBlock.text.text).toBe("*Add pagination*");
    expect(titleBlock.text.text).not.toContain("View in Linear");
  });

  it("issue_dispatched includes stage field", () => {
    const result = formatNotification({
      type: "issue_dispatched",
      issueIdentifier: "SYMPH-42",
      issueTitle: "Add pagination",
      issueUrl: null,
      stageName: "investigate",
      reworkCount: 0,
    });
    const blocks = result.blocks!;
    // header, section (title), section (fields with stage), context
    expect(blocks).toHaveLength(4);
    const fieldsBlock = blocks[2] as {
      type: "section";
      fields: Array<{ text: string }>;
    };
    expect(fieldsBlock.type).toBe("section");
    expect(fieldsBlock.fields[0]?.text).toContain("Stage: investigate");
  });

  it("issue_dispatched with rework shows rework field", () => {
    const result = formatNotification({
      type: "issue_dispatched",
      issueIdentifier: "SYMPH-42",
      issueTitle: "Add pagination",
      issueUrl: null,
      stageName: "implement",
      reworkCount: 2,
    });
    const blocks = result.blocks!;
    const fieldsBlock = blocks[2] as {
      type: "section";
      fields: Array<{ text: string }>;
    };
    expect(fieldsBlock.fields).toHaveLength(2);
    expect(fieldsBlock.fields[0]?.text).toContain("Stage: implement");
    expect(fieldsBlock.fields[1]?.text).toContain("Rework #2");
  });

  it("issue_dispatched includes right-sizing fields when present", () => {
    const result = formatNotification({
      type: "issue_dispatched",
      issueIdentifier: "SYMPH-42",
      issueTitle: "Add pagination",
      issueUrl: null,
      stageName: "implement",
      reworkCount: 1,
      rightSizingDecision: createRightSizingDecision({
        mode: "full",
        modelRouting: {
          allowed: true,
          reason: "risk_trigger",
        },
        triggerHits: ["high_risk_files", "repeat_retry"],
      }),
    });
    const blocks = result.blocks!;
    const fieldsBlock = blocks[2] as {
      type: "section";
      fields: Array<{ text: string }>;
    };

    expect(fieldsBlock.fields).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          text: expect.stringContaining("Mode: full"),
        }),
        expect.objectContaining({
          text: expect.stringContaining(
            "Model routing: allowed (risk_trigger)",
          ),
        }),
        expect.objectContaining({
          text: expect.stringContaining(
            "Triggers:* high_risk_files, repeat_retry",
          ),
        }),
      ]),
    );
  });

  it("issue_dispatched without rework omits rework field", () => {
    const result = formatNotification({
      type: "issue_dispatched",
      issueIdentifier: "SYMPH-42",
      issueTitle: "Add pagination",
      issueUrl: null,
      stageName: "investigate",
      reworkCount: 0,
    });
    const blocks = result.blocks!;
    const fieldsBlock = blocks[2] as {
      type: "section";
      fields: Array<{ text: string }>;
    };
    expect(fieldsBlock.fields).toHaveLength(1);
    expect(fieldsBlock.fields[0]?.text).not.toContain("Rework");
  });

  it("issue_dispatched with no stageName and reworkCount 0 omits fields section", () => {
    const result = formatNotification({
      type: "issue_dispatched",
      issueIdentifier: "SYMPH-99",
      issueTitle: "No fields edge case",
      issueUrl: null,
      stageName: null,
      reworkCount: 0,
    });
    const blocks = result.blocks!;
    // header + title section + context = 3 blocks (no fields section)
    expect(blocks).toHaveLength(3);
    expect(blocks[0]!.type).toBe("header");
    expect(blocks[1]!.type).toBe("section");
    expect(blocks[2]!.type).toBe("context");
    // No block should have a fields property
    for (const block of blocks) {
      expect((block as { fields?: unknown }).fields).toBeUndefined();
    }
  });

  // --- Block Kit tests for pipeline_started ---

  it("pipeline_started with dashboard URL returns Block Kit with header, dashboard link, and context", () => {
    const result = formatNotification({
      type: "pipeline_started",
      productName: "symphony",
      dashboardUrl: "http://localhost:3000",
    });
    expect(result.blocks).toBeDefined();
    const blocks = result.blocks!;
    // header, section (dashboard link), context
    expect(blocks).toHaveLength(3);

    const header = blocks[0] as { type: "header"; text: { text: string } };
    expect(header.type).toBe("header");
    expect(header.text.text).toContain("Pipeline started");
    expect(header.text.text).toContain("symphony");

    const dashSection = blocks[1] as {
      type: "section";
      text: { type: string; text: string };
    };
    expect(dashSection.type).toBe("section");
    expect(dashSection.text.text).toContain(
      "<http://localhost:3000|Dashboard>",
    );

    expect(blocks[2]?.type).toBe("context");
    const ctx = blocks[2] as {
      type: "context";
      elements: Array<{ text: string }>;
    };
    expect(ctx.elements[0]?.text).toContain("symphony-ts v");
  });

  it("pipeline_started without dashboard URL omits link section", () => {
    const result = formatNotification({
      type: "pipeline_started",
      productName: "symphony",
      dashboardUrl: null,
    });
    expect(result.blocks).toBeDefined();
    const blocks = result.blocks!;
    // header, context (no dashboard section)
    expect(blocks).toHaveLength(2);
    expect(blocks[0]?.type).toBe("header");
    expect(blocks[1]?.type).toBe("context");
  });

  // --- Block Kit tests for stall_killed ---

  it("stall_killed returns Block Kit with header, title, stage and duration fields, and context", () => {
    const result = formatNotification({
      type: "stall_killed",
      issueIdentifier: "SYMPH-42",
      issueTitle: "Add pagination",
      stageName: "implement",
      stallDurationMs: 900_000,
    });
    expect(result.blocks).toBeDefined();
    const blocks = result.blocks!;
    // header, section (title), section (fields), context
    expect(blocks).toHaveLength(4);

    const header = blocks[0] as { type: "header"; text: { text: string } };
    expect(header.type).toBe("header");
    expect(header.text.text).toContain("Stall killed");
    expect(header.text.text).toContain("SYMPH-42");

    const titleBlock = blocks[1] as {
      type: "section";
      text: { text: string };
    };
    expect(titleBlock.text.text).toBe("*Add pagination*");

    const fieldsBlock = blocks[2] as {
      type: "section";
      fields: Array<{ text: string }>;
    };
    expect(fieldsBlock.type).toBe("section");
    expect(fieldsBlock.fields).toHaveLength(2);
    expect(fieldsBlock.fields[0]?.text).toContain("Stage: implement");
    expect(fieldsBlock.fields[1]?.text).toContain("Stalled: 15m");

    expect(blocks[3]?.type).toBe("context");
  });

  it("stall_killed without stage name omits stage field", () => {
    const result = formatNotification({
      type: "stall_killed",
      issueIdentifier: "SYMPH-42",
      issueTitle: "Fix bug",
      stageName: null,
      stallDurationMs: 300_000,
    });
    expect(result.blocks).toBeDefined();
    const blocks = result.blocks!;
    // header, section (title), section (fields with duration only), context
    expect(blocks).toHaveLength(4);

    const fieldsBlock = blocks[2] as {
      type: "section";
      fields: Array<{ text: string }>;
    };
    expect(fieldsBlock.fields).toHaveLength(1);
    expect(fieldsBlock.fields[0]?.text).toContain("Stalled:");
    expect(fieldsBlock.fields[0]?.text).not.toContain("Stage:");
  });

  // --- Block Kit tests for infra_error ---

  it("infra_error returns Block Kit with header, title, error reason, and context", () => {
    const result = formatNotification({
      type: "infra_error",
      issueIdentifier: "SYMPH-42",
      issueTitle: "Add pagination",
      errorReason: "Failed to start agent process",
    });
    expect(result.blocks).toBeDefined();
    const blocks = result.blocks!;
    // header, section (title), section (error), context
    expect(blocks).toHaveLength(4);

    const header = blocks[0] as { type: "header"; text: { text: string } };
    expect(header.type).toBe("header");
    expect(header.text.text).toContain("Infra error");
    expect(header.text.text).toContain("SYMPH-42");

    const titleBlock = blocks[1] as {
      type: "section";
      text: { text: string };
    };
    expect(titleBlock.text.text).toBe("*Add pagination*");

    const errorBlock = blocks[2] as {
      type: "section";
      text: { text: string };
    };
    expect(errorBlock.text.text).toContain(
      "Error: Failed to start agent process",
    );

    expect(blocks[3]?.type).toBe("context");
  });

  // --- Block Kit tests for issue_dropped ---

  it("issue_dropped returns Block Kit with header, title with Linear link, reason, and context", () => {
    const result = formatNotification({
      type: "issue_dropped",
      issueIdentifier: "SYMPH-42",
      issueTitle: "Add pagination",
      issueUrl: "https://linear.app/mobilyze-llc/issue/SYMPH-42",
      reason: "issue no longer in candidate list",
    });
    expect(result.blocks).toBeDefined();
    const blocks = result.blocks!;
    // header, section (title + link), section (reason), context
    expect(blocks).toHaveLength(4);

    const header = blocks[0] as { type: "header"; text: { text: string } };
    expect(header.type).toBe("header");
    expect(header.text.text).toContain("Issue left pipeline");
    expect(header.text.text).toContain("SYMPH-42");

    const titleBlock = blocks[1] as {
      type: "section";
      text: { text: string };
    };
    expect(titleBlock.text.text).toContain("*Add pagination*");
    expect(titleBlock.text.text).toContain(
      "<https://linear.app/mobilyze-llc/issue/SYMPH-42|View in Linear>",
    );

    const reasonBlock = blocks[2] as {
      type: "section";
      text: { text: string };
    };
    expect(reasonBlock.text.text).toContain(
      "Reason: issue no longer in candidate list",
    );

    expect(blocks[3]?.type).toBe("context");
  });

  it("issue_dropped without URL omits View in Linear link", () => {
    const result = formatNotification({
      type: "issue_dropped",
      issueIdentifier: "SYMPH-42",
      issueTitle: "Add pagination",
      issueUrl: null,
      reason: "dropped",
    });
    expect(result.blocks).toBeDefined();
    const blocks = result.blocks!;
    // header, section (title only), section (reason), context
    expect(blocks).toHaveLength(4);

    const titleBlock = blocks[1] as {
      type: "section";
      text: { text: string };
    };
    expect(titleBlock.text.text).toBe("*Add pagination*");
    expect(titleBlock.text.text).not.toContain("View in Linear");
  });

  it("formats systemic_cluster_alert with breaker + watchdog and no raw error text", () => {
    const result = formatNotification({
      type: "systemic_cluster_alert",
      signature: "abc1234",
      errorClass: "permanent",
      stageName: "implement",
      clusterSize: 3,
      issueIdentifiers: ["SYMPH-1", "SYMPH-2", "SYMPH-3"],
      breakerOpened: true,
      watchdogTicketFiling: true,
    });
    expect(result.text).toContain("SYSTEMIC failure cluster");
    expect(result.text).toContain("abc1234");
    expect(result.text).toContain("permanent");
    expect(result.text).toContain("stage `implement`");
    expect(result.text).toContain("3 affected issues");
    expect(result.text).toContain("SYMPH-1, SYMPH-2, SYMPH-3");
    expect(result.text).toContain("Circuit breaker OPENED");
    expect(result.text).toContain("Watchdog ticket being filed");
  });

  it("systemic_cluster_alert omits breaker/watchdog lines when both false", () => {
    const result = formatNotification({
      type: "systemic_cluster_alert",
      signature: "def5678",
      errorClass: "unknown",
      stageName: null,
      clusterSize: 2,
      issueIdentifiers: ["SYMPH-9", "SYMPH-10"],
      breakerOpened: false,
      watchdogTicketFiling: false,
    });
    expect(result.text).toContain("unknown stage");
    expect(result.text).not.toContain("Circuit breaker OPENED");
    expect(result.text).not.toContain("Watchdog ticket being filed");
    // The raw normalized error text must never be embedded in the Slack
    // message — only the hash + class + affected issues are the egress surface.
    expect(result.text).not.toContain("```");
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

  it("delivers right-sizing details through the notifier post payload", async () => {
    const poster = createMockPoster();
    const notifier = new PipelineNotifier({
      channel: "C12345",
      poster,
    });

    notifier.notify({
      type: "issue_dispatched",
      issueIdentifier: "SYMPH-42",
      issueTitle: "Add pagination",
      issueUrl: null,
      stageName: "implement",
      reworkCount: 0,
      rightSizingDecision: createRightSizingDecision({
        mode: "prototype",
        modelRouting: {
          allowed: false,
          reason: "not_needed",
        },
        triggerHits: [],
      }),
    });

    await new Promise((resolve) => setTimeout(resolve, 10));

    expect(poster.calls).toHaveLength(1);
    expect(poster.calls[0]?.text).toContain("Mode: prototype");
    expect(poster.calls[0]?.text).toContain("Model routing: off (not_needed)");
    expect(JSON.stringify(poster.calls[0]?.blocks ?? [])).toContain(
      "Mode: prototype",
    );
  });
});

function createRightSizingDecision(input: {
  mode: "prototype" | "thin" | "full";
  modelRouting: {
    allowed: boolean;
    reason: "not_needed" | "ambiguous_routing" | "risk_trigger";
  };
  triggerHits: string[];
}) {
  return {
    classifier: "deterministic-v1" as const,
    mode: input.mode,
    stageName: "implement",
    reason: `Selected ${input.mode}`,
    rationale: [`${input.mode} rationale`],
    triggerHits: input.triggerHits,
    signals: {
      explicitModeHint: null,
      declaredScopeFiles: ["src/features/example.ts"],
      changedFiles: ["src/features/example.ts"],
      impactSurface: "narrow" as const,
      highRiskFiles: [],
      stageCount: 2,
      gateCount: 0,
      reviewerCount: 0,
      humanGateCount: 0,
      blockedByCount: 0,
      retryCount: 0,
      priority: null,
      labels: [],
      plannedTurns: 8,
      budget: "low" as const,
    },
    modelRouting: input.modelRouting,
  };
}

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

// ---------------------------------------------------------------------------
// SYMPH-397: watchdog / lifecycle alert event formatting
// ---------------------------------------------------------------------------

describe("formatNotification — watchdog events (SYMPH-397)", () => {
  it("formats failure_exhausted with signature and class", () => {
    const result = formatNotification({
      type: "failure_exhausted",
      issueIdentifier: "SYMPH-42",
      issueTitle: "Fix bug",
      issueUrl: "https://linear.app/mobilyze-llc/issue/SYMPH-42",
      stageName: "implement",
      reason: "max retries exceeded",
      failureSignature: "hash:abc123",
      failureClass: "permanent",
    });
    expect(result.text).toContain("Retries exhausted");
    expect(result.text).toContain("SYMPH-42");
    expect(result.text).toContain("Stage: implement");
    expect(result.text).toContain("Reason: max retries exceeded");
    expect(result.text).toContain("Signature: hash:abc123 (permanent)");
    expect(result.text).toContain(
      "<https://linear.app/mobilyze-llc/issue/SYMPH-42|SYMPH-42>",
    );
  });

  it("formats failure_exhausted without signature", () => {
    const result = formatNotification({
      type: "failure_exhausted",
      issueIdentifier: "SYMPH-42",
      issueTitle: "Fix bug",
      issueUrl: null,
      stageName: null,
      reason: "unrecoverable spec failure",
      failureSignature: null,
      failureClass: null,
    });
    expect(result.text).toContain("Retries exhausted");
    expect(result.text).not.toContain("Signature:");
    expect(result.text).not.toContain("Stage:");
  });

  it("formats hard_stop_budget with cost and token summary", () => {
    const result = formatNotification({
      type: "hard_stop_budget",
      issueIdentifier: "SYMPH-42",
      issueTitle: "Add pagination",
      issueUrl: null,
      stageName: "implement",
      trigger: "token_budget",
      reason: "Token budget exceeded.",
      totalTokens: 250_000,
      estimatedCostUsd: 3.21,
    });
    expect(result.text).toContain("Budget ceiling hit");
    expect(result.text).toContain("SYMPH-42");
    expect(result.text).toContain("Stage: implement");
    expect(result.text).toContain("token_budget");
    expect(result.text).toContain("$3.21");
    expect(result.text).toContain("250k tokens");
  });

  it("formats escalation_step with step/maxSteps and multiplier", () => {
    const result = formatNotification({
      type: "escalation_step",
      issueIdentifier: "SYMPH-42",
      issueTitle: "Add pagination",
      issueUrl: null,
      stageName: "implement",
      step: 2,
      maxSteps: 3,
      multiplier: 4,
      trigger: "token_budget",
    });
    expect(result.text).toContain("Budget escalation step 2/3");
    expect(result.text).toContain("SYMPH-42");
    expect(result.text).toContain("4x budget");
    expect(result.text).toContain("token_budget");
  });

  it("formats gate_failed with stage and reason", () => {
    const result = formatNotification({
      type: "gate_failed",
      issueIdentifier: "SYMPH-42",
      issueTitle: "Add pagination",
      issueUrl: "https://linear.app/mobilyze-llc/issue/SYMPH-42",
      stageName: "review",
      reason: "Ensemble review failed: missing tests",
    });
    expect(result.text).toContain("Gate failed");
    expect(result.text).toContain("SYMPH-42");
    expect(result.text).toContain("Stage: review");
    expect(result.text).toContain(
      "Reason: Ensemble review failed: missing tests",
    );
  });

  it("formats gate_failed without stage", () => {
    const result = formatNotification({
      type: "gate_failed",
      issueIdentifier: "SYMPH-42",
      issueTitle: "Add pagination",
      issueUrl: null,
      stageName: null,
      reason: "[STAGE_FAILED]",
    });
    expect(result.text).toContain("Gate failed");
    expect(result.text).not.toContain("Stage:");
  });

  it("formats info_alert with message", () => {
    const result = formatNotification({
      type: "info_alert",
      issueIdentifier: "SYMPH-42",
      message: "Some informational notice",
    });
    expect(result.text).toContain("SYMPH-42");
    expect(result.text).toContain("Some informational notice");
  });
});

describe("createWebhookPoster (SYMPH-397)", () => {
  it("POSTs JSON to the webhook URL with text payload", async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const mockFetch = vi.fn(async (url: string, init: RequestInit) => {
      calls.push({ url, init });
      return { ok: true } as Response;
    });
    const poster = createWebhookPoster({
      webhookUrl: "https://hooks.slack.com/services/TEST/WEBHOOK",
      // biome-ignore lint/suspicious/noExplicitAny: test override
      _fetchOverride: mockFetch as any,
    });
    await poster.post("ignored-channel", "Hello world");
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe("https://hooks.slack.com/services/TEST/WEBHOOK");
    const body = JSON.parse(calls[0]?.init.body as string) as { text: string };
    expect(body.text).toBe("Hello world");
  });

  it("throws when webhook returns non-ok status", async () => {
    const poster = createWebhookPoster({
      webhookUrl: "https://hooks.slack.com/services/TEST/WEBHOOK",
      // biome-ignore lint/suspicious/noExplicitAny: test override
      _fetchOverride: vi.fn(async () => ({ ok: false, status: 400 }) as any),
    });
    await expect(poster.post("c", "text")).rejects.toThrow("HTTP 400");
  });

  it("redacts secret URL from transport error — malformed URL does not appear in thrown message", async () => {
    // A malformed webhook URL containing a secret token would normally produce
    // "Failed to parse URL from http://hooks.slack.com/services/T00/SuperSecretToken123"
    // in the thrown error. The wrapper must collapse all transport errors to a
    // fixed, URL-free message so the secret cannot reach log aggregation.
    const secretToken = "SuperSecretToken123";
    const malformedUrl = `http://hooks.slack.com:bad/services/T00/${secretToken}`;
    const poster = createWebhookPoster({ webhookUrl: malformedUrl });
    await expect(poster.post("c", "text")).rejects.toSatisfy((err: unknown) => {
      const msg = err instanceof Error ? err.message : String(err);
      return !msg.includes(secretToken) && !msg.includes(malformedUrl);
    });
  });

  it("transport error is wrapped as 'Slack webhook delivery failed: <name>'", async () => {
    // Verify the fixed-message shape so callers can rely on it for alerting.
    const throwingFetch: typeof fetch = async () => {
      throw new TypeError("fetch failed");
    };
    const poster = createWebhookPoster({
      webhookUrl: "https://hooks.slack.com/services/TEST/WEBHOOK",
      _fetchOverride: throwingFetch,
    });
    await expect(poster.post("c", "text")).rejects.toThrow(
      "Slack webhook delivery failed: TypeError",
    );
  });

  it("AbortSignal timeout path wraps the error without leaking URL", async () => {
    // Simulate the AbortError that AbortSignal.timeout(5_000) would throw.
    const throwingFetch: typeof fetch = async () => {
      throw new DOMException(
        "The operation was aborted due to timeout",
        "TimeoutError",
      );
    };
    const poster = createWebhookPoster({
      webhookUrl: "https://hooks.slack.com/services/TEST/WEBHOOK",
      _fetchOverride: throwingFetch,
    });
    await expect(poster.post("c", "text")).rejects.toThrow(
      "Slack webhook delivery failed: TimeoutError",
    );
  });
});

describe("PipelineNotifier — fail-open contract (SYMPH-397)", () => {
  it("notify() swallows a rejecting webhook poster and does not throw", async () => {
    // The notifier's fail-open guarantee must hold even when the poster rejects.
    const rejector = createWebhookPoster({
      webhookUrl: "https://hooks.slack.com/services/FAKE/WEBHOOK",
      // biome-ignore lint/suspicious/noExplicitAny: test override
      _fetchOverride: vi.fn(async () => ({ ok: false, status: 503 }) as any),
    });
    const errors: unknown[] = [];
    const notifier = new PipelineNotifier({
      channel: "webhook",
      poster: rejector,
      onError: (err) => errors.push(err),
    });

    // Must not throw synchronously or asynchronously
    notifier.notify({
      type: "pipeline_started",
      productName: "test",
      dashboardUrl: null,
    });

    await notifier.flush(200);

    // Error was captured by onError, not propagated
    expect(errors).toHaveLength(1);
    expect((errors[0] as Error).message).toContain("HTTP 503");
  });
});

describe("formatNotification — tracker_write_failed (SYMPH-413)", () => {
  it("formats tracker_write_failed with status, sources, and serialized details", () => {
    const result = formatNotification({
      type: "tracker_write_failed",
      followUpTitle: "Dispatcher follow-up: branch_divergence for SYMPH-332",
      sourceIssueIds: ["7fe4ed29-b2ea-492f-9263-25c1e34c43ec"],
      reason: "Linear API request failed with HTTP 400.",
      httpStatus: 400,
      details:
        '{"errors":[{"extensions":{"code":"GRAPHQL_VALIDATION_FAILED"}}]}',
    });
    expect(result.text).toContain("Tracker follow-up write failed");
    expect(result.text).toContain("(HTTP 400)");
    expect(result.text).toContain(
      "Dispatcher follow-up: branch_divergence for SYMPH-332",
    );
    expect(result.text).toContain(
      "Source issues: 7fe4ed29-b2ea-492f-9263-25c1e34c43ec",
    );
    expect(result.text).toContain(
      "Reason: Linear API request failed with HTTP 400.",
    );
    expect(result.text).toContain("GRAPHQL_VALIDATION_FAILED");
    expect(result.text).not.toContain("[object Object]");
  });

  it("formats tracker_write_failed without status or details", () => {
    const result = formatNotification({
      type: "tracker_write_failed",
      followUpTitle: "Dispatcher follow-up: stale promotion",
      sourceIssueIds: [],
      reason: "tracker unavailable",
      httpStatus: null,
      details: null,
    });
    expect(result.text).toContain("Tracker follow-up write failed");
    expect(result.text).not.toContain("HTTP");
    expect(result.text).toContain("Source issues: none");
    expect(result.text).toContain("Reason: tracker unavailable");
    expect(result.text).not.toContain("Details:");
  });
});

describe("egress sanitization retrofit (SYMPH-421)", () => {
  it("sanitizes issue_failed free-text reason in text and blocks", () => {
    const longTail = "z".repeat(1_000);
    const result = formatNotification({
      type: "issue_failed",
      issueIdentifier: "SYMPH-1",
      issueTitle: "A title",
      issueUrl: null,
      failureReason: `worker said <https://evil.example|click> with GH_TOKEN=ghp_fake123 ${longTail}`,
      retriesExhausted: false,
      retryAttempt: null,
    });
    expect(result.text).toContain("&lt;https://evil.example|click&gt;");
    expect(result.text).toContain("GH_TOKEN=[REDACTED]");
    expect(result.text).not.toContain("ghp_fake123");
    expect(result.text).toContain("[truncated by egress cap]");
    const reasonBlock = (result.blocks ?? []).find(
      (block) =>
        block.type === "section" &&
        block.text !== undefined &&
        block.text.text.startsWith("Reason:"),
    );
    expect(reasonBlock).toBeDefined();
    if (reasonBlock?.type === "section" && reasonBlock.text !== undefined) {
      expect(reasonBlock.text.text).toContain("GH_TOKEN=[REDACTED]");
      expect(reasonBlock.text.text).toContain(
        "&lt;https://evil.example|click&gt;",
      );
    }
  });

  it("leaves a clean issue_failed reason byte-identical", () => {
    const clean = "agent reported failure: review";
    const result = formatNotification({
      type: "issue_failed",
      issueIdentifier: "SYMPH-1",
      issueTitle: "A title",
      issueUrl: null,
      failureReason: clean,
      retriesExhausted: false,
      retryAttempt: null,
    });
    expect(result.text).toContain(`Reason: ${clean}`);
  });

  it("sanitizes the watchdog reason fields and info_alert message", () => {
    const hostile = "park reason with secret=abc and <!channel> ping";
    for (const event of [
      {
        type: "failure_exhausted",
        issueIdentifier: "SYMPH-1",
        issueTitle: "T",
        issueUrl: null,
        stageName: null,
        reason: hostile,
        failureSignature: null,
        failureClass: null,
      },
      {
        type: "hard_stop_budget",
        issueIdentifier: "SYMPH-1",
        issueTitle: "T",
        issueUrl: null,
        stageName: null,
        trigger: "token_budget",
        reason: hostile,
        totalTokens: 1,
        estimatedCostUsd: 0,
      },
      {
        type: "gate_failed",
        issueIdentifier: "SYMPH-1",
        issueTitle: "T",
        issueUrl: null,
        stageName: null,
        reason: hostile,
      },
      {
        type: "issue_dropped",
        issueIdentifier: "SYMPH-1",
        issueTitle: "T",
        issueUrl: null,
        reason: hostile,
      },
    ] satisfies PipelineNotificationEvent[]) {
      const result = formatNotification(event);
      expect(result.text).toContain("secret=[REDACTED]");
      expect(result.text).toContain("&lt;!channel&gt;");
      expect(result.text).not.toContain("<!channel>");
    }

    const info = formatNotification({
      type: "info_alert",
      issueIdentifier: "SYMPH-1",
      message: "note with api-key=oops and <!here>",
    });
    expect(info.text).toContain("api-key=[REDACTED]");
    expect(info.text).toContain("&lt;!here&gt;");

    const infra = formatNotification({
      type: "infra_error",
      issueIdentifier: "SYMPH-1",
      issueTitle: "T",
      errorReason: "spawn failed: token=tok_123 <runaway>",
    });
    expect(infra.text).toContain("token=[REDACTED]");
    expect(infra.text).toContain("&lt;runaway&gt;");
  });
});

describe("formatNotification triage_escalation (SYMPH-399)", () => {
  it("formats the L2 escalation with classification, case, and attribution", () => {
    const result = formatNotification({
      type: "triage_escalation",
      issueIdentifier: "SYMPH-332",
      issueTitle: "Council gate loops review stage",
      issueUrl: "https://linear.app/x/issue/SYMPH-332",
      stageName: "review",
      classification: "infra",
      confidence: "high",
      caseText:
        "EPERM recurs across attempts with rotating temp paths; a human needs to inspect the host.",
      attribution: "by watchdog-l2@pro14",
    });

    expect(result.text).toContain("Stuck-triage escalation");
    expect(result.text).toContain(
      "<https://linear.app/x/issue/SYMPH-332|SYMPH-332>",
    );
    expect(result.text).toContain("Stage: review");
    expect(result.text).toContain("Classification: infra (confidence: high)");
    expect(result.text).toContain("by watchdog-l2@pro14");
    expect(result.text).toContain("a human needs to inspect the host");
  });

  it("sanitizes a hostile caseText (mrkdwn injection, credentials, 50k length)", () => {
    const result = formatNotification({
      type: "triage_escalation",
      issueIdentifier: "SYMPH-332",
      issueTitle: "Council gate loops review stage",
      issueUrl: null,
      stageName: null,
      classification: "infra",
      confidence: "high",
      caseText: `ping <!channel> & set slack_token=xoxb-fake-1234 ${"w".repeat(50_000)}`,
      attribution: "by watchdog-l2@pro14",
    });

    expect(result.text).toContain("&lt;!channel&gt;");
    expect(result.text).not.toContain("<!channel>");
    expect(result.text).toContain("slack_token=[REDACTED]");
    expect(result.text).not.toContain("xoxb-fake-1234");
    // Field-level Slack cap bounds the case line; the version trailer survives.
    expect(result.text).toContain("[truncated by egress cap]");
    expect(result.text.length).toBeLessThan(2000);
  });
});
