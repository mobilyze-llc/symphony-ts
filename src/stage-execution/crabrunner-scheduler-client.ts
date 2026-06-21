import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";
import { promisify } from "node:util";

import { z } from "zod";

import type {
  CrabrunnerAdmissionResult,
  CrabrunnerCancellationRequest,
  CrabrunnerJobSpec,
  CrabrunnerSchedulerClient,
  CrabrunnerTerminalEvidence,
  CrabrunnerTerminalState,
  CrabrunnerUsage,
} from "./crabrunner-backend.js";

const execFileAsync = promisify(execFile);

/**
 * Injectable subprocess executor for `bin/crabrunner`. Tests inject a fake so no
 * real process is ever spawned; production uses {@link execFileCrabrunnerCli}.
 *
 * Implementations MUST return the captured stdout/stderr and the process exit
 * code (never throw on a non-zero exit) so the client can fail closed itself.
 */
export type CrabrunnerCli = (
  args: readonly string[],
  opts: { cwd: string; signal?: AbortSignal; timeoutMs?: number },
) => Promise<{ stdout: string; stderr: string; exitCode: number }>;

/** Recorded invocation shape, exported so tests can assert on argv/cwd. */
export interface CrabrunnerCliInvocation {
  args: readonly string[];
  opts: { cwd: string; signal?: AbortSignal; timeoutMs?: number };
}

export interface CrabrunnerCliSchedulerClientOptions {
  /**
   * Crucible repo root. `bin/crabrunner` runs with cwd set here (MOB-193) and it
   * is also the `--repo-root` value and manifest `remote_repo` (Codex P1-1).
   */
  crucibleRoot: string;
  /** Target repo the lane operates on; written to manifest `workspace`. */
  targetRepoRoot: string;
  /**
   * Crabrunner state root. Passed via `--state-root` to every call when set, and
   * used to resolve job-relative artifact/usage paths under
   * `<stateRoot>/jobs/<jobId>/`. Defaults to `~/.crucible/crabrunner`.
   */
  stateRoot?: string;
  /** Host label written into the manifest (default "local"). */
  host?: string;
  /**
   * Manifest `provider`. Defaults to "local" when host==="local", else "ssh".
   * Override for explicit transport selection.
   */
  provider?: string;
  now?: () => Date;
  /** Injected subprocess executor (tests). Defaults to a real execFile impl. */
  cli?: CrabrunnerCli;
  /** Status poll interval in ms (default 1000). */
  pollIntervalMs?: number;
  /** Maximum number of status polls before failing closed (default 1800). */
  maxPolls?: number;
  /** When true, pass `--no-stage` to submit. */
  noStage?: boolean;
  /** Subprocess timeout in ms for individual CLI calls (default 120000). */
  cliTimeoutMs?: number;
  /** execFile maxBuffer in bytes (default 16 MiB). */
  maxBufferBytes?: number;
}

const DEFAULT_POLL_INTERVAL_MS = 1_000;
const DEFAULT_MAX_POLLS = 1_800;
const DEFAULT_CLI_TIMEOUT_MS = 120_000;
const DEFAULT_MAX_BUFFER_BYTES = 16 * 1_024 * 1_024;
// Grace window for the terminal-state/collectible write race: a terminal
// lifecycle state with collectible!==true is tolerated for this many extra
// polls before failing closed (DeepSeek P2-1).
const STATUS_TERMINAL_GRACE_POLLS = 3;

function defaultStateRoot(): string {
  return join(homedir(), ".crucible", "crabrunner");
}

const CRABRUNNER_MANIFEST_SCHEMA = "crucible.crabrunner.job.v1";
const CRABRUNNER_STATUS_SCHEMA = "crucible.crabrunner.status.v1";
const CRABRUNNER_COLLECT_SCHEMA = "crucible.crabrunner.collect.v1";
// Job-kind-dependent lane-worker protocol selector. A prompt_file+model manifest
// uses "lane-worker.v1"; a worker_argv manifest uses "worker-argv.v1". This
// client emits a prompt_file/model lane (the worker_argv path is not sourced
// from the spec yet — see TODO(SYMPH-853-followup)).
const LANE_WORKER_PROTOCOL = "lane-worker.v1";
const WORKER_ARGV_PROTOCOL = "worker-argv.v1";
const LANE_WORKER_USAGE_SCHEMA = "crucible.lane-worker.usage.v2";

