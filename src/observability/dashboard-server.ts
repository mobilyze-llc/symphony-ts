import {
  type ChildProcess,
  execFile as execFileCb,
  spawn,
} from "node:child_process";
import { timingSafeEqual } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import {
  type IncomingMessage,
  type Server,
  type ServerResponse,
  createServer,
} from "node:http";
import { homedir, hostname as osHostname } from "node:os";
import { dirname, join, resolve as pathResolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { z } from "zod";

import {
  DEFAULT_OBSERVABILITY_REFRESH_MS,
  DEFAULT_OBSERVABILITY_RENDER_INTERVAL_MS,
} from "../config/defaults.js";
import { ERROR_CODES } from "../errors/codes.js";
import type { LoopTraceJournalResponse } from "../logging/loop-trace.js";
import {
  type RuntimeSnapshot,
  STATE_DELTA_DEFAULT_LIMIT,
  STATE_DELTA_MAX_LIMIT,
  type StateDeltaResponse,
} from "../logging/runtime-snapshot.js";
// The ONLY orchestrator import allowed in this file is the intent leaf
// module (verb/actor vocabulary + types). The dashboard never reaches into
// orchestrator state directly — every mutation goes through a host method
// that routes the orchestrator's intent-verb layer (SYMPH-408; enforced by
// tests/observability/dashboard-no-bypass.test.ts).
import {
  type AnchorIntentPayload,
  INTENT_VERBS,
  type IntentActor,
  type IntentFence,
  type IntentStatus,
  type IntentVerb,
  isPipelineSentinelValue,
} from "../orchestrator/intent.js";
import { fetchClaudeUsageFromCli } from "./dashboard-claude-usage.js";
import { toErrorMessage } from "./dashboard-format.js";
import {
  PayloadTooLargeError,
  isSnapshotTimeoutError,
  readRequestBody,
  readRequestBodyText,
  readSnapshot,
  writeHtml,
  writeJson,
  writeNotFound,
} from "./dashboard-http.js";
import { DashboardLiveUpdatesController } from "./dashboard-live-updates.js";
import {
  type DashboardRenderOptions,
  renderDashboardHtml,
} from "./dashboard-render.js";

const DEFAULT_SNAPSHOT_TIMEOUT_MS = 1_000;
const GITHUB_QUEUE_CACHE_TTL_MS = 15_000;
const CLAUDE_USAGE_CACHE_TTL_MS = 30_000;

let claudeUsageCache: {
  data: Record<string, unknown>;
  expiresAt: number;
} | null = null;
let claudeUsageInflight: Promise<Record<string, unknown>> | null = null;

export interface IssueDetailRunningState {
  session_id: string | null;
  turn_count: number;
  state: string;
  started_at: string;
  last_event: string | null;
  last_message: string | null;
  last_event_at: string | null;
  tokens: {
    input_tokens: number;
    output_tokens: number;
    total_tokens: number;
    cache_read_tokens?: number;
    cache_write_tokens?: number;
    no_cache_tokens?: number;
    reasoning_tokens?: number;
  };
  token_telemetry: Array<{
    at: string;
    event: string;
    session_id: string | null;
    turn_id: string | null;
    input_tokens: number;
    output_tokens: number;
    total_tokens: number;
    input_tokens_delta: number;
    output_tokens_delta: number;
    total_tokens_delta: number;
    cache_read_tokens: number | null;
    cache_write_tokens: number | null;
    no_cache_tokens: number | null;
    reasoning_tokens: number | null;
    cache_read_tokens_delta: number;
    cache_write_tokens_delta: number;
    no_cache_tokens_delta: number;
    reasoning_tokens_delta: number;
  }>;
  token_telemetry_total_entries?: number;
  token_telemetry_retained_entries?: number;
  token_telemetry_observed_entries?: number;
  token_telemetry_truncated?: boolean;
  token_telemetry_retention_truncated?: boolean;
}

export interface IssueDetailRetryState {
  attempt: number;
  due_at: string;
  error: string | null;
}

export interface IssueDetailResponse {
  issue_identifier: string;
  issue_id: string;
  status:
    | "claimed"
    | "completed"
    | "failed"
    | "released"
    | "retry_queued"
    | "running"
    | "unclaimed";
  workspace: {
    path: string;
  } | null;
  attempts: {
    restart_count: number;
    current_retry_attempt: number | null;
  };
  running: IssueDetailRunningState | null;
  retry: IssueDetailRetryState | null;
  logs: {
    codex_session_logs: Array<{
      label: string;
      path: string;
      url: string | null;
      bytes?: number;
    }>;
  };
  recent_events: Array<{
    at: string;
    event: string;
    message: string | null;
  }>;
  loop_trace_journal: LoopTraceJournalResponse;
  last_error: string | null;
  tracked: Record<string, unknown>;
  parent: {
    identifier: string;
    title: string;
    url: string;
  } | null;
}

export interface RefreshResponse {
  queued: boolean;
  coalesced: boolean;
  requested_at: string;
  operations: string[];
}

export interface StopIssueResponse {
  issue_identifier: string;
  stopped: boolean;
  reason: string;
  signal_delivery?: StopSignalDeliveryResponse | null;
}

export interface StopSignalDeliveryResponse {
  status: "not_attempted" | "delivered" | "partial" | "failed";
  reason: string;
  attempted_at: string;
  workspace_path: string | null;
  attempts: Array<{
    pid: number;
    process_group_id?: number;
    sigterm: "delivered" | "failed";
    sigkill: "delivered" | "failed" | "not_attempted";
  }>;
  warning: string | null;
}

export type PipelineRestartSafetyReason =
  | "drained"
  | "active_pipeline_issues"
  | "running_or_retrying_lanes"
  | "runtime_and_queue_not_drained"
  | "queue_status_unavailable";

export interface PipelineRestartSafetyResponse {
  restart_safe: boolean;
  reason: PipelineRestartSafetyReason;
  running_lane_count: number;
  retrying_lane_count: number;
  active_issue_count: number;
  active_issues: Array<{
    identifier: string;
    title: string;
    state: string;
  }>;
  guidance: string[];
  error_message?: string;
}

export interface PipelineStatusResponse {
  paused: boolean;
  issues: Array<{ identifier: string; title: string }>;
  restart_safety?: PipelineRestartSafetyResponse;
  emergency_stop?: EmergencyStopStateResponse | null;
}

export interface EmergencyStopStateResponse {
  active: true;
  since: string;
  reason: string;
  set_by_sequence: number | null;
  interrupted_issues: Array<{
    issue_id: string;
    issue_identifier: string;
    stage: string | null;
    attempt: number | null;
    codex_app_server_pid: string | null;
    process_identity: {
      pid: number;
      process_group_id: number | null;
      session_id: number | null;
      started_at: string;
      command_present: boolean;
      launch_token_present: boolean;
    } | null;
    identity_status: "present" | "missing" | "mismatch";
    cleanup_status:
      | "confirmed"
      | "unconfirmed"
      | "missing_identity"
      | "identity_mismatch";
    cleanup_status_reason: string;
  }>;
}

export interface EmergencyStopResponse {
  status: "applied" | "no_op";
  detail: string;
  sequence: number | null;
  interrupted_issues: EmergencyStopStateResponse["interrupted_issues"];
  stop_requests: StopIssueResponse[];
}

/**
 * Validated body of POST /api/v1/intents (SYMPH-408b). A thin transport
 * envelope over the orchestrator's writeIntent primitive — the dashboard
 * adds no verb semantics of its own.
 */
export interface IntentRequest {
  verb: IntentVerb;
  issueId?: string;
  issueIdentifier?: string;
  reason: string;
  actor: IntentActor;
  fence?: IntentFence;
  hint?: string;
  stage?: string;
  anchor?: AnchorIntentPayload;
}

export interface IntentRequestResult {
  status: IntentStatus | "issue_not_found" | "invalid_request";
  detail: string;
  sequence: number | null;
  verb: IntentVerb;
  issue_id: string | null;
  issue_identifier: string | null;
}

/**
 * Validated body of POST /api/v1/anchor-field-edits (SYMPH-486). This is the
 * production ingress for Linear field-edit events: the dashboard validates the
 * event envelope, then the runtime host resolves the issue and routes through
 * the anchor field-edit ingestion path.
 */
export interface AnchorFieldEditRequest {
  issueId?: string;
  issueIdentifier?: string;
  fieldName: string;
  value: string | null;
  editorEmail: string;
  editedAt: string;
}

export interface AnchorFieldEditResult {
  status:
    | "applied"
    | "no_op"
    | "rejected_stale"
    | "ignored"
    | "invalid"
    | "issue_not_found"
    | "invalid_request";
  detail: string;
  sequence: number | null;
  issue_id: string | null;
  issue_identifier: string | null;
}

/**
 * Operator attribution forwarded with pipeline-wide pause/resume so the
 * journaled intent entry carries the real actor instead of an anonymous
 * dashboard default (SYMPH-408b).
 */
export interface PipelineControlContext {
  actor: IntentActor;
  reason: string;
}

export interface DashboardOperatorAuthOptions {
  token?: string | null;
  actor?: IntentActor;
}

export interface DashboardServerHost {
  getRuntimeSnapshot(): RuntimeSnapshot | Promise<RuntimeSnapshot>;
  /**
   * Cursor-forward journal delta read (SYMPH-407): entries with
   * sequence > sinceSeq, bounded. Optional — hosts without a journal
   * surface 501 on GET /api/v1/state/delta.
   */
  getStateDelta?(input: {
    sinceSeq: number;
    limit?: number;
  }): StateDeltaResponse | Promise<StateDeltaResponse>;
  getIssueDetails(
    issueIdentifier: string,
  ): IssueDetailResponse | null | Promise<IssueDetailResponse | null>;
  requestRefresh(): RefreshResponse | Promise<RefreshResponse>;
  requestIssueStop?(
    issueIdentifier: string,
  ): StopIssueResponse | Promise<StopIssueResponse>;
  subscribeToSnapshots?(listener: () => void): () => void;
  requestIntent?(
    input: IntentRequest,
  ): IntentRequestResult | Promise<IntentRequestResult>;
  requestAnchorFieldEdit?(
    input: AnchorFieldEditRequest,
  ): AnchorFieldEditResult | Promise<AnchorFieldEditResult>;
  requestPipelinePause?(
    context?: PipelineControlContext,
  ): PipelineStatusResponse | Promise<PipelineStatusResponse>;
  requestPipelineResume?(
    context?: PipelineControlContext,
  ): PipelineStatusResponse | Promise<PipelineStatusResponse>;
  requestEmergencyStop?(
    context?: PipelineControlContext,
  ): EmergencyStopResponse | Promise<EmergencyStopResponse>;
  getPipelineStatus?():
    | PipelineStatusResponse
    | Promise<PipelineStatusResponse>;
}

const anchorPlacementSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("top") }),
  z.object({
    kind: z.literal("above"),
    issueIdentifier: z.string().min(1).max(256),
  }),
  z.object({
    kind: z.literal("below"),
    issueIdentifier: z.string().min(1).max(256),
  }),
]);

const anchorExpirySchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("until_merged") }),
  z.object({
    kind: z.literal("until_date"),
    at: z.string().datetime(),
  }),
]);

const anchorRequestSchema = z
  .object({
    placement: anchorPlacementSchema,
    expiry: anchorExpirySchema,
    source: z.enum(["symphonyctl", "api"]).default("api"),
  })
  .strict();

const intentRequestSchema = z
  .object({
    verb: z.enum(INTENT_VERBS),
    issueId: z.string().min(1).max(256).optional(),
    issueIdentifier: z.string().min(1).max(256).optional(),
    reason: z.string().min(1).max(2048),
    fence: z
      .object({ expectedParkSeq: z.number().int().positive() })
      .optional(),
    hint: z.string().min(1).max(1024).optional(),
    stage: z.string().min(1).max(1024).optional(),
    anchor: anchorRequestSchema.optional(),
  })
  .refine(
    (value) =>
      value.issueId !== undefined || value.issueIdentifier !== undefined,
    { message: "Either issueId or issueIdentifier is required." },
  )
  .refine(
    (value) =>
      !isPipelineSentinelValue(value.issueId) &&
      !isPipelineSentinelValue(value.issueIdentifier),
    {
      message:
        "The pipeline sentinel is not an addressable issue; use the pipeline pause/resume endpoints.",
    },
  )
  .refine((value) => value.verb !== "anchor" || value.anchor !== undefined, {
    message: "anchor intent requires anchor placement and expiry.",
  });

