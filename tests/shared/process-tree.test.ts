import { EventEmitter } from "node:events";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  signalPidOrProcessGroup,
  terminateChildProcessTree,
  terminateDetachedPidTree,
} from "../../src/shared/process-tree.js";

describe("process tree termination", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("sends SIGTERM to the process group then escalates to SIGKILL", async () => {
    vi.useFakeTimers();
    const child = new EventEmitter() as EventEmitter & {
      pid: number;
      exitCode: number | null;
      signalCode: NodeJS.Signals | null;
    };
    child.pid = 1234;
    child.exitCode = null;
    child.signalCode = null;
    const calls: Array<{ pid: number; signal: NodeJS.Signals }> = [];

    const pending = terminateChildProcessTree(child, {
      graceMs: 1_000,
      kill: ((pid: number, signal?: string | number) => {
        calls.push({ pid, signal: signal as NodeJS.Signals });
        return true;
      }) as typeof process.kill,
    });

    await vi.advanceTimersByTimeAsync(1_100);
    const result = await pending;

    expect(result).toEqual({
      pid: 1234,
      sigtermSent: true,
      sigkillSent: true,
    });
    expect(calls).toEqual([
      { pid: -1234, signal: "SIGTERM" },
      { pid: -1234, signal: "SIGKILL" },
    ]);
  });

  it("still escalates when the process-group leader exits during grace", async () => {
    vi.useFakeTimers();
    const child = new EventEmitter() as EventEmitter & {
      pid: number;
      exitCode: number | null;
      signalCode: NodeJS.Signals | null;
    };
    child.pid = 1234;
    child.exitCode = null;
    child.signalCode = null;
    const calls: Array<{ pid: number; signal: NodeJS.Signals }> = [];

    const pending = terminateChildProcessTree(child, {
      graceMs: 1_000,
      kill: ((pid: number, signal?: string | number) => {
        calls.push({ pid, signal: signal as NodeJS.Signals });
        return true;
      }) as typeof process.kill,
    });

    child.signalCode = "SIGTERM";
    child.emit("exit");
    await vi.advanceTimersByTimeAsync(1_100);
    const result = await pending;

    expect(result).toEqual({
      pid: 1234,
      sigtermSent: true,
      sigkillSent: true,
    });
    expect(calls).toEqual([
      { pid: -1234, signal: "SIGTERM" },
      { pid: -1234, signal: "SIGKILL" },
    ]);
  });

  it("does not signal or wait when the child already exited before teardown", async () => {
    vi.useFakeTimers();
    const child = new EventEmitter() as EventEmitter & {
      pid: number;
      exitCode: number | null;
      signalCode: NodeJS.Signals | null;
    };
    child.pid = 1234;
    child.exitCode = 0;
    child.signalCode = null;
    const kill = vi.fn() as unknown as typeof process.kill;

    const result = await terminateChildProcessTree(child, {
      graceMs: 1_000,
      kill,
    });

    await vi.advanceTimersByTimeAsync(1_100);

    expect(result).toEqual({
      pid: 1234,
      sigtermSent: false,
      sigkillSent: false,
    });
    expect(kill).not.toHaveBeenCalled();
  });

  it("escalates detached process groups without checking leader liveness", async () => {
    vi.useFakeTimers();
    const calls: Array<{ pid: number; signal: NodeJS.Signals }> = [];

    const pending = terminateDetachedPidTree(1234, {
      graceMs: 1_000,
      kill: ((pid: number, signal?: string | number) => {
        calls.push({ pid, signal: signal as NodeJS.Signals });
        return true;
      }) as typeof process.kill,
    });

    await vi.advanceTimersByTimeAsync(1_100);
    const result = await pending;

    expect(result).toEqual({
      pid: 1234,
      sigtermSent: true,
      sigkillSent: true,
    });
    expect(calls).toEqual([
      { pid: -1234, signal: "SIGTERM" },
      { pid: -1234, signal: "SIGKILL" },
    ]);
  });

  it("falls back to the child pid when the process group is already gone", () => {
    const calls: Array<{ pid: number; signal: NodeJS.Signals }> = [];
    const kill = ((pid: number, signal?: string | number) => {
      calls.push({ pid, signal: signal as NodeJS.Signals });
      if (pid < 0) {
        const error = new Error("missing process group") as Error & {
          code: string;
        };
        error.code = "ESRCH";
        throw error;
      }
      return true;
    }) as typeof process.kill;

    expect(signalPidOrProcessGroup(55, "SIGTERM", kill)).toBe(true);
    expect(calls).toEqual([
      { pid: -55, signal: "SIGTERM" },
      { pid: 55, signal: "SIGTERM" },
    ]);
  });

  it("falls back to the child pid when group signaling is denied", () => {
    const calls: Array<{ pid: number; signal: NodeJS.Signals }> = [];
    const kill = ((pid: number, signal?: string | number) => {
      calls.push({ pid, signal: signal as NodeJS.Signals });
      if (pid < 0) {
        const error = new Error("process group denied") as Error & {
          code: string;
        };
        error.code = "EPERM";
        throw error;
      }
      return true;
    }) as typeof process.kill;

    expect(signalPidOrProcessGroup(55, "SIGTERM", kill)).toBe(true);
    expect(calls).toEqual([
      { pid: -55, signal: "SIGTERM" },
      { pid: 55, signal: "SIGTERM" },
    ]);
  });

  it("reports failure when both process-group and direct-pid signaling fail", () => {
    const calls: Array<{ pid: number; signal: NodeJS.Signals }> = [];
    const kill = ((pid: number, signal?: string | number) => {
      calls.push({ pid, signal: signal as NodeJS.Signals });
      const error = new Error("signal denied") as Error & { code: string };
      error.code = "EPERM";
      throw error;
    }) as typeof process.kill;

    expect(signalPidOrProcessGroup(55, "SIGTERM", kill)).toBe(false);
    expect(calls).toEqual([
      { pid: -55, signal: "SIGTERM" },
      { pid: 55, signal: "SIGTERM" },
    ]);
  });
});
