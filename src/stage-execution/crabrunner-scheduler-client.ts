import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { extname, isAbsolute, join, resolve } from "node:path";
import { promisify } from "node:util";

import {
  type CollectedArtifact,
  readCollectedArtifact,
} from "./collected-artifact.js";
import {
  type CrabrunnerAdmissionResult,
  type CrabrunnerCancellationRequest,
  type CrabrunnerJobSpec,
  type CrabrunnerProgressEvidence,
  type CrabrunnerSchedulerClient,
  CrabrunnerStatusPollError,
  type CrabrunnerTerminalEvidence,
  type CrabrunnerTerminalState,
  type CrabrunnerUsage,
} from "./crabrunner-backend.js";
import {
  type CrabrunnerRunResult,
  type CrabrunnerStatus,
  parseCrabrunnerCollect,
  parseCrabrunnerRunResult,
  parseCrabrunnerStatus,
} from "./crabrunner-contract.js";
import {
  laneWorkerUsageSchema,
  mapLaneWorkerUsage,
} from "./crabrunner-usage.js";
import { fileSha256 } from "./file-sha256.js";

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
  /**
   * SSH user for `bin/crabrunner run` on remote/non-local hosts. Required for
   * remote workspace materialization; absent remote config fails closed.
   */
  remoteUser?: string;
  /** Optional SSH port for remote crabbox runs (default is crabrunner's 22). */
  remotePort?: string;
  /** Optional remote crabbox static work root override. */
  remoteWorkRoot?: string;
  /** Optional crabbox binary override (default is crabrunner's "crabbox"). */
  crabboxBin?: string;
  /**
   * Remote crabrunner state root for `bin/crabrunner run`. This is intentionally
   * separate from local `stateRoot`: the run CLI interprets this path on the
   * remote host and defaults to a user-relative root when omitted.
   */
  remoteStateRoot?: string;
  /**
   * Local directory where `bin/crabrunner run` downloads collect archives.
   * Defaults to `<stateRoot>/remote-artifacts`.
   */
  remoteRunArtifactDir?: string;
  /** Crabrunner version passed to `bin/crabrunner run` (default "dev"). */
  crabrunnerVersion?: string;
  now?: () => Date;
  /** Injected subprocess executor (tests). Defaults to a real execFile impl. */
  cli?: CrabrunnerCli;
  /** Status poll interval in ms (default 1000). */
  pollIntervalMs?: number;
  /**
   * Explicit maximum status polls. When absent, the client derives the budget
   * from each submitted lane's timeout.
   */
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
const CANCELLATION_SETTLE_TIMEOUT_MS = 15_000;

function defaultStateRoot(): string {
  return join(homedir(), ".crucible", "crabrunner");
}

function normalizeOptionalString(value: string | undefined): string | null {
  if (value === undefined) {
    return null;
  }
  const trimmed = value.trim();
  return trimmed.length === 0 ? null : trimmed;
}

function resolveMaybeRelativePath(path: string, cwd: string): string {
  return isAbsolute(path) ? path : resolve(cwd, path);
}

function appendOptionalArg(
  args: string[],
  flag: string,
  value: string | null,
): void {
  if (value !== null) {
    args.push(flag, value);
  }
}

const CRABRUNNER_MANIFEST_SCHEMA = "crucible.crabrunner.job.v1";
// Job-kind-dependent lane-worker protocol selector. A prompt_file+model manifest
// uses "lane-worker.v1"; a worker_argv manifest uses "worker-argv.v1". This
// client emits a prompt_file/model lane (the worker_argv path is not sourced
// from the spec yet — see TODO(SYMPH-853-followup)).
const LANE_WORKER_PROTOCOL = "lane-worker.v1";
const WORKER_ARGV_PROTOCOL = "worker-argv.v1";

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

interface ObservedCrabrunnerLiveness {
  lastHeartbeatAt?: string;
  lastProgressAt?: string;
}

/**
 * Named classes from Crucible's crabrunner execution contract. Keep this an
 * exact lookup: substrate codes such as `admission_lock_timeout` are runner
 * failures, not lane timeouts, while worker `timeout` is a terminal lane class.
 */
const CRABRUNNER_ERROR_CODE_TERMINAL_STATES: Readonly<
  Record<string, CrabrunnerTerminalState>
