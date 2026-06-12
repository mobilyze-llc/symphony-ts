/**
 * POST /api/v1/intents — the SYMPH-408b verb endpoint. The endpoint is a
 * validated transport over the orchestrator's writeIntent primitive; these
 * tests cover the I/O boundary (zod validation, status mapping) plus the
 * ticket's "indistinguishable entries" AC against a real OrchestratorCore.
 */
import { type IncomingMessage, request as httpRequest } from "node:http";

import { afterEach, describe, expect, it } from "vitest";

import type {
  ResolvedWorkflowConfig,
  StagesConfig,
} from "../../src/config/types.js";
import type { Issue } from "../../src/domain/model.js";
import type { RuntimeSnapshot } from "../../src/logging/runtime-snapshot.js";
import {
  type DashboardServerHost,
  type IntentRequest,
  type IntentRequestResult,
  type PipelineControlContext,
  startDashboardServer,
} from "../../src/observability/dashboard-server.js";
import {
  OrchestratorCore,
  type OrchestratorCoreOptions,
} from "../../src/orchestrator/core.js";
import type { IntentActor } from "../../src/orchestrator/intent.js";
import type { IssueTracker } from "../../src/tracker/tracker.js";

describe("POST /api/v1/intents", () => {
  const servers: Array<{ close: () => Promise<void> }> = [];

  afterEach(async () => {
    await Promise.all(servers.splice(0).map((server) => server.close()));
  });

  async function startServer(overrides?: Partial<DashboardServerHost>) {
    const server = await startDashboardServer({
      port: 0,
      host: createHost(overrides),
    });
    servers.push(server);
    return server;
  }

  it("returns 501 when the host does not support intents", async () => {
    const server = await startServer();
    const response = await postIntent(server.port, validBody());
    expect(response.statusCode).toBe(501);
  });

  it("returns 405 for GET", async () => {
    const server = await startServer({
      requestIntent: () => appliedResult(),
    });
    const response = await sendRequest(server.port, {
      method: "GET",
      path: "/api/v1/intents",
    });
    expect(response.statusCode).toBe(405);
  });

  it("rejects an unknown verb with 400", async () => {
    const server = await startServer({
      requestIntent: () => appliedResult(),
    });
    const response = await postIntent(server.port, {
      ...validBody(),
      verb: "obliterate",
    });
    expect(response.statusCode).toBe(400);
    expect(JSON.parse(response.body).error.code).toBe("invalid_request");
  });

  it("rejects a body without issueId or issueIdentifier with 400", async () => {
    const server = await startServer({
      requestIntent: () => appliedResult(),
    });
    const { issueIdentifier, ...withoutIssue } = validBody();
    const response = await postIntent(server.port, withoutIssue);
    expect(response.statusCode).toBe(400);
    expect(JSON.parse(response.body).error.message).toContain(
      "issueId or issueIdentifier",
    );
  });

  it("rejects an unknown actor kind with 400", async () => {
    const server = await startServer({
      requestIntent: () => appliedResult(),
    });
    const response = await postIntent(server.port, {
      ...validBody(),
      actor: { kind: "root", host: "pro14" },
    });
    expect(response.statusCode).toBe(400);
  });

  it("rejects malformed JSON with 400", async () => {
    const server = await startServer({
      requestIntent: () => appliedResult(),
    });
    const response = await sendRequest(server.port, {
      method: "POST",
      path: "/api/v1/intents",
      body: "{not json",
      headers: { "content-type": "application/json" },
    });
    expect(response.statusCode).toBe(400);
  });

  it("passes the validated request to the host and returns 200 for applied", async () => {
    const received: IntentRequest[] = [];
    const server = await startServer({
      requestIntent: (input) => {
        received.push(input);
        return appliedResult();
      },
    });

    const response = await postIntent(server.port, {
      ...validBody(),
      fence: { expectedParkSeq: 3 },
      hint: "check the lockfile",
      stage: "review",
    });
    expect(response.statusCode).toBe(200);
    expect(JSON.parse(response.body).status).toBe("applied");
    expect(received).toEqual([
      {
        verb: "release",
        issueIdentifier: "SYMPH-1",
        reason: "released after host fix",
        actor: { kind: "operator", host: "pro14", session: "symphonyctl" },
        fence: { expectedParkSeq: 3 },
        hint: "check the lockfile",
        stage: "review",
      },
    ]);
  });

  it("maps rejected_stale to 409", async () => {
    const server = await startServer({
      requestIntent: () => ({
        ...appliedResult(),
        status: "rejected_stale",
        detail: "stale fence",
      }),
    });
    const response = await postIntent(server.port, validBody());
    expect(response.statusCode).toBe(409);
  });

  it("maps issue_not_found to 404", async () => {
    const server = await startServer({
      requestIntent: () => ({
        ...appliedResult(),
        status: "issue_not_found",
        sequence: null,
      }),
    });
    const response = await postIntent(server.port, validBody());
    expect(response.statusCode).toBe(404);
  });

  it("maps invalid_request to 400", async () => {
    const server = await startServer({
      requestIntent: () => ({
        ...appliedResult(),
        status: "invalid_request",
        detail: "mismatched issue id/identifier pair",
        sequence: null,
      }),
    });
    const response = await postIntent(server.port, validBody());
    expect(response.statusCode).toBe(400);
  });

  it("rejects a POST without content-type: application/json with 415", async () => {
    const requests: IntentRequest[] = [];
    const server = await startServer({
      requestIntent: (input) => {
        requests.push(input);
        return appliedResult();
      },
    });
    const response = await sendRequest(server.port, {
      method: "POST",
      path: "/api/v1/intents",
      body: JSON.stringify(validBody()),
    });
    expect(response.statusCode).toBe(415);
    expect(JSON.parse(response.body).error.code).toBe("unsupported_media_type");
    expect(requests).toHaveLength(0);
  });

  it("rejects the pipeline sentinel as an intent target with 400 (case-insensitive)", async () => {
    const requests: IntentRequest[] = [];
    const server = await startServer({
      requestIntent: (input) => {
        requests.push(input);
        return appliedResult();
      },
    });

    for (const target of [
      { issueId: "pipeline" },
      { issueId: "PIPELINE" },
      { issueIdentifier: "Pipeline" },
    ]) {
      const { issueIdentifier, ...rest } = validBody();
      const response = await postIntent(server.port, {
        ...rest,
        verb: "park",
        ...target,
      });
      expect(response.statusCode).toBe(400);
    }
    expect(requests).toHaveLength(0);
  });

  it("rejects a body over the 64 KiB cap with 413", async () => {
    const server = await startServer({
      requestIntent: () => appliedResult(),
    });
    const response = await sendRequest(server.port, {
      method: "POST",
      path: "/api/v1/intents",
      body: JSON.stringify({
        ...validBody(),
        reason: "x".repeat(70 * 1024),
      }),
      headers: { "content-type": "application/json" },
    });
    expect(response.statusCode).toBe(413);
    expect(JSON.parse(response.body).error.code).toBe("payload_too_large");
  });
});

