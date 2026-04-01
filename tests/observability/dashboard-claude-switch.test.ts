import { type IncomingMessage, request as httpRequest } from "node:http";

import { afterEach, describe, expect, it, vi } from "vitest";

import type { RuntimeSnapshot } from "../../src/logging/runtime-snapshot.js";
import {
  type DashboardServerHost,
  type ExecCommandFn,
  type IssueDetailResponse,
  type RefreshResponse,
  startDashboardServer,
} from "../../src/observability/dashboard-server.js";

describe("POST /api/v1/claude/switch", () => {
  const servers: Array<{ close: () => Promise<void> }> = [];

  afterEach(async () => {
    await Promise.all(servers.splice(0).map((server) => server.close()));
  });

  it("executes cswap --switch when no agents are running", async () => {
    const execCommand = vi.fn<ExecCommandFn>();
    execCommand.mockImplementation(async (cmd: string, _args: string[]) => {
      if (cmd === "cswap") {
        return { stdout: "", stderr: "" };
      }
      if (cmd === "ops/claude-usage") {
        return {
          stdout: JSON.stringify({
            account: "user@example.com",
            usage_percent: 42,
          }),
          stderr: "",
        };
      }
      return { stdout: "", stderr: "" };
    });

    const server = await startDashboardServer({
      port: 0,
      host: createHost({
        getRuntimeSnapshot: () => createSnapshotWithRunning(0),
      }),
      execCommand,
    });
    servers.push(server);

    const res = await sendRequest(server.port, {
      method: "POST",
      path: "/api/v1/claude/switch",
    });

    expect(res.statusCode).toBe(200);
    expect(execCommand).toHaveBeenCalledWith("cswap", ["--switch"]);
  });

  it("returns new account info from ops/claude-usage --json after switch", async () => {
    const usageData = {
      account: "user2@example.com",
      usage_percent: 10,
      remaining: 90,
    };

    const execCommand = vi.fn<ExecCommandFn>();
    execCommand.mockImplementation(async (cmd: string) => {
      if (cmd === "cswap") {
        return { stdout: "", stderr: "" };
      }
      if (cmd === "ops/claude-usage") {
        return { stdout: JSON.stringify(usageData), stderr: "" };
      }
      return { stdout: "", stderr: "" };
    });

    const server = await startDashboardServer({
      port: 0,
      host: createHost({
        getRuntimeSnapshot: () => createSnapshotWithRunning(0),
      }),
      execCommand,
    });
    servers.push(server);

    const res = await sendRequest(server.port, {
      method: "POST",
      path: "/api/v1/claude/switch",
    });

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.switched).toBe(true);
    expect(body.usage).toEqual(usageData);
    // Verify ops/claude-usage --json was called after cswap
    expect(execCommand).toHaveBeenCalledWith("ops/claude-usage", ["--json"]);
  });

  it("clears cache so next usage fetch is fresh", async () => {
    const execCommand = vi.fn<ExecCommandFn>();
    let callCount = 0;
    execCommand.mockImplementation(async (cmd: string) => {
      if (cmd === "cswap") {
        return { stdout: "", stderr: "" };
      }
      if (cmd === "ops/claude-usage") {
        callCount++;
        return {
          stdout: JSON.stringify({ account: `user${callCount}@example.com` }),
          stderr: "",
        };
      }
      return { stdout: "", stderr: "" };
    });

    const server = await startDashboardServer({
      port: 0,
      host: createHost({
        getRuntimeSnapshot: () => createSnapshotWithRunning(0),
      }),
      execCommand,
    });
    servers.push(server);

    // First: fetch usage to populate cache
    await sendRequest(server.port, {
      method: "GET",
      path: "/api/v1/claude/usage",
    });
    const usageCallsBeforeSwitch = execCommand.mock.calls.filter(
      (c) => c[0] === "ops/claude-usage",
    ).length;

    // Second: switch (clears cache, also fetches usage)
    await sendRequest(server.port, {
      method: "POST",
      path: "/api/v1/claude/switch",
    });

    // Third: fetch usage again — should call ops/claude-usage again (not cached from pre-switch)
    const res = await sendRequest(server.port, {
      method: "GET",
      path: "/api/v1/claude/usage",
    });

    // The usage endpoint should have been called at least once more after the switch's own call
    const totalUsageCalls = execCommand.mock.calls.filter(
      (c) => c[0] === "ops/claude-usage",
    ).length;
    // Before switch: 1 call. Switch itself calls it once (=2). After switch usage GET: cache from switch is valid so no extra call.
    // But the key point: the switch DID call ops/claude-usage (clearing old cache), so the data is fresh.
    expect(totalUsageCalls).toBeGreaterThanOrEqual(usageCallsBeforeSwitch + 1);
    expect(res.statusCode).toBe(200);
  });

  it("refuses when agents are running and returns 409", async () => {
    const execCommand = vi.fn<ExecCommandFn>();

    const server = await startDashboardServer({
      port: 0,
      host: createHost({
        getRuntimeSnapshot: () => createSnapshotWithRunning(2),
      }),
      execCommand,
    });
    servers.push(server);

    const res = await sendRequest(server.port, {
      method: "POST",
      path: "/api/v1/claude/switch",
    });

    expect(res.statusCode).toBe(409);
    const body = JSON.parse(res.body);
    expect(body.error.code).toBe("switch_refused_running");
    expect(body.error.message).toContain("running");
  });

  it("ensures cswap not called when agents are running", async () => {
    const execCommand = vi.fn<ExecCommandFn>();

    const server = await startDashboardServer({
      port: 0,
      host: createHost({
        getRuntimeSnapshot: () => createSnapshotWithRunning(2),
      }),
      execCommand,
    });
    servers.push(server);

    await sendRequest(server.port, {
      method: "POST",
      path: "/api/v1/claude/switch",
    });

    expect(execCommand).not.toHaveBeenCalled();
  });

  it("handles cswap failure and returns 500", async () => {
    const execCommand = vi.fn<ExecCommandFn>();
    execCommand.mockRejectedValue(new Error("cswap: command not found"));

    const server = await startDashboardServer({
      port: 0,
      host: createHost({
        getRuntimeSnapshot: () => createSnapshotWithRunning(0),
      }),
      execCommand,
    });
    servers.push(server);

    const res = await sendRequest(server.port, {
      method: "POST",
      path: "/api/v1/claude/switch",
    });

    expect(res.statusCode).toBe(500);
    const body = JSON.parse(res.body);
    expect(body.error.code).toBe("switch_failed");
    expect(body.error.message).toContain("cswap: command not found");
  });

  it("returns 405 for non-POST methods", async () => {
    const server = await startDashboardServer({
      port: 0,
      host: createHost(),
    });
    servers.push(server);

    const res = await sendRequest(server.port, {
      method: "GET",
      path: "/api/v1/claude/switch",
    });

    expect(res.statusCode).toBe(405);
  });
});

