import { readFile } from "node:fs/promises";

import { describe, expect, it, vi } from "vitest";

import type { AgentRunInput } from "../../src/agent/runner.js";
import type { StageExecutionJobSpec } from "../../src/stage-execution/backend.js";
import {
  type CrabrunnerCancellationRequest,
  type CrabrunnerJobSpec,
  CrabrunnerStageExecutionBackend,
  createCrabrunnerJobSpec,
} from "../../src/stage-execution/crabrunner-backend.js";
import {
  type CrabrunnerCli,
  type CrabrunnerCliInvocation,
  CrabrunnerCliSchedulerClient,
} from "../../src/stage-execution/crabrunner-scheduler-client.js";

const CRUCIBLE_ROOT = "/tmp/crucible";
const TARGET_REPO_ROOT = "/tmp/target-repo";

describe("CrabrunnerCliSchedulerClient.submit", () => {
  it("maps an accepted submit status to an admission with the job id", async () => {
    const recorder = createCliRecorder({
      submit: () =>
        cliOk(
          statusJson({
            state: "queued",
            job_id: "job-accept",
            collectible: false,
          }),
        ),
    });
    const client = createClient(recorder.cli);

    const admission = await client.submit(createSpec());

    expect(admission).toEqual({ status: "accepted", jobId: "job-accept" });
    const submitCall = recorder.invocations[0]!;
    expect(submitCall.args[0]).toBe("submit");
    expect(submitCall.args).toContain("--manifest-file");
    expect(submitCall.args).toContain("--repo-root");
    expect(submitCall.args).toContain(TARGET_REPO_ROOT);
    expect(submitCall.opts.cwd).toBe(CRUCIBLE_ROOT);
  });

  it("treats an already-terminal complete submit status as accepted", async () => {
    const client = createClient(
      staticCli({
        submit: () =>
          cliOk(
            statusJson({
              state: "complete",
              job_id: "job-fast",
              collectible: true,
            }),
          ),
      }),
    );

    const admission = await client.submit(createSpec());

    expect(admission).toEqual({ status: "accepted", jobId: "job-fast" });
  });

  it("maps a failed submit status to a rejection with a reason", async () => {
    const client = createClient(
      staticCli({
        submit: () =>
          cliOk(
            statusJson({
              state: "failed",
              job_id: "job-reject",
              collectible: false,
              message: "queue full",
              error_code: "queue_limit",
            }),
          ),
      }),
    );

    const admission = await client.submit(createSpec());

    expect(admission.status).toBe("rejected");
    expect(admission.jobId).toBeNull();
    expect(admission.reason).toBe("queue full");
  });

  it("throws (fail closed) when submit exits non-zero", async () => {
    const client = createClient(
      staticCli({
        submit: () => ({ stdout: "", stderr: "boom", exitCode: 1 }),
      }),
    );

    await expect(client.submit(createSpec())).rejects.toThrow(/exit/i);
  });

  it("throws (fail closed) when submit stdout is unparseable", async () => {
    const client = createClient(
      staticCli({ submit: () => cliOk("not json at all") }),
    );

    await expect(client.submit(createSpec())).rejects.toThrow();
  });

  it("throws (fail closed) when submit returns the wrong schema", async () => {
    const client = createClient(
      staticCli({
        submit: () =>
          cliOk(
            JSON.stringify({
              schema: "crucible.crabrunner.collect.v1",
              job_id: "job-1",
              state: "queued",
            }),
          ),
      }),
    );

    await expect(client.submit(createSpec())).rejects.toThrow(/schema/i);
  });

  it("throws (fail closed) when the submit status is missing a job id", async () => {
    const client = createClient(
      staticCli({
        submit: () =>
          cliOk(
            statusJson({ state: "queued", job_id: "", collectible: false }),
          ),
      }),
    );

    await expect(client.submit(createSpec())).rejects.toThrow(/job_id/i);
  });

  it("writes a mapped manifest to a temp file and cleans it up", async () => {
    let manifestPath: string | null = null;
    let manifestContent: string | null = null;
    const client = createClient(
      async (args, opts) => {
        const index = args.indexOf("--manifest-file");
        manifestPath = args[index + 1] ?? null;
        if (manifestPath !== null) {
          manifestContent = await readFile(manifestPath, "utf8");
        }
        return cliOk(
          statusJson({
            state: "queued",
            job_id: "job-manifest",
            collectible: false,
          }),
        );
      },
      { now: () => new Date("2026-06-21T10:00:00.000Z") },
    );

    await client.submit(createSpec());

    expect(manifestPath).not.toBeNull();
    expect(manifestContent).not.toBeNull();
    const manifest = JSON.parse(manifestContent!) as Record<string, unknown>;
    expect(manifest).toMatchObject({
      schema: "crucible.crabrunner.job.v1",
      lane_worker_protocol: "lane-worker.v1",
      provider: "local",
      target: "macos",
      phase: "implement",
      created_at: "2026-06-21T10:00:00.000Z",
      timeout_seconds: 600,
      profile: "write",
    });
    expect(manifest.issue_ids).toEqual(["SYMPH-807"]);
    expect(typeof manifest.job_id).toBe("string");
    expect((manifest.job_id as string).length).toBeGreaterThan(0);
    expect(manifest.lane_key).toBe(manifest.job_id);
    // Temp manifest must be cleaned up after submit returns.
    await expect(readFile(manifestPath!, "utf8")).rejects.toThrow();
  });

  it("uses provider ssh for non-local hosts and worker-argv protocol without a model", async () => {
    let manifest: Record<string, unknown> | null = null;
    const cli: CrabrunnerCli = async (args) => {
      const index = args.indexOf("--manifest-file");
      const path = args[index + 1];
      if (path !== undefined) {
        manifest = JSON.parse(await readFile(path, "utf8")) as Record<
          string,
          unknown
        >;
      }
      return cliOk(
        statusJson({ state: "queued", job_id: "job-ssh", collectible: false }),
      );
    };
    const client = new CrabrunnerCliSchedulerClient({
      crucibleRoot: CRUCIBLE_ROOT,
      targetRepoRoot: TARGET_REPO_ROOT,
      host: "crabbox-studio1",
      cli,
    });

    const job = createJob();
    const specWithoutModel = createCrabrunnerJobSpec(
      {
        job: { ...job, runner: { ...job.runner, model: null } },
        runnerInput: createRunnerInput(),
      },
      false,
    );

    await client.submit(specWithoutModel);

    expect(manifest).not.toBeNull();
    expect(manifest!.provider).toBe("ssh");
    expect(manifest!.host).toBe("crabbox-studio1");
    expect(manifest!.lane_worker_protocol).toBe("worker-argv.v1");
    expect(manifest!.model).toBeUndefined();
  });

  it("passes --no-stage and --state-root when configured", async () => {
    const recorder = createCliRecorder({
      submit: () =>
        cliOk(
          statusJson({
            state: "queued",
            job_id: "job-flags",
            collectible: false,
          }),
        ),
    });
    const client = new CrabrunnerCliSchedulerClient({
      crucibleRoot: CRUCIBLE_ROOT,
      targetRepoRoot: TARGET_REPO_ROOT,
      stateRoot: "/tmp/state",
      noStage: true,
      cli: recorder.cli,
    });

    await client.submit(createSpec());

    const submitCall = recorder.invocations[0]!;
    expect(submitCall.args).toContain("--no-stage");
    expect(submitCall.args).toContain("--state-root");
    expect(submitCall.args).toContain("/tmp/state");
  });
});