> = {
  staged_runtime_not_ready: "runner_failed",
  staging_lock_timeout: "runner_failed",
  staging_build_failed: "runner_failed",
  admission_lock_timeout: "runner_failed",
  submit_or_worker_failure: "runner_failed",
  timeout: "timed_out",
  cancellation: "canceled",
  artifact_parse_failure: "artifact_parse_failed",
  workspace_materialization_failed: "runner_failed",
  workspace_sync_apply_failed: "runner_failed",
  workspace_sync_empty: "runner_failed",
  worker_failure: "runner_failed",
  dependency_failed: "runner_failed",
  workspace_sync_missing: "runner_failed",
  workspace_sync_unsupported: "runner_failed",
  codex_stream_timeout_after_diff: "runner_failed",
  provider_stream_error_after_diff: "runner_failed",
  budget_exceeded: "budget_exceeded",
  turn_cap_reached: "turn_cap_reached",
};

export class CrabrunnerCliSchedulerClient implements CrabrunnerSchedulerClient {
  private readonly crucibleRoot: string;
  private readonly targetRepoRoot: string;
  private readonly stateRoot: string;
  private readonly host: string;
  private readonly provider: string;
  private readonly remoteUser: string | null;
  private readonly remotePort: string | null;
  private readonly remoteWorkRoot: string | null;
  private readonly crabboxBin: string | null;
  private readonly remoteStateRoot: string | null;
  private readonly remoteRunArtifactDir: string;
  private readonly crabrunnerVersion: string;
  private readonly now: () => Date;
  private readonly cli: CrabrunnerCli;
  private readonly pollIntervalMs: number;
  private readonly configuredMaxPolls: number | null;
  private readonly noStage: boolean;
  private readonly cliTimeoutMs: number;
  private readonly maxBufferBytes: number;
  private readonly remoteRunResults = new Map<string, CrabrunnerRunResult>();
  private readonly maxPollsByJob = new Map<string, number>();
  private readonly livenessByJob = new Map<
    string,
    ObservedCrabrunnerLiveness
  >();

  constructor(options: CrabrunnerCliSchedulerClientOptions) {
    this.crucibleRoot = options.crucibleRoot;
    this.targetRepoRoot = options.targetRepoRoot;
    this.stateRoot = options.stateRoot ?? defaultStateRoot();
    this.host = options.host ?? "local";
    this.provider =
      options.provider ?? (this.host === "local" ? "local" : "ssh");
    this.remoteUser = normalizeOptionalString(options.remoteUser);
    this.remotePort = normalizeOptionalString(options.remotePort);
    this.remoteWorkRoot = normalizeOptionalString(options.remoteWorkRoot);
    this.crabboxBin = normalizeOptionalString(options.crabboxBin);
    this.remoteStateRoot = normalizeOptionalString(options.remoteStateRoot);
    this.remoteRunArtifactDir = resolveMaybeRelativePath(
      normalizeOptionalString(options.remoteRunArtifactDir) ??
        join(this.stateRoot, "remote-artifacts"),
      this.crucibleRoot,
    );
    this.crabrunnerVersion =
      normalizeOptionalString(options.crabrunnerVersion) ?? "dev";
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
    this.configuredMaxPolls = options.maxPolls ?? null;
    this.noStage = options.noStage ?? false;
  }

