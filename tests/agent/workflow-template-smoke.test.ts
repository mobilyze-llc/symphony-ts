import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { renderPrompt } from "../../src/agent/prompt-builder.js";
import { resolveWorkflowConfig } from "../../src/config/config-resolver.js";
import { loadWorkflowDefinition } from "../../src/config/workflow-loader.js";
import type { Issue } from "../../src/domain/model.js";

const WORKFLOW_PATH = resolve(
  import.meta.dirname,
  "../../pipeline-config/workflows/WORKFLOW-symphony.md",
);
const PIPELINE_WORKFLOW_PATH = resolve(
  import.meta.dirname,
  "../../pipeline-config/WORKFLOW.md",
);
const CODEX_LOW_APP_SERVER_COMMAND =
  "codex --disable plugins --config 'model_reasoning_effort=\"low\"' app-server";
const SHIPPED_CODEX_WORKFLOW_CONFIGS = [
  "../../pipeline-config/WORKFLOW.md",
  "../../pipeline-config/WORKFLOW-staged.md",
  "../../pipeline-config/WORKFLOW-flat.md",
  "../../pipeline-config/WORKFLOW-instrumentation.md",
  "../../pipeline-config/templates/WORKFLOW-template.md",
].map((path) => resolve(import.meta.dirname, path));

const DESCRIPTION_SENTINEL = "DESCRIPTION_SENTINEL: do not leak to merge";

const ISSUE_FIXTURE: Issue = {
  id: "test-issue-id",
  identifier: "TEST-1",
  title: "Test issue title",
  description: DESCRIPTION_SENTINEL,
  state: "In Progress",
  branchName: "feature/test-1",
  url: "https://linear.app/example/issue/TEST-1",
  labels: [],
  blockedBy: [],
  priority: 1,
  createdAt: "2026-03-28T00:00:00.000Z",
  updatedAt: "2026-03-28T01:00:00.000Z",
};

const workflow = await loadWorkflowDefinition(WORKFLOW_PATH);
const { promptTemplate } = workflow;
const resolvedConfig = resolveWorkflowConfig(workflow, {
  LINEAR_API_KEY: "test-token",
});

describe("WORKFLOW-symphony.md smoke tests", () => {
  it("uses Codex low effort as the primary workflow runner", () => {
    expect(resolvedConfig.runner).toEqual({ kind: "codex", model: null });
    expect(resolvedConfig.codex.command).toBe(CODEX_LOW_APP_SERVER_COMMAND);

    const stages = resolvedConfig.stages;
    expect(stages).not.toBeNull();
    expect(stages?.stages.investigate?.runner).toBe("codex");
    expect(stages?.stages.implement?.runner).toBe("codex");
    expect(stages?.stages.review?.runner).toBe("codex");
    expect(stages?.stages.merge?.runner).toBe("codex");
    expect(stages?.stages.review?.model).toBeNull();
    expect(stages?.stages.review?.maxTurns).toBe(8);
    expect(resolvedConfig.codex.stallTimeoutMs).toBe(3_600_000);
  });

  it("disables Codex plugins in shipped low-effort workflow configs", async () => {
    for (const configPath of SHIPPED_CODEX_WORKFLOW_CONFIGS) {
      const config = await readFile(configPath, "utf8");

      expect(config).toContain(`command: ${CODEX_LOW_APP_SERVER_COMMAND}`);
    }
  });

  it("keeps the primary review gate stall budget above the council timeout", async () => {
    const primaryWorkflow = await loadWorkflowDefinition(
      PIPELINE_WORKFLOW_PATH,
    );
    const primaryConfig = resolveWorkflowConfig(primaryWorkflow, {
      LINEAR_API_KEY: "test-token",
      LINEAR_PROJECT_SLUG: "test-project",
    });

    expect(primaryConfig.codex.stallTimeoutMs).toBeGreaterThan(1_800_000);
  });

  it("investigate stage contains description and no merge prohibitions", async () => {
    const output = await renderPrompt({
      workflow: { promptTemplate },
      issue: ISSUE_FIXTURE,
      attempt: null,
      stageName: "investigate",
      reworkCount: 0,
    });
    expect(output).toContain(DESCRIPTION_SENTINEL);
    expect(output).not.toMatch(/You MUST NOT/);
  });

  it("implement stage contains description and no merge prohibitions", async () => {
    const output = await renderPrompt({
      workflow: { promptTemplate },
      issue: ISSUE_FIXTURE,
      attempt: null,
      stageName: "implement",
      reworkCount: 0,
    });
    expect(output).toContain(DESCRIPTION_SENTINEL);
    expect(output).not.toMatch(/You MUST NOT/);
  });

  it("review stage does NOT contain description", async () => {
    const output = await renderPrompt({
      workflow: { promptTemplate },
      issue: ISSUE_FIXTURE,
      attempt: null,
      stageName: "review",
      reworkCount: 0,
    });
    expect(output).not.toContain(DESCRIPTION_SENTINEL);
    expect(output).toContain(
      "Every PR, including low-risk PRs, must pass the headless council gate",
    );
    expect(output).toContain("symphony-council-review-gate");
    expect(output).toContain("CMUX_SPAWN_BIN");
    expect(output).toContain("SYMPHONY_COUNCIL_REVIEW_GATE");
    expect(output).toContain("command -v cmux-spawn");
    expect(output).toContain("command -v symphony-council-review-gate");
    expect(output).toContain("run_council_gate");
    expect(output).toContain("--timeout-seconds 1800");
    expect(output).toContain("Claude must run through CMUX");
    expect(output).not.toContain("Build the local CLI");
    expect(output).not.toContain(
      "/Users/ericlitman/projects/crucible/bin/cmux-spawn",
    );
    expect(output).not.toContain("Load and execute the /self-moa-review skill");
    expect(output).not.toContain("issue description contains the frozen spec");
  });

  it("merge stage does NOT contain description and HAS prohibitions", async () => {
    const output = await renderPrompt({
      workflow: { promptTemplate },
      issue: ISSUE_FIXTURE,
      attempt: null,
      stageName: "merge",
      reworkCount: 0,
    });
    expect(output).not.toContain(DESCRIPTION_SENTINEL);
    expect(output).toMatch(/MUST NOT/);
    expect(output).toContain("Your ONLY job is to merge the PR");
  });

  it("null stageName renders without error (backward compat)", async () => {
    const output = await renderPrompt({
      workflow: { promptTemplate },
      issue: ISSUE_FIXTURE,
      attempt: null,
      stageName: null,
      reworkCount: 0,
    });
    expect(output).toBeDefined();
    expect(output.length).toBeGreaterThan(0);
  });

  it("routes generated markdown docs to Linear Docs", async () => {
    const output = await renderPrompt({
      workflow: { promptTemplate },
      issue: ISSUE_FIXTURE,
      attempt: null,
      stageName: "implement",
      reworkCount: 0,
    });

    expect(output).toContain("Put generated markdown docs");
    expect(output).toContain("Linear Docs");
    expect(output).toContain("linear document create/update");
  });
});
