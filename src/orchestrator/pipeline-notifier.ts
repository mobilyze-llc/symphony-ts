/**
 * Pipeline notification module.
 *
 * Best-effort Slack notifications for high-value pipeline events.
 * Failures are logged and swallowed — never affect pipeline correctness.
 */

import type { ExecutionHistory, RightSizingDecision } from "../domain/model.js";
import { sanitizeForSlack } from "../shared/egress.js";
import { getDisplayVersion } from "../version.js";

// ---------------------------------------------------------------------------
// Block Kit types (minimal inline — avoids @slack/types dependency)
// ---------------------------------------------------------------------------

export interface SlackTextObject {
  type: "plain_text" | "mrkdwn";
  text: string;
  emoji?: boolean;
}

export interface SlackHeaderBlock {
  type: "header";
  text: SlackTextObject;
}

export interface SlackSectionBlock {
  type: "section";
  text?: SlackTextObject;
  fields?: SlackTextObject[];
}

export interface SlackDividerBlock {
  type: "divider";
}

export interface SlackContextBlock {
  type: "context";
  elements: SlackTextObject[];
}

export type SlackBlock =
  | SlackHeaderBlock
  | SlackSectionBlock
  | SlackDividerBlock
  | SlackContextBlock;

// ---------------------------------------------------------------------------
// Formatted notification result
// ---------------------------------------------------------------------------

export interface FormattedNotification {
  text: string;
  blocks?: SlackBlock[];
}

// ---------------------------------------------------------------------------
// Event types (discriminated union)
// ---------------------------------------------------------------------------

export interface PipelineStartedEvent {
  type: "pipeline_started";
  productName: string;
  dashboardUrl: string | null;
}

export interface PipelineStoppedEvent {
  type: "pipeline_stopped";
  productName: string;
  completedCount: number;
  failedCount: number;
  durationMs: number;
}

export interface IssueCompletedEvent {
  type: "issue_completed";
  issueIdentifier: string;
  issueTitle: string;
  issueUrl: string | null;
  executionHistory: ExecutionHistory;
  reworkCount: number;
  totalTokens: number;
  totalDurationMs: number;
}

export interface IssueFailedEvent {
  type: "issue_failed";
  issueIdentifier: string;
  issueTitle: string;
  issueUrl: string | null;
  failureReason: string | null;
  retriesExhausted: boolean;
  retryAttempt: number | null;
}

export interface StallKilledEvent {
  type: "stall_killed";
  issueIdentifier: string;
  issueTitle: string;
  stageName: string | null;
  stallDurationMs: number;
}

export interface InfraErrorEvent {
  type: "infra_error";
  issueIdentifier: string;
  issueTitle: string;
  errorReason: string;
}

export interface IssueDispatchedEvent {
  type: "issue_dispatched";
  issueIdentifier: string;
  issueTitle: string;
  issueUrl: string | null;
  stageName: string | null;
  reworkCount: number;
  rightSizingDecision?: RightSizingDecision;
}

export interface IssueDroppedEvent {
  type: "issue_dropped";
  issueIdentifier: string;
  issueTitle: string;
  issueUrl: string | null;
  reason: string;
}

// ---------------------------------------------------------------------------
// Watchdog / lifecycle alert events (SYMPH-397)
// ---------------------------------------------------------------------------

/**
 * Fired when an issue's retry budget is exhausted or it is parked for
 * operator review (includes loud-parking via the novelty short-circuit).
 * severity: critical
 */
export interface FailureExhaustedEvent {
  type: "failure_exhausted";
  issueIdentifier: string;
  issueTitle: string;
  issueUrl: string | null;
  stageName: string | null;
  reason: string;
  /** Normalized failure signature when available (from SYMPH-396). */
  failureSignature: string | null;
  /** Failure class when available. */
  failureClass: string | null;
}

/**
 * Fired when a hard stop pauses an issue due to hitting the budget ceiling
 * (token, dollar, or window-% limit) and the escalation ladder could not
 * absorb it.
 * severity: warning
 */