  async submit(
    spec: CrabrunnerJobSpec,
    signal?: AbortSignal,
  ): Promise<CrabrunnerAdmissionResult> {
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

    if (this.requiresRemoteRun()) {
      return await this.submitRemote(spec, signal);
    }

    const manifest = this.buildManifest(spec);
    const dir = await mkdtemp(join(tmpdir(), "crabrunner-manifest-"));
    const manifestPath = join(dir, "manifest.json");
    try {
      await writeFile(manifestPath, JSON.stringify(manifest), "utf8");
      const result = await this.run(
        [
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
        ],
        signal,
      );
      const status = parseCrabrunnerStatus(result, "submit");
      if (!CRABRUNNER_ADMITTED_STATES.has(status.state)) {
        return {
          status: "rejected",
          jobId: null,
          reason:
            status.message ?? status.error_code ?? status.state ?? "rejected",
        };
      }
      this.maxPollsByJob.set(status.job_id, this.maxPollsForSpec(spec));
      return { status: "accepted", jobId: status.job_id };
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }

  async status(jobId: string, signal?: AbortSignal): Promise<void> {
    let latestStatus: CrabrunnerStatus | undefined;
    try {
      throwIfAborted(signal);
      if (this.remoteRunResults.has(jobId)) {
        return;
      }
      if (this.requiresRemoteRun()) {
        throw new Error(
          `crabrunner remote job ${jobId} has no cached run result; provider=ssh uses crabrunner run and cannot poll split status`,
        );
      }
      // Count consecutive terminal-but-not-collectible polls. The daemon can
      // write a terminal lifecycle state before flipping `collectible` (write
      // race); grace-retry a few polls before failing closed (DeepSeek P2-1).
      let terminalNotCollectiblePolls = 0;
      const maxPolls =
        this.maxPollsByJob.get(jobId) ??
        this.configuredMaxPolls ??
        DEFAULT_MAX_POLLS;
      for (let attempt = 0; attempt < maxPolls; attempt += 1) {
        throwIfAborted(signal);
        const result = await this.run(
          ["status", "--job-id", jobId, ...this.stateRootArgs()],
          signal,
        );
        const status = parseCrabrunnerStatus(result, "status", jobId);
        latestStatus = status;
        await this.observeLiveness(jobId, status);

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

        if (attempt < maxPolls - 1) {
          await this.sleep(this.pollIntervalMs, signal);
        }
      }

      throw new Error(
        `crabrunner job ${jobId} did not become collectible within ${maxPolls} status polls`,
      );
    } catch (error) {
      const observed = this.livenessByJob.get(jobId);
      const progress =
        latestStatus === undefined
          ? buildObservedProgress(observed)
          : buildProgress(latestStatus, observed);
      const statusError =
        error instanceof CrabrunnerStatusPollError
          ? error
          : new CrabrunnerStatusPollError(error, progress);
      // Copy the diagnostic snapshot into the typed error before releasing the
      // scheduler's per-job state. The backend consumes and persists it.
      this.forgetLocalJob(jobId);
      throw statusError;
    }
  }

  async collect(
    jobId: string,
    signal?: AbortSignal,
  ): Promise<CrabrunnerTerminalEvidence> {
    throwIfAborted(signal);
    const remoteRun = this.remoteRunResults.get(jobId);
    if (remoteRun !== undefined) {
      const evidence = await this.collectRemoteRunEvidence(remoteRun);
      this.remoteRunResults.delete(jobId);
      return evidence;
    }
    if (this.requiresRemoteRun()) {
      throw new Error(
        `crabrunner remote job ${jobId} has no cached run result to collect`,
      );
    }
    try {
      const result = await this.run(
        ["collect", "--job-id", jobId, ...this.stateRootArgs()],
        signal,
      );
      const collect = parseCrabrunnerCollect(result, jobId);
      const status = collect.status;
      await this.observeLiveness(jobId, status);

      const lifecycleState = collect.state;
      let terminalState = mapLifecycleToTerminalState(lifecycleState, status);
      const artifact = readCollectedArtifact(collect);

      // usage_path in CrabrunnerStatus is RELATIVE to <stateRoot>/jobs/<jobId>/.
      // It remains a pre-materialization fallback during the additive rollout.
      const usageAbsPath = this.resolveJobPath(jobId, status.usage_path);

      if (terminalState === "succeeded" && artifact.status !== "ready") {
        terminalState = "artifact_parse_failed";
      }

      const usage =
        (await this.readUsageFromCollectedArtifact(artifact)) ??
        (await this.readUsage(usageAbsPath));

      return {
        state: terminalState,
        artifact,
        workspacePath: status.workspace ?? null,
        usage,
        message: status.message ?? null,
        progress: buildProgress(status, this.livenessByJob.get(jobId)),
        process: buildProcess(status),
      };
    } finally {
      this.forgetLocalJob(jobId);
    }
  }

  async cancel(
    jobId: string,
    request: CrabrunnerCancellationRequest,
  ): Promise<CrabrunnerTerminalEvidence> {
    // The `bin/crabrunner cancel` CLI only accepts --job-id [--state-root]; it
    // does not take --signal/--process-group. request.signal/processGroup are
    // therefore diagnostics-only in the cancellation block for this phase.
    // TODO(SYMPH-853-followup): forward signal/process-group once the CLI supports it.
    try {
      const result = await this.run([
        "cancel",
        "--job-id",
        jobId,
        ...this.stateRootArgs(),
      ]);
      const status = parseCrabrunnerStatus(result, "cancel", jobId);
      // Only a TERMINAL "stopped" counts as killed. "stopping" is non-terminal
      // (still shutting down) and must NOT be reported as canceled, or consumers
      // misread an in-flight job as killed (Codex P2 / DeepSeek P2-6). The
      // cancel CLI can return stopping immediately, so settle against status
      // before deciding whether the kill was delivered.
      const settledStatus = await this.waitForCancellationTerminalStatus(
        jobId,
        status,
        request,
      );
      await this.observeLiveness(jobId, settledStatus);
      const killed = settledStatus.state === "stopped";
      const alreadyExited =
        CRABRUNNER_TERMINAL_LIFECYCLE_STATES.has(settledStatus.state) &&
        !killed;
      const terminalState: CrabrunnerTerminalState =
        killed || alreadyExited ? "canceled" : "kill_failed";
      const failure =
        killed || alreadyExited
          ? null
          : settledStatus.state === "stopping"
            ? "cancel_incomplete"
            : (settledStatus.message ?? "cancel_incomplete");

      return {
        state: terminalState,
        workspacePath: settledStatus.workspace ?? null,
        message: settledStatus.message ?? null,
        progress: buildProgress(settledStatus, this.livenessByJob.get(jobId)),
        process: buildProcess(settledStatus),
        cancellation: {
          requested: true,
          signal: request.signal,
          processGroup: request.processGroup,
          killed,
          failure,
        },
      };
    } finally {
      this.forgetLocalJob(jobId);
    }
  }

  private buildManifest(spec: CrabrunnerJobSpec): Record<string, unknown> {
    const jobId = buildJobId(spec);
    const profile = resolveProfile(spec);
    const model = resolveModelSlug(spec);
    const thinking = spec.runner.reasoningEffort ?? null;
    // Null timeouts inherit the CLI default; explicit zero/negative values are
    // rejected by delegated enforcement validation before submit.
    const timeoutSeconds = this.laneTimeoutSeconds(spec);
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
      crabrunner_version: this.crabrunnerVersion,
      created_at: this.now().toISOString(),
      host: this.host,
      // "local" for a local host, "ssh" for an SSH crabbox host.
      provider: this.provider,
      target: "macos",
      // remote_repo is the CRUCIBLE checkout (where the lane worker code loads
      // from); the TARGET repo is `workspace` (Codex P1-1, confirmed against a
      // real smoke manifest).
      remote_repo: this.crucibleRoot,
      // Local submit uses the target checkout directly. Remote/non-local hosts
      // never take this path; they go through `crabrunner run`, which
      // materializes this workspace onto the host and rewrites the manifest.
      workspace: this.targetRepoRoot,
      artifact_name: sanitizeSlug(spec.identity.stageName ?? "stage"),
      phase: spec.phase,
      issue_ids: [spec.issue.identifier],
      // Symphony owns closeout, so the lane does none. TODO(SYMPH-853-followup):
      // revisit lane-side workspace cleanup semantics before rollout.
      closeout_policy: "disabled",
      ...(promptFile === undefined ? {} : { prompt_file: promptFile }),
      ...(model === null ? {} : { model }),
      ...(thinking === null ? {} : { thinking }),
      profile,
      timeout_seconds: timeoutSeconds,
      lane_worker_protocol: laneWorkerProtocol,
      lane_key: jobId,
      workspace_identity: workspaceIdentity(spec),
    };
  }