describe("pipeline pause/resume attribution forwarding (SYMPH-408b)", () => {
  const servers: Array<{ close: () => Promise<void> }> = [];

  afterEach(async () => {
    await Promise.all(servers.splice(0).map((server) => server.close()));
  });

  it("forwards the request body's actor and reason to the host", async () => {
    const received: Array<PipelineControlContext | undefined> = [];
    const server = await startDashboardServer({
      port: 0,
      host: createHost({
        requestPipelinePause: (context) => {
          received.push(context);
          return { paused: true, issues: [] };
        },
      }),
    });
    servers.push(server);

    const response = await sendRequest(server.port, {
      method: "POST",
      path: "/api/v1/pipeline/pause",
      body: JSON.stringify({
        actor: { kind: "watchdog-l2", host: "pro14" },
        reason: "halting for deploy",
      }),
      headers: { "content-type": "application/json" },
    });
    expect(response.statusCode).toBe(200);
    expect(received).toEqual([
      {
        actor: { kind: "watchdog-l2", host: "pro14" },
        reason: "halting for deploy",
      },
    ]);
  });

  it("defaults to an operator@dashboard actor when no body is sent", async () => {
    const received: Array<PipelineControlContext | undefined> = [];
    const server = await startDashboardServer({
      port: 0,
      host: createHost({
        requestPipelineResume: (context) => {
          received.push(context);
          return { paused: false, issues: [] };
        },
      }),
    });
    servers.push(server);

    const response = await sendRequest(server.port, {
      method: "POST",
      path: "/api/v1/pipeline/resume",
      body: "",
      headers: { "content-type": "application/json" },
    });
    expect(response.statusCode).toBe(200);
    expect(received[0]?.actor).toEqual({ kind: "operator", host: "dashboard" });
    expect(received[0]?.reason).toContain("dashboard");
  });

  it("rejects pause/resume without content-type: application/json with 415", async () => {
    const received: Array<PipelineControlContext | undefined> = [];
    const server = await startDashboardServer({
      port: 0,
      host: createHost({
        requestPipelinePause: (context) => {
          received.push(context);
          return { paused: true, issues: [] };
        },
        requestPipelineResume: (context) => {
          received.push(context);
          return { paused: false, issues: [] };
        },
      }),
    });
    servers.push(server);

    for (const path of ["/api/v1/pipeline/pause", "/api/v1/pipeline/resume"]) {
      const response = await sendRequest(server.port, {
        method: "POST",
        path,
        body: "{}",
      });
      expect(response.statusCode).toBe(415);
    }
    expect(received).toHaveLength(0);
  });
});

