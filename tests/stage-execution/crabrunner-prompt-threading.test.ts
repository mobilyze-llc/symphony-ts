import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { beforeAll, describe, expect, it } from "vitest";

import type { AgentRunInput } from "../../src/agent/runner.js";
import type { StageDefinition } from "../../src/config/types.js";
import type { Issue } from "../../src/domain/model.js";
import type { StageExecutionJobSpec } from "../../src/stage-execution/backend.js";
import { createCrabrunnerStageExecutionBackend } from "../../src/stage-execution/crabrunner-backend-factory.js";
import {
  CRABRUNNER_JOB_SPEC_VERSION,
  type CrabrunnerJobSpec,
} from "../../src/stage-execution/crabrunner-backend.js";
import type { CrabrunnerCli } from "../../src/stage-execution/crabrunner-scheduler-client.js";

// SYMPH-856 — the default factory resolver renders the stage prompt and threads
// it into the delegated lane as a temp `prompt_file`, so a real-model delegated
// run can work. These tests drive the whole path through the real backend +
// scheduler client, capturing the emitted crabrunner manifest via a fake cli, so
// nothing spawns a subprocess or calls a model.

describe("crabrunner default prompt resolver (SYMPH-856)", () => {
  it("renders the workflow promptTemplate + issue context into a temp prompt_file and emits a lane-worker.v1 manifest", async () => {
    const capture = createManifestCaptureCli();
    const backend = createCrabrunnerStageExecutionBackend({
      crucibleRoot: "/tmp/crucible",
      targetRepoRoot: "/tmp/repo",
      pollIntervalMs: 0,
      cli: capture.cli,
      promptRendering: {
        promptTemplate:
          "Work on {{ issue.identifier }}: {{ issue.title }}\nState: {{ issue.state }}",
        workflowPath: "/tmp/workflow/WORKFLOW.md",
      },
    });

    const result = await backend.execute({
      job: createJob(),
      runnerInput: createRunnerInput(),
    });

    expect(result.result.runAttempt.status).toBe("succeeded");

    const manifest = capture.manifest();
    expect(manifest.lane_worker_protocol).toBe("lane-worker.v1");
    const promptFile = manifest.prompt_file;
    expect(typeof promptFile).toBe("string");
    expect((promptFile as string).length).toBeGreaterThan(0);

    const contents = await readFile(promptFile as string, "utf8");
    // strictVariables is on; the rendered prompt carries the issue context.
    expect(contents).toContain("Work on SYMPH-1: Thread the stage prompt");
    expect(contents).toContain("State: In Progress");
  });

  it("renders the SUB-STAGE/stage prompt when runnerInput.stage.prompt is set, overriding the workflow promptTemplate", async () => {
    const capture = createManifestCaptureCli();
    const backend = createCrabrunnerStageExecutionBackend({
      crucibleRoot: "/tmp/crucible",
      targetRepoRoot: "/tmp/repo",
      pollIntervalMs: 0,
      cli: capture.cli,
      promptRendering: {
        promptTemplate: "GLOBAL fallback for {{ issue.identifier }}",
        workflowPath: "/tmp/workflow/WORKFLOW.md",
      },
    });

    const runnerInput: AgentRunInput = {
      ...createRunnerInput(),
      stage: createStage("STAGE prompt wins for {{ issue.identifier }}"),
    };

    const result = await backend.execute({
      job: createJob(),
      runnerInput,
    });

    expect(result.result.runAttempt.status).toBe("succeeded");
    const contents = await readFile(
      capture.manifest().prompt_file as string,
      "utf8",
    );
    expect(contents).toContain("STAGE prompt wins for SYMPH-1");
    expect(contents).not.toContain("GLOBAL fallback");
  });

  it("fails closed when the template references an undefined variable (strictVariables) — no prompt_file written, job not succeeded", async () => {
    const capture = createManifestCaptureCli();
    const backend = createCrabrunnerStageExecutionBackend({
      crucibleRoot: "/tmp/crucible",
      targetRepoRoot: "/tmp/repo",
      pollIntervalMs: 0,
      cli: capture.cli,
      promptRendering: {
        // `nope` is not in the render context; strictVariables throws.
        promptTemplate: "Broken: {{ nope }}",
        workflowPath: "/tmp/workflow/WORKFLOW.md",
      },
    });

    const result = await backend.execute({
      job: createJob(),
      runnerInput: createRunnerInput(),
    });

    expect(result.result.runAttempt.status).toBe("failed");
    // The render error must surface (not a silent success, not an empty prompt).
    expect(result.result.runAttempt.error ?? "").toMatch(
      /nope|undefined|render|template/i,
    );
    // submit must never have been reached, so no manifest was emitted.
    expect(capture.submitted()).toBe(false);
  });

  it("regression: with NO resolver and no promptRendering, the 853 fail-closed path still holds (submit rejects)", async () => {
    const capture = createManifestCaptureCli();
    const backend = createCrabrunnerStageExecutionBackend({
      crucibleRoot: "/tmp/crucible",
      targetRepoRoot: "/tmp/repo",
      pollIntervalMs: 0,
      cli: capture.cli,
      // No promptRendering, no resolvePromptFile: spec.promptFile stays absent.
    });

    const result = await backend.execute({
      job: createJob(),
      runnerInput: createRunnerInput(),
    });

    expect(result.result.runAttempt.status).toBe("failed");
    expect(result.result.runAttempt.error ?? "").toContain(
      "crabrunner_prompt_required_symph_856",
    );
    expect(capture.submitted()).toBe(false);
  });

  it("an explicit resolvePromptFile override still wins over the default renderer", async () => {
    const capture = createManifestCaptureCli();
    const backend = createCrabrunnerStageExecutionBackend({
      crucibleRoot: "/tmp/crucible",
      targetRepoRoot: "/tmp/repo",
      pollIntervalMs: 0,
      cli: capture.cli,
      promptRendering: {
        promptTemplate: "default render {{ issue.identifier }}",
        workflowPath: "/tmp/workflow/WORKFLOW.md",
      },
      // An injected override (e.g. a precomputed path) must bypass the renderer.
      resolvePromptFile: () => "/tmp/explicit-prompt.md",
    });

    const result = await backend.execute({
      job: createJob(),
      runnerInput: createRunnerInput(),
    });

    expect(result.result.runAttempt.status).toBe("succeeded");
    expect(capture.manifest().prompt_file).toBe("/tmp/explicit-prompt.md");
  });

  it("supports an injected renderer fake for fully deterministic tests", async () => {
    const capture = createManifestCaptureCli();
    let seenStageName: string | null | undefined;
    const backend = createCrabrunnerStageExecutionBackend({
      crucibleRoot: "/tmp/crucible",
      targetRepoRoot: "/tmp/repo",
      pollIntervalMs: 0,
      cli: capture.cli,
      promptRendering: {
        promptTemplate: "unused when renderer injected",
        workflowPath: "/tmp/workflow/WORKFLOW.md",
      },
      renderPrompt: async (input) => {
        seenStageName = input.stageName;
        return `RENDERED:${input.issue.identifier}:${input.workflow.promptTemplate}`;
      },
    });

    const result = await backend.execute({
      job: createJob(),
      runnerInput: createRunnerInput(),
    });

    expect(result.result.runAttempt.status).toBe("succeeded");
    expect(seenStageName).toBe("implement");
    const contents = await readFile(
      capture.manifest().prompt_file as string,
      "utf8",
    );
    expect(contents).toBe("RENDERED:SYMPH-1:unused when renderer injected");
  });
});

