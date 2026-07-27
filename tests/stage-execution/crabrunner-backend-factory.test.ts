import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import type { AgentRunInput } from "../../src/agent/runner.js";
import type { StageExecutionJobSpec } from "../../src/stage-execution/backend.js";
import {
  createCrabrunnerStageExecutionBackend,
  createCrabrunnerStageExecutionBackends,
} from "../../src/stage-execution/crabrunner-backend-factory.js";
import type { CrabrunnerCli } from "../../src/stage-execution/crabrunner-scheduler-client.js";
import { materializedReady } from "./collected-artifact-fixtures.js";

describe("createCrabrunnerStageExecutionBackend", () => {
  it("builds a backend tagged crabrunner", () => {
    const backend = createCrabrunnerStageExecutionBackend({
      crucibleRoot: "/tmp/crucible",
      targetRepoRoot: "/tmp/repo",
      cli: neverCalledCli,
    });

    expect(backend.backend).toBe("crabrunner");
  });

  it("round-trips submit -> status -> collect through an injected fake cli", async () => {
    const usageDir = await mkdtemp(join(tmpdir(), "crabrunner-factory-"));
    const promptPath = join(usageDir, "prompt.md");
    const artifactPath = join(usageDir, "artifact.json");
    const usagePath = join(usageDir, "usage.json");
    await writeFile(artifactPath, JSON.stringify({ ok: true }), "utf8");
    await writeFile(promptPath, "factory round-trip prompt", "utf8");
    await writeFile(
      usagePath,
      JSON.stringify({
        schema: "crucible.lane-worker.usage.v2",
        measurement_kind: "true",
        input_tokens: 7,
        output_tokens: 4,
        total_tokens: 11,
      }),
      "utf8",
    );

    const calls: string[] = [];
    const cli: CrabrunnerCli = async (args) => {
      calls.push(args[0] ?? "");
      switch (args[0]) {
        case "submit":
          return ok(
            statusJson({ state: "queued", job_id: "rt", collectible: false }),
          );
        case "status":
          return ok(
            statusJson({ state: "complete", job_id: "rt", collectible: true }),
          );
        case "collect":
          return ok(
            JSON.stringify({
              schema: "crucible.crabrunner.collect.v1",
              job_id: "rt",
              attempt_id: "0",
              state: "complete",
              status: statusObject({
                state: "complete",
                job_id: "rt",
                collectible: true,
                artifact_path: artifactPath,
                usage_path: usagePath,
              }),
              archive_path: "/tmp/rt.tgz",
              materialized: materializedReady("rt"),
            }),
          );
        default:
          throw new Error(`unexpected subcommand ${args[0]}`);
      }
    };

    const backend = createCrabrunnerStageExecutionBackend({
      crucibleRoot: "/tmp/crucible",
      targetRepoRoot: "/tmp/repo",
      pollIntervalMs: 0,
      resolvePromptFile: () => promptPath,
      cli,
    });

    const result = await backend.execute({
      job: createJob(),
      runnerInput: createRunnerInput(),
    });

    expect(calls).toEqual(["submit", "status", "collect"]);
    expect(result.result.runAttempt.status).toBe("succeeded");
    expect(result.result.liveSession.usageMeasurement?.tokens).toMatchObject({
      inputTokens: 7,
      outputTokens: 4,
      totalTokens: 11,
    });
    expect(result.evidence?.promptSha256).toHaveLength(64);
  });
});

