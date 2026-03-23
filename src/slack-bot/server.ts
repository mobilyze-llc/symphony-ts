/**
 * Standalone HTTP server entry point for the Slack bot webhook receiver.
 *
 * Uses node:http directly (no frameworks). Forwards Slack webhook requests
 * to the Chat SDK's webhook handler and exposes a health endpoint.
 *
 * All configuration is read from environment variables.
 */
import {
  type IncomingMessage,
  type Server,
  type ServerResponse,
  createServer,
} from "node:http";

import { createSlackBot } from "./index.js";
import { parseChannelProjectMap } from "./index.js";
import type { SlackBotConfig } from "./types.js";

/** Configuration for the Slack bot server, loaded from environment variables. */
export interface SlackBotServerConfig extends SlackBotConfig {
  /** Port to listen on. */
  port: number;
}

/**
 * Load and validate Slack bot configuration from environment variables.
 *
 * Required env vars: SLACK_BOT_TOKEN, SLACK_SIGNING_SECRET
 * Optional: SLACK_BOT_PORT (default 3000), CHANNEL_PROJECT_MAP (JSON, default {}), CLAUDE_MODEL
 *
 * @throws {Error} If required environment variables are missing.
 */
export function loadSlackBotConfig(
  env: Record<string, string | undefined> = process.env,
): SlackBotServerConfig {
  const missing: string[] = [];

  const botToken = env.SLACK_BOT_TOKEN;
  if (!botToken) {
    missing.push("SLACK_BOT_TOKEN");
  }

  const signingSecret = env.SLACK_SIGNING_SECRET;
  if (!signingSecret) {
    missing.push("SLACK_SIGNING_SECRET");
  }

  if (missing.length > 0) {
    throw new Error(
      `Missing required environment variables: ${missing.join(", ")}`,
    );
  }

  // At this point both botToken and signingSecret are defined (missing.length === 0).
  const resolvedBotToken = botToken as string;
  const resolvedSigningSecret = signingSecret as string;

  const port = env.SLACK_BOT_PORT
    ? Number.parseInt(env.SLACK_BOT_PORT, 10)
    : 3000;

  const channelMapJson = env.CHANNEL_PROJECT_MAP ?? "{}";
  const channelMap = parseChannelProjectMap(channelMapJson);

  const model = env.CLAUDE_MODEL;

  return {
    botToken: resolvedBotToken,
    signingSecret: resolvedSigningSecret,
    port,
    channelMap,
    ...(model !== undefined ? { model } : {}),
  };
}

/** Instance returned by startSlackBotServer. */
export interface SlackBotServerInstance {
  readonly server: Server;
  readonly hostname: string;
  readonly port: number;
  close(): Promise<void>;
}

/**
 * Collect the request body from an IncomingMessage into a Buffer.
 */
async function collectBody(request: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk);
  }
  return Buffer.concat(chunks);
}

/**
 * Convert a node:http IncomingMessage to a Fetch API Request.
 */
function toFetchRequest(
  request: IncomingMessage,
  body: Buffer,
  baseUrl: string,
): Request {
  const url = new URL(request.url ?? "/", baseUrl);
  const headers = new Headers();
  for (const [key, value] of Object.entries(request.headers)) {
    if (value !== undefined) {
      if (Array.isArray(value)) {
        for (const v of value) {
          headers.append(key, v);
        }
      } else {
        headers.set(key, value);
      }
    }
  }

  const init: RequestInit = {
    method: request.method ?? "GET",
    headers,
  };
  if (body.length > 0) {
    init.body = body;
  }
  return new Request(url.toString(), init);
}

/**
 * Write a Fetch API Response back to a node:http ServerResponse.
 */
async function writeFetchResponse(
  fetchResponse: Response,
  response: ServerResponse,
): Promise<void> {
  response.statusCode = fetchResponse.status;
  fetchResponse.headers.forEach((value, key) => {
    response.setHeader(key, value);
  });
  const responseBody = await fetchResponse.arrayBuffer();
  response.end(Buffer.from(responseBody));
}