describe("CrabrunnerCliSchedulerClient.status", () => {
  it("resolves once status reports collectible:true", async () => {
    const client = createClient(
      staticCli({
        status: () =>
          cliOk(
            statusJson({ state: "complete", job_id: "j", collectible: true }),
          ),
      }),
    );

    await expect(client.status("j")).resolves.toBeUndefined();
  });

  it("polls until collectible becomes true", async () => {
    let calls = 0;
    const client = createClient(
      staticCli({
        status: () => {
          calls += 1;
          return cliOk(
            statusJson({
              state: calls < 3 ? "running" : "complete",
              job_id: "j",
              collectible: calls >= 3,
            }),
          );
        },
      }),
      { pollIntervalMs: 0, maxPolls: 10 },
    );

    await client.status("j");

    expect(calls).toBe(3);
  });

  it("throws when a terminal state is never collectible", async () => {
    const client = createClient(
      staticCli({
        status: () =>
          cliOk(
            statusJson({ state: "failed", job_id: "j", collectible: false }),
          ),
      }),
      { pollIntervalMs: 0 },
    );

    await expect(client.status("j")).rejects.toThrow(/terminal/i);
  });

  it("throws when maxPolls is exhausted without becoming collectible", async () => {
    const client = createClient(
      staticCli({
        status: () =>
          cliOk(
            statusJson({ state: "running", job_id: "j", collectible: false }),
          ),
      }),
      { pollIntervalMs: 0, maxPolls: 3 },
    );

    await expect(client.status("j")).rejects.toThrow(/poll/i);
  });

  it("throws on non-zero status exit", async () => {
    const client = createClient(
      staticCli({ status: () => ({ stdout: "", stderr: "x", exitCode: 2 }) }),
      { pollIntervalMs: 0 },
    );

    await expect(client.status("j")).rejects.toThrow(/exit/i);
  });

  it("throws on unparseable status stdout", async () => {
    const client = createClient(staticCli({ status: () => cliOk("garbage") }), {
      pollIntervalMs: 0,
    });

    await expect(client.status("j")).rejects.toThrow();
  });
});

