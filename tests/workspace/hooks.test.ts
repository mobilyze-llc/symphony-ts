import { describe, expect, it, vi } from "vitest";

import {
  ERROR_CODES,
  type WorkspaceHookError,
  type WorkspaceHookLogEntry,
  WorkspaceHookRunner,
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

  it("maps executor failures to hook timeout errors", async () => {
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
      execute: vi.fn().mockRejectedValue(new Error("timed out")),
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
      env: { SYMPHONY_STAGE: "implement" },
    });
  });

  it("omits env when not provided", async () => {
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
    });
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