const anchorFieldEditRequestSchema = z
  .object({
    issueId: z.string().min(1).max(256).optional(),
    issueIdentifier: z.string().min(1).max(256).optional(),
    fieldName: z.string().min(1).max(256),
    value: z.string().max(2048).nullable(),
    editorEmail: z.string().min(1).max(320),
    editedAt: z.string().datetime(),
  })
  .refine(
    (value) =>
      value.issueId !== undefined || value.issueIdentifier !== undefined,
    { message: "Either issueId or issueIdentifier is required." },
  )
  .refine(
    (value) =>
      !isPipelineSentinelValue(value.issueId) &&
      !isPipelineSentinelValue(value.issueIdentifier),
    {
      message:
        "The pipeline sentinel is not an addressable issue; field edits must target a real issue.",
    },
  );

/** Optional body for the pipeline pause/resume endpoints. */
const pipelineControlBodySchema = z.object({
  reason: z.string().min(1).max(2048).optional(),
});

function parseJsonBody(raw: string): unknown {
  if (raw.trim() === "") {
    return {};
  }
  return JSON.parse(raw);
}

/**
 * Mutating JSON routes (intents, pipeline pause/resume) require an explicit
 * `content-type: application/json` — a cheap cross-site / accidental-form
 * POST guard on a server that may be bound beyond loopback. GET routes and
 * body-ignoring POST routes are unchanged.
 */
function hasJsonContentType(request: IncomingMessage): boolean {
  const header = request.headers["content-type"];
  if (header === undefined) {
    return false;
  }
  return header.split(";")[0]?.trim().toLowerCase() === "application/json";
}

function isAuthorizedAnchorFieldEditRequest(
  request: IncomingMessage,
  configuredSecret: string | null,
): boolean {
  if (configuredSecret === null || configuredSecret.trim() === "") {
    return false;
  }
  const suppliedHeader = request.headers["x-symphony-anchor-secret"];
  const suppliedSecret = Array.isArray(suppliedHeader)
    ? suppliedHeader[0]
    : suppliedHeader;
  if (typeof suppliedSecret !== "string") {
    return false;
  }
  const expected = Buffer.from(configuredSecret);
  const supplied = Buffer.from(suppliedSecret);
  return (
    expected.length === supplied.length && timingSafeEqual(expected, supplied)
  );
}

interface OperatorAuthContext {
  token: string | null;
  actor: IntentActor;
}

function defaultOperatorAuthActor(): IntentActor {
  const label = osHostname().split(".")[0];
  return {
    kind: "operator",
    host: label === undefined || label === "" ? osHostname() : label,
    session: "dashboard",
  };
}

function resolveOperatorAuth(
  options: DashboardServerOptions,
): OperatorAuthContext {
  const configuredToken =
    options.operatorAuth?.token ?? process.env.SYMPHONY_OPERATOR_TOKEN ?? null;
  const token =
    configuredToken === null || configuredToken.trim() === ""
      ? null
      : configuredToken.trim();
  return {
    token,
    actor: options.operatorAuth?.actor ?? defaultOperatorAuthActor(),
  };
}

function bearerTokenFromRequest(request: IncomingMessage): string | null {
  const header = request.headers.authorization;
  const authorization = Array.isArray(header) ? header[0] : header;
  if (typeof authorization !== "string") {
    return null;
  }
  if (authorization.slice(0, 6).toLowerCase() !== "bearer") {
    return null;
  }
  const separator = authorization.charCodeAt(6);
  if (separator !== 0x20 && separator !== 0x09) {
    return null;
  }
  let tokenStart = 7;
  while (tokenStart < authorization.length) {
    const code = authorization.charCodeAt(tokenStart);
    if (code !== 0x20 && code !== 0x09) {
      break;
    }
    tokenStart += 1;
  }
  const token = authorization.slice(tokenStart).trim();
  return token === "" ? null : token;
}

function tokenMatches(expectedToken: string, suppliedToken: string): boolean {
  const expected = Buffer.from(expectedToken);
  const supplied = Buffer.from(suppliedToken);
  return (
    expected.length === supplied.length && timingSafeEqual(expected, supplied)
  );
}

function authenticateOperatorRequest(
  request: IncomingMessage,
  auth: OperatorAuthContext,
):
  | { status: "ok"; actor: IntentActor }
  | { status: "unconfigured" | "invalid" } {
  if (auth.token === null) {
    return { status: "unconfigured" };
  }
  const suppliedToken = bearerTokenFromRequest(request);
  if (suppliedToken === null || !tokenMatches(auth.token, suppliedToken)) {
    return { status: "invalid" };
  }
  return { status: "ok", actor: auth.actor };
}

function requireOperatorAuth(
  request: IncomingMessage,
  response: ServerResponse,
  auth: OperatorAuthContext,
): IntentActor | null {
  const authenticated = authenticateOperatorRequest(request, auth);
  if (authenticated.status === "ok") {
    return authenticated.actor;
  }
  if (authenticated.status === "unconfigured") {
    writeJsonError(response, 403, "operator_auth_unconfigured", {
      message:
        "Dashboard mutating routes require SYMPHONY_OPERATOR_TOKEN or operatorAuth.token.",
    });
    return null;
  }
  writeJsonError(response, 401, "unauthorized", {
    message: "Dashboard mutating routes require a valid operator bearer token.",
  });
  return null;
}

function writeUnsupportedMediaType(response: ServerResponse): void {
  writeJsonError(response, 415, "unsupported_media_type", {
    message: "Content-Type must be application/json.",
  });
}

function toIntentRequest(
  data: z.infer<typeof intentRequestSchema>,
  actor: IntentActor,
): IntentRequest {
  return {
    verb: data.verb,
    reason: data.reason,
    actor,
    ...(data.issueId === undefined ? {} : { issueId: data.issueId }),
    ...(data.issueIdentifier === undefined
      ? {}
      : { issueIdentifier: data.issueIdentifier }),
    ...(data.fence === undefined ? {} : { fence: data.fence }),
    ...(data.hint === undefined ? {} : { hint: data.hint }),
    ...(data.stage === undefined ? {} : { stage: data.stage }),
    ...(data.anchor === undefined
      ? {}
      : {
          anchor: {
            placement: data.anchor.placement,
            expiry: data.anchor.expiry,
            source: data.anchor.source,
            fieldName: null,
            editorEmail: null,
          },
        }),
  };
}

function toAnchorFieldEditRequest(
  data: z.infer<typeof anchorFieldEditRequestSchema>,
): AnchorFieldEditRequest {
  return {
    ...(data.issueId === undefined ? {} : { issueId: data.issueId }),
    ...(data.issueIdentifier === undefined
      ? {}
      : { issueIdentifier: data.issueIdentifier }),
    fieldName: data.fieldName,
    value: data.value ?? null,
    editorEmail: data.editorEmail,
    editedAt: data.editedAt,
  };
}

