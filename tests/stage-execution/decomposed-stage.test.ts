import { describe, expect, it } from "vitest";

import type { AgentRunInput, AgentRunResult } from "../../src/agent/runner.js";
import type {
  StageExecutionBackend,
  StageExecutionProfile,
  StageExecutionSubStage,
} from "../../src/config/types.js";
import type {
  StageExecutionBackendRunner,
  StageExecutionJobSpec,
} from "../../src/stage-execution/backend.js";
import {
  type DecomposedSubStageContext,
  runDecomposedStage,
} from "../../src/stage-execution/decomposed-stage.js";

describe("runDecomposedStage", () => {
  it("dispatches sub-stages in order through the backend seam", async () => {
    const { backend, calls } = fakeBackend({
      "patch-plan": 10,
      "first-patch": 20,
      "focused-tests": 5,
    });
    const resolved: StageExecutionJobSpec[] = [];

    const result = await runDecomposedStage({
      subStages: [
        sub("patch-plan", {
          maxTokens: 100,
          produce: ["capsules/patch-plan.json"],
        }),
        sub("first-patch", {
          maxTokens: 100,
          consume: ["capsules/patch-plan.json"],
          produce: ["capsules/first-patch.json"],
        }),
        sub("focused-tests", {
          maxTokens: 100,
          consume: ["capsules/first-patch.json"],
        }),
      ],
      resolveBackend: (job) => {
        resolved.push(job);
        return backend;
      },
      buildJobSpec: makeJob,
      buildRunnerInput,
      spendTokensOf,
    });

    expect(calls.map((job) => job.identity.stageName)).toEqual([
      "patch-plan",
      "first-patch",
      "focused-tests",
    ]);
    expect(resolved).toHaveLength(3);
    expect(result.stopReason).toBe("completed");
    expect(result.completedAll).toBe(true);
    expect(result.outcomes.map((outcome) => outcome.status)).toEqual([
      "succeeded",
      "succeeded",
      "succeeded",
    ]);
  });

  it("hands off capsules by path between sub-stages without threading transcripts", async () => {
    const { backend } = fakeBackend({ "patch-plan": 10, "first-patch": 20 });
    const contexts: DecomposedSubStageContext[] = [];

    const result = await runDecomposedStage({
      subStages: [
        sub("patch-plan", {
          maxTokens: 100,
          produce: ["capsules/patch-plan.json"],
        }),
        sub("first-patch", {
          maxTokens: 100,
          consume: ["capsules/patch-plan.json"],
        }),
      ],
      resolveBackend: () => backend,
      buildJobSpec: makeJob,
      buildRunnerInput: (ctx) => {
        contexts.push(ctx);
        return runnerInputFor(ctx);
      },
      spendTokensOf,
    });

    expect(result.completedAll).toBe(true);
    const firstPatch = contexts.find((ctx) => ctx.name === "first-patch");
    expect(firstPatch).toBeDefined();
    // The downstream sub-stage consumes the prior sub-stage's capsule BY PATH
    // (resolved, non-empty path) — never the prior transcript.
    expect(
      firstPatch?.consumeCapsules.map((capsule) => ({
        id: capsule.id,
        path: capsule.path,
        required: capsule.required,
      })),
    ).toEqual([
      {
        id: "capsules/patch-plan.json",
        path: "capsules/patch-plan.json",
        required: true,
      },
    ]);
    // The handoff context exposes only capsule paths; there is no transcript/result surface.
    expect(firstPatch).not.toHaveProperty("priorResult");
    expect(firstPatch).not.toHaveProperty("transcript");
  });

  it("treats initial capsule paths as available to the first sub-stage", async () => {
    const { backend, calls } = fakeBackend({ "patch-plan": 10 });

    const result = await runDecomposedStage({
      subStages: [
        sub("patch-plan", { maxTokens: 100, consume: ["capsules/plan.json"] }),
      ],
      initialCapsulePaths: ["capsules/plan.json"],
      resolveBackend: () => backend,
      buildJobSpec: makeJob,
      buildRunnerInput,
      spendTokensOf,
    });

    expect(result.completedAll).toBe(true);
    expect(calls.map((job) => job.identity.stageName)).toEqual(["patch-plan"]);
  });

  it("fails closed and stops the sequence when a required capsule was not produced", async () => {
    const { backend, calls } = fakeBackend({
      "patch-plan": 10,
      "first-patch": 20,
    });

    const result = await runDecomposedStage({
      subStages: [
        sub("patch-plan", {
          maxTokens: 100,
          produce: ["capsules/patch-plan.json"],
        }),
        sub("first-patch", {
          maxTokens: 100,
          consume: ["capsules/never-made.json"],
        }),
      ],
      resolveBackend: () => backend,
      buildJobSpec: makeJob,
      buildRunnerInput,
      spendTokensOf,
    });

    expect(result.stopReason).toBe("missing_required_capsule");
    expect(result.completedAll).toBe(false);
    // The downstream sub-stage is NOT dispatched once the handoff fails closed.
    expect(calls.map((job) => job.identity.stageName)).toEqual(["patch-plan"]);
    const firstPatch = result.outcomes.find(
      (outcome) => outcome.name === "first-patch",
    );
    expect(firstPatch?.status).toBe("failed");
    expect(firstPatch?.missingCapsules).toEqual(["capsules/never-made.json"]);
  });

  it("stops at the sub-stage boundary when a sub-stage exceeds its own ceiling", async () => {
    // patch-plan overruns its 100-token ceiling.
    const { backend, calls } = fakeBackend({
      "patch-plan": 150,
      "first-patch": 10,
    });

    const result = await runDecomposedStage({
      subStages: [
        sub("patch-plan", {
          maxTokens: 100,
          produce: ["capsules/patch-plan.json"],
        }),
        sub("first-patch", {
          maxTokens: 100,
          consume: ["capsules/patch-plan.json"],
        }),
      ],
      resolveBackend: () => backend,
      buildJobSpec: makeJob,
      buildRunnerInput,
      spendTokensOf,
    });

    expect(result.stopReason).toBe("budget_exceeded");
    expect(result.completedAll).toBe(false);
    // The next sub-stage is NOT dispatched after a ceiling breach.
    expect(calls.map((job) => job.identity.stageName)).toEqual(["patch-plan"]);
    const patchPlan = result.outcomes.find(
      (outcome) => outcome.name === "patch-plan",
    );
    expect(patchPlan?.spentTokens).toBe(150);
    expect(patchPlan?.ceilingTokens).toBe(100);
  });

  it("bounds cumulative spend by the sum of sub-stage ceilings and isolates each ceiling", async () => {
    const { backend, calls } = fakeBackend({
      "patch-plan": 80,
      "first-patch": 90,
      "focused-tests": 30,
    });

    const result = await runDecomposedStage({
      subStages: [
        sub("patch-plan", {
          maxTokens: 100,
          produce: ["capsules/patch-plan.json"],
        }),
        sub("first-patch", {
          maxTokens: 100,
          consume: ["capsules/patch-plan.json"],
          produce: ["capsules/first-patch.json"],
        }),
        sub("focused-tests", {
          maxTokens: 100,
          consume: ["capsules/first-patch.json"],
        }),
      ],
      resolveBackend: () => backend,
      buildJobSpec: makeJob,
      buildRunnerInput,
      spendTokensOf,
    });

    expect(result.completedAll).toBe(true);
    expect(result.ceilingSumTokens).toBe(300);
    expect(result.cumulativeSpentTokens).toBe(200);
    expect(result.cumulativeSpentTokens).toBeLessThanOrEqual(
      result.ceilingSumTokens,
    );
    // Each sub-stage lane carries ONLY its own ceiling — no single sub-stage can
    // consume the whole implement budget.
    expect(calls.map((job) => job.enforcement.budget.maxTokens)).toEqual([
      100, 100, 100,
    ]);
  });
});

