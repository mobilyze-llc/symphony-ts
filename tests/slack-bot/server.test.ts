import * as http from "node:http";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Mock createSlackBot to avoid real Slack API calls
vi.mock("../../src/slack-bot/index.js", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../../src/slack-bot/index.js")>();
  return {
    ...actual,
    createSlackBot: vi.fn().mockReturnValue({
      chat: {},
      webhooks: {
        slack: vi.fn().mockResolvedValue(
          new Response(JSON.stringify({ ok: true }), {
            status: 200,
            headers: { "content-type": "application/json" },
          }),
        ),
      },
      sessions: new Map(),
      ccSessions: {},
    }),
  };
});

import { createSlackBot } from "../../src/slack-bot/index.js";
import {
  type SlackBotServerConfig,
  createSlackBotServer,
  loadSlackBotConfig,
  startSlackBotServer,
} from "../../src/slack-bot/server.js";

/** Helper: make an HTTP request to a running server. */
function request(
  server: http.Server,
  options: {
    method?: string;
    path: string;
    body?: string;
    headers?: Record<string, string>;
  },
): Promise<{
  statusCode: number;
  headers: http.IncomingHttpHeaders;
  body: string;
}> {
  return new Promise((resolve, reject) => {
    const address = server.address();
    if (address === null || typeof address === "string") {
      reject(new Error("Server not listening on a TCP address"));
      return;
    }

    const req = http.request(
      {
        hostname: "127.0.0.1",
        port: address.port,
        method: options.method ?? "GET",
        path: options.path,
        headers: options.headers,
      },
      (res: http.IncomingMessage) => {
        const chunks: Buffer[] = [];
        res.on("data", (chunk: Buffer) => chunks.push(chunk));
        res.on("end", () => {
          resolve({
            statusCode: res.statusCode ?? 0,
            headers: res.headers,
            body: Buffer.concat(chunks).toString("utf-8"),
          });
        });
      },
    );

    req.on("error", reject);
    if (options.body !== undefined) {
      req.write(options.body);
    }
    req.end();
  });
}

describe("loadSlackBotConfig", () => {
  it("exits with error when required env vars are missing", () => {
    expect(() => loadSlackBotConfig({})).toThrow();
  });

  it("names the missing variable SLACK_BOT_TOKEN", () => {
    expect(() =>
      loadSlackBotConfig({ SLACK_SIGNING_SECRET: "secret" }),
    ).toThrow("SLACK_BOT_TOKEN");
  });

  it("names the missing variable SLACK_SIGNING_SECRET", () => {
    expect(() => loadSlackBotConfig({ SLACK_BOT_TOKEN: "xoxb-token" })).toThrow(
      "SLACK_SIGNING_SECRET",
    );
  });

  it("defaults to port 3000", () => {
    const config = loadSlackBotConfig({
      SLACK_BOT_TOKEN: "xoxb-test",
      SLACK_SIGNING_SECRET: "secret",
    });
    expect(config.port).toBe(3000);
  });

  it("listens on configured port", () => {
    const config = loadSlackBotConfig({
      SLACK_BOT_TOKEN: "xoxb-test",
      SLACK_SIGNING_SECRET: "secret",
      SLACK_BOT_PORT: "3001",
    });
    expect(config.port).toBe(3001);
  });

  it("parses channel project map from JSON", () => {
    const config = loadSlackBotConfig({
      SLACK_BOT_TOKEN: "xoxb-test",
      SLACK_SIGNING_SECRET: "secret",
      CHANNEL_PROJECT_MAP: '{"C123":"/tmp/project-a"}',
    });
    expect(config.channelMap).toBeInstanceOf(Map);
    expect(config.channelMap.get("C123")).toBe("/tmp/project-a");
  });

  it("empty channel map when CHANNEL_PROJECT_MAP is not set", () => {
    const config = loadSlackBotConfig({
      SLACK_BOT_TOKEN: "xoxb-test",
      SLACK_SIGNING_SECRET: "secret",
    });
    expect(config.channelMap).toBeInstanceOf(Map);
    expect(config.channelMap.size).toBe(0);
  });
});

describe("createSlackBotServer", () => {
  let server: http.Server;

  const baseConfig: SlackBotServerConfig = {
    botToken: "xoxb-test-token",
    signingSecret: "test-secret",
    channelMap: new Map(),
    port: 0, // OS-assigned port
  };

  beforeEach(() => {
    vi.mocked(createSlackBot).mockReturnValue({
      chat: {} as ReturnType<typeof createSlackBot>["chat"],
      webhooks: {
        slack: vi.fn().mockResolvedValue(
          new Response(JSON.stringify({ ok: true }), {
            status: 200,
            headers: { "content-type": "application/json" },
          }),
        ),
      } as unknown as ReturnType<typeof createSlackBot>["webhooks"],
      sessions: new Map(),
      ccSessions: {} as ReturnType<typeof createSlackBot>["ccSessions"],
    });
  });

  afterEach(async () => {
    if (server?.listening) {
      await new Promise<void>((resolve, reject) => {
        server.close((err: Error | undefined) =>
          err ? reject(err) : resolve(),
        );
      });
    }
    vi.restoreAllMocks();
  });

  /** Start the server on an OS-assigned port for testing. */
  async function startTestServer(
    config?: Partial<SlackBotServerConfig>,
  ): Promise<http.Server> {
    server = createSlackBotServer({ ...baseConfig, ...config });
    await new Promise<void>((resolve) => {
      server.listen(0, "127.0.0.1", resolve);
    });
    return server;
  }

  it("listens on configured port", async () => {
    const instance = await startSlackBotServer({ ...baseConfig, port: 0 });
    server = instance.server;
    expect(instance.port).toBeGreaterThan(0);
    await instance.close();
  });

  it("health endpoint returns 200", async () => {
    await startTestServer();
    const res = await request(server, { path: "/health" });
    expect(res.statusCode).toBe(200);
  });

  it("health endpoint returns ok", async () => {
    await startTestServer();
    const res = await request(server, { path: "/health" });
    const body = JSON.parse(res.body);
    expect(body).toEqual({ status: "ok" });
  });

  it("returns 404 for unmatched routes", async () => {
    await startTestServer();
    const res = await request(server, { path: "/nonexistent" });
    expect(res.statusCode).toBe(404);
  });

  it("forwards webhook POST to chat.webhooks.slack handler", async () => {
    await startTestServer();
    const mockWebhookHandler = vi.mocked(createSlackBot).mock.results[0]!.value
      .webhooks.slack as ReturnType<typeof vi.fn>;

    const res = await request(server, {
      method: "POST",
      path: "/api/webhooks/slack",
      body: JSON.stringify({ type: "event_callback" }),
      headers: { "content-type": "application/json" },
    });

    expect(mockWebhookHandler).toHaveBeenCalledTimes(1);
    // Verify it was called with a Fetch API Request object
    const callArg = mockWebhookHandler.mock.calls[0]![0];
    expect(callArg).toBeInstanceOf(Request);
    expect(res.statusCode).toBe(200);
  });
});