  private stateRootArgs(): string[] {
    // Always forward --state-root (even the default ~/.crucible/crabrunner) so
    // the CLI and resolveJobPath agree on the job directory (DeepSeek P2-4).
    return ["--state-root", this.stateRoot];
  }

  private requiresRemoteRun(): boolean {
    return this.provider === "ssh" || this.host !== "local";
  }

  private async submitRemote(
    spec: CrabrunnerJobSpec,
    signal: AbortSignal | undefined,
  ): Promise<CrabrunnerAdmissionResult> {
    if (this.remoteUser === null) {
      return {
        status: "rejected",
        jobId: null,
        reason: "crabrunner_remote_user_required_symph_864",
      };
    }

    const model = resolveModelSlug(spec);
    if (model === null) {
      return {
        status: "rejected",
        jobId: null,
        reason: "crabrunner_remote_model_required_symph_864",
      };
    }
    const promptFile = spec.promptFile;
    if (promptFile === undefined || promptFile.trim().length === 0) {
      return {
        status: "rejected",
        jobId: null,
        reason: "crabrunner_prompt_required_symph_856",
      };
    }

    const jobId = buildJobId(spec);
    const result = await this.run(
      this.buildRemoteRunArgs(spec, jobId, this.remoteUser, model, promptFile),
      signal,
      this.remoteRunCliTimeoutMs(spec),
    );
    const runResult = parseCrabrunnerRunResult(result, jobId);
    this.remoteRunResults.set(runResult.job_id, runResult);
    return { status: "accepted", jobId: runResult.job_id };
  }