describe("CrabrunnerCliSchedulerClient.collect", () => {
  it("maps complete -> succeeded with usage and artifact refs", async () => {
    const fixture = await writeArtifactFixtures({
      artifact: { ok: true },
      usage: {
        schema: "crucible.lane-worker.usage.v2",
        measurement_kind: "true",
        input_tokens: 100,
        output_tokens: 40,
        total_tokens: 140,
      },
    });
    const client = createClient(
      staticCli({
        collect: () =>
          cliOk(
            collectJson({
              state: "complete",
              status: statusObject({
                state: "complete",
                job_id: "jc",
                collectible: true,
                artifact_path: fixture.artifactPath,
                usage_path: fixture.usagePath,
                collect_archive: "/tmp/archive.tgz",
              }),
              archive_path: "/tmp/archive.tgz",
            }),
          ),
      }),
    );

    const evidence = await client.collect("jc");

    expect(evidence.state).toBe("succeeded");
    expect(evidence.usage).toEqual({
      status: "available",
      inputTokens: 100,
      outputTokens: 40,
      totalTokens: 140,
    });
    expect(evidence.artifactRefs).toEqual([
      fixture.artifactPath,
      "/tmp/archive.tgz",
    ]);
  });

  it("maps timed_out, stopped, and stopping states", async () => {
    for (const [state, expected] of [
      ["timed_out", "timed_out"],
      ["stopped", "canceled"],
      ["stopping", "canceled"],
    ] as const) {
      const fixture = await writeArtifactFixtures({ artifact: { ok: true } });
      const client = createClient(
        staticCli({
          collect: () =>
            cliOk(
              collectJson({
                state,
                status: statusObject({
                  state,
                  job_id: "j",
                  collectible: true,
                  artifact_path: fixture.artifactPath,
                }),
                archive_path: "/tmp/a.tgz",
              }),
            ),
        }),
      );

      const evidence = await client.collect("j");
      expect(evidence.state).toBe(expected);
    }
  });

  it("inspects error_code for failed jobs (budget/stall/kill)", async () => {
    for (const [errorCode, expected] of [
      ["budget_exceeded", "budget_exceeded"],
      ["stall_timeout", "stalled"],
      ["kill_failed", "kill_failed"],
      ["something_else", "runner_failed"],
    ] as const) {
      const fixture = await writeArtifactFixtures({ artifact: { ok: true } });
      const client = createClient(
        staticCli({
          collect: () =>
            cliOk(
              collectJson({
                state: "failed",
                status: statusObject({
                  state: "failed",
                  job_id: "j",
                  collectible: true,
                  artifact_path: fixture.artifactPath,
                  error_code: errorCode,
                }),
                archive_path: "/tmp/a.tgz",
              }),
            ),
        }),
      );

      const evidence = await client.collect("j");
      expect(evidence.state).toBe(expected);
    }
  });

  it("returns artifact_parse_failed when the artifact is missing", async () => {
    const client = createClient(
      staticCli({
        collect: () =>
          cliOk(
            collectJson({
              state: "complete",
              status: statusObject({
                state: "complete",
                job_id: "j",
                collectible: true,
                artifact_path: "/tmp/does-not-exist-artifact.json",
              }),
              archive_path: "/tmp/a.tgz",
            }),
          ),
      }),
    );

    const evidence = await client.collect("j");
    expect(evidence.state).toBe("artifact_parse_failed");
  });

  it("returns unavailable usage (never zero) when the usage file is missing", async () => {
    const fixture = await writeArtifactFixtures({ artifact: { ok: true } });
    const client = createClient(
      staticCli({
        collect: () =>
          cliOk(
            collectJson({
              state: "complete",
              status: statusObject({
                state: "complete",
                job_id: "j",
                collectible: true,
                artifact_path: fixture.artifactPath,
                usage_path: "/tmp/missing-usage.json",
              }),
              archive_path: "/tmp/a.tgz",
            }),
          ),
      }),
    );

    const evidence = await client.collect("j");
    expect(evidence.usage).toMatchObject({ status: "unavailable" });
    expect(evidence.usage).not.toMatchObject({ inputTokens: 0 });
  });

  it("treats proxy/char-count measurement as unavailable (never summed as tokens)", async () => {
    const fixture = await writeArtifactFixtures({
      artifact: { ok: true },
      usage: {
        schema: "crucible.lane-worker.usage.v2",
        measurement_kind: "proxy",
        char_count: 9999,
        input_tokens: 0,
        output_tokens: 0,
      },
    });
    const client = createClient(
      staticCli({
        collect: () =>
          cliOk(
            collectJson({
              state: "complete",
              status: statusObject({
                state: "complete",
                job_id: "j",
                collectible: true,
                artifact_path: fixture.artifactPath,
                usage_path: fixture.usagePath,
              }),
              archive_path: "/tmp/a.tgz",
            }),
          ),
      }),
    );

    const evidence = await client.collect("j");
    expect(evidence.usage?.status).toBe("unavailable");
  });

  it("throws on non-zero collect exit", async () => {
    const client = createClient(
      staticCli({ collect: () => ({ stdout: "", stderr: "x", exitCode: 1 }) }),
    );

    await expect(client.collect("j")).rejects.toThrow(/exit/i);
  });

  it("resolves job-relative artifact/usage paths under stateRoot (real shape)", async () => {
    // Real CrabrunnerStatus: artifact_path / usage_path are RELATIVE to
    // <stateRoot>/jobs/<jobId>/; collect_archive / archive_path are ABSOLUTE.
    const { mkdtemp, mkdir, writeFile } = await import("node:fs/promises");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const stateRoot = await mkdtemp(join(tmpdir(), "crabrunner-state-"));
    const jobId = "smoke-pro14-0";
    const jobDir = join(stateRoot, "jobs", jobId, "attempts", "01", "artifact");
    await mkdir(jobDir, { recursive: true });
    await writeFile(join(jobDir, "result.md"), "# result", "utf8");
    await writeFile(
      join(jobDir, "usage.json"),
      JSON.stringify({
        schema: "crucible.lane-worker.usage.v2",
        measurement_kind: "true",
        input_tokens: 5,
        output_tokens: 3,
        total_tokens: 8,
      }),
      "utf8",
    );
    const absoluteArchive = join(stateRoot, "jobs", jobId, "collect.tgz");

    const client = new CrabrunnerCliSchedulerClient({
      crucibleRoot: CRUCIBLE_ROOT,
      targetRepoRoot: TARGET_REPO_ROOT,
      stateRoot,
      pollIntervalMs: 0,
      cli: staticCli({
        collect: () =>
          cliOk(
            collectJson({
              state: "complete",
              status: statusObject({
                state: "complete",
                job_id: jobId,
                collectible: true,
                artifact_path: "attempts/01/artifact/result.md",
                usage_path: "attempts/01/artifact/usage.json",
                collect_archive: absoluteArchive,
              }),
              archive_path: absoluteArchive,
            }),
          ),
      }),
    });

    const evidence = await client.collect(jobId);

    expect(evidence.state).toBe("succeeded");
    expect(evidence.usage).toEqual({
      status: "available",
      inputTokens: 5,
      outputTokens: 3,
      totalTokens: 8,
    });
    expect(evidence.artifactRefs).toEqual([
      join(jobDir, "result.md"),
      absoluteArchive,
    ]);
  });

  it("maps the simple {available:false,reason} usage shape to unavailable", async () => {
    const fixture = await writeArtifactFixtures({
      artifact: { ok: true },
      usage: { available: false, reason: "smoke job does not run a model" },
    });
    const client = createClient(
      staticCli({
        collect: () =>
          cliOk(
            collectJson({
              state: "complete",
              status: statusObject({
                state: "complete",
                job_id: "smoke",
                collectible: true,
                artifact_path: fixture.artifactPath,
                usage_path: fixture.usagePath,
              }),
              archive_path: "/tmp/a.tgz",
            }),
          ),
      }),
    );

    const evidence = await client.collect("smoke");

    expect(evidence.usage).toEqual({
      status: "unavailable",
      reason: "smoke job does not run a model",
    });
  });

  it("maps the simple {available:true,...camelCase} usage shape to available", async () => {
    const fixture = await writeArtifactFixtures({
      artifact: { ok: true },
      usage: {
        available: true,
        inputTokens: 21,
        outputTokens: 9,
        totalTokens: 30,
      },
    });
    const client = createClient(
      staticCli({
        collect: () =>
          cliOk(
            collectJson({
              state: "complete",
              status: statusObject({
                state: "complete",
                job_id: "smoke2",
                collectible: true,
                artifact_path: fixture.artifactPath,
                usage_path: fixture.usagePath,
              }),
              archive_path: "/tmp/a.tgz",
            }),
          ),
      }),
    );

    const evidence = await client.collect("smoke2");

    expect(evidence.usage).toEqual({
      status: "available",
      inputTokens: 21,
      outputTokens: 9,
      totalTokens: 30,
    });
  });

  it("surfaces worker_pgid as process.processGroupId", async () => {
    const fixture = await writeArtifactFixtures({ artifact: { ok: true } });
    const client = createClient(
      staticCli({
        collect: () =>
          cliOk(
            collectJson({
              state: "complete",
              status: {
                ...statusObject({
                  state: "complete",
                  job_id: "j",
                  collectible: true,
                  artifact_path: fixture.artifactPath,
                }),
                worker_pid: 4242,
                worker_pgid: 4200,
              },
              archive_path: "/tmp/a.tgz",
            }),
          ),
      }),
    );

    const evidence = await client.collect("j");
    expect(evidence.process).toEqual({ pid: 4242, processGroupId: 4200 });
  });
});