/** Crabrunner lifecycle states (mirrors crucible/crabrunner/src). */
const CRABRUNNER_TERMINAL_LIFECYCLE_STATES = new Set([
  "complete",
  "failed",
  "timed_out",
  "stopped",
  "lost",
]);

/** Admitted submit states the scheduler accepts (terminal complete included). */
const CRABRUNNER_ADMITTED_STATES = new Set([
  "accepted",
  "queued",
  "starting",
  "running",
  "complete",
]);

const crabrunnerStatusSchema = z
  .object({
    schema: z.string(),
    job_id: z.string(),
    state: z.string(),
    message: z.string().nullish(),
    host: z.string().nullish(),
    worker_pid: z.number().nullish(),
    worker_pgid: z.number().nullish(),
    started_at: z.string().nullish(),
    updated_at: z.string().nullish(),
    artifact_path: z.string().nullish(),
    usage_path: z.string().nullish(),
    collect_archive: z.string().nullish(),
    workspace: z.string().nullish(),
    collectible: z.boolean().nullish(),
    error_code: z.string().nullish(),
    heartbeat_seq: z.number().nullish(),
  })
  .passthrough();

type CrabrunnerStatus = z.infer<typeof crabrunnerStatusSchema>;

const crabrunnerCollectSchema = z
  .object({
    schema: z.string(),
    job_id: z.string(),
    state: z.string(),
    status: crabrunnerStatusSchema,
    archive_path: z.string().nullish(),
  })
  .passthrough();

// Two on-disk usage shapes both map here. The real model shape is the
// `crucible.lane-worker.usage.v2` contract keyed by `measurement_kind` with
// snake_case token fields. The simple/smoke shape is `{available:boolean,
// reason?, inputTokens?, outputTokens?, totalTokens?}` (camelCase) used by
// non-model smoke jobs. Both must map and must never produce a zero-token
// "available". passthrough() keeps unknown diagnostic fields (e.g. char_count)
// out of the way.
const laneWorkerUsageSchema = z
  .object({
    schema: z.string().nullish(),
    measurement_kind: z.string().nullish(),
    available: z.boolean().nullish(),
    reason: z.string().nullish(),
    // v2 snake_case token fields
    input_tokens: z.number().nullish(),
    output_tokens: z.number().nullish(),
    total_tokens: z.number().nullish(),
    cache_read_tokens: z.number().nullish(),
    cache_write_tokens: z.number().nullish(),
    no_cache_tokens: z.number().nullish(),
    reasoning_tokens: z.number().nullish(),
    // simple/smoke camelCase token fields
    inputTokens: z.number().nullish(),
    outputTokens: z.number().nullish(),
    totalTokens: z.number().nullish(),
    cacheReadTokens: z.number().nullish(),
    cacheWriteTokens: z.number().nullish(),
    noCacheTokens: z.number().nullish(),
    reasoningTokens: z.number().nullish(),
  })
  .passthrough();

/** Measurement kinds that carry real (summable) token counts. */
const SUMMABLE_MEASUREMENT_KINDS = new Set(["true", "estimated", "partial"]);

export class CrabrunnerCliSchedulerClient implements CrabrunnerSchedulerClient {
  private readonly crucibleRoot: string;
  private readonly targetRepoRoot: string;
  private readonly stateRoot: string;
  private readonly host: string;
  private readonly provider: string;
  private readonly now: () => Date;
  private readonly cli: CrabrunnerCli;
  private readonly pollIntervalMs: number;
  private readonly maxPolls: number;
  private readonly noStage: boolean;
  private readonly cliTimeoutMs: number;
  private readonly maxBufferBytes: number;

