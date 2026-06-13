import { EventEmitter } from "node:events";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  signalPidOrProcessGroup,
  terminateChildProcessTree,
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
});
