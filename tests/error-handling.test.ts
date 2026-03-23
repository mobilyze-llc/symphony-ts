import { afterEach, describe, expect, it, vi } from "vitest";

// Mock the AI SDK modules before importing handler
vi.mock("ai", () => ({
  streamText: vi.fn(),
}));

vi.mock("ai-sdk-provider-claude-code", () => ({
  claudeCode: vi.fn(),
}));

import { streamText } from "ai";
import { claudeCode } from "ai-sdk-provider-claude-code";

import { createMessageHandler } from "../src/slack-bot/handler.js";
import { createCcSessionStore } from "../src/slack-bot/session-store.js";
import type { ChannelProjectMap, SessionMap } from "../src/slack-bot/types.js";

// Helper to create a mock thread
function createMockThread(channelId: string) {
  return {
    id: `slack:${channelId}:1234.5678`,
    channelId,
    adapter: {
      addReaction: vi.fn().mockResolvedValue(undefined),
      removeReaction: vi.fn().mockResolvedValue(undefined),
    },
    post: vi.fn().mockResolvedValue({ id: "sent-msg-1" }),
  };
}

// Helper to create a mock message
function createMockMessage(text: string) {
  return {
    id: "msg-ts-1234",
    text,
    threadId: "slack:C123:1234.5678",
    author: {
      userId: "U999",
      userName: "testuser",
      fullName: "Test User",
      isBot: false,
      isMe: false,
    },
    metadata: { dateSent: new Date(), edited: false },
    attachments: [],
    formatted: { type: "root" as const, children: [] },
    raw: {},
  };
}

describe("Error handling", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("posts a user-friendly error message to the thread when streamText throws", async () => {
    const channelMap: ChannelProjectMap = new Map([
      ["C123", "/tmp/test-project"],
    ]);
    const sessions: SessionMap = new Map();
    const ccSessions = createCcSessionStore();
    const mockModel = { id: "mock-claude-code-model" };

    vi.mocked(claudeCode).mockReturnValue(
      mockModel as unknown as ReturnType<typeof claudeCode>,
    );

    // Create a failing async iterable (plain object to avoid lint/useYield)
    const failingStream: AsyncIterable<string> = {
      [Symbol.asyncIterator]() {
        return {
          async next(): Promise<IteratorResult<string>> {
            throw new Error("Rate limit exceeded");
          },
        };
      },
    };

    vi.mocked(streamText).mockReturnValue({
      textStream: failingStream,
      response: Promise.resolve({ messages: [] }),
    } as unknown as ReturnType<typeof streamText>);

    const handler = createMessageHandler({ channelMap, sessions, ccSessions });
    const thread = createMockThread("C123");
    const message = createMockMessage("test query");

    await handler(
      thread as unknown as Parameters<typeof handler>[0],
      message as unknown as Parameters<typeof handler>[1],
    );

    // Should post a user-friendly error message
    expect(thread.post).toHaveBeenCalledWith("Error: Rate limit exceeded");
  });

  it("adds an x reaction instead of checkmark on error", async () => {
    const channelMap: ChannelProjectMap = new Map([
      ["C123", "/tmp/test-project"],
    ]);
    const sessions: SessionMap = new Map();
    const ccSessions = createCcSessionStore();
    const mockModel = { id: "mock-claude-code-model" };

    vi.mocked(claudeCode).mockReturnValue(
      mockModel as unknown as ReturnType<typeof claudeCode>,
    );

    const failingStream: AsyncIterable<string> = {
      [Symbol.asyncIterator]() {
        return {
          async next(): Promise<IteratorResult<string>> {
            throw new Error("Session failure");
          },
        };
      },
    };

    vi.mocked(streamText).mockReturnValue({
      textStream: failingStream,
      response: Promise.resolve({ messages: [] }),
    } as unknown as ReturnType<typeof streamText>);

    const handler = createMessageHandler({ channelMap, sessions, ccSessions });
    const thread = createMockThread("C123");
    const message = createMockMessage("test");

    await handler(
      thread as unknown as Parameters<typeof handler>[0],
      message as unknown as Parameters<typeof handler>[1],
    );

    // Verify reactions.remove('eyes') was called
    expect(thread.adapter.removeReaction).toHaveBeenCalledWith(
      thread.id,
      message.id,
      "eyes",
    );

    // Verify reactions.add('x') was called
    expect(thread.adapter.addReaction).toHaveBeenCalledWith(
      thread.id,
      message.id,
      "x",
    );

    // Verify white_check_mark was NOT added
    const addCalls = thread.adapter.addReaction.mock.calls;
    const checkmarkCalls = addCalls.filter(
      (call: unknown[]) => call[2] === "white_check_mark",
    );
    expect(checkmarkCalls).toHaveLength(0);
  });

  it("handles non-Error thrown values with a generic message", async () => {
    const channelMap: ChannelProjectMap = new Map([
      ["C123", "/tmp/test-project"],
    ]);
    const sessions: SessionMap = new Map();
    const ccSessions = createCcSessionStore();
    const mockModel = { id: "mock-claude-code-model" };

    vi.mocked(claudeCode).mockReturnValue(
      mockModel as unknown as ReturnType<typeof claudeCode>,
    );

    const failingStream: AsyncIterable<string> = {
      [Symbol.asyncIterator]() {
        return {
          async next(): Promise<IteratorResult<string>> {
            throw "string error"; // eslint-disable-line no-throw-literal
          },
        };
      },
    };

    vi.mocked(streamText).mockReturnValue({
      textStream: failingStream,
      response: Promise.resolve({ messages: [] }),
    } as unknown as ReturnType<typeof streamText>);

    const handler = createMessageHandler({ channelMap, sessions, ccSessions });
    const thread = createMockThread("C123");
    const message = createMockMessage("test");

    await handler(
      thread as unknown as Parameters<typeof handler>[0],
      message as unknown as Parameters<typeof handler>[1],
    );

    // Should post generic error message for non-Error values
    expect(thread.post).toHaveBeenCalledWith(
      "Error: An unexpected error occurred",
    );

    // Should still add x reaction
    expect(thread.adapter.addReaction).toHaveBeenCalledWith(
      thread.id,
      message.id,
      "x",
    );
  });
});