describe("indistinguishable journal entries AC (SYMPH-408)", () => {
  const servers: Array<{ close: () => Promise<void> }> = [];

  afterEach(async () => {
    await Promise.all(servers.splice(0).map((server) => server.close()));
  });

  it("watchdog-l2 and operator intents via the endpoint differ only in the actor field", async () => {
    const journalEntryFor = async (actor: IntentActor) => {
      const orchestrator = createOrchestrator();
      const server = await startDashboardServer({
        port: 0,
        host: createHost({
          // Mirror of OrchestratorRuntimeHost.requestIntent: a thin route
          // into writeIntent, no extra semantics.
          requestIntent: async (input) => {
            const result = await orchestrator.writeIntent({
              verb: input.verb,
              issueId: input.issueId ?? "1",
              issueIdentifier: input.issueIdentifier ?? "ISSUE-1",
              actor: input.actor,
              reason: { class: `api:${input.verb}`, human: input.reason },
            });
            return {
              status: result.status,
              detail: result.detail,
              sequence: result.sequence,
              verb: input.verb,
              issue_id: input.issueId ?? "1",
              issue_identifier: input.issueIdentifier ?? "ISSUE-1",
            };
          },
        }),
      });
      servers.push(server);

      const response = await postIntent(server.port, {
        verb: "park",
        issueId: "1",
        issueIdentifier: "ISSUE-1",
        reason: "pausing for deploy",
        actor,
      });
      expect(response.statusCode).toBe(200);
      expect(JSON.parse(response.body).status).toBe("applied");

      const entry = orchestrator
        .getState()
        .dispatcherRunJournal.find((candidate) => candidate.kind === "intent");
      expect(entry).toBeDefined();
      return entry as NonNullable<typeof entry>;
    };

    const operatorEntry = await journalEntryFor({
      kind: "operator",
      host: "pro14",
    });
    const watchdogEntry = await journalEntryFor({
      kind: "watchdog-l2",
      host: "pro14",
    });

    // Same metadata shape: identical key sets...
    expect(Object.keys(watchdogEntry.metadata).sort()).toEqual(
      Object.keys(operatorEntry.metadata).sort(),
    );
    // ...and identical values everywhere except the actor (and the strings
    // that render the actor: summary + the actor-discriminated idempotency
    // key).
    const { actor: operatorActor, ...operatorRest } = operatorEntry.metadata;
    const { actor: watchdogActor, ...watchdogRest } = watchdogEntry.metadata;
    expect(watchdogRest).toEqual(operatorRest);
    expect(operatorActor).toEqual({
      kind: "operator",
      host: "pro14",
      session: null,
    });
    expect(watchdogActor).toEqual({
      kind: "watchdog-l2",
      host: "pro14",
      session: null,
    });

    // The non-metadata envelope matches too (same kind, issue, stage...).
    for (const field of [
      "kind",
      "issueId",
      "issueIdentifier",
      "operation",
      "stage",
      "attempt",
      "lease",
    ] as const) {
      expect(watchdogEntry[field]).toEqual(operatorEntry[field]);
    }
  });
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function validBody(): Record<string, unknown> & { issueIdentifier: string } {
  return {
    verb: "release",
    issueIdentifier: "SYMPH-1",
    reason: "released after host fix",
    actor: { kind: "operator", host: "pro14", session: "symphonyctl" },
  };
}

function appliedResult(): IntentRequestResult {
  return {
    status: "applied",
    detail: "released",
    sequence: 7,
    verb: "release",
    issue_id: "1",
    issue_identifier: "SYMPH-1",
  };
}

function postIntent(port: number, body: unknown) {
  return sendRequest(port, {
    method: "POST",
    path: "/api/v1/intents",
    body: JSON.stringify(body),
    headers: { "content-type": "application/json" },
  });
}

function createHost(
  overrides?: Partial<DashboardServerHost>,
): DashboardServerHost {
  return {
    getRuntimeSnapshot: () => createSnapshot(),
    getIssueDetails: () => null,
    requestRefresh: () => ({
      queued: true,
      coalesced: false,
      requested_at: "2026-06-12T11:00:00.000Z",
      operations: ["poll", "reconcile"],
    }),
    ...overrides,
  };
}

function createSnapshot(): RuntimeSnapshot {
  return {
    generated_at: "2026-06-12T10:00:00.000Z",
    counts: { running: 0, retrying: 0, completed: 0, failed: 0 },
    running: [],
    retrying: [],
    codex_totals: {
      input_tokens: 0,
      output_tokens: 0,
      total_tokens: 0,
      seconds_running: 0,
    },
    rate_limits: { requestsRemaining: 10 },
    rate_limit_admission: null,
    explicit_resume_required: {},
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
): Promise<{ statusCode: number; body: string }> {
  return new Promise((resolve, reject) => {
    const request = httpRequest(
      {
        host: "127.0.0.1",
        port,
        method: input.method,
        path: input.path,
        headers: input.headers,
      },
      (response: IncomingMessage) => {
        const chunks: Buffer[] = [];
        response.on("data", (chunk) => {
          chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
        });
        response.on("end", () => {
          resolve({
            statusCode: response.statusCode ?? 0,
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

// Orchestrator harness (mirrors tests/orchestrator/write-intent.test.ts).

function createOrchestrator(): OrchestratorCore {
  const options: OrchestratorCoreOptions = {
    config: createConfig(),
    tracker: createTracker(),
    spawnWorker: async () => ({
      workerHandle: { pid: 9001 },
      monitorHandle: { ref: "monitor-1" },
    }),
    now: () => new Date("2026-06-12T12:00:00.000Z"),
  };
  return new OrchestratorCore(options);
}

function createTracker(): IssueTracker {
  return {
    async fetchCandidateIssues() {
      return [createIssue()];
    },
    async fetchIssuesByStates() {
      return [];
    },
    async fetchIssueStatesByIds() {
      return [{ id: "1", identifier: "ISSUE-1", state: "In Progress" }];
    },
  };
}

function createConfig(): ResolvedWorkflowConfig {
  return {
    workflowPath: "/tmp/WORKFLOW.md",
    promptTemplate: "Prompt",
    tracker: {
      kind: "linear",
      endpoint: "https://api.linear.app/graphql",
      apiKey: "token",
      projectSlug: "project",
      activeStates: ["Todo", "In Progress", "In Review", "Resume"],
      terminalStates: ["Done", "Canceled"],
    },
    polling: { intervalMs: 30_000 },
    workspace: { root: "/tmp/workspaces" },
    hooks: {
      afterCreate: null,
      beforeRun: null,
      afterRun: null,
      beforeRemove: null,
      timeoutMs: 30_000,
    },
    agent: {
      maxConcurrentAgents: 2,
      maxTurns: 5,
      maxRetryBackoffMs: 300_000,
      maxRetryAttempts: 5,
      maxConcurrentAgentsByState: {},
    },
    runner: { kind: "codex", model: null },
    codex: {
      command: "codex-app-server",
      approvalPolicy: "never",
      threadSandbox: null,
      turnSandboxPolicy: null,
      turnTimeoutMs: 300_000,
      readTimeoutMs: 30_000,
      stallTimeoutMs: 300_000,
    },
    pauseTriage: { baseUrl: null, model: null, apiKey: null, maxResumes: 2 },
    acGate: { enabled: false },
    specFidelity: { enabled: false },
    budgetEscalation: { maxSteps: null, multiplier: 2 },
    rateLimitAdmission: {
      minPrimaryHeadroomPct: null,
      minSecondaryHeadroomPct: null,
    },
    server: { port: null, slackNotifyChannel: null },
    notifications: { slackEnabled: true },
    observability: {
      dashboardEnabled: false,
      refreshMs: 1_000,
      renderIntervalMs: 16,
    },
    admissionCard: { enabled: false },
    watchdog: {
      systemicThreshold: 2,
      circuitBreaker: true,
      maxFilingsPerHour: 3,
    },
    stages: createStages(),
    escalationState: "Blocked",
  };
}

function createStages(): StagesConfig {
  return {
    initialStage: "investigate",
    fastTrack: null,
    stages: {
      investigate: {
        type: "agent",
        runner: "codex",
        model: null,
        prompt: "investigate.liquid",
        maxTurns: 8,
        timeoutMs: null,
        concurrency: null,
        gateType: null,
        maxRework: null,
        reviewers: [],
        transitions: { onComplete: "done", onApprove: null, onRework: null },
        linearState: null,
      },
      done: {
        type: "terminal",
        runner: null,
        model: null,
        prompt: null,
        maxTurns: null,
        timeoutMs: null,
        concurrency: null,
        gateType: null,
        maxRework: null,
        reviewers: [],
        transitions: { onComplete: null, onApprove: null, onRework: null },
        linearState: null,
      },
    },
  };
}

function createIssue(overrides?: Partial<Issue>): Issue {
  return {
    id: "1",
    identifier: "ISSUE-1",
    title: "Example issue",
    description: null,
    priority: 1,
    state: "In Progress",
    branchName: null,
    url: null,
    labels: [],
    blockedBy: [],
    createdAt: "2026-06-01T00:00:00.000Z",
    updatedAt: "2026-06-01T00:00:00.000Z",
    ...overrides,
  };
}