describe("CrabrunnerCliSchedulerClient.cancel", () => {
  it("maps a stopped status to canceled with killed:true", async () => {
    const client = createClient(
      staticCli({
        cancel: () =>
          cliOk(
            statusJson({
              state: "stopped",
              job_id: "j",
              collectible: true,
              message: "stopped",
            }),
          ),
      }),
    );

    const evidence = await client.cancel("j", cancelRequest());

    expect(evidence.state).toBe("canceled");
    expect(evidence.cancellation).toMatchObject({
      requested: true,
      signal: "SIGTERM",
      processGroup: true,
      killed: true,
      failure: null,
    });
  });

  it("maps a non-stopped cancel status to kill_failed with a failure reason", async () => {
    const client = createClient(
      staticCli({
        cancel: () =>
          cliOk(
            statusJson({
              state: "running",
              job_id: "j",
              collectible: false,
              message: "still running",
            }),
          ),
      }),
    );

    const evidence = await client.cancel("j", cancelRequest());

    expect(evidence.state).toBe("kill_failed");
    expect(evidence.cancellation).toMatchObject({
      killed: false,
      failure: "still running",
    });
  });
});

describe("CrabrunnerCliSchedulerClient end-to-end through the backend", () => {
  it("produces a succeeded AgentRunResult for a happy-path job", async () => {
    const fixture = await writeArtifactFixtures({
      artifact: { ok: true },
      usage: {
        schema: "crucible.lane-worker.usage.v2",
        measurement_kind: "true",
        input_tokens: 12,
        output_tokens: 8,
        total_tokens: 20,
      },
    });
    const client = createClient(
      staticCli({
        submit: () =>
          cliOk(
            statusJson({ state: "queued", job_id: "e2e", collectible: false }),
          ),
        status: () =>
          cliOk(
            statusJson({ state: "complete", job_id: "e2e", collectible: true }),
          ),
        collect: () =>
          cliOk(
            collectJson({
              state: "complete",
              status: statusObject({
                state: "complete",
                job_id: "e2e",
                collectible: true,
                artifact_path: fixture.artifactPath,
                usage_path: fixture.usagePath,
              }),
              archive_path: "/tmp/e2e.tgz",
            }),
          ),
      }),
      { pollIntervalMs: 0 },
    );
    const backend = new CrabrunnerStageExecutionBackend({ client });

    const result = await backend.execute({
      job: createJob(),
      runnerInput: createRunnerInput(),
    });

    expect(result.result.runAttempt.status).toBe("succeeded");
    expect(result.evidence?.terminal?.state).toBe("succeeded");
    expect(result.result.liveSession.usageMeasurement?.tokens).toMatchObject({
      inputTokens: 12,
      outputTokens: 8,
      totalTokens: 20,
    });
  });

  it("produces a failed AgentRunResult when the lane reports a failed terminal", async () => {
    const fixture = await writeArtifactFixtures({ artifact: { ok: true } });
    const client = createClient(
      staticCli({
        submit: () =>
          cliOk(
            statusJson({
              state: "queued",
              job_id: "e2e-f",
              collectible: false,
            }),
          ),
        status: () =>
          cliOk(
            statusJson({ state: "failed", job_id: "e2e-f", collectible: true }),
          ),
        collect: () =>
          cliOk(
            collectJson({
              state: "failed",
              status: statusObject({
                state: "failed",
                job_id: "e2e-f",
                collectible: true,
                artifact_path: fixture.artifactPath,
                error_code: "budget_exceeded",
              }),
              archive_path: "/tmp/e2e-f.tgz",
            }),
          ),
      }),
      { pollIntervalMs: 0 },
    );
    const backend = new CrabrunnerStageExecutionBackend({ client });

    const result = await backend.execute({
      job: createJob(),
      runnerInput: createRunnerInput(),
    });

    expect(result.result.runAttempt.status).toBe("failed");
    expect(result.evidence?.terminal?.state).toBe("budget_exceeded");
  });
});

