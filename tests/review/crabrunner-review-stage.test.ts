import { describe, expect, it, vi } from "vitest";

import type { AgentRunInput } from "../../src/agent/runner.js";
import type {
  CrabrunnerReviewLaneSpec,
  ReviewJobGroupLaneEvidence,
} from "../../src/review/crabrunner-review-job-group.js";
import { runCrabrunnerReviewStage } from "../../src/review/crabrunner-review-stage.js";
import type { HeadlessCouncilGateResult } from "../../src/review/headless-council-gate.js";
import { buildReviewJournalEntries } from "../../src/review/review-journal-events.js";
import type {
  StageExecutionBackendInput,
  StageExecutionBackendResult,
  StageExecutionBackendRunner,
  StageExecutionJobSpec,
} from "../../src/stage-execution/backend.js";
import type {
  CrabrunnerStageExecutionEvidence,
  CrabrunnerTerminalEvidence,
} from "../../src/stage-execution/crabrunner-backend.js";

const RUN_GROUP_ID = "rg-review-855";
const CURRENT_HEAD = "head-current-855";
const ARTIFACT_DIR = "/artifacts/SYMPH-855";

function reviewerArtifact(input: {
  laneId: string;
  agent: "claude" | "pi" | "codex" | "kimi";
  modelFamily: string;
  verdict: "pass" | "fail" | "error";
  headSha?: string;
}): Record<string, unknown> {
  return {
    schemaVersion: 1,
    kind: "symphony-headless-council-reviewer-artifact",
    lane: {
      laneId: input.laneId,
      agent: input.agent,
      role: "reviewer",
      model: `${input.modelFamily}-model`,
      modelFamily: input.modelFamily,
      reasoningEffort: null,
      independentReviewer: true,
      mergeAuthoritative: true,
    },
    routing: { mode: "full", routingMode: null, round: 1 },
    reviewBundle: null,
    verdict: input.verdict,
    confidence: 0.9,
    parseStatus: "synthesized_from_markdown",
    rawArtifactPath: null,
    malformedReason: null,
    headSha: input.headSha ?? CURRENT_HEAD,
    sections: {
      p1: "",
      p2: "",
      track: "",
      dismissedOrTheoretical: "",
      triage: "",
    },
    findings: [],
    familySyntheses: [],
  };
}

function fakeBackend(
  byLane: Record<
    string,
    {
      admission?: CrabrunnerStageExecutionEvidence["admission"];
      terminal: CrabrunnerTerminalEvidence | null;
      collectedArtifact?: unknown;
    }
  >,
): StageExecutionBackendRunner<CrabrunnerStageExecutionEvidence> & {
  submitted: StageExecutionJobSpec[];
  collectedArtifacts: Record<string, unknown>;
} {
  const submitted: StageExecutionJobSpec[] = [];
  const collectedArtifacts: Record<string, unknown> = {};
  for (const [laneId, scripted] of Object.entries(byLane)) {
    if (scripted.collectedArtifact !== undefined) {
      collectedArtifacts[laneId] = scripted.collectedArtifact;
    }
  }
  return {
    backend: "crabrunner",
    submitted,
    collectedArtifacts,
    execute: vi.fn(
      async (
        input: StageExecutionBackendInput,
      ): Promise<
        StageExecutionBackendResult<CrabrunnerStageExecutionEvidence>
      > => {
        submitted.push(input.job);
        const laneId = input.job.identity.stageName ?? "";
        const scripted = byLane[laneId];
        if (scripted === undefined) {
          throw new Error(`no scripted evidence for lane ${laneId}`);
        }
        const admission = scripted.admission ?? {
          status: "accepted" as const,
          jobId: `job-${laneId}`,
        };
        const terminal = scripted.terminal;
        return {
          job: input.job,
          evidence: {
            admission,
            terminal,
            artifactRefs: terminal?.artifactRefs ?? [],
            usage: terminal?.usage ?? null,
          },
          result: {
            issue: input.runnerInput.issue,
            workspace: {
              path: "/artifacts",
              workspaceKey: input.runnerInput.issue.id,
              createdNow: false,
            },
            runAttempt: {
              issueId: input.runnerInput.issue.id,
              issueIdentifier: input.runnerInput.issue.identifier,
              attempt: input.runnerInput.attempt,
              workspacePath: "/artifacts",
              startedAt: "2026-06-21T00:00:00.000Z",
              status: terminal?.state === "succeeded" ? "succeeded" : "failed",
            },
            liveSession: {} as never,
            turnsCompleted: 0,
            lastTurn: null,
            rateLimits: null,
          },
        };
      },
    ),
  };
}

