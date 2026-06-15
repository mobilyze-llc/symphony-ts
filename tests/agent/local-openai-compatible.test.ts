import { afterEach, describe, expect, it } from "vitest";

import {
  LOCAL_JUDGE_STRUCTURED_OUTPUTS_ENV,
  localJudgeStructuredOutputsEnabled,
  withLocalJudgeAiSdkWarningPolicy,
} from "../../src/agent/local-openai-compatible.js";

type AiSdkWarningOptions = {
  warnings: Array<{ type?: string; feature?: string; message?: string }>;
  provider: string;
  model: string;
};

type AiSdkWarningGlobal = typeof globalThis & {
  AI_SDK_LOG_WARNINGS?: false | ((options: AiSdkWarningOptions) => void);
};

const globalRecord = globalThis as AiSdkWarningGlobal;
const originalLogger = globalRecord.AI_SDK_LOG_WARNINGS;

afterEach(() => {
  if (originalLogger === undefined) {
    Reflect.deleteProperty(globalRecord, "AI_SDK_LOG_WARNINGS");
  } else {
    globalRecord.AI_SDK_LOG_WARNINGS = originalLogger;
  }
});

describe("local OpenAI-compatible judge policy", () => {
  it("keeps structured outputs off unless explicitly enabled", () => {
    expect(localJudgeStructuredOutputsEnabled({})).toBe(false);
    expect(
      localJudgeStructuredOutputsEnabled({
        [LOCAL_JUDGE_STRUCTURED_OUTPUTS_ENV]: "true",
      }),
    ).toBe(true);
    expect(
      localJudgeStructuredOutputsEnabled({
        [LOCAL_JUDGE_STRUCTURED_OUTPUTS_ENV]: "1",
      }),
    ).toBe(true);
  });

  it("suppresses only the unsupported responseFormat warning", async () => {
    const forwarded: AiSdkWarningOptions[] = [];
    globalRecord.AI_SDK_LOG_WARNINGS = (options: AiSdkWarningOptions) => {
      forwarded.push(options);
    };

    await withLocalJudgeAiSdkWarningPolicy(async () => {
      const logger = globalRecord.AI_SDK_LOG_WARNINGS;
      if (typeof logger === "function") {
        logger({
          provider: "local",
          model: "judge",
          warnings: [
            { type: "unsupported", feature: "responseFormat" },
            { type: "unsupported", feature: "temperature" },
          ],
        });
      }
    });

    expect(forwarded).toHaveLength(1);
    expect(forwarded[0]?.warnings).toEqual([
      { type: "unsupported", feature: "temperature" },
    ]);
  });

  it("restores the previous warning hook", async () => {
    const previous = () => undefined;
    globalRecord.AI_SDK_LOG_WARNINGS = previous;

    await withLocalJudgeAiSdkWarningPolicy(async () => undefined);

    expect(globalRecord.AI_SDK_LOG_WARNINGS).toBe(previous);
  });

  it("serializes overlapping warning hooks before restoring the previous hook", async () => {
    const previous = () => undefined;
    globalRecord.AI_SDK_LOG_WARNINGS = previous;

    let releaseFirst: () => void = () => undefined;
    let markFirstStarted: () => void = () => undefined;
    const firstStarted = new Promise<void>((resolve) => {
      markFirstStarted = resolve;
    });
    let secondStarted = false;

    const first = withLocalJudgeAiSdkWarningPolicy(async () => {
      markFirstStarted();
      await new Promise<void>((resolve) => {
        releaseFirst = resolve;
      });
    });
    await firstStarted;

    const second = withLocalJudgeAiSdkWarningPolicy(async () => {
      secondStarted = true;
    });

    await Promise.resolve();
    expect(secondStarted).toBe(false);
    expect(globalRecord.AI_SDK_LOG_WARNINGS).not.toBe(previous);

    releaseFirst();
    await Promise.all([first, second]);

    expect(secondStarted).toBe(true);
    expect(globalRecord.AI_SDK_LOG_WARNINGS).toBe(previous);
  });
});
