import { type IncomingMessage, request as httpRequest } from "node:http";

import { afterEach, describe, expect, it } from "vitest";

import type { RuntimeSnapshot } from "../../src/logging/runtime-snapshot.js";
import {
  type DashboardServerHost,
  type PipelineStatusResponse,
  startDashboardServer,
} from "../../src/observability/dashboard-server.js";

describe("dashboard pipeline control", () => {
  const servers: Array<{ close: () => Promise<void> }> = [];

  afterEach(async () => {
    await Promise.all(servers.splice(0).map((server) => server.close()));
  });

  it("pause creates a pipeline-halt issue via the host", async () => {
    const server = await startDashboardServer({
      port: 0,
      host: createHost({
        requestPipelinePause: () => ({
          paused: true,
          issues: [{ identifier: "ENG-99", title: "Pipeline Halt" }],
        }),
      }),
    });
    servers.push(server);

    const response = await sendRequest(server.port, {
      method: "POST",
      path: "/api/v1/pipeline/pause",
      body: "{}",
      headers: { "content-type": "application/json" },
    });
    expect(response.statusCode).toBe(200);
    const body = JSON.parse(response.body);
    expect(body).toEqual({
      paused: true,
      issues: [{ identifier: "ENG-99", title: "Pipeline Halt" }],
    });
  });

  it("already paused returns existing halt issue without creating duplicate", async () => {
    const existingIssue = { identifier: "ENG-50", title: "Pipeline Halt" };
    const server = await startDashboardServer({
      port: 0,
      host: createHost({
        requestPipelinePause: () => ({
          paused: true,
          issues: [existingIssue],
        }),
      }),
    });
    servers.push(server);

    const response = await sendRequest(server.port, {
      method: "POST",
      path: "/api/v1/pipeline/pause",
      body: "{}",
      headers: { "content-type": "application/json" },
    });
    expect(response.statusCode).toBe(200);
    const body = JSON.parse(response.body);
    expect(body.paused).toBe(true);
    expect(body.issues).toEqual([existingIssue]);
  });

  it("returns existing halt issue details when already paused", async () => {
    const existingIssue = { identifier: "ENG-50", title: "Pipeline Halt" };
    const server = await startDashboardServer({
      port: 0,
      host: createHost({
        requestPipelinePause: () => ({
          paused: true,
          issues: [existingIssue],
        }),
      }),
    });
    servers.push(server);

    const response = await sendRequest(server.port, {
      method: "POST",
      path: "/api/v1/pipeline/pause",
      body: "{}",
      headers: { "content-type": "application/json" },
    });
    const body = JSON.parse(response.body);
    expect(body.issues[0].identifier).toBe("ENG-50");
    expect(body.issues[0].title).toBe("Pipeline Halt");
  });

  it("resume cancels all pipeline-halt issues", async () => {
    const cancelledIds: string[] = [];
    const server = await startDashboardServer({
      port: 0,
      host: createHost({
        requestPipelineResume: () => {
          cancelledIds.push("cancelled");
          return { paused: false, issues: [] };
        },
      }),
    });
    servers.push(server);

    const response = await sendRequest(server.port, {
      method: "POST",
      path: "/api/v1/pipeline/resume",
      body: "{}",
      headers: { "content-type": "application/json" },
    });
    expect(response.statusCode).toBe(200);
    const body = JSON.parse(response.body);
    expect(body.paused).toBe(false);
    expect(body.issues).toEqual([]);
    expect(cancelledIds).toEqual(["cancelled"]);
  });

  it("status returns paused when halt issues exist", async () => {
    const server = await startDashboardServer({
      port: 0,
      host: createHost({
        getPipelineStatus: () => ({
          paused: true,
          issues: [{ identifier: "ENG-42", title: "Pipeline Halt" }],
        }),
      }),
    });
    servers.push(server);

    const response = await sendRequest(server.port, {
      method: "GET",
      path: "/api/v1/pipeline/status",
    });
    expect(response.statusCode).toBe(200);
    const body = JSON.parse(response.body);
    expect(body).toEqual({
      paused: true,
      issues: [{ identifier: "ENG-42", title: "Pipeline Halt" }],
    });
  });

  it("status returns running when no halt issues exist", async () => {
    const server = await startDashboardServer({
      port: 0,
      host: createHost({
        getPipelineStatus: () => ({
          paused: false,
          issues: [],
        }),
      }),
    });
    servers.push(server);

    const response = await sendRequest(server.port, {
      method: "GET",
      path: "/api/v1/pipeline/status",
    });
    expect(response.statusCode).toBe(200);
    const body = JSON.parse(response.body);
    expect(body).toEqual({
      paused: false,
      issues: [],
    });
  });

  it("returns 501 when host does not support pause", async () => {
    const server = await startDashboardServer({
      port: 0,
      host: createHost(),
    });
    servers.push(server);

    const response = await sendRequest(server.port, {
      method: "POST",
      path: "/api/v1/pipeline/pause",
      body: "{}",
      headers: { "content-type": "application/json" },
    });
    expect(response.statusCode).toBe(501);
    const body = JSON.parse(response.body);
    expect(body).toEqual({
      error: {
        code: "not_implemented",
        message: "Pipeline pause is not supported by this host.",
      },
    });
  });

  it("returns 501 when host does not support resume", async () => {
    const server = await startDashboardServer({
      port: 0,
      host: createHost(),
    });
    servers.push(server);

    const response = await sendRequest(server.port, {
      method: "POST",
      path: "/api/v1/pipeline/resume",
      body: "{}",
      headers: { "content-type": "application/json" },
    });
    expect(response.statusCode).toBe(501);
  });

  it("returns 501 when host does not support pipeline status", async () => {
    const server = await startDashboardServer({
      port: 0,
      host: createHost(),
    });
    servers.push(server);

    const response = await sendRequest(server.port, {
      method: "GET",
      path: "/api/v1/pipeline/status",
    });
    expect(response.statusCode).toBe(501);
  });

  it("returns 405 for GET on pause endpoint", async () => {
    const server = await startDashboardServer({
      port: 0,
      host: createHost({
        requestPipelinePause: () => ({ paused: true, issues: [] }),
      }),
    });
    servers.push(server);

    const response = await sendRequest(server.port, {
      method: "GET",
      path: "/api/v1/pipeline/pause",
    });
    expect(response.statusCode).toBe(405);
  });

  it("returns 405 for GET on resume endpoint", async () => {
    const server = await startDashboardServer({
      port: 0,
      host: createHost({
        requestPipelineResume: () => ({ paused: false, issues: [] }),
      }),
    });
    servers.push(server);

    const response = await sendRequest(server.port, {
      method: "GET",
      path: "/api/v1/pipeline/resume",
    });
    expect(response.statusCode).toBe(405);
  });
});

