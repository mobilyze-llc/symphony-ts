import type { StageExecutionBackend } from "../config/types.js";
import type { StageUsageMeasurementQuality } from "../domain/stage-usage.js";
import type { RunnerKind } from "./types.js";

export const RUNNER_PROVIDER_IDS = [
  "codex-app-server",
  "codex-cli",
  "claude-code",
  "gemini",
  "crabrunner",
] as const;

export type RunnerProviderId = (typeof RUNNER_PROVIDER_IDS)[number];

export type RunnerProviderRunnerKind = RunnerKind | "crabrunner";

export type RunnerProviderExecutionShape =
  | "persistent-thread"
  | "one-shot"
  | "delegated-worker";

export type RunnerProviderSupport =
  | "current"
  | "target"
  | "not-wired"
  | "not-supported";

export interface RunnerProviderCapabilitySet {
  executionShape: RunnerProviderExecutionShape;
  warmResume: RunnerProviderSupport;
  midRunInjection: RunnerProviderSupport;
  mcpToolPolicy: string;
  usageQuality: StageUsageMeasurementQuality;
  abortSemantics: string;
  durableArtifact: string;
  budgetTelemetry: RunnerProviderSupport;
  stallReset: RunnerProviderSupport;
  stageSignalParsing: RunnerProviderSupport;
  fullControlSemantics: boolean;
}

export interface RunnerProviderCapabilityRow {
  id: RunnerProviderId;
  label: string;
  runnerKind: RunnerProviderRunnerKind;
  aliases: readonly string[];
  current: RunnerProviderCapabilitySet;
  target: RunnerProviderCapabilitySet;
}

export const RUNNER_PROVIDER_CAPABILITY_MATRIX = Object.freeze<
  readonly RunnerProviderCapabilityRow[]
>([
  {
    id: "codex-app-server",
    label: "Codex app-server",
    runnerKind: "codex",
    aliases: ["codex", "app-server", "codex-app-server", "openai"],
    current: {
      executionShape: "persistent-thread",
      warmResume: "current",
      midRunInjection: "current",
      mcpToolPolicy: "Codex dynamic tools plus turn sandbox and mode policy",
      usageQuality: "true",
      abortSemantics:
        "Cooperative client close plus RuntimeHost tracked PID/process-group kill",
      durableArtifact: "Codex session artifact directory",
      budgetTelemetry: "current",
      stallReset: "current",
      stageSignalParsing: "current",
      fullControlSemantics: true,
    },
    target: {
      executionShape: "persistent-thread",
      warmResume: "current",
      midRunInjection: "current",
      mcpToolPolicy: "Keep Codex dynamic tools and turn sandbox parity",
      usageQuality: "true",
      abortSemantics:
        "Keep cooperative close plus tracked process-group kill parity",
      durableArtifact: "Codex session artifact directory",
      budgetTelemetry: "current",
      stallReset: "current",
      stageSignalParsing: "current",
      fullControlSemantics: true,
    },
  },
  {
    id: "codex-cli",
    label: "Codex CLI one-shot provider",
    runnerKind: "codex",
    aliases: ["codex-cli", "codex-one-shot", "openai-codex-cli"],
    current: {
      executionShape: "one-shot",
      warmResume: "not-wired",
      midRunInjection: "not-supported",
      mcpToolPolicy: "Not wired in this repository",
      usageQuality: "unavailable",
      abortSemantics: "Not wired; would be process-level cancellation only",
      durableArtifact: "Not wired",
      budgetTelemetry: "not-supported",
      stallReset: "not-supported",
      stageSignalParsing: "not-wired",
      fullControlSemantics: false,
    },
    target: {
      executionShape: "one-shot",
      warmResume: "not-supported",
      midRunInjection: "not-supported",
      mcpToolPolicy: "Non-control stages only, with explicit policy mapping",
      usageQuality: "partial",
      abortSemantics: "Bounded process cancellation",
      durableArtifact: "Terminal transcript or provider output artifact",
      budgetTelemetry: "not-supported",
      stallReset: "not-supported",
      stageSignalParsing: "target",
      fullControlSemantics: false,
    },
  },
  {
    id: "claude-code",
    label: "Claude Code AI SDK",
    runnerKind: "claude-code",
    aliases: ["claude", "claude-code", "anthropic"],
    current: {
      executionShape: "one-shot",
      warmResume: "not-wired",
      midRunInjection: "not-supported",
      mcpToolPolicy: "Claude hooks plus Symphony mode-permission envelope",
      usageQuality: "partial",
      abortSemantics: "AI SDK AbortSignal; no tracked app-server PID",
      durableArtifact: "Runner events only",
      budgetTelemetry: "target",
      stallReset: "target",
      stageSignalParsing: "current",
      fullControlSemantics: false,
    },
    target: {
      executionShape: "one-shot",
      warmResume: "target",
      midRunInjection: "not-supported",
      mcpToolPolicy:
        "Provider hooks mapped to the same Symphony permission policy",
      usageQuality: "true",
      abortSemantics: "AbortSignal plus provider subprocess cleanup proof",
      durableArtifact: "Provider transcript/session artifact when exposed",
      budgetTelemetry: "target",
      stallReset: "target",
      stageSignalParsing: "current",
      fullControlSemantics: false,
    },
  },
  {
    id: "gemini",
    label: "Gemini CLI AI SDK",
    runnerKind: "gemini",
    aliases: ["gemini", "gemini-cli", "google"],
    current: {
      executionShape: "one-shot",
      warmResume: "not-wired",
      midRunInjection: "not-supported",
      mcpToolPolicy: "Provider defaults; no Symphony tool-policy hook",
      usageQuality: "partial",
      abortSemantics: "No AbortSignal wired in current runner",
      durableArtifact: "Runner events only",
      budgetTelemetry: "target",
      stallReset: "target",
      stageSignalParsing: "current",
      fullControlSemantics: false,
    },
    target: {
      executionShape: "one-shot",
      warmResume: "not-supported",
      midRunInjection: "not-supported",
      mcpToolPolicy: "Explicit provider policy contract if supported",
      usageQuality: "true",
      abortSemantics: "AbortSignal when provider supports it",
      durableArtifact: "Provider transcript/session artifact when exposed",
      budgetTelemetry: "target",
      stallReset: "target",
      stageSignalParsing: "current",
      fullControlSemantics: false,
    },
  },
  {
    id: "crabrunner",
    label: "Crabrunner delegated worker",
    runnerKind: "crabrunner",
    aliases: ["crabrunner"],
    current: {
      executionShape: "delegated-worker",
      warmResume: "not-wired",
      midRunInjection: "not-wired",
      mcpToolPolicy: "Backend contract only; lane policy not enforced here",
      usageQuality: "unavailable",
      abortSemantics: "Backend-specific; not enforced by caller inspection",
      durableArtifact: "Backend terminal evidence when supplied",
      budgetTelemetry: "target",
      stallReset: "target",
      stageSignalParsing: "target",
      fullControlSemantics: false,
    },
    target: {
      executionShape: "delegated-worker",
      warmResume: "target",
      midRunInjection: "target",
      mcpToolPolicy: "Lane-side worker enforces profile/tool policy",
      usageQuality: "true",
      abortSemantics: "Lane-side budget/stall/kill enforcement",
      durableArtifact: "Scheduler artifact bundle and usage ledger",
      budgetTelemetry: "target",
      stallReset: "target",
      stageSignalParsing: "target",
      fullControlSemantics: false,
    },
  },
]);

