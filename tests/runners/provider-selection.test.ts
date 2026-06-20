import { describe, expect, it } from "vitest";

import { resolveStageRunnerProviderSelector } from "../../src/runners/provider-selection.js";

describe("resolveStageRunnerProviderSelector", () => {
  it("inherits the top-level provider when the stage keeps the default runner", () => {
    expect(
      resolveStageRunnerProviderSelector({
        runnerKind: "codex",
        defaultRunnerKind: "codex",
        stageRunner: null,
        executionProvider: null,
        defaultRunnerProvider: "openai",
      }),
    ).toBe("openai");
  });

  it("does not inherit the top-level provider when the stage overrides runner kind", () => {
    expect(
      resolveStageRunnerProviderSelector({
        runnerKind: "gemini",
        defaultRunnerKind: "codex",
        stageRunner: "gemini",
        executionProvider: null,
        defaultRunnerProvider: "openai",
      }),
    ).toBe("gemini");
  });

  it("falls back to the resolved runner kind when no provider selector is configured", () => {
    expect(
      resolveStageRunnerProviderSelector({
        runnerKind: "gemini",
        defaultRunnerKind: "codex",
        stageRunner: "gemini",
        executionProvider: null,
        defaultRunnerProvider: null,
      }),
    ).toBe("gemini");
  });

  it("compares runner selectors case-insensitively before inheriting defaults", () => {
    expect(
      resolveStageRunnerProviderSelector({
        runnerKind: "CODEX",
        defaultRunnerKind: "codex",
        stageRunner: "CODEX",
        executionProvider: null,
        defaultRunnerProvider: "OPENAI",
      }),
    ).toBe("OPENAI");
  });

  it("lets an execution provider override both runner defaults", () => {
    expect(
      resolveStageRunnerProviderSelector({
        runnerKind: "gemini",
        defaultRunnerKind: "codex",
        stageRunner: "gemini",
        executionProvider: "google",
        defaultRunnerProvider: "openai",
      }),
    ).toBe("google");
  });
});