  constructor(options: CrabrunnerCliSchedulerClientOptions) {
    this.crucibleRoot = options.crucibleRoot;
    this.targetRepoRoot = options.targetRepoRoot;
    this.stateRoot = options.stateRoot ?? defaultStateRoot();
    this.host = options.host ?? "local";
    this.provider =
      options.provider ?? (this.host === "local" ? "local" : "ssh");
    this.now = options.now ?? (() => new Date());
    this.maxBufferBytes = options.maxBufferBytes ?? DEFAULT_MAX_BUFFER_BYTES;
    this.cliTimeoutMs = options.cliTimeoutMs ?? DEFAULT_CLI_TIMEOUT_MS;
    this.cli =
      options.cli ??
      execFileCrabrunnerCli({
        crucibleRoot: options.crucibleRoot,
        maxBufferBytes: this.maxBufferBytes,
      });
    this.pollIntervalMs = options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
    this.maxPolls = options.maxPolls ?? DEFAULT_MAX_POLLS;
    this.noStage = options.noStage ?? false;
  }

  async submit(spec: CrabrunnerJobSpec): Promise<CrabrunnerAdmissionResult> {
    // Fail closed rather than emit an unrunnable manifest (Codex P1-2 /
    // SYMPH-856): the lane worker needs a prompt_file (or worker_argv, not
    // sourced yet). A manifest with neither always-fails the job lane-side.
    // SYMPH-856: dispatch now renders the stage prompt into spec.promptFile via
    // the backend factory's default resolver; this guard stays as the
    // fail-closed backstop for any path that does not (e.g. no promptRendering
    // config wired, or a genuinely absent template).
    if (spec.promptFile === undefined || spec.promptFile.trim().length === 0) {
      return {
        status: "rejected",
        jobId: null,
        reason: "crabrunner_prompt_required_symph_856",
      };
    }

    const manifest = this.buildManifest(spec);
    const dir = await mkdtemp(join(tmpdir(), "crabrunner-manifest-"));
    const manifestPath = join(dir, "manifest.json");
    try {
      await writeFile(manifestPath, JSON.stringify(manifest), "utf8");
      const result = await this.run([
        "submit",
        "--manifest-file",
        manifestPath,
        // --repo-root is the CRUCIBLE checkout: crabrunner/src/cli.ts and
        // lane_workers/run.ts load from there (confirmed against a real smoke
        // manifest). The TARGET repo is the manifest `workspace` (Codex P1-1).
        "--repo-root",
        this.crucibleRoot,
        ...this.stateRootArgs(),
        ...(this.noStage ? ["--no-stage"] : []),
      ]);
      const status = this.parseStatus(result, "submit");
      if (!CRABRUNNER_ADMITTED_STATES.has(status.state)) {
        return {
          status: "rejected",
          jobId: null,
          reason:
            status.message ?? status.error_code ?? status.state ?? "rejected",
        };
      }
      return { status: "accepted", jobId: status.job_id };
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }

  async status(jobId: string, signal?: AbortSignal): Promise<void> {
    // Count consecutive terminal-but-not-collectible polls. The daemon can
    // write a terminal lifecycle state before flipping `collectible` (write
    // race); grace-retry a few polls before failing closed (DeepSeek P2-1).
    let terminalNotCollectiblePolls = 0;
    for (let attempt = 0; attempt < this.maxPolls; attempt += 1) {
      throwIfAborted(signal);
      const result = await this.run(
        ["status", "--job-id", jobId, ...this.stateRootArgs()],
        signal,
      );
      const status = this.parseStatus(result, "status", jobId);

      if (status.collectible === true) {
        return;
      }

      if (CRABRUNNER_TERMINAL_LIFECYCLE_STATES.has(status.state)) {
        terminalNotCollectiblePolls += 1;
        if (terminalNotCollectiblePolls > STATUS_TERMINAL_GRACE_POLLS) {
          throw new Error(
            `crabrunner job ${jobId} reached terminal state "${status.state}" but is not collectible after ${STATUS_TERMINAL_GRACE_POLLS} grace polls: ${
              status.message ?? status.error_code ?? "no detail"
            }`,
          );
        }
      } else {
        terminalNotCollectiblePolls = 0;
      }

      if (attempt < this.maxPolls - 1) {
        await this.sleep(this.pollIntervalMs, signal);
      }
    }

    throw new Error(
      `crabrunner job ${jobId} did not become collectible within ${this.maxPolls} status polls`,
    );
  }

  async collect(
    jobId: string,
    signal?: AbortSignal,
  ): Promise<CrabrunnerTerminalEvidence> {
    throwIfAborted(signal);
    const result = await this.run(
      ["collect", "--job-id", jobId, ...this.stateRootArgs()],
      signal,
    );
    const collect = this.parseCollect(result, jobId);
    const status = collect.status;

    const lifecycleState = collect.state;
    let terminalState = mapLifecycleToTerminalState(lifecycleState, status);

    // artifact_path / usage_path in CrabrunnerStatus are RELATIVE to the job dir
    // <stateRoot>/jobs/<jobId>/; collect_archive / archive_path are ABSOLUTE.
    const artifactAbsPath = this.resolveJobPath(jobId, status.artifact_path);
    const usageAbsPath = this.resolveJobPath(jobId, status.usage_path);

    const artifactOk = await this.isArtifactPresent(artifactAbsPath);
    if (terminalState === "succeeded" && !artifactOk) {
      terminalState = "artifact_parse_failed";
    }

    const usage = await this.readUsage(usageAbsPath);
    const artifactRefs = collectArtifactRefs(
      artifactAbsPath,
      status.collect_archive ?? collect.archive_path,
    );

    const evidence: CrabrunnerTerminalEvidence = {
      state: terminalState,
      ...(artifactRefs.length > 0 ? { artifactRefs } : {}),
      workspacePath: status.workspace ?? null,
      usage,
      message: status.message ?? null,
      progress: buildProgress(status),
      process: buildProcess(status),
    };
    return evidence;
  }

  async cancel(
    jobId: string,
    request: CrabrunnerCancellationRequest,
  ): Promise<CrabrunnerTerminalEvidence> {
    // The `bin/crabrunner cancel` CLI only accepts --job-id [--state-root]; it
    // does not take --signal/--process-group. request.signal/processGroup are
    // therefore diagnostics-only in the cancellation block for this phase.
    // TODO(SYMPH-853-followup): forward signal/process-group once the CLI supports it.
    const result = await this.run([
      "cancel",
      "--job-id",
      jobId,
      ...this.stateRootArgs(),
    ]);
    const status = this.parseStatus(result, "cancel", jobId);
    // Only a TERMINAL "stopped" counts as killed. "stopping" is non-terminal
    // (still shutting down) and must NOT be reported as canceled, or consumers
    // misread an in-flight job as killed (Codex P2 / DeepSeek P2-6).
    const killed = status.state === "stopped";
    const terminalState: CrabrunnerTerminalState = killed
      ? "canceled"
      : "kill_failed";
    const failure = killed
      ? null
      : status.state === "stopping"
        ? "cancel_incomplete"
        : (status.message ?? "cancel_incomplete");

    return {
      state: terminalState,
      workspacePath: status.workspace ?? null,
      message: status.message ?? null,
      progress: buildProgress(status),
      process: buildProcess(status),
      cancellation: {
        requested: true,
        signal: request.signal,
        processGroup: request.processGroup,
        killed,
        failure,
      },
    };
  }

  private buildManifest(spec: CrabrunnerJobSpec): Record<string, unknown> {
    const jobId = buildJobId(spec);
    const profile = resolveProfile(spec);
    const model = resolveModelSlug(spec);
    const thinking = spec.runner.reasoningEffort ?? "medium";
    // Floor to 1s (TK-1): 0 is NOT "unlimited" — it would be a degenerate
    // instant timeout. In practice this floor is unreachable for required lanes
    // (enforcement validation rejects timeoutMs<=0 before submit).
    const timeoutSeconds = Math.max(
      1,
      Math.ceil((spec.enforcement.timing.timeoutMs ?? 0) / 1_000),
    );
    // submit() guarantees a prompt_file is present, so this is always a
    // lane-worker.v1 prompt-file lane. WORKER_ARGV_PROTOCOL is reserved for a
    // future worker_argv manifest that this client does not yet source.
    const promptFile = spec.promptFile;
    const laneWorkerProtocol =
      promptFile === undefined ? WORKER_ARGV_PROTOCOL : LANE_WORKER_PROTOCOL;

    return {
      schema: CRABRUNNER_MANIFEST_SCHEMA,
      job_id: jobId,
      attempt_id: String(spec.identity.stageAttempt),
      crabrunner_version: "dev",
      created_at: this.now().toISOString(),
      host: this.host,
      // "local" for a local host, "ssh" for an SSH crabbox host.
      provider: this.provider,
      target: "macos",
      // remote_repo is the CRUCIBLE checkout (where the lane worker code loads
      // from); the TARGET repo is `workspace` (Codex P1-1, confirmed against a
      // real smoke manifest).
      remote_repo: this.crucibleRoot,
      // TODO(SYMPH-853-followup): workspace materialization semantics are not
      // sourced from the spec; the first canary points workspace at the target
      // repo root directly.
      workspace: this.targetRepoRoot,
      artifact_name: sanitizeSlug(spec.identity.stageName ?? "stage"),
      phase: spec.phase,
      issue_ids: [spec.issue.identifier],
      // Symphony owns closeout, so the lane does none. TODO(SYMPH-853-followup):
      // revisit lane-side workspace cleanup semantics before rollout.
      closeout_policy: "disabled",
      ...(promptFile === undefined ? {} : { prompt_file: promptFile }),
      ...(model === null ? {} : { model }),
      thinking,
      profile,
      timeout_seconds: timeoutSeconds,
      lane_worker_protocol: laneWorkerProtocol,
      lane_key: jobId,
    };
  }

  private stateRootArgs(): string[] {
    // Always forward --state-root (even the default ~/.crucible/crabrunner) so
    // the CLI and resolveJobPath agree on the job directory (DeepSeek P2-4).
    return ["--state-root", this.stateRoot];
  }

  private async run(
    args: readonly string[],
    signal?: AbortSignal,
  ): Promise<{
    stdout: string;
    stderr: string;
    exitCode: number;
  }> {
    return await this.cli(args, {
      cwd: this.crucibleRoot,
      timeoutMs: this.cliTimeoutMs,
      ...(signal === undefined ? {} : { signal }),
    });
  }

  private parseStatus(
    result: { stdout: string; stderr: string; exitCode: number },
    command: string,
    expectedJobId?: string,
  ): CrabrunnerStatus {
    if (result.exitCode !== 0) {
      throw new Error(
        `crabrunner ${command} exited with code ${result.exitCode}: ${
          result.stderr.trim() || "no stderr"
        }`,
      );
    }
    const parsed = parseJson(result.stdout, command);
    const status = crabrunnerStatusSchema.safeParse(parsed);
    if (!status.success) {
      throw new Error(
        `crabrunner ${command} returned an invalid status payload: ${status.error.message}`,
      );
    }
    if (status.data.schema !== CRABRUNNER_STATUS_SCHEMA) {
      throw new Error(
        `crabrunner ${command} returned unexpected schema "${status.data.schema}" (expected ${CRABRUNNER_STATUS_SCHEMA})`,
      );
    }
    if (status.data.job_id.trim().length === 0) {
      throw new Error(`crabrunner ${command} status is missing a job_id`);
    }
    assertJobIdMatches(command, expectedJobId, status.data.job_id);
    return status.data;
  }

  private parseCollect(
    result: {
      stdout: string;
      stderr: string;
      exitCode: number;
    },
    expectedJobId?: string,
  ): z.infer<typeof crabrunnerCollectSchema> {
    if (result.exitCode !== 0) {
      throw new Error(
        `crabrunner collect exited with code ${result.exitCode}: ${
          result.stderr.trim() || "no stderr"
        }`,
      );
    }
    const parsed = parseJson(result.stdout, "collect");
    const collect = crabrunnerCollectSchema.safeParse(parsed);
    if (!collect.success) {
      throw new Error(
        `crabrunner collect returned an invalid payload: ${collect.error.message}`,
      );
    }
    if (collect.data.schema !== CRABRUNNER_COLLECT_SCHEMA) {
      throw new Error(
        `crabrunner collect returned unexpected schema "${collect.data.schema}" (expected ${CRABRUNNER_COLLECT_SCHEMA})`,
      );
    }
    // Guard both the envelope and the nested status job_id so a stale/misrouted
    // response can never be attributed to the wrong Symphony job (Codex Track).
    assertJobIdMatches("collect", expectedJobId, collect.data.job_id);
    assertJobIdMatches("collect", expectedJobId, collect.data.status.job_id);
    return collect.data;
  }

  /**
   * Resolve a CrabrunnerStatus artifact/usage path. These are RELATIVE to the
   * job dir `<stateRoot>/jobs/<jobId>/`; absolute values are returned as-is.
   */
  private resolveJobPath(
    jobId: string,
    relativeOrAbsolute: string | null | undefined,
  ): string | null {
    if (
      relativeOrAbsolute === null ||
      relativeOrAbsolute === undefined ||
      relativeOrAbsolute.trim().length === 0
    ) {
      return null;
    }
    if (isAbsolute(relativeOrAbsolute)) {
      return relativeOrAbsolute;
    }
    return join(this.stateRoot, "jobs", jobId, relativeOrAbsolute);
  }

  private async isArtifactPresent(
    artifactPath: string | null | undefined,
  ): Promise<boolean> {
    if (artifactPath === null || artifactPath === undefined) {
      return false;
    }
    try {
      const content = await readFile(artifactPath, "utf8");
      return content.trim().length > 0;
    } catch {
      return false;
    }
  }

  private async readUsage(
    usagePath: string | null | undefined,
  ): Promise<CrabrunnerUsage> {
    if (usagePath === null || usagePath === undefined) {
      return { status: "unavailable", reason: "usage artifact path absent" };
    }
    let raw: string;
    try {
      raw = await readFile(usagePath, "utf8");
    } catch {
      return {
        status: "unavailable",
        reason: "usage artifact file missing or unreadable",
      };
    }
    if (raw.trim().length === 0) {
      return { status: "unavailable", reason: "usage artifact file empty" };
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return { status: "unavailable", reason: "usage artifact not valid JSON" };
    }
    const usage = laneWorkerUsageSchema.safeParse(parsed);
    if (!usage.success) {
      return {
        status: "unavailable",
        reason: "usage artifact failed schema validation",
      };
    }
    return mapLaneWorkerUsage(usage.data);
  }

  private async sleep(ms: number, signal?: AbortSignal): Promise<void> {
    if (signal?.aborted === true) {
      throw createAbortError();
    }
    if (ms <= 0) {
      return;
    }
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        if (signal !== undefined) {
          signal.removeEventListener("abort", onAbort);
        }
        resolve();
      }, ms);
      const onAbort = () => {
        clearTimeout(timer);
        reject(createAbortError());
      };
      if (signal !== undefined) {
        signal.addEventListener("abort", onAbort, { once: true });
      }
    });
  }
}