// --- helpers ---------------------------------------------------------------

function createClient(
  cli: CrabrunnerCli,
  overrides: {
    pollIntervalMs?: number;
    maxPolls?: number;
    now?: () => Date;
  } = {},
): CrabrunnerCliSchedulerClient {
  return new CrabrunnerCliSchedulerClient({
    crucibleRoot: CRUCIBLE_ROOT,
    targetRepoRoot: TARGET_REPO_ROOT,
    cli,
    pollIntervalMs: overrides.pollIntervalMs ?? 0,
    ...(overrides.maxPolls === undefined
      ? {}
      : { maxPolls: overrides.maxPolls }),
    ...(overrides.now === undefined ? {} : { now: overrides.now }),
  });
}

interface StaticCliHandlers {
  submit?: () => Promise<CliResult> | CliResult;
  status?: () => Promise<CliResult> | CliResult;
  collect?: () => Promise<CliResult> | CliResult;
  cancel?: () => Promise<CliResult> | CliResult;
}

interface CliResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

function staticCli(handlers: StaticCliHandlers): CrabrunnerCli {
  return async (args) => {
    const subcommand = args[0];
    const handler = handlers[subcommand as keyof StaticCliHandlers];
    if (handler === undefined) {
      throw new Error(`unexpected crabrunner subcommand: ${subcommand}`);
    }
    return await handler();
  };
}

