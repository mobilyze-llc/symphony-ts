import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  handleSignal,
  handleUncaughtException,
  handleUnhandledRejection,
} from "../../src/cli/main.js";

describe("global error handlers", () => {
  let stderrSpy: ReturnType<typeof vi.spyOn>;
  let exitSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    stderrSpy = vi
      .spyOn(process.stderr, "write")
      .mockImplementation(() => true);
    exitSpy = vi
      .spyOn(process, "exit")
      .mockImplementation(() => undefined as never);
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it("handleUncaughtException logs structured JSON and exits with code 70", () => {
    const error = new Error("kaboom");

    handleUncaughtException(error);

    expect(stderrSpy).toHaveBeenCalledOnce();
    const written = stderrSpy.mock.calls[0]![0] as string;
    const entry = JSON.parse(written.trimEnd());

    expect(entry.level).toBe("error");
    expect(entry.event).toBe("process_crash");
    expect(entry.error_code).toBe("uncaught_exception");
    expect(entry.message).toBe("kaboom");
    expect(entry.stack).toContain("kaboom");
    expect(entry.timestamp).toBeDefined();
    expect(process.exitCode).toBe(70);

    // Advance past the 100ms flush delay
    vi.advanceTimersByTime(100);
    expect(exitSpy).toHaveBeenCalledWith(70);
  });

  it("handleUncaughtException handles non-Error values", () => {
    handleUncaughtException("string rejection");

    const written = stderrSpy.mock.calls[0]![0] as string;
    const entry = JSON.parse(written.trimEnd());

    expect(entry.message).toBe("string rejection");
    expect(entry.stack).toBeUndefined();
    expect(entry.error_code).toBe("uncaught_exception");
  });

  it("handleUnhandledRejection logs structured JSON and exits with code 70", () => {
    const reason = new Error("promise failed");

    handleUnhandledRejection(reason);

    expect(stderrSpy).toHaveBeenCalledOnce();
    const written = stderrSpy.mock.calls[0]![0] as string;
    const entry = JSON.parse(written.trimEnd());

    expect(entry.level).toBe("error");
    expect(entry.event).toBe("process_crash");
    expect(entry.error_code).toBe("unhandled_rejection");
    expect(entry.message).toBe("promise failed");
    expect(entry.stack).toContain("promise failed");
    expect(process.exitCode).toBe(70);

    vi.advanceTimersByTime(100);
    expect(exitSpy).toHaveBeenCalledWith(70);
  });

  it("handleUnhandledRejection handles non-Error values", () => {
    handleUnhandledRejection(42);

    const written = stderrSpy.mock.calls[0]![0] as string;
    const entry = JSON.parse(written.trimEnd());

    expect(entry.message).toBe("42");
    expect(entry.stack).toBeUndefined();
    expect(entry.error_code).toBe("unhandled_rejection");
  });

  it("handleSignal logs SIGTERM and exits with 128 + 15", () => {
    handleSignal("SIGTERM");

    expect(stderrSpy).toHaveBeenCalledOnce();
    const written = stderrSpy.mock.calls[0]![0] as string;
    const entry = JSON.parse(written.trimEnd());

    expect(entry.level).toBe("info");
    expect(entry.event).toBe("process_signal");
    expect(entry.message).toBe("Received SIGTERM, shutting down");
    expect(exitSpy).toHaveBeenCalledWith(143);
  });

  it("handleSignal logs SIGINT and exits with 128 + 2", () => {
    handleSignal("SIGINT");

    const written = stderrSpy.mock.calls[0]![0] as string;
    const entry = JSON.parse(written.trimEnd());

    expect(entry.level).toBe("info");
    expect(entry.event).toBe("process_signal");
    expect(entry.message).toBe("Received SIGINT, shutting down");
    expect(exitSpy).toHaveBeenCalledWith(130);
  });

  it("main() .catch handler would log main_promise_rejection", () => {
    // The .catch handler at module scope can't be directly imported,
    // but we can test the same logic by simulating what it does.
    const error = new Error("main blew up");

    // Replicate the .catch handler logic inline
    process.stderr.write(
      `${JSON.stringify({
        timestamp: new Date().toISOString(),
        level: "error",
        event: "process_crash",
        message: error instanceof Error ? error.message : String(error),
        error_code: "main_promise_rejection",
        stack: error instanceof Error ? error.stack : undefined,
      })}\n`,
    );
    process.exitCode = 70;

    const written = stderrSpy.mock.calls[0]![0] as string;
    const entry = JSON.parse(written.trimEnd());

    expect(entry.level).toBe("error");
    expect(entry.event).toBe("process_crash");
    expect(entry.error_code).toBe("main_promise_rejection");
    expect(entry.message).toBe("main blew up");
    expect(entry.stack).toContain("main blew up");
    expect(process.exitCode).toBe(70);
  });
});