  private buildRemoteRunArgs(
    spec: CrabrunnerJobSpec,
    jobId: string,
    remoteUser: string,
    model: string,
    promptFile: string,
  ): string[] {
    const timeoutSeconds = this.laneTimeoutSeconds(spec);
    const phase = spec.phase ?? "review";
    const thinking = spec.runner.reasoningEffort ?? null;
    const args = [
      "run",
      "--host",
      this.host,
      "--user",
      remoteUser,
      "--job-id",
      jobId,
      "--version",
      this.crabrunnerVersion,
      "--artifact-name",
      sanitizeSlug(spec.identity.stageName ?? "stage"),
      "--phase",
      phase,
      "--profile",
      resolveProfile(spec),
      ...(thinking === null ? [] : ["--thinking", thinking]),
      "--timeout-seconds",
      String(timeoutSeconds),
      "--lane-key",
      jobId,
      "--issue-ids-json",
      JSON.stringify([spec.issue.identifier]),
      "--workspace-identity-json",
      JSON.stringify(workspaceIdentity(spec)),
      "--closeout-policy",
      "disabled",
      "--workspace",
      this.targetRepoRoot,
      "--materialize-workspace-from",
      this.targetRepoRoot,
      "--prompt-file",
      promptFile,
      "--model",
      model,
      "--repo-root",
      this.crucibleRoot,
      "--artifact-dir",
      this.remoteRunArtifactDir,
      "--poll-interval-ms",
      String(this.pollIntervalMs),
      "--max-polls",
      String(this.maxPollsForSpec(spec)),
    ];
    appendOptionalArg(args, "--port", this.remotePort);
    appendOptionalArg(args, "--work-root", this.remoteWorkRoot);
    appendOptionalArg(args, "--crabbox-bin", this.crabboxBin);
    appendOptionalArg(args, "--state-root", this.remoteStateRoot);
    return args;
  }

  private remoteRunCliTimeoutMs(spec: CrabrunnerJobSpec): number {
    const laneTimeoutMs = this.laneTimeoutMs(spec);
    const pollBudgetMs = this.maxPollsForSpec(spec) * this.pollIntervalMs;
    return Math.max(this.cliTimeoutMs, laneTimeoutMs + pollBudgetMs + 60_000);
  }

  private laneTimeoutMs(spec: CrabrunnerJobSpec): number {
    return spec.enforcement.timing.timeoutMs ?? DEFAULT_CLI_TIMEOUT_MS;
  }

  private laneTimeoutSeconds(spec: CrabrunnerJobSpec): number {
    return Math.max(1, Math.ceil(this.laneTimeoutMs(spec) / 1_000));
  }

  private maxPollsForSpec(spec: CrabrunnerJobSpec): number {
    if (this.configuredMaxPolls !== null) {
      return this.configuredMaxPolls;
    }
    if (this.pollIntervalMs <= 0) {
      return DEFAULT_MAX_POLLS;
    }
    return Math.max(
      1,
      Math.ceil(this.laneTimeoutMs(spec) / this.pollIntervalMs) +
        STATUS_TERMINAL_GRACE_POLLS +
        1,
    );
  }