// ---- helpers ----------------------------------------------------------------

const minimalIssue: AgentRunInput["issue"] = {
  id: "issue-835",
  identifier: "SYMPH-835",
  title: "Decompose implement",
  description: null,
  priority: 1,
  state: "In Progress",
  branchName: "claude/SYMPH-835",
  url: null,
  labels: [],
  blockedBy: [],
  createdAt: null,
  updatedAt: null,
};

function spendTokensOf(result: { evidence?: unknown }): number {
  return (result.evidence as { spentTokens: number }).spentTokens;
}

function runnerInputFor(ctx: DecomposedSubStageContext): AgentRunInput {
  return { issue: minimalIssue, attempt: null, stageName: ctx.name };
}

function buildRunnerInput(ctx: DecomposedSubStageContext): AgentRunInput {
  return runnerInputFor(ctx);
}

function fakeBackend(spendByStage: Record<string, number>): {
  backend: StageExecutionBackendRunner;
  calls: StageExecutionJobSpec[];
} {
  const calls: StageExecutionJobSpec[] = [];
  const backend: StageExecutionBackendRunner = {
    backend: "crabrunner",
    execute: async (input) => {
      calls.push(input.job);
      const spent = spendByStage[input.job.identity.stageName ?? ""] ?? 0;
      return {
        job: input.job,
        result: {} as unknown as AgentRunResult,
        evidence: { spentTokens: spent },
      };
    },
  };
  return { backend, calls };
}

