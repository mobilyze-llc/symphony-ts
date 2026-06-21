import { describe, expect, it, vi } from "vitest";

import type { AgentRunInput } from "../../src/agent/runner.js";
import {
  type CrabrunnerReviewLaneSpec,
  type ReviewJobGroupLaneEvidence,
  runCrabrunnerReviewJobGroup,
} from "../../src/review/crabrunner-review-job-group.js";
import type { BrowserQaEvidence } from "../../src/review/qa-evidence.js";
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

const RUN_GROUP_ID = "rg-review-810";
const CURRENT_HEAD = "head-current-aaa";

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

function qaArtifact(
  overrides: Partial<BrowserQaEvidence> = {},
): Record<string, unknown> {
  return {
    schemaVersion: 1,
    kind: "symphony-browser-qa-evidence",
    targetUrl: "http://localhost:3000/checkout",
    headSha: CURRENT_HEAD,
    scenario: "checkout happy path",
    assertions: [{ description: "submit enabled", passed: true }],
    mediaRefs: [
      { kind: "screenshot", path: "/artifacts/qa/shot.png", sha256: "qa-sha" },
    ],
    consoleFindings: [],
    networkFindings: [],
    failureRule: {
      id: "no-console-errors",
      description: "no console errors and all assertions pass",
      violated: false,
    },
    ...overrides,
  } as Record<string, unknown>;
}

/**
 * A fake StageExecutionBackendRunner that returns scripted crabrunner evidence
 * keyed by lane id. This is the ONLY mock the job group needs — there is no
 * production scheduler client.
 */
function fakeBackend(
  byLane: Record<
    string,
    {
      admission?: CrabrunnerStageExecutionEvidence["admission"];
      terminal: CrabrunnerTerminalEvidence | null;
      runStatus?: StageExecutionBackendResult["result"]["runAttempt"]["status"];
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
        const runStatus =
          scripted.runStatus ??
          (terminal?.state === "succeeded" ? "succeeded" : "failed");
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
              path: terminal?.workspacePath ?? "/artifacts",
              workspaceKey: input.runnerInput.issue.id,
              createdNow: false,
            },
            runAttempt: {
              issueId: input.runnerInput.issue.id,
              issueIdentifier: input.runnerInput.issue.identifier,
              attempt: input.runnerInput.attempt,
              workspacePath: terminal?.workspacePath ?? "/artifacts",
              startedAt: "2026-06-21T00:00:00.000Z",
              status: runStatus,
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
  mergeAuthoritative?: boolean;
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
    mergeAuthoritative: input.mergeAuthoritative ?? true,
  };
}

function qaLane(): CrabrunnerReviewLaneSpec {
  return {
    laneId: "browser-qa",
    kind: "browser-qa",
    agent: "claude",
    role: "browser-qa",
    model: "qa-runner",
    modelFamily: "qa",
    reasoningEffort: null,
    independentReviewer: false,
    mergeAuthoritative: false,
  };
}

