import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it, vi } from "vitest";

import type { BacklogAuditReport } from "../../src/audit/backlog-audit.js";
import { BACKLOG_AUDIT_FINDING_TYPES } from "../../src/audit/backlog-audit.js";
import type { Issue } from "../../src/domain/model.js";
import {
  BACKLOG_HYGIENE_PROPOSAL_LABELS,
  QUEUE_TRIAGE_EVALUATION_DIMENSIONS,
  QUEUE_TRIAGE_GOLDEN_CORPUS,
  buildBacklogHygieneCodeGroundingInput,
  buildBacklogHygieneDecisionJournalEntry,
  buildBacklogHygieneProposalJournalEntry,
  buildBacklogHygieneProposals,
  decideBacklogHygieneModelTier,
  runBacklogHygieneProposalLane,
} from "../../src/orchestrator/backlog-hygiene.js";
import { INTENT_VERBS } from "../../src/orchestrator/intent.js";

function issue(overrides: Partial<Issue>): Issue {
  return {
    id: overrides.id ?? "issue-1",
    identifier: overrides.identifier ?? "SYMPH-1",
    title: overrides.title ?? "Issue 1",
    description: overrides.description ?? null,
    priority: overrides.priority ?? null,
    state: overrides.state ?? "Backlog",
    branchName: overrides.branchName ?? null,
    url: overrides.url ?? null,
    labels: overrides.labels ?? [],
    blockedBy: overrides.blockedBy ?? [],
    createdAt: overrides.createdAt ?? null,
    updatedAt: overrides.updatedAt ?? null,
  };
}

function auditReport(): BacklogAuditReport {
  return {
    generatedAt: "2026-06-14T00:00:00.000Z",
    issueCount: 4,
    runtimeSources: ["/api/v1/state"],
    verdict: {
      summary: "Synthetic hygiene findings.",
      findingTypeVolume: {
        duplicate: 1,
        supersession: 1,
        stale: 1,
        thin_spec: 0,
        review_dispatch_mismatch: 0,
        other: 0,
      },
      findings: [
        {
          findingId: "F-1",
          type: "duplicate",
          issueIdentifiers: ["SYMPH-1"],
          summary: "Duplicate work",
          evidence: "Issue bodies overlap",
          confidence: "medium",
        },
        {
          findingId: "F-2",
          type: "stale",
          issueIdentifiers: ["SYMPH-2"],
          summary: "Stale work",
          evidence: "No longer matches current plan",
          confidence: "high",
        },
        {
          findingId: "F-3",
          type: "supersession",
          issueIdentifiers: ["SYMPH-3"],
          summary: "Superseded work",
          evidence: "Newer ticket owns it",
          confidence: "medium",
        },
      ],
    },
  };
}

function passingEvaluation() {
  return {
    corpusId: QUEUE_TRIAGE_GOLDEN_CORPUS[0].id,
    threshold: 0.8,
    dimensionScores: Object.fromEntries(
      QUEUE_TRIAGE_EVALUATION_DIMENSIONS.map((dimension) => [dimension, 0.9]),
    ),
  };
}

function auditResponse(): Response {
  return new Response(
    JSON.stringify({
      choices: [
        {
          message: {
            content: JSON.stringify({
              summary: "Synthetic audit response.",
              findingTypeVolume: {
                duplicate: 1,
                supersession: 0,
                stale: 0,
                thin_spec: 0,
                review_dispatch_mismatch: 0,
                other: 0,
              },
              findings: [
                {
                  findingId: "F-1",
                  type: "duplicate",
                  issueIdentifiers: ["SYMPH-1"],
                  summary: "Duplicate work",
                  evidence: "Issue bodies overlap",
                  confidence: "medium",
                },
              ],
            }),
          },
        },
      ],
    }),
    { status: 200, headers: { "content-type": "application/json" } },
  );
}