// --- helpers ---------------------------------------------------------------

// Real on-disk artifact/usage files so the collect step resolves a present
// artifact and reaches a succeeded terminal — without spawning any subprocess.
let artifactPath = "";
let usagePath = "";

beforeAll(async () => {
  const dir = await mkdtemp(join(tmpdir(), "crabrunner-pt-fixtures-"));
  artifactPath = join(dir, "artifact.json");
  usagePath = join(dir, "usage.json");
  await writeFile(artifactPath, JSON.stringify({ ok: true }), "utf8");
  await writeFile(
    usagePath,
    JSON.stringify({
      schema: "crucible.lane-worker.usage.v2",
      measurement_kind: "true",
      input_tokens: 5,
      output_tokens: 3,
      total_tokens: 8,
    }),
    "utf8",
  );
});

/**
 * A fake CrabrunnerCli that captures the manifest the scheduler client writes on
 * `submit`, and records whether submit was ever reached. status/collect succeed
 * so a submitted job round-trips to a succeeded terminal.
 */
function createManifestCaptureCli(): {
  cli: CrabrunnerCli;
  manifest: () => Record<string, unknown>;
  submitted: () => boolean;
} {
  let captured: Record<string, unknown> | null = null;
  let didSubmit = false;
  const cli: CrabrunnerCli = async (args) => {
    switch (args[0]) {
      case "submit": {
        didSubmit = true;
        const manifestPath = manifestPathFromArgs(args);
        captured = JSON.parse(await readFile(manifestPath, "utf8")) as Record<
          string,
          unknown
        >;
        return ok(
          statusJson({ state: "queued", job_id: "j1", collectible: false }),
        );
      }
      case "status":
        return ok(
          statusJson({ state: "complete", job_id: "j1", collectible: true }),
        );
      case "collect":
        return ok(
          JSON.stringify({
            schema: "crucible.crabrunner.collect.v1",
            job_id: "j1",
            attempt_id: "0",
            state: "complete",
            status: statusObject({
              state: "complete",
              job_id: "j1",
              collectible: true,
            }),
            archive_path: "/tmp/j1.tgz",
          }),
        );
      default:
        throw new Error(`unexpected subcommand ${args[0]}`);
    }
  };
  return {
    cli,
    manifest: () => {
      if (captured === null) {
        throw new Error("no manifest captured (submit was not reached)");
      }
      return captured;
    },
    submitted: () => didSubmit,
  };
}

