import { createHash } from "node:crypto";
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
import { parseCrabrunnerStaticSlotsJson } from "../../src/stage-execution/crabrunner-static-slots.js";
import {
  artifactEntry,
  materializedReady,
  usageEntry,
} from "./collected-artifact-fixtures.js";

const CRUCIBLE_ROOT = "/tmp/crucible";
const TARGET_REPO_ROOT = "/tmp/target-repo";

describe("parseCrabrunnerStaticSlotsJson", () => {
  it("preserves absent configuration", () => {
    expect(parseCrabrunnerStaticSlotsJson(undefined)).toBeUndefined();
    expect(parseCrabrunnerStaticSlotsJson("   ")).toBeUndefined();
  });

  it("parses and trims a non-empty slot list", () => {
    expect(
      parseCrabrunnerStaticSlotsJson(
        '[" static_pro16-slot0 ","static_pro16-slot1"]',
      ),
    ).toEqual(["static_pro16-slot0", "static_pro16-slot1"]);
  });

  it.each(["not-json", "[]", '[" "]', "{}"])(
    "rejects invalid configured slot JSON: %s",
    (value) => {
      expect(() => parseCrabrunnerStaticSlotsJson(value)).toThrow(
        "SYMPHONY_CRABRUNNER_STATIC_SLOTS_JSON",
      );
    },
  );
});

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
    const repoRootIndex = submitCall.args.indexOf("--repo-root");
    expect(repoRootIndex).toBeGreaterThanOrEqual(0);
    expect(submitCall.args[repoRootIndex + 1]).toBe(CRUCIBLE_ROOT);
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
      async (args, _opts) => {
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
      {
        now: () => new Date("2026-06-21T10:00:00.000Z"),
        crabrunnerVersion: "test-version",
      },
    );

    await client.submit(
      createSpec({
        promptFile: "/tmp/render/prompt.md",
        promptSha256: "rendered-prompt-sha256",
      }),
    );

    expect(manifestPath).not.toBeNull();
    expect(manifestContent).not.toBeNull();
    const manifest = JSON.parse(manifestContent!) as Record<string, unknown>;
    expect(manifest).toMatchObject({
      schema: "crucible.crabrunner.job.v1",
      crabrunner_version: "test-version",
      lane_worker_protocol: "lane-worker.v1",
      provider: "local",
      target: "macos",
      phase: "implement",
      created_at: "2026-06-21T10:00:00.000Z",
      timeout_seconds: 600,
      profile: "write",
      remote_repo: CRUCIBLE_ROOT,
      workspace: TARGET_REPO_ROOT,
      prompt_file: "/tmp/render/prompt.md",
      thinking: "high",
      workspace_identity: {
        runGroupId: "rg-807",
        stageAttempt: 0,
        idempotencyKey:
          "stage-execution:SYMPH-807:implement:0:crabrunner:1234567890abcdef1234",
        promptSha256: "rendered-prompt-sha256",
      },
    });
    expect(manifest.issue_ids).toEqual(["SYMPH-807"]);
    expect(typeof manifest.job_id).toBe("string");
    expect((manifest.job_id as string).length).toBeGreaterThan(0);
    expect(manifest.lane_key).toBe(manifest.job_id);
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

  it("omits manifest thinking when reasoning effort is unset", async () => {
    let manifestContent: string | null = null;
    const client = createClient(async (args) => {
      const index = args.indexOf("--manifest-file");
      manifestContent = await readFile(args[index + 1]!, "utf8");
      return cliOk(
        statusJson({
          state: "queued",
          job_id: "job-manifest-no-thinking",
          collectible: false,
        }),
      );
    });

    await client.submit(createSpec({ reasoningEffort: null }));

    const manifest = JSON.parse(manifestContent!) as Record<string, unknown>;
    expect(manifest).not.toHaveProperty("thinking");
  });

  it("passes max thinking through to the lane manifest (SYMPH-1131)", async () => {
    let manifestContent: string | null = null;
    const client = createClient(async (args) => {
      const index = args.indexOf("--manifest-file");
      manifestContent = await readFile(args[index + 1]!, "utf8");
      return cliOk(
        statusJson({
          state: "queued",
          job_id: "job-manifest-max-thinking",
          collectible: false,
        }),
      );
    });

    await client.submit(createSpec({ reasoningEffort: "max" }));

    const manifest = JSON.parse(manifestContent!) as Record<string, unknown>;
    expect(manifest.thinking).toBe("max");
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
      remoteStaticSlots: ["static_studio1-slot0", "static_studio1-slot1"],
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
    expect(runCall.args[runCall.args.indexOf("--static-slots-json") + 1]).toBe(
      '["static_studio1-slot0","static_studio1-slot1"]',
    );
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
    expect(
      JSON.parse(
        runCall.args[runCall.args.indexOf("--workspace-identity-json") + 1]!,
      ),
    ).toEqual({
      runGroupId: "rg-807",
      stageAttempt: 0,
      idempotencyKey:
        "stage-execution:SYMPH-807:implement:0:crabrunner:1234567890abcdef1234",
    });
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
    expect(runCall.args[runCall.args.indexOf("--thinking") + 1]).toBe("high");
    expect(runCall.opts.cwd).toBe(CRUCIBLE_ROOT);
  });

  it("omits remote --thinking when reasoning effort is unset", async () => {
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
      cli,
    });

    await client.submit(createSpec({ reasoningEffort: null }));

    expect(invocations[0]?.args).not.toContain("--thinking");
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
    expect(calls).toBe(4);
  });

  it("grace-retries the terminal/collectible write race, then resolves", async () => {
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

  it("derives the local status poll budget from the submitted lane timeout", async () => {
    let statusCalls = 0;
    const client = createClient(
      staticCli({
        submit: () =>
          cliOk(
            statusJson({
              state: "queued",
              job_id: "derived-budget",
              collectible: false,
            }),
          ),
        status: () => {
          statusCalls += 1;
          return cliOk(
            statusJson({
              state: "running",
              job_id: "derived-budget",
              collectible: false,
            }),
          );
        },
      }),
      { pollIntervalMs: 1 },
    );
    const spec = createSpec();
    spec.enforcement.timing.timeoutMs = 3;

    await client.submit(spec);
    await expect(client.status("derived-budget")).rejects.toThrow(
      /within 7 status polls/,
    );
    expect(statusCalls).toBe(7);
  });

  it("throws on non-zero status exit", async () => {
    const client = createClient(
      staticCli({ status: () => ({ stdout: "", stderr: "x", exitCode: 2 }) }),
      { pollIntervalMs: 0 },
    );

    await expect(client.status("j")).rejects.toThrow(/exit/i);
  });

  it("parses structured crabrunner error payloads from stdout on non-zero exit", async () => {
    const client = createClient(
      staticCli({
        status: () => ({
          stdout: JSON.stringify({
            schema: "crucible.crabrunner.error.v1",
            error_code: "admission_lock_timeout",
            message: "admission lock remained held",
            lock_path: "/tmp/admission.lock",
          }),
          stderr: "crabrunner: admission lock remained held",
          exitCode: 1,
        }),
      }),
      { pollIntervalMs: 0 },
    );

    await expect(client.status("j")).rejects.toThrow(
      /admission_lock_timeout.*admission lock remained held.*lock_path/,
    );
  });

  it("observes heartbeat and progress mtimes during polling and returns them as terminal evidence", async () => {
    const { mkdtemp, mkdir, rm, utimes, writeFile } = await import(
      "node:fs/promises"
    );
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const stateRoot = await mkdtemp(join(tmpdir(), "crabrunner-liveness-"));
    const artifactDir = join(
      stateRoot,
      "jobs",
      "liveness-job",
      "attempts",
      "0",
      "artifact",
    );
    await mkdir(artifactDir, { recursive: true });
    const heartbeatPath = join(artifactDir, "implement.heartbeat.json");
    const progressPath = join(artifactDir, "implement.progress.jsonl");
    await writeFile(heartbeatPath, '{"seq":2}\n', "utf8");
    await writeFile(progressPath, '{"seq":1}\n{"seq":2}\n', "utf8");
    await utimes(
      heartbeatPath,
      new Date("2026-07-09T12:00:00.000Z"),
      new Date("2026-07-09T12:00:00.000Z"),
    );
    await utimes(
      progressPath,
      new Date("2026-07-09T12:00:01.000Z"),
      new Date("2026-07-09T12:00:01.000Z"),
    );
    const relativeArtifactPath = "attempts/0/artifact/implement.md";
    const terminalStatus = statusObject({
      state: "complete",
      job_id: "liveness-job",
      collectible: true,
    });
    let statusCalls = 0;
    const client = createClient(
      staticCli({
        status: async () => {
          statusCalls += 1;
          if (statusCalls === 1) {
            return cliOk(
              statusJson({
                state: "running",
                job_id: "liveness-job",
                collectible: false,
                artifact_path: relativeArtifactPath,
              }),
            );
          }
          await rm(heartbeatPath, { force: true });
          await rm(progressPath, { force: true });
          return cliOk(JSON.stringify(terminalStatus));
        },
        collect: () =>
          cliOk(
            collectJson({
              state: "complete",
              status: terminalStatus,
              archive_path: "/tmp/liveness-job.tgz",
            }),
          ),
      }),
      { pollIntervalMs: 0, stateRoot },
    );

    try {
      await client.status("liveness-job");
      const evidence = await client.collect("liveness-job");
      expect(statusCalls).toBe(2);
      expect(evidence.progress).toMatchObject({
        lastHeartbeatAt: "2026-07-09T12:00:00.000Z",
        lastProgressAt: "2026-07-09T12:00:01.000Z",
      });
    } finally {
      await rm(stateRoot, { recursive: true, force: true });
    }
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
  it("maps cached remote run evidence to materialized artifacts and workspace-sync refs", async () => {
    const { mkdtemp, writeFile } = await import("node:fs/promises");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const artifactDir = await mkdtemp(join(tmpdir(), "crabrunner-remote-"));
    const artifactContent = "# result\n";
    const usage = {
      schema: "crucible.lane-worker.usage.v2",
      measurement_kind: "true",
      input_tokens: 10,
      output_tokens: 5,
      total_tokens: 15,
    };
    const workspaceSyncContent = '{"ok":true}\n';
    const cli: CrabrunnerCli = async (args) => {
      const jobId = args[args.indexOf("--job-id") + 1]!;
      const workspaceSyncPath = join(
        artifactDir,
        `${jobId}.workspace-sync.json`,
      );
      await writeFile(workspaceSyncPath, workspaceSyncContent, "utf8");
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
          collect: JSON.parse(
            collectJson({
              state: "complete",
              status,
              archive_path: join(artifactDir, `${jobId}.tar`),
              materialized: materializedReady(
                jobId,
                "artifact/result.md",
                artifactContent,
                [
                  usageEntry(
                    "attempts/01/artifact/remote-materialization-canary.usage.json",
                    usage,
                  ),
                ],
              ),
            }),
          ),
          workspaceSyncPath,
          workspaceSyncSha256: sha256(workspaceSyncContent),
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
    expect(evidence.artifact).toMatchObject({
      status: "ready",
      primary: {
        name: "artifact/result.md",
        content: artifactContent,
        hash: sha256(artifactContent),
      },
    });
    expect(evidence.workspaceSyncRef).toEqual({
      path: join(artifactDir, `${admission.jobId!}.workspace-sync.json`),
      sha256: sha256(workspaceSyncContent),
    });
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

  it("fails closed when remote workspace-sync metadata does not match the downloaded file", async () => {
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
      await writeFile(archivePath, "legacy archive bytes", "utf8");
      await writeFile(workspaceSyncPath, '{"ok":true}\n', "utf8");
      return cliOk(
        runResultJson({
          state: "complete",
          job_id: jobId,
          workspaceSyncPath,
          workspaceSyncSha256: sha256("different"),
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
    await expect(client.collect(admission.jobId!)).rejects.toThrow(
      /workspace-sync artifact hash mismatch/,
    );
  });

  it("fails closed when remote workspace-sync metadata is present but the downloaded file is missing", async () => {
    const { mkdtemp, writeFile } = await import("node:fs/promises");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const artifactDir = await mkdtemp(join(tmpdir(), "crabrunner-remote-"));
    const cli: CrabrunnerCli = async (args) => {
      const jobId = args[args.indexOf("--job-id") + 1]!;
      const archivePath = join(artifactDir, `${jobId}.tar`);
      await writeFile(archivePath, "legacy archive bytes", "utf8");
      return cliOk(
        runResultJson({
          state: "complete",
          job_id: jobId,
          workspaceSyncPath: join(artifactDir, `${jobId}.workspace-sync.json`),
          workspaceSyncSha256: sha256("expected workspace sync"),
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
    await expect(client.collect(admission.jobId!)).rejects.toThrow(
      /workspace-sync artifact missing/,
    );
  });

  it("downgrades a successful remote run when materialized artifact data is missing", async () => {
    const { mkdtemp } = await import("node:fs/promises");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const artifactDir = await mkdtemp(join(tmpdir(), "crabrunner-remote-"));
    const cli: CrabrunnerCli = async (args) => {
      const jobId = args[args.indexOf("--job-id") + 1]!;
      return cliOk(
        runResultJson({
          state: "complete",
          job_id: jobId,
          collect: {
            schema: "crucible.crabrunner.collect.v1",
            job_id: jobId,
            attempt_id: "attempt-1",
            state: "complete",
            status: statusObject({
              state: "complete",
              job_id: jobId,
              collectible: true,
            }),
            archive_path: `/remote/${jobId}.tar`,
          },
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
    const evidence = await client.collect(admission.jobId!);

    expect(evidence.state).toBe("artifact_parse_failed");
    expect(evidence.artifact).toEqual({
      status: "missing",
      jobId: admission.jobId!,
      entries: [],
      reason: "producer_predates_materialization",
    });
    expect(evidence.usage).toEqual({
      status: "unavailable",
      reason: "usage artifact not found in materialized collect artifact",
    });
    expect(evidence.message).toBe("producer_predates_materialization");
  });

  it("reports materialized collect usage failures as unavailable", async () => {
    const { mkdtemp } = await import("node:fs/promises");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");

    for (const [entries, reason] of [
      [
        [artifactEntry("attempts/01/artifact/result.md", "# result")],
        "usage artifact not found in materialized collect artifact",
      ],
      [
        [artifactEntry("attempts/01/artifact/result.usage.json", "not json")],
        "usage artifact in materialized collect is not valid JSON",
      ],
      [
        [
          usageEntry("attempts/01/artifact/result.usage.json", {
            schema: "unexpected.schema",
            measurement_kind: "true",
            input_tokens: 1,
            output_tokens: 1,
            total_tokens: 2,
          }),
        ],
        'unexpected usage schema "unexpected.schema"',
      ],
      [
        [
          usageEntry("attempts/01/artifact/result.usage.json", {
            input_tokens: "not-a-number",
          }),
        ],
        "usage artifact in materialized collect failed schema validation",
      ],
    ] as const) {
      const artifactDir = await mkdtemp(join(tmpdir(), "crabrunner-remote-"));
      const cli: CrabrunnerCli = async (args) => {
        const jobId = args[args.indexOf("--job-id") + 1]!;
        const status = statusObject({
          state: "complete",
          job_id: jobId,
          collectible: true,
        });
        return cliOk(
          runResultJson({
            state: "complete",
            job_id: jobId,
            status,
            collect: JSON.parse(
              collectJson({
                state: "complete",
                status,
                archive_path: join(artifactDir, `${jobId}.tar`),
                materialized: materializedReady(
                  jobId,
                  "artifact/result.md",
                  "# result",
                  entries,
                ),
              }),
            ),
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
      const evidence = await client.collect(admission.jobId!);

      expect(evidence.state).toBe("succeeded");
      expect(evidence.usage).toEqual({ status: "unavailable", reason });
    }
  });

  it("maps complete -> succeeded with materialized usage and artifact data", async () => {
    const artifactContent = '{"ok":true}\n';
    const usage = {
      schema: "crucible.lane-worker.usage.v2",
      measurement_kind: "true",
      input_tokens: 100,
      output_tokens: 40,
      total_tokens: 140,
    };
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
                artifact_path: "/legacy/artifact.json",
                usage_path: "/legacy/usage.json",
                collect_archive: "/legacy/archive.tgz",
              }),
              archive_path: "/legacy/archive.tgz",
              materialized: materializedReady(
                "jc",
                "artifact/result.md",
                artifactContent,
                [usageEntry("attempts/01/artifact/result.usage.json", usage)],
              ),
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
    expect(evidence.artifact).toMatchObject({
      status: "ready",
      primary: {
        name: "artifact/result.md",
        content: artifactContent,
        hash: sha256(artifactContent),
      },
    });
  });

  it("prefers canonical measurement_quality and ingests reasoning_output_tokens", async () => {
    const client = createClient(
      staticCli({
        collect: () =>
          cliOk(
            collectJson({
              state: "complete",
              status: statusObject({
                state: "complete",
                job_id: "canonical-usage",
                collectible: true,
              }),
              archive_path: "/tmp/canonical-usage.tgz",
              materialized: materializedReady(
                "canonical-usage",
                "artifact/result.md",
                "{}",
                [
                  usageEntry("attempts/01/artifact/result.usage.json", {
                    schema: "crucible.lane-worker.usage.v2",
                    measurement_quality: "estimated",
                    measurement_kind: "proxy",
                    input_tokens: 25,
                    output_tokens: 10,
                    total_tokens: 35,
                    reasoning_output_tokens: 7,
                  }),
                ],
              ),
            }),
          ),
      }),
    );

    const evidence = await client.collect("canonical-usage");

    expect(evidence.usage).toEqual({
      status: "available",
      inputTokens: 25,
      outputTokens: 10,
      totalTokens: 35,
      reasoningTokens: 7,
      measurementQuality: "estimated",
    });
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

  it("maps documented named failure and terminal codes without substring collisions", async () => {
    for (const [errorCode, expected] of [
      ["budget_exceeded", "budget_exceeded"],
      ["timeout", "timed_out"],
      ["turn_cap_reached", "turn_cap_reached"],
      ["cancellation", "canceled"],
      ["artifact_parse_failure", "artifact_parse_failed"],
      ["admission_lock_timeout", "runner_failed"],
      ["staging_lock_timeout", "runner_failed"],
      ["stall_timeout", "runner_failed"],
      ["kill_failed", "runner_failed"],
      ["something_else", "runner_failed"],
    ] as const) {
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
              materialized: {
                status: "missing",
                jobId: "j",
                entries: [],
                reason: "producer_predates_materialization",
              },
            }),
          ),
      }),
    );

    const evidence = await client.collect("j");
    expect(evidence.state).toBe("artifact_parse_failed");
  });

  it("returns unavailable usage (never zero) when the usage file is missing", async () => {
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
              }),
              archive_path: "/tmp/a.tgz",
              materialized: materializedReady("j", "artifact/result.md", "{}", [
                usageEntry("attempts/01/artifact/result.usage.json", {
                  schema: "crucible.lane-worker.usage.v2",
                  measurement_kind: "proxy",
                  char_count: 9999,
                  input_tokens: 0,
                  output_tokens: 0,
                }),
              ]),
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

  it("prefers materialized entries over legacy job-relative artifact/usage paths", async () => {
    const { mkdtemp } = await import("node:fs/promises");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const stateRoot = await mkdtemp(join(tmpdir(), "crabrunner-state-"));
    const jobId = "smoke-pro14-0";
    const absoluteArchive = join(stateRoot, "jobs", jobId, "collect.tgz");
    const usage = {
      schema: "crucible.lane-worker.usage.v2",
      measurement_kind: "true",
      input_tokens: 5,
      output_tokens: 3,
      total_tokens: 8,
    };

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
              materialized: materializedReady(
                jobId,
                "attempts/01/artifact/result.md",
                "# result",
                [usageEntry("attempts/01/artifact/result.usage.json", usage)],
              ),
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
    expect(evidence.artifact).toMatchObject({
      status: "ready",
      primary: { name: "attempts/01/artifact/result.md" },
    });
  });

  it("maps the simple {available:false,reason} usage shape to unavailable", async () => {
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
              }),
              archive_path: "/tmp/a.tgz",
              materialized: materializedReady(
                "smoke",
                "artifact/result.md",
                "{}",
                [
                  usageEntry("attempts/01/artifact/result.usage.json", {
                    available: false,
                    reason: "smoke job does not run a model",
                  }),
                ],
              ),
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
              }),
              archive_path: "/tmp/a.tgz",
              materialized: materializedReady(
                "smoke2",
                "artifact/result.md",
                "{}",
                [
                  usageEntry("attempts/01/artifact/result.usage.json", {
                    available: true,
                    inputTokens: 21,
                    outputTokens: 9,
                    totalTokens: 30,
                  }),
                ],
              ),
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

  it("maps an already-terminal complete status to canceled with killed:false", async () => {
    const client = createClient(
      staticCli({
        cancel: () =>
          cliOk(
            statusJson({
              state: "complete",
              job_id: "j",
              collectible: true,
              message: "completed before cancellation",
            }),
          ),
      }),
    );

    const evidence = await client.cancel("j", cancelRequest());

    expect(evidence).toMatchObject({
      state: "canceled",
      cancellation: {
        requested: true,
        killed: false,
        failure: null,
      },
    });
  });

  it("settles an initially stopping cancel response before reporting delivery", async () => {
    const client = createClient(
      staticCli({
        cancel: () =>
          cliOk(
            statusJson({
              state: "stopping",
              job_id: "j",
              collectible: false,
              message: "cancel requested",
            }),
          ),
        status: () =>
          cliOk(
            statusJson({
              state: "stopped",
              job_id: "j",
              collectible: true,
              message: "worker stopped",
            }),
          ),
      }),
    );

    const evidence = await client.cancel("j", cancelRequest());

    expect(evidence.state).toBe("canceled");
    expect(evidence.cancellation).toMatchObject({
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

  it("persists poll liveness when the local status budget is exhausted", async () => {
    const { mkdtemp, mkdir, rm, utimes, writeFile } = await import(
      "node:fs/promises"
    );
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const stateRoot = await mkdtemp(join(tmpdir(), "crabrunner-timeout-"));
    const artifactDir = join(
      stateRoot,
      "jobs",
      "poll-timeout",
      "attempts",
      "0",
      "artifact",
    );
    await mkdir(artifactDir, { recursive: true });
    const heartbeatPath = join(artifactDir, "implement.heartbeat.json");
    const progressPath = join(artifactDir, "implement.progress.jsonl");
    await writeFile(heartbeatPath, '{"seq":1}\n', "utf8");
    await writeFile(progressPath, '{"seq":1}\n', "utf8");
    await utimes(
      heartbeatPath,
      new Date("2026-07-09T12:00:00.000Z"),
      new Date("2026-07-09T12:00:00.000Z"),
    );
    await utimes(
      progressPath,
      new Date("2026-07-09T12:00:01.000Z"),
      new Date("2026-07-09T12:00:01.000Z"),
    );
    const client = createClient(
      staticCli({
        submit: () =>
          cliOk(
            statusJson({
              state: "queued",
              job_id: "poll-timeout",
              collectible: false,
            }),
          ),
        status: () =>
          cliOk(
            statusJson({
              state: "running",
              job_id: "poll-timeout",
              collectible: false,
              artifact_path: "attempts/0/artifact/implement.md",
            }),
          ),
      }),
      { pollIntervalMs: 0, maxPolls: 1, stateRoot },
    );
    const backend = new CrabrunnerStageExecutionBackend({
      client,
      resolvePromptFile: () => "/tmp/prompt.md",
    });

    try {
      const result = await backend.execute({
        job: createJob(),
        runnerInput: createRunnerInput(),
      });

      expect(result.evidence?.terminal).toMatchObject({
        state: "runner_failed",
        progress: {
          lastHeartbeatAt: "2026-07-09T12:00:00.000Z",
          lastProgressAt: "2026-07-09T12:00:01.000Z",
        },
      });
      expect(result.result.liveSession.lastCodexMessage).toContain(
        '"lastProgressAt":"2026-07-09T12:00:01.000Z"',
      );
    } finally {
      await rm(stateRoot, { recursive: true, force: true });
    }
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

function createClient(
  cli: CrabrunnerCli,
  overrides: {
    pollIntervalMs?: number;
    maxPolls?: number;
    now?: () => Date;
    crabrunnerVersion?: string;
    stateRoot?: string;
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
    ...(overrides.crabrunnerVersion === undefined
      ? {}
      : { crabrunnerVersion: overrides.crabrunnerVersion }),
    ...(overrides.stateRoot === undefined
      ? {}
      : { stateRoot: overrides.stateRoot }),
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
  materialized?: unknown;
}): string {
  return JSON.stringify({
    schema: "crucible.crabrunner.collect.v1",
    job_id: fields.status.job_id,
    attempt_id: "attempt-1",
    state: fields.state,
    status: fields.status,
    archive_path: fields.archive_path,
    materialized:
      fields.materialized ??
      materializedReady(String(fields.status.job_id), "artifact/result.md"),
  });
}

function runResultJson(fields: {
  state: string;
  job_id: string;
  status?: Record<string, unknown>;
  collect?: Record<string, unknown>;
  workspaceSyncPath?: string;
  workspaceSyncSha256?: string;
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
            sha256: fields.workspaceSyncSha256 ?? "sha256",
          },
        }),
  });
}

async function writeArtifactFixtures(input: {
  artifact: unknown;
  usage?: unknown;
}): Promise<{ dir: string; artifactPath: string; usagePath: string }> {
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
  return { dir, artifactPath, usagePath };
}

function sha256(content: string | Buffer): string {
  return createHash("sha256").update(content).digest("hex");
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
  overrides: {
    promptFile?: string | null;
    promptSha256?: string;
    reasoningEffort?: StageExecutionJobSpec["runner"]["reasoningEffort"];
  } = {},
): CrabrunnerJobSpec {
  const job = createJob();
  const base = createCrabrunnerJobSpec(
    {
      job:
        overrides.reasoningEffort === undefined
          ? job
          : {
              ...job,
              runner: {
                ...job.runner,
                reasoningEffort: overrides.reasoningEffort,
              },
            },
      runnerInput: createRunnerInput(),
    },
    false,
  );
  if (overrides.promptFile === null) {
    return base;
  }
  return {
    ...base,
    promptFile: overrides.promptFile ?? "/tmp/prompt.md",
    ...(overrides.promptSha256 === undefined
      ? {}
      : { promptSha256: overrides.promptSha256 }),
  };
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