/**
 * Production {@link CrabrunnerCli} that runs `<crucibleRoot>/bin/crabrunner`
 * with cwd pinned to the Crucible root. Captures exit code / stdout / stderr;
 * never throws on a non-zero exit so the client can fail closed itself.
 */
export function execFileCrabrunnerCli(input: {
  crucibleRoot: string;
  maxBufferBytes?: number;
}): CrabrunnerCli {
  const binPath = join(input.crucibleRoot, "bin", "crabrunner");
  const maxBuffer = input.maxBufferBytes ?? DEFAULT_MAX_BUFFER_BYTES;
  return async (args, opts) => {
    try {
      const result = await execFileAsync(binPath, [...args], {
        cwd: opts.cwd,
        maxBuffer,
        ...(opts.timeoutMs === undefined ? {} : { timeout: opts.timeoutMs }),
        ...(opts.signal === undefined ? {} : { signal: opts.signal }),
      });
      return { exitCode: 0, stdout: result.stdout, stderr: result.stderr };
    } catch (error) {
      const err = error as NodeJS.ErrnoException & {
        stdout?: string;
        stderr?: string;
        code?: number | string;
      };
      return {
        exitCode: typeof err.code === "number" ? err.code : 1,
        stdout: typeof err.stdout === "string" ? err.stdout : "",
        stderr:
          typeof err.stderr === "string"
            ? err.stderr
            : (err.message ?? String(error)),
      };
    }
  };
}