/** Async function that runs `gh` with the given args and returns stdout. */
export type ExecGh = (args: string[]) => Promise<string>;

/** Async function that runs the deploy script with the given args and returns stdout. */
export type ExecDeploy = (args: string[]) => Promise<string>;

/** Spawns the deploy script with the given args and returns the child process for streaming. */
export type SpawnDeploy = (args: string[]) => ChildProcess;

export interface DeployPreviewResponse {
  current_version: string;
  target_version: string;
  commits_ahead: number;
  actions: string[];
  running_issues_count: number;
}

export type ExecCommandFn = (
  cmd: string,
  args: string[],
) => Promise<{ stdout: string; stderr: string }>;

const defaultExecCommand: ExecCommandFn = promisify(execFileCb);

export interface DashboardServerOptions {
  host: DashboardServerHost;
  hostname?: string;
  snapshotTimeoutMs?: number;
  refreshMs?: number;
  renderIntervalMs?: number;
  liveUpdatesEnabled?: boolean;
  operatorAuth?: DashboardOperatorAuthOptions;
  anchorFieldEditSecret?: string | null;
  /** GitHub repo slug (e.g. "org/repo"). Falls back to REPO_URL env var. */
  githubRepoSlug?: string;
  /** Injectable gh CLI executor for testing. Defaults to child_process.execFile("gh", ...). */
  execGh?: ExecGh;
  /** Injectable deploy script executor for testing. Defaults to running ops/symphony-deploy. */
  execDeploy?: ExecDeploy;
  /** Injectable deploy script spawner for streaming. Defaults to spawning ops/symphony-deploy. */
  spawnDeploy?: SpawnDeploy;
  execCommand?: ExecCommandFn;
}

export interface DashboardServerInstance {
  readonly server: Server;
  readonly hostname: string;
  readonly port: number;
  close(): Promise<void>;
}

export function createDashboardServer(options: DashboardServerOptions): Server {
  const hostname = options.hostname ?? "127.0.0.1";
  const snapshotTimeoutMs =
    options.snapshotTimeoutMs ?? DEFAULT_SNAPSHOT_TIMEOUT_MS;
  const liveController = new DashboardLiveUpdatesController({
    host: options.host,
    snapshotTimeoutMs,
    refreshMs: options.refreshMs ?? DEFAULT_OBSERVABILITY_REFRESH_MS,
    renderIntervalMs:
      options.renderIntervalMs ?? DEFAULT_OBSERVABILITY_RENDER_INTERVAL_MS,
  });
  liveController.start();

  const handler = createDashboardRequestHandler({
    ...options,
    hostname,
    snapshotTimeoutMs,
    liveController,
  });
  const server = createServer((request, response) => {
    void handler(request, response);
  });
  server.on("close", () => {
    void liveController.close();
  });
  return server;
}

export async function startDashboardServer(
  options: DashboardServerOptions & {
    port: number;
  },
): Promise<DashboardServerInstance> {
  const server = createDashboardServer(options);
  const hostname = options.hostname ?? "127.0.0.1";

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(options.port, hostname, () => {
      server.off("error", reject);
      resolve();
    });
  });

  const address = server.address();
  if (address === null || typeof address === "string") {
    throw new Error("Dashboard server did not bind to a TCP address.");
  }

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

