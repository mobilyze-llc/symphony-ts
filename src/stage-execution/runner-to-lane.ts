export type CrabrunnerLaneRuntime = "anthropic-agent-sdk" | "openai-codex";

export interface RunnerToLaneInput {
  runner: string | null | undefined;
  model: string | null | undefined;
  provider: string | null | undefined;
}

export interface ResolvedCrabrunnerLane {
  runtime: CrabrunnerLaneRuntime;
  provider: "anthropic" | "openai";
  modelId: string;
}

export class UnsupportedCrabrunnerRuntimeError extends Error {
  readonly runner: string;
  readonly provider: string | null;

  constructor(input: { runner: string; provider: string | null }) {
    super(
      `Unsupported Crabrunner runtime for runner "${input.runner}"${
        input.provider === null ? "" : ` and provider "${input.provider}"`
      }. Generic stage lanes support Codex and Claude only.`,
    );
    this.name = "UnsupportedCrabrunnerRuntimeError";
    this.runner = input.runner;
    this.provider = input.provider;
  }
}

const CODEX_PROVIDER_ALIASES = new Set([
  "codex",
  "codex-app-server",
  "codex-cli",
  "openai",
  "openai-codex",
]);
const CLAUDE_PROVIDER_ALIASES = new Set([
  "anthropic",
  "anthropic-agent-sdk",
  "claude",
  "claude-code",
]);

export function runnerToLane(input: RunnerToLaneInput): ResolvedCrabrunnerLane {
  const runner = normalize(input.runner) ?? "";
  const provider = normalize(input.provider);
  const model = normalize(input.model);

  if (runner === "codex") {
    if (provider !== null && !CODEX_PROVIDER_ALIASES.has(provider)) {
      throw unsupportedProvider(input, provider, "Codex");
    }
    return {
      runtime: "openai-codex",
      provider: "openai",
      modelId: modelIdForModel(model, "openai", "codex"),
    };
  }

  if (runner === "claude-code" || runner === "claude" || runner === "opus") {
    if (provider !== null && !CLAUDE_PROVIDER_ALIASES.has(provider)) {
      throw unsupportedProvider(input, provider, "Claude");
    }
    return {
      runtime: "anthropic-agent-sdk",
      provider: "anthropic",
      modelId: modelIdForModel(model, "anthropic", "opus"),
    };
  }

  throw new UnsupportedCrabrunnerRuntimeError({
    runner: runner || "<missing>",
    provider,
  });
}

function modelIdForModel(
  model: string | null,
  expectedProvider: string,
  fallback: string,
): string {
  if (model === null) {
    return fallback;
  }
  const slash = model.indexOf("/");
  if (slash < 0) {
    return model;
  }
  const modelProvider = model.slice(0, slash).toLowerCase();
  if (modelProvider !== expectedProvider) {
    throw new Error(
      `Crabrunner model provider "${modelProvider}" does not match runtime provider "${expectedProvider}".`,
    );
  }
  const modelId = model.slice(slash + 1).trim();
  if (modelId === "") {
    throw new Error(`Crabrunner model "${model}" has no model id.`);
  }
  return modelId;
}

function unsupportedProvider(
  input: RunnerToLaneInput,
  provider: string,
  label: string,
): UnsupportedCrabrunnerRuntimeError {
  const error = new UnsupportedCrabrunnerRuntimeError({
    runner: normalize(input.runner) ?? "<missing>",
    provider,
  });
  error.message = `${label} runner does not support provider "${provider}" for a generic Crabrunner lane.`;
  return error;
}

function normalize(value: string | null | undefined): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const trimmed = value.trim();
  return trimmed === "" ? null : trimmed.toLowerCase();
}