function reviewerLane(input: {
  laneId: string;
  agent: "claude" | "pi" | "codex" | "kimi";
  modelFamily: string;
}): CrabrunnerReviewLaneSpec {
  return {
    laneId: input.laneId,
    kind: "reviewer",
    agent: input.agent,
    role: "reviewer",
    model: `${input.modelFamily}-model`,
    modelFamily: input.modelFamily,
    reasoningEffort: null,
    independentReviewer: true,
    mergeAuthoritative: true,
  };
}

function runInput(): AgentRunInput {
  return {
    issue: {
      id: "issue-855",
      identifier: "SYMPH-855",
      title: "wire crabrunner review",
      description: null,
      priority: 1,
      state: "In Review",
      branchName: "claude/SYMPH-855",
      url: null,
      labels: [],
      blockedBy: [],
      createdAt: null,
      updatedAt: null,
    },
    attempt: null,
    stageName: "review",
  };
}

function buildJobSpec(lane: CrabrunnerReviewLaneSpec): StageExecutionJobSpec {
  return {
    backend: "crabrunner" as const,
    role: null,
    phase: null,
    identity: {
      issueId: "issue-855",
      issueIdentifier: "SYMPH-855",
      stageName: lane.laneId,
      stageAttempt: 0,
      runGroupId: RUN_GROUP_ID,
      profileId: null,
      baseRef: "base",
      targetHeadRef: CURRENT_HEAD,
      artifactRoot: ARTIFACT_DIR,
      idempotencyKey: `idem-${lane.laneId}`,
    },
    runner: {
      runnerKind: "crabrunner",
      model: lane.model,
      provider: null,
      reasoningEffort: lane.reasoningEffort,
    },
    enforcement: {
      required: true,
      budget: {
        maxTokens: 1000,
        maxUsd: 1,
        estimatedCostPer1kTokensUsd: 0.05,
        cachedTokenCostRatio: 0.1,
        liveBudgetGraceRatio: 0.2,
      },
      timing: {
        timeoutMs: 1000,
        stallTimeoutMs: 1000,
        noProgressTurns: 1,
        maxIterations: 1,
      },
      telemetry: {
        heartbeatIntervalMs: 1,
        progressIntervalMs: 1,
        usageIntervalMs: 1,
      },
      cancellation: {
        jobIdRequired: true,
        cooperativeAbort: true,
        processGroupKill: true,
        killGraceMs: 1,
      },
    },
  };
}

interface WrittenFile {
  path: string;
  contents: string;
}

function baseInput(overrides: {
  lanes: CrabrunnerReviewLaneSpec[];
  backend: StageExecutionBackendRunner<CrabrunnerStageExecutionEvidence> & {
    collectedArtifacts: Record<string, unknown>;
  };
  routingGuaranteeConditions?: readonly string[];
  written: WrittenFile[];
}) {
  return {
    issueId: "issue-855",
    issueIdentifier: "SYMPH-855",
    runGroupId: RUN_GROUP_ID,
    currentHeadSha: CURRENT_HEAD,
    artifactDir: ARTIFACT_DIR,
    pr: {
      repo: "mobilyze-llc/symphony-ts",
      number: 999,
      baseRef: "main",
      headRef: "claude/SYMPH-855",
    },
    baseSha: "base-sha-855",
    round: 1,
    mode: "full" as const,
    lanes: overrides.lanes,
    backend: overrides.backend,
    routingGuaranteeConditions: overrides.routingGuaranteeConditions ?? [],
    buildJobSpec,
    buildRunnerInput: (_lane: CrabrunnerReviewLaneSpec): AgentRunInput =>
      runInput(),
    collectArtifact: (lane: ReviewJobGroupLaneEvidence): unknown =>
      overrides.backend.collectedArtifacts[lane.laneId] ?? null,
    mkdir: async (_path: string): Promise<void> => {},
    writeFile: async (path: string, contents: string): Promise<void> => {
      overrides.written.push({ path, contents });
    },
    now: () => new Date("2026-06-21T00:00:00.000Z"),
  };
}