export function createDashboardRequestHandler(
  options: DashboardServerOptions & {
    liveController?: DashboardLiveUpdatesController;
  },
): (request: IncomingMessage, response: ServerResponse) => Promise<void> {
  const hostname = options.hostname ?? "127.0.0.1";
  const snapshotTimeoutMs =
    options.snapshotTimeoutMs ?? DEFAULT_SNAPSHOT_TIMEOUT_MS;
  const renderOptions: DashboardRenderOptions = {
    liveUpdatesEnabled: options.liveUpdatesEnabled ?? true,
  };
  const githubRepoSlug = resolveRepoSlug(options.githubRepoSlug);
  const execGh = options.execGh ?? defaultExecGh;
  const execDeploy = options.execDeploy ?? defaultExecDeploy;
  const spawnDeployFn = options.spawnDeploy ?? defaultSpawnDeploy;
  let githubQueueCache: GitHubQueueCache | null = null;
  const execCommand = options.execCommand ?? defaultExecCommand;
  const operatorAuth = resolveOperatorAuth(options);

  function clearSwitchUsageCache(): void {
    claudeUsageCache = null;
    claudeUsageInflight = null;
  }

  function writeSwitchCooldown(): void {
    const symphonyDir = join(homedir(), ".symphony");
    try {
      mkdirSync(symphonyDir, { recursive: true });
      writeFileSync(
        join(symphonyDir, "auto-switch-last"),
        new Date().toISOString(),
        "utf8",
      );
    } catch {
      // Best-effort: don't fail the switch if we can't write cooldown
    }
  }

  return async (request, response) => {
    try {
      const url = new URL(request.url ?? "/", `http://${hostname}`);
      const method = request.method ?? "GET";

      // CORS headers on all responses
      response.setHeader("access-control-allow-origin", "*");
      response.setHeader("access-control-allow-methods", "GET, POST, OPTIONS");
      response.setHeader(
        "access-control-allow-headers",
        "Content-Type, Authorization, X-Symphony-Anchor-Secret",
      );

      // Handle CORS preflight
      if (method === "OPTIONS") {
        response.statusCode = 204;
        response.end();
        return;
      }

      if (url.pathname === "/") {
        if (method !== "GET") {
          writeMethodNotAllowed(response, ["GET"]);
          return;
        }

        const snapshot = await readSnapshot(options.host, snapshotTimeoutMs);
        writeHtml(response, 200, renderDashboardHtml(snapshot, renderOptions));
        return;
      }

      if (url.pathname === "/api/v1/state") {
        if (method !== "GET") {
          writeMethodNotAllowed(response, ["GET"]);
          return;
        }

        const snapshot = await readSnapshot(options.host, snapshotTimeoutMs);
        writeJson(response, 200, snapshot);
        return;
      }

      if (url.pathname === "/api/v1/state/delta") {
        if (method !== "GET") {
          writeMethodNotAllowed(response, ["GET"]);
          return;
        }

        if (options.host.getStateDelta === undefined) {
          writeJsonError(response, 501, "not_implemented", {
            message: "State deltas are not supported by this host.",
          });
          return;
        }

        const sinceSeqRaw = url.searchParams.get("since_seq");
        const sinceSeq =
          sinceSeqRaw === null ? Number.NaN : Number(sinceSeqRaw);
        if (!Number.isInteger(sinceSeq) || sinceSeq < 0) {
          writeJsonError(response, 400, "invalid_request", {
            message:
              "since_seq is required and must be a non-negative integer.",
          });
          return;
        }

        const limitRaw = url.searchParams.get("limit");
        let limit = STATE_DELTA_DEFAULT_LIMIT;
        if (limitRaw !== null) {
          const parsedLimit = Number(limitRaw);
          if (!Number.isInteger(parsedLimit) || parsedLimit < 1) {
            writeJsonError(response, 400, "invalid_request", {
              message: "limit must be a positive integer.",
            });
            return;
          }
          limit = Math.min(parsedLimit, STATE_DELTA_MAX_LIMIT);
        }

        const delta = await options.host.getStateDelta({ sinceSeq, limit });
        writeJson(response, 200, delta);
        return;
      }

      if (url.pathname === "/api/v1/events") {
        if (method !== "GET") {
          writeMethodNotAllowed(response, ["GET"]);
          return;
        }

        if (renderOptions.liveUpdatesEnabled !== true) {
          writeNotFound(response, url.pathname);
          return;
        }

        if (options.liveController === undefined) {
          writeJsonError(response, 503, ERROR_CODES.snapshotUnavailable, {
            message: "Live dashboard updates are unavailable.",
          });
          return;
        }

        await options.liveController.handleEventsRequest(request, response);
        return;
      }

      if (url.pathname === "/api/v1/refresh") {
        if (method !== "POST") {
          writeMethodNotAllowed(response, ["POST"]);
          return;
        }

        if (requireOperatorAuth(request, response, operatorAuth) === null) {
          return;
        }

        await readRequestBody(request);
        const refresh = await options.host.requestRefresh();
        writeJson(response, 202, refresh);
        return;
      }

      if (url.pathname === "/api/v1/claude/switch") {
        if (method !== "POST") {
          writeMethodNotAllowed(response, ["POST"]);
          return;
        }

        if (requireOperatorAuth(request, response, operatorAuth) === null) {
          return;
        }

        await readRequestBody(request);

        // Check for running agents before switching
        const snapshot = await readSnapshot(options.host, snapshotTimeoutMs);
        const runningCount = snapshot.counts.running;
        if (runningCount > 0) {
          writeJsonError(response, 409, ERROR_CODES.switchRefusedRunning, {
            message: `Cannot switch accounts while ${runningCount} agent${runningCount === 1 ? " is" : "s are"} running.`,
          });
          return;
        }

        // Execute cswap --switch
        try {
          await execCommand("cswap", ["--switch"]);
        } catch (error) {
          writeJsonError(response, 500, ERROR_CODES.switchFailed, {
            message: `Account switch failed: ${toErrorMessage(error)}`,
          });
          return;
        }

        // Clear usage cache so next usage fetch is fresh
        clearSwitchUsageCache();

        // Write cooldown timestamp for auto-switch
        writeSwitchCooldown();

        // Fetch fresh account info
        let usageData: unknown;
        try {
          const { stdout } = await execCommand("ops/claude-usage", ["--json"]);
          usageData = JSON.parse(stdout);
        } catch (error) {
          // Switch succeeded but usage fetch failed — return success with warning
          writeJson(response, 200, {
            switched: true,
            usage: null,
            warning: `Switch succeeded but usage fetch failed: ${toErrorMessage(error)}`,
          });
          return;
        }

        // Log switch event for audit trail
        console.log(
          `[claude-switch] Account switched at ${new Date().toISOString()}`,
        );

        writeJson(response, 200, {
          switched: true,
          usage: usageData,
        });
        return;
      }

      if (url.pathname === "/api/v1/claude/usage") {
        if (method !== "GET") {
          writeMethodNotAllowed(response, ["GET"]);
          return;
        }

        if (
          claudeUsageCache !== null &&
          Date.now() < claudeUsageCache.expiresAt
        ) {
          writeJson(response, 200, {
            ...claudeUsageCache.data,
            cached: true,
          });
          return;
        }

        try {
          // Single-flight: reuse an in-progress CLI call instead of spawning N concurrent processes
          if (claudeUsageInflight === null) {
            claudeUsageInflight = fetchClaudeUsageFromCli().finally(() => {
              claudeUsageInflight = null;
            });
          }
          const parsed = await claudeUsageInflight;
          claudeUsageCache = {
            data: parsed,
            expiresAt: Date.now() + CLAUDE_USAGE_CACHE_TTL_MS,
          };
          writeJson(response, 200, { ...parsed, cached: false });
        } catch (err) {
          writeJson(response, 200, {
            available: false,
            error:
              err instanceof Error
                ? err.message
                : "Unknown error running ops/claude-usage",
          });
        }
        return;
      }

      if (url.pathname === "/api/v1/deploy/preview") {
        if (method !== "POST") {
          writeMethodNotAllowed(response, ["POST"]);
          return;
        }

        if (requireOperatorAuth(request, response, operatorAuth) === null) {
          return;
        }

        await readRequestBody(request);

        try {
          const snapshot = await readSnapshot(options.host, snapshotTimeoutMs);
          const runningCount = snapshot.counts.running;

          const stdout = await execDeploy(["--dry-run"]);
          const preview = parseDeployDryRunOutput(stdout, runningCount);
          writeJson(response, 200, preview);
        } catch (error) {
          writeJsonError(response, 500, ERROR_CODES.deployFailed, {
            message:
              error instanceof Error ? error.message : "Deploy preview failed.",
          });
        }
        return;
      }

      if (url.pathname === "/api/v1/deploy") {
        if (method !== "POST") {
          writeMethodNotAllowed(response, ["POST"]);
          return;
        }

        if (requireOperatorAuth(request, response, operatorAuth) === null) {
          return;
        }

        await readRequestBody(request);

        response.statusCode = 200;
        response.setHeader("content-type", "text/event-stream");
        response.setHeader("cache-control", "no-cache");
        response.setHeader("connection", "keep-alive");
        response.flushHeaders();

        try {
          await streamDeploy(response, spawnDeployFn);
        } catch (error) {
          const message =
            error instanceof Error ? error.message : "Deploy failed.";
          writeSseEvent(response, "deploy_complete", {
            success: false,
            message,
          });
          response.end();
        }
        return;
      }

      if (url.pathname === "/api/v1/github/queue") {
        if (method !== "GET") {
          writeMethodNotAllowed(response, ["GET"]);
          return;
        }

        if (githubRepoSlug === null) {
          writeJsonError(response, 500, ERROR_CODES.githubCliFailed, {
            message:
              "GitHub repo slug is not configured. Set githubRepoSlug in options or REPO_URL environment variable.",
          });
          return;
        }

        // Return cached response if still valid
        if (
          githubQueueCache !== null &&
          Date.now() < githubQueueCache.expiresAt
        ) {
          writeJson(response, 200, { ...githubQueueCache.data, cached: true });
          return;
        }

        try {
          const data = await fetchGitHubQueue(githubRepoSlug, execGh);
          githubQueueCache = {
            data,
            expiresAt: Date.now() + GITHUB_QUEUE_CACHE_TTL_MS,
          };
          writeJson(response, 200, data);
        } catch (error) {
          writeJsonError(response, 502, ERROR_CODES.githubCliFailed, {
            message:
              error instanceof Error
                ? error.message
                : "GitHub CLI command failed.",
          });
        }
        return;
      }

      if (url.pathname === "/api/v1/operator/whoami") {
        if (method !== "GET") {
          writeMethodNotAllowed(response, ["GET"]);
          return;
        }

        const operatorActor = requireOperatorAuth(
          request,
          response,
          operatorAuth,
        );
        if (operatorActor === null) {
          return;
        }

        writeJson(response, 200, { status: "ok", actor: operatorActor });
        return;
      }

      if (url.pathname === "/api/v1/intents") {
        if (method !== "POST") {
          writeMethodNotAllowed(response, ["POST"]);
          return;
        }

        const operatorActor = requireOperatorAuth(
          request,
          response,
          operatorAuth,
        );
        if (operatorActor === null) {
          return;
        }

        if (options.host.requestIntent === undefined) {
          writeJsonError(response, 501, "not_implemented", {
            message: "Intent verbs are not supported by this host.",
          });
          return;
        }

        if (!hasJsonContentType(request)) {
          writeUnsupportedMediaType(response);
          return;
        }

        const rawBody = await readRequestBodyText(request);
        let parsedBody: unknown;
        try {
          parsedBody = parseJsonBody(rawBody);
        } catch {
          writeJsonError(response, 400, "invalid_request", {
            message: "Request body is not valid JSON.",
          });
          return;
        }

        const parsed = intentRequestSchema.safeParse(parsedBody);
        if (!parsed.success) {
          writeJsonError(response, 400, "invalid_request", {
            message: parsed.error.issues
              .map((issue) =>
                issue.path.length > 0
                  ? `${issue.path.join(".")}: ${issue.message}`
                  : issue.message,
              )
              .join("; "),
          });
          return;
        }

        const result = await options.host.requestIntent(
          toIntentRequest(parsed.data, operatorActor),
        );
        const statusCode =
          result.status === "issue_not_found"
            ? 404
            : result.status === "invalid_request"
              ? 400
              : result.status === "rejected_stale"
                ? 409
                : 200;
        writeJson(response, statusCode, result);
        return;
      }

      if (url.pathname === "/api/v1/anchor-field-edits") {
        if (method !== "POST") {
          writeMethodNotAllowed(response, ["POST"]);
          return;
        }

        if (
          !isAuthorizedAnchorFieldEditRequest(
            request,
            options.anchorFieldEditSecret ?? null,
          )
        ) {
          writeJsonError(response, 403, "forbidden", {
            message:
              "Anchor field-edit ingestion requires the configured ingress secret.",
          });
          return;
        }

        if (options.host.requestAnchorFieldEdit === undefined) {
          writeJsonError(response, 501, "not_implemented", {
            message:
              "Anchor field-edit ingestion is not supported by this host.",
          });
          return;
        }

        if (!hasJsonContentType(request)) {
          writeUnsupportedMediaType(response);
          return;
        }

        const rawBody = await readRequestBodyText(request);
        let parsedBody: unknown;
        try {
          parsedBody = parseJsonBody(rawBody);
        } catch {
          writeJsonError(response, 400, "invalid_request", {
            message: "Request body is not valid JSON.",
          });
          return;
        }

        const parsed = anchorFieldEditRequestSchema.safeParse(parsedBody);
        if (!parsed.success) {
          writeJsonError(response, 400, "invalid_request", {
            message: parsed.error.issues
              .map((issue) =>
                issue.path.length > 0
                  ? `${issue.path.join(".")}: ${issue.message}`
                  : issue.message,
              )
              .join("; "),
          });
          return;
        }

        const result = await options.host.requestAnchorFieldEdit(
          toAnchorFieldEditRequest(parsed.data),
        );
        const statusCode =
          result.status === "issue_not_found"
            ? 404
            : result.status === "invalid_request" || result.status === "invalid"
              ? 400
              : result.status === "rejected_stale"
                ? 409
                : 200;
        writeJson(response, statusCode, result);
        return;
      }

      if (
        url.pathname === "/api/v1/pipeline/pause" ||
        url.pathname === "/api/v1/pipeline/resume" ||
        url.pathname === "/api/v1/pipeline/stop"
      ) {
        const action = url.pathname.endsWith("/pause")
          ? "pause"
          : url.pathname.endsWith("/resume")
            ? "resume"
            : "stop";
        if (method !== "POST") {
          writeMethodNotAllowed(response, ["POST"]);
          return;
        }

        const operatorActor = requireOperatorAuth(
          request,
          response,
          operatorAuth,
        );
        if (operatorActor === null) {
          return;
        }

        const handler =
          action === "pause"
            ? options.host.requestPipelinePause?.bind(options.host)
            : action === "resume"
              ? options.host.requestPipelineResume?.bind(options.host)
              : options.host.requestEmergencyStop?.bind(options.host);
        if (handler === undefined) {
          writeJsonError(response, 501, "not_implemented", {
            message: `Pipeline ${action} is not supported by this host.`,
          });
          return;
        }

        if (!hasJsonContentType(request)) {
          writeUnsupportedMediaType(response);
          return;
        }

        const rawBody = await readRequestBodyText(request);
        let parsedBody: unknown;
        try {
          parsedBody = parseJsonBody(rawBody);
        } catch {
          writeJsonError(response, 400, "invalid_request", {
            message: "Request body is not valid JSON.",
          });
          return;
        }

        const parsed = pipelineControlBodySchema.safeParse(parsedBody);
        if (!parsed.success) {
          writeJsonError(response, 400, "invalid_request", {
            message: parsed.error.issues
              .map((issue) => `${issue.path.join(".")}: ${issue.message}`)
              .join("; "),
          });
          return;
        }

        const result = await handler({
          actor: operatorActor,
          reason:
            parsed.data.reason ??
            (action === "stop"
              ? "emergency stop requested via dashboard"
              : `pipeline ${action} requested via dashboard`),
        });
        writeJson(response, 200, result);
        return;
      }

      if (url.pathname === "/api/v1/pipeline/status") {
        if (method !== "GET") {
          writeMethodNotAllowed(response, ["GET"]);
          return;
        }

        if (options.host.getPipelineStatus === undefined) {
          writeJsonError(response, 501, "not_implemented", {
            message: "Pipeline status is not supported by this host.",
          });
          return;
        }

        const result = await options.host.getPipelineStatus();
        writeJson(response, 200, result);
        return;
      }

      if (url.pathname.startsWith("/api/v1/")) {
        const rest = url.pathname.slice("/api/v1/".length);
        const issueRest = rest.startsWith("issues/")
          ? rest.slice("issues/".length)
          : rest;
        const stopMatch = issueRest.match(/^(.+)\/stop$/);

        if (stopMatch !== null) {
          if (method !== "POST") {
            writeMethodNotAllowed(response, ["POST"]);
            return;
          }

          if (requireOperatorAuth(request, response, operatorAuth) === null) {
            return;
          }

          const issueIdentifier = decodeURIComponent(stopMatch[1] ?? "");

          if (options.host.requestIssueStop === undefined) {
            writeJsonError(response, 501, "not_implemented", {
              message: "Stop issue is not supported by this host.",
            });
            return;
          }

          await readRequestBody(request);
          const result = await options.host.requestIssueStop(issueIdentifier);
          writeJson(response, result.stopped ? 200 : 404, result);
          return;
        }

        if (method !== "GET") {
          writeMethodNotAllowed(response, ["GET"]);
          return;
        }

        const issueIdentifier = decodeURIComponent(issueRest);
        const issue = await options.host.getIssueDetails(issueIdentifier);
        if (issue === null) {
          writeJsonError(response, 404, ERROR_CODES.issueNotFound, {
            message: `Issue '${issueIdentifier}' is not tracked in the current runtime state.`,
          });
          return;
        }

        writeJson(response, 200, issue);
        return;
      }

      writeNotFound(response, url.pathname);
    } catch (error) {
      if (error instanceof PayloadTooLargeError) {
        // Belt-and-braces: drop the connection so a slow uploader's socket
        // cannot linger on keep-alive after we abandoned its body mid-read.
        response.setHeader("connection", "close");
        writeJsonError(response, 413, "payload_too_large", {
          message: toErrorMessage(error),
        });
        return;
      }

      if (isSnapshotTimeoutError(error)) {
        writeJsonError(response, 504, ERROR_CODES.snapshotTimedOut, {
          message: toErrorMessage(error),
        });
        return;
      }

      writeJsonError(response, 500, ERROR_CODES.snapshotUnavailable, {
        message: toErrorMessage(error),
      });
    }
  };
}

