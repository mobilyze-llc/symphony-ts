import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

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

    // strictVariables is on; the rendered prompt carries the issue context.
    // Contents snapshotted at submit (execute() cleans up the temp file after).
    const contents = capture.promptContents() ?? "";
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
    const contents = capture.promptContents() ?? "";
    expect(contents).toContain("STAGE prompt wins for SYMPH-1");
    expect(contents).not.toContain("GLOBAL fallback");
  });

  it("renders runnerInput.promptTemplate before stage or workflow prompts", async () => {
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
      stage: createStage("STAGE prompt loses for {{ issue.identifier }}"),
      promptTemplate: "LANE prompt wins for {{ issue.identifier }}",
    };

    const result = await backend.execute({
      job: createJob(),
      runnerInput,
    });

    expect(result.result.runAttempt.status).toBe("succeeded");
    const contents = capture.promptContents() ?? "";
    expect(contents).toContain("LANE prompt wins for SYMPH-1");
    expect(contents).not.toContain("STAGE prompt loses");
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
    const overrideDir = await mkdtemp(join(tmpdir(), "override-wins-"));
    const overridePath = join(overrideDir, "explicit-prompt.md");
    await writeFile(overridePath, "precomputed override prompt", "utf8");

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
      resolvePromptFile: () => overridePath,
    });

    const result = await backend.execute({
      job: createJob(),
      runnerInput: createRunnerInput(),
    });

    expect(result.result.runAttempt.status).toBe("succeeded");
    expect(capture.manifest().prompt_file).toBe(overridePath);
    expect(capture.promptContents()).toBe("precomputed override prompt");

    await rm(overrideDir, { recursive: true, force: true });
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
    const contents = capture.promptContents() ?? "";
    expect(contents).toBe("RENDERED:SYMPH-1:unused when renderer injected");
  });

  it("fails closed when a present template renders to whitespace (P2-1) — no prompt_file, no submit", async () => {
    const capture = createManifestCaptureCli();
    const backend = createCrabrunnerStageExecutionBackend({
      crucibleRoot: "/tmp/crucible",
      targetRepoRoot: "/tmp/repo",
      pollIntervalMs: 0,
      cli: capture.cli,
      promptRendering: {
        // Present, non-blank SOURCE, but renders to only whitespace — a template
        // bug the operator must see, distinct from an absent template.
        promptTemplate: "{{ issue.description }}   \n  ",
        workflowPath: "/tmp/workflow/WORKFLOW.md",
      },
    });

    const result = await backend.execute({
      job: createJob(),
      runnerInput: createRunnerInput(),
    });

    expect(result.result.runAttempt.status).toBe("failed");
    expect(result.result.runAttempt.error ?? "").toContain(
      "crabrunner_prompt_render_failed",
    );
    expect(result.result.runAttempt.error ?? "").toMatch(/empty/i);
    expect(capture.submitted()).toBe(false);
  });

  it("removes the owned temp prompt dir after a successful job (P2-2)", async () => {
    const capture = createManifestCaptureCli();
    const backend = createCrabrunnerStageExecutionBackend({
      crucibleRoot: "/tmp/crucible",
      targetRepoRoot: "/tmp/repo",
      pollIntervalMs: 0,
      cli: capture.cli,
      promptRendering: {
        promptTemplate: "Work on {{ issue.identifier }}",
        workflowPath: "/tmp/workflow/WORKFLOW.md",
      },
    });

    const result = await backend.execute({
      job: createJob(),
      runnerInput: createRunnerInput(),
    });

    expect(result.result.runAttempt.status).toBe("succeeded");
    const promptFile = capture.manifest().prompt_file as string;
    // The lane consumed it during submit/collect (captured above); after
    // execute() returns terminal, the owned temp dir must be gone.
    const dir = dirname(promptFile);
    expect(dir).toContain("crabrunner-prompt-");
    expect(await pathExists(dir)).toBe(false);
  });

  it("removes the owned temp prompt dir even when the job fails after render (P2-2)", async () => {
    // Render succeeds (temp dir created), but submit is rejected — the finally
    // must still clean the owned dir on the non-success path.
    let capturedPromptFile: string | null = null;
    const cli: CrabrunnerCli = async (args) => {
      if (args[0] === "submit") {
        const manifest = JSON.parse(
          await readFile(manifestPathFromArgs(args), "utf8"),
        ) as Record<string, unknown>;
        capturedPromptFile =
          typeof manifest.prompt_file === "string"
            ? manifest.prompt_file
            : null;
        return ok(
          statusJson({ state: "failed", job_id: "j1", collectible: false }),
        );
      }
      throw new Error(`unexpected subcommand ${args[0]}`);
    };
    const backend = createCrabrunnerStageExecutionBackend({
      crucibleRoot: "/tmp/crucible",
      targetRepoRoot: "/tmp/repo",
      pollIntervalMs: 0,
      cli,
      promptRendering: {
        promptTemplate: "Work on {{ issue.identifier }}",
        workflowPath: "/tmp/workflow/WORKFLOW.md",
      },
    });

    const result = await backend.execute({
      job: createJob(),
      runnerInput: createRunnerInput(),
    });

    expect(result.result.runAttempt.status).toBe("failed");
    const promptFile: string | null = capturedPromptFile;
    if (promptFile === null) {
      throw new Error("expected the manifest to carry a prompt_file");
    }
    const dir = dirname(promptFile);
    expect(dir).toContain("crabrunner-prompt-");
    expect(await pathExists(dir)).toBe(false);
  });

  it("does NOT delete an explicit resolvePromptFile override path (P2-2)", async () => {
    const overrideDir = await mkdtemp(join(tmpdir(), "override-keep-"));
    const overridePath = join(overrideDir, "prompt.md");
    await writeFile(overridePath, "explicit prompt", "utf8");

    const capture = createManifestCaptureCli();
    const backend = createCrabrunnerStageExecutionBackend({
      crucibleRoot: "/tmp/crucible",
      targetRepoRoot: "/tmp/repo",
      pollIntervalMs: 0,
      cli: capture.cli,
      // Override points outside the owned crabrunner-prompt- prefix; cleanup
      // must leave it untouched.
      resolvePromptFile: () => overridePath,
    });

    const result = await backend.execute({
      job: createJob(),
      runnerInput: createRunnerInput(),
    });

    expect(result.result.runAttempt.status).toBe("succeeded");
    expect(capture.manifest().prompt_file).toBe(overridePath);
    expect(await pathExists(overridePath)).toBe(true);

    await rm(overrideDir, { recursive: true, force: true });
  });

  it("does NOT delete an override path that COLLIDES with the temp prompt prefix (recheck-2 P2-1)", async () => {
    // Ownership must be explicit, not inferred from the pathname: an override
    // returning a path UNDER tmpdir() WITH the crabrunner-prompt- prefix must
    // still be left untouched, because the factory default resolver did not
    // create it.
    const overrideDir = await mkdtemp(
      join(tmpdir(), "crabrunner-prompt-keep-"),
    );
    const overridePath = join(overrideDir, "prompt.md");
    await writeFile(overridePath, "explicit colliding-prefix prompt", "utf8");

    const capture = createManifestCaptureCli();
    const backend = createCrabrunnerStageExecutionBackend({
      crucibleRoot: "/tmp/crucible",
      targetRepoRoot: "/tmp/repo",
      pollIntervalMs: 0,
      cli: capture.cli,
      resolvePromptFile: () => overridePath,
    });

    const result = await backend.execute({
      job: createJob(),
      runnerInput: createRunnerInput(),
    });

    expect(result.result.runAttempt.status).toBe("succeeded");
    expect(capture.manifest().prompt_file).toBe(overridePath);
    // Provably NOT deleted despite the colliding prefix.
    expect(await pathExists(overridePath)).toBe(true);

    await rm(overrideDir, { recursive: true, force: true });
  });

  it("fails closed render_failed (not required) when a present template path points at a blank file (recheck-2 P2-2)", async () => {
    // A present SOURCE (a real prompt-file path) whose CONTENT is blank is a
    // present-but-empty template — it must hit the empty-render contract
    // (crabrunner_prompt_render_failed), not the absent-template rejection.
    const tplDir = await mkdtemp(join(tmpdir(), "blank-tpl-"));
    const tplPath = join(tplDir, "empty.liquid");
    await writeFile(tplPath, "   \n  ", "utf8");

    const capture = createManifestCaptureCli();
    const backend = createCrabrunnerStageExecutionBackend({
      crucibleRoot: "/tmp/crucible",
      targetRepoRoot: "/tmp/repo",
      pollIntervalMs: 0,
      cli: capture.cli,
      promptRendering: {
        // Path with a recognized extension + separator → resolved by reading the
        // (blank) file, exactly as AgentRunner.run() turn-1 does.
        promptTemplate: tplPath,
        workflowPath: join(tplDir, "WORKFLOW.md"),
      },
    });

    const result = await backend.execute({
      job: createJob(),
      runnerInput: createRunnerInput(),
    });

    expect(result.result.runAttempt.status).toBe("failed");
    expect(result.result.runAttempt.error ?? "").toContain(
      "crabrunner_prompt_render_failed",
    );
    expect(result.result.runAttempt.error ?? "").not.toContain(
      "crabrunner_prompt_required_symph_856",
    );
    expect(capture.submitted()).toBe(false);

    await rm(tplDir, { recursive: true, force: true });
  });

  it("cleans up the temp dir if writeFile throws after mkdtemp (recheck-2 T1)", async () => {
    // Force a write failure AFTER the temp dir is created; the resolver must
    // remove the dir before rethrowing so it does not leak.
    const createdDirs: string[] = [];
    const capture = createManifestCaptureCli();
    const backend = createCrabrunnerStageExecutionBackend({
      crucibleRoot: "/tmp/crucible",
      targetRepoRoot: "/tmp/repo",
      pollIntervalMs: 0,
      cli: capture.cli,
      promptRendering: {
        promptTemplate: "Work on {{ issue.identifier }}",
        workflowPath: "/tmp/workflow/WORKFLOW.md",
      },
      // Internal seam (tests only): capture the dir then fail the write.
      writePromptFile: async (path) => {
        createdDirs.push(dirname(path));
        throw new Error("disk full");
      },
    });

    const result = await backend.execute({
      job: createJob(),
      runnerInput: createRunnerInput(),
    });

    expect(result.result.runAttempt.status).toBe("failed");
    expect(result.result.runAttempt.error ?? "").toContain(
      "crabrunner_prompt_render_failed",
    );
    expect(result.result.runAttempt.error ?? "").toContain("disk full");
    expect(capture.submitted()).toBe(false);
    expect(createdDirs.length).toBe(1);
    // The temp dir created by mkdtemp must have been removed despite the throw.
    expect(await pathExists(createdDirs[0] as string)).toBe(false);
  });
});