function mapLifecycleToTerminalState(
  lifecycleState: string,
  status: CrabrunnerStatus,
): CrabrunnerTerminalState {
  switch (lifecycleState) {
    case "complete":
      return "succeeded";
    case "timed_out":
      return "timed_out";
    case "stopped":
    case "stopping":
      // Intentional divergence from cancel() (TK-2): the COLLECT path treats a
      // stopping/stopped job as "canceled" ("something/someone already stopped
      // it"), whereas cancel() treats non-terminal "stopping" as kill_failed
      // ("our own cancel hasn't finished yet"). Different question, different
      // answer — not a bug.
      return "canceled";
    case "failed":
    case "lost":
      return mapErrorCodeToTerminalState(status.error_code);
    default:
      return "runner_failed";
  }
}

function mapErrorCodeToTerminalState(
  errorCode: string | null | undefined,
): CrabrunnerTerminalState {
  if (errorCode === null || errorCode === undefined) {
    return "runner_failed";
  }
  const normalized = errorCode.toLowerCase();
  if (normalized.includes("budget")) {
    return "budget_exceeded";
  }
  if (normalized.includes("stall")) {
    return "stalled";
  }
  if (normalized.includes("timeout") || normalized.includes("timed_out")) {
    return "timed_out";
  }
  if (normalized.includes("kill")) {
    return "kill_failed";
  }
  return "runner_failed";
}