const MATRIX_BY_ID = new Map(
  RUNNER_PROVIDER_CAPABILITY_MATRIX.map((row) => [row.id, row]),
);

export function getRunnerProviderCapabilityRow(
  id: RunnerProviderId,
): RunnerProviderCapabilityRow {
  const row = MATRIX_BY_ID.get(id);
  if (row === undefined) {
    throw new Error(`Unknown runner provider capability row: ${id}`);
  }
  return row;
}

export function resolveRunnerProviderCapability(input: {
  backend?: StageExecutionBackend | null;
  runnerKind: string | null | undefined;
  provider: string | null | undefined;
}): RunnerProviderCapabilityRow | null {
  if (input.backend === "crabrunner") {
    return getRunnerProviderCapabilityRow("crabrunner");
  }

  const runnerKind = normalizeSelector(input.runnerKind);
  const provider = normalizeSelector(input.provider);
  if (runnerKind === null) {
    return null;
  }

  if (provider === null) {
    return defaultProviderForRunnerKind(runnerKind);
  }

  const matches = RUNNER_PROVIDER_CAPABILITY_MATRIX.filter((row) =>
    row.aliases.some((alias) => normalizeSelector(alias) === provider),
  );
  if (matches.length === 0) {
    return null;
  }

  const sameRunner = matches.find((row) => row.runnerKind === runnerKind);
  return sameRunner ?? null;
}

export function findRunnerProviderCapabilityMatches(
  provider: string | null | undefined,
): readonly RunnerProviderCapabilityRow[] {
  const selector = normalizeSelector(provider);
  if (selector === null) {
    return [];
  }
  return RUNNER_PROVIDER_CAPABILITY_MATRIX.filter((row) =>
    row.aliases.some((alias) => normalizeSelector(alias) === selector),
  );
}

export function requiresCodexAppServerControlPath(input: {
  backend?: StageExecutionBackend | null;
  runnerKind: string | null | undefined;
  provider: string | null | undefined;
}): boolean {
  return (
    resolveRunnerProviderCapability(input)?.current.fullControlSemantics ===
    true
  );
}

function defaultProviderForRunnerKind(
  runnerKind: string,
): RunnerProviderCapabilityRow | null {
  switch (runnerKind) {
    case "codex":
      return getRunnerProviderCapabilityRow("codex-app-server");
    case "claude-code":
      return getRunnerProviderCapabilityRow("claude-code");
    case "gemini":
      return getRunnerProviderCapabilityRow("gemini");
    default:
      return null;
  }
}

function normalizeSelector(value: string | null | undefined): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const normalized = value.trim().toLowerCase();
  return normalized === "" ? null : normalized;
}