/** Clear the cached claude usage data. Called after account switches. */
// TODO(SYMPH-219): Wire this into account-switch handlers
export function clearClaudeUsageCache(): void {
  claudeUsageCache = null;
  claudeUsageInflight = null;
}

// ── GitHub merge queue types & helpers ────────────────────────────

export interface GitHubQueuePR {
  number: number;
  title: string;
  url: string;
  author: string;
  state: string;
  mergedAt: string | null;
  labels: string[];
}

export interface GitHubQueueAlert {
  number: number;
  title: string;
  url: string;
  createdAt: string;
}

export interface GitHubQueueResponse {
  repo: string;
  cached: boolean;
  fetched_at: string;
  in_queue: GitHubQueuePR[];
  recently_merged: GitHubQueuePR[];
  rejected: GitHubQueuePR[];
  alerts: GitHubQueueAlert[];
}

interface GitHubQueueCache {
  data: GitHubQueueResponse;
  expiresAt: number;
}

function resolveRepoSlug(explicit?: string): string | null {
  if (explicit !== undefined && explicit !== "") {
    return explicit;
  }
  const repoUrl = process.env.REPO_URL;
  if (repoUrl === undefined || repoUrl === "") {
    return null;
  }
  // Extract owner/repo from https://github.com/owner/repo(.git)
  return repoUrl.replace(/^https?:\/\/github\.com\//, "").replace(/\.git$/, "");
}

interface GhPrJsonItem {
  number: number;
  title: string;
  url: string;
  author: { login: string };
  state: string;
  mergedAt: string | null;
  labels: Array<{ name: string }>;
}

interface GhIssueJsonItem {
  number: number;
  title: string;
  url: string;
  createdAt: string;
}

function categorizePRs(prs: GhPrJsonItem[]): {
  in_queue: GitHubQueuePR[];
  recently_merged: GitHubQueuePR[];
  rejected: GitHubQueuePR[];
} {
  const in_queue: GitHubQueuePR[] = [];
  const recently_merged: GitHubQueuePR[] = [];
  const rejected: GitHubQueuePR[] = [];

  for (const pr of prs) {
    const mapped: GitHubQueuePR = {
      number: pr.number,
      title: pr.title,
      url: pr.url,
      author: pr.author.login,
      state: pr.state,
      mergedAt: pr.mergedAt,
      labels: pr.labels.map((l) => l.name),
    };

    if (pr.state === "MERGED") {
      recently_merged.push(mapped);
    } else if (pr.state === "CLOSED") {
      rejected.push(mapped);
    } else {
      // OPEN PRs are considered in the queue
      in_queue.push(mapped);
    }
  }

  return { in_queue, recently_merged, rejected };
}

function defaultExecGh(args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFileCb(
      "gh",
      args,
      { encoding: "utf-8", maxBuffer: 2 * 1024 * 1024, timeout: 15_000 },
      (error, stdout) => {
        if (error) {
          reject(error);
          return;
        }
        resolve(stdout);
      },
    );
  });
}

