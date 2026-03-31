import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  WorkflowLoaderError,
  deepMergeConfigs,
  loadWorkflowDefinition,
  parseWorkflowContent,
  resolveWorkflowPath,
} from "../../src/config/workflow-loader.js";
import { ERROR_CODES } from "../../src/errors/codes.js";

describe("workflow-loader", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("parses YAML front matter and trims the prompt body", () => {
    const workflow = parseWorkflowContent(`---
tracker:
  kind: linear
  project_slug: ENG
---

# Prompt

Do the work.
`);

    expect(workflow.config).toEqual({
      tracker: {
        kind: "linear",
        project_slug: "ENG",
      },
    });
    expect(workflow.promptTemplate).toBe("# Prompt\n\nDo the work.");
  });

  it("treats files without front matter as prompt-only workflows", () => {
    const workflow = parseWorkflowContent("\n\nShip it.\n");

    expect(workflow.config).toEqual({});
    expect(workflow.promptTemplate).toBe("Ship it.");
  });

  it("rejects non-map front matter", () => {
    expect(() =>
      parseWorkflowContent(`---
- nope
---
Prompt`),
    ).toThrowError(WorkflowLoaderError);

    try {
      parseWorkflowContent(`---
- nope
---
Prompt`);
    } catch (error) {
      expect(error).toMatchObject({
        code: ERROR_CODES.workflowFrontMatterNotAMap,
      });
    }
  });

  it("rejects invalid YAML front matter", () => {
    expect(() =>
      parseWorkflowContent(`---
tracker: [broken
---
Prompt`),
    ).toThrowError(WorkflowLoaderError);

    try {
      parseWorkflowContent(`---
tracker: [broken
---
Prompt`);
    } catch (error) {
      expect(error).toMatchObject({
        code: ERROR_CODES.workflowParseError,
      });
    }
  });

  it("loads the workflow from disk and defaults to WORKFLOW.md in cwd", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "symphony-task3-loader-"));
    const workflowPath = join(workspace, "WORKFLOW.md");
    await writeFile(workflowPath, "Prompt body\n", "utf8");

    const workflow = await loadWorkflowDefinition(workflowPath);

    expect(workflow.workflowPath).toBe(workflowPath);
    expect(workflow.promptTemplate).toBe("Prompt body");
    expect(resolveWorkflowPath(workflowPath)).toBe(workflowPath);
  });

  it("prefers the explicit workflow path over the cwd default", async () => {
    const otherWorkspace = await mkdtemp(
      join(tmpdir(), "symphony-task3-other-"),
    );
    const explicitPath = join(otherWorkspace, "WORKFLOW.md");
    await writeFile(explicitPath, "Explicit prompt\n", "utf8");
    const workflow = await loadWorkflowDefinition(explicitPath);
    expect(workflow.workflowPath).toBe(explicitPath);
    expect(workflow.promptTemplate).toBe("Explicit prompt");
  });

  it("resolves the default workflow path from the current working directory", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "symphony-task3-cwd-"));

    vi.spyOn(process, "cwd").mockReturnValue(workspace);
    expect(resolveWorkflowPath()).toBe(join(workspace, "WORKFLOW.md"));
  });

  it("returns a typed missing-workflow error when the file does not exist", async () => {
    const missingPath = join(tmpdir(), "missing-workflow.md");

    await expect(loadWorkflowDefinition(missingPath)).rejects.toMatchObject({
      code: ERROR_CODES.missingWorkflowFile,
    });
  });

  describe("base_config", () => {
    it("loads and merges base template", async () => {
      const workspace = await mkdtemp(
        join(tmpdir(), "symphony-base-config-merge-"),
      );
      const templatesDir = join(workspace, "templates");
      await mkdir(templatesDir, { recursive: true });

      const baseContent = `---
tracker:
  kind: linear
  project_slug: BASE
stall_timeout_ms: 900000
---

Base prompt body.
`;
      await writeFile(join(templatesDir, "WORKFLOW-template.md"), baseContent);

      const productContent = `---
base_config: ./templates/WORKFLOW-template.md
tracker:
  project_slug: PRODUCT
max_retries: 3
---

Product identity line.
`;
      const productPath = join(workspace, "WORKFLOW.md");
      await writeFile(productPath, productContent);

      const result = await loadWorkflowDefinition(productPath);

      expect(result.config).toEqual({
        tracker: {
          kind: "linear",
          project_slug: "PRODUCT",
        },
        stall_timeout_ms: 900000,
        max_retries: 3,
      });
      expect(result.promptTemplate).toBe(
        "Base prompt body.\nProduct identity line.",
      );
    });

    it("product values override base values", async () => {
      const workspace = await mkdtemp(
        join(tmpdir(), "symphony-base-config-override-"),
      );

      const baseContent = `---
stall_timeout_ms: 300000
max_retries: 5
---
`;
      await writeFile(join(workspace, "base.md"), baseContent);

      const productContent = `---
base_config: ./base.md
stall_timeout_ms: 900000
---
`;
      const productPath = join(workspace, "WORKFLOW.md");
      await writeFile(productPath, productContent);

      const result = await loadWorkflowDefinition(productPath);

      expect(result.config.stall_timeout_ms).toBe(900000);
      expect(result.config.max_retries).toBe(5);
    });

    it("product body appended after base body", async () => {
      const workspace = await mkdtemp(
        join(tmpdir(), "symphony-base-config-body-"),
      );

      await writeFile(
        join(workspace, "base.md"),
        `---
key: value
---

Base body here.
`,
      );

      await writeFile(
        join(workspace, "WORKFLOW.md"),
        `---
base_config: ./base.md
---

Product body here.
`,
      );

      const result = await loadWorkflowDefinition(
        join(workspace, "WORKFLOW.md"),
      );

      expect(result.promptTemplate).toBe("Base body here.\nProduct body here.");
    });

    it("works with product having no body", async () => {
      const workspace = await mkdtemp(
        join(tmpdir(), "symphony-base-config-nobody-"),
      );

      await writeFile(
        join(workspace, "base.md"),
        `---
key: value
---

Base body only.
`,
      );

      await writeFile(
        join(workspace, "WORKFLOW.md"),
        `---
base_config: ./base.md
extra: true
---
`,
      );

      const result = await loadWorkflowDefinition(
        join(workspace, "WORKFLOW.md"),
      );

      expect(result.config).toEqual({ key: "value", extra: true });
      expect(result.promptTemplate).toBe("Base body only.");
    });

    it("errors on missing base file", async () => {
      const workspace = await mkdtemp(
        join(tmpdir(), "symphony-base-config-missing-"),
      );

      await writeFile(
        join(workspace, "WORKFLOW.md"),
        `---
base_config: ./nonexistent.md
---
`,
      );

      await expect(
        loadWorkflowDefinition(join(workspace, "WORKFLOW.md")),
      ).rejects.toMatchObject({
        code: ERROR_CODES.missingWorkflowFile,
      });
    });

    it("errors on circular reference", async () => {
      const workspace = await mkdtemp(
        join(tmpdir(), "symphony-base-config-circular-"),
      );

      await writeFile(
        join(workspace, "base.md"),
        `---
base_config: ./other.md
key: value
---
`,
      );

      await writeFile(
        join(workspace, "WORKFLOW.md"),
        `---
base_config: ./base.md
---
`,
      );

      await expect(
        loadWorkflowDefinition(join(workspace, "WORKFLOW.md")),
      ).rejects.toMatchObject({
        code: ERROR_CODES.baseConfigCircularReference,
      });
    });

    it("strips base_config from the final config", async () => {
      const workspace = await mkdtemp(
        join(tmpdir(), "symphony-base-config-strip-"),
      );

      await writeFile(
        join(workspace, "base.md"),
        `---
key: value
---
`,
      );

      await writeFile(
        join(workspace, "WORKFLOW.md"),
        `---
base_config: ./base.md
extra: true
---
`,
      );

      const result = await loadWorkflowDefinition(
        join(workspace, "WORKFLOW.md"),
      );

      expect(result.config).not.toHaveProperty("base_config");
      expect(result.config).toEqual({ key: "value", extra: true });
    });
  });
});

