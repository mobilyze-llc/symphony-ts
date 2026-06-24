import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { describe, expect, it } from "vitest";

import type { AgentRunResult } from "../../src/agent/runner.js";
import type { WorkflowPreReviewVerifyConfig } from "../../src/config/types.js";
import type { Issue } from "../../src/domain/model.js";
import {
  createCrabrunnerReviewStageDispatcher,
  reviewLaneReasoningEffort,
} from "../../src/review/crabrunner-review-dispatcher.js";
import type { CrabrunnerReviewLaneSpec } from "../../src/review/crabrunner-review-job-group.js";
import type { CrabrunnerReviewStageDispatchContext } from "../../src/review/crabrunner-review-stage.js";
import type {
  CommandRunner,
  StructuredReviewerArtifact,
} from "../../src/review/headless-council-gate.js";
import type {
  StageExecutionBackendInput,
  StageExecutionBackendResult,
  StageExecutionBackendRunner,
} from "../../src/stage-execution/backend.js";
import type { CrabrunnerStageExecutionEvidence } from "../../src/stage-execution/crabrunner-backend.js";

const BASE_SHA = "base000000000000000000000000000000000000000";
const HEAD_SHA = "head000000000000000000000000000000000000000";
const PRIOR_HEAD_SHA = "prior0000000000000000000000000000000000000";
const MERGE_BASE_SHA = "merge000000000000000000000000000000000000";
const BASE_REF = "origin/main";
const ISSUE_BRANCH = "codex/SYMPH-862";

