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
  type AnchorFieldEditRequest,
  type AnchorFieldEditResult,
  type DashboardOperatorAuthOptions,
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

const OPERATOR_AUTH = {
  token: "operator-token",
  actor: { kind: "operator", host: "trusted-host", session: "dashboard" },
} satisfies DashboardOperatorAuthOptions;
const AUTH_HEADERS = {
  authorization: `Bearer ${OPERATOR_AUTH.token}`,
};

describe("POST /api/v1/intents", () => {
  const servers: Array<{ close: () => Promise<void> }> = [];

  afterEach(async () => {
    await Promise.all(servers.splice(0).map((server) => server.close()));
  });

  async function startServer(overrides?: Partial<DashboardServerHost>) {
    const server = await startDashboardServer({
      port: 0,
      host: createHost(overrides),
      operatorAuth: OPERATOR_AUTH,
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

  it("requires anchor details for the anchor verb", async () => {
    const server = await startServer({
      requestIntent: () => appliedResult(),
    });
    const response = await postIntent(server.port, {
      ...validBody(),
      verb: "anchor",
    });
    expect(response.statusCode).toBe(400);
    expect(JSON.parse(response.body).error.message).toContain(
      "anchor placement",
    );
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

  it("rejects unauthenticated intent requests before host mutation", async () => {
    const received: IntentRequest[] = [];
    const server = await startServer({
      requestIntent: (input) => {
        received.push(input);
        return appliedResult();
      },
    });
    const response = await sendRequest(server.port, {
      method: "POST",
      path: "/api/v1/intents",
      body: JSON.stringify(validBody()),
      headers: { "content-type": "application/json" },
    });
    expect(response.statusCode).toBe(401);
    expect(JSON.parse(response.body).error.code).toBe("unauthorized");
    expect(received).toHaveLength(0);
  });

  it("rejects invalid operator tokens before host mutation", async () => {
    const received: IntentRequest[] = [];
    const server = await startServer({
      requestIntent: (input) => {
        received.push(input);
        return appliedResult();
      },
    });
    const response = await sendRequest(server.port, {
      method: "POST",
      path: "/api/v1/intents",
      body: JSON.stringify(validBody()),
      headers: {
        "content-type": "application/json",
        authorization: "Bearer wrong-token",
      },
    });
    expect(response.statusCode).toBe(401);
    expect(JSON.parse(response.body).error.code).toBe("unauthorized");
    expect(received).toHaveLength(0);
  });

  it("derives intent actor from operator auth instead of body content", async () => {
    const received: IntentRequest[] = [];
    const server = await startServer({
      requestIntent: (input) => {
        received.push(input);
        return appliedResult();
      },
    });
    const response = await postIntent(server.port, {
      ...validBody(),
      actor: { kind: "watchdog-l2", host: "spoofed-host" },
    });
    expect(response.statusCode).toBe(200);
    expect(received[0]?.actor).toEqual(OPERATOR_AUTH.actor);
  });

  it("rejects malformed JSON with 400", async () => {
    const server = await startServer({
      requestIntent: () => appliedResult(),
    });
    const response = await sendRequest(server.port, {
      method: "POST",
      path: "/api/v1/intents",
      body: "{not json",
      headers: { "content-type": "application/json", ...AUTH_HEADERS },
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
        actor: OPERATOR_AUTH.actor,
        fence: { expectedParkSeq: 3 },
        hint: "check the lockfile",
        stage: "review",
      },
    ]);
  });

  it("passes validated anchor payloads to the host", async () => {
    const received: IntentRequest[] = [];
    const server = await startServer({
      requestIntent: (input) => {
        received.push(input);
        return { ...appliedResult(), verb: "anchor" };
      },
    });

    const response = await postIntent(server.port, {
      verb: "anchor",
      issueIdentifier: "SYMPH-1",
      reason: "pin this one",
      actor: { kind: "operator", host: "pro14", session: "symphonyctl" },
      anchor: {
        placement: { kind: "above", issueIdentifier: "SYMPH-0" },
        expiry: { kind: "until_merged" },
        source: "symphonyctl",
      },
    });
    expect(response.statusCode).toBe(200);
    expect(received[0]?.anchor).toEqual({
      placement: { kind: "above", issueIdentifier: "SYMPH-0" },
      expiry: { kind: "until_merged" },
      source: "symphonyctl",
      fieldName: null,
      editorEmail: null,
    });
  });

  it("rejects Linear field-edit provenance on the generic intent endpoint", async () => {
    const received: IntentRequest[] = [];
    const server = await startServer({
      requestIntent: (input) => {
        received.push(input);
        return { ...appliedResult(), verb: "anchor" };
      },
    });

    const forgedSource = await postIntent(server.port, {
      verb: "anchor",
      issueIdentifier: "SYMPH-1",
      reason: "pin this one",
      actor: { kind: "operator", host: "pro14", session: "symphonyctl" },
      anchor: {
        placement: { kind: "top" },
        expiry: { kind: "until_merged" },
        source: "linear_field_edit",
        fieldName: "Queue Anchor",
        editorEmail: "operator@mobilyze.com",
      },
    });
    expect(forgedSource.statusCode).toBe(400);

    const forgedFields = await postIntent(server.port, {
      verb: "anchor",
      issueIdentifier: "SYMPH-1",
      reason: "pin this one",
      actor: { kind: "operator", host: "pro14", session: "symphonyctl" },
      anchor: {
        placement: { kind: "top" },
        expiry: { kind: "until_merged" },
        source: "api",
        fieldName: "Queue Anchor",
        editorEmail: "operator@mobilyze.com",
      },
    });
    expect(forgedFields.statusCode).toBe(400);
    expect(received).toHaveLength(0);
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
      headers: AUTH_HEADERS,
    });
    expect(response.statusCode).toBe(415);
    expect(JSON.parse(response.body).error.code).toBe("unsupported_media_type");
    expect(requests).toHaveLength(0);
  });

  it("rejects the pipeline sentinel as an intent target with 400 (case- and whitespace-insensitive)", async () => {
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
      { issueId: " pipeline " },
      { issueIdentifier: "\tPIPELINE\n" },
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
      headers: { "content-type": "application/json", ...AUTH_HEADERS },
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

  it("derives the actor from operator auth and forwards the request reason", async () => {
    const received: Array<PipelineControlContext | undefined> = [];
    const server = await startDashboardServer({
      port: 0,
      operatorAuth: OPERATOR_AUTH,
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
      headers: { "content-type": "application/json", ...AUTH_HEADERS },
    });
    expect(response.statusCode).toBe(200);
    expect(received).toEqual([
      {
        actor: OPERATOR_AUTH.actor,
        reason: "halting for deploy",
      },
    ]);
  });

  it("uses the authenticated operator actor when no body is sent", async () => {
    const received: Array<PipelineControlContext | undefined> = [];
    const server = await startDashboardServer({
      port: 0,
      operatorAuth: OPERATOR_AUTH,
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
      headers: { "content-type": "application/json", ...AUTH_HEADERS },
    });
    expect(response.statusCode).toBe(200);
    expect(received[0]?.actor).toEqual(OPERATOR_AUTH.actor);
    expect(received[0]?.reason).toContain("dashboard");
  });

  it("rejects unauthenticated pipeline control before host mutation", async () => {
    const received: Array<PipelineControlContext | undefined> = [];
    const server = await startDashboardServer({
      port: 0,
      operatorAuth: OPERATOR_AUTH,
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
        actor: { kind: "watchdog-l2", host: "spoofed" },
        reason: "spoofed",
      }),
      headers: { "content-type": "application/json" },
    });
    expect(response.statusCode).toBe(401);
    expect(received).toHaveLength(0);
  });

  it("rejects pause/resume without content-type: application/json with 415", async () => {
    const received: Array<PipelineControlContext | undefined> = [];
    const server = await startDashboardServer({
      port: 0,
      operatorAuth: OPERATOR_AUTH,
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
        headers: AUTH_HEADERS,
      });
      expect(response.statusCode).toBe(415);
    }
    expect(received).toHaveLength(0);
  });

  it("rejects non-string pipeline control reasons before host mutation", async () => {
    const received: Array<PipelineControlContext | undefined> = [];
    const server = await startDashboardServer({
      port: 0,
      operatorAuth: OPERATOR_AUTH,
      host: createHost({
        requestPipelinePause: (context) => {
          received.push(context);
          return { paused: true, issues: [] };
        },
        requestPipelineResume: (context) => {
          received.push(context);
          return { paused: false, issues: [] };
        },
        requestEmergencyStop: (context) => {
          received.push(context);
          return {
            status: "applied",
            detail: "emergency stop applied",
            sequence: 17,
            interrupted_issues: [],
            stop_requests: [],
          };
        },
      }),
    });
    servers.push(server);

    const invalidReasons: unknown[] = [
      { class: "structured" },
      ["array reason"],
      42,
      true,
      null,
    ];
    const paths = [
      "/api/v1/pipeline/pause",
      "/api/v1/pipeline/resume",
      "/api/v1/pipeline/stop",
    ];

    for (const path of paths) {
      for (const reason of invalidReasons) {
        const response = await sendRequest(server.port, {
          method: "POST",
          path,
          body: JSON.stringify({ reason }),
          headers: { "content-type": "application/json", ...AUTH_HEADERS },
        });
        expect(response.statusCode).toBe(400);
      }
    }

    expect(received).toHaveLength(0);

    for (const path of paths) {
      const response = await sendRequest(server.port, {
        method: "POST",
        path,
        body: JSON.stringify({ reason: `valid reason for ${path}` }),
        headers: { "content-type": "application/json", ...AUTH_HEADERS },
      });
      expect(response.statusCode).toBe(200);
    }

    expect(received.map((context) => context?.reason)).toEqual([
      "valid reason for /api/v1/pipeline/pause",
      "valid reason for /api/v1/pipeline/resume",
      "valid reason for /api/v1/pipeline/stop",
    ]);
  });

  it("forwards emergency stop requests through the pipeline stop control endpoint", async () => {
    const received: Array<PipelineControlContext | undefined> = [];
    const server = await startDashboardServer({
      port: 0,
      operatorAuth: OPERATOR_AUTH,
      host: createHost({
        requestEmergencyStop: (context) => {
          received.push(context);
          return {
            status: "applied",
            detail: "emergency stop applied",
            sequence: 17,
            interrupted_issues: [
              {
                issue_id: "1",
                issue_identifier: "ISSUE-1",
                stage: "implement",
                attempt: null,
                codex_app_server_pid: "1001",
                process_identity: {
                  pid: 1001,
                  process_group_id: 1001,
                  session_id: 1001,
                  started_at: "linux-starttime:123456",
                  command_present: true,
                  launch_token_present: true,
                },
                identity_status: "present",
                cleanup_status: "confirmed",
                cleanup_status_reason:
                  "Cleanup proof is confirmed; process identity is redacted for display.",
              },
            ],
            stop_requests: [
              {
                issue_identifier: "ISSUE-1",
                stopped: true,
                reason: "emergency_stop",
              },
            ],
          };
        },
      }),
    });
    servers.push(server);

    const response = await sendRequest(server.port, {
      method: "POST",
      path: "/api/v1/pipeline/stop",
      body: JSON.stringify({
        actor: { kind: "operator", host: "pro14", session: "symphonyctl" },
        reason: "runaway token burn",
      }),
      headers: { "content-type": "application/json", ...AUTH_HEADERS },
    });

    expect(response.statusCode).toBe(200);
    expect(JSON.parse(response.body)).toMatchObject({
      status: "applied",
      sequence: 17,
      interrupted_issues: [{ issue_identifier: "ISSUE-1" }],
    });
    expect(received).toEqual([
      {
        actor: OPERATOR_AUTH.actor,
        reason: "runaway token burn",
      },
    ]);
  });
});

describe("POST /api/v1/anchor-field-edits", () => {
  const servers: Array<{ close: () => Promise<void> }> = [];

  afterEach(async () => {
    await Promise.all(servers.splice(0).map((server) => server.close()));
  });

  it("returns 501 when the host does not support anchor field edits", async () => {
    const server = await startDashboardServer({
      port: 0,
      anchorFieldEditSecret: "shared-secret",
      host: createHost(),
    });
    servers.push(server);

    const response = await postAnchorFieldEdit(
      server.port,
      {
        issueIdentifier: "ISSUE-1",
        fieldName: "Queue Anchor",
        value: "top until-merged",
        editorEmail: "operator@mobilyze.com",
        editedAt: "2026-06-12T12:00:00.000Z",
      },
      {
        secret: "shared-secret",
      },
    );
    expect(response.statusCode).toBe(501);
  });

  it("passes validated field edits to the host", async () => {
    const received: AnchorFieldEditRequest[] = [];
    const server = await startDashboardServer({
      port: 0,
      anchorFieldEditSecret: "shared-secret",
      host: createHost({
        requestAnchorFieldEdit: (input) => {
          received.push(input);
          return anchorFieldEditResult({ status: "ignored" });
        },
      }),
    });
    servers.push(server);

    const response = await postAnchorFieldEdit(
      server.port,
      {
        issueIdentifier: "ISSUE-1",
        fieldName: "Queue Anchor",
        value: null,
        editorEmail: "operator@mobilyze.com",
        editedAt: "2026-06-12T12:00:00.000Z",
      },
      {
        secret: "shared-secret",
      },
    );
    expect(response.statusCode).toBe(200);
    expect(received).toEqual([
      {
        issueIdentifier: "ISSUE-1",
        fieldName: "Queue Anchor",
        value: null,
        editorEmail: "operator@mobilyze.com",
        editedAt: "2026-06-12T12:00:00.000Z",
      },
    ]);
  });

  it("maps unresolved anchor field edits to 404 instead of pre-pinning non-active issues", async () => {
    const server = await startDashboardServer({
      port: 0,
      anchorFieldEditSecret: "shared-secret",
      host: createHost({
        requestAnchorFieldEdit: () =>
          anchorFieldEditResult({
            status: "issue_not_found",
            detail:
              "Issue 'ISSUE-1' could not be resolved from runtime state or the tracker's active states.",
          }),
      }),
    });
    servers.push(server);

    const response = await postAnchorFieldEdit(
      server.port,
      {
        issueIdentifier: "ISSUE-1",
        fieldName: "Queue Anchor",
        value: "top until-merged",
        editorEmail: "operator@mobilyze.com",
        editedAt: "2026-06-12T12:00:00.000Z",
      },
      {
        secret: "shared-secret",
      },
    );
    expect(response.statusCode).toBe(404);
    expect(JSON.parse(response.body).status).toBe("issue_not_found");
  });

  it("rejects field edits that omit value instead of treating them as clears", async () => {
    const received: AnchorFieldEditRequest[] = [];
    const server = await startDashboardServer({
      port: 0,
      anchorFieldEditSecret: "shared-secret",
      host: createHost({
        requestAnchorFieldEdit: (input) => {
          received.push(input);
          return anchorFieldEditResult({ status: "applied" });
        },
      }),
    });
    servers.push(server);

    const response = await postAnchorFieldEdit(
      server.port,
      {
        issueIdentifier: "ISSUE-1",
        fieldName: "Queue Anchor",
        editorEmail: "operator@mobilyze.com",
        editedAt: "2026-06-12T12:00:00.000Z",
      },
      {
        secret: "shared-secret",
      },
    );
    expect(response.statusCode).toBe(400);
    expect(JSON.parse(response.body).error.code).toBe("invalid_request");
    expect(received).toEqual([]);
  });

  it("rejects field edits without the configured ingress secret before calling the host", async () => {
    const received: AnchorFieldEditRequest[] = [];
    const server = await startDashboardServer({
      port: 0,
      anchorFieldEditSecret: "shared-secret",
      host: createHost({
        requestAnchorFieldEdit: (input) => {
          received.push(input);
          return anchorFieldEditResult({ status: "applied" });
        },
      }),
    });
    servers.push(server);

    const missing = await postAnchorFieldEdit(server.port, {
      issueIdentifier: "ISSUE-1",
      fieldName: "Queue Anchor",
      value: "top until-merged",
      editorEmail: "operator@mobilyze.com",
      editedAt: "2026-06-12T12:00:00.000Z",
    });
    expect(missing.statusCode).toBe(403);

    const wrong = await postAnchorFieldEdit(
      server.port,
      {
        issueIdentifier: "ISSUE-1",
        fieldName: "Queue Anchor",
        value: "top until-merged",
        editorEmail: "operator@mobilyze.com",
        editedAt: "2026-06-12T12:00:00.000Z",
      },
      {
        secret: "wrong-secret",
      },
    );
    expect(wrong.statusCode).toBe(403);
    expect(received).toEqual([]);
  });

  it("rejects unauthenticated field edits before host and content-type distinctions", async () => {
    const server = await startDashboardServer({
      port: 0,
      anchorFieldEditSecret: "shared-secret",
      host: createHost(),
    });
    servers.push(server);

    const response = await sendRequest(server.port, {
      method: "POST",
      path: "/api/v1/anchor-field-edits",
      body: JSON.stringify({
        issueIdentifier: "ISSUE-1",
        fieldName: "Queue Anchor",
        value: "top until-merged",
        editorEmail: "operator@mobilyze.com",
        editedAt: "2026-06-12T12:00:00.000Z",
      }),
    });
    expect(response.statusCode).toBe(403);
  });

  it("routes allowlisted field edits through the anchor ingestion primitive and leaves service-account edits inert", async () => {
    const config = createConfig();
    config.operatorAnchors = {
      operatorAllowlist: ["operator@mobilyze.com"],
      serviceAccounts: ["agent@mobilyze.com"],
      fieldName: "Queue Anchor",
      ingestSecret: null,
    };
    const orchestrator = createOrchestrator({ config });
    const server = await startDashboardServer({
      port: 0,
      anchorFieldEditSecret: "shared-secret",
      host: createHost({
        requestAnchorFieldEdit: async (input) => {
          const result = await orchestrator.ingestAnchorFieldEdit({
            issueId: input.issueId ?? "1",
            issueIdentifier: input.issueIdentifier ?? "ISSUE-1",
            fieldName: input.fieldName,
            value: input.value,
            editorEmail: input.editorEmail,
            editedAt: input.editedAt,
          });
          return anchorFieldEditResult({
            status: result.status,
            detail: result.detail,
            sequence: result.sequence,
          });
        },
      }),
    });
    servers.push(server);

    const service = await postAnchorFieldEdit(
      server.port,
      {
        issueIdentifier: "ISSUE-1",
        fieldName: "Queue Anchor",
        value: "top until-merged",
        editorEmail: "agent@mobilyze.com",
        editedAt: "2026-06-12T12:00:00.000Z",
      },
      {
        secret: "shared-secret",
      },
    );
    expect(service.statusCode).toBe(200);
    expect(JSON.parse(service.body).status).toBe("ignored");
    expect(orchestrator.getState().issueAnchors["1"]).toBeUndefined();

    const operator = await postAnchorFieldEdit(
      server.port,
      {
        issueIdentifier: "ISSUE-1",
        fieldName: "Queue Anchor",
        value: "below ISSUE-0 until-merged",
        editorEmail: "operator@mobilyze.com",
        editedAt: "2026-06-12T12:01:00.000Z",
      },
      {
        secret: "shared-secret",
      },
    );
    expect(operator.statusCode).toBe(200);
    expect(JSON.parse(operator.body).status).toBe("applied");
    expect(orchestrator.getState().issueAnchors["1"]).toMatchObject({
      placement: { kind: "below", issueIdentifier: "ISSUE-0" },
      source: "linear_field_edit",
      editorEmail: "operator@mobilyze.com",
    });
  });

  it("maps stale field edits to 409 through the runtime ingestion path", async () => {
    const config = createConfig();
    config.operatorAnchors = {
      operatorAllowlist: ["operator@mobilyze.com"],
      serviceAccounts: [],
      fieldName: "Queue Anchor",
      ingestSecret: null,
    };
    const orchestrator = createOrchestrator({ config });
    const server = await startDashboardServer({
      port: 0,
      anchorFieldEditSecret: "shared-secret",
      host: createHost({
        requestAnchorFieldEdit: async (input) => {
          const result = await orchestrator.ingestAnchorFieldEdit({
            issueId: input.issueId ?? "1",
            issueIdentifier: input.issueIdentifier ?? "ISSUE-1",
            fieldName: input.fieldName,
            value: input.value,
            editorEmail: input.editorEmail,
            editedAt: input.editedAt,
          });
          return anchorFieldEditResult({
            status: result.status,
            detail: result.detail,
            sequence: result.sequence,
          });
        },
      }),
    });
    servers.push(server);

    const first = await postAnchorFieldEdit(
      server.port,
      {
        issueIdentifier: "ISSUE-1",
        fieldName: "Queue Anchor",
        value: "top until-merged",
        editorEmail: "operator@mobilyze.com",
        editedAt: "2026-06-12T12:01:00.000Z",
      },
      {
        secret: "shared-secret",
      },
    );
    expect(first.statusCode).toBe(200);
    expect(JSON.parse(first.body).status).toBe("applied");

    const stale = await postAnchorFieldEdit(
      server.port,
      {
        issueIdentifier: "ISSUE-1",
        fieldName: "Queue Anchor",
        value: "below ISSUE-0 until-merged",
        editorEmail: "operator@mobilyze.com",
        editedAt: "2026-06-12T12:00:00.000Z",
      },
      {
        secret: "shared-secret",
      },
    );
    expect(stale.statusCode).toBe(409);
    expect(JSON.parse(stale.body).status).toBe("rejected_stale");
  });

  it("rejects field edits without JSON content-type before calling the host", async () => {
    const received: AnchorFieldEditRequest[] = [];
    const server = await startDashboardServer({
      port: 0,
      anchorFieldEditSecret: "shared-secret",
      host: createHost({
        requestAnchorFieldEdit: (input) => {
          received.push(input);
          return anchorFieldEditResult({ status: "ignored" });
        },
      }),
    });
    servers.push(server);

    const response = await sendRequest(server.port, {
      method: "POST",
      path: "/api/v1/anchor-field-edits",
      body: JSON.stringify({
        issueIdentifier: "ISSUE-1",
        fieldName: "Queue Anchor",
        value: "top until-merged",
        editorEmail: "operator@mobilyze.com",
        editedAt: "2026-06-12T12:00:00.000Z",
      }),
      headers: { "x-symphony-anchor-secret": "shared-secret" },
    });
    expect(response.statusCode).toBe(415);
    expect(received).toHaveLength(0);
  });
});

describe("authenticated intent actor binding (SYMPH-449)", () => {
  const servers: Array<{ close: () => Promise<void> }> = [];

  afterEach(async () => {
    await Promise.all(servers.splice(0).map((server) => server.close()));
  });

  it("body actor content cannot spoof the journaled authenticated actor", async () => {
    const journalEntryFor = async (bodyActor: IntentActor) => {
      const orchestrator = createOrchestrator();
      const server = await startDashboardServer({
        port: 0,
        operatorAuth: OPERATOR_AUTH,
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
        actor: bodyActor,
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
    // ...and identical values. The request body actor no longer influences
    // journal attribution; the server binds it to authenticated operator auth.
    const operatorActor = operatorEntry.metadata.actor;
    const watchdogActor = watchdogEntry.metadata.actor;
    expect(watchdogEntry.metadata).toEqual(operatorEntry.metadata);
    expect(operatorActor).toEqual({
      kind: "operator",
      host: "trusted-host",
      session: "dashboard",
    });
    expect(watchdogActor).toEqual(operatorActor);

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

function anchorFieldEditResult(
  overrides?: Partial<AnchorFieldEditResult>,
): AnchorFieldEditResult {
  return {
    status: "ignored",
    detail: "service-account field edit is advisory only",
    sequence: null,
    issue_id: "1",
    issue_identifier: "ISSUE-1",
    ...overrides,
  };
}

function postIntent(port: number, body: unknown) {
  return sendRequest(port, {
    method: "POST",
    path: "/api/v1/intents",
    body: JSON.stringify(body),
    headers: { "content-type": "application/json", ...AUTH_HEADERS },
  });
}

function postAnchorFieldEdit(
  port: number,
  body: unknown,
  options?: { secret?: string },
) {
  return sendRequest(port, {
    method: "POST",
    path: "/api/v1/anchor-field-edits",
    body: JSON.stringify(body),
    headers: {
      "content-type": "application/json",
      ...(options?.secret === undefined
        ? {}
        : { "x-symphony-anchor-secret": options.secret }),
    },
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
    anchors: [],
    codex_totals: {
      input_tokens: 0,
      output_tokens: 0,
      total_tokens: 0,
      seconds_running: 0,
    },
    rate_limits: { requestsRemaining: 10 },
    rate_limit_admission: null,
    explicit_resume_required: {},
    emergency_stop: null,
    as_of_sequence: 0,
    counters: {},
    rate_limit_views: {
      runner_snapshot_file: null,
      gate: null,
      live_telemetry: null,
      disagreement: null,
    },
    deploy_drift: null,
    watchdog: { clusters: [], open_breakers: [] },
    components: {},
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

function createOrchestrator(
  overrides?: Partial<OrchestratorCoreOptions>,
): OrchestratorCore {
  const options: OrchestratorCoreOptions = {
    config: createConfig(),
    tracker: createTracker(),
    spawnWorker: async () => ({
      workerHandle: { pid: 9001 },
      monitorHandle: { ref: "monitor-1" },
    }),
    now: () => new Date("2026-06-12T12:00:00.000Z"),
    ...overrides,
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
    server: { port: null, host: null, slackNotifyChannel: null },
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
