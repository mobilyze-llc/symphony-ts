import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { renderPrompt } from "../../src/agent/prompt-builder.js";
import { loadWorkflowDefinition } from "../../src/config/workflow-loader.js";
import type { Issue } from "../../src/domain/model.js";

const WORKFLOW_PATH = resolve(
  import.meta.dirname,
  "../../pipeline-config/workflows/WORKFLOW-symphony.md",
);

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

const { promptTemplate } = await loadWorkflowDefinition(WORKFLOW_PATH);

describe("WORKFLOW-symphony.md smoke tests", () => {
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
    expect(output).toContain("issue description contains the frozen spec");
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
});