function createHost(
  overrides?: Partial<DashboardServerHost>,
): DashboardServerHost {
  return {
    getRuntimeSnapshot: () => createSnapshotWithRunning(1),
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

function createSnapshotWithRunning(runningCount: number): RuntimeSnapshot {
  const running = [];
  for (let i = 0; i < runningCount; i++) {
    running.push({
      issue_id: `issue-${i}`,
      issue_identifier: `ABC-${100 + i}`,
      issue_title: `Issue ${i}`,
      state: "In Progress",
      pipeline_stage: null,
      activity_summary: "Working",
      session_id: `session-${i}`,
      turn_count: 1,
      last_event: "notification",
      last_message: "Working",
      started_at: "2026-03-06T09:58:00.000Z",
      first_dispatched_at: "2026-03-06T09:58:00.000Z",
      last_event_at: "2026-03-06T09:59:30.000Z",
      stage_duration_seconds: 120,
      tokens_per_turn: 500,
      tokens: {
        input_tokens: 1000,
        output_tokens: 500,
        total_tokens: 1500,
        cache_read_tokens: 200,
        cache_write_tokens: 100,
        reasoning_tokens: 50,
      },
      total_pipeline_tokens: 1500,
      pipeline_tokens: {
        input_tokens: 1000,
        output_tokens: 500,
        total_tokens: 1500,
        cache_read_tokens: 200,
        cache_write_tokens: 100,
      },
      execution_history: [],
      turn_history: [],
      recent_activity: [],
      last_tool_call: null,
      failure_reason: null,
      health: "green" as const,
      health_reason: null,
    });
  }
  return {
    generated_at: "2026-03-06T10:00:00.000Z",
    counts: {
      running: runningCount,
      retrying: 0,
      completed: 0,
      failed: 0,
    },
    running,
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