function createCliRecorder(handlers: StaticCliHandlers): {
  cli: CrabrunnerCli;
  invocations: CrabrunnerCliInvocation[];
} {
  const invocations: CrabrunnerCliInvocation[] = [];
  const inner = staticCli(handlers);
  const cli: CrabrunnerCli = async (args, opts) => {
    invocations.push({ args: [...args], opts });
    return await inner(args, opts);
  };
  return { cli, invocations };
}

function cliOk(stdout: string): CliResult {
  return { stdout, stderr: "", exitCode: 0 };
}

function statusObject(fields: {
  state: string;
  job_id: string;
  collectible: boolean;
  message?: string;
  error_code?: string;
  artifact_path?: string;
  usage_path?: string;
  collect_archive?: string;
}): Record<string, unknown> {
  return {
    schema: "crucible.crabrunner.status.v1",
    job_id: fields.job_id,
    attempt_id: "attempt-1",
    crabrunner_version: "dev",
    state: fields.state,
    message: fields.message ?? null,
    host: "local",
    updated_at: "2026-06-21T10:00:00.000Z",
    artifact_path: fields.artifact_path ?? "/tmp/artifact.json",
    usage_path: fields.usage_path ?? "/tmp/usage.json",
    collectible: fields.collectible,
    ...(fields.collect_archive === undefined
      ? {}
      : { collect_archive: fields.collect_archive }),
    ...(fields.error_code === undefined
      ? {}
      : { error_code: fields.error_code }),
  };
}