async function fetchGitHubQueue(
  repoSlug: string,
  execGh: ExecGh,
): Promise<GitHubQueueResponse> {
  const prFields = "number,title,url,author,state,mergedAt,labels";

  const prStdout = await execGh([
    "pr",
    "list",
    "--repo",
    repoSlug,
    "--json",
    prFields,
    "--limit",
    "50",
    "--state",
    "all",
  ]);

  const prs = JSON.parse(prStdout) as GhPrJsonItem[];
  const { in_queue, recently_merged, rejected } = categorizePRs(prs);

  let alerts: GitHubQueueAlert[] = [];
  try {
    const issueStdout = await execGh([
      "issue",
      "list",
      "--repo",
      repoSlug,
      "--json",
      "number,title,url,createdAt",
      "--label",
      "pipeline-halt",
      "--limit",
      "20",
    ]);
    const issues = JSON.parse(issueStdout) as GhIssueJsonItem[];
    alerts = issues.map((issue) => ({
      number: issue.number,
      title: issue.title,
      url: issue.url,
      createdAt: issue.createdAt,
    }));
  } catch {
    // Issues may be disabled on the repo — return PR data with empty alerts
  }

  return {
    repo: repoSlug,
    cached: false,
    fetched_at: new Date().toISOString(),
    in_queue,
    recently_merged,
    rejected,
    alerts,
  };
}