export interface HardStopBudgetEvent {
  type: "hard_stop_budget";
  issueIdentifier: string;
  issueTitle: string;
  issueUrl: string | null;
  stageName: string | null;
  trigger: string;
  reason: string;
  totalTokens: number;
  estimatedCostUsd: number;
}

/**
 * Fired for each step of the deterministic budget-escalation ladder.
 * severity: info
 */
export interface EscalationStepEvent {
  type: "escalation_step";
  issueIdentifier: string;
  issueTitle: string;
  issueUrl: string | null;
  stageName: string | null;
  step: number;
  maxSteps: number;
  multiplier: number;
  trigger: string;
}

/**
 * Fired when an ensemble gate returns ERROR or [STAGE_FAILED].
 * severity: warning
 */
export interface GateFailedEvent {
  type: "gate_failed";
  issueIdentifier: string;
  issueTitle: string;
  issueUrl: string | null;
  stageName: string | null;
  reason: string;
}

/**
 * Info-tier alert event.
 * severity: info
 */
export interface InfoAlertEvent {
  type: "info_alert";
  issueIdentifier: string;
  message: string;
}

/**
 * Fired when a normalized failure signature has been seen in K>=threshold
 * distinct issues — declared SYSTEMIC (SYMPH-398).
 * severity: critical
 * Re-fires when the cluster grows beyond the last-alerted size.
 */
export interface SystemicClusterAlertEvent {
  type: "systemic_cluster_alert";
  /** 7-char signature hash. */
  signature: string;
  /** Failure class: permanent | transient | unknown. */
  errorClass: string;
  /** Affected stage name, or null if unknown. */
  stageName: string | null;
  /** Number of distinct issues in the cluster. */
  clusterSize: number;
  /** Identifiers of all affected issues. */
  issueIdentifiers: string[];
  /** Whether the stage circuit breaker is being opened. */
  breakerOpened: boolean;
  /** Whether a watchdog ticket is being filed. */
  watchdogTicketFiling: boolean;
}

/**
 * Fired when a dispatcher follow-up issue write to the tracker fails
 * (SYMPH-413). Without this alert, supervision findings (e.g.
 * branch_divergence) silently never reach the board.
 * severity: warning
 */
export interface TrackerWriteFailedEvent {
  type: "tracker_write_failed";
  /** Title of the follow-up issue that failed to write. */
  followUpTitle: string;
  /** Identifiers/IDs of the source issues the follow-up was filed for. */
  sourceIssueIds: string[];
  reason: string;
  httpStatus: number | null;
  /** Bounded, pre-serialized tracker error details (never raw objects). */
  details: string | null;
}

/**
 * Fired when the watchdog L2 stuck-triage lane escalates a parked ticket to
 * a human with the model's one-paragraph case (SYMPH-399).
 * severity: critical
 */
export interface TriageEscalationEvent {
  type: "triage_escalation";
  issueIdentifier: string;
  issueTitle: string;
  issueUrl: string | null;
  stageName: string | null;
  classification: string;
  confidence: string;
  /** The model's one-paragraph case for paging a human. */
  caseText: string;
  /** Rendered actor attribution, e.g. "by watchdog-l2@pro14". */
  attribution: string;
}

export type PipelineNotificationEvent =
  | PipelineStartedEvent
  | PipelineStoppedEvent
  | IssueCompletedEvent
  | IssueFailedEvent
  | StallKilledEvent
  | InfraErrorEvent
  | IssueDispatchedEvent
  | IssueDroppedEvent
  | FailureExhaustedEvent
  | HardStopBudgetEvent
  | EscalationStepEvent
  | GateFailedEvent
  | InfoAlertEvent
  | SystemicClusterAlertEvent
  | TrackerWriteFailedEvent
  | TriageEscalationEvent;

// ---------------------------------------------------------------------------
// Formatting helpers
// ---------------------------------------------------------------------------

