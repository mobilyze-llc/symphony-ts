import { createOpenAICompatible } from "@ai-sdk/openai-compatible";

export const LOCAL_JUDGE_STRUCTURED_OUTPUTS_ENV =
  "SYMPHONY_LOCAL_JUDGE_STRUCTURED_OUTPUTS";

type AiSdkWarning = {
  type?: string;
  feature?: string;
  details?: string;
  message?: string;
};

type AiSdkWarningOptions = {
  warnings: AiSdkWarning[];
  provider: string;
  model: string;
};

type AiSdkWarningLogger = false | ((options: AiSdkWarningOptions) => void);

type AiSdkWarningGlobal = typeof globalThis & {
  AI_SDK_LOG_WARNINGS?: AiSdkWarningLogger;
};

let warningPolicyLock: Promise<void> = Promise.resolve();

export interface LocalOpenAICompatibleProviderOptions {
  name: string;
  baseURL: string;
  apiKey?: string | undefined;
  fetch?: typeof fetch | undefined;
  env?: NodeJS.ProcessEnv | undefined;
}

export function localJudgeStructuredOutputsEnabled(
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  const value = env[LOCAL_JUDGE_STRUCTURED_OUTPUTS_ENV];
  return value === "1" || value === "true";
}

export function createLocalOpenAICompatibleProvider(
  options: LocalOpenAICompatibleProviderOptions,
): ReturnType<typeof createOpenAICompatible> {
  return createOpenAICompatible({
    name: options.name,
    baseURL: options.baseURL,
    supportsStructuredOutputs: localJudgeStructuredOutputsEnabled(options.env),
    ...(options.apiKey === undefined ? {} : { apiKey: options.apiKey }),
    ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
  });
}

function isUnsupportedResponseFormatWarning(warning: AiSdkWarning): boolean {
  return (
    warning.type === "unsupported" &&
    (warning.feature === "responseFormat" ||
      warning.details?.includes("responseFormat") === true ||
      warning.message?.includes("responseFormat") === true)
  );
}

async function acquireWarningPolicyLock(): Promise<() => void> {
  let releaseLock: () => void = () => undefined;
  const previousLock = warningPolicyLock;
  warningPolicyLock = new Promise<void>((resolve) => {
    releaseLock = resolve;
  });
  await previousLock;
  return releaseLock;
}

function formatForwardedWarning(
  warning: AiSdkWarning,
  provider: string,
  model: string,
): string {
  const prefix = `AI SDK Warning (${provider} / ${model}):`;
  if (warning.type === "unsupported") {
    return `${prefix} The feature "${String(warning.feature ?? "unknown")}" is not supported.${warning.details === undefined ? "" : ` ${warning.details}`}`;
  }
  if (warning.message !== undefined) {
    return `${prefix} ${warning.message}`;
  }
  return `${prefix} ${JSON.stringify(warning)}`;
}

export async function withLocalJudgeAiSdkWarningPolicy<T>(
  run: () => Promise<T>,
): Promise<T> {
  const releaseWarningPolicyLock = await acquireWarningPolicyLock();
  const globalRecord = globalThis as AiSdkWarningGlobal;
  const previousLogger = globalRecord.AI_SDK_LOG_WARNINGS;

  // The AI SDK warning hook is process-global, so overlapping local judge calls
  // must not interleave hook installation and restoration.
  globalRecord.AI_SDK_LOG_WARNINGS = (options: AiSdkWarningOptions) => {
    const forwardedWarnings = options.warnings.filter(
      (warning: AiSdkWarning) => !isUnsupportedResponseFormatWarning(warning),
    );
    if (forwardedWarnings.length === 0 || previousLogger === false) {
      return;
    }
    if (typeof previousLogger === "function") {
      previousLogger({ ...options, warnings: forwardedWarnings });
      return;
    }
    for (const warning of forwardedWarnings) {
      console.warn(
        formatForwardedWarning(warning, options.provider, options.model),
      );
    }
  };

  try {
    return await run();
  } finally {
    if (previousLogger === undefined) {
      Reflect.deleteProperty(globalRecord, "AI_SDK_LOG_WARNINGS");
    } else {
      globalRecord.AI_SDK_LOG_WARNINGS = previousLogger;
    }
    releaseWarningPolicyLock();
  }
}
