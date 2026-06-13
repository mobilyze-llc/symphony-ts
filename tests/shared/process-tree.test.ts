import { EventEmitter } from "node:events";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  type ProcessIdentitySnapshot,
  processIdentityMatches,
  readProcessIdentity,
  readProcessIdentityMetadata,
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

  it("can wait for graceful child exit without escalating to SIGKILL", async () => {
    vi.useFakeTimers();
    const child = new EventEmitter() as EventEmitter & {
      pid: number;
      exitCode: number | null;
      signalCode: NodeJS.Signals | null;
    };
    child.pid = 1234;
    child.exitCode = null;
    child.signalCode = null;
    const calls: Array<{ pid: number; signal: string | number | undefined }> =
      [];

    const pending = terminateChildProcessTree(child, {
      forceKillAfterGrace: false,
      graceMs: 1_000,
      kill: ((pid: number, signal?: string | number) => {
        calls.push({ pid, signal });
        return true;
      }) as typeof process.kill,
    });

    child.exitCode = 0;
    child.emit("exit");
    await vi.advanceTimersByTimeAsync(1_100);
    const result = await pending;

    expect(result).toEqual({
      pid: 1234,
      sigtermSent: true,
      sigkillSent: false,
    });
    expect(calls).toEqual([{ pid: -1234, signal: "SIGTERM" }]);
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

  it("terminates a recovered detached process tree only when identity matches", async () => {
    vi.useFakeTimers();
    const identity = createProcessIdentity(1234);
    const calls: Array<{ pid: number; signal: NodeJS.Signals }> = [];
    const probeIdentity = vi.fn(async () => identity);

    const pending = terminateDetachedPidTree(1234, {
      graceMs: 1_000,
      expectedIdentity: identity,
      probeIdentity,
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
    expect(probeIdentity).toHaveBeenCalledTimes(2);
    expect(calls).toEqual([
      { pid: -1234, signal: "SIGTERM" },
      { pid: -1234, signal: "SIGKILL" },
    ]);
  });

  it("cleans up a recovered detached process tree when the expected process is already absent", async () => {
    vi.useFakeTimers();
    const calls: Array<{ pid: number; signal: string | number | undefined }> =
      [];
    const probeIdentity = vi.fn(async () => null);

    const pending = terminateDetachedPidTree(1234, {
      graceMs: 1_000,
      expectedIdentity: createProcessIdentity(1234),
      probeIdentity,
      kill: ((pid: number, signal?: string | number) => {
        calls.push({ pid, signal });
        if (pid === 1234 && signal === 0) {
          throw createNoSuchProcessError();
        }
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
    expect(probeIdentity).toHaveBeenCalledTimes(2);
    expect(calls).toEqual([
      { pid: 1234, signal: 0 },
      { pid: -1234, signal: "SIGTERM" },
      { pid: 1234, signal: 0 },
      { pid: -1234, signal: "SIGKILL" },
    ]);
  });

  it("finishes recovered detached cleanup when the expected identity exits during grace", async () => {
    vi.useFakeTimers();
    const identity = createProcessIdentity(1234);
    const calls: Array<{ pid: number; signal: string | number | undefined }> =
      [];
    const probeIdentity = vi
      .fn()
      .mockResolvedValueOnce(identity)
      .mockResolvedValueOnce(null);

    const pending = terminateDetachedPidTree(1234, {
      graceMs: 1_000,
      expectedIdentity: identity,
      probeIdentity,
      kill: ((pid: number, signal?: string | number) => {
        calls.push({ pid, signal });
        if (pid === 1234 && signal === 0) {
          throw createNoSuchProcessError();
        }
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
      { pid: 1234, signal: 0 },
      { pid: -1234, signal: "SIGKILL" },
    ]);
  });

  it("refuses recovered detached cleanup when identity probing is inconclusive but the pid still exists", async () => {
    vi.useFakeTimers();
    const calls: Array<{ pid: number; signal: string | number | undefined }> =
      [];

    const result = await terminateDetachedPidTree(1234, {
      graceMs: 1_000,
      expectedIdentity: createProcessIdentity(1234),
      probeIdentity: vi.fn(async () => null),
      kill: ((pid: number, signal?: string | number) => {
        calls.push({ pid, signal });
        return true;
      }) as typeof process.kill,
    });

    await vi.advanceTimersByTimeAsync(1_100);

    expect(result).toEqual({
      pid: 1234,
      sigtermSent: false,
      sigkillSent: false,
    });
    expect(calls).toEqual([{ pid: 1234, signal: 0 }]);
  });

  it("refuses recovered detached cleanup when the process identity mismatches before SIGTERM", async () => {
    vi.useFakeTimers();
    const calls: Array<{ pid: number; signal: NodeJS.Signals }> = [];

    const result = await terminateDetachedPidTree(1234, {
      graceMs: 1_000,
      expectedIdentity: createProcessIdentity(1234),
      probeIdentity: vi.fn(async () =>
        createProcessIdentity(1234, { launchToken: "other-token" }),
      ),
      kill: ((pid: number, signal?: string | number) => {
        calls.push({ pid, signal: signal as NodeJS.Signals });
        return true;
      }) as typeof process.kill,
    });

    await vi.advanceTimersByTimeAsync(1_100);

    expect(result).toEqual({
      pid: 1234,
      sigtermSent: false,
      sigkillSent: false,
    });
    expect(calls).toEqual([]);
  });

  it("re-checks recovered detached process identity before SIGKILL", async () => {
    vi.useFakeTimers();
    const identity = createProcessIdentity(1234);
    const calls: Array<{ pid: number; signal: NodeJS.Signals }> = [];
    const probeIdentity = vi
      .fn()
      .mockResolvedValueOnce(identity)
      .mockResolvedValueOnce(
        createProcessIdentity(1234, { launchToken: "reused-pid" }),
      );

    const pending = terminateDetachedPidTree(1234, {
      graceMs: 1_000,
      expectedIdentity: identity,
      probeIdentity,
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
      sigkillSent: false,
    });
    expect(calls).toEqual([{ pid: -1234, signal: "SIGTERM" }]);
  });

  it("accepts tokenless process identities when stable process metadata matches", () => {
    const identity = createProcessIdentity(1234, { launchToken: null });

    expect(processIdentityMatches(identity, identity)).toBe(true);
  });

  it("rejects tokenless process identities when command metadata changes", () => {
    const expected = createProcessIdentity(1234, { launchToken: null });
    const observed = createProcessIdentity(1234, {
      command: "node reused-process.js",
      launchToken: null,
    });

    expect(processIdentityMatches(expected, observed)).toBe(false);
  });

  it("reads serialized process identity metadata with a launch token", () => {
    expect(readProcessIdentityMetadata(createProcessIdentity(1234))).toEqual(
      createProcessIdentity(1234),
    );
  });

  it("reads tokenless serialized process identity metadata", () => {
    const identity = createProcessIdentity(1234, { launchToken: null });

    expect(readProcessIdentityMetadata(identity)).toEqual(identity);
  });

  it("rejects malformed serialized process identity metadata", () => {
    expect(
      readProcessIdentityMetadata({
        ...createProcessIdentity(1234),
        launchToken: "",
      }),
    ).toBeNull();
    expect(
      readProcessIdentityMetadata({
        ...createProcessIdentity(1234),
        processGroupId: null,
      }),
    ).toBeNull();
  });

  it("reads Linux process identity from /proc stat, cmdline, and environ", async () => {
    const identity = await readProcessIdentity(1234, {
      readFile: async (path) => {
        if (path.endsWith("/stat")) {
          return "1234 (bash) S 1 1234 1234 0 -1 4194560 0 0 0 0 1 2 0 0 20 0 1 0 987654 0 0";
        }
        if (path.endsWith("/cmdline")) {
          return "bash\0-lc\0codex-app-server\0";
        }
        if (path.endsWith("/environ")) {
          return "PATH=/bin\0SYMPHONY_CODEX_APP_SERVER_TOKEN=launch-token\0";
        }
        throw new Error(`unexpected path ${path}`);
      },
      execFile: async () => {
        throw new Error("ps fallback should not run");
      },
    });

    expect(identity).toEqual({
      pid: 1234,
      processGroupId: 1234,
      sessionId: 1234,
      startedAt: "linux-starttime:987654",
      command: "bash -lc codex-app-server",
      launchToken: "launch-token",
    });
  });

  it("reads ps fallback process identity with a zero session id", async () => {
    const identity = await readProcessIdentity(1234, {
      readFile: async () => {
        throw new Error("no procfs");
      },
      execFile: async (_file, args) => {
        if (args.includes("pgid=")) {
          return {
            stdout: "1234 0 Sat Jun 13 07:00:18 2026 sleep 5\n",
          };
        }
        if (args.includes("eww")) {
          return { stdout: "sleep 5\n" };
        }
        throw new Error(`unexpected args ${args.join(" ")}`);
      },
    });

    expect(identity).toEqual({
      pid: 1234,
      processGroupId: 1234,
      sessionId: 0,
      startedAt: "Sat Jun 13 07:00:18 2026",
      command: "sleep 5",
      launchToken: null,
    });
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

function createProcessIdentity(
  pid: number,
  overrides: Partial<ProcessIdentitySnapshot> = {},
): ProcessIdentitySnapshot {
  return {
    pid,
    processGroupId: pid,
    sessionId: pid,
    startedAt: "linux-starttime:123456",
    command: "bash -lc codex-app-server",
    launchToken: "launch-token",
    ...overrides,
  };
}

function createNoSuchProcessError(): Error & { code: string } {
  const error = new Error("missing process") as Error & { code: string };
  error.code = "ESRCH";
  return error;
}