export function formatDurationMs(ms: number): string {
  const totalSeconds = Math.round(ms / 1000);
  if (totalSeconds < 60) {
    return `${totalSeconds}s`;
  }
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  if (minutes < 60) {
    return seconds > 0 ? `${minutes}m ${seconds}s` : `${minutes}m`;
  }
  const hours = Math.floor(minutes / 60);
  const remainingMinutes = minutes % 60;
  return remainingMinutes > 0 ? `${hours}h ${remainingMinutes}m` : `${hours}h`;
}

export function formatStageTimeline(history: ExecutionHistory): string {
  if (history.length === 0) {
    return "_No stage data_";
  }

  return history
    .map(
      (record) =>
        `${record.stageName}: ${formatDurationMs(record.durationMs)} · ${record.totalTokens.toLocaleString("en-US")} tokens · ${record.outcome}`,
    )
    .join("\n");
}

function formatCompactUnit(value: number, suffix: string): string {
  const rounded = Math.round(value * 10) / 10;
  return `${rounded % 1 === 0 ? rounded.toFixed(0) : rounded.toFixed(1)}${suffix}`;
}

export function formatTokensCompact(tokens: number): string {
  if (tokens >= 1_000_000) return formatCompactUnit(tokens / 1_000_000, "M");
  if (tokens >= 1_000) return formatCompactUnit(tokens / 1_000, "k");
  return `${tokens}`;
}

function formatRightSizingRouting(decision: RightSizingDecision): string {
  const prefix = decision.modelRouting.allowed ? "allowed" : "off";
  return `${prefix} (${decision.modelRouting.reason})`;
}

function buildRightSizingLines(decision: RightSizingDecision): {
  textLines: string[];
  fields: SlackTextObject[];
} {
  const textLines = [
    `Mode: ${decision.mode}`,
    `Model routing: ${formatRightSizingRouting(decision)}`,
  ];
  const fields: SlackTextObject[] = [
    {
      type: "mrkdwn",
      text: `:straight_ruler: *Mode: ${decision.mode}*`,
    },
    {
      type: "mrkdwn",
      text: `:compass: *Model routing: ${formatRightSizingRouting(decision)}*`,
    },
  ];

  if (decision.triggerHits.length > 0) {
    const triggers = decision.triggerHits.join(", ");
    textLines.push(`Triggers: ${triggers}`);
    fields.push({
      type: "mrkdwn",
      text: `:triangular_flag_on_post: *Triggers:* ${triggers}`,
    });
  }

  return { textLines, fields };
}

// ---------------------------------------------------------------------------
// Message formatter
// ---------------------------------------------------------------------------