describe("createCrabrunnerReviewStageDispatcher", () => {
  it("runs production reviewer lanes through crabrunner refs and writes routed review artifacts", async () => {
    const root = await mkdtemp(join(tmpdir(), "symph862-dispatcher-"));
    try {
      const workspaceRoot = join(root, "workspace");
      const artifactRoot = join(root, "artifacts");
      await mkdir(workspaceRoot, { recursive: true });
      await mkdir(artifactRoot, { recursive: true });
      const backend = new MarkdownArtifactBackend(artifactRoot);
      const issue = createIssue();
      const dispatcher = createCrabrunnerReviewStageDispatcher({
        env: {
          SYMPHONY_COUNCIL_AUTHOR_FAMILY: "codex",
          SYMPHONY_COUNCIL_CODEX_EXCAVATION_ENABLED: "false",
          SYMPHONY_COUNCIL_KIMI_SHADOW_ENABLED: "false",
        },
        defaultRunnerKind: "codex",
        defaultRunnerModel: null,
        defaultTurnTimeoutMs: 3_600_000,
        defaultStallTimeoutMs: 300_000,
        runCommand: fakeGitCommand(),
      });

      const result = await dispatcher({
        issue,
        issueId: issue.id,
        issueIdentifier: issue.identifier,
        workspaceRoot,
        stage: null,
        stageName: "review",
        attempt: null,
        artifactRoot,
        baseRef: BASE_REF,
        signal: new AbortController().signal,
        backend,
      } satisfies CrabrunnerReviewStageDispatchContext);

      expect(backend.inputs).toHaveLength(1);
      expect(backend.inputs[0]?.job.backend).toBe("crabrunner");
      expect(backend.inputs[0]?.job.runner.runnerKind).toBe("pi");
      expect(backend.inputs[0]?.job.runner.provider).toBe("deepseek");
      expect(backend.inputs[0]?.runnerInput.stage?.prompt).toContain(
        "You are a decorrelated reviewer in a headless Symphony council gate.",
      );

      expect(result.result.verdict).toBe("pass");
      expect(result.result.review_metadata.reviewed_head_sha).toBe(HEAD_SHA);
      expect(result.result.review_metadata.base_sha).toBe(BASE_SHA);
      expect(result.result.review_routing?.decorrelationBasis).toMatchObject({
        authorFamilies: ["openai-codex"],
        requiredReviewerLaneIds: ["pi-deepseek"],
        mergeEligible: true,
      });
      expect(
        result.result.review_routing?.decorrelationBasis
          .decorrelatedReviewerArtifacts,
      ).toEqual([{ laneId: "pi-deepseek", agent: "pi", modelFamily: "pi" }]);

      const resultJson = JSON.parse(
        await readFile(result.reviewResultPath, "utf8"),
      ) as { artifactPaths: { structuredArtifacts: string[] } };
      expect(resultJson.artifactPaths.structuredArtifacts).toHaveLength(1);
      const structured = JSON.parse(
        await readFile(
          resultJson.artifactPaths.structuredArtifacts[0]!,
          "utf8",
        ),
      ) as { kind: string; lane: { laneId: string } };
      expect(structured.kind).toBe(
        "symphony-headless-council-reviewer-artifact",
      );
      expect(structured.lane.laneId).toBe("pi-deepseek");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("preserves structured artifact paths for JSON reviewer refs", async () => {
    const root = await mkdtemp(join(tmpdir(), "symph862-dispatcher-json-"));
    try {
      const workspaceRoot = join(root, "workspace");
      const artifactRoot = join(root, "artifacts");
      await mkdir(workspaceRoot, { recursive: true });
      await mkdir(artifactRoot, { recursive: true });
      const backend = new JsonArtifactBackend(artifactRoot);
      const issue = createIssue();
      const dispatcher = createDispatcher({ runCommand: fakeGitCommand() });

      const result = await dispatcher(
        dispatchContext({ issue, workspaceRoot, artifactRoot, backend }),
      );

      const expectedArtifactPath = join(artifactRoot, "pi-deepseek.json");
      const resultJson = JSON.parse(
        await readFile(result.reviewResultPath, "utf8"),
      ) as { artifactPaths: { structuredArtifacts: string[] } };
      expect(resultJson.artifactPaths.structuredArtifacts).toEqual([
        expectedArtifactPath,
      ]);
      expect(result.result.lanes[0]?.structuredArtifactPath).toBe(
        expectedArtifactPath,
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("carries prior review state into re-review dispatch prompts and metadata", async () => {
    const root = await mkdtemp(join(tmpdir(), "symph871-dispatcher-prior-"));
    try {
      const workspaceRoot = join(root, "workspace");
      const artifactRoot = join(root, "artifacts");
      await mkdir(workspaceRoot, { recursive: true });
      await mkdir(artifactRoot, { recursive: true });
      const backend = new MarkdownArtifactBackend(artifactRoot);
      const issue = createIssue();
      const dispatcher = createDispatcher({ runCommand: fakeGitCommand() });

      const result = await dispatcher(
        dispatchContext({
          issue,
          workspaceRoot,
          artifactRoot,
          backend,
          previousReviewedHeadSha: PRIOR_HEAD_SHA,
          priorStructuredArtifacts: [priorStructuredReviewerArtifact()],
        }),
      );

      expect(result.result.review_metadata.previous_reviewed_head_sha).toBe(
        PRIOR_HEAD_SHA,
      );
      expect(backend.inputs[0]?.runnerInput.stage?.prompt).toContain(
        "Prior adjudicated findings by fingerprint:",
      );
      expect(backend.inputs[0]?.runnerInput.stage?.prompt).toContain(
        "prior-fingerprint",
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("prefers structured JSON reviewer refs over earlier markdown refs", async () => {
    const root = await mkdtemp(join(tmpdir(), "symph862-dispatcher-mixed-"));
    try {
      const workspaceRoot = join(root, "workspace");
      const artifactRoot = join(root, "artifacts");
      await mkdir(workspaceRoot, { recursive: true });
      await mkdir(artifactRoot, { recursive: true });
      const backend = new MixedArtifactBackend(artifactRoot);
      const issue = createIssue();
      const dispatcher = createDispatcher({ runCommand: fakeGitCommand() });

      const result = await dispatcher(
        dispatchContext({ issue, workspaceRoot, artifactRoot, backend }),
      );

      const expectedArtifactPath = join(artifactRoot, "pi-deepseek.json");
      const resultJson = JSON.parse(
        await readFile(result.reviewResultPath, "utf8"),
      ) as { artifactPaths: { structuredArtifacts: string[] } };
      expect(resultJson.artifactPaths.structuredArtifacts).toEqual([
        expectedArtifactPath,
      ]);
      expect(result.result.lanes[0]?.structuredArtifactPath).toBe(
        expectedArtifactPath,
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("fails closed when the review head cannot be resolved", async () => {
    const root = await mkdtemp(join(tmpdir(), "symph862-dispatcher-head-"));
    try {
      const workspaceRoot = join(root, "workspace");
      const artifactRoot = join(root, "artifacts");
      await mkdir(workspaceRoot, { recursive: true });
      await mkdir(artifactRoot, { recursive: true });
      const issue = createIssue();
      const dispatcher = createDispatcher({
        runCommand: fakeGitCommand({ headSha: "" }),
      });

      await expect(
        dispatcher(
          dispatchContext({
            issue,
            workspaceRoot,
            artifactRoot,
            backend: new MarkdownArtifactBackend(artifactRoot),
          }),
        ),
      ).rejects.toThrow(
        "crabrunner review dispatch requires a resolved head SHA",
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("fails closed when the review diff is empty", async () => {
    const root = await mkdtemp(join(tmpdir(), "symph862-dispatcher-diff-"));
    try {
      const workspaceRoot = join(root, "workspace");
      const artifactRoot = join(root, "artifacts");
      await mkdir(workspaceRoot, { recursive: true });
      await mkdir(artifactRoot, { recursive: true });
      const issue = createIssue();
      const dispatcher = createDispatcher({
        runCommand: fakeGitCommand({ diff: "" }),
      });

      await expect(
        dispatcher(
          dispatchContext({
            issue,
            workspaceRoot,
            artifactRoot,
            backend: new MarkdownArtifactBackend(artifactRoot),
          }),
        ),
      ).rejects.toThrow("crabrunner review dispatch requires a non-empty diff");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("runs pre-review verify before dispatching council lanes", async () => {
    const root = await mkdtemp(join(tmpdir(), "symph913-dispatcher-green-"));
    try {
      const workspaceRoot = join(root, "workspace");
      const artifactRoot = join(root, "artifacts");
      await mkdir(workspaceRoot, { recursive: true });
      await mkdir(artifactRoot, { recursive: true });
      const backend = new MarkdownArtifactBackend(artifactRoot);
      const issue = createIssue();
      const verifyCalls: string[] = [];
      const dispatcher = createDispatcher({
        runCommand: fakeGitAndVerifyCommand({
          verifyCalls,
          verifyResults: [{ exitCode: 0, stdout: "ok\n", stderr: "" }],
        }),
        preReviewVerify: singleCommandVerifyConfig({ maxFixAttempts: 1 }),
      });

      const result = await dispatcher(
        dispatchContext({ issue, workspaceRoot, artifactRoot, backend }),
      );

      expect(verifyCalls).toEqual(["pnpm typecheck"]);
      expect(backend.inputs).toHaveLength(1);
      expect(backend.inputs[0]?.job.identity.stageName).toBe("pi-deepseek");
      expect(result.preReviewVerify?.status).toBe("green");
      expect(result.preReviewVerify?.metrics.fixAttempts).toBe(0);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("blocks council dispatch when pre-review verify is red and the fix loop is exhausted", async () => {
    const root = await mkdtemp(join(tmpdir(), "symph913-dispatcher-red-"));
    try {
      const workspaceRoot = join(root, "workspace");
      const artifactRoot = join(root, "artifacts");
      await mkdir(workspaceRoot, { recursive: true });
      await mkdir(artifactRoot, { recursive: true });
      const backend = new MarkdownArtifactBackend(artifactRoot);
      const issue = createIssue();
      const dispatcher = createDispatcher({
        runCommand: fakeGitAndVerifyCommand({
          verifyResults: [
            { exitCode: 2, stdout: "", stderr: "typecheck failed\n" },
          ],
        }),
        preReviewVerify: singleCommandVerifyConfig({ maxFixAttempts: 0 }),
      });

      await expect(
        dispatcher(
          dispatchContext({ issue, workspaceRoot, artifactRoot, backend }),
        ),
      ).rejects.toThrow(
        "pre-review verify gate failed closed: typecheck exited 2",
      );
      expect(backend.inputs).toHaveLength(0);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("dispatches one cheap repair lane and re-verifies before admitting council", async () => {
    const root = await mkdtemp(join(tmpdir(), "symph913-dispatcher-repair-"));
    try {
      const workspaceRoot = join(root, "workspace");
      const artifactRoot = join(root, "artifacts");
      await mkdir(workspaceRoot, { recursive: true });
      await mkdir(artifactRoot, { recursive: true });
      const backend = new MarkdownArtifactBackend(artifactRoot);
      const issue = createIssue();
      const dispatcher = createDispatcher({
        runCommand: fakeGitAndVerifyCommand({
          verifyResults: [
            { exitCode: 1, stdout: "", stderr: "lint failed\n" },
            { exitCode: 0, stdout: "ok\n", stderr: "" },
          ],
        }),
        preReviewVerify: singleCommandVerifyConfig({ maxFixAttempts: 1 }),
      });

      const result = await dispatcher(
        dispatchContext({ issue, workspaceRoot, artifactRoot, backend }),
      );

      expect(backend.inputs).toHaveLength(2);
      const repair = backend.inputs[0]!;
      expect(repair.job.identity.stageName).toBe("review/pre-review-repair-1");
      expect(repair.job.role).toBe("implementer");
      expect(repair.job.phase).toBe("verify");
      expect(repair.job.runner.reasoningEffort).toBe("low");
      expect(repair.runnerInput.reasoningEffort).toBe("low");
      expect(repair.runnerInput.stage?.prompt).toContain("lint failed");
      expect(backend.inputs[1]?.job.identity.stageName).toBe("pi-deepseek");
      expect(result.preReviewVerify?.status).toBe("green");
      expect(result.preReviewVerify?.metrics).toMatchObject({
        gateCaughtCount: 1,
        fixAttempts: 1,
        fixedPreCouncil: true,
        councilRoundsAvoided: 0,
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("normalizes and validates review lane reasoning effort", () => {
    const lane: CrabrunnerReviewLaneSpec = {
      laneId: "pi-deepseek",
      kind: "reviewer",
      agent: "pi",
      role: "decorrelated-reviewer",
      model: "deepseek/deepseek-v4-pro",
      modelFamily: "pi",
      reasoningEffort: null,
      independentReviewer: true,
      mergeAuthoritative: true,
    };

    expect(reviewLaneReasoningEffort(lane)).toBeNull();
    expect(
      reviewLaneReasoningEffort({
        ...lane,
        reasoningEffort: undefined as never,
      }),
    ).toBeNull();
    expect(
      reviewLaneReasoningEffort({ ...lane, reasoningEffort: "high" }),
    ).toBe("high");
    expect(() =>
      reviewLaneReasoningEffort({
        ...lane,
        laneId: "bad-reasoning",
        reasoningEffort: "extreme",
      }),
    ).toThrow(
      'review lane bad-reasoning has unsupported reasoningEffort "extreme"',
    );
  });
});

class MarkdownArtifactBackend
  implements StageExecutionBackendRunner<CrabrunnerStageExecutionEvidence>
{
  readonly backend = "crabrunner" as const;
  readonly inputs: StageExecutionBackendInput[] = [];

  constructor(private readonly artifactRoot: string) {}

  async execute(
    input: StageExecutionBackendInput,
  ): Promise<StageExecutionBackendResult<CrabrunnerStageExecutionEvidence>> {
    this.inputs.push(input);
    const laneId = input.job.identity.stageName ?? "review-lane";
    const artifactPath = join(this.artifactRoot, `${laneId}.md`);
    await mkdir(dirname(artifactPath), { recursive: true });
    await writeFile(
      artifactPath,
      [
        "## Verdict",
        "PASS",
        "",
        "## P1 Must Fix",
        "None",
        "",
        "## P2 Should Fix",
        "None",
        "",
        "## Track",
        "None",
        "",
        "## Dismissed Or Theoretical",
        "None",
        "",
      ].join("\n"),
      "utf8",
    );
    return {
      job: input.job,
      evidence: {
        admission: { status: "accepted", jobId: `job-${laneId}` },
        terminal: { state: "succeeded", artifactRefs: [artifactPath] },
        artifactRefs: [artifactPath],
        usage: null,
      },
      result: createRunResult(input, "succeeded"),
    };
  }
}

class JsonArtifactBackend
  implements StageExecutionBackendRunner<CrabrunnerStageExecutionEvidence>
{
  readonly backend = "crabrunner" as const;

  constructor(private readonly artifactRoot: string) {}

  async execute(
    input: StageExecutionBackendInput,
  ): Promise<StageExecutionBackendResult<CrabrunnerStageExecutionEvidence>> {
    const laneId = input.job.identity.stageName ?? "review-lane";
    const artifactPath = join(this.artifactRoot, `${laneId}.json`);
    await mkdir(dirname(artifactPath), { recursive: true });
    await writeFile(
      artifactPath,
      `${JSON.stringify(
        crabrunnerStructuredReviewerArtifactRecord(laneId),
        null,
        2,
      )}\n`,
      "utf8",
    );
    return {
      job: input.job,
      evidence: {
        admission: { status: "accepted", jobId: `job-${laneId}` },
        terminal: { state: "succeeded", artifactRefs: [artifactPath] },
        artifactRefs: [artifactPath],
        usage: null,
      },
      result: createRunResult(input, "succeeded"),
    };
  }
}

class MixedArtifactBackend
  implements StageExecutionBackendRunner<CrabrunnerStageExecutionEvidence>
{
  readonly backend = "crabrunner" as const;

  constructor(private readonly artifactRoot: string) {}

  async execute(
    input: StageExecutionBackendInput,
  ): Promise<StageExecutionBackendResult<CrabrunnerStageExecutionEvidence>> {
    const laneId = input.job.identity.stageName ?? "review-lane";
    const markdownPath = join(this.artifactRoot, `${laneId}.md`);
    const jsonPath = join(this.artifactRoot, `${laneId}.json`);
    await mkdir(dirname(markdownPath), { recursive: true });
    await writeFile(markdownPath, "## Verdict\nPASS\n", "utf8");
    await writeFile(
      jsonPath,
      `${JSON.stringify(
        {
          ...crabrunnerStructuredReviewerArtifactRecord(laneId),
          rawArtifactPath: "json-artifact",
        },
        null,
        2,
      )}\n`,
      "utf8",
    );
    return {
      job: input.job,
      evidence: {
        admission: { status: "accepted", jobId: `job-${laneId}` },
        terminal: {
          state: "succeeded",
          artifactRefs: [markdownPath, jsonPath],
        },
        artifactRefs: [markdownPath, jsonPath],
        usage: null,
      },
      result: createRunResult(input, "succeeded"),
    };
  }
}

function createDispatcher(input: {
  runCommand: CommandRunner;
  preReviewVerify?: WorkflowPreReviewVerifyConfig;
}): ReturnType<typeof createCrabrunnerReviewStageDispatcher> {
  return createCrabrunnerReviewStageDispatcher({
    env: {
      SYMPHONY_COUNCIL_AUTHOR_FAMILY: "codex",
      SYMPHONY_COUNCIL_CODEX_EXCAVATION_ENABLED: "false",
      SYMPHONY_COUNCIL_KIMI_SHADOW_ENABLED: "false",
    },
    defaultRunnerKind: "codex",
    defaultRunnerModel: null,
    defaultTurnTimeoutMs: 3_600_000,
    defaultStallTimeoutMs: 300_000,
    ...(input.preReviewVerify === undefined
      ? {}
      : { preReviewVerify: input.preReviewVerify }),
    runCommand: input.runCommand,
  });
}

function singleCommandVerifyConfig(input: {
  maxFixAttempts: number;
}): WorkflowPreReviewVerifyConfig {
  return {
    enabled: true,
    maxFixAttempts: input.maxFixAttempts,
    commands: {
      typecheck: "pnpm typecheck",
      lint: null,
      build: null,
      unit: null,
      smoke: null,
    },
  };
}

function dispatchContext(input: {
  issue: Issue;
  workspaceRoot: string;
  artifactRoot: string;
  backend: StageExecutionBackendRunner<CrabrunnerStageExecutionEvidence>;
  previousReviewedHeadSha?: string | null;
  priorStructuredArtifacts?: readonly StructuredReviewerArtifact[];
}): CrabrunnerReviewStageDispatchContext {
  return {
    issue: input.issue,
    issueId: input.issue.id,
    issueIdentifier: input.issue.identifier,
    workspaceRoot: input.workspaceRoot,
    stage: null,
    stageName: "review",
    attempt: null,
    artifactRoot: input.artifactRoot,
    baseRef: BASE_REF,
    previousReviewedHeadSha: input.previousReviewedHeadSha ?? null,
    priorStructuredArtifacts: input.priorStructuredArtifacts ?? [],
    signal: new AbortController().signal,
    backend: input.backend,
  };
}

function fakeGitCommand(
  input: { headSha?: string; diff?: string } = {},
): CommandRunner {
  const headSha = input.headSha ?? HEAD_SHA;
  const diff =
    input.diff ??
    "diff --git a/src/example.ts b/src/example.ts\n+export const value = 1;\n";

  return async (command, args) => {
    if (command !== "git") {
      return {
        exitCode: 1,
        stdout: "",
        stderr: `unexpected command ${command}`,
      };
    }
    if (args[0] === "rev-parse") {
      return {
        exitCode: 0,
        stdout: `${args[1] === BASE_REF ? BASE_SHA : headSha}\n`,
        stderr: "",
      };
    }
    if (args[0] === "diff" && args[1] === `${BASE_REF}...${ISSUE_BRANCH}`) {
      return {
        exitCode: 0,
        stdout: diff,
        stderr: "",
      };
    }
    if (args[0] === "merge-base") {
      return {
        exitCode: 0,
        stdout: `${MERGE_BASE_SHA}\n`,
        stderr: "",
      };
    }
    if (args[0] === "diff" && args[1] === "--name-only") {
      return {
        exitCode: 0,
        stdout: "src/review/crabrunner-review-dispatcher.ts\n",
        stderr: "",
      };
    }
    if (args[0] === "status") {
      return {
        exitCode: 0,
        stdout: `## ${ISSUE_BRANCH}\n`,
        stderr: "",
      };
    }
    return { exitCode: 1, stdout: "", stderr: `unexpected git args ${args}` };
  };
}

function fakeGitAndVerifyCommand(input: {
  verifyResults: { exitCode: number; stdout: string; stderr: string }[];
  verifyCalls?: string[];
}): CommandRunner {
  const git = fakeGitCommand();
  let verifyIndex = 0;
  return async (command, args, options) => {
    if (command === "sh" && args[0] === "-lc") {
      input.verifyCalls?.push(String(args[1]));
      const result =
        input.verifyResults[
          Math.min(verifyIndex, input.verifyResults.length - 1)
        ];
      verifyIndex += 1;
      return result ?? { exitCode: 1, stdout: "", stderr: "missing result" };
    }
    return git(command, args, options);
  };
}

function priorStructuredReviewerArtifact(): StructuredReviewerArtifact {
  const base = structuredReviewerArtifact("pi-deepseek");
  return {
    ...base,
    routing: {
      mode: "full",
      routingMode: "standard",
      round: 1,
    },
    findings: [
      {
        fingerprint: "prior-fingerprint",
        severity: "P2",
        emittedSeverity: "P2",
        title: "Prior review state was not carried forward",
        titleStem: "prior review state was not carried forward",
        category: "review-state",
        confidence: 0.9,
        evidence: [
          {
            path: "src/review/crabrunner-review-dispatcher.ts",
            lineStart: 57,
            lineEnd: 57,
            changedPath: true,
          },
        ],
        relatedPaths: ["src/review/crabrunner-review-dispatcher.ts"],
        rationale: "Re-review prompts need prior adjudicated findings.",
        leadDisposition: "open",
        repeatOf: null,
        introducedIn: "original_diff",
        dismissalReason: null,
        family: {
          name: "review-state contract",
          safetyClaim:
            "re-review dispatch carries prior reviewer artifacts into targeting",
          nextRoundQuestion:
            "does the re-review prompt preserve prior finding context?",
          fixedSymptoms: [],
          remainingSymptoms: ["prior artifact context missing"],
        },
      },
    ],
    familySyntheses: [
      {
        name: "review-state contract",
        safetyClaim:
          "re-review dispatch carries prior reviewer artifacts into targeting",
        nextRoundQuestion:
          "does the re-review prompt preserve prior finding context?",
        fixedSymptoms: [],
        remainingSymptoms: ["prior artifact context missing"],
        findingFingerprints: ["prior-fingerprint"],
      },
    ],
  };
}

type CrabrunnerStructuredReviewerArtifactRecord = StructuredReviewerArtifact & {
  headSha: string;
};

function crabrunnerStructuredReviewerArtifactRecord(
  laneId: string,
): CrabrunnerStructuredReviewerArtifactRecord {
  return {
    ...structuredReviewerArtifact(laneId),
    headSha: HEAD_SHA,
  };
}

function structuredReviewerArtifact(
  laneId: string,
): StructuredReviewerArtifact {
  return {
    schemaVersion: 1,
    kind: "symphony-headless-council-reviewer-artifact",
    lane: {
      laneId,
      agent: "pi",
      role: "decorrelated-reviewer",
      model: "deepseek/deepseek-v4-pro",
      modelFamily: "pi",
      reasoningEffort: null,
      independentReviewer: true,
      mergeAuthoritative: true,
    },
    routing: {
      mode: "full",
      routingMode: "standard",
      round: 1,
    },
    reviewBundle: null,
    verdict: "pass",
    confidence: 1,
    parseStatus: "synthesized_from_markdown",
    rawArtifactPath: null,
    malformedReason: null,
    sections: {
      findings: "",
      p1: "None",
      p2: "None",
      track: "None",
      dismissedOrTheoretical: "None",
      triage: "",
    },
    findings: [],
    familySyntheses: [],
  };
}

function createIssue(): Issue {
  return {
    id: "issue-862",
    identifier: "SYMPH-862",
    title: "Wire crabrunner review dispatcher",
    description: null,
    priority: 1,
    state: "In Review",
    branchName: ISSUE_BRANCH,
    url: null,
    labels: [],
    blockedBy: [],
    createdAt: null,
    updatedAt: null,
  };
}

function createRunResult(
  input: StageExecutionBackendInput,
  status: "succeeded" | "failed",
): AgentRunResult {
  return {
    issue: input.runnerInput.issue,
    workspace: {
      path: "/tmp/workspace",
      workspaceKey: input.runnerInput.issue.id,
      createdNow: false,
    },
    runAttempt: {
      issueId: input.runnerInput.issue.id,
      issueIdentifier: input.runnerInput.issue.identifier,
      attempt: input.runnerInput.attempt,
      workspacePath: "/tmp/workspace",
      startedAt: "2026-06-21T00:00:00.000Z",
      status,
    },
    liveSession: {} as never,
    turnsCompleted: 1,
    lastTurn: null,
    rateLimits: null,
  };
}