function statusJson(fields: Parameters<typeof statusObject>[0]): string {
  return JSON.stringify(statusObject(fields));
}

function collectJson(fields: {
  state: string;
  status: Record<string, unknown>;
  archive_path: string;
}): string {
  return JSON.stringify({
    schema: "crucible.crabrunner.collect.v1",
    job_id: fields.status.job_id,
    attempt_id: "attempt-1",
    state: fields.state,
    status: fields.status,
    archive_path: fields.archive_path,
  });
}

async function writeArtifactFixtures(input: {
  artifact: unknown;
  usage?: unknown;
}): Promise<{ artifactPath: string; usagePath: string }> {
  const { mkdtemp, writeFile } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const dir = await mkdtemp(join(tmpdir(), "crabrunner-fixture-"));
  const artifactPath = join(dir, "artifact.json");
  const usagePath = join(dir, "usage.json");
  await writeFile(artifactPath, JSON.stringify(input.artifact), "utf8");
  if (input.usage !== undefined) {
    await writeFile(usagePath, JSON.stringify(input.usage), "utf8");
  }
  return { artifactPath, usagePath };
}

function cancelRequest(): CrabrunnerCancellationRequest {
  return {
    reason: "abort_signal",
    signal: "SIGTERM",
    processGroup: true,
    killGraceMs: 5_000,
  };
}

function createSpec(): CrabrunnerJobSpec {
  return createCrabrunnerJobSpec(
    { job: createJob(), runnerInput: createRunnerInput() },
    false,
  );
}

function createJob(): StageExecutionJobSpec {
  return {
    backend: "crabrunner",
    role: "implementer",
    phase: "implement",
    identity: {
      issueId: "issue-807",
      issueIdentifier: "SYMPH-807",
      stageName: "implement",
      stageAttempt: 0,
      runGroupId: "rg-807",
      profileId: "deterministic.crabrunner",
      baseRef: "41e1975",
      targetHeadRef: "codex/SYMPH-807",
      artifactRoot: "/tmp/artifacts/SYMPH-807",
      idempotencyKey:
        "stage-execution:SYMPH-807:implement:0:crabrunner:1234567890abcdef1234",
    },
    runner: {
      runnerKind: "crabrunner-deterministic",
      model: "gpt-5-codex",
      provider: "openai",
      reasoningEffort: "high",
    },
    enforcement: {
      required: true,
      budget: {
        maxTokens: 50_000,
        maxUsd: 4,
        estimatedCostPer1kTokensUsd: 0.05,
        cachedTokenCostRatio: 0.1,
        liveBudgetGraceRatio: 0.2,
      },
      timing: {
        timeoutMs: 600_000,
        stallTimeoutMs: 120_000,
        noProgressTurns: 3,
        maxIterations: 10,
      },
      telemetry: {
        heartbeatIntervalMs: 30_000,
        progressIntervalMs: 30_000,
        usageIntervalMs: 30_000,
      },
      cancellation: {
        jobIdRequired: true,
        cooperativeAbort: true,
        processGroupKill: true,
        killGraceMs: 5_000,
      },
    },
  };
}

function createRunnerInput(
  overrides: Partial<Pick<AgentRunInput, "signal">> = {},
): AgentRunInput {
  return {
    issue: {
      id: "issue-807",
      identifier: "SYMPH-807",
      title: "Add deterministic crabrunner scheduler backend",
      description: null,
      priority: 1,
      state: "In Progress",
      branchName: "codex/SYMPH-807",
      url: null,
      labels: [],
      blockedBy: [],
      createdAt: null,
      updatedAt: null,
    },
    attempt: null,
    stageName: "implement",
    ...overrides,
  };
}