// ── Deploy types & helpers ────────────────────────────────────────

export function resolveDeployScriptPath(): string {
  const thisFile = fileURLToPath(import.meta.url);
  // dist/src/observability/dashboard-server.js -> repo root (3 levels up) -> ops/symphony-deploy
  const repoRoot = pathResolve(dirname(thisFile), "..", "..", "..");
  return pathResolve(repoRoot, "ops", "symphony-deploy");
}

function defaultExecDeploy(args: string[]): Promise<string> {
  const scriptPath = resolveDeployScriptPath();
  return new Promise((resolve, reject) => {
    execFileCb(
      scriptPath,
      args,
      { encoding: "utf-8", maxBuffer: 2 * 1024 * 1024, timeout: 120_000 },
      (error, stdout) => {
        if (error) {
          reject(error);
          return;
        }
        resolve(stdout);
      },
    );
  });
}

function defaultSpawnDeploy(args: string[]): ChildProcess {
  const scriptPath = resolveDeployScriptPath();
  return spawn(scriptPath, args, { stdio: ["ignore", "pipe", "pipe"] });
}

function parseDeployDryRunOutput(
  stdout: string,
  runningIssuesCount: number,
): DeployPreviewResponse {
  const lines = stdout.split("\n");

  let currentVersion = "(unknown)";
  let targetVersion = "(unknown)";
  let commitsAhead = 0;
  const actions: string[] = [];

  for (const line of lines) {
    // Strip ANSI escape codes for parsing
    // biome-ignore lint/suspicious/noControlCharactersInRegex: ESC char needed to strip ANSI codes
    const clean = line.replace(/\u001b\[[0-9;]*m/g, "").trim();

    // Match "Pre-deploy version: <version>"
    const preVersionMatch = clean.match(/Pre-deploy version:\s*(.+)/);
    if (preVersionMatch?.[1] !== undefined) {
      currentVersion = preVersionMatch[1].trim();
    }

    // Match "Post-deploy version: <version>"
    const postVersionMatch = clean.match(/Post-deploy version:\s*(.+)/);
    if (postVersionMatch?.[1] !== undefined) {
      targetVersion = postVersionMatch[1].trim();
    }

    // Match "symphony-ts: <pre_sha> → <post_sha>" from summary
    const shaMatch = clean.match(
      /symphony-ts:\s+([a-f0-9]+)\s+→\s+([a-f0-9]+)/,
    );
    if (shaMatch?.[1] !== undefined && shaMatch[2] !== undefined) {
      if (shaMatch[1] !== shaMatch[2]) {
        // Count commits between SHAs — dry-run doesn't give exact count,
        // but we mark at least 1 if SHAs differ
        commitsAhead = 1;
      }
    }

    // Collect [dry-run] action lines
    const dryRunMatch = clean.match(/\[dry-run\]\s+(.+)/);
    if (dryRunMatch?.[1] !== undefined) {
      actions.push(dryRunMatch[1].trim());
    }
  }

  return {
    current_version: currentVersion,
    target_version: targetVersion,
    commits_ahead: commitsAhead,
    actions,
    running_issues_count: runningIssuesCount,
  };
}

function writeSseEvent(
  response: ServerResponse,
  event: string,
  data: unknown,
): void {
  response.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}

async function streamDeploy(
  response: ServerResponse,
  spawnDeployFn: SpawnDeploy,
): Promise<void> {
  return await new Promise<void>((resolve, reject) => {
    const child = spawnDeployFn([]);
    let buffer = "";
    let errBuffer = "";

    const flushLine = (line: string) => {
      writeSseEvent(response, "deploy_output", { line });
    };

    child.stdout?.setEncoding("utf-8");
    child.stdout?.on("data", (chunk: string) => {
      buffer += chunk;
      const parts = buffer.split("\n");
      // Keep the last partial line in the buffer
      buffer = parts.pop() ?? "";
      for (const part of parts) {
        flushLine(part);
      }
    });

    child.stderr?.setEncoding("utf-8");
    child.stderr?.on("data", (chunk: string) => {
      errBuffer += chunk;
    });

    child.on("error", (error) => {
      reject(error);
    });

    child.on("close", (code) => {
      // Flush any remaining buffer
      if (buffer.length > 0) {
        flushLine(buffer);
        buffer = "";
      }

      const success = code === 0;
      writeSseEvent(response, "deploy_complete", {
        success,
        exit_code: code,
        message: success
          ? "Deploy completed successfully."
          : `Deploy failed with exit code ${code}.${errBuffer.length > 0 ? ` stderr: ${errBuffer.trim()}` : ""}`,
      });
      response.end();
      resolve();
    });
  });
}

function writeJsonError(
  response: ServerResponse,
  statusCode: number,
  code: string,
  input: {
    message: string;
    allow?: string[];
  },
): void {
  if (input.allow !== undefined) {
    response.setHeader("allow", input.allow.join(", "));
  }

  writeJson(response, statusCode, {
    error: {
      code,
      message: input.message,
    },
  });
}

function writeMethodNotAllowed(
  response: ServerResponse,
  allow: string[],
): void {
  writeJsonError(response, 405, "method_not_allowed", {
    message: "Method not allowed.",
    allow,
  });
}