function createHost(
  overrides?: Partial<DashboardServerHost>,
): DashboardServerHost {
  return {
    getRuntimeSnapshot: () => createSnapshot(),
    getIssueDetails: () => null,
    requestRefresh: () => ({
      queued: true,
      coalesced: false,
      requested_at: "2026-03-06T11:00:00.000Z",
      operations: ["poll", "reconcile"],
    }),
    ...overrides,
  };
}

function createSnapshot(): RuntimeSnapshot {
  return {
    generated_at: "2026-03-06T10:00:00.000Z",
    counts: {
      running: 0,
      retrying: 0,
      completed: 0,
      failed: 0,
    },
    running: [],
    retrying: [],
    codex_totals: {
      input_tokens: 0,
      output_tokens: 0,
      total_tokens: 0,
      seconds_running: 0,
    },
    rate_limits: {
      requestsRemaining: 10,
    },
  };
}

function sendRequest(
  port: number,
  input: {
    method: string;
    path: string;
    body?: string;
    headers?: Record<string, string>;
  },
): Promise<{
  statusCode: number;
  headers: Record<string, string | string[] | undefined>;
  body: string;
}> {
  return new Promise((resolve, reject) => {
    const request = httpRequest(
      {
        host: "127.0.0.1",
        port,
        method: input.method,
        path: input.path,
        headers: input.headers,
      },
      (response) => {
        const chunks: Buffer[] = [];
        response.on("data", (chunk) => {
          chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
        });
        response.on("end", () => {
          resolve({
            statusCode: response.statusCode ?? 0,
            headers: response.headers,
            body: Buffer.concat(chunks).toString("utf8"),
          });
        });
      },
    );

    request.on("error", reject);
    if (input.body !== undefined) {
      request.write(input.body);
    }
    request.end();
  });
}
