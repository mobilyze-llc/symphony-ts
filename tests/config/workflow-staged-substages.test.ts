import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

import { resolveWorkflowConfig } from "../../src/config/config-resolver.js";
import { loadWorkflowDefinition } from "../../src/config/workflow-loader.js";

const STAGED_WORKFLOW_PATH = resolve(
  import.meta.dirname,
  "../../pipeline-config/WORKFLOW-staged.md",
);

describe("WORKFLOW-staged.md implement decomposition (SYMPH-835)", () => {
  it("declares the implement sub-stage sequence data-driven from WORKFLOW config", async () => {
    const workflow = await loadWorkflowDefinition(STAGED_WORKFLOW_PATH);
    const resolved = resolveWorkflowConfig(workflow, {
      LINEAR_API_KEY: "test-token",
    });

    const implement = resolved.stages?.stages.implement;
    expect(implement).toBeDefined();
    expect(implement?.executionValidationErrors ?? []).toEqual([]);

    const subStages = implement?.execution?.subStages ?? [];
    // Ordered, bounded sub-stages — parsed from the WORKFLOW file, not hard-coded.
    expect(subStages.map((sub) => sub.name)).toEqual([
      "patch-plan",
      "first-patch",
      "focused-tests",
      "repair",
      "pr-assembly",
    ]);
    // Each sub-stage carries its own independent budget ceiling.
    expect(subStages.map((sub) => sub.execution.budget.maxTokens)).toEqual([
      40000, 80000, 60000, 80000, 30000,
    ]);
    // Capsules hand off BY PATH: each sub-stage consumes the prior's produce.
    expect(subStages[1]?.execution.capsules.consume).toEqual([
      "capsules/patch-plan.json",
    ]);
    expect(subStages[2]?.execution.capsules.consume).toEqual([
      "capsules/first-patch.json",
    ]);
    expect(subStages[3]?.execution.capsules.consume).toEqual([
      "capsules/focused-tests.json",
    ]);
    expect(subStages[4]?.execution.capsules.consume).toEqual([
      "capsules/repair.json",
    ]);
  });
});