describe("createCrabrunnerStageExecutionBackends", () => {
  it("returns a map with only the crabrunner entry", () => {
    const map = createCrabrunnerStageExecutionBackends({
      crucibleRoot: "/tmp/crucible",
      targetRepoRoot: "/tmp/repo",
      cli: neverCalledCli,
    });

    expect([...map.keys()]).toEqual(["crabrunner"]);
    expect(map.get("crabrunner")?.backend).toBe("crabrunner");
  });

  it("forwards one literal slot pool argument through a built remote backend", async () => {
    const invocations: string[][] = [];
    const cli: CrabrunnerCli = async (args) => {
      invocations.push([...args]);
      const jobId = args[args.indexOf("--job-id") + 1]!;
      const status = statusObject({
        state: "complete",
        job_id: jobId,
        collectible: true,
      });
      return ok(
        JSON.stringify({
          schema: "crucible.crabrunner.run-result.v1",
          job_id: jobId,
          attempt_id: "0",
          host: "pro16",
          state: "complete",
          status,
          collect: {
            schema: "crucible.crabrunner.collect.v1",
            job_id: jobId,
            attempt_id: "0",
            state: "complete",
            status,
            archive_path: `/tmp/${jobId}.tgz`,
            materialized: materializedReady(jobId),
          },
        }),
      );
    };
    const map = createCrabrunnerStageExecutionBackends({
      crucibleRoot: "/tmp/crucible",
      targetRepoRoot: "/tmp/repo",
      host: "pro16",
      remoteUser: "operator",
      remoteStaticSlots: ["static_pro16-slot0", "static_pro16-slot1"],
      resolvePromptFile: () => "/tmp/prompt.md",
      hashPromptFile: () => "a".repeat(64),
      cli,
    });

    const result = await map.get("crabrunner")!.execute({
      job: createJob(),
      runnerInput: createRunnerInput(),
    });

    expect(result.result.runAttempt.status).toBe("succeeded");
    expect(invocations).toHaveLength(1);
    expect(invocations[0]?.[0]).toBe("run");
    expect(
      invocations[0]?.filter((arg) => arg === "--static-slots-json"),
    ).toHaveLength(1);
    const slotArgIndex = invocations[0]!.indexOf("--static-slots-json");
    expect(invocations[0]?.[slotArgIndex + 1]).toBe(
      '["static_pro16-slot0","static_pro16-slot1"]',
    );
  });
});

const neverCalledCli: CrabrunnerCli = async () => {
  throw new Error("cli should not be called");
};

function ok(stdout: string): {
  stdout: string;
  stderr: string;
  exitCode: number;
} {
  return { stdout, stderr: "", exitCode: 0 };
}

function statusObject(fields: {
  state: string;
  job_id: string;
  collectible: boolean;
  artifact_path?: string;
  usage_path?: string;
}): Record<string, unknown> {
  return {
    schema: "crucible.crabrunner.status.v1",
    job_id: fields.job_id,
    attempt_id: "0",
    crabrunner_version: "dev",
    state: fields.state,
    message: null,
    host: "local",
    updated_at: "2026-06-21T10:00:00.000Z",
    artifact_path: fields.artifact_path ?? "/tmp/artifact.json",
    usage_path: fields.usage_path ?? "/tmp/usage.json",
    collectible: fields.collectible,
  };
}

function statusJson(fields: Parameters<typeof statusObject>[0]): string {
  return JSON.stringify(statusObject(fields));
}

function createJob(): StageExecutionJobSpec {
  return {
    backend: "crabrunner",
    role: "implementer",
    phase: "implement",
    identity: {
      issueId: "issue-1",
      issueIdentifier: "SYMPH-1",
      stageName: "implement",
      stageAttempt: 0,
      runGroupId: "rg-1",
      profileId: "deterministic.crabrunner",
      baseRef: "abc",
      targetHeadRef: "codex/SYMPH-1",
      artifactRoot: "/tmp/artifacts/SYMPH-1",
      idempotencyKey: "stage-execution:SYMPH-1:implement:0:crabrunner:abcd",
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

function createRunnerInput(): AgentRunInput {
  return {
    issue: {
      id: "issue-1",
      identifier: "SYMPH-1",
      title: "Round-trip crabrunner backend",
      description: null,
      priority: 1,
      state: "In Progress",
      branchName: "codex/SYMPH-1",
      url: null,
      labels: [],
      blockedBy: [],
      createdAt: null,
      updatedAt: null,
    },
    attempt: null,
    stageName: "implement",
  };
}