export function formatNotification(
  event: PipelineNotificationEvent,
): FormattedNotification {
  const version = `_symphony-ts v${getDisplayVersion()}_`;

  switch (event.type) {
    case "pipeline_started": {
      const parts = [`:rocket: *Pipeline started* — ${event.productName}`];
      if (event.dashboardUrl !== null) {
        parts.push(`Dashboard: ${event.dashboardUrl}`);
      }
      parts.push(version);
      const text = parts.join("\n");

      const blocks: SlackBlock[] = [
        {
          type: "header",
          text: {
            type: "plain_text",
            text: `🚀 Pipeline started — ${event.productName}`,
            emoji: true,
          },
        },
      ];
      if (event.dashboardUrl !== null) {
        blocks.push({
          type: "section",
          text: {
            type: "mrkdwn",
            text: `<${event.dashboardUrl}|Dashboard>`,
          },
        });
      }
      blocks.push({
        type: "context",
        elements: [{ type: "mrkdwn", text: version }],
      });

      return { text, blocks };
    }

    case "pipeline_stopped": {
      const total = event.completedCount + event.failedCount;
      const text = [
        `:stop_sign: *Pipeline stopped* — ${event.productName}`,
        `Completed: ${event.completedCount} · Failed: ${event.failedCount} · Total: ${total}`,
        `Duration: ${formatDurationMs(event.durationMs)}`,
        version,
      ].join("\n");

      const blocks: SlackBlock[] = [
        {
          type: "header",
          text: {
            type: "plain_text",
            text: `🛑 Pipeline stopped — ${event.productName}`,
            emoji: true,
          },
        },
        { type: "divider" },
        {
          type: "section",
          fields: [
            {
              type: "mrkdwn",
              text: `:white_check_mark: *${event.completedCount} completed*`,
            },
            {
              type: "mrkdwn",
              text: `:x: *${event.failedCount} failed*`,
            },
            {
              type: "mrkdwn",
              text: `:bar_chart: *${total} total*`,
            },
          ],
        },
        {
          type: "section",
          fields: [
            {
              type: "mrkdwn",
              text: `:stopwatch: *${formatDurationMs(event.durationMs)}*`,
            },
          ],
        },
        {
          type: "context",
          elements: [{ type: "mrkdwn", text: version }],
        },
      ];

      return { text, blocks };
    }

    case "issue_completed": {
      const parts = [
        `:white_check_mark: *Issue completed* — ${event.issueIdentifier}`,
        `*${event.issueTitle}*`,
      ];
      if (event.issueUrl !== null) {
        parts.push(event.issueUrl);
      }
      if (event.executionHistory.length > 0) {
        parts.push("", formatStageTimeline(event.executionHistory));
      }
      parts.push(
        "",
        `Total: ${formatDurationMs(event.totalDurationMs)} · ${event.totalTokens.toLocaleString("en-US")} tokens`,
      );
      if (event.reworkCount > 0) {
        parts.push(`Rework cycles: ${event.reworkCount}`);
      }
      parts.push(version);
      const text = parts.join("\n");

      // Build Block Kit layout for issue_completed
      const blocks: SlackBlock[] = [
        {
          type: "header",
          text: {
            type: "plain_text",
            text: `✅ Issue completed — ${event.issueIdentifier}`,
            emoji: true,
          },
        },
        {
          type: "section",
          text: {
            type: "mrkdwn",
            text:
              event.issueUrl !== null
                ? `*<${event.issueUrl}|${event.issueTitle}>*`
                : `*${event.issueTitle}*`,
          },
        },
      ];

      if (event.executionHistory.length > 0) {
        blocks.push({ type: "divider" });
        const stageLines = event.executionHistory
          .map(
            (record) =>
              `\`${record.stageName}\` ${formatDurationMs(record.durationMs)} · ${formatTokensCompact(record.totalTokens)} tokens · ${record.outcome}`,
          )
          .join("\n");
        blocks.push({
          type: "section",
          text: { type: "mrkdwn", text: stageLines },
        });
      }

      blocks.push({ type: "divider" });

      const totalLine = `*Total:* ${formatDurationMs(event.totalDurationMs)} · ${formatTokensCompact(event.totalTokens)} tokens`;
      const summaryParts = [totalLine];
      if (event.reworkCount > 0) {
        summaryParts.push(`Rework cycles: ${event.reworkCount}`);
      }
      blocks.push({
        type: "section",
        text: { type: "mrkdwn", text: summaryParts.join("\n") },
      });

      blocks.push({
        type: "context",
        elements: [{ type: "mrkdwn", text: version }],
      });

      return { text, blocks };
    }

    case "issue_failed": {
      // Free-text failure reasons can carry worker/model-authored content;
      // sanitize once and reuse (SYMPH-421).
      const failureReason =
        event.failureReason === null
          ? null
          : sanitizeForSlack(event.failureReason);
      const parts = [
        `:x: *Issue failed* — ${event.issueIdentifier}`,
        `*${event.issueTitle}*`,
      ];
      if (event.issueUrl !== null) {
        parts.push(event.issueUrl);
      }
      if (failureReason !== null) {
        parts.push(`Reason: ${failureReason}`);
      }
      if (event.retriesExhausted) {
        parts.push(`Retries exhausted (attempt ${event.retryAttempt ?? "?"})`);
      }
      parts.push(version);
      const text = parts.join("\n");

      const titleText =
        event.issueUrl !== null
          ? `*${event.issueTitle}*\n<${event.issueUrl}|View in Linear>`
          : `*${event.issueTitle}*`;

      const blocks: SlackBlock[] = [
        {
          type: "header",
          text: {
            type: "plain_text",
            text: `❌ Issue failed — ${event.issueIdentifier}`,
            emoji: true,
          },
        },
        {
          type: "section",
          text: { type: "mrkdwn", text: titleText },
        },
        { type: "divider" },
      ];

      if (failureReason !== null) {
        blocks.push({
          type: "section",
          text: {
            type: "mrkdwn",
            text: `Reason: ${failureReason}`,
          },
        });
      }

      if (event.retriesExhausted) {
        blocks.push({
          type: "section",
          fields: [
            {
              type: "mrkdwn",
              text: `:repeat: *Retries exhausted (attempt ${event.retryAttempt ?? "?"})*`,
            },
          ],
        });
      }

      blocks.push({
        type: "context",
        elements: [{ type: "mrkdwn", text: version }],
      });

      return { text, blocks };
    }

    case "stall_killed": {
      const parts = [
        `:warning: *Stall killed* — ${event.issueIdentifier}`,
        `*${event.issueTitle}*`,
      ];
      if (event.stageName !== null) {
        parts.push(`Stage: ${event.stageName}`);
      }
      parts.push(`Stalled for: ${formatDurationMs(event.stallDurationMs)}`);
      parts.push(version);
      const text = parts.join("\n");

      const blocks: SlackBlock[] = [
        {
          type: "header",
          text: {
            type: "plain_text",
            text: `⚠️ Stall killed — ${event.issueIdentifier}`,
            emoji: true,
          },
        },
        {
          type: "section",
          text: { type: "mrkdwn", text: `*${event.issueTitle}*` },
        },
      ];

      const fields: SlackTextObject[] = [];
      if (event.stageName !== null) {
        fields.push({
          type: "mrkdwn",
          text: `:stop_sign: Stage: ${event.stageName}`,
        });
      }
      fields.push({
        type: "mrkdwn",
        text: `:clock3: Stalled: ${formatDurationMs(event.stallDurationMs)}`,
      });
      blocks.push({ type: "section", fields });

      blocks.push({
        type: "context",
        elements: [{ type: "mrkdwn", text: version }],
      });

      return { text, blocks };
    }

    case "infra_error": {
      const errorReason = sanitizeForSlack(event.errorReason);
      const text = [
        `:rotating_light: *Infra error* — ${event.issueIdentifier}`,
        `*${event.issueTitle}*`,
        `Error: ${errorReason}`,
        version,
      ].join("\n");

      const blocks: SlackBlock[] = [
        {
          type: "header",
          text: {
            type: "plain_text",
            text: `🚨 Infra error — ${event.issueIdentifier}`,
            emoji: true,
          },
        },
        {
          type: "section",
          text: { type: "mrkdwn", text: `*${event.issueTitle}*` },
        },
        {
          type: "section",
          text: { type: "mrkdwn", text: `Error: ${errorReason}` },
        },
        {
          type: "context",
          elements: [{ type: "mrkdwn", text: version }],
        },
      ];

      return { text, blocks };
    }

    case "issue_dispatched": {
      const parts = [
        `:arrow_forward: *Issue dispatched* — ${event.issueIdentifier}`,
        `*${event.issueTitle}*`,
      ];
      if (event.issueUrl !== null) {
        parts.push(event.issueUrl);
      }
      if (event.stageName !== null) {
        parts.push(`Stage: ${event.stageName}`);
      }
      if (event.reworkCount > 0) {
        parts.push(`Rework #${event.reworkCount}`);
      }
      if (event.rightSizingDecision !== undefined) {
        parts.push(
          ...buildRightSizingLines(event.rightSizingDecision).textLines,
        );
      }
      parts.push(version);
      const text = parts.join("\n");

      const titleText =
        event.issueUrl !== null
          ? `*${event.issueTitle}*\n<${event.issueUrl}|View in Linear>`
          : `*${event.issueTitle}*`;

      const blocks: SlackBlock[] = [
        {
          type: "header",
          text: {
            type: "plain_text",
            text: `▶️ Issue dispatched — ${event.issueIdentifier}`,
            emoji: true,
          },
        },
        {
          type: "section",
          text: { type: "mrkdwn", text: titleText },
        },
      ];

      const fields: SlackTextObject[] = [];
      if (event.stageName !== null) {
        fields.push({
          type: "mrkdwn",
          text: `:gear: *Stage: ${event.stageName}*`,
        });
      }
      if (event.reworkCount > 0) {
        fields.push({
          type: "mrkdwn",
          text: `:repeat: *Rework #${event.reworkCount}*`,
        });
      }
      if (event.rightSizingDecision !== undefined) {
        fields.push(...buildRightSizingLines(event.rightSizingDecision).fields);
      }
      if (fields.length > 0) {
        blocks.push({ type: "section", fields });
      }

      blocks.push({
        type: "context",
        elements: [{ type: "mrkdwn", text: version }],
      });

      return { text, blocks };
    }

    case "issue_dropped": {
      const dropReason = sanitizeForSlack(event.reason);
      const parts = [
        `:stop_button: *Issue left pipeline* — ${event.issueIdentifier}`,
        `*${event.issueTitle}*`,
      ];
      if (event.issueUrl !== null) {
        parts.push(event.issueUrl);
      }
      parts.push(`Reason: ${dropReason}`);
      parts.push(version);
      const text = parts.join("\n");

      const titleText =
        event.issueUrl !== null
          ? `*${event.issueTitle}*\n<${event.issueUrl}|View in Linear>`
          : `*${event.issueTitle}*`;

      const blocks: SlackBlock[] = [
        {
          type: "header",
          text: {
            type: "plain_text",
            text: `⏹️ Issue left pipeline — ${event.issueIdentifier}`,
            emoji: true,
          },
        },
        {
          type: "section",
          text: { type: "mrkdwn", text: titleText },
        },
        {
          type: "section",
          text: { type: "mrkdwn", text: `Reason: ${dropReason}` },
        },
        {
          type: "context",
          elements: [{ type: "mrkdwn", text: version }],
        },
      ];

      return { text, blocks };
    }

    // -----------------------------------------------------------------------
    // Watchdog / lifecycle alert events (SYMPH-397)
    // -----------------------------------------------------------------------

    case "failure_exhausted": {
      const exhaustedReason = sanitizeForSlack(event.reason);
      const issueLine =
        event.issueUrl !== null
          ? `<${event.issueUrl}|${event.issueIdentifier}>: ${event.issueTitle}`
          : `${event.issueIdentifier}: ${event.issueTitle}`;
      const parts: string[] = [
        `:rotating_light: *Retries exhausted* — ${issueLine}`,
      ];
      if (event.stageName !== null) {
        parts.push(`Stage: ${event.stageName}`);
      }
      parts.push(`Reason: ${exhaustedReason}`);
      if (event.failureSignature !== null) {
        const classSuffix =
          event.failureClass !== null ? ` (${event.failureClass})` : "";
        parts.push(`Signature: ${event.failureSignature}${classSuffix}`);
      }
      parts.push(version);
      return { text: parts.join("\n") };
    }

    case "hard_stop_budget": {
      const hardStopReason = sanitizeForSlack(event.reason);
      const issueLine =
        event.issueUrl !== null
          ? `<${event.issueUrl}|${event.issueIdentifier}>: ${event.issueTitle}`
          : `${event.issueIdentifier}: ${event.issueTitle}`;
      const parts: string[] = [`:warning: *Budget ceiling hit* — ${issueLine}`];
      if (event.stageName !== null) {
        parts.push(`Stage: ${event.stageName}`);
      }
      parts.push(
        `Trigger: ${event.trigger} · ~$${event.estimatedCostUsd.toFixed(2)} · ${formatTokensCompact(event.totalTokens)} tokens`,
      );
      parts.push(`Reason: ${hardStopReason}`);
      parts.push(version);
      return { text: parts.join("\n") };
    }

    case "escalation_step": {
      const issueLine =
        event.issueUrl !== null
          ? `<${event.issueUrl}|${event.issueIdentifier}>: ${event.issueTitle}`
          : `${event.issueIdentifier}: ${event.issueTitle}`;
      const parts: string[] = [
        `:ladder: *Budget escalation step ${event.step}/${event.maxSteps}* — ${issueLine}`,
      ];
      if (event.stageName !== null) {
        parts.push(`Stage: ${event.stageName}`);
      }
      parts.push(
        `Auto-resuming at ${event.multiplier}x budget after ${event.trigger}`,
      );
      parts.push(version);
      return { text: parts.join("\n") };
    }

    case "gate_failed": {
      const gateReason = sanitizeForSlack(event.reason);
      const issueLine =
        event.issueUrl !== null
          ? `<${event.issueUrl}|${event.issueIdentifier}>: ${event.issueTitle}`
          : `${event.issueIdentifier}: ${event.issueTitle}`;
      const parts: string[] = [`:x: *Gate failed* — ${issueLine}`];
      if (event.stageName !== null) {
        parts.push(`Stage: ${event.stageName}`);
      }
      parts.push(`Reason: ${gateReason}`);
      parts.push(version);
      return { text: parts.join("\n") };
    }

    case "info_alert": {
      return {
        text: `:information_source: *${event.issueIdentifier}* — ${sanitizeForSlack(event.message)}\n${version}`,
      };
    }

    case "triage_escalation": {
      const issueLine =
        event.issueUrl !== null
          ? `<${event.issueUrl}|${event.issueIdentifier}>: ${event.issueTitle}`
          : `${event.issueIdentifier}: ${event.issueTitle}`;
      const parts: string[] = [
        `:rotating_light: *Stuck-triage escalation* — ${issueLine}`,
      ];
      if (event.stageName !== null) {
        parts.push(`Stage: ${event.stageName}`);
      }
      parts.push(
        `Classification: ${event.classification} (confidence: ${event.confidence}) · ${event.attribution}`,
      );
      // caseText is the model's verbatim rationale (SYMPH-421).
      parts.push(`Case: ${sanitizeForSlack(event.caseText)}`);
      parts.push(version);
      return { text: parts.join("\n") };
    }

    case "systemic_cluster_alert": {
      const stageLabel =
        event.stageName !== null
          ? `stage \`${event.stageName}\``
          : "unknown stage";
      const issueList =
        event.issueIdentifiers.length > 0
          ? event.issueIdentifiers.join(", ")
          : "none";
      const parts: string[] = [
        `:rotating_light: *SYSTEMIC failure cluster* — signature \`${event.signature}\``,
        `Class: \`${event.errorClass}\` · ${stageLabel} · ${event.clusterSize} affected issues`,
        `Issues: ${issueList}`,
      ];
      if (event.breakerOpened) {
        parts.push(`:electric_plug: Circuit breaker OPENED for ${stageLabel}`);
      }
      if (event.watchdogTicketFiling) {
        parts.push(":ticket: Watchdog ticket being filed");
      }
      // The raw normalized error text is deliberately omitted here: it can
      // carry secrets or adversarial content from worker output. The signature
      // hash + class + affected issues are the operator triage signal; the raw
      // text lives on the linked member issues (SYMPH-398).
      parts.push(version);
      return { text: parts.join("\n") };
    }

    case "tracker_write_failed": {
      const sourceList =
        event.sourceIssueIds.length > 0
          ? event.sourceIssueIds.join(", ")
          : "none";
      const statusLabel =
        event.httpStatus !== null ? ` (HTTP ${event.httpStatus})` : "";
      const parts: string[] = [
        `:warning: *Tracker follow-up write failed*${statusLabel} — ${sanitizeForSlack(event.followUpTitle)}`,
        `Source issues: ${sourceList}`,
        `Reason: ${sanitizeForSlack(event.reason)}`,
      ];
      if (event.details !== null) {
        // details carries Linear API error bodies — sanitize like every other
        // free-text egress surface (SYMPH-421).
        parts.push(`Details: \`${sanitizeForSlack(event.details)}\``);
      }
      parts.push(version);
      return { text: parts.join("\n") };
    }
  }
}

