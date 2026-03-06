import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import type { WorkflowLoaderError } from "../../src/config/workflow-loader.js";
import {
  WorkflowWatcher,
  loadWorkflowSnapshot,
} from "../../src/config/workflow-watch.js";
import { ERROR_CODES } from "../../src/errors/codes.js";

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.allSettled(
    tempDirs.splice(0).map(async (directory) => {
      await import("node:fs/promises").then(({ rm }) =>
        rm(directory, { recursive: true, force: true }),
      );
    }),
  );
});

describe("workflow-watch", () => {
  it("loads a workflow snapshot with resolved config and dispatch validation", async () => {
    const workflowPath = await writeWorkflow(`---
tracker:
  kind: linear
  api_key: token
  project_slug: ENG
polling:
  interval_ms: 15000
---
Ship it.
`);

    const snapshot = await loadWorkflowSnapshot(workflowPath, {});

    expect(snapshot.definition.workflowPath).toBe(workflowPath);
    expect(snapshot.config.polling.intervalMs).toBe(15_000);
    expect(snapshot.dispatchValidation).toEqual({ ok: true });
  });

  it("keeps the last known good snapshot when reload parsing fails", async () => {
    const workflowPath = await writeWorkflow(`---
tracker:
  kind: linear
  api_key: token
  project_slug: ENG
---
Prompt v1
`);
    const onError = vi.fn();
    const watcher = await WorkflowWatcher.create({
      workflowPath,
      environment: {},
      onError,
    });

    await writeFile(
      workflowPath,
      `---
tracker: [broken
---
Prompt v2
`,
      "utf8",
    );

    const result = await watcher.reload();

    expect(result.ok).toBe(false);
    expect(watcher.currentSnapshot.definition.promptTemplate).toBe("Prompt v1");
    expect(onError).toHaveBeenCalledTimes(1);
    expect(onError.mock.calls[0]?.[0]).toMatchObject({
      reason: "manual",
      currentSnapshot: watcher.currentSnapshot,
      error: expect.objectContaining<Partial<WorkflowLoaderError>>({
        code: ERROR_CODES.workflowParseError,
      }),
    });

    await watcher.close();
  });

  it("updates the current snapshot when reload changes dispatch readiness", async () => {
    const workflowPath = await writeWorkflow(`---
tracker:
  kind: linear
  api_key: token
  project_slug: ENG
---
Prompt v1
`);
    const onReload = vi.fn();
    const watcher = await WorkflowWatcher.create({
      workflowPath,
      environment: {},
      onReload,
    });

    await writeFile(
      workflowPath,
      `---
tracker:
  kind: linear
---
Prompt v2
`,
      "utf8",
    );

    const result = await watcher.reload();

    expect(result).toMatchObject({
      ok: true,
      reason: "manual",
    });
    expect(watcher.currentSnapshot.definition.promptTemplate).toBe("Prompt v2");
    expect(watcher.currentSnapshot.dispatchValidation).toEqual({
      ok: false,
      error: {
        code: ERROR_CODES.trackerCredentialsMissing,
        message: "tracker.api_key must be configured before dispatch.",
      },
    });
    expect(onReload).toHaveBeenCalledTimes(1);

    await watcher.close();
  });

  it("reloads automatically when the workflow file changes on disk", async () => {
    const workflowPath = await writeWorkflow(`---
tracker:
  kind: linear
  api_key: token
  project_slug: ENG
---
Prompt v1
`);
    const onReload = vi.fn();
    const watcher = await WorkflowWatcher.create({
      workflowPath,
      environment: {},
      debounceMs: 25,
      onReload,
    });
    watcher.start();

    await writeFile(
      workflowPath,
      `---
tracker:
  kind: linear
  api_key: token
  project_slug: ENG
polling:
  interval_ms: 20000
---
Prompt v2
`,
      "utf8",
    );

    await vi.waitFor(() => {
      expect(watcher.currentSnapshot.definition.promptTemplate).toBe(
        "Prompt v2",
      );
    });

    expect(watcher.currentSnapshot.config.polling.intervalMs).toBe(20_000);
    expect(onReload).toHaveBeenCalled();

    await watcher.close();
  });
});

async function writeWorkflow(content: string): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "symphony-task5-"));
  tempDirs.push(directory);
  const workflowPath = join(directory, "WORKFLOW.md");
  await writeFile(workflowPath, content, "utf8");
  return workflowPath;
}
