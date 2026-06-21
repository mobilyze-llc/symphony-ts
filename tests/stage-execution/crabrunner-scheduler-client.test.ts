import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

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
    // --repo-root is the CRUCIBLE checkout, not the target repo (Codex P1-1).
    const repoRootIndex = submitCall.args.indexOf("--repo-root");
    expect(repoRootIndex).toBeGreaterThanOrEqual(0);
    expect(submitCall.args[repoRootIndex + 1]).toBe(CRUCIBLE_ROOT);
    // --state-root is always forwarded (DeepSeek P2-4).
    expect(submitCall.args).toContain("--state-root");
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

    await client.submit(createSpec({ promptFile: "/tmp/render/prompt.md" }));

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
      // remote_repo is the CRUCIBLE checkout; workspace is the TARGET repo
      // (Codex P1-1).
      remote_repo: CRUCIBLE_ROOT,
      workspace: TARGET_REPO_ROOT,
      prompt_file: "/tmp/render/prompt.md",
    });
    expect(manifest.issue_ids).toEqual(["SYMPH-807"]);
    expect(typeof manifest.job_id).toBe("string");
    expect((manifest.job_id as string).length).toBeGreaterThan(0);
    expect(manifest.lane_key).toBe(manifest.job_id);
    // Temp manifest must be cleaned up after submit returns.
    await expect(readFile(manifestPath!, "utf8")).rejects.toThrow();
  });

  it("uses the shared default timeout for local manifests with null timeout metadata", async () => {
    let manifestContent: string | null = null;
    const client = createClient(async (args) => {
      const index = args.indexOf("--manifest-file");
      manifestContent = await readFile(args[index + 1]!, "utf8");
      return cliOk(
        statusJson({
          state: "queued",
          job_id: "job-manifest-default-timeout",
          collectible: false,
        }),
      );
    });

    await client.submit(nullTimeout(createSpec()));

    const manifest = JSON.parse(manifestContent!) as Record<string, unknown>;
    expect(manifest.timeout_seconds).toBe(120);
  });

  it("rejects (fail closed) when the spec carries no promptFile (SYMPH-856)", async () => {
    const recorder = createCliRecorder({
      submit: () =>
        cliOk(
          statusJson({
            state: "queued",
            job_id: "should-not-submit",
            collectible: false,
          }),
        ),
    });
    const client = createClient(recorder.cli);

    const admission = await client.submit(createSpec({ promptFile: null }));

    expect(admission).toEqual({
      status: "rejected",
      jobId: null,
      reason: "crabrunner_prompt_required_symph_856",
    });
    // The CLI must never be invoked for an unrunnable manifest.
    expect(recorder.invocations).toEqual([]);
  });

  it("rejects non-local hosts until remote materialization config is present (SYMPH-864)", async () => {
    const recorder = createCliRecorder({
      run: () =>
        cliOk(
          runResultJson({
            state: "complete",
            job_id: "should-not-run",
          }),
        ),
    });
    const client = new CrabrunnerCliSchedulerClient({
      crucibleRoot: CRUCIBLE_ROOT,
      targetRepoRoot: TARGET_REPO_ROOT,
      host: "crabbox-studio1",
      cli: recorder.cli,
    });

    const admission = await client.submit(createSpec());

    expect(admission).toEqual({
      status: "rejected",
      jobId: null,
      reason: "crabrunner_remote_user_required_symph_864",
    });
    expect(recorder.invocations).toEqual([]);
  });

  it("rejects remote hosts with no prompt before invoking crabrunner", async () => {
    const recorder = createCliRecorder({
      run: () =>
        cliOk(
          runResultJson({
            state: "complete",
            job_id: "should-not-run",
          }),
        ),
    });
    const client = new CrabrunnerCliSchedulerClient({
      crucibleRoot: CRUCIBLE_ROOT,
      targetRepoRoot: TARGET_REPO_ROOT,
      host: "crabbox-studio1",
      remoteUser: "ericlitman",
      cli: recorder.cli,
    });

    const admission = await client.submit(createSpec({ promptFile: null }));

    expect(admission).toEqual({
      status: "rejected",
      jobId: null,
      reason: "crabrunner_prompt_required_symph_856",
    });
    expect(recorder.invocations).toEqual([]);
  });

  it("uses crabrunner run with workspace materialization for configured remote hosts", async () => {
    const invocations: CrabrunnerCliInvocation[] = [];
    const cli: CrabrunnerCli = async (args, opts) => {
      invocations.push({ args: [...args], opts });
      const jobId = args[args.indexOf("--job-id") + 1]!;
      return cliOk(runResultJson({ state: "complete", job_id: jobId }));
    };
    const client = new CrabrunnerCliSchedulerClient({
      crucibleRoot: CRUCIBLE_ROOT,
      targetRepoRoot: TARGET_REPO_ROOT,
      host: "crabbox-studio1",
      remoteUser: "ericlitman",
      remotePort: "2222",
      remoteWorkRoot: "/Users/ericlitman/.crabbox-static-work",
      remoteStateRoot: "~/.crucible/crabrunner",
      remoteRunArtifactDir: "/tmp/crabrunner-artifacts",
      crabboxBin: "/opt/crabbox/bin/crabbox",
      crabrunnerVersion: "test-version",
      cli,
    });

    await client.submit(createSpec({ promptFile: "/tmp/render/prompt.md" }));

    const runCall = invocations[0]!;
    expect(runCall.args[0]).toBe("run");
    expect(runCall.args).not.toContain("submit");
    expect(runCall.args).not.toContain("--manifest-file");
    expect(runCall.args).toContain("--host");
    expect(runCall.args[runCall.args.indexOf("--host") + 1]).toBe(
      "crabbox-studio1",
    );
    expect(runCall.args[runCall.args.indexOf("--user") + 1]).toBe("ericlitman");
    expect(runCall.args[runCall.args.indexOf("--repo-root") + 1]).toBe(
      CRUCIBLE_ROOT,
    );
    expect(runCall.args[runCall.args.indexOf("--workspace") + 1]).toBe(
      TARGET_REPO_ROOT,
    );
    expect(
      runCall.args[runCall.args.indexOf("--materialize-workspace-from") + 1],
    ).toBe(TARGET_REPO_ROOT);
    expect(runCall.args[runCall.args.indexOf("--prompt-file") + 1]).toBe(
      "/tmp/render/prompt.md",
    );
    expect(runCall.args[runCall.args.indexOf("--model") + 1]).toBe(
      "openai/gpt-5-codex",
    );
    expect(runCall.args[runCall.args.indexOf("--issue-ids-json") + 1]).toBe(
      JSON.stringify(["SYMPH-807"]),
    );
    expect(runCall.args[runCall.args.indexOf("--port") + 1]).toBe("2222");
    expect(runCall.args[runCall.args.indexOf("--work-root") + 1]).toBe(
      "/Users/ericlitman/.crabbox-static-work",
    );
    expect(runCall.args[runCall.args.indexOf("--state-root") + 1]).toBe(
      "~/.crucible/crabrunner",
    );
    expect(runCall.args[runCall.args.indexOf("--artifact-dir") + 1]).toBe(
      "/tmp/crabrunner-artifacts",
    );
    expect(runCall.args[runCall.args.indexOf("--crabbox-bin") + 1]).toBe(
      "/opt/crabbox/bin/crabbox",
    );
    expect(runCall.args[runCall.args.indexOf("--version") + 1]).toBe(
      "test-version",
    );
    expect(runCall.opts.cwd).toBe(CRUCIBLE_ROOT);
  });

  it("passes abort signals and a remote-sized subprocess timeout to crabrunner run", async () => {
    const controller = new AbortController();
    const invocations: CrabrunnerCliInvocation[] = [];
    const cli: CrabrunnerCli = async (args, opts) => {
      invocations.push({ args: [...args], opts });
      const jobId = args[args.indexOf("--job-id") + 1]!;
      return cliOk(runResultJson({ state: "complete", job_id: jobId }));
    };
    const client = new CrabrunnerCliSchedulerClient({
      crucibleRoot: CRUCIBLE_ROOT,
      targetRepoRoot: TARGET_REPO_ROOT,
      host: "crabbox-studio1",
      remoteUser: "ericlitman",
      cliTimeoutMs: 180_000,
      pollIntervalMs: 1_000,
      maxPolls: 10,
      cli,
    });

    await client.submit(createSpec(), controller.signal);

    expect(invocations[0]?.opts.signal).toBe(controller.signal);
    expect(invocations[0]?.opts.timeoutMs).toBe(670_000);
  });

  it("uses the same default timeout for remote lane args and subprocess budget", async () => {
    const invocations: CrabrunnerCliInvocation[] = [];
    const cli: CrabrunnerCli = async (args, opts) => {
      invocations.push({ args: [...args], opts });
      const jobId = args[args.indexOf("--job-id") + 1]!;
      return cliOk(runResultJson({ state: "complete", job_id: jobId }));
    };
    const client = new CrabrunnerCliSchedulerClient({
      crucibleRoot: CRUCIBLE_ROOT,
      targetRepoRoot: TARGET_REPO_ROOT,
      host: "crabbox-studio1",
      remoteUser: "ericlitman",
      cliTimeoutMs: 120_000,
      pollIntervalMs: 1_000,
      maxPolls: 10,
      cli,
    });

    await client.submit(nullTimeout(createSpec()));

    const runCall = invocations[0]!;
    expect(runCall.args[runCall.args.indexOf("--timeout-seconds") + 1]).toBe(
      "120",
    );
    expect(runCall.opts.timeoutMs).toBe(190_000);
  });

  it("does not pass the local state root as a remote state root by default", async () => {
    const invocations: CrabrunnerCliInvocation[] = [];
    const cli: CrabrunnerCli = async (args, opts) => {
      invocations.push({ args: [...args], opts });
      const jobId = args[args.indexOf("--job-id") + 1]!;
      return cliOk(runResultJson({ state: "complete", job_id: jobId }));
    };
    const client = new CrabrunnerCliSchedulerClient({
      crucibleRoot: CRUCIBLE_ROOT,
      targetRepoRoot: TARGET_REPO_ROOT,
      stateRoot: "/tmp/local-crabrunner-state",
      host: "crabbox-studio1",
      remoteUser: "ericlitman",
      cli,
    });

    await client.submit(createSpec());

    const runCall = invocations[0]!;
    expect(runCall.args).not.toContain("--state-root");
    expect(runCall.args[runCall.args.indexOf("--artifact-dir") + 1]).toBe(
      "/tmp/local-crabrunner-state/remote-artifacts",
    );
  });

  it("rejects configured remote prompt lanes when no model is available", async () => {
    const recorder = createCliRecorder({
      run: () =>
        cliOk(runResultJson({ state: "complete", job_id: "should-not-run" })),
    });
    const client = new CrabrunnerCliSchedulerClient({
      crucibleRoot: CRUCIBLE_ROOT,
      targetRepoRoot: TARGET_REPO_ROOT,
      host: "crabbox-studio1",
      remoteUser: "ericlitman",
      cli: recorder.cli,
    });

    const job = createJob();
    const base = createCrabrunnerJobSpec(
      {
        job: { ...job, runner: { ...job.runner, model: null } },
        runnerInput: createRunnerInput(),
      },
      false,
    );
    const specWithoutModel = { ...base, promptFile: "/tmp/prompt.md" };

    const admission = await client.submit(specWithoutModel);

    expect(admission).toEqual({
      status: "rejected",
      jobId: null,
      reason: "crabrunner_remote_model_required_symph_864",
    });
    expect(recorder.invocations).toEqual([]);
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

  it("throws when a terminal state stays not-collectible past the grace window", async () => {
    let calls = 0;
    const client = createClient(
      staticCli({
        status: () => {
          calls += 1;
          return cliOk(
            statusJson({ state: "failed", job_id: "j", collectible: false }),
          );
        },
      }),
      { pollIntervalMs: 0 },
    );

    await expect(client.status("j")).rejects.toThrow(/terminal/i);
    // Grace-retried up to STATUS_TERMINAL_GRACE_POLLS (3) extra polls => 4 total.
    expect(calls).toBe(4);
  });

  it("grace-retries the terminal/collectible write race, then resolves", async () => {
    // Daemon writes the terminal state before flipping collectible (DeepSeek P2-1).
    let calls = 0;
    const client = createClient(
      staticCli({
        status: () => {
          calls += 1;
          return cliOk(
            statusJson({
              state: "complete",
              job_id: "j",
              collectible: calls >= 2,
            }),
          );
        },
      }),
      { pollIntervalMs: 0 },
    );

    await expect(client.status("j")).resolves.toBeUndefined();
    expect(calls).toBe(2);
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

  it("fails closed when status returns a different job_id than requested (Codex Track)", async () => {
    const client = createClient(
      staticCli({
        status: () =>
          cliOk(
            statusJson({
              state: "complete",
              job_id: "some-other-job",
              collectible: true,
            }),
          ),
      }),
      { pollIntervalMs: 0 },
    );

    await expect(client.status("requested-job")).rejects.toThrow(
      /job_id.*some-other-job.*expected.*requested-job/i,
    );
  });

  it("aborts immediately when the signal is already aborted (no CLI call)", async () => {
    const controller = new AbortController();
    controller.abort();
    let calls = 0;
    const client = createClient(
      staticCli({
        status: () => {
          calls += 1;
          return cliOk(
            statusJson({ state: "running", job_id: "j", collectible: false }),
          );
        },
      }),
      { pollIntervalMs: 0 },
    );

    await expect(client.status("j", controller.signal)).rejects.toThrow(
      /abort/i,
    );
    expect(calls).toBe(0);
  });

  it("stops polling when the signal aborts between polls (no 30-min orphan)", async () => {
    const controller = new AbortController();
    let calls = 0;
    const client = createClient(
      staticCli({
        status: () => {
          calls += 1;
          // Abort right after the first poll; the abortable sleep must reject.
          controller.abort();
          return cliOk(
            statusJson({ state: "running", job_id: "j", collectible: false }),
          );
        },
      }),
      { pollIntervalMs: 1_000, maxPolls: 1_800 },
    );

    await expect(client.status("j", controller.signal)).rejects.toThrow(
      /abort/i,
    );
    expect(calls).toBe(1);
  });
});

describe("CrabrunnerCliSchedulerClient.collect", () => {
  it("maps cached remote run evidence to downloaded archive refs", async () => {
    const { mkdtemp, writeFile } = await import("node:fs/promises");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const artifactDir = await mkdtemp(join(tmpdir(), "crabrunner-remote-"));
    const cli: CrabrunnerCli = async (args) => {
      const jobId = args[args.indexOf("--job-id") + 1]!;
      const archivePath = join(artifactDir, `${jobId}.tar`);
      const workspaceSyncPath = join(
        artifactDir,
        `${jobId}.workspace-sync.json`,
      );
      await writeFile(
        archivePath,
        createTarBuffer({
          "attempts/01/artifact/remote-materialization-canary.usage.json":
            JSON.stringify({
              schema: "crucible.lane-worker.usage.v2",
              measurement_kind: "true",
              input_tokens: 10,
              output_tokens: 5,
              total_tokens: 15,
            }),
        }),
      );
      await writeFile(workspaceSyncPath, '{"ok":true}\n', "utf8");
      const status = statusObject({
        state: "complete",
        job_id: jobId,
        collectible: true,
        workspace:
          "/Users/ericlitman/.crucible/crabrunner/materialized/job/workspace",
      });
      return cliOk(
        runResultJson({
          state: "complete",
          job_id: jobId,
          status,
          workspaceSyncPath,
        }),
      );
    };
    const client = new CrabrunnerCliSchedulerClient({
      crucibleRoot: CRUCIBLE_ROOT,
      targetRepoRoot: TARGET_REPO_ROOT,
      host: "crabbox-studio1",
      remoteUser: "ericlitman",
      remoteRunArtifactDir: artifactDir,
      cli,
    });

    const admission = await client.submit(createSpec());
    await expect(client.status(admission.jobId!)).resolves.toBeUndefined();
    const evidence = await client.collect(admission.jobId!);

    expect(evidence.state).toBe("succeeded");
    expect(evidence.artifactRefs).toEqual([
      join(artifactDir, `${admission.jobId!}.tar`),
      join(artifactDir, `${admission.jobId!}.workspace-sync.json`),
    ]);
    expect(evidence.workspacePath).toBe(
      "/Users/ericlitman/.crucible/crabrunner/materialized/job/workspace",
    );
    expect(evidence.usage).toEqual({
      status: "available",
      inputTokens: 10,
      outputTokens: 5,
      totalTokens: 15,
    });
    await expect(client.status(admission.jobId!)).rejects.toThrow(
      /no cached run result/,
    );
  });

  it("downgrades a successful remote run when the downloaded archive is missing", async () => {
    const { mkdtemp } = await import("node:fs/promises");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const artifactDir = await mkdtemp(join(tmpdir(), "crabrunner-remote-"));
    const cli: CrabrunnerCli = async (args) => {
      const jobId = args[args.indexOf("--job-id") + 1]!;
      return cliOk(runResultJson({ state: "complete", job_id: jobId }));
    };
    const client = new CrabrunnerCliSchedulerClient({
      crucibleRoot: CRUCIBLE_ROOT,
      targetRepoRoot: TARGET_REPO_ROOT,
      host: "crabbox-studio1",
      remoteUser: "ericlitman",
      remoteRunArtifactDir: artifactDir,
      cli,
    });

    const admission = await client.submit(createSpec());
    const evidence = await client.collect(admission.jobId!);

    expect(evidence.state).toBe("artifact_parse_failed");
    expect(evidence.artifactRefs).toBeUndefined();
    expect(evidence.usage).toEqual({
      status: "unavailable",
      reason: "remote crabrunner collect archive missing or empty",
    });
    expect(evidence.message).toBe(
      "remote crabrunner collect archive missing or empty",
    );
  });

  it("reports remote collect archive usage failures as unavailable", async () => {
    const { mkdtemp, writeFile } = await import("node:fs/promises");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");

    for (const [entries, reason] of [
      [
        { "attempts/01/artifact/result.md": "# result" },
        "usage artifact not found in remote collect archive",
      ],
      [
        { "attempts/01/artifact/result.usage.json": "not json" },
        "usage artifact in remote collect archive is not valid JSON",
      ],
      [
        {
          "attempts/01/artifact/result.usage.json": JSON.stringify({
            schema: "unexpected.schema",
            measurement_kind: "true",
            input_tokens: 1,
            output_tokens: 1,
            total_tokens: 2,
          }),
        },
        'unexpected usage schema "unexpected.schema"',
      ],
      [
        {
          "attempts/01/artifact/result.usage.json": JSON.stringify({
            input_tokens: "not-a-number",
          }),
        },
        "usage artifact in remote collect archive failed schema validation",
      ],
    ] as const) {
      const artifactDir = await mkdtemp(join(tmpdir(), "crabrunner-remote-"));
      const cli: CrabrunnerCli = async (args) => {
        const jobId = args[args.indexOf("--job-id") + 1]!;
        await writeFile(
          join(artifactDir, `${jobId}.tar`),
          createTarBuffer(entries),
        );
        return cliOk(runResultJson({ state: "complete", job_id: jobId }));
      };
      const client = new CrabrunnerCliSchedulerClient({
        crucibleRoot: CRUCIBLE_ROOT,
        targetRepoRoot: TARGET_REPO_ROOT,
        host: "crabbox-studio1",
        remoteUser: "ericlitman",
        remoteRunArtifactDir: artifactDir,
        cli,
      });

      const admission = await client.submit(createSpec());
      const evidence = await client.collect(admission.jobId!);

      expect(evidence.state).toBe("succeeded");
      expect(evidence.usage).toEqual({ status: "unavailable", reason });
    }
  });

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

  it("aborts collect immediately when the signal is already aborted", async () => {
    const controller = new AbortController();
    controller.abort();
    let calls = 0;
    const client = createClient(
      staticCli({
        collect: () => {
          calls += 1;
          return cliOk(
            collectJson({
              state: "complete",
              status: statusObject({
                state: "complete",
                job_id: "j",
                collectible: true,
              }),
              archive_path: "/tmp/a.tgz",
            }),
          );
        },
      }),
    );

    await expect(client.collect("j", controller.signal)).rejects.toThrow(
      /abort/i,
    );
    expect(calls).toBe(0);
  });

  it("throws on non-zero collect exit", async () => {
    const client = createClient(
      staticCli({ collect: () => ({ stdout: "", stderr: "x", exitCode: 1 }) }),
    );

    await expect(client.collect("j")).rejects.toThrow(/exit/i);
  });

  it("fails closed when collect returns a different job_id than requested (Codex Track)", async () => {
    const client = createClient(
      staticCli({
        collect: () =>
          cliOk(
            collectJson({
              state: "complete",
              status: statusObject({
                state: "complete",
                job_id: "wrong-job",
                collectible: true,
              }),
              archive_path: "/tmp/a.tgz",
            }),
          ),
      }),
    );

    await expect(client.collect("right-job")).rejects.toThrow(
      /job_id.*wrong-job.*expected.*right-job/i,
    );
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

  it("treats non-terminal 'stopping' as kill_failed, not canceled (Codex P2 / DeepSeek P2-6)", async () => {
    const client = createClient(
      staticCli({
        cancel: () =>
          cliOk(
            statusJson({
              state: "stopping",
              job_id: "j",
              collectible: false,
              message: "still shutting down",
            }),
          ),
      }),
    );

    const evidence = await client.cancel("j", cancelRequest());

    expect(evidence.state).toBe("kill_failed");
    expect(evidence.cancellation).toMatchObject({
      killed: false,
      failure: "cancel_incomplete",
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
    const backend = new CrabrunnerStageExecutionBackend({
      client,
      resolvePromptFile: () => "/tmp/prompt.md",
    });

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

  it("fails closed through the backend when no promptFile is resolved (SYMPH-856)", async () => {
    const recorder = createCliRecorder({
      submit: () =>
        cliOk(statusJson({ state: "queued", job_id: "x", collectible: false })),
    });
    const client = new CrabrunnerCliSchedulerClient({
      crucibleRoot: CRUCIBLE_ROOT,
      targetRepoRoot: TARGET_REPO_ROOT,
      pollIntervalMs: 0,
      cli: recorder.cli,
    });
    // No resolvePromptFile => spec.promptFile absent => client rejects.
    const backend = new CrabrunnerStageExecutionBackend({ client });

    const result = await backend.execute({
      job: createJob(),
      runnerInput: createRunnerInput(),
    });

    expect(result.result.runAttempt.status).toBe("failed");
    expect(result.result.runAttempt.error).toContain(
      "crabrunner_prompt_required_symph_856",
    );
    expect(recorder.invocations).toEqual([]);
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
    const backend = new CrabrunnerStageExecutionBackend({
      client,
      resolvePromptFile: () => "/tmp/prompt.md",
    });

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
  run?: () => Promise<CliResult> | CliResult;
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
  workspace?: string;
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
    ...(fields.workspace === undefined ? {} : { workspace: fields.workspace }),
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

function runResultJson(fields: {
  state: string;
  job_id: string;
  status?: Record<string, unknown>;
  collect?: Record<string, unknown>;
  workspaceSyncPath?: string;
}): string {
  const status =
    fields.status ??
    statusObject({
      state: fields.state,
      job_id: fields.job_id,
      collectible: true,
    });
  return JSON.stringify({
    schema: "crucible.crabrunner.run-result.v1",
    job_id: fields.job_id,
    attempt_id: "attempt-1",
    host: "crabbox-studio1",
    state: fields.state,
    status,
    collect:
      fields.collect ??
      JSON.parse(
        collectJson({
          state: fields.state,
          status,
          archive_path: `/remote/${fields.job_id}.tar`,
        }),
      ),
    ...(fields.workspaceSyncPath === undefined
      ? {}
      : {
          workspace_sync_artifact: {
            schema: "crucible.crabrunner.workspace-sync-artifact-ref.v1",
            path: fields.workspaceSyncPath,
            sha256: "sha256",
          },
        }),
  });
}

function createTarBuffer(entries: Record<string, string>): Buffer {
  const chunks: Buffer[] = [];
  for (const [name, contents] of Object.entries(entries)) {
    const body = Buffer.from(contents, "utf8");
    const header = Buffer.alloc(512);
    header.write(name, 0, 100, "utf8");
    header.write("0000644\0", 100, 8, "ascii");
    header.write("0000000\0", 108, 8, "ascii");
    header.write("0000000\0", 116, 8, "ascii");
    header.write(`${body.length.toString(8).padStart(11, "0")}\0`, 124, 12);
    header.write("00000000000\0", 136, 12, "ascii");
    header.fill(" ", 148, 156);
    header.write("0", 156, 1, "ascii");
    header.write("ustar\0", 257, 6, "ascii");
    header.write("00", 263, 2, "ascii");
    let checksum = 0;
    for (const byte of header) {
      checksum += byte;
    }
    header.write(checksum.toString(8).padStart(6, "0"), 148, 6, "ascii");
    header[154] = 0;
    header[155] = 0x20;
    chunks.push(header, body);
    const padding = (512 - (body.length % 512)) % 512;
    if (padding > 0) {
      chunks.push(Buffer.alloc(padding));
    }
  }
  chunks.push(Buffer.alloc(1024));
  return Buffer.concat(chunks);
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

function createSpec(
  overrides: { promptFile?: string | null } = {},
): CrabrunnerJobSpec {
  const base = createCrabrunnerJobSpec(
    { job: createJob(), runnerInput: createRunnerInput() },
    false,
  );
  // Default to a present promptFile so submit-path tests are admitted; pass
  // { promptFile: null } to exercise the SYMPH-856 fail-closed rejection.
  if (overrides.promptFile === null) {
    return base;
  }
  return { ...base, promptFile: overrides.promptFile ?? "/tmp/prompt.md" };
}

function nullTimeout(spec: CrabrunnerJobSpec): CrabrunnerJobSpec {
  return {
    ...spec,
    enforcement: {
      ...spec.enforcement,
      timing: {
        ...spec.enforcement.timing,
        timeoutMs: null,
      },
    },
  };
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
