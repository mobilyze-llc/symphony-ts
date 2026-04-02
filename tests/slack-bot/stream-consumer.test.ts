import { describe, expect, it, vi } from "vitest";

import { SLACK_MAX_CHARS } from "../../src/chunking.js";
import { StreamConsumer } from "../../src/slack-bot/stream-consumer.js";

/** Create a mock WebClient with chatStream support. */
function createMockClient() {
  const mockStreamer = {
    append: vi.fn().mockResolvedValue(undefined),
    stop: vi.fn().mockResolvedValue(undefined),
  };

  const client = {
    chatStream: vi.fn().mockReturnValue(mockStreamer),
  };

  return { client, mockStreamer };
}

describe("StreamConsumer", () => {
  it("creates stream lazily on first append", async () => {
    const { client, mockStreamer } = createMockClient();

    const consumer = new StreamConsumer(
      client as never,
      "C123",
      "1234.5678",
      "U456",
      "T789",
    );

    // No stream created yet
    expect(client.chatStream).not.toHaveBeenCalled();

    await consumer.append("Hello");

    // Now stream should be created
    expect(client.chatStream).toHaveBeenCalledTimes(1);
    expect(client.chatStream).toHaveBeenCalledWith({
      channel: "C123",
      thread_ts: "1234.5678",
      recipient_user_id: "U456",
      recipient_team_id: "T789",
    });

    // Text should be appended
    expect(mockStreamer.append).toHaveBeenCalledWith({
      markdown_text: "Hello",
    });
  });

  it("finish is a no-op when no stream was started", async () => {
    const { client } = createMockClient();

    const consumer = new StreamConsumer(
      client as never,
      "C123",
      "1234.5678",
      "U456",
      "T789",
    );

    // Should not throw
    await consumer.finish();
    expect(client.chatStream).not.toHaveBeenCalled();
  });

  it("finish stops the current stream", async () => {
    const { client, mockStreamer } = createMockClient();

    const consumer = new StreamConsumer(
      client as never,
      "C123",
      "1234.5678",
      "U456",
      "T789",
    );

    await consumer.append("Hello");
    await consumer.finish();

    expect(mockStreamer.stop).toHaveBeenCalledTimes(1);
  });

  it("handles overflow by starting a new stream at 39K boundary", async () => {
    const streamers = [
      {
        append: vi.fn().mockResolvedValue(undefined),
        stop: vi.fn().mockResolvedValue(undefined),
      },
      {
        append: vi.fn().mockResolvedValue(undefined),
        stop: vi.fn().mockResolvedValue(undefined),
      },
    ];
    let streamIndex = 0;

    const client = {
      chatStream: vi.fn().mockImplementation(() => {
        const s = streamers[streamIndex];
        streamIndex++;
        return s;
      }),
    };

    const consumer = new StreamConsumer(
      client as never,
      "C123",
      "1234.5678",
      "U456",
      "T789",
    );

    // Append text that's just under the limit
    const nearLimit = "x".repeat(SLACK_MAX_CHARS - 100);
    await consumer.append(nearLimit);

    expect(client.chatStream).toHaveBeenCalledTimes(1);

    // Append text that pushes over the limit
    const overflow = "y".repeat(200);
    await consumer.append(overflow);

    // Should have created a second stream
    expect(client.chatStream).toHaveBeenCalledTimes(2);

    // First stream should have been stopped
    expect(streamers[0]!.stop).toHaveBeenCalledTimes(1);

    // Second stream should have the overflow text
    expect(streamers[1]!.append).toHaveBeenCalledWith({
      markdown_text: overflow,
    });

    await consumer.finish();
    expect(streamers[1]!.stop).toHaveBeenCalledTimes(1);
  });

  it("handles undefined teamId", async () => {
    const { client } = createMockClient();

    const consumer = new StreamConsumer(
      client as never,
      "C123",
      "1234.5678",
      "U456",
      undefined,
    );

    await consumer.append("Hello");

    expect(client.chatStream).toHaveBeenCalledWith({
      channel: "C123",
      thread_ts: "1234.5678",
      recipient_user_id: "U456",
    });
  });

  it("suppresses errors from stop during cleanup", async () => {
    const mockStreamer = {
      append: vi.fn().mockResolvedValue(undefined),
      stop: vi.fn().mockRejectedValue(new Error("stream already stopped")),
    };

    const client = {
      chatStream: vi.fn().mockReturnValue(mockStreamer),
    };

    const consumer = new StreamConsumer(
      client as never,
      "C123",
      "1234.5678",
      "U456",
      "T789",
    );

    await consumer.append("Hello");

    // Should not throw even though stop() rejects
    await consumer.finish();
  });

  it("appends multiple chunks to the same stream within limit", async () => {
    const { client, mockStreamer } = createMockClient();

    const consumer = new StreamConsumer(
      client as never,
      "C123",
      "1234.5678",
      "U456",
      "T789",
    );

    await consumer.append("Hello ");
    await consumer.append("world");

    // Only one stream created
    expect(client.chatStream).toHaveBeenCalledTimes(1);

    // Two appends
    expect(mockStreamer.append).toHaveBeenCalledTimes(2);
    expect(mockStreamer.append).toHaveBeenNthCalledWith(1, {
      markdown_text: "Hello ",
    });
    expect(mockStreamer.append).toHaveBeenNthCalledWith(2, {
      markdown_text: "world",
    });

    await consumer.finish();
  });

  it("recovers from message_not_in_streaming_state by creating a new stream", async () => {
    const streamExpiredError = Object.assign(
      new Error("An API error occurred: message_not_in_streaming_state"),
      {
        code: "slack_webapi_platform_error",
        data: { ok: false, error: "message_not_in_streaming_state" },
      },
    );

    const streamers = [
      {
        append: vi.fn().mockRejectedValue(streamExpiredError),
        stop: vi.fn().mockResolvedValue(undefined),
      },
      {
        append: vi.fn().mockResolvedValue(undefined),
        stop: vi.fn().mockResolvedValue(undefined),
      },
    ];
    let streamIndex = 0;
    const client = {
      chatStream: vi.fn().mockImplementation(() => {
        const s = streamers[streamIndex];
        streamIndex++;
        return s;
      }),
    };

    const consumer = new StreamConsumer(
      client as never,
      "C123",
      "1234.5678",
      "U456",
      "T789",
    );

    await consumer.append("Hello after gap");

    // Should have created two streams: original + recovery
    expect(client.chatStream).toHaveBeenCalledTimes(2);

    // Dead streamer's stop should NOT be called (server already finalized)
    expect(streamers[0]!.stop).not.toHaveBeenCalled();

    // Fresh streamer should have received the retried text
    expect(streamers[1]!.append).toHaveBeenCalledWith({
      markdown_text: "Hello after gap",
    });
  });

  it("rethrows non-streaming errors from append", async () => {
    const rateLimitError = Object.assign(
      new Error("An API error occurred: rate_limited"),
      {
        code: "slack_webapi_platform_error",
        data: { ok: false, error: "rate_limited" },
      },
    );

    const mockStreamer = {
      append: vi.fn().mockRejectedValue(rateLimitError),
      stop: vi.fn().mockResolvedValue(undefined),
    };
    const client = {
      chatStream: vi.fn().mockReturnValue(mockStreamer),
    };

    const consumer = new StreamConsumer(
      client as never,
      "C123",
      "1234.5678",
      "U456",
      "T789",
    );

    await expect(consumer.append("Hello")).rejects.toThrow("rate_limited");

    // Should not have attempted recovery (only one stream created)
    expect(client.chatStream).toHaveBeenCalledTimes(1);
  });

  it("recovers mid-stream when timeout occurs after successful appends", async () => {
    const streamExpiredError = Object.assign(
      new Error("An API error occurred: message_not_in_streaming_state"),
      {
        code: "slack_webapi_platform_error",
        data: { ok: false, error: "message_not_in_streaming_state" },
      },
    );

    const streamers = [
      {
        append: vi
          .fn()
          .mockResolvedValueOnce(undefined)
          .mockResolvedValueOnce(undefined)
          .mockRejectedValueOnce(streamExpiredError),
        stop: vi.fn().mockResolvedValue(undefined),
      },
      {
        append: vi.fn().mockResolvedValue(undefined),
        stop: vi.fn().mockResolvedValue(undefined),
      },
    ];
    let streamIndex = 0;
    const client = {
      chatStream: vi.fn().mockImplementation(() => {
        const s = streamers[streamIndex];
        streamIndex++;
        return s;
      }),
    };

    const consumer = new StreamConsumer(
      client as never,
      "C123",
      "1234.5678",
      "U456",
      "T789",
    );

    // First two appends succeed on the original stream
    await consumer.append("chunk1");
    await consumer.append("chunk2");
    expect(client.chatStream).toHaveBeenCalledTimes(1);

    // Third append fails with stream expiry, triggers recovery
    await consumer.append("chunk3");
    expect(client.chatStream).toHaveBeenCalledTimes(2);

    // Recovery stream received the failed chunk
    expect(streamers[1]!.append).toHaveBeenCalledWith({
      markdown_text: "chunk3",
    });

    // Subsequent appends work on the new stream
    await consumer.append("chunk4");
    expect(streamers[1]!.append).toHaveBeenCalledTimes(2);
    expect(streamers[1]!.append).toHaveBeenNthCalledWith(2, {
      markdown_text: "chunk4",
    });
  });

  it("recovers via message-only fallback when structured error fields are absent", async () => {
    // Error has message_not_in_streaming_state in message but no code/data fields,
    // exercising the defensive fallback path in isStreamExpiredError (lines 45-50)
    const wrappedError = new Error(
      "Something went wrong: message_not_in_streaming_state",
    );

    const streamers = [
      {
        append: vi.fn().mockRejectedValue(wrappedError),
        stop: vi.fn().mockResolvedValue(undefined),
      },
      {
        append: vi.fn().mockResolvedValue(undefined),
        stop: vi.fn().mockResolvedValue(undefined),
      },
    ];
    let streamIndex = 0;
    const client = {
      chatStream: vi.fn().mockImplementation(() => {
        const s = streamers[streamIndex];
        streamIndex++;
        return s;
      }),
    };

    const consumer = new StreamConsumer(
      client as never,
      "C123",
      "1234.5678",
      "U456",
      "T789",
    );

    await consumer.append("Hello after SDK re-wrap");

    // Should have created two streams: original + recovery
    expect(client.chatStream).toHaveBeenCalledTimes(2);

    // Dead streamer's stop should NOT be called
    expect(streamers[0]!.stop).not.toHaveBeenCalled();

    // Fresh streamer should have received the retried text
    expect(streamers[1]!.append).toHaveBeenCalledWith({
      markdown_text: "Hello after SDK re-wrap",
    });
  });

  it("propagates error if recovery append also fails", async () => {
    const streamExpiredError = Object.assign(
      new Error("An API error occurred: message_not_in_streaming_state"),
      {
        code: "slack_webapi_platform_error",
        data: { ok: false, error: "message_not_in_streaming_state" },
      },
    );
    const secondError = new Error("channel_not_found");

    const streamers = [
      {
        append: vi.fn().mockRejectedValue(streamExpiredError),
        stop: vi.fn().mockResolvedValue(undefined),
      },
      {
        append: vi.fn().mockRejectedValue(secondError),
        stop: vi.fn().mockResolvedValue(undefined),
      },
    ];
    let streamIndex = 0;
    const client = {
      chatStream: vi.fn().mockImplementation(() => {
        const s = streamers[streamIndex];
        streamIndex++;
        return s;
      }),
    };

    const consumer = new StreamConsumer(
      client as never,
      "C123",
      "1234.5678",
      "U456",
      "T789",
    );

    // First streamer fails with stream expiry, recovery also fails — second error propagates
    await expect(consumer.append("Hello")).rejects.toThrow("channel_not_found");

    // Both streams were attempted
    expect(client.chatStream).toHaveBeenCalledTimes(2);
  });
});