/**
 * Write a JSON response to a node:http ServerResponse.
 */
function writeJson(
  response: ServerResponse,
  statusCode: number,
  payload: unknown,
): void {
  const body = JSON.stringify(payload);
  response.statusCode = statusCode;
  response.setHeader("content-type", "application/json; charset=utf-8");
  response.setHeader("content-length", Buffer.byteLength(body));
  response.end(body);
}

/**
 * Write a 404 Not Found response.
 */
function writeNotFound(response: ServerResponse, path: string): void {
  response.statusCode = 404;
  response.setHeader("content-type", "text/plain; charset=utf-8");
  response.end(`Not found: ${path}`);
}

/**
 * Create a Slack bot HTTP server (does not listen).
 *
 * Routes:
 * - POST /api/webhooks/slack → forwarded to chat.webhooks.slack
 * - GET /health → { status: "ok" }
 * - Everything else → 404
 */
export function createSlackBotServer(config: SlackBotServerConfig): Server {
  const bot = createSlackBot(config);
  // Base URL used only for parsing request.url relative paths.
  // Use $BASE_URL if it looks like a valid origin; otherwise fall back to 0.0.0.0:<port>.
  const envBaseUrl = process.env.BASE_URL;
  const hostPort =
    envBaseUrl && /^[\w.-]+:\d+$/.test(envBaseUrl)
      ? envBaseUrl
      : `0.0.0.0:${config.port}`;
  const baseUrl = `http://${hostPort}`;

  const handler = async (
    request: IncomingMessage,
    response: ServerResponse,
  ): Promise<void> => {
    try {
      const url = new URL(request.url ?? "/", baseUrl);
      const method = request.method ?? "GET";

      if (url.pathname === "/health") {
        if (method !== "GET") {
          response.statusCode = 405;
          response.setHeader("allow", "GET");
          response.end("Method not allowed");
          return;
        }
        writeJson(response, 200, { status: "ok" });
        return;
      }

      if (url.pathname === "/api/webhooks/slack") {
        if (method !== "POST") {
          response.statusCode = 405;
          response.setHeader("allow", "POST");
          response.end("Method not allowed");
          return;
        }
        const body = await collectBody(request);
        const fetchRequest = toFetchRequest(request, body, baseUrl);
        const fetchResponse = await bot.webhooks.slack(fetchRequest);
        await writeFetchResponse(fetchResponse, response);
        return;
      }

      writeNotFound(response, url.pathname);
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "Internal server error";
      writeJson(response, 500, { error: { message } });
    }
  };

  const server = createServer((request, response) => {
    void handler(request, response);
  });

  return server;
}

/**
 * Start the Slack bot HTTP server (binds to a port and listens).
 *
 * @returns A promise that resolves with server instance details.
 */
export async function startSlackBotServer(
  config: SlackBotServerConfig,
): Promise<SlackBotServerInstance> {
  const server = createSlackBotServer(config);
  const hostname = "0.0.0.0";

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(config.port, hostname, () => {
      server.off("error", reject);
      resolve();
    });
  });

  const address = server.address();
  if (address === null || typeof address === "string") {
    throw new Error("Slack bot server did not bind to a TCP address.");
  }

  const channelCount = config.channelMap.size;
  console.log(
    `Slack bot server listening on ${hostname}:${address.port} (${channelCount} channel mapping${channelCount === 1 ? "" : "s"})`,
  );

  return {
    server,
    hostname,
    port: address.port,
    close: async () => {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => {
          if (error) {
            reject(error);
            return;
          }
          resolve();
        });
      });
    },
  };
}

/* Entry point for direct execution: node dist/src/slack-bot/server.js */
const isDirectExecution =
  import.meta.url === `file://${process.argv[1]}` ||
  process.argv[1]?.endsWith("/src/slack-bot/server.js");

if (isDirectExecution) {
  try {
    const config = loadSlackBotConfig();
    void startSlackBotServer(config);
  } catch (error) {
    console.error(
      error instanceof Error
        ? error.message
        : "Failed to start Slack bot server",
    );
    process.exit(1);
  }
}