function mapLaneWorkerUsage(
  usage: z.infer<typeof laneWorkerUsageSchema>,
): CrabrunnerUsage {
  // Simple/smoke shape: explicit { available: boolean, reason? }.
  if (usage.available === false) {
    return {
      status: "unavailable",
      ...(usage.reason === null || usage.reason === undefined
        ? {}
        : { reason: usage.reason }),
    };
  }

  // v2 shape: schema-tagged with a measurement_kind that gates summability.
  if (usage.schema !== undefined && usage.schema !== null) {
    if (usage.schema !== LANE_WORKER_USAGE_SCHEMA) {
      return {
        status: "unavailable",
        reason: `unexpected usage schema "${usage.schema}"`,
      };
    }
    const kind = usage.measurement_kind ?? "unknown";
    if (!SUMMABLE_MEASUREMENT_KINDS.has(kind)) {
      // proxy / unsupported / unavailable / unknown — never sum diagnostics.
      return {
        status: kind === "unknown" ? "unknown" : "unavailable",
        reason: `usage measurement_kind "${kind}" is not a summable token count`,
      };
    }
  } else if (usage.available !== true) {
    // No schema tag and not an explicit available:true smoke payload: only
    // treat as available when a measurement_kind explicitly permits it.
    const kind = usage.measurement_kind;
    if (kind === null || kind === undefined) {
      return {
        status: "unknown",
        reason:
          "usage artifact had no schema, measurement_kind, or availability flag",
      };
    }
    if (!SUMMABLE_MEASUREMENT_KINDS.has(kind)) {
      return {
        status: "unavailable",
        reason: `usage measurement_kind "${kind}" is not a summable token count`,
      };
    }
  }

  // Token fields appear under snake_case (v2) or camelCase (smoke); prefer
  // whichever is present.
  const inputTokens = normalizeToken(usage.input_tokens ?? usage.inputTokens);
  const outputTokens = normalizeToken(
    usage.output_tokens ?? usage.outputTokens,
  );
  const totalTokens =
    normalizeToken(usage.total_tokens ?? usage.totalTokens) ??
    (inputTokens !== null && outputTokens !== null
      ? inputTokens + outputTokens
      : null);

  if (inputTokens === null && outputTokens === null && totalTokens === null) {
    return {
      status: "unavailable",
      reason: "usage artifact carried no numeric token counts",
    };
  }

  return {
    status: "available",
    inputTokens: inputTokens ?? 0,
    outputTokens: outputTokens ?? 0,
    totalTokens: totalTokens ?? (inputTokens ?? 0) + (outputTokens ?? 0),
    ...optionalUsageToken(
      "cacheReadTokens",
      usage.cache_read_tokens ?? usage.cacheReadTokens,
    ),
    ...optionalUsageToken(
      "cacheWriteTokens",
      usage.cache_write_tokens ?? usage.cacheWriteTokens,
    ),
    ...optionalUsageToken(
      "noCacheTokens",
      usage.no_cache_tokens ?? usage.noCacheTokens,
    ),
    ...optionalUsageToken(
      "reasoningTokens",
      usage.reasoning_tokens ?? usage.reasoningTokens,
    ),
  };
}

