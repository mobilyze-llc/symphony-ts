import { PassThrough } from "node:stream";

import { describe, expect, it } from "vitest";

import {
  type StructuredLogEntry,
  StructuredLogger,
  createJsonLineSink,
  createStructuredLogEntry,
  formatStructuredMessage,
} from "../../src/logging/structured-logger.js";

describe("structured logger", () => {
  it("formats stable key=value messages with ordered context", () => {
    expect(
      formatStructuredMessage("worker_exit", "agent turn completed", {
        outcome: "completed",
        issue_id: "issue-1",
        issue_identifier: "ABC-123",
        session_id: "thread-1-turn-1",
        duration_ms: 2500,
      }),
    ).toBe(
      'event=worker_exit outcome=completed issue_id=issue-1 issue_identifier=ABC-123 session_id=thread-1-turn-1 duration_ms=2500 message="agent turn completed"',
    );
  });

  it("emits warnings to remaining sinks when a sink write fails", async () => {
    const entries: StructuredLogEntry[] = [];
    const logger = new StructuredLogger([
      {
        write(entry) {
          entries.push(entry);
        },
      },
      {
        write() {
          throw new Error("boom");
        },
      },
    ]);

    await logger.info("dispatch", "issue claimed", {
      outcome: "completed",
      issue_id: "issue-1",
      issue_identifier: "ABC-123",
    });

    expect(entries).toHaveLength(2);
    expect(entries[0]).toMatchObject({
      event: "dispatch",
      level: "info",
    });
    expect(entries[1]).toMatchObject({
      event: "log_sink_failed",
      level: "warn",
      outcome: "degraded",
      reason: "sink_write_failed",
    });
  });

  it("writes structured JSON lines to streams", async () => {
    const stream = new PassThrough();
    let buffer = "";
    stream.on("data", (chunk: Buffer) => {
      buffer += chunk.toString("utf8");
    });

    const sink = createJsonLineSink(stream);
    const entry = createStructuredLogEntry(
      {
        level: "info",
        event: "startup",
        message: "service started",
      },
      {
        outcome: "completed",
      },
      new Date("2026-03-06T10:00:00.000Z"),
    );

    await sink.write(entry);

    expect(buffer).toContain('"event":"startup"');
    expect(buffer).toContain('"outcome":"completed"');
  });
});