// --- helpers ---------------------------------------------------------------

// Real on-disk artifact/usage files so the collect step resolves a present
// artifact and reaches a succeeded terminal — without spawning any subprocess.
let fixtureDir = "";
let artifactPath = "";
let usagePath = "";

beforeAll(async () => {
  fixtureDir = await mkdtemp(join(tmpdir(), "crabrunner-pt-fixtures-"));
  artifactPath = join(fixtureDir, "artifact.json");
  usagePath = join(fixtureDir, "usage.json");
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

afterAll(async () => {
  // Clean the fixture dir this suite created (DeepSeek noted these leak too).
  if (fixtureDir !== "") {
    await rm(fixtureDir, { recursive: true, force: true });
  }
});

async function pathExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

/**
 * A fake CrabrunnerCli that captures the manifest the scheduler client writes on
 * `submit`, and records whether submit was ever reached. status/collect succeed
 * so a submitted job round-trips to a succeeded terminal.
 *
 * It also snapshots the rendered prompt_file CONTENTS at submit time — the only
 * point the file is guaranteed to exist, since execute() cleans up the owned
 * temp dir after the job is terminal (P2-2). Tests assert on these snapshotted
 * contents rather than re-reading the (cleaned) file after execute() returns.
 */
function createManifestCaptureCli(): {
  cli: CrabrunnerCli;
  manifest: () => Record<string, unknown>;
  promptContents: () => string | null;
  submitted: () => boolean;
} {
  let captured: Record<string, unknown> | null = null;
  let capturedPrompt: string | null = null;
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
        const promptFile = captured.prompt_file;
        capturedPrompt =
          typeof promptFile === "string"
            ? await readFile(promptFile, "utf8")
            : null;
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
    promptContents: () => capturedPrompt,
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