  private async collectRemoteRunEvidence(
    runResult: CrabrunnerRunResult,
  ): Promise<CrabrunnerTerminalEvidence> {
    if (runResult.collect === null || runResult.collect === undefined) {
      throw new Error(
        `crabrunner run result ${runResult.job_id} did not include a collect payload`,
      );
    }

    const status = runResult.collect.status;
    let terminalState = mapLifecycleToTerminalState(
      runResult.collect.state,
      status,
    );
    const artifact = readCollectedArtifact(runResult.collect);
    if (terminalState === "succeeded" && artifact.status !== "ready") {
      terminalState = "artifact_parse_failed";
    }

    const workspaceSyncPath =
      runResult.workspace_sync_artifact?.path ??
      join(
        this.remoteRunArtifactDir,
        `${runResult.job_id}.workspace-sync.json`,
      );
    const crabrunnerWorkspaceSyncHash = normalizeOptionalString(
      runResult.workspace_sync_artifact?.sha256 ?? undefined,
    );
    let workspaceSyncRef:
      | NonNullable<CrabrunnerTerminalEvidence["workspaceSyncRef"]>
      | undefined;
    if (await this.isFilePresent(workspaceSyncPath)) {
      const workspaceSyncHash = await fileSha256(workspaceSyncPath);
      if (
        crabrunnerWorkspaceSyncHash !== null &&
        crabrunnerWorkspaceSyncHash !== workspaceSyncHash
      ) {
        throw new Error(
          `remote workspace-sync artifact hash mismatch for ${workspaceSyncPath}: crabrunner reported ${crabrunnerWorkspaceSyncHash} but downloaded file is ${workspaceSyncHash}`,
        );
      }
      workspaceSyncRef = {
        path: workspaceSyncPath,
        sha256: workspaceSyncHash,
      };
    } else if (crabrunnerWorkspaceSyncHash !== null) {
      throw new Error(
        `remote workspace-sync artifact missing for ${workspaceSyncPath}: crabrunner reported ${crabrunnerWorkspaceSyncHash}`,
      );
    }

    const usage = (await this.readUsageFromCollectedArtifact(artifact)) ?? {
      status: "unavailable" as const,
      reason: "usage artifact not found in materialized collect artifact",
    };

    return {
      state: terminalState,
      artifact,
      ...(workspaceSyncRef === undefined ? {} : { workspaceSyncRef }),
      workspacePath: status.workspace ?? null,
      usage,
      message:
        status.message ??
        (artifact.status === "ready" ? null : artifact.reason),
      progress: buildProgress(status),
      process: buildProcess(status),
    };
  }