// ---------------------------------------------------------------------------
// Poster interface & Slack factory
// ---------------------------------------------------------------------------

export interface NotificationPoster {
  post(channel: string, text: string, blocks?: SlackBlock[]): Promise<void>;
}

export function createSlackPoster(input: {
  botToken: string;
}): NotificationPoster {
  // Lazy-import to avoid pulling @slack/web-api into test bundles
  // when using mock posters.
  let clientPromise: Promise<import("@slack/web-api").WebClient> | null = null;

  const getClient = () => {
    if (clientPromise === null) {
      clientPromise = import("@slack/web-api").then(
        ({ WebClient }) => new WebClient(input.botToken),
      );
    }
    return clientPromise;
  };

  return {
    async post(
      channel: string,
      text: string,
      blocks?: SlackBlock[],
    ): Promise<void> {
      const client = await getClient();
      await client.chat.postMessage({
        channel,
        text,
        ...(blocks !== undefined ? { blocks } : {}),
      });
    },
  };
}

/**
 * Create a webhook-based poster for Incoming Webhook URLs
 * (SYMPHONY_SLACK_WEBHOOK_URL). The channel parameter is ignored — webhook
 * URLs are pre-routed to a single channel by Slack. This poster never logs
 * the URL, per the fail-open / no-URL-in-logs contract.
 */