describe("backlog hygiene proposal lane (SYMPH-484)", () => {
  it("keeps the shared intent vocabulary live instead of a stale hand-copied list", () => {
    expect(INTENT_VERBS).toEqual(
      expect.arrayContaining(["anchor", "unanchor", "resume"]),
    );
    expect(new Set(INTENT_VERBS).size).toBe(INTENT_VERBS.length);
  });

  it("uses the shipped backlog-audit finding taxonomy when filtering proposals", () => {
    const proposals = buildBacklogHygieneProposals({
      report: auditReport(),
      candidateIssues: [
        issue({ id: "1", identifier: "SYMPH-1" }),
        issue({ id: "2", identifier: "SYMPH-2" }),
        issue({ id: "3", identifier: "SYMPH-3" }),
      ],
      findingTypes: BACKLOG_AUDIT_FINDING_TYPES,
      maxProposalsPerProductPerPoll: 10,
      modelTierDecision: decideBacklogHygieneModelTier(passingEvaluation()),
    });

    expect(proposals.map((proposal) => proposal.findingType)).toEqual([
      "duplicate",
      "stale",
      "supersession",
    ]);
  });

  it("applies the per-product poll cap and suppresses active or parked issues", () => {
    const proposals = buildBacklogHygieneProposals({
      report: auditReport(),
      candidateIssues: [
        issue({ id: "1", identifier: "SYMPH-1" }),
        issue({ id: "2", identifier: "SYMPH-2" }),
        issue({ id: "3", identifier: "SYMPH-3" }),
      ],
      activeIssueIds: ["1"],
      openParkIssueIds: ["2"],
      maxProposalsPerProductPerPoll: 1,
      modelTierDecision: decideBacklogHygieneModelTier(passingEvaluation()),
    });

    expect(proposals).toHaveLength(1);
    expect(proposals[0]?.issueIdentifiers).toEqual(["SYMPH-3"]);
  });

  it("attaches code-grounding evidence to generated proposals", () => {
    const proposals = buildBacklogHygieneProposals({
      report: auditReport(),
      candidateIssues: [issue({ id: "1", identifier: "SYMPH-1" })],
      maxProposalsPerProductPerPoll: 1,
      modelTierDecision: decideBacklogHygieneModelTier(passingEvaluation()),
      codeGroundingReport: {
        generatedAt: "2026-06-14T00:00:00.000Z",
        status: "verified",
        checkout: {
          checkoutId: "cg-123",
          path: "/tmp/workspace/.symphony/code-grounding/checkouts/cg-123",
          commitSha: "abc123",
          repoUrl: "file:///repo",
        },
        entries: [
          {
            findingId: "F-1",
            status: "verified",
            summary: "All extracted claims were found.",
            citations: [
              {
                checkoutId: "cg-123",
                commitSha: "abc123",
                path: "src/orchestrator/backlog-hygiene.ts",
                lineRange: [1, 20],
                contentHash: "abcdef1234567890",
                matchedSpan: "buildBacklogHygieneProposals",
              },
            ],
            missing: [],
          },
        ],
        cleanup: {
          leaseReleased: true,
          checkoutPurged: false,
          dirtyState: null,
        },
        warnings: [],
      },
    });

    expect(proposals[0]).toMatchObject({
      findingId: "F-1",
      codeGroundingStatus: "verified",
    });
    expect(proposals[0]?.codeGroundingEvidence).toContain(
      "src/orchestrator/backlog-hygiene.ts:1-20#abcdef123456",
    );
  });

  it("validates cap units and treats a zero cap as no proposals", () => {
    const baseInput = {
      report: auditReport(),
      candidateIssues: [issue({ id: "1", identifier: "SYMPH-1" })],
      modelTierDecision: decideBacklogHygieneModelTier(passingEvaluation()),
    };

    expect(
      buildBacklogHygieneProposals({
        ...baseInput,
        maxProposalsPerProductPerPoll: 0,
      }),
    ).toEqual([]);
    expect(() =>
      buildBacklogHygieneProposals({
        ...baseInput,
        maxProposalsPerProductPerPoll: 1.5,
      }),
    ).toThrow("maxProposalsPerProductPerPoll must be an integer.");
  });

  it("builds code-grounding input from resolved workflow config only when enabled", () => {
    const enabled = buildBacklogHygieneCodeGroundingInput({
      workflowConfig: {
        workspace: { root: "/tmp/symphony-workspace" },
        codeGrounding: {
          enabled: true,
          baseDir: ".symphony/code-grounding",
          ttlMs: 86_400_000,
          maxCheckoutsPerRepo: 5,
        },
      },
      runId: "hygiene-run-1",
      target: {
        repoUrl: "https://github.com/mobilyze-llc/symphony-ts.git",
        commitSha: "abc123",
        repoScope: "symphony",
      },
    });

    expect(enabled).toMatchObject({
      workspaceRoot: "/tmp/symphony-workspace",
      runId: "hygiene-run-1",
      config: {
        enabled: true,
        baseDir: ".symphony/code-grounding",
      },
      target: {
        repoUrl: "https://github.com/mobilyze-llc/symphony-ts.git",
        commitSha: "abc123",
      },
    });
    expect(
      buildBacklogHygieneCodeGroundingInput({
        workflowConfig: {
          workspace: { root: "/tmp/symphony-workspace" },
          codeGrounding: {
            enabled: false,
            baseDir: ".symphony/code-grounding",
            ttlMs: 86_400_000,
            maxCheckoutsPerRepo: 5,
          },
        },
        runId: "hygiene-run-2",
        target: {
          repoUrl: "https://github.com/mobilyze-llc/symphony-ts.git",
          commitSha: "abc123",
          repoScope: "symphony",
        },
      }),
    ).toBeNull();
  });

  it("uses the golden corpus registry when deciding local-vs-frontier model tier", () => {
    const missingDimensionDecision = decideBacklogHygieneModelTier({
      corpusId: QUEUE_TRIAGE_GOLDEN_CORPUS[0].id,
      threshold: 0.8,
      dimensionScores: { ordering: 0.9 },
    });
    expect(missingDimensionDecision.tier).toBe("frontier_high_judgment");
    expect(missingDimensionDecision.failedDimensions).toEqual(
      QUEUE_TRIAGE_EVALUATION_DIMENSIONS.filter(
        (dimension) => dimension !== "ordering",
      ),
    );

    const unknownCorpusDecision = decideBacklogHygieneModelTier({
      corpusId: "unknown-corpus",
      threshold: 0.8,
      dimensionScores: {},
    });
    expect(unknownCorpusDecision.tier).toBe("frontier_high_judgment");
    expect(unknownCorpusDecision.failedDimensions).toEqual(
      QUEUE_TRIAGE_EVALUATION_DIMENSIONS,
    );
    expect(unknownCorpusDecision.reason).toContain(
      "not in the queue-triage golden corpus registry",
    );
  });

  it("returns no proposals when the audit throws", async () => {
    const result = await runBacklogHygieneProposalLane({
      enabled: true,
      config: {
        baseUrl: "http://127.0.0.1:9999",
        model: "local",
        apiKey: null,
        timeoutMs: 1,
      },
      issues: [issue({ id: "1", identifier: "SYMPH-1" })],
      runtimeEvidence: { state: {}, stateDelta: {} },
      maxProposalsPerProductPerPoll: 5,
      evaluation: passingEvaluation(),
      fetchFn: vi.fn(async () => {
        throw new Error("model offline");
      }) as typeof fetch,
    });

    expect(result.status).toBe("audit_failed");
    expect(result.proposals).toEqual([]);
    expect(result.warnings[0]).toContain("model offline");
  });

  it("guards audit-failure warning rendering against circular cause chains", async () => {
    const circular = new Error("model offline");
    (circular as Error & { cause?: unknown }).cause = circular;

    const result = await runBacklogHygieneProposalLane({
      enabled: true,
      config: {
        baseUrl: "http://127.0.0.1:9999",
        model: "local",
        apiKey: null,
        timeoutMs: 1,
      },
      issues: [issue({ id: "1", identifier: "SYMPH-1" })],
      runtimeEvidence: { state: {}, stateDelta: {} },
      maxProposalsPerProductPerPoll: 5,
      evaluation: passingEvaluation(),
      fetchFn: vi.fn(async () => {
        throw circular;
      }) as typeof fetch,
    });

    expect(result.status).toBe("audit_failed");
    expect(result.warnings[0]).toContain("[circular cause]");
  });

  it("blocks high-judgment recommendations until the model clears the golden corpus", async () => {
    const result = await runBacklogHygieneProposalLane({
      enabled: true,
      config: {
        baseUrl: "http://127.0.0.1:9999",
        model: "local",
        apiKey: null,
        timeoutMs: 1,
      },
      issues: [issue({ id: "1", identifier: "SYMPH-1" })],
      runtimeEvidence: { state: {}, stateDelta: {} },
      maxProposalsPerProductPerPoll: 5,
      evaluation: {
        corpusId: QUEUE_TRIAGE_GOLDEN_CORPUS[0].id,
        threshold: 0.8,
        dimensionScores: { ordering: 0.2 },
      },
      fetchFn: vi.fn(async () => {
        throw new Error("must not run");
      }) as typeof fetch,
    });

    expect(result.status).toBe("model_tier_blocked");
    expect(result.proposals).toEqual([]);
  });

  it("exercises the explicit frontier-allowed path before emitting proposals", async () => {
    const result = await runBacklogHygieneProposalLane({
      enabled: true,
      config: {
        baseUrl: "http://127.0.0.1:9999",
        model: "frontier-review",
        apiKey: null,
        timeoutMs: 1,
      },
      issues: [issue({ id: "1", identifier: "SYMPH-1" })],
      runtimeEvidence: { state: {}, stateDelta: {} },
      maxProposalsPerProductPerPoll: 5,
      evaluation: {
        corpusId: QUEUE_TRIAGE_GOLDEN_CORPUS[0].id,
        threshold: 0.8,
        dimensionScores: { ordering: 0.2 },
      },
      allowFrontierRecommendations: true,
      fetchFn: vi.fn(async () => auditResponse()) as typeof fetch,
    });

    expect(result.status).toBe("completed");
    expect(result.proposals).toHaveLength(1);
    expect(result.proposals[0]?.modelTier).toBe("frontier_high_judgment");
  });

  it("degrades code-grounding failures without dropping hygiene proposals", async () => {
    const workspaceRoot = await mkdtemp(join(tmpdir(), "symph-hygiene-cg-"));
    try {
      const result = await runBacklogHygieneProposalLane({
        enabled: true,
        config: {
          baseUrl: "http://127.0.0.1:9999",
          model: "local",
          apiKey: null,
          timeoutMs: 1,
        },
        issues: [issue({ id: "1", identifier: "SYMPH-1" })],
        runtimeEvidence: { state: {}, stateDelta: {} },
        maxProposalsPerProductPerPoll: 5,
        evaluation: passingEvaluation(),
        fetchFn: vi.fn(async () => auditResponse()) as typeof fetch,
        codeGrounding: {
          workspaceRoot,
          runId: "grounding-failure",
          config: {
            enabled: true,
            baseDir: join(".symphony", "code-grounding"),
            ttlMs: 86_400_000,
            maxCheckoutsPerRepo: 5,
          },
          target: {
            repoUrl: "file:///missing-repo",
            commitSha: "bad",
            repoScope: "symphony",
          },
          commandRunner: async () => ({
            exitCode: 1,
            stdout: "",
            stderr: "clone failed",
          }),
        },
      });

      expect(result.status).toBe("completed");
      expect(result.proposals).toHaveLength(1);
      expect(result.proposals[0]?.codeGroundingStatus).toBeNull();
      expect(result.warnings[0]).toContain("code grounding failed");
      expect(result.warnings[0]).toContain("clone failed");
    } finally {
      await rm(workspaceRoot, { recursive: true, force: true });
    }
  });

  it("skips code grounding when cap and eligibility filters prevent proposals", async () => {
    const commandRunner = vi.fn(async () => ({
      exitCode: 1,
      stdout: "",
      stderr: "must not run",
    }));

    const result = await runBacklogHygieneProposalLane({
      enabled: true,
      config: {
        baseUrl: "http://127.0.0.1:9999",
        model: "local",
        apiKey: null,
        timeoutMs: 1,
      },
      issues: [issue({ id: "1", identifier: "SYMPH-1" })],
      activeIssueIds: ["1"],
      runtimeEvidence: { state: {}, stateDelta: {} },
      maxProposalsPerProductPerPoll: 5,
      evaluation: passingEvaluation(),
      fetchFn: vi.fn(async () => auditResponse()) as typeof fetch,
      codeGrounding: {
        workspaceRoot: "/tmp/symphony-workspace",
        runId: "no-proposals",
        config: {
          enabled: true,
          baseDir: ".symphony/code-grounding",
          ttlMs: 86_400_000,
          maxCheckoutsPerRepo: 5,
        },
        target: {
          repoUrl: "https://github.com/mobilyze-llc/symphony-ts.git",
          commitSha: "abc123",
          repoScope: "symphony",
        },
        commandRunner,
      },
    });

    expect(result.status).toBe("completed");
    expect(result.proposals).toEqual([]);
    expect(result.warnings).toEqual([]);
    expect(commandRunner).not.toHaveBeenCalled();
  });

  it("journals proposals and accept/reject decisions as calibration-only label transitions", () => {
    const [proposal] = buildBacklogHygieneProposals({
      report: auditReport(),
      candidateIssues: [issue({ id: "1", identifier: "SYMPH-1" })],
      maxProposalsPerProductPerPoll: 1,
      modelTierDecision: decideBacklogHygieneModelTier(passingEvaluation()),
    });
    expect(proposal).toBeDefined();

    const proposalEntry = buildBacklogHygieneProposalJournalEntry({
      proposal: proposal!,
      actor: { kind: "dispatcher", host: "test" },
      ownerId: "owner-1",
    });
    expect(proposalEntry.kind).toBe("hygiene_proposal");
    expect(proposalEntry.metadata.label).toBe(
      BACKLOG_HYGIENE_PROPOSAL_LABELS.proposed,
    );
    expect(proposalEntry.metadata.code_grounding_status).toBeNull();
    expect(proposalEntry.metadata.code_grounding_evidence).toBeNull();

    const decisionEntry = buildBacklogHygieneDecisionJournalEntry({
      proposal: proposal!,
      decision: "accepted",
      actor: { kind: "operator", host: "test" },
      ownerId: "owner-1",
      reason: "good catch",
      timestamp: "2026-06-14T00:00:01.000Z",
    });
    expect(decisionEntry.kind).toBe("hygiene_proposal_decision");
    expect(decisionEntry.metadata.issue_state_mutation).toBe(false);
    expect(decisionEntry.metadata.mutation_authority).toBe(
      "calibration_label_only",
    );
    expect(decisionEntry.metadata.label_transition).toEqual({
      remove: [BACKLOG_HYGIENE_PROPOSAL_LABELS.proposed],
      add: [BACKLOG_HYGIENE_PROPOSAL_LABELS.accepted],
    });
  });
});