function optionalUsageToken(
  key:
    | "cacheReadTokens"
    | "cacheWriteTokens"
    | "noCacheTokens"
    | "reasoningTokens",
  value: number | null | undefined,
): Partial<Record<typeof key, number>> {
  const normalized = normalizeToken(value);
  return normalized === null ? {} : { [key]: normalized };
}

function normalizeToken(value: number | null | undefined): number | null {
  if (
    value === null ||
    value === undefined ||
    !Number.isFinite(value) ||
    value < 0
  ) {
    return null;
  }
  return Math.floor(value);
}

function collectArtifactRefs(
  artifactAbsPath: string | null,
  archivePath: string | null | undefined,
): string[] {
  const refs: string[] = [];
  if (artifactAbsPath !== null) {
    refs.push(artifactAbsPath);
  }
  if (
    archivePath !== null &&
    archivePath !== undefined &&
    archivePath.trim().length > 0
  ) {
    refs.push(archivePath);
  }
  return refs;
}

type CrabrunnerProgress = NonNullable<CrabrunnerTerminalEvidence["progress"]>;
type CrabrunnerProcess = NonNullable<CrabrunnerTerminalEvidence["process"]>;

function buildProgress(status: CrabrunnerStatus): CrabrunnerProgress | null {
  if (status.heartbeat_seq === null || status.heartbeat_seq === undefined) {
    return null;
  }
  return {
    heartbeatCount: status.heartbeat_seq,
    ...(status.updated_at === null || status.updated_at === undefined
      ? {}
      : { lastHeartbeatAt: status.updated_at }),
  };
}

