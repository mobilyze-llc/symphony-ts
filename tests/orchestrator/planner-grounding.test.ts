import { describe, expect, it } from "vitest";

import { buildPlannerCodeGroundingInput } from "../../src/orchestrator/planner-grounding.js";

describe("planner grounding", () => {
  const target = {
    repoUrl: "file:///repo",
    commitSha: "abc123",
    repoScope: "symphony" as const,
  };

  it("returns null when the planner grounding flag is absent or disabled", () => {
    expect(
      buildPlannerCodeGroundingInput({
        workflowConfig: {
          workspace: { root: "/workspace" },
          codeGrounding: codeGroundingConfig(true),
        },
        runId: "run-1",
        target,
      }),
    ).toBeNull();
  });

  it("returns null when core code grounding is disabled", () => {
    expect(
      buildPlannerCodeGroundingInput({
        workflowConfig: {
          workspace: { root: "/workspace" },
          plannerGrounding: { enabled: true },
          codeGrounding: codeGroundingConfig(false),
        },
        runId: "run-1",
        target,
      }),
    ).toBeNull();
  });

  it("builds input when planner and core code grounding are enabled", () => {
    const input = buildPlannerCodeGroundingInput({
      workflowConfig: {
        workspace: { root: "/workspace" },
        plannerGrounding: { enabled: true },
        codeGrounding: codeGroundingConfig(true),
      },
      runId: "run-1",
      target,
    });

    expect(input).toMatchObject({
      workspaceRoot: "/workspace",
      runId: "run-1",
      target,
      config: { enabled: true },
    });
  });
});

function codeGroundingConfig(enabled: boolean) {
  return {
    enabled,
    baseDir: ".grounding",
    ttlMs: 1000,
    maxCheckoutsPerRepo: 2,
  };
}