export function createWebhookPoster(input: {
  webhookUrl: string;
  /** Injected only in tests — never pass in production code. */
  _fetchOverride?: typeof fetch;
}): NotificationPoster {
  return {
    async post(
      _channel: string,
      text: string,
      blocks?: SlackBlock[],
    ): Promise<void> {
      const fetchFn = input._fetchOverride ?? fetch;
      const body = JSON.stringify({
        text,
        ...(blocks !== undefined ? { blocks } : {}),
      });
      // Wrap the fetch so that ALL transport errors (URL parse failures, DNS,
      // connection refused, timeout) are re-thrown as a fixed URL-free message.
      // This prevents a malformed SYMPHONY_SLACK_WEBHOOK_URL from leaking the
      // full secret path into logs via "Failed to parse URL from <url>".
      // Redaction is co-located with the secret — never rely on callers to sanitize.
      let response: Response;
      try {
        response = await fetchFn(input.webhookUrl, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body,
          signal: AbortSignal.timeout(5_000),
        });
      } catch (err) {
        throw new Error(
          `Slack webhook delivery failed: ${err instanceof Error ? err.name : "unknown"}`,
        );
      }
      if (!response.ok) {
        throw new Error(`Slack webhook returned HTTP ${response.status}`);
      }
    },
  };
}