function runInput(): AgentRunInput {
  return {
    issue: {
      id: "issue-810",
      identifier: "SYMPH-810",
      title: "crabrunner review + QA job groups",
      description: null,
      priority: 1,
      state: "In Review",
      branchName: "claude/SYMPH-810",
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

function baseInput(overrides: {
  lanes: CrabrunnerReviewLaneSpec[];
  backend: StageExecutionBackendRunner<CrabrunnerStageExecutionEvidence>;
  routingGuaranteeConditions?: readonly string[];
}) {
  return {
    issueId: "issue-810",
    runGroupId: RUN_GROUP_ID,
    currentHeadSha: CURRENT_HEAD,
    lanes: overrides.lanes,
    backend: overrides.backend,
    routingGuaranteeConditions: overrides.routingGuaranteeConditions ?? [],
    buildJobSpec: (lane: CrabrunnerReviewLaneSpec): StageExecutionJobSpec => ({
      backend: "crabrunner" as const,
      role: null,
      phase: null,
      identity: {
        issueId: "issue-810",
        issueIdentifier: "SYMPH-810",
        stageName: lane.laneId,
        stageAttempt: 0,
        runGroupId: RUN_GROUP_ID,
        profileId: null,
        baseRef: "base",
        targetHeadRef: CURRENT_HEAD,
        artifactRoot: "/artifacts/SYMPH-810",
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
    }),
    buildRunnerInput: (_lane: CrabrunnerReviewLaneSpec): AgentRunInput =>
      runInput(),
  };
}

describe("runCrabrunnerReviewJobGroup", () => {
  it("submits each lane under one run group and aggregates a PASS verdict", async () => {
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

    const result = await runCrabrunnerReviewJobGroup({
      ...baseInput({
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
      }),
      collectArtifact: async (lane: ReviewJobGroupLaneEvidence) =>
        backendArtifactFor(backend, lane),
    });

    expect(result.verdict).toBe("pass");
    // All lanes share the same run group id (the job-group invariant).
    expect(backend.submitted.map((job) => job.identity.runGroupId)).toEqual([
      RUN_GROUP_ID,
      RUN_GROUP_ID,
    ]);
    expect(result.lanes.map((lane) => lane.laneId)).toEqual([
      "codex-high-lead",
      "pi-deepseek",
    ]);
    expect(result.lanes.every((lane) => lane.state === "complete")).toBe(true);
    // Cross-host provenance is explicit on every lane.
    expect(result.provenance.lanes).toEqual([
      expect.objectContaining({
        laneId: "codex-high-lead",
        runGroupId: RUN_GROUP_ID,
        jobId: "job-codex-high-lead",
        artifactRefs: ["/artifacts/codex.json"],
      }),
      expect.objectContaining({
        laneId: "pi-deepseek",
        jobId: "job-pi-deepseek",
        artifactRefs: ["/artifacts/pi.json"],
      }),
    ]);
  });

  it("fails closed when a reviewer lane is unavailable (admission rejected)", async () => {
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
        admission: { status: "rejected", jobId: null, reason: "no-capacity" },
        terminal: null,
        runStatus: "failed",
      },
    });

    const result = await runCrabrunnerReviewJobGroup({
      ...baseInput({
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
      }),
      collectArtifact: async (lane: ReviewJobGroupLaneEvidence) =>
        backendArtifactFor(backend, lane),
    });

    expect(result.verdict).toBe("error");
    const piLane = result.lanes.find((lane) => lane.laneId === "pi-deepseek");
    expect(piLane?.state).toBe("error");
    expect(result.degradedConditions).toContain("lane_unavailable:pi-deepseek");
  });

  it("fails closed on concurrency/admission ambiguity (accepted without job id)", async () => {
    const backend = fakeBackend({
      "codex-high-lead": {
        // Accepted but no job id -> admission ambiguity; must not pass.
        admission: { status: "accepted", jobId: null },
        terminal: null,
        runStatus: "failed",
      },
    });

    const result = await runCrabrunnerReviewJobGroup({
      ...baseInput({
        lanes: [
          reviewerLane({
            laneId: "codex-high-lead",
            agent: "codex",
            modelFamily: "codex",
          }),
        ],
        backend,
      }),
      collectArtifact: async (lane: ReviewJobGroupLaneEvidence) =>
        backendArtifactFor(backend, lane),
    });

    expect(result.verdict).toBe("error");
    expect(result.degradedConditions).toContain(
      "admission_ambiguous:codex-high-lead",
    );
  });

  it("fails closed when a succeeded lane produced no artifact refs (provenance failure)", async () => {
    const backend = fakeBackend({
      "codex-high-lead": {
        // Terminal succeeded but no host-owned artifact refs -> cross-host
        // provenance cannot be established.
        terminal: { state: "succeeded", artifactRefs: [] },
        collectedArtifact: reviewerArtifact({
          laneId: "codex-high-lead",
          agent: "codex",
          modelFamily: "codex",
          verdict: "pass",
        }),
      },
    });

    const result = await runCrabrunnerReviewJobGroup({
      ...baseInput({
        lanes: [
          reviewerLane({
            laneId: "codex-high-lead",
            agent: "codex",
            modelFamily: "codex",
          }),
        ],
        backend,
      }),
      collectArtifact: async (lane: ReviewJobGroupLaneEvidence) =>
        backendArtifactFor(backend, lane),
    });

    expect(result.verdict).toBe("error");
    expect(result.degradedConditions).toContain(
      "artifact_provenance_missing:codex-high-lead",
    );
  });

  it("fails closed on a malformed reviewer artifact", async () => {
    const backend = fakeBackend({
      "codex-high-lead": {
        terminal: { state: "succeeded", artifactRefs: ["/a.json"] },
        collectedArtifact: { not: "a reviewer artifact" },
      },
    });

    const result = await runCrabrunnerReviewJobGroup({
      ...baseInput({
        lanes: [
          reviewerLane({
            laneId: "codex-high-lead",
            agent: "codex",
            modelFamily: "codex",
          }),
        ],
        backend,
      }),
      collectArtifact: async (lane: ReviewJobGroupLaneEvidence) =>
        backendArtifactFor(backend, lane),
    });

    expect(result.verdict).toBe("error");
    const lane = result.lanes[0];
    expect(lane?.state).toBe("error");
    expect(lane?.degradedReason).toBe("malformed_artifact");
    expect(result.degradedConditions).toContain(
      "malformed_artifact:codex-high-lead",
    );
  });

  it("fails closed when a reviewer artifact targets a stale head", async () => {
    const backend = fakeBackend({
      "codex-high-lead": {
        terminal: { state: "succeeded", artifactRefs: ["/a.json"] },
        collectedArtifact: reviewerArtifact({
          laneId: "codex-high-lead",
          agent: "codex",
          modelFamily: "codex",
          verdict: "pass",
          headSha: "head-stale-zzz",
        }),
      },
    });

    const result = await runCrabrunnerReviewJobGroup({
      ...baseInput({
        lanes: [
          reviewerLane({
            laneId: "codex-high-lead",
            agent: "codex",
            modelFamily: "codex",
          }),
        ],
        backend,
      }),
      collectArtifact: async (lane: ReviewJobGroupLaneEvidence) =>
        backendArtifactFor(backend, lane),
    });

    expect(result.verdict).toBe("error");
    expect(result.degradedConditions).toContain("stale_review:codex-high-lead");
  });

  it("downgrades to error when routing guarantees fail on an otherwise-passing group", async () => {
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

    const result = await runCrabrunnerReviewJobGroup({
      ...baseInput({
        lanes: [
          reviewerLane({
            laneId: "codex-high-lead",
            agent: "codex",
            modelFamily: "codex",
          }),
        ],
        backend,
        routingGuaranteeConditions: [
          "routing_absent_decorrelated_reviewer_artifact",
        ],
      }),
      collectArtifact: async (lane: ReviewJobGroupLaneEvidence) =>
        backendArtifactFor(backend, lane),
    });

    expect(result.verdict).toBe("error");
  });

  it("includes a passing browser-QA lane and keeps the group PASS", async () => {
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
      "browser-qa": {
        terminal: { state: "succeeded", artifactRefs: ["/qa.json"] },
        collectedArtifact: qaArtifact(),
      },
    });

    const result = await runCrabrunnerReviewJobGroup({
      ...baseInput({
        lanes: [
          reviewerLane({
            laneId: "codex-high-lead",
            agent: "codex",
            modelFamily: "codex",
          }),
          qaLane(),
        ],
        backend,
      }),
      collectArtifact: async (lane: ReviewJobGroupLaneEvidence) =>
        backendArtifactFor(backend, lane),
    });

    expect(result.verdict).toBe("pass");
    expect(result.qa).not.toBeNull();
    expect(result.qa?.assessment.disposition).toBe("pass");
    expect(result.qa?.evidence?.scenario).toBe("checkout happy path");
    // The QA lane shares the run group but is not merge-authoritative, so it
    // does not enter the reviewer verdict aggregation as a reviewer lane.
    expect(
      result.lanes.find((lane) => lane.laneId === "browser-qa"),
    ).toBeUndefined();
  });

  it("fails closed when the browser-QA failure rule is violated", async () => {
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
      "browser-qa": {
        terminal: { state: "succeeded", artifactRefs: ["/qa.json"] },
        collectedArtifact: qaArtifact({
          consoleFindings: [{ level: "error", message: "boom" }],
          failureRule: {
            id: "no-console-errors",
            description: "no console errors and all assertions pass",
            violated: true,
          },
        }),
      },
    });

    const result = await runCrabrunnerReviewJobGroup({
      ...baseInput({
        lanes: [
          reviewerLane({
            laneId: "codex-high-lead",
            agent: "codex",
            modelFamily: "codex",
          }),
          qaLane(),
        ],
        backend,
      }),
      collectArtifact: async (lane: ReviewJobGroupLaneEvidence) =>
        backendArtifactFor(backend, lane),
    });

    expect(result.verdict).toBe("error");
    expect(result.qa?.assessment.disposition).toBe("block");
    expect(result.degradedConditions).toContain(
      "qa_failure_rule_violated:no-console-errors",
    );
  });

  it("fails closed when a required QA artifact is missing", async () => {
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
      "browser-qa": {
        terminal: { state: "succeeded", artifactRefs: ["/qa.json"] },
        // No collectedArtifact -> QA evidence missing.
        collectedArtifact: undefined,
      },
    });

    const result = await runCrabrunnerReviewJobGroup({
      ...baseInput({
        lanes: [
          reviewerLane({
            laneId: "codex-high-lead",
            agent: "codex",
            modelFamily: "codex",
          }),
          qaLane(),
        ],
        backend,
      }),
      collectArtifact: async (lane: ReviewJobGroupLaneEvidence) =>
        backendArtifactFor(backend, lane),
    });

    expect(result.verdict).toBe("error");
    expect(result.qa?.assessment.disposition).toBe("block");
    expect(result.degradedConditions).toContain("qa_evidence_missing");
  });

  it("uses the same StageExecutionBackendResult boundary as other delegated stages", async () => {
    // Every lane dispatch must flow through backend.execute (the shared seam),
    // never a direct scheduler client call. We assert the backend was the only
    // dispatch surface and that each lane carries its backend result.
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

    const result = await runCrabrunnerReviewJobGroup({
      ...baseInput({
        lanes: [
          reviewerLane({
            laneId: "codex-high-lead",
            agent: "codex",
            modelFamily: "codex",
          }),
        ],
        backend,
      }),
      collectArtifact: async (lane: ReviewJobGroupLaneEvidence) =>
        backendArtifactFor(backend, lane),
    });

    expect(backend.execute).toHaveBeenCalledTimes(1);
    expect(result.provenance.lanes[0]?.backendResult.job.backend).toBe(
      "crabrunner",
    );
    expect(
      result.provenance.lanes[0]?.backendResult.result.runAttempt.status,
    ).toBe("succeeded");
  });

  it("rejects a non-crabrunner backend (job-group invariant)", async () => {
    const wrongBackend = {
      backend: "current-runner" as const,
      execute: vi.fn(),
    } as unknown as StageExecutionBackendRunner<CrabrunnerStageExecutionEvidence>;

    await expect(
      runCrabrunnerReviewJobGroup({
        ...baseInput({
          lanes: [
            reviewerLane({
              laneId: "codex-high-lead",
              agent: "codex",
              modelFamily: "codex",
            }),
          ],
          backend: wrongBackend,
        }),
        collectArtifact: async () => null,
      }),
    ).rejects.toThrow(/crabrunner/);
  });

  // P2-1: the QA lane's evidence must be asserted against the current PR head,
  // exactly like the reviewer lanes — a stale QA artifact must not pass.
  it("fails closed when the browser-QA artifact targets a stale head", async () => {
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
      "browser-qa": {
        terminal: { state: "succeeded", artifactRefs: ["/qa.json"] },
        // Every assertion passes and the rule is not violated, but the QA run
        // was captured against an older commit.
        collectedArtifact: qaArtifact({ headSha: "head-stale-zzz" }),
      },
    });

    const result = await runCrabrunnerReviewJobGroup({
      ...baseInput({
        lanes: [
          reviewerLane({
            laneId: "codex-high-lead",
            agent: "codex",
            modelFamily: "codex",
          }),
          qaLane(),
        ],
        backend,
      }),
      collectArtifact: async (lane: ReviewJobGroupLaneEvidence) =>
        backendArtifactFor(backend, lane),
    });

    expect(result.verdict).toBe("error");
    expect(result.qa?.assessment.disposition).toBe("block");
    expect(result.degradedConditions).toContain("qa_stale_review");
  });

  // P2-3: a collected reviewer artifact must be bound to the lane it was
  // collected for — a misattributed artifact from another lane fails closed.
  it("fails closed when a reviewer artifact's lane identity does not match the lane", async () => {
    const backend = fakeBackend({
      "codex-high-lead": {
        terminal: { state: "succeeded", artifactRefs: ["/a.json"] },
        // The artifact claims to be from a DIFFERENT lane/agent/family.
        collectedArtifact: reviewerArtifact({
          laneId: "pi-deepseek",
          agent: "pi",
          modelFamily: "deepseek",
          verdict: "pass",
        }),
      },
    });

    const result = await runCrabrunnerReviewJobGroup({
      ...baseInput({
        lanes: [
          reviewerLane({
            laneId: "codex-high-lead",
            agent: "codex",
            modelFamily: "codex",
          }),
        ],
        backend,
      }),
      collectArtifact: async (lane: ReviewJobGroupLaneEvidence) =>
        backendArtifactFor(backend, lane),
    });

    expect(result.verdict).toBe("error");
    const lane = result.lanes[0];
    expect(lane?.state).toBe("error");
    expect(lane?.degradedReason).toBe("malformed_artifact");
    expect(result.degradedConditions).toContain(
      "artifact_lane_mismatch:codex-high-lead",
    );
  });

  it("fails closed when only the artifact's model family is spoofed", async () => {
    const backend = fakeBackend({
      "codex-high-lead": {
        terminal: { state: "succeeded", artifactRefs: ["/a.json"] },
        collectedArtifact: reviewerArtifact({
          laneId: "codex-high-lead",
          agent: "codex",
          // matching laneId + agent, but a different model family.
          modelFamily: "deepseek",
          verdict: "pass",
        }),
      },
    });

    const result = await runCrabrunnerReviewJobGroup({
      ...baseInput({
        lanes: [
          reviewerLane({
            laneId: "codex-high-lead",
            agent: "codex",
            modelFamily: "codex",
          }),
        ],
        backend,
      }),
      collectArtifact: async (lane: ReviewJobGroupLaneEvidence) =>
        backendArtifactFor(backend, lane),
    });

    expect(result.verdict).toBe("error");
    expect(result.degradedConditions).toContain(
      "artifact_lane_mismatch:codex-high-lead",
    );
  });

  // Track-1: routing-guarantee conditions that drive a non-pass verdict must
  // appear in degradedConditions (the documented machine-readable reasons).
  it("records routing-guarantee conditions in degradedConditions when they downgrade the verdict", async () => {
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

    const result = await runCrabrunnerReviewJobGroup({
      ...baseInput({
        lanes: [
          reviewerLane({
            laneId: "codex-high-lead",
            agent: "codex",
            modelFamily: "codex",
          }),
        ],
        backend,
        routingGuaranteeConditions: [
          "routing_absent_decorrelated_reviewer_artifact",
        ],
      }),
      collectArtifact: async (lane: ReviewJobGroupLaneEvidence) =>
        backendArtifactFor(backend, lane),
    });

    expect(result.verdict).toBe("error");
    expect(result.degradedConditions).toContain(
      "routing_absent_decorrelated_reviewer_artifact",
    );
  });

  // P2-A: an artifact with verdict:"pass" but a structurally incomplete
  // StructuredReviewerArtifact (missing sections/findings/routing/confidence)
  // must NOT produce a group PASS — it fails closed as malformed.
  it("fails closed when a pass-verdict artifact is structurally incomplete", async () => {
    const incomplete = {
      schemaVersion: 1,
      kind: "symphony-headless-council-reviewer-artifact",
      lane: {
        laneId: "codex-high-lead",
        agent: "codex",
        role: "reviewer",
        model: "codex-model",
        modelFamily: "codex",
        reasoningEffort: null,
        independentReviewer: true,
        mergeAuthoritative: true,
      },
      verdict: "pass",
      headSha: CURRENT_HEAD,
      // MISSING: routing, confidence, sections, findings.
    };
    const backend = fakeBackend({
      "codex-high-lead": {
        terminal: { state: "succeeded", artifactRefs: ["/a.json"] },
        collectedArtifact: incomplete,
      },
    });

    const result = await runCrabrunnerReviewJobGroup({
      ...baseInput({
        lanes: [
          reviewerLane({
            laneId: "codex-high-lead",
            agent: "codex",
            modelFamily: "codex",
          }),
        ],
        backend,
      }),
      collectArtifact: async (lane: ReviewJobGroupLaneEvidence) =>
        backendArtifactFor(backend, lane),
    });

    expect(result.verdict).toBe("error");
    const lane = result.lanes[0];
    expect(lane?.state).toBe("error");
    expect(lane?.degradedReason).toBe("malformed_artifact");
    expect(result.degradedConditions).toContain(
      "malformed_artifact:codex-high-lead",
    );
  });

  // Track-B: verdict aggregation coverage beyond "pass".
  it("aggregates a reviewer FAIL verdict to a group FAIL", async () => {
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

    const result = await runCrabrunnerReviewJobGroup({
      ...baseInput({
        lanes: [
          reviewerLane({
            laneId: "codex-high-lead",
            agent: "codex",
            modelFamily: "codex",
          }),
        ],
        backend,
      }),
      collectArtifact: async (lane: ReviewJobGroupLaneEvidence) =>
        backendArtifactFor(backend, lane),
    });

    expect(result.verdict).toBe("fail");
    const lane = result.lanes[0];
    expect(lane?.state).toBe("complete");
    expect(lane?.verdict).toBe("fail");
  });

  it("aggregates a reviewer ERROR verdict to a group ERROR", async () => {
    const backend = fakeBackend({
      "codex-high-lead": {
        terminal: { state: "succeeded", artifactRefs: ["/a.json"] },
        collectedArtifact: reviewerArtifact({
          laneId: "codex-high-lead",
          agent: "codex",
          modelFamily: "codex",
          verdict: "error",
        }),
      },
    });

    const result = await runCrabrunnerReviewJobGroup({
      ...baseInput({
        lanes: [
          reviewerLane({
            laneId: "codex-high-lead",
            agent: "codex",
            modelFamily: "codex",
          }),
        ],
        backend,
      }),
      collectArtifact: async (lane: ReviewJobGroupLaneEvidence) =>
        backendArtifactFor(backend, lane),
    });

    expect(result.verdict).toBe("error");
  });

  it("a reviewer FAIL alongside a PASS still aggregates to FAIL", async () => {
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
        terminal: { state: "succeeded", artifactRefs: ["/pi.json"] },
        collectedArtifact: reviewerArtifact({
          laneId: "pi-deepseek",
          agent: "pi",
          modelFamily: "deepseek",
          verdict: "fail",
        }),
      },
    });

    const result = await runCrabrunnerReviewJobGroup({
      ...baseInput({
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
      }),
      collectArtifact: async (lane: ReviewJobGroupLaneEvidence) =>
        backendArtifactFor(backend, lane),
    });

    expect(result.verdict).toBe("fail");
  });

  // P2-B: the contract is a SINGLE optional browser-QA lane. More than one must
  // fail the group closed rather than letting a later passing QA overwrite an
  // earlier blocking one.
  it("fails closed when more than one browser-QA lane is present", async () => {
    const secondQaLane: CrabrunnerReviewLaneSpec = {
      ...qaLane(),
      laneId: "browser-qa-2",
    };
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
      "browser-qa": {
        terminal: { state: "succeeded", artifactRefs: ["/qa1.json"] },
        // First QA lane BLOCKS (failure rule violated).
        collectedArtifact: qaArtifact({
          consoleFindings: [{ level: "error", message: "boom" }],
          failureRule: {
            id: "no-console-errors",
            description: "rule",
            violated: true,
          },
        }),
      },
      "browser-qa-2": {
        terminal: { state: "succeeded", artifactRefs: ["/qa2.json"] },
        // Second QA lane passes — must NOT mask the first.
        collectedArtifact: qaArtifact(),
      },
    });

    const result = await runCrabrunnerReviewJobGroup({
      ...baseInput({
        lanes: [
          reviewerLane({
            laneId: "codex-high-lead",
            agent: "codex",
            modelFamily: "codex",
          }),
          qaLane(),
          secondQaLane,
        ],
        backend,
      }),
      collectArtifact: async (lane: ReviewJobGroupLaneEvidence) =>
        backendArtifactFor(backend, lane),
    });

    expect(result.verdict).toBe("error");
    expect(result.degradedConditions).toContain("multiple_browser_qa_lanes");
  });

  // P2-C: the FULL StructuredReviewerArtifact top-level contract must be present
  // before an artifact is accepted. parseStatus/reviewBundle/rawArtifactPath/
  // malformedReason/familySyntheses are part of that contract; omitting them on a
  // verdict:"pass" artifact must still fail closed.
  it("fails closed when a pass-verdict artifact omits parseStatus", async () => {
    const artifact = reviewerArtifact({
      laneId: "codex-high-lead",
      agent: "codex",
      modelFamily: "codex",
      verdict: "pass",
    });
    artifact.parseStatus = undefined;
    const backend = fakeBackend({
      "codex-high-lead": {
        terminal: { state: "succeeded", artifactRefs: ["/a.json"] },
        collectedArtifact: artifact,
      },
    });

    const result = await runCrabrunnerReviewJobGroup({
      ...baseInput({
        lanes: [
          reviewerLane({
            laneId: "codex-high-lead",
            agent: "codex",
            modelFamily: "codex",
          }),
        ],
        backend,
      }),
      collectArtifact: async (lane: ReviewJobGroupLaneEvidence) =>
        backendArtifactFor(backend, lane),
    });

    expect(result.verdict).toBe("error");
    expect(result.lanes[0]?.degradedReason).toBe("malformed_artifact");
    expect(result.degradedConditions).toContain(
      "malformed_artifact:codex-high-lead",
    );
  });

  it("fails closed when a pass-verdict artifact self-declares a malformed parse", async () => {
    // parseStatus:"malformed" (or a non-null malformedReason) is a self-declared
    // bad parse and must fail closed regardless of the verdict field.
    const artifact = reviewerArtifact({
      laneId: "codex-high-lead",
      agent: "codex",
      modelFamily: "codex",
      verdict: "pass",
    });
    artifact.parseStatus = "malformed";
    artifact.malformedReason = "reviewer emitted unparseable sections";
    const backend = fakeBackend({
      "codex-high-lead": {
        terminal: { state: "succeeded", artifactRefs: ["/a.json"] },
        collectedArtifact: artifact,
      },
    });

    const result = await runCrabrunnerReviewJobGroup({
      ...baseInput({
        lanes: [
          reviewerLane({
            laneId: "codex-high-lead",
            agent: "codex",
            modelFamily: "codex",
          }),
        ],
        backend,
      }),
      collectArtifact: async (lane: ReviewJobGroupLaneEvidence) =>
        backendArtifactFor(backend, lane),
    });

    expect(result.verdict).toBe("error");
    expect(result.degradedConditions).toContain(
      "malformed_artifact:codex-high-lead",
    );
  });

  it("fails closed when a pass-verdict artifact omits reviewBundle", async () => {
    const artifact = reviewerArtifact({
      laneId: "codex-high-lead",
      agent: "codex",
      modelFamily: "codex",
      verdict: "pass",
    });
    artifact.reviewBundle = undefined;
    const backend = fakeBackend({
      "codex-high-lead": {
        terminal: { state: "succeeded", artifactRefs: ["/a.json"] },
        collectedArtifact: artifact,
      },
    });

    const result = await runCrabrunnerReviewJobGroup({
      ...baseInput({
        lanes: [
          reviewerLane({
            laneId: "codex-high-lead",
            agent: "codex",
            modelFamily: "codex",
          }),
        ],
        backend,
      }),
      collectArtifact: async (lane: ReviewJobGroupLaneEvidence) =>
        backendArtifactFor(backend, lane),
    });

    expect(result.verdict).toBe("error");
    expect(result.degradedConditions).toContain(
      "malformed_artifact:codex-high-lead",
    );
  });

  it("fails closed when a pass-verdict artifact's familySyntheses is not an array", async () => {
    const artifact = reviewerArtifact({
      laneId: "codex-high-lead",
      agent: "codex",
      modelFamily: "codex",
      verdict: "pass",
    });
    artifact.familySyntheses = undefined;
    const backend = fakeBackend({
      "codex-high-lead": {
        terminal: { state: "succeeded", artifactRefs: ["/a.json"] },
        collectedArtifact: artifact,
      },
    });

    const result = await runCrabrunnerReviewJobGroup({
      ...baseInput({
        lanes: [
          reviewerLane({
            laneId: "codex-high-lead",
            agent: "codex",
            modelFamily: "codex",
          }),
        ],
        backend,
      }),
      collectArtifact: async (lane: ReviewJobGroupLaneEvidence) =>
        backendArtifactFor(backend, lane),
    });

    expect(result.verdict).toBe("error");
    expect(result.degradedConditions).toContain(
      "malformed_artifact:codex-high-lead",
    );
  });

  it("fails closed when a pass-verdict artifact omits the nullable reasoningEffort lane key", async () => {
    // DeepSeek TR-1: the "all lane fields present" guarantee must include the
    // nullable reasoningEffort key (present, null allowed).
    const artifact = reviewerArtifact({
      laneId: "codex-high-lead",
      agent: "codex",
      modelFamily: "codex",
      verdict: "pass",
    });
    // Rebuild the lane WITHOUT the reasoningEffort key (truly absent).
    const { reasoningEffort: _omitted, ...laneWithoutReasoningEffort } =
      artifact.lane as Record<string, unknown>;
    artifact.lane = laneWithoutReasoningEffort;
    const backend = fakeBackend({
      "codex-high-lead": {
        terminal: { state: "succeeded", artifactRefs: ["/a.json"] },
        collectedArtifact: artifact,
      },
    });

    const result = await runCrabrunnerReviewJobGroup({
      ...baseInput({
        lanes: [
          reviewerLane({
            laneId: "codex-high-lead",
            agent: "codex",
            modelFamily: "codex",
          }),
        ],
        backend,
      }),
      collectArtifact: async (lane: ReviewJobGroupLaneEvidence) =>
        backendArtifactFor(backend, lane),
    });

    expect(result.verdict).toBe("error");
    expect(result.degradedConditions).toContain(
      "malformed_artifact:codex-high-lead",
    );
  });

  it("accepts a fully-formed artifact (regression guard for the stricter validator)", async () => {
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

    const result = await runCrabrunnerReviewJobGroup({
      ...baseInput({
        lanes: [
          reviewerLane({
            laneId: "codex-high-lead",
            agent: "codex",
            modelFamily: "codex",
          }),
        ],
        backend,
      }),
      collectArtifact: async (lane: ReviewJobGroupLaneEvidence) =>
        backendArtifactFor(backend, lane),
    });

    expect(result.verdict).toBe("pass");
    expect(result.lanes[0]?.state).toBe("complete");
  });

  // P2-D: a lane's job spec must belong to THIS run group. A buildJobSpec that
  // returns a mismatched runGroupId would dispatch a lane outside the intended
  // group while provenance claims membership — fail closed before dispatch.
  it("fails closed when a lane's job spec runGroupId does not match the group", async () => {
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

    const base = baseInput({
      lanes: [
        reviewerLane({
          laneId: "codex-high-lead",
          agent: "codex",
          modelFamily: "codex",
        }),
      ],
      backend,
    });

    const result = await runCrabrunnerReviewJobGroup({
      ...base,
      // Override buildJobSpec to return a DIFFERENT runGroupId than the group.
      buildJobSpec: (lane: CrabrunnerReviewLaneSpec): StageExecutionJobSpec => {
        const job = base.buildJobSpec(lane);
        return {
          ...job,
          identity: { ...job.identity, runGroupId: "rg-WRONG-group" },
        };
      },
      collectArtifact: async (lane: ReviewJobGroupLaneEvidence) =>
        backendArtifactFor(backend, lane),
    });

    expect(result.verdict).toBe("error");
    expect(result.lanes[0]?.state).toBe("error");
    expect(result.degradedConditions).toContain(
      "run_group_mismatch:codex-high-lead",
    );
    // The lane must NOT have been dispatched (fail closed BEFORE execute).
    expect(backend.execute).not.toHaveBeenCalled();
  });

  // TR-3 (DeepSeek): qaMissingPolicy:"degrade" passes through to the assessor so
  // a missing QA artifact degrades (still gating) rather than hard-blocking.
  it('passes qaMissingPolicy:"degrade" through to the QA assessor', async () => {
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
      "browser-qa": {
        terminal: { state: "succeeded", artifactRefs: ["/qa.json"] },
        // No collected QA artifact -> missing QA evidence.
        collectedArtifact: undefined,
      },
    });

    const result = await runCrabrunnerReviewJobGroup({
      ...baseInput({
        lanes: [
          reviewerLane({
            laneId: "codex-high-lead",
            agent: "codex",
            modelFamily: "codex",
          }),
          qaLane(),
        ],
        backend,
      }),
      qaMissingPolicy: "degrade",
      collectArtifact: async (lane: ReviewJobGroupLaneEvidence) =>
        backendArtifactFor(backend, lane),
    });

    expect(result.qa?.assessment.disposition).toBe("degrade");
    expect(result.qa?.assessment.blocking).toBe(true);
    expect(result.qa?.assessment.reasons).toContain("qa_evidence_missing");
    // A degraded QA still gates the group (not a silent PASS).
    expect(result.verdict).toBe("error");
  });

  // TR-4 (DeepSeek): a terminal that is null/undefined despite an accepted
  // admission with a job id must fail closed (no terminal evidence => unprovable).
  it("fails closed when terminal evidence is null despite an accepted admission with a job id", async () => {
    const backend = fakeBackend({
      "codex-high-lead": {
        admission: { status: "accepted", jobId: "job-codex-high-lead" },
        terminal: null,
        runStatus: "failed",
      },
    });

    const result = await runCrabrunnerReviewJobGroup({
      ...baseInput({
        lanes: [
          reviewerLane({
            laneId: "codex-high-lead",
            agent: "codex",
            modelFamily: "codex",
          }),
        ],
        backend,
      }),
      collectArtifact: async (lane: ReviewJobGroupLaneEvidence) =>
        backendArtifactFor(backend, lane),
    });

    expect(result.verdict).toBe("error");
    expect(result.lanes[0]?.state).toBe("error");
    expect(result.degradedConditions).toContain(
      "lane_unavailable:codex-high-lead",
    );
  });

  // SYMPH-855 Track (a): a job group that resolves ZERO usable reviewer lanes
  // must fail closed BEFORE any dispatch with an explicit machine-readable
  // condition, never an unexplained `error` verdict. aggregateHeadlessVerdict
  // already returns "error" for zero authoritative lanes, but without this guard
  // the cause is invisible (empty degradedConditions) — and a QA-only group
  // would otherwise dispatch a QA lane with no reviewer ever gating it.
  it("fails closed with no_reviewer_lanes when the group has zero reviewer lanes", async () => {
    const backend = fakeBackend({});

    const result = await runCrabrunnerReviewJobGroup({
      ...baseInput({ lanes: [], backend }),
      collectArtifact: async (lane: ReviewJobGroupLaneEvidence) =>
        backendArtifactFor(backend, lane),
    });

    expect(result.verdict).toBe("error");
    expect(result.degradedConditions).toContain("no_reviewer_lanes");
    expect(result.lanes).toEqual([]);
    // Guard runs before dispatch: nothing is submitted to the backend.
    expect(backend.submitted).toEqual([]);
  });

  // SYMPH-855 Track (a): a QA-only group (one browser-QA lane, no reviewer
  // lanes) also fails closed — a QA lane can only gate a group that has a
  // reviewer verdict to gate; on its own there is no merge-authoritative signal.
  it("fails closed with no_reviewer_lanes when only a browser-QA lane is present", async () => {
    const backend = fakeBackend({
      "browser-qa": {
        terminal: { state: "succeeded", artifactRefs: ["/qa.json"] },
        collectedArtifact: qaArtifact(),
      },
    });

    const result = await runCrabrunnerReviewJobGroup({
      ...baseInput({ lanes: [qaLane()], backend }),
      collectArtifact: async (lane: ReviewJobGroupLaneEvidence) =>
        backendArtifactFor(backend, lane),
    });

    expect(result.verdict).toBe("error");
    expect(result.degradedConditions).toContain("no_reviewer_lanes");
    expect(backend.submitted).toEqual([]);
  });

  // SYMPH-855 Track (b): the reviewer artifact's routing mode is validated, not
  // trusted. A `routing.mode` outside the council review modes (full|convergence)
  // is contract drift / a spoofed artifact and fails the lane closed as
  // malformed, even on a verdict:"pass" artifact.
  it("fails closed when a reviewer artifact routing.mode is not a council review mode", async () => {
    const spoofed = reviewerArtifact({
      laneId: "codex-high-lead",
      agent: "codex",
      modelFamily: "codex",
      verdict: "pass",
    });
    (spoofed.routing as Record<string, unknown>).mode = "garbage-mode";
    const backend = fakeBackend({
      "codex-high-lead": {
        terminal: { state: "succeeded", artifactRefs: ["/a.json"] },
        collectedArtifact: spoofed,
      },
    });

    const result = await runCrabrunnerReviewJobGroup({
      ...baseInput({
        lanes: [
          reviewerLane({
            laneId: "codex-high-lead",
            agent: "codex",
            modelFamily: "codex",
          }),
        ],
        backend,
      }),
      collectArtifact: async (lane: ReviewJobGroupLaneEvidence) =>
        backendArtifactFor(backend, lane),
    });

    expect(result.verdict).toBe("error");
    expect(result.degradedConditions).toContain(
      "malformed_artifact:codex-high-lead",
    );
  });

  // SYMPH-855 Track (b): a present `routing.routingMode` must be one of the
  // known council routing modes (or null). A bogus routing mode fails closed.
  it("fails closed when a reviewer artifact routing.routingMode is unknown", async () => {
    const spoofed = reviewerArtifact({
      laneId: "codex-high-lead",
      agent: "codex",
      modelFamily: "codex",
      verdict: "pass",
    });
    (spoofed.routing as Record<string, unknown>).routingMode = "turbo";
    const backend = fakeBackend({
      "codex-high-lead": {
        terminal: { state: "succeeded", artifactRefs: ["/a.json"] },
        collectedArtifact: spoofed,
      },
    });

    const result = await runCrabrunnerReviewJobGroup({
      ...baseInput({
        lanes: [
          reviewerLane({
            laneId: "codex-high-lead",
            agent: "codex",
            modelFamily: "codex",
          }),
        ],
        backend,
      }),
      collectArtifact: async (lane: ReviewJobGroupLaneEvidence) =>
        backendArtifactFor(backend, lane),
    });

    expect(result.verdict).toBe("error");
    expect(result.degradedConditions).toContain(
      "malformed_artifact:codex-high-lead",
    );
  });

  // SYMPH-855 Track (b): a null routing.routingMode is the legitimate "no forced
  // routing mode" value and must NOT fail the artifact (regression guard so the
  // tightened validation does not over-reject the common case).
  it("accepts a reviewer artifact whose routing.routingMode is null", async () => {
    const artifact = reviewerArtifact({
      laneId: "codex-high-lead",
      agent: "codex",
      modelFamily: "codex",
      verdict: "pass",
    });
    expect(
      (artifact.routing as Record<string, unknown>).routingMode,
    ).toBeNull();
    const backend = fakeBackend({
      "codex-high-lead": {
        terminal: { state: "succeeded", artifactRefs: ["/a.json"] },
        collectedArtifact: artifact,
      },
    });

    const result = await runCrabrunnerReviewJobGroup({
      ...baseInput({
        lanes: [
          reviewerLane({
            laneId: "codex-high-lead",
            agent: "codex",
            modelFamily: "codex",
          }),
        ],
        backend,
      }),
      collectArtifact: async (lane: ReviewJobGroupLaneEvidence) =>
        backendArtifactFor(backend, lane),
    });

    expect(result.verdict).toBe("pass");
  });
});

/**
 * Test helper: resolve the scripted collected artifact for a lane from the fake
 * backend's recorded evidence. Mirrors how production resolves a host-owned
 * artifact ref into a parsed structured artifact.
 */
function backendArtifactFor(
  backend: ReturnType<typeof fakeBackend>,
  lane: ReviewJobGroupLaneEvidence,
): unknown {
  return backend.collectedArtifacts[lane.laneId] ?? null;
}