  private async run(
    args: readonly string[],
    signal?: AbortSignal,
    timeoutMs = this.cliTimeoutMs,
  ): Promise<{
    stdout: string;
    stderr: string;
    exitCode: number;
  }> {
    return await this.cli(args, {
      cwd: this.crucibleRoot,
      timeoutMs,
      ...(signal === undefined ? {} : { signal }),
    });
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

  private async isFilePresent(path: string): Promise<boolean> {
    try {
      const metadata = await stat(path);
      return metadata.isFile() && metadata.size > 0;
    } catch {
      return false;
    }
  }

  private forgetLocalJob(jobId: string): void {
    this.maxPollsByJob.delete(jobId);
    this.livenessByJob.delete(jobId);
  }

  private async observeLiveness(
    jobId: string,
    status: CrabrunnerStatus,
  ): Promise<void> {
    const artifactPath = this.resolveJobPath(jobId, status.artifact_path);
    if (artifactPath === null) {
      return;
    }
    const extension = extname(artifactPath);
    const basePath =
      extension.length === 0
        ? artifactPath
        : artifactPath.slice(0, -extension.length);
    const [heartbeatMtime, progressMtime] = await Promise.all([
      fileMtimeIso(`${basePath}.heartbeat.json`),
      fileMtimeIso(`${basePath}.progress.jsonl`),
    ]);
    if (heartbeatMtime === null && progressMtime === null) {
      return;
    }
    const prior = this.livenessByJob.get(jobId) ?? {};
    const lastHeartbeatAt =
      heartbeatMtime === null
        ? prior.lastHeartbeatAt
        : latestIso(prior.lastHeartbeatAt, heartbeatMtime);
    const lastProgressAt =
      progressMtime === null
        ? prior.lastProgressAt
        : latestIso(prior.lastProgressAt, progressMtime);
    if (
      lastHeartbeatAt === prior.lastHeartbeatAt &&
      lastProgressAt === prior.lastProgressAt
    ) {
      return;
    }
    this.livenessByJob.set(jobId, {
      ...(lastHeartbeatAt === undefined ? {} : { lastHeartbeatAt }),
      ...(lastProgressAt === undefined ? {} : { lastProgressAt }),
    });
  }

  private async waitForCancellationTerminalStatus(
    jobId: string,
    initialStatus: CrabrunnerStatus,
    request: CrabrunnerCancellationRequest,
  ): Promise<CrabrunnerStatus> {
    if (CRABRUNNER_TERMINAL_LIFECYCLE_STATES.has(initialStatus.state)) {
      return initialStatus;
    }

    const deadline =
      Date.now() +
      Math.min(
        CANCELLATION_SETTLE_TIMEOUT_MS,
        Math.max(1_000, request.killGraceMs + 5_000),
      );
    let status = initialStatus;
    while (Date.now() < deadline) {
      try {
        const timeoutMs = Math.max(
          1,
          Math.min(this.cliTimeoutMs, deadline - Date.now()),
        );
        const result = await this.run(
          ["status", "--job-id", jobId, ...this.stateRootArgs()],
          undefined,
          timeoutMs,
        );
        status = parseCrabrunnerStatus(result, "status", jobId);
        if (CRABRUNNER_TERMINAL_LIFECYCLE_STATES.has(status.state)) {
          return status;
        }
      } catch {
        // Preserve the cancellation response when a status probe races state
        // cleanup or a remote scheduler does not expose split polling.
        return status;
      }
      await this.sleep(Math.max(25, Math.min(this.pollIntervalMs || 250, 250)));
    }
    return status;
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

  private async readUsageFromCollectedArtifact(
    artifact: CollectedArtifact,
  ): Promise<CrabrunnerUsage | null> {
    const usageEntry = artifact.entries.find(
      (entry) =>
        entry.name.includes("/artifact/") && entry.name.endsWith(".usage.json"),
    );
    const raw =
      usageEntry !== undefined && "content" in usageEntry
        ? usageEntry.content
        : null;
    if (raw === null) {
      return null;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return {
        status: "unavailable",
        reason: "usage artifact in materialized collect is not valid JSON",
      };
    }
    const usage = laneWorkerUsageSchema.safeParse(parsed);
    if (!usage.success) {
      return {
        status: "unavailable",
        reason:
          "usage artifact in materialized collect failed schema validation",
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
  const normalized = errorCode.trim().toLowerCase();
  return CRABRUNNER_ERROR_CODE_TERMINAL_STATES[normalized] ?? "runner_failed";
}

async function fileMtimeIso(path: string): Promise<string | null> {
  try {
    const metadata = await stat(path);
    return metadata.isFile() ? metadata.mtime.toISOString() : null;
  } catch {
    return null;
  }
}

function latestIso(prior: string | undefined, observed: string): string {
  return prior === undefined || observed > prior ? observed : prior;
}

type CrabrunnerProgress = CrabrunnerProgressEvidence;
type CrabrunnerProcess = NonNullable<CrabrunnerTerminalEvidence["process"]>;

function buildProgress(
  status: CrabrunnerStatus,
  observed?: ObservedCrabrunnerLiveness,
): CrabrunnerProgress | null {
  const heartbeatCount = status.heartbeat_seq ?? undefined;
  const lastHeartbeatAt =
    observed?.lastHeartbeatAt ??
    (heartbeatCount === undefined
      ? undefined
      : (status.updated_at ?? undefined));
  const lastProgressAt = observed?.lastProgressAt;
  if (
    heartbeatCount === undefined &&
    lastHeartbeatAt === undefined &&
    lastProgressAt === undefined
  ) {
    return null;
  }
  return {
    ...(heartbeatCount === undefined ? {} : { heartbeatCount }),
    ...(lastHeartbeatAt === undefined ? {} : { lastHeartbeatAt }),
    ...(lastProgressAt === undefined ? {} : { lastProgressAt }),
  };
}

function buildObservedProgress(
  observed: ObservedCrabrunnerLiveness | undefined,
): CrabrunnerProgress | null {
  if (observed === undefined) {
    return null;
  }
  return {
    ...(observed.lastHeartbeatAt === undefined
      ? {}
      : { lastHeartbeatAt: observed.lastHeartbeatAt }),
    ...(observed.lastProgressAt === undefined
      ? {}
      : { lastProgressAt: observed.lastProgressAt }),
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

function workspaceIdentity(spec: CrabrunnerJobSpec): Record<string, unknown> {
  return {
    runGroupId: spec.identity.runGroupId,
    stageAttempt: spec.identity.stageAttempt,
    idempotencyKey: spec.identity.idempotencyKey,
    ...(spec.promptSha256 === undefined
      ? {}
      : { promptSha256: spec.promptSha256 }),
  };
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
