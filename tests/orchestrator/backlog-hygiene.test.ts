import { describe, expect, it, vi } from "vitest";

import type { BacklogAuditReport } from "../../src/audit/backlog-audit.js";
import { BACKLOG_AUDIT_FINDING_TYPES } from "../../src/audit/backlog-audit.js";
import type { Issue } from "../../src/domain/model.js";
import {
  BACKLOG_HYGIENE_PROPOSAL_LABELS,
  QUEUE_TRIAGE_EVALUATION_DIMENSIONS,
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
    corpusId: "2026-06-13-queue-triage-wave",
    threshold: 0.8,
    dimensionScores: Object.fromEntries(
      QUEUE_TRIAGE_EVALUATION_DIMENSIONS.map((dimension) => [dimension, 0.9]),
    ),
  };
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
        corpusId: "2026-06-13-queue-triage-wave",
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