describe("runCrabrunnerReviewStage", () => {
  it("writes a merge-eligible review-result.json and a marker on a PASS", async () => {
    const backend = fakeBackend({
      "codex-high-lead": {
        terminal: {
          state: "succeeded",
          artifactRefs: ["/artifacts/codex.json"],
        },
        collectedArtifact: reviewerArtifact({
          laneId: "codex-high-lead",
          agent: "codex",
          modelFamily: "codex",
          verdict: "pass",
        }),
      },
      "pi-deepseek": {
        terminal: { state: "succeeded", artifactRefs: ["/artifacts/pi.json"] },
        collectedArtifact: reviewerArtifact({
          laneId: "pi-deepseek",
          agent: "pi",
          modelFamily: "deepseek",
          verdict: "pass",
        }),
      },
    });
    const written: WrittenFile[] = [];

    const stageResult = await runCrabrunnerReviewStage(
      baseInput({
        lanes: [
          reviewerLane({
            laneId: "codex-high-lead",
            agent: "codex",
            modelFamily: "codex",
          }),
          reviewerLane({
            laneId: "pi-deepseek",
            agent: "pi",
            modelFamily: "deepseek",
          }),
        ],
        backend,
        written,
      }),
    );

    // The marker carries the resolved review-result.json path and matches the
    // dispatcher contract the orchestrator extracts.
    expect(stageResult.markerMessage).toBe(
      `[REVIEW_GATE_RESULT_PATH: ${stageResult.reviewResultPath}]`,
    );
    expect(stageResult.result.verdict).toBe("pass");
    // Exactly one review-result.json is written, to the marker path.
    expect(written).toHaveLength(1);
    expect(written[0]?.path).toBe(stageResult.reviewResultPath);

    const parsed = JSON.parse(written[0]?.contents ?? "{}") as
      | HeadlessCouncilGateResult
      | Record<string, unknown>;
    const result = parsed as HeadlessCouncilGateResult;
    // The persisted artifact satisfies the orchestrator's anti-spoof path
    // equality (resultJson === marker, artifactDir === marker parent).
    expect(result.artifactPaths.resultJson).toBe(stageResult.reviewResultPath);
    expect(result.artifactPaths.artifactDir).toBe(ARTIFACT_DIR);
    // Merge eligibility must be true so buildReviewJournalEntries emits a
    // merge_candidate row (decorrelation_merge_eligible === true) on a PASS.
    expect(result.review_routing?.decorrelationBasis.mergeEligible).toBe(true);
    expect(result.review_metadata.reviewed_head_sha).toBe(CURRENT_HEAD);
    expect(result.review_metadata.base_sha).toBe("base-sha-855");
    expect(result.review_metadata.round).toBe(1);
    expect(result.issueId).toBe("SYMPH-855");
    expect(result.pr).toEqual({
      repo: "mobilyze-llc/symphony-ts",
      number: 999,
      baseRef: "main",
      headRef: "claude/SYMPH-855",
    });
  });

  it("writes a non-merge-eligible FAIL result (no merge candidate downstream)", async () => {
    const backend = fakeBackend({
      "codex-high-lead": {
        terminal: { state: "succeeded", artifactRefs: ["/a.json"] },
        collectedArtifact: reviewerArtifact({
          laneId: "codex-high-lead",
          agent: "codex",
          modelFamily: "codex",
          verdict: "fail",
        }),
      },
    });
    const written: WrittenFile[] = [];

    const stageResult = await runCrabrunnerReviewStage(
      baseInput({
        lanes: [
          reviewerLane({
            laneId: "codex-high-lead",
            agent: "codex",
            modelFamily: "codex",
          }),
        ],
        backend,
        written,
      }),
    );

    expect(stageResult.result.verdict).toBe("fail");
    const result = JSON.parse(
      written[0]?.contents ?? "{}",
    ) as HeadlessCouncilGateResult;
    expect(result.verdict).toBe("fail");
    // A non-pass verdict is never merge-eligible.
    expect(result.review_routing?.decorrelationBasis.mergeEligible).toBe(false);
  });

  it("downgrades to error and is not merge-eligible when routing guarantees fail", async () => {
    const backend = fakeBackend({
      "codex-high-lead": {
        terminal: { state: "succeeded", artifactRefs: ["/a.json"] },
        collectedArtifact: reviewerArtifact({
          laneId: "codex-high-lead",
          agent: "codex",
          modelFamily: "codex",
          verdict: "pass",
        }),
      },
    });
    const written: WrittenFile[] = [];

    const stageResult = await runCrabrunnerReviewStage(
      baseInput({
        lanes: [
          reviewerLane({
            laneId: "codex-high-lead",
            agent: "codex",
            modelFamily: "codex",
          }),
        ],
        backend,
        written,
        routingGuaranteeConditions: [
          "routing_absent_decorrelated_reviewer_artifact",
        ],
      }),
    );

    expect(stageResult.result.verdict).toBe("error");
    const result = JSON.parse(
      written[0]?.contents ?? "{}",
    ) as HeadlessCouncilGateResult;
    expect(result.verdict).toBe("error");
    expect(result.review_routing?.decorrelationBasis.mergeEligible).toBe(false);
    expect(result.degradedConditions).toContain(
      "routing_absent_decorrelated_reviewer_artifact",
    );
  });

  it("fails closed (error, no_reviewer_lanes) when the group has zero reviewer lanes", async () => {
    const backend = fakeBackend({});
    const written: WrittenFile[] = [];

    const stageResult = await runCrabrunnerReviewStage(
      baseInput({ lanes: [], backend, written }),
    );

    expect(stageResult.result.verdict).toBe("error");
    expect(backend.submitted).toEqual([]);
    const result = JSON.parse(
      written[0]?.contents ?? "{}",
    ) as HeadlessCouncilGateResult;
    expect(result.verdict).toBe("error");
    expect(result.degradedConditions).toContain("no_reviewer_lanes");
    expect(result.review_routing?.decorrelationBasis.mergeEligible).toBe(false);
  });

  it("produces a result that reduces to review_gate_result + merge_candidate rows on PASS", async () => {
    // This is the integration contract: the orchestrator's finalization requires
    // buildReviewJournalEntries to emit BOTH a review_gate_result and a
    // merge_candidate row (core.ts), else it parks. The mapped artifact must
    // satisfy that exactly as the legacy council-gate result does.
    const backend = fakeBackend({
      "codex-high-lead": {
        terminal: { state: "succeeded", artifactRefs: ["/a.json"] },
        collectedArtifact: reviewerArtifact({
          laneId: "codex-high-lead",
          agent: "codex",
          modelFamily: "codex",
          verdict: "pass",
        }),
      },
      "pi-deepseek": {
        terminal: { state: "succeeded", artifactRefs: ["/b.json"] },
        collectedArtifact: reviewerArtifact({
          laneId: "pi-deepseek",
          agent: "pi",
          modelFamily: "deepseek",
          verdict: "pass",
        }),
      },
    });
    const written: WrittenFile[] = [];

    const stageResult = await runCrabrunnerReviewStage(
      baseInput({
        lanes: [
          reviewerLane({
            laneId: "codex-high-lead",
            agent: "codex",
            modelFamily: "codex",
          }),
          reviewerLane({
            laneId: "pi-deepseek",
            agent: "pi",
            modelFamily: "deepseek",
          }),
        ],
        backend,
        written,
      }),
    );

    const entries = buildReviewJournalEntries(stageResult.result, {
      issueId: "issue-855",
      issueIdentifier: "SYMPH-855",
      stage: "review",
      source: "pipeline",
    });
    expect(entries.some((entry) => entry.kind === "review_gate_result")).toBe(
      true,
    );
    expect(entries.some((entry) => entry.kind === "merge_candidate")).toBe(
      true,
    );
  });

  it("produces a FAIL result that does NOT reduce to a merge_candidate row", async () => {
    const backend = fakeBackend({
      "codex-high-lead": {
        terminal: { state: "succeeded", artifactRefs: ["/a.json"] },
        collectedArtifact: reviewerArtifact({
          laneId: "codex-high-lead",
          agent: "codex",
          modelFamily: "codex",
          verdict: "fail",
        }),
      },
    });
    const written: WrittenFile[] = [];

    const stageResult = await runCrabrunnerReviewStage(
      baseInput({
        lanes: [
          reviewerLane({
            laneId: "codex-high-lead",
            agent: "codex",
            modelFamily: "codex",
          }),
        ],
        backend,
        written,
      }),
    );

    const entries = buildReviewJournalEntries(stageResult.result, {
      issueId: "issue-855",
      issueIdentifier: "SYMPH-855",
      stage: "review",
      source: "pipeline",
    });
    // A failing review is journaled but must NOT mint a merge candidate.
    expect(entries.some((entry) => entry.kind === "review_gate_result")).toBe(
      true,
    );
    expect(entries.some((entry) => entry.kind === "merge_candidate")).toBe(
      false,
    );
  });

  it("does not call any backend or model when mapping the verdict (deterministic)", async () => {
    const backend = fakeBackend({
      "codex-high-lead": {
        terminal: { state: "succeeded", artifactRefs: ["/a.json"] },
        collectedArtifact: reviewerArtifact({
          laneId: "codex-high-lead",
          agent: "codex",
          modelFamily: "codex",
          verdict: "pass",
        }),
      },
    });
    const written: WrittenFile[] = [];

    await runCrabrunnerReviewStage(
      baseInput({
        lanes: [
          reviewerLane({
            laneId: "codex-high-lead",
            agent: "codex",
            modelFamily: "codex",
          }),
        ],
        backend,
        written,
      }),
    );

    // The ONLY dispatch surface is the injected backend (one lane => one call).
    expect(backend.execute).toHaveBeenCalledTimes(1);
  });
});