function manifestPathFromArgs(args: readonly string[]): string {
  const index = args.indexOf("--manifest-file");
  const path = index >= 0 ? args[index + 1] : undefined;
  if (path === undefined) {
    throw new Error("submit invoked without --manifest-file");
  }
  return path;
}

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
    artifact_path: artifactPath,
    usage_path: usagePath,
    collectible: fields.collectible,
  };
}

function statusJson(fields: Parameters<typeof statusObject>[0]): string {
  return JSON.stringify(statusObject(fields));
}

function createStage(prompt: string): StageDefinition {
  return {
    type: "agent",
    runner: null,
    model: null,
    prompt,
    maxTurns: null,
    timeoutMs: null,
    concurrency: null,
    gateType: null,
    maxRework: null,
    reviewers: [],
    transitions: { onComplete: null, onApprove: null, onRework: null },
    linearState: null,
  };
}

function createIssue(): Issue {
  return {
    id: "issue-1",
    identifier: "SYMPH-1",
    title: "Thread the stage prompt",
    description: null,
    priority: 1,
    state: "In Progress",
    branchName: "codex/SYMPH-1",
    url: null,
    labels: [],
    blockedBy: [],
    createdAt: null,
    updatedAt: null,
  };
}

function createRunnerInput(): AgentRunInput {
  return {
    issue: createIssue(),
    attempt: null,
    stageName: "implement",
  };
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

// Reference the job-spec version so an accidental schema rename trips this file.
void CRABRUNNER_JOB_SPEC_VERSION;
void ({} as CrabrunnerJobSpec);
