import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import type {
  StageExecutionBackendInput,
  StageExecutionJobSpec,
} from "../../src/stage-execution/backend.js";
import {
  type CrabrunnerJobSpec,
  CrabrunnerStageExecutionBackend,
  createCrabrunnerJobSpec,
} from "../../src/stage-execution/crabrunner-backend.js";
import {
  type CrabrunnerCli,
  CrabrunnerCliSchedulerClient,
  execFileCrabrunnerCli,
} from "../../src/stage-execution/crabrunner-scheduler-client.js";

const FIXTURE_DIR = join(
  process.cwd(),
  "tests/fixtures/stage-execution/crucible-execution-seam",
);
const LIVE_CRUCIBLE_ROOT =
  process.env.SYMPHONY_CRABRUNNER_ROOT ?? join(homedir(), "projects/crucible");
const LIVE_CRABRUNNER_BIN = join(LIVE_CRUCIBLE_ROOT, "bin/crabrunner");

describe("Crucible execution seam frozen real-output fixtures", () => {
  it("replays submit -> status -> collect through the Symphony consumer", async () => {
    const emittedManifests: Record<string, unknown>[] = [];
    const cli: CrabrunnerCli = async (args) => {
      switch (args[0]) {
        case "submit": {
          const manifestIndex = args.indexOf("--manifest-file");
          emittedManifests.push(
            JSON.parse(await readFile(args[manifestIndex + 1]!, "utf8")),
          );
          return ok(await fixture("live-submit.json"));
        }
        case "status":
          return ok(await fixture("live-status.json"));
        case "collect":
          return ok(await fixture("live-collect.json"));
        default:
          throw new Error(`unexpected crabrunner subcommand: ${args[0]}`);
      }
    };
    const client = new CrabrunnerCliSchedulerClient({
      crucibleRoot: LIVE_CRUCIBLE_ROOT,
      targetRepoRoot: process.cwd(),
      cli,
      pollIntervalMs: 0,
      maxPolls: 3,
      crabrunnerVersion: "symph-1071-conformance",
    });

    const admission = await client.submit(createSpec());
    expect(admission).toEqual({
      status: "accepted",
      jobId: "symph-1071-conformance-live",
    });
    await client.status(admission.jobId!);
    const terminal = await client.collect(admission.jobId!);

    expect(emittedManifests[0]?.workspace_identity).toEqual({
      runGroupId: "symph-1071-round-trip",
      stageAttempt: 2,
      idempotencyKey: "symph-1071:conformance:2",
      promptSha256:
        "95b9f06462d83e0e27b643a5f03f1f32ef298b2ef097f1e266b083752ae914ff",
    });
    expect(terminal).toMatchObject({
      state: "succeeded",
      artifact: { status: "ready" },
      usage: {
        status: "available",
        inputTokens: 3,
        outputTokens: 2,
        totalTokens: 5,
        reasoningTokens: 1,
      },
    });
  });

  it("diagnoses a synthetic lane failure from persisted artifacts alone", async () => {
    // Tabletop constraint: only the persisted manifest/status/collect files are
    // available. There is no process memory, stdout/stderr, or Symphony result.
    const manifest = JSON.parse(
      await fixture("synthetic-failure-manifest.json"),
    ) as Record<string, unknown>;
    const status = JSON.parse(
      await fixture("synthetic-failure-status.json"),
    ) as Record<string, unknown>;
    const collect = JSON.parse(
      await fixture("synthetic-failure-collect.json"),
    ) as Record<string, unknown>;
    const workspaceIdentity = manifest.workspace_identity as Record<
      string,
      unknown
    >;
    const materialized = collect.materialized as Record<string, unknown>;
    const client = new CrabrunnerCliSchedulerClient({
      crucibleRoot: LIVE_CRUCIBLE_ROOT,
      targetRepoRoot: process.cwd(),
      pollIntervalMs: 0,
      maxPolls: 1,
      cli: async (args) => {
        if (args[0] === "status") {
          return ok(JSON.stringify(status));
        }
        if (args[0] === "collect") {
          return ok(JSON.stringify(collect));
        }
        throw new Error(`unexpected tabletop subcommand: ${args[0]}`);
      },
    });

    await client.status(String(status.job_id));
    const terminal = await client.collect(String(status.job_id));

    expect({
      jobId: status.job_id,
      runGroupId: workspaceIdentity.runGroupId,
      stageAttempt: workspaceIdentity.stageAttempt,
      idempotencyKey: workspaceIdentity.idempotencyKey,
      promptSha256: workspaceIdentity.promptSha256,
      terminalState: collect.state,
      errorCode: status.error_code,
      artifactStatus: materialized.status,
      artifactReason: materialized.reason,
    }).toEqual({
      jobId: "symph-1071-synthetic-failure",
      runGroupId: "symph-1071-tabletop",
      stageAttempt: 3,
      idempotencyKey: "stage-execution:SYMPH-1071:implement:3:tabletop",
      promptSha256:
        "4da024810be1d60f36cb191de3afad2b474fb33e4e9c679f549c8e7a90b4745b",
      terminalState: "failed",
      errorCode: "turn_cap_reached",
      artifactStatus: "invalid",
      artifactReason: "primary artifact missing after turn-cap termination",
    });
    expect(terminal).toMatchObject({
      state: "turn_cap_reached",
      artifact: {
        status: "invalid",
        reason: "primary artifact missing after turn-cap termination",
      },
    });
  });
});

