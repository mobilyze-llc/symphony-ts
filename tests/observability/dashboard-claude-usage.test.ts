import { request as httpRequest } from "node:http";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { RuntimeSnapshot } from "../../src/logging/runtime-snapshot.js";
import type {
  DashboardServerHost,
  IssueDetailResponse,
} from "../../src/observability/dashboard-server.js";

// Mock the claude-usage CLI helper. vi.hoisted ensures the fn exists before vi.mock runs.
const { mockFetchClaudeUsage } = vi.hoisted(() => ({
  mockFetchClaudeUsage: vi.fn(),
}));
vi.mock("../../src/observability/dashboard-claude-usage.js", () => ({
  fetchClaudeUsageFromCli: mockFetchClaudeUsage,
}));

import {
  clearClaudeUsageCache,
  startDashboardServer,
} from "../../src/observability/dashboard-server.js";

describe("dashboard claude usage endpoint", () => {
  const servers: Array<{ close: () => Promise<void> }> = [];

  beforeEach(() => {
    clearClaudeUsageCache();
    mockFetchClaudeUsage.mockReset();
  });

  afterEach(async () => {
    await Promise.all(servers.splice(0).map((server) => server.close()));
  });

  it("returns usage data from CLI", async () => {
    const usageData = {
      five_hour: { utilization: 0.42 },
      seven_day: { utilization: 0.15 },
      active_account: "user@example.com",
    };
    mockFetchClaudeUsage.mockResolvedValue(usageData);

    const server = await startDashboardServer({
      port: 0,
      host: createHost(),
    });
    servers.push(server);

    const response = await sendRequest(server.port, {
      method: "GET",
      path: "/api/v1/claude/usage",
    });

    expect(response.statusCode).toBe(200);
    const body = JSON.parse(response.body);
    expect(body.five_hour.utilization).toBe(0.42);
    expect(body.seven_day.utilization).toBe(0.15);
    expect(body.active_account).toBe("user@example.com");
    expect(body.cached).toBe(false);
    expect(mockFetchClaudeUsage).toHaveBeenCalledOnce();
  });

  it("caches results for 30 seconds", async () => {
    const usageData = {
      five_hour: { utilization: 0.5 },
      seven_day: { utilization: 0.2 },
      active_account: "cached@example.com",
    };
    mockFetchClaudeUsage.mockResolvedValue(usageData);

    const server = await startDashboardServer({
      port: 0,
      host: createHost(),
    });
    servers.push(server);

    const first = await sendRequest(server.port, {
      method: "GET",
      path: "/api/v1/claude/usage",
    });
    expect(first.statusCode).toBe(200);
    const firstBody = JSON.parse(first.body);
    expect(firstBody.cached).toBe(false);

    const second = await sendRequest(server.port, {
      method: "GET",
      path: "/api/v1/claude/usage",
    });
    expect(second.statusCode).toBe(200);
    const secondBody = JSON.parse(second.body);
    expect(secondBody.cached).toBe(true);
    expect(secondBody.five_hour.utilization).toBe(0.5);

    // fetchClaudeUsageFromCli should only have been called once — second response served from cache
    expect(mockFetchClaudeUsage).toHaveBeenCalledOnce();
  });

  it("handles failure gracefully when CLI exits non-zero", async () => {
    mockFetchClaudeUsage.mockRejectedValue(
      new Error("ops/claude-usage exited with code 1"),
    );

    const server = await startDashboardServer({
      port: 0,
      host: createHost(),
    });
    servers.push(server);

    const response = await sendRequest(server.port, {
      method: "GET",
      path: "/api/v1/claude/usage",
    });

    expect(response.statusCode).toBe(200);
    const body = JSON.parse(response.body);
    expect(body.available).toBe(false);
    expect(body.error).toBe("ops/claude-usage exited with code 1");
  });

  it("rejects non-GET methods with 405", async () => {
    const server = await startDashboardServer({
      port: 0,
      host: createHost(),
    });
    servers.push(server);

    const response = await sendRequest(server.port, {
      method: "POST",
      path: "/api/v1/claude/usage",
    });
    expect(response.statusCode).toBe(405);
    expect(response.headers.allow).toBe("GET");
  });
});

function createHost(): DashboardServerHost {
  const snapshot = createSnapshot();
  const issue = createIssueDetail();
  return {
    getRuntimeSnapshot: () => snapshot,
    getIssueDetails: (issueIdentifier) =>
      issueIdentifier === issue.issue_identifier ? issue : null,
    requestRefresh: () => ({
      queued: true,
      coalesced: false,
      requested_at: "2026-03-06T11:00:00.000Z",
      operations: ["poll", "reconcile"],
    }),
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

function createIssueDetail(): IssueDetailResponse {
  return {
    issue_identifier: "ABC-123",
    issue_id: "issue-1",
    status: "running",
    workspace: { path: "/tmp/symphony/ABC-123" },
    attempts: { restart_count: 0, current_retry_attempt: null },
    running: null,
    retry: null,
    logs: { codex_session_logs: [] },
    recent_events: [],
    last_error: null,
    tracked: {},
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
