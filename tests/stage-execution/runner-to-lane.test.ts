import { describe, expect, it } from "vitest";

import {
  UnsupportedCrabrunnerRuntimeError,
  runnerToLane,
} from "../../src/stage-execution/runner-to-lane.js";

describe("runnerToLane", () => {
  it("resolves Codex to the openai-codex lane runtime and default model", () => {
    expect(
      runnerToLane({
        runner: "codex",
        model: null,
        provider: "codex-app-server",
      }),
    ).toEqual({
      runtime: "openai-codex",
      provider: "openai",
      modelId: "codex",
    });
  });

  it("resolves Claude stages to the anthropic-agent-sdk lane runtime", () => {
    expect(
      runnerToLane({
        runner: "claude-code",
        model: "sonnet",
        provider: "anthropic",
      }),
    ).toEqual({
      runtime: "anthropic-agent-sdk",
      provider: "anthropic",
      modelId: "sonnet",
    });
  });

  it("rejects a runtime that has no generic lane mapping", () => {
    expect(() =>
      runnerToLane({
        runner: "gemini",
        model: "gemini-2.5-pro",
        provider: "gemini",
      }),
    ).toThrow(UnsupportedCrabrunnerRuntimeError);
  });

  it("rejects a provider that does not match the selected lane runtime", () => {
    expect(() =>
      runnerToLane({ runner: "codex", model: "codex", provider: "anthropic" }),
    ).toThrow(/does not support provider/);
  });
});