describe.skipIf(!existsSync(LIVE_CRABRUNNER_BIN))(
  "Crucible execution seam live submit -> status -> collect",
  () => {
    it("round-trips against a staged temporary state root without model calls", async () => {
      const stateRoot = await mkdtemp(
        join(tmpdir(), "symph-1071-live-conformance-"),
      );
      const promptDir = await mkdtemp(join(tmpdir(), "symph-1071-prompt-"));
      const promptPath = join(promptDir, "prompt.md");
      const prompt = "deterministic SYMPH-1071 execution seam prompt\n";
      await writeFile(promptPath, prompt, "utf8");
      const promptSha256 = createHash("sha256").update(prompt).digest("hex");
      const realCli = execFileCrabrunnerCli({
        crucibleRoot: LIVE_CRUCIBLE_ROOT,
      });
      const version = "symph-1071-conformance";
      const emittedManifests: Record<string, unknown>[] = [];

      try {
        const staged = await realCli(
          [
            "stage",
            "--version",
            version,
            "--state-root",
            stateRoot,
            "--repo-root",
            LIVE_CRUCIBLE_ROOT,
          ],
          { cwd: LIVE_CRUCIBLE_ROOT, timeoutMs: 120_000 },
        );
        expect(staged.exitCode, staged.stderr).toBe(0);

        const cli: CrabrunnerCli = async (args, opts) => {
          if (args[0] !== "submit") {
            return await realCli(args, opts);
          }
          const manifestIndex = args.indexOf("--manifest-file");
          const generated = JSON.parse(
            await readFile(args[manifestIndex + 1]!, "utf8"),
          ) as Record<string, unknown>;
          emittedManifests.push(generated);
          const deterministic: Record<string, unknown> = {
            ...generated,
            lane_worker_protocol: "worker-argv.v1",
            worker_argv: deterministicWorkerArgv(),
          };
          // JSON.stringify omits undefined values, yielding a valid
          // worker-argv manifest without mutating the production emitter.
          deterministic.prompt_file = undefined;
          deterministic.model = undefined;
          deterministic.thinking = undefined;
          deterministic.closeout_policy = undefined;
          const deterministicManifestPath = join(
            stateRoot,
            "symphony-live-manifest.json",
          );
          await writeFile(
            deterministicManifestPath,
            JSON.stringify(deterministic),
            "utf8",
          );
          const liveArgs = [...args];
          liveArgs[manifestIndex + 1] = deterministicManifestPath;
          return await realCli(liveArgs, opts);
        };
        const client = new CrabrunnerCliSchedulerClient({
          crucibleRoot: LIVE_CRUCIBLE_ROOT,
          targetRepoRoot: process.cwd(),
          stateRoot,
          crabrunnerVersion: version,
          pollIntervalMs: 50,
          cli,
        });
        const job = createStageExecutionJob();
        job.enforcement.timing.timeoutMs = 30_000;
        const backend = new CrabrunnerStageExecutionBackend({
          client,
          resolvePromptFile: () => promptPath,
          resolvePromptSha256: () => promptSha256,
        });
        const execution = await backend.execute({
          job,
          runnerInput: createRunnerInput(),
        });
        if (execution.evidence === undefined) {
          throw new Error("crabrunner backend omitted execution evidence");
        }
        const admission = execution.evidence.admission;
        const terminal = execution.evidence.terminal;
        expect(admission.status).toBe("accepted");
        expect(admission.jobId).toBeTruthy();
        expect(terminal).not.toBeNull();
        const persistedManifest = JSON.parse(
          await readFile(
            join(stateRoot, "jobs", admission.jobId!, "manifest.json"),
            "utf8",
          ),
        ) as Record<string, unknown>;

        expect(emittedManifests[0]?.workspace_identity).toEqual({
          runGroupId: "symph-1071-round-trip",
          stageAttempt: 2,
          idempotencyKey: "symph-1071:conformance:2",
          promptSha256,
        });
        expect(persistedManifest.workspace_identity).toEqual(
          emittedManifests[0]?.workspace_identity,
        );
        expect(terminal).toMatchObject({
          state: "succeeded",
          artifact: { status: "ready" },
          usage: {
            status: "available",
            totalTokens: 5,
            reasoningTokens: 1,
          },
          progress: {
            lastHeartbeatAt: expect.any(String),
            lastProgressAt: expect.any(String),
          },
        });
        expect(execution.result.lastTurn?.message).toBe(
          "deterministic execution seam conformance",
        );
        expect(execution.result.metadata).toEqual({
          agentMessage: "deterministic execution seam conformance",
          laneJobId: admission.jobId,
        });
      } finally {
        await Promise.all([
          rm(stateRoot, { recursive: true, force: true }),
          rm(promptDir, { recursive: true, force: true }),
        ]);
      }
    }, 120_000);
  },
);