describe("deepMergeConfigs", () => {
  it("merges nested objects", () => {
    const base = {
      tracker: { kind: "linear", project_slug: "BASE" },
      timeout: 5000,
    };
    const override = {
      tracker: { project_slug: "OVERRIDE" },
    };

    const result = deepMergeConfigs(base, override);

    expect(result).toEqual({
      tracker: { kind: "linear", project_slug: "OVERRIDE" },
      timeout: 5000,
    });
  });

  it("arrays are replaced not merged", () => {
    const base = {
      active_states: ["In Progress", "In Review"],
      tags: ["a", "b"],
    };
    const override = {
      active_states: ["Blocked"],
    };

    const result = deepMergeConfigs(base, override);

    expect(result).toEqual({
      active_states: ["Blocked"],
      tags: ["a", "b"],
    });
  });

  it("override scalar replaces base scalar", () => {
    const base = { timeout: 5000, name: "base" };
    const override = { timeout: 9000 };

    const result = deepMergeConfigs(base, override);

    expect(result).toEqual({ timeout: 9000, name: "base" });
  });

  it("adds new keys from override", () => {
    const base = { a: 1 };
    const override = { b: 2 };

    const result = deepMergeConfigs(base, override);

    expect(result).toEqual({ a: 1, b: 2 });
  });

  it("deeply nested merge works", () => {
    const base = {
      level1: {
        level2: {
          level3: { a: 1, b: 2 },
        },
      },
    };
    const override = {
      level1: {
        level2: {
          level3: { b: 3, c: 4 },
        },
      },
    };

    const result = deepMergeConfigs(base, override);

    expect(result).toEqual({
      level1: {
        level2: {
          level3: { a: 1, b: 3, c: 4 },
        },
      },
    });
  });

  it("override object replaces base scalar", () => {
    const base = { tracker: "simple" } as Record<string, unknown>;
    const override = { tracker: { kind: "linear" } };

    const result = deepMergeConfigs(base, override);

    expect(result).toEqual({ tracker: { kind: "linear" } });
  });
});