function buildProcess(status: CrabrunnerStatus): CrabrunnerProcess | null {
  const pid = status.worker_pid;
  const pgid = status.worker_pgid;
  if (
    (pid === null || pid === undefined) &&
    (pgid === null || pgid === undefined)
  ) {
    return null;
  }
  return {
    ...(pid === null || pid === undefined ? {} : { pid }),
    ...(pgid === null || pgid === undefined ? {} : { processGroupId: pgid }),
  };
}

function createAbortError(): Error {
  const error = new Error("crabrunner poll aborted");
  error.name = "AbortError";
  return error;
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted === true) {
    throw createAbortError();
  }
}

/**
 * Fail closed if a crabrunner response is for a different job than requested,
 * so a stale or misrouted response is never attributed to the wrong Symphony
 * job (Codex Track). No-op when no expected id is supplied (e.g. submit, where
 * the daemon assigns the id).
 */
function assertJobIdMatches(
  command: string,
  expectedJobId: string | undefined,
  actualJobId: string,
): void {
  if (expectedJobId === undefined) {
    return;
  }
  if (actualJobId !== expectedJobId) {
    throw new Error(
      `crabrunner ${command} returned job_id "${actualJobId}" but expected "${expectedJobId}"`,
    );
  }
}

function parseJson(stdout: string, command: string): unknown {
  const trimmed = stdout.trim();
  if (trimmed.length === 0) {
    throw new Error(`crabrunner ${command} produced empty stdout`);
  }
  try {
    return JSON.parse(trimmed);
  } catch (error) {
    throw new Error(
      `crabrunner ${command} produced unparseable stdout: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
}

function buildJobId(spec: CrabrunnerJobSpec): string {
  const base = sanitizeSlug(
    `${spec.issue.identifier}-${spec.identity.stageName ?? "stage"}`,
  );
  // sha256 (not sha1) for security-scanner cleanliness; the slice is only a
  // short disambiguator, not a cryptographic commitment (DeepSeek P2-5).
  const hash = createHash("sha256")
    .update(spec.identity.idempotencyKey)
    .digest("hex")
    .slice(0, 8);
  return `${base}-${hash}`;
}

function resolveProfile(spec: CrabrunnerJobSpec): "write" | "read-only" {
  const phase = spec.phase;
  const role = spec.role;
  if (phase === "implement" || role === "implementer") {
    return "write";
  }
  return "read-only";
}

function resolveModelSlug(spec: CrabrunnerJobSpec): string | null {
  const model = spec.runner.model;
  if (model === null || model.trim().length === 0) {
    return null;
  }
  const provider = spec.runner.provider;
  if (provider === null || provider.trim().length === 0) {
    return model;
  }
  return `${provider}/${model}`;
}

function sanitizeSlug(value: string): string {
  const slug = value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
  return slug.length > 0 ? slug : "stage";
}
