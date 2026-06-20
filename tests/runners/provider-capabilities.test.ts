import { describe, expect, it } from "vitest";

import { REGISTERED_RUNNER_KINDS } from "../../src/runners/factory.js";
import {
  RUNNER_PROVIDER_CAPABILITY_MATRIX,
  RUNNER_PROVIDER_IDS,
  resolveRunnerProviderCapability,
} from "../../src/runners/provider-capabilities.js";

describe("runner provider capability matrix", () => {
  it("has one truthful matrix row for every provider id", () => {
    expect(RUNNER_PROVIDER_CAPABILITY_MATRIX.map((row) => row.id)).toEqual(
      RUNNER_PROVIDER_IDS,
    );

    for (const row of RUNNER_PROVIDER_CAPABILITY_MATRIX) {
      expect(row.current.executionShape).toBeTruthy();
      expect(row.current.warmResume).toBeTruthy();
      expect(row.current.midRunInjection).toBeTruthy();
      expect(row.current.mcpToolPolicy).toBeTruthy();
      expect(row.current.usageQuality).toBeTruthy();
      expect(row.current.abortSemantics).toBeTruthy();
      expect(row.current.durableArtifact).toBeTruthy();
      expect(row.target.executionShape).toBeTruthy();
      expect(row.target.warmResume).toBeTruthy();
      expect(row.target.midRunInjection).toBeTruthy();
      expect(row.target.mcpToolPolicy).toBeTruthy();
      expect(row.target.usageQuality).toBeTruthy();
      expect(row.target.abortSemantics).toBeTruthy();
      expect(row.target.durableArtifact).toBeTruthy();
    }
  });

  it("covers every runner registered in the factory", () => {
    for (const runnerKind of REGISTERED_RUNNER_KINDS) {
      expect(
        RUNNER_PROVIDER_CAPABILITY_MATRIX.some(
          (row) => row.runnerKind === runnerKind,
        ),
      ).toBe(true);
    }
  });

  it("marks only the current Codex app-server path as control-capable", () => {
    const controlCapableRows = RUNNER_PROVIDER_CAPABILITY_MATRIX.filter(
      (row) => row.current.fullControlSemantics,
    );

    expect(controlCapableRows.map((row) => row.id)).toEqual([
      "codex-app-server",
    ]);
  });

  it("resolves stage-provider aliases in runner context", () => {
    expect(
      resolveRunnerProviderCapability({
        backend: "current-runner",
        runnerKind: "codex",
        provider: "openai",
      })?.id,
    ).toBe("codex-app-server");
    expect(
      resolveRunnerProviderCapability({
        backend: "current-runner",
        runnerKind: "codex",
        provider: "codex-cli",
      })?.id,
    ).toBe("codex-cli");
    expect(
      resolveRunnerProviderCapability({
        backend: "current-runner",
        runnerKind: "claude-code",
        provider: "anthropic",
      })?.id,
    ).toBe("claude-code");
    expect(
      resolveRunnerProviderCapability({
        backend: "current-runner",
        runnerKind: "gemini",
        provider: "google",
      })?.id,
    ).toBe("gemini");
    expect(
      resolveRunnerProviderCapability({
        backend: "crabrunner",
        runnerKind: "codex",
        provider: "openai",
      })?.id,
    ).toBe("crabrunner");
  });
});