function createSpec(
  overrides: Partial<
    Pick<CrabrunnerJobSpec, "promptFile" | "promptSha256">
  > = {},
): CrabrunnerJobSpec {
  return createCrabrunnerJobSpec(
    {
      job: createStageExecutionJob(),
      runnerInput: createRunnerInput(),
    },
    false,
    overrides.promptFile ?? "/sanitized/prompt.md",
    overrides.promptSha256 ??
      "95b9f06462d83e0e27b643a5f03f1f32ef298b2ef097f1e266b083752ae914ff",
  );
}

function createStageExecutionJob(): StageExecutionJobSpec {
  return {
    backend: "crabrunner",
    role: "implementer",
    phase: "implement",
    identity: {
      issueId: "issue-1071",
      issueIdentifier: "SYMPH-1071",
      stageName: "execution-seam",
      stageAttempt: 2,
      runGroupId: "symph-1071-round-trip",
      profileId: "deterministic.crabrunner",
      baseRef: "origin/main",
      targetHeadRef: "codex/SYMPH-1071-conformance-debuggability",
      artifactRoot: "/tmp/symph-1071-artifacts",
      idempotencyKey: "symph-1071:conformance:2",
    },
    runner: {
      runnerKind: "crabrunner-deterministic",
      model: "gpt-5-codex",
      provider: "openai",
      reasoningEffort: null,
    },
    enforcement: {
      required: true,
      budget: {
        maxTokens: 1_000,
        maxUsd: 1,
        estimatedCostPer1kTokensUsd: 0.01,
        cachedTokenCostRatio: 0,
        liveBudgetGraceRatio: 0.1,
      },
      timing: {
        timeoutMs: 30_000,
        stallTimeoutMs: 10_000,
        noProgressTurns: 2,
        maxIterations: 2,
      },
      telemetry: {
        heartbeatIntervalMs: 1_000,
        progressIntervalMs: 1_000,
        usageIntervalMs: 1_000,
      },
      cancellation: {
        jobIdRequired: true,
        cooperativeAbort: true,
        processGroupKill: true,
        killGraceMs: 1_000,
      },
    },
  };
}

function createRunnerInput(): StageExecutionBackendInput["runnerInput"] {
  return {
    issue: {
      id: "issue-1071",
      identifier: "SYMPH-1071",
      title: "Crucible execution-seam hardening",
      description: null,
      priority: 1,
      state: "In Progress",
      branchName: "codex/SYMPH-1071-conformance-debuggability",
      url: null,
      labels: [],
      blockedBy: [],
      createdAt: null,
      updatedAt: null,
    },
    attempt: 2,
    stageName: "execution-seam",
  };
}

function deterministicWorkerArgv(): string[] {
  const script = [
    'const { mkdirSync, writeFileSync } = require("node:fs");',
    'const { join } = require("node:path");',
    "const dir = process.env.CRABRUNNER_ARTIFACT_DIR;",
    "const name = process.env.CRABRUNNER_ARTIFACT_NAME;",
    "mkdirSync(dir, { recursive: true });",
    'writeFileSync(join(dir, name + ".progress.jsonl"), JSON.stringify({seq:1,ts:new Date().toISOString(),phase:"implement",type:"started",detail:null}) + "\\n");',
    'writeFileSync(join(dir, name + ".heartbeat.json"), JSON.stringify({seq:1,ts:new Date().toISOString(),phase:"implement",last_event:"started",detail:null}) + "\\n");',
    'writeFileSync(join(dir, name + ".md"), "deterministic execution seam conformance\\n");',
    'writeFileSync(join(dir, name + ".usage.json"), JSON.stringify({schema:"crucible.lane-worker.usage.v2",measurement_quality:"true",input_tokens:3,output_tokens:2,total_tokens:5,reasoning_output_tokens:1}) + "\\n");',
  ].join("\n");
  return [process.execPath, "-e", script];
}

async function fixture(name: string): Promise<string> {
  return await readFile(join(FIXTURE_DIR, name), "utf8");
}

function ok(stdout: string): {
  stdout: string;
  stderr: string;
  exitCode: number;
} {
  return { stdout, stderr: "", exitCode: 0 };
}