// ---------------------------------------------------------------------------
// PipelineNotifier — best-effort delivery
// ---------------------------------------------------------------------------

export interface PipelineNotificationSink {
  notify(event: PipelineNotificationEvent): void;
  flush?(): Promise<void>;
}

export interface PipelineNotifierOptions {
  channel: string;
  poster: NotificationPoster;
  onError?: (error: unknown) => void;
}

export class PipelineNotifier implements PipelineNotificationSink {
  private readonly channel: string;
  private readonly poster: NotificationPoster;
  private readonly onError: (error: unknown) => void;
  private readonly inflight: Set<Promise<void>> = new Set();

  constructor(options: PipelineNotifierOptions) {
    this.channel = options.channel;
    this.poster = options.poster;
    this.onError = options.onError ?? (() => {});
  }

  notify(event: PipelineNotificationEvent): void {
    const { text, blocks } = formatNotification(event);
    const p = this.poster.post(this.channel, text, blocks).catch((error) => {
      this.onError(error);
    });
    this.inflight.add(p);
    void p.finally(() => this.inflight.delete(p));
  }

  async flush(timeoutMs = 5000): Promise<void> {
    if (this.inflight.size === 0) return;
    await Promise.race([
      Promise.allSettled(this.inflight),
      new Promise<void>((resolve) => setTimeout(resolve, timeoutMs)),
    ]);
  }
}
