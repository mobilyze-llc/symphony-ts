import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it, vi } from "vitest";

import {
  ERROR_CODES,
  type WorkspaceHookError,
  type WorkspaceHookLogEntry,
  WorkspaceHookRunner,
  WorkspaceHookTimeoutError,
  resolveWorkflowConfig,
} from "../../src/index.js";

describe("WorkspaceHookRunner", () => {
  it("returns false when the requested hook is not configured", async () => {
    const execute = vi.fn();
    const runner = new WorkspaceHookRunner({
      config: {
        afterCreate: null,
        beforeRun: null,
        afterRun: null,
        beforeRemove: null,
        timeoutMs: 100,
      },
      execute,
    });

    await expect(
      runner.run({
        name: "beforeRun",
        workspacePath: "/tmp/workspace",
      }),
    ).resolves.toBe(false);
    expect(execute).not.toHaveBeenCalled();
  });

  it("fails fatal hooks on non-zero exit codes and truncates logged output", async () => {
    const logs: WorkspaceHookLogEntry[] = [];
    const runner = new WorkspaceHookRunner({
      config: {
        afterCreate: "echo prepare",
        beforeRun: "echo run",
        afterRun: null,
        beforeRemove: null,
        timeoutMs: 500,
      },
      outputLimit: 12,
      log: (entry) => {
        logs.push(entry);
      },
      execute: vi.fn().mockResolvedValue({
        exitCode: 12,
        signal: null,
        stdout: "1234567890abcdef",
        stderr: "failure-details",
      }),
    });

    await expect(
      runner.run({
        name: "beforeRun",
        workspacePath: "/tmp/workspace",
      }),
    ).rejects.toThrowError(
      expect.objectContaining<Partial<WorkspaceHookError>>({
        code: ERROR_CODES.hookFailed,
        exitCode: 12,
        stdout: "1234567890ab...[truncated]",
        stderr: "failure-deta...[truncated]",
      }),
    );

    expect(logs).toEqual([
      {
        level: "info",
        event: "workspace_hook_started",
        hook: "beforeRun",
        workspacePath: "/tmp/workspace",
      },
      expect.objectContaining({
        level: "error",
        event: "workspace_hook_failed",
        hook: "beforeRun",
        workspacePath: "/tmp/workspace",
        exitCode: 12,
        errorCode: ERROR_CODES.hookFailed,
        stdout: "1234567890ab...[truncated]",
        stderr: "failure-deta...[truncated]",
      }),
    ]);
  });

  it("maps executor timeout signals to hook timeout errors", async () => {
    const logs: WorkspaceHookLogEntry[] = [];
    const runner = new WorkspaceHookRunner({
      config: {
        afterCreate: null,
        beforeRun: "sleep 10",
        afterRun: null,
        beforeRemove: null,
        timeoutMs: 25,
      },
      log: (entry) => {
        logs.push(entry);
      },
      execute: vi.fn().mockRejectedValue(new WorkspaceHookTimeoutError(25)),
    });

    await expect(
      runner.run({
        name: "beforeRun",
        workspacePath: "/tmp/workspace",
      }),
    ).rejects.toThrowError(
      expect.objectContaining<Partial<WorkspaceHookError>>({
        code: ERROR_CODES.hookTimedOut,
      }),
    );

    expect(logs).toEqual([
      {
        level: "info",
        event: "workspace_hook_started",
        hook: "beforeRun",
        workspacePath: "/tmp/workspace",
      },
      expect.objectContaining({
        level: "error",
        event: "workspace_hook_timed_out",
        hook: "beforeRun",
        workspacePath: "/tmp/workspace",
        errorCode: ERROR_CODES.hookTimedOut,
        exitCode: null,
      }),
    ]);
  });

  it("maps generic executor failures to non-timeout hook execution errors", async () => {
    const logs: WorkspaceHookLogEntry[] = [];
    const executorError = new Error("spawn ENOENT");
    const runner = new WorkspaceHookRunner({
      config: {
        afterCreate: null,
        beforeRun: "sh ./missing",
        afterRun: null,
        beforeRemove: null,
        timeoutMs: 25,
      },
      log: (entry) => {
        logs.push(entry);
      },
      execute: vi.fn().mockRejectedValue(executorError),
    });

    await expect(
      runner.run({
        name: "beforeRun",
        workspacePath: "/tmp/workspace",
      }),
    ).rejects.toThrowError(
      expect.objectContaining<Partial<WorkspaceHookError>>({
        code: ERROR_CODES.hookExecutionFailed,
        cause: executorError,
      }),
    );

    expect(logs).toEqual([
      {
        level: "info",
        event: "workspace_hook_started",
        hook: "beforeRun",
        workspacePath: "/tmp/workspace",
      },
      expect.objectContaining({
        level: "error",
        event: "workspace_hook_failed",
        hook: "beforeRun",
        workspacePath: "/tmp/workspace",
        errorCode: ERROR_CODES.hookExecutionFailed,
        exitCode: null,
      }),
    ]);
  });

  it("passes env variables to the hook executor", async () => {
    const execute = vi.fn().mockResolvedValue({
      exitCode: 0,
      signal: null,
      stdout: "",
      stderr: "",
    });
    const runner = new WorkspaceHookRunner({
      config: {
        afterCreate: null,
        beforeRun: "echo hello",
        afterRun: null,
        beforeRemove: null,
        timeoutMs: 100,
      },
      execute,
    });

    await runner.run({
      name: "beforeRun",
      workspacePath: "/tmp/workspace",
      env: { SYMPHONY_STAGE: "implement" },
    });

    expect(execute).toHaveBeenCalledWith("echo hello", {
      cwd: "/tmp/workspace",
      timeoutMs: 100,
      env: expect.objectContaining({
        SYMPHONY_STAGE: "implement",
        GIT_CEILING_DIRECTORIES: expect.stringMatching(/(^|:)\/tmp$/),
      }),
    });
  });

  it("does not let caller env weaken the git isolation ceiling", async () => {
    const execute = vi.fn().mockResolvedValue({
      exitCode: 0,
      signal: null,
      stdout: "",
      stderr: "",
    });
    const runner = new WorkspaceHookRunner({
      config: {
        afterCreate: null,
        beforeRun: "echo hello",
        afterRun: null,
        beforeRemove: null,
        timeoutMs: 100,
      },
      execute,
    });

    await runner.run({
      name: "beforeRun",
      workspacePath: "/tmp/workspace",
      env: { GIT_CEILING_DIRECTORIES: "" },
    });

    const env = execute.mock.calls[0]?.[1]?.env as Record<string, string>;
    expect(env.GIT_CEILING_DIRECTORIES).toMatch(/(^|:)\/tmp$/);
  });

  it("always injects the git isolation env, even without caller env", async () => {
    const execute = vi.fn().mockResolvedValue({
      exitCode: 0,
      signal: null,
      stdout: "",
      stderr: "",
    });
    const runner = new WorkspaceHookRunner({
      config: {
        afterCreate: null,
        beforeRun: "echo hello",
        afterRun: null,
        beforeRemove: null,
        timeoutMs: 100,
      },
      execute,
    });

    await runner.run({
      name: "beforeRun",
      workspacePath: "/tmp/workspace",
    });

    expect(execute).toHaveBeenCalledWith("echo hello", {
      cwd: "/tmp/workspace",
      timeoutMs: 100,
      env: expect.objectContaining({
        GIT_CEILING_DIRECTORIES: expect.stringMatching(/(^|:)\/tmp$/),
      }),
    });
  });

  it("executes a resolved hook path containing spaces end-to-end (SYMPH-285)", async () => {
    // Disposable workspace smoke: a real workflow dir with a space in its
    // name, a real hook script, the real shell executor — no mocks.
    const workflowDir = await mkdtemp(join(tmpdir(), "symphony hooks "));
    const workspaceDir = await mkdtemp(join(tmpdir(), "symphony-ws-"));
    try {
      const hooksDir = join(workflowDir, "hooks");
      await mkdir(hooksDir);
      const scriptPath = join(hooksDir, "after-create.sh");
      await writeFile(scriptPath, "#!/bin/sh\necho hook-ran\n");
      await chmod(scriptPath, 0o755);

      const resolved = resolveWorkflowConfig({
        workflowPath: join(workflowDir, "WORKFLOW.md"),
        promptTemplate: "Prompt",
        config: {
          hooks: {
            after_create: "./hooks/after-create.sh",
          },
        },
      });

      const logs: WorkspaceHookLogEntry[] = [];
      const runner = new WorkspaceHookRunner({
        config: resolved.hooks,
        log: (entry) => {
          logs.push(entry);
        },
      });

      await expect(
        runner.run({
          name: "afterCreate",
          workspacePath: workspaceDir,
        }),
      ).resolves.toBe(true);
      const completed = logs.find(
        (entry) => entry.event === "workspace_hook_completed",
      );
      expect(completed?.stdout).toContain("hook-ran");
    } finally {
      await rm(workflowDir, { recursive: true, force: true });
      await rm(workspaceDir, { recursive: true, force: true });
    }
  });

  it("suppresses errors in best-effort mode", async () => {
    const runner = new WorkspaceHookRunner({
      config: {
        afterCreate: null,
        beforeRun: null,
        afterRun: "echo cleanup",
        beforeRemove: null,
        timeoutMs: 100,
      },
      execute: vi.fn().mockResolvedValue({
        exitCode: 1,
        signal: null,
        stdout: "",
        stderr: "broken",
      }),
    });

    await expect(
      runner.runBestEffort({
        name: "afterRun",
        workspacePath: "/tmp/workspace",
      }),
    ).resolves.toBe(false);
  });
});
