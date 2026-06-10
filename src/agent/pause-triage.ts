import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import { generateObject } from "ai";
import { z } from "zod";

import type { WorkflowPauseTriageConfig } from "../config/types.js";
import type { HardStopDecision } from "../policy/hard-stops.js";

/**
 * LLM pause triage (SYMPH-337 slice 2).
 *
 * When a budget pause survives the deterministic escalation ladder, a local
 * OpenAI-compatible model renders a structured verdict over evidence the
 * harness digests from orchestrator state — never raw ledgers. The judge
 * deliberately runs on the operator's local endpoint: zero marginal cost,
 * and it must not consume the Codex subscription window it adjudicates.
 *
 * Authority lives in the envelope, not the model: a `continue` verdict
 * grants exactly one additional unit at the issue's current budget ceiling,
 * bounded by pause_triage.max_resumes per issue. Any endpoint, parsing, or
 * schema failure returns null and the pause falls through to the operator
 * park — today's behavior.
 */

export type PauseTriageVerdictKind = "continue" | "split" | "hold";

export interface PauseTriageVerdict {
  verdict: PauseTriageVerdictKind;
  rationale: string;
}

const VERDICT_SCHEMA = z.object({
  verdict: z.enum(["continue", "split", "hold"]),
  rationale: z.string().min(1).max(2000),
});

export interface PauseTriageEvidence {
  issueIdentifier: string;
  issueTitle: string;
  stageName: string | null;
  hardStop: HardStopDecision;
  escalationStepsUsed: number;
  triageResumesUsed: number;
  reworkCount: number;
  /** Most recent worker activity, oldest first (tool name + context). */
  recentActivity: Array<{ toolName: string; context: string | null }>;
  /** The worker's last visible message, if any. */
  lastMessage: string | null;
  /** Completed pipeline stages with outcomes, oldest first. */
  stageHistory: Array<{ stageName: string; outcome: string; turns: number }>;
}

export interface PauseTriageRunInput {
  config: WorkflowPauseTriageConfig;
  evidence: PauseTriageEvidence;
  fetchFn?: typeof fetch;
  timeoutMs?: number;
}

export function isPauseTriageConfigured(
  config: WorkflowPauseTriageConfig,
): boolean {
  return config.baseUrl !== null && config.model !== null;
}

const DEFAULT_TRIAGE_TIMEOUT_MS = 30_000;

/**
 * Render a triage verdict, or null when triage is unconfigured or anything
 * fails — callers must treat null as "park for the operator".
 */
export async function runPauseTriage(
  input: PauseTriageRunInput,
): Promise<PauseTriageVerdict | null> {
  const { config, evidence } = input;
  if (!isPauseTriageConfigured(config)) {
    return null;
  }

  try {
    const provider = createOpenAICompatible({
      name: "pause-triage-local",
      // isPauseTriageConfigured guarantees these are non-null.
      baseURL: config.baseUrl as string,
      ...(config.apiKey === null ? {} : { apiKey: config.apiKey }),
      ...(input.fetchFn === undefined ? {} : { fetch: input.fetchFn }),
    });

    const { object } = await generateObject({
      model: provider(config.model as string),
      schema: VERDICT_SCHEMA,
      temperature: 0,
      // Fail fast to the operator pause — a flaky local endpoint must not
      // hold the worker-exit path hostage with retry backoff.
      maxRetries: 0,
      abortSignal: AbortSignal.timeout(
        input.timeoutMs ?? DEFAULT_TRIAGE_TIMEOUT_MS,
      ),
      prompt: buildTriagePrompt(evidence),
    });

    return object;
  } catch {
    // Fail closed: endpoint down, malformed output, schema mismatch, or
    // timeout all degrade to the operator pause.
    return null;
  }
}

function buildTriagePrompt(evidence: PauseTriageEvidence): string {
  const activity =
    evidence.recentActivity.length === 0
      ? "(none recorded)"
      : evidence.recentActivity
          .map(
            (entry) =>
              `- ${entry.toolName}${entry.context === null ? "" : `: ${entry.context}`}`,
          )
          .join("\n");
  const stages =
    evidence.stageHistory.length === 0
      ? "(no completed stages)"
      : evidence.stageHistory
          .map(
            (stage) =>
              `- ${stage.stageName}: ${stage.outcome} after ${stage.turns} turn(s)`,
          )
          .join("\n");

  return [
    "You triage a paused autonomous coding worker. Decide whether resuming it for one more bounded work unit is worthwhile.",
    "",
    `Issue: ${evidence.issueIdentifier} — ${evidence.issueTitle}`,
    `Stage: ${evidence.stageName ?? "(none)"} | rework count: ${evidence.reworkCount}`,
    `Pause: ${evidence.hardStop.trigger} — ${evidence.hardStop.reason}`,
    `Unit spend at pause: ${evidence.hardStop.totalTokens} tokens (~$${evidence.hardStop.estimatedCostUsd.toFixed(2)}) across ${evidence.hardStop.turnCount} turn(s).`,
    `Automatic budget escalations already used: ${evidence.escalationStepsUsed}. Triage-authorized resumes already used: ${evidence.triageResumesUsed}.`,
    "",
    "Completed stages:",
    stages,
    "",
    "Recent worker activity (oldest first):",
    activity,
    "",
    `Last worker message: ${evidence.lastMessage ?? "(none)"}`,
    "",
    "Verdicts:",
    '- "continue": the trajectory shows forward progress toward the stage deliverable; one more unit at the current budget is likely to finish or materially advance it.',
    '- "split": the work is real but too large for unit budgets; a human should decompose the ticket.',
    '- "hold": the worker is spinning, repeating itself, or the evidence does not justify more spend; a human should review.',
    "",
    'Respond with JSON only: {"verdict": "continue" | "split" | "hold", "rationale": "<one or two sentences citing the evidence>"}',
  ].join("\n");
}