function sub(
  name: string,
  opts: {
    backend?: StageExecutionBackend;
    maxTokens?: number | null;
    consume?: readonly string[];
    produce?: readonly string[];
    missingCapsule?: "fail" | "degrade";
  },
): StageExecutionSubStage {
  return { name, execution: profile(opts) };
}

function profile(opts: {
  backend?: StageExecutionBackend;
  maxTokens?: number | null;
  consume?: readonly string[];
  produce?: readonly string[];
  missingCapsule?: "fail" | "degrade";
}): StageExecutionProfile {
  return {
    role: "implementer",
    phase: "implement",
    backend: opts.backend ?? "crabrunner",
    controlNeeding: false,
    provider: null,
    model: null,
    reasoningEffort: null,
    profile: null,
    artifacts: { requires: [], produces: [] },
    timeoutMs: null,
    budget: { maxTokens: opts.maxTokens ?? null, maxUsd: null },
    dependencies: {
      stages: [],
      capsules: [],
      missingCapsule: opts.missingCapsule ?? "fail",
    },
    runGroup: { id: "rg-835", key: null },
    capsules: { consume: opts.consume ?? [], produce: opts.produce ?? [] },
    subStages: [],
  };
}

function makeJob(ctx: DecomposedSubStageContext): StageExecutionJobSpec {
  return {
    backend: ctx.execution.backend,
    role: ctx.execution.role,
    phase: ctx.execution.phase,
    identity: {
      issueId: "issue-835",
      issueIdentifier: "SYMPH-835",
      stageName: ctx.name,
      stageAttempt: 0,
      runGroupId: "rg-835",
      profileId: ctx.execution.profile,
      baseRef: "origin/main",
      targetHeadRef: "claude/SYMPH-835",
      artifactRoot: "/tmp/artifacts/issue-835",
      idempotencyKey: `issue-835:${ctx.name}:0`,
    },
    runner: {
      runnerKind: "codex",
      model: ctx.execution.model,
      provider: ctx.execution.provider,
      reasoningEffort: ctx.execution.reasoningEffort,
    },
    enforcement: {
      required: ctx.execution.backend === "crabrunner",
      budget: {
        maxTokens: ctx.execution.budget.maxTokens,
        maxUsd: ctx.execution.budget.maxUsd,
        estimatedCostPer1kTokensUsd: null,
        cachedTokenCostRatio: null,
        liveBudgetGraceRatio: null,
      },
      timing: {
        timeoutMs: null,
        stallTimeoutMs: null,
        noProgressTurns: null,
        maxIterations: null,
      },
      telemetry: {
        heartbeatIntervalMs: null,
        progressIntervalMs: null,
        usageIntervalMs: null,
      },
      cancellation: {
        jobIdRequired: false,
        cooperativeAbort: false,
        processGroupKill: false,
        killGraceMs: null,
      },
    },
  };
}
