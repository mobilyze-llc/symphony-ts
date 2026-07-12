import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  structuralAdvisoryFingerprint,
  structuralAdvisoryMemberSetHash,
} from "../../src/agent/advisory-lifecycle.js";
import type {
  HotFileGrowth,
  PlannerCandidateGroundingEvidence,
  PlannerRunResult,
  QueueHealth,
  TriageIntakeHealth,
} from "../../src/agent/triage-planner.js";
import { runTriagePlanner } from "../../src/agent/triage-planner.js";
import type { WorkflowQueueTriageConfig } from "../../src/config/types.js";
import type { Issue } from "../../src/domain/model.js";
import {
  type PlanBatch,
  type PlanEnvelope,
  type PlanReviewRecord,
  computePlanContentHash,
} from "../../src/domain/standing-plan.js";
import {
  appendStandingPlanJournalEntriesWithLock,
  readStandingPlanJournal,
} from "../../src/logging/standing-plan-journal.js";
import type {
  PlanPostEmitReviewDeps,
  PlanPostEmitReviewResult,
} from "../../src/orchestrator/plan-post-emit-review.js";
import { renderStandingPlanControlDoc } from "../../src/orchestrator/standing-plan-doc-render.js";
import {
  assembleShadowPlannerContext,
  buildShadowPlannerAuditDispositions,
  buildShadowPlannerSupersessionRelationDispositions,
  enrichPlannerContextWithComments,
  runShadowPlanCycle,
  runStandingPlanShadowTick,
  shouldRunShadowPlanCycle,
} from "../../src/orchestrator/standing-plan-shadow.js";
import {
  loadLastReviewedContentHash,
  loadStandingPlan,
  recordPlanRevision,
} from "../../src/orchestrator/standing-plan-store.js";
import type { LinearIssueComment } from "../../src/tracker/linear-client.js";

const ENVELOPE: PlanEnvelope = {
  version: 1,
  concurrencyCeiling: 2,
  allowedRisk: "medium",
  allowedModes: ["parallel-isolated"],
};

function batch(
  id: string,
  identifier: string,
  status: PlanBatch["status"] = "lookahead",
): PlanBatch {
  return {
    batchId: id,
    mode: "parallel-isolated",
    status,
    members: [{ issueId: id, issueIdentifier: identifier }],
    rationale: "r",
    canary: null,
  };
}

function issue(id: string, identifier: string): Issue {
  return {
    id,
    identifier,
    title: `Title ${identifier}`,
    description: null,
    priority: 1,
    state: "Todo",
    branchName: null,
    url: null,
    labels: [],
    blockedBy: [],
    createdAt: "2026-06-18T00:00:00.000Z",
    updatedAt: "2026-06-18T00:00:00.000Z",
  };
}

function okPlanner(): { runClaude: () => Promise<PlannerRunResult> } {
  return {
    runClaude: async () => ({
      status: "ok",
      markdown:
        '# Plan\n```json\n{"rationale":"go","batches":[{"mode":"parallel-isolated","issueIdentifiers":["SYMPH-1"],"rationale":"first"}]}\n```\n',
    }),
  };
}

function plannerFor(identifier: string): {
  runClaude: () => Promise<PlannerRunResult>;
} {
  return {
    runClaude: async () => ({
      status: "ok",
      markdown: `# Plan\n\`\`\`json\n{\"rationale\":\"go\",\"batches\":[{\"mode\":\"parallel-isolated\",\"issueIdentifiers\":[\"${identifier}\"],\"rationale\":\"first\"}]}\n\`\`\`\n`,
    }),
  };
}

function advisoryPlanMarkdown(rootCauseHypothesis: string | null): string {
  return `\`\`\`json\n${JSON.stringify({
    rationale: "advisory lifecycle",
    batches: [],
    structural_advisories:
      rootCauseHypothesis === null
        ? []
        : [
            {
              memberIssueIdentifiers: ["SYMPH-1", "SYMPH-2"],
              rootCauseHypothesis,
              structuralFix: "Fix the shared root",
              confidenceNote: "high",
            },
          ],
  })}\n\`\`\``;
}

function plannerForBatches(identifiers: readonly string[]): {
  runClaude: (prompt: string) => Promise<PlannerRunResult>;
} {
  return {
    runClaude: async (prompt) => {
      if (prompt.startsWith("Review this already-produced standing plan.")) {
        return {
          status: "ok",
          markdown: '```json\n{"findings":[]}\n```',
        };
      }
      return {
        status: "ok",
        markdown: `# Plan\n\`\`\`json\n${JSON.stringify({
          rationale: "go",
          batches: identifiers.map((identifier) => ({
            mode: "parallel-isolated",
            issueIdentifiers: [identifier],
            rationale: "first",
          })),
        })}\n\`\`\`\n`,
      };
    },
  };
}

function groundingEvidence(): PlannerCandidateGroundingEvidence {
  return {
    status: "grounded",
    reason: null,
    digest: { text: "digest", status: "unverified", truncated: false },
    claims: [],
    units: [],
    warnings: [],
    extractorCallCount: 1,
    wallClockMs: 10,
  };
}

function tier2Record(over: Partial<PlanReviewRecord> = {}): PlanReviewRecord {
  return {
    tier: "tier-2",
    status: "reviewed",
    diffHash: "diff-hash",
    gateReason: "no_baseline",
    aggregateVerdict: "pass",
    note: null,
    reviewedGroundingEvidence: [],
    findingFingerprints: [],
    postHocEntries: [],
    ...over,
  };
}

function tier2RecordForReview(
  deps: PlanPostEmitReviewDeps,
  over: Partial<PlanReviewRecord> = {},
): PlanReviewRecord {
  const body = deps.tier2?.body ?? deps.body;
  return tier2Record({
    diffHash: computePlanContentHash({
      planId: deps.tier2?.planId ?? "symphony-standing-plan",
      batches: body.batches,
      dependencyEdges: body.dependencyEdges,
      options: body.options,
      envelope: body.envelope,
      rationale: body.rationale,
      source: body.source,
    }),
    ...over,
  });
}

function postEmitStub(
  fn: (deps: PlanPostEmitReviewDeps) => PlanPostEmitReviewResult,
): (deps: PlanPostEmitReviewDeps) => Promise<PlanPostEmitReviewResult> {
  return async (deps) => fn(deps);
}

function linearComment(
  over: Partial<LinearIssueComment> = {},
): LinearIssueComment {
  return {
    id: "lc1",
    body: "human comment",
    createdAt: "2026-06-20T00:00:00.000Z",
    updatedAt: "2026-06-20T00:00:00.000Z",
    user: {
      kind: "user",
      id: "u",
      name: "Dev",
      displayName: "Dev",
      email: "dev@example.com",
      botType: null,
      botSubType: null,
    },
    botActor: null,
    ...over,
  };
}

describe("assembleShadowPlannerContext", () => {
  it("builds the backlog from candidates, excluding in-flight issues", () => {
    const context = assembleShadowPlannerContext({
      candidates: [issue("u1", "SYMPH-1"), issue("u2", "SYMPH-2")],
      inFlight: [{ issueIdentifier: "SYMPH-2", stage: "implement" }],
      envelope: ENVELOPE,
    });
    expect(context.backlog.map((c) => c.issueIdentifier)).toEqual(["SYMPH-1"]);
    expect(context.inFlight).toEqual([
      { issueIdentifier: "SYMPH-2", stage: "implement" },
    ]);
    expect(context.envelope).toBe(ENVELOPE);
  });

  it("carries recorded blockedBy identifiers onto the candidate (SYMPH-841)", () => {
    const blocked: Issue = {
      ...issue("u1", "SYMPH-1"),
      blockedBy: [{ id: "b1", identifier: "SYMPH-9", state: "Todo" }],
    };
    const context = assembleShadowPlannerContext({
      candidates: [blocked],
      inFlight: [],
      envelope: ENVELOPE,
    });
    expect(context.backlog[0]?.blockedBy).toEqual(["SYMPH-9"]);
  });

  it("carries advisory Linear relations onto planner candidates (SYMPH-1020)", () => {
    const related: Issue = {
      ...issue("u1", "SYMPH-1"),
      relatesTo: [
        { id: "r1", identifier: "SYMPH-2", title: "Related", state: "Todo" },
      ],
      duplicates: [
        { id: "d1", identifier: "SYMPH-3", title: "Duplicate", state: "Todo" },
      ],
      duplicatedBy: [
        {
          id: "d2",
          identifier: "SYMPH-8",
          title: "Duplicates this",
          state: "Todo",
        },
      ],
      supersedes: [
        { id: "s1", identifier: "SYMPH-4", title: "Old", state: "Todo" },
      ],
      supersededBy: [
        { id: "s2", identifier: "SYMPH-7", title: "New", state: "Todo" },
      ],
      parent: {
        id: "p1",
        identifier: "SYMPH-5",
        title: "Parent",
        state: "Backlog",
      },
      children: [
        { id: "c1", identifier: "SYMPH-6", title: "Child", state: "Todo" },
      ],
      advisoryRelationsTruncated: true,
      childrenTruncated: true,
    };
    const context = assembleShadowPlannerContext({
      candidates: [related],
      inFlight: [],
      envelope: ENVELOPE,
    });
    expect(context.backlog[0]?.advisoryRelations).toEqual({
      relatesTo: ["SYMPH-2"],
      duplicates: ["SYMPH-3"],
      duplicatedBy: ["SYMPH-8"],
      supersedes: ["SYMPH-4"],
      supersededBy: ["SYMPH-7"],
      relationsTruncated: true,
      parent: "SYMPH-5",
      children: ["SYMPH-6"],
      childrenTruncated: true,
    });
  });

  it("carries the issue description and labels onto the candidate (SYMPH-874)", () => {
    const enriched: Issue = {
      ...issue("u1", "SYMPH-1"),
      description: "Body mentions src/orchestrator/core.ts",
      labels: ["area:scheduling", "kind:bug"],
    };
    const context = assembleShadowPlannerContext({
      candidates: [enriched],
      inFlight: [],
      envelope: ENVELOPE,
    });
    expect(context.backlog[0]?.description).toBe(
      "Body mentions src/orchestrator/core.ts",
    );
    expect(context.backlog[0]?.labels).toEqual(["area:scheduling", "kind:bug"]);
  });

  it("derives code-grounding path hints from the candidate body (SYMPH-895)", () => {
    const enriched: Issue = {
      ...issue("u1", "SYMPH-1"),
      description:
        "Reworks `src/orchestrator/core.ts` and `src/agent/triage-planner.ts`.",
    };
    const context = assembleShadowPlannerContext({
      candidates: [enriched],
      inFlight: [],
      envelope: ENVELOPE,
    });
    expect(context.backlog[0]?.pathHints).toEqual([
      "src/orchestrator/core.ts",
      "src/agent/triage-planner.ts",
    ]);
  });

  it("threads supplied grounded evidence onto planner candidates (SYMPH-1017 U4)", () => {
    const evidence = groundingEvidence();
    const context = assembleShadowPlannerContext({
      candidates: [issue("u1", "SYMPH-1")],
      inFlight: [],
      envelope: ENVELOPE,
      groundingEvidenceByIssueId: new Map([["u1", evidence]]),
    });
    expect(context.backlog[0]?.groundingEvidence).toBe(evidence);
  });

  it("yields empty path hints when the body cites no paths (SYMPH-895)", () => {
    const context = assembleShadowPlannerContext({
      candidates: [issue("u1", "SYMPH-1")],
      inFlight: [],
      envelope: ENVELOPE,
    });
    expect(context.backlog[0]?.pathHints).toEqual([]);
  });

  it("omits the health own-property when no triageHealthInput is given (SYMPH-939 U1, byte-unchanged)", () => {
    const context = assembleShadowPlannerContext({
      candidates: [issue("u1", "SYMPH-1")],
      inFlight: [],
      envelope: ENVELOPE,
    });
    expect("health" in context).toBe(false);
  });

  it("threads triageHealthInput onto context.health when given (SYMPH-939 U1)", () => {
    const health: QueueHealth = {
      triageIntake: { depth: 7, inflowRate: 2 },
      residualShare: 0.3,
      hotFileGrowth: {
        topFileChurnFraction: 0.5,
        godFileConcentration: "high",
      },
      reviewRoundDepth: 1,
    };
    const context = assembleShadowPlannerContext({
      candidates: [issue("u1", "SYMPH-1")],
      inFlight: [],
      envelope: ENVELOPE,
      triageHealthInput: health,
    });
    expect(context.health).toEqual(health);
  });

  it("annotates audit kills while excluding stale and supersession identifiers (SYMPH-989, SYMPH-1014)", () => {
    const context = assembleShadowPlannerContext({
      candidates: [
        issue("u1", "SYMPH-KEEP"),
        issue("u2", "SYMPH-KILL"),
        issue("u3", "SYMPH-STALE"),
        issue("u4", "SYMPH-SUPERSEDED"),
      ],
      inFlight: [],
      envelope: ENVELOPE,
      auditDispositions: [
        {
          type: "kill",
          issueIdentifiers: ["SYMPH-KILL"],
          classification: "kill",
          rootIssueIdentifier: "SYMPH-ROOT",
        },
        { type: "stale", issueIdentifiers: ["SYMPH-STALE"] },
        { type: "supersession", issueIdentifiers: ["SYMPH-SUPERSEDED"] },
      ],
    });
    expect(context.backlog.map((c) => c.issueIdentifier)).toEqual([
      "SYMPH-KEEP",
      "SYMPH-KILL",
    ]);
    expect(context.backlog[1]?.dispatchExclusionReasons).toEqual([
      "audit:kill",
    ]);
    expect(context.backlog[1]?.auditAnnotations).toEqual([
      { classification: "kill", rootIssueIdentifier: "SYMPH-ROOT" },
    ]);
  });

  it("retains symptomatic root-cause audit context without excluding dispatch", () => {
    const context = assembleShadowPlannerContext({
      candidates: [issue("u1", "SYMPH-SYMPTOM")],
      inFlight: [],
      envelope: ENVELOPE,
      auditDispositions: [
        {
          type: "advisory",
          issueIdentifiers: ["SYMPH-SYMPTOM"],
          classification: "symptomatic_of_root",
          rootIssueIdentifier: "SYMPH-ROOT",
        },
      ],
    });

    expect(context.backlog).toHaveLength(1);
    expect(context.backlog[0]?.auditAnnotations).toEqual([
      {
        classification: "symptomatic_of_root",
        rootIssueIdentifier: "SYMPH-ROOT",
      },
    ]);
    expect(context.backlog[0]?.dispatchExclusionReasons).toBeUndefined();
  });

  it("carries duplicate audit clusters onto surviving planner candidates (SYMPH-983)", () => {
    const context = assembleShadowPlannerContext({
      candidates: [
        issue("u1", "SYMPH-A"),
        issue("u2", "SYMPH-B"),
        issue("u3", "SYMPH-C"),
      ],
      inFlight: [],
      envelope: ENVELOPE,
      auditDispositions: [
        { type: "duplicate", issueIdentifiers: ["SYMPH-A", "SYMPH-B"] },
      ],
    });
    expect(context.backlog[0]?.duplicateClusterIdentifiers).toEqual([
      "SYMPH-A",
      "SYMPH-B",
    ]);
    expect(context.backlog[1]?.duplicateClusterIdentifiers).toEqual([
      "SYMPH-A",
      "SYMPH-B",
    ]);
    expect(context.backlog[2]?.duplicateClusterIdentifiers).toBeUndefined();
  });

  it("derives shadow planner dispositions from hygiene proposals (SYMPH-983)", () => {
    const dispositions = buildShadowPlannerAuditDispositions([
      {
        proposalId: "p1",
        findingId: "f1",
        findingType: "duplicate",
        issueIds: ["a", "b"],
        issueIdentifiers: ["SYMPH-A", "SYMPH-B"],
        summary: "duplicates",
        evidence: "same work",
        confidence: "high",
        cull: null,
        codeGroundingStatus: null,
        codeGroundingEvidence: null,
        generatedAt: "2026-06-30T00:00:00.000Z",
        modelTier: "local_low_risk",
      },
      {
        proposalId: "p2",
        findingId: "f2",
        findingType: "stale",
        issueIds: ["c"],
        issueIdentifiers: ["SYMPH-C"],
        summary: "stale",
        evidence: "obsolete",
        confidence: "medium",
        cull: null,
        codeGroundingStatus: null,
        codeGroundingEvidence: null,
        generatedAt: "2026-06-30T00:00:00.000Z",
        modelTier: "local_low_risk",
      },
      {
        proposalId: "p3",
        findingId: "f3",
        findingType: "supersession",
        issueIds: ["d"],
        issueIdentifiers: ["SYMPH-D"],
        summary: "kill",
        evidence: "replaced",
        confidence: "medium",
        cull: {
          classification: "kill",
          killReason: "duplicate",
          marker: null,
          rootIssueIdentifier: null,
        },
        codeGroundingStatus: null,
        codeGroundingEvidence: null,
        generatedAt: "2026-06-30T00:00:00.000Z",
        modelTier: "local_low_risk",
      },
      {
        proposalId: "p4",
        findingId: "f4",
        findingType: "supersession",
        issueIds: ["e"],
        issueIdentifiers: ["SYMPH-E"],
        summary: "superseded",
        evidence: "replaced by merged work",
        confidence: "high",
        cull: null,
        codeGroundingStatus: null,
        codeGroundingEvidence: null,
        generatedAt: "2026-06-30T00:00:00.000Z",
        modelTier: "local_low_risk",
      },
      {
        proposalId: "p5",
        findingId: "f5",
        findingType: "other",
        issueIds: ["f"],
        issueIdentifiers: ["SYMPH-F"],
        summary: "symptom",
        evidence: "root cause is tracked elsewhere",
        confidence: "high",
        cull: {
          classification: "symptomatic_of_root",
          killReason: null,
          marker: null,
          rootIssueIdentifier: "SYMPH-ROOT",
          advisoryOnly: true,
        },
        codeGroundingStatus: null,
        codeGroundingEvidence: null,
        generatedAt: "2026-06-30T00:00:00.000Z",
        modelTier: "local_low_risk",
      },
      {
        proposalId: "p6",
        findingId: "f6",
        findingType: "stale",
        issueIds: ["g"],
        issueIdentifiers: ["SYMPH-G"],
        summary: "stale symptom",
        evidence: "obsolete even though the audit retained a root advisory",
        confidence: "high",
        cull: {
          classification: "symptomatic_of_root",
          killReason: null,
          marker: null,
          rootIssueIdentifier: "SYMPH-ROOT",
          advisoryOnly: true,
        },
        codeGroundingStatus: null,
        codeGroundingEvidence: null,
        generatedAt: "2026-06-30T00:00:00.000Z",
        modelTier: "local_low_risk",
      },
    ]);
    expect(dispositions).toEqual([
      { type: "duplicate", issueIdentifiers: ["SYMPH-A", "SYMPH-B"] },
      { type: "stale", issueIdentifiers: ["SYMPH-C"] },
      {
        type: "kill",
        issueIdentifiers: ["SYMPH-D"],
        classification: "kill",
        rootIssueIdentifier: null,
      },
      { type: "supersession", issueIdentifiers: ["SYMPH-E"] },
      {
        type: "advisory",
        issueIdentifiers: ["SYMPH-F"],
        classification: "symptomatic_of_root",
        rootIssueIdentifier: "SYMPH-ROOT",
      },
      { type: "stale", issueIdentifiers: ["SYMPH-G"] },
    ]);
  });

  it("derives supersession prune dispositions from completed superseded-by relations (SYMPH-1014)", () => {
    expect(
      buildShadowPlannerSupersessionRelationDispositions([
        issue("u1", "SYMPH-OLD"),
        {
          ...issue("u2", "SYMPH-SUPERSEDED"),
          supersededBy: [
            {
              id: "u3",
              identifier: "SYMPH-DONE",
              state: "Done",
              title: "Replacement",
            },
          ],
        },
        {
          ...issue("u4", "SYMPH-PENDING"),
          supersededBy: [
            {
              id: "u5",
              identifier: "SYMPH-FUTURE",
              state: "Backlog",
              title: "Replacement not complete",
            },
          ],
        },
      ]),
    ).toEqual([
      { type: "supersession", issueIdentifiers: ["SYMPH-SUPERSEDED"] },
    ]);
  });
});

describe("shouldRunShadowPlanCycle", () => {
  it("runs when there is no plan yet", () => {
    expect(
      shouldRunShadowPlanCycle({ plan: null, nowMs: 1000, heartbeatMs: 100 }),
    ).toBe(true);
  });

  it("skips when the last plan is within the heartbeat window", () => {
    const plan = {
      planId: "p",
      revision: 1,
      contentHash: "h",
      envelope: ENVELOPE,
      batches: [],
      dependencyEdges: [],
      options: [],
      rationale: "r",
      createdAt: "2026-06-18T00:00:00.000Z",
      updatedAt: "2026-06-18T00:00:00.000Z",
    };
    const nowMs = Date.parse("2026-06-18T00:00:30.000Z");
    expect(shouldRunShadowPlanCycle({ plan, nowMs, heartbeatMs: 60_000 })).toBe(
      false,
    );
  });

  it("runs when the heartbeat window has elapsed", () => {
    const plan = {
      planId: "p",
      revision: 1,
      contentHash: "h",
      envelope: ENVELOPE,
      batches: [],
      dependencyEdges: [],
      options: [],
      rationale: "r",
      createdAt: "2026-06-18T00:00:00.000Z",
      updatedAt: "2026-06-18T00:00:00.000Z",
    };
    const nowMs = Date.parse("2026-06-18T00:20:00.000Z");
    expect(shouldRunShadowPlanCycle({ plan, nowMs, heartbeatMs: 60_000 })).toBe(
      true,
    );
  });

  it("uses the last planner run time when a no-op plan leaves updatedAt unchanged", () => {
    const plan = {
      planId: "p",
      revision: 1,
      contentHash: "h",
      envelope: ENVELOPE,
      batches: [],
      dependencyEdges: [],
      options: [],
      rationale: "r",
      createdAt: "2026-06-18T00:00:00.000Z",
      updatedAt: "2026-06-18T00:00:00.000Z",
    };
    const nowMs = Date.parse("2026-06-18T00:20:00.000Z");
    const lastRunAtMs = Date.parse("2026-06-18T00:19:30.000Z");
    expect(
      shouldRunShadowPlanCycle({
        plan,
        nowMs,
        heartbeatMs: 60_000,
        lastRunAtMs,
      }),
    ).toBe(false);
  });
});

describe("runShadowPlanCycle", () => {
  it("round-trips advisory-only shadow churn into the control doc without revision rotation", async () => {
    const root = mkdtempSync(join(tmpdir(), "symph-shadow-advisory-"));
    let rootName = "Root A";
    const planner = {
      runClaude: async (): Promise<PlannerRunResult> => ({
        status: "ok",
        markdown: `# Plan\n\`\`\`json\n${JSON.stringify({
          rationale: "go",
          batches: [
            {
              mode: "parallel-isolated",
              issueIdentifiers: ["SYMPH-1"],
              rationale: "first",
            },
          ],
          structural_advisories: [
            {
              memberIssueIdentifiers: ["SYMPH-1", "SYMPH-2"],
              rootCauseHypothesis: rootName,
              structuralFix: `Fix ${rootName}`,
              confidenceNote: "High",
            },
          ],
        })}\n\`\`\`\n`,
      }),
    };
    const context = assembleShadowPlannerContext({
      candidates: [issue("u1", "SYMPH-1")],
      inFlight: [],
      envelope: ENVELOPE,
    });
    try {
      const first = await runShadowPlanCycle({
        workspaceRoot: root,
        context,
        planner,
        log: () => undefined,
        now: () => new Date("2026-06-18T01:00:00.000Z"),
        planId: "plan-1",
        plannerModel: "opus",
        plannerEffort: "max",
      });
      rootName = "Root B";
      const second = await runShadowPlanCycle({
        workspaceRoot: root,
        context,
        planner,
        log: () => undefined,
        now: () => new Date("2026-06-18T01:05:00.000Z"),
        planId: "plan-1",
      });

      expect(first.status).toBe("ok");
      expect(second.status).toBe("ok");
      if (first.status === "ok" && second.status === "ok") {
        expect(second.revision).toBe(first.revision);
        expect(second.recorded).toBe(true);
      }
      const plan = await loadStandingPlan(root);
      expect(plan?.structuralAdvisories?.[0]?.rootCauseHypothesis).toBe(
        "Root B",
      );
      expect(plan?.updatedAt).toBe("2026-06-18T01:05:00.000Z");
      expect(plan?.optionsPublishedAt).toBe("2026-06-18T01:00:00.000Z");
      if (plan === null) {
        throw new Error("expected a persisted plan");
      }
      expect(
        shouldRunShadowPlanCycle({
          plan,
          nowMs: Date.parse("2026-06-18T01:05:30.000Z"),
          heartbeatMs: 60_000,
        }),
      ).toBe(false);
      const doc = renderStandingPlanControlDoc({
        plan,
        recentlyShipped: [],
        inFlight: [],
        changelog: [],
      });
      expect(doc).toContain("Structural advisories (report-only)");
      expect(doc).toContain("Root hypothesis: Root B");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("records a revision and logs the plan (shadow, no dispatch)", async () => {
    const root = mkdtempSync(join(tmpdir(), "symph-shadow-"));
    const logs: Array<{ event: string; fields: Record<string, unknown> }> = [];
    try {
      const context = assembleShadowPlannerContext({
        candidates: [issue("u1", "SYMPH-1")],
        inFlight: [],
        envelope: ENVELOPE,
      });
      const result = await runShadowPlanCycle({
        workspaceRoot: root,
        context,
        planner: okPlanner(),
        log: (event, _message, fields) => {
          logs.push({ event, fields });
        },
        now: () => new Date("2026-06-18T01:00:00.000Z"),
        planId: "plan-1",
        plannerModel: "opus",
        plannerEffort: "max",
      });
      expect(result.status).toBe("ok");
      if (result.status === "ok") {
        expect(result.revision).toBe(1);
        expect(result.batchCount).toBe(1);
      }
      expect(logs.map((l) => l.event)).toContain("queue_triage_shadow_plan");
      // Retry rate is observable: the shadow-plan log carries attempts (SYMPH-918).
      const shadowLog = logs.find(
        (l) => l.event === "queue_triage_shadow_plan",
      );
      expect(shadowLog?.fields).toMatchObject({
        attempts: 1,
        planner_model: "opus",
        planner_effort: "max",
      });
      // Persisted + queryable after the cycle.
      const plan = await loadStandingPlan(root);
      expect(plan).toMatchObject({
        revision: 1,
        plannerModel: "opus",
        plannerEffort: "max",
      });
      const journal = await readStandingPlanJournal(root);
      expect(journal[0]).toMatchObject({
        kind: "plan_revision",
        revision: { plannerModel: "opus", plannerEffort: "max" },
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("runs tier-1 review report-only and records a cancelled-candidate finding", async () => {
    const root = mkdtempSync(join(tmpdir(), "symph-shadow-"));
    try {
      const context = assembleShadowPlannerContext({
        candidates: [{ ...issue("u1", "SYMPH-1"), state: "Cancelled" }],
        inFlight: [],
        envelope: ENVELOPE,
      });
      const expected = await runTriagePlanner(context, okPlanner());
      expect(expected.status).toBe("ok");
      if (expected.status !== "ok") {
        throw new Error("expected ok planner result");
      }
      let persistedBodyJson: string | null = null;

      const result = await runShadowPlanCycle({
        workspaceRoot: root,
        context,
        planner: okPlanner(),
        persistPlanRevision: async (workspaceRoot, body, options) => {
          persistedBodyJson = JSON.stringify(body);
          return recordPlanRevision(workspaceRoot, body, options);
        },
        log: () => undefined,
        now: () => new Date("2026-06-18T01:00:00.000Z"),
        planId: "plan-1",
      });

      expect(result.status).toBe("ok");
      expect(persistedBodyJson).toBe(JSON.stringify(expected.body));
      expect((await loadStandingPlan(root))?.findings).toEqual([
        {
          title: "Scheduled ineligible candidate SYMPH-1 (Cancelled)",
          planAnchor: `${expected.body.batches[0]?.batchId}:SYMPH-1`,
          severity: "P2",
        },
      ]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("does not advance the tier-2 baseline when a reentrant persist changes the rotated hash", async () => {
    const root = mkdtempSync(join(tmpdir(), "symph-shadow-"));
    try {
      const context = assembleShadowPlannerContext({
        candidates: [issue("u1", "SYMPH-1")],
        inFlight: [],
        envelope: ENVELOPE,
      });
      const interveningBatch = batch("b0", "SYMPH-0", "in_flight");
      const interveningHash = computePlanContentHash({
        planId: "symphony-standing-plan",
        batches: [interveningBatch],
        dependencyEdges: [],
        options: [],
        envelope: ENVELOPE,
        rationale: "intervening",
        source: "manual",
      });
      let injected = false;

      const result = await runShadowPlanCycle({
        workspaceRoot: root,
        context,
        planner: okPlanner(),
        planReview: {
          enabled: true,
          plannerGroundingEnabled: true,
          lastReviewedContentHash: null,
          artifactDir: join(root, "tier2-artifacts"),
          workspace: root,
        },
        runPlanPostEmitReview: postEmitStub((deps) => ({
          findings: [],
          reviewRecords: [
            tier2RecordForReview(deps, {
              status: "reviewed",
              gateReason: "no_baseline",
              aggregateVerdict: "pass",
            }),
          ],
        })),
        persistPlanRevision: async (workspaceRoot, body, options) => {
          if (!injected) {
            injected = true;
            await appendStandingPlanJournalEntriesWithLock(workspaceRoot, [
              {
                kind: "plan_revision",
                idempotencyKey: "symphony-standing-plan:intervening-replan",
                timestamp: "2026-06-18T00:59:00.000Z",
                planId: "symphony-standing-plan",
                revision: {
                  revision: 1,
                  planId: "symphony-standing-plan",
                  contentHash: interveningHash,
                  supersedes: null,
                  createdAt: "2026-06-18T00:59:00.000Z",
                  envelope: ENVELOPE,
                  batches: [interveningBatch],
                  dependencyEdges: [],
                  options: [],
                  rationale: "intervening",
                  premises: [],
                  findings: [],
                  reviewRecords: [],
                  source: "manual",
                },
              },
            ]);
          }
          return recordPlanRevision(workspaceRoot, body, options);
        },
        log: () => undefined,
        now: () => new Date("2026-06-18T01:00:00.000Z"),
      });

      expect(result.status).toBe("ok");
      const plan = await loadStandingPlan(root);
      const tier2 = plan?.reviewRecords?.[0];
      expect(plan?.contentHash).not.toBe(tier2?.diffHash);
      expect(await loadLastReviewedContentHash(root)).toBeNull();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("degrades and records nothing when the planner is unavailable", async () => {
    const root = mkdtempSync(join(tmpdir(), "symph-shadow-"));
    const logs: string[] = [];
    try {
      const context = assembleShadowPlannerContext({
        candidates: [issue("u1", "SYMPH-1")],
        inFlight: [],
        envelope: ENVELOPE,
      });
      const result = await runShadowPlanCycle({
        workspaceRoot: root,
        context,
        planner: {
          runClaude: async () => ({
            status: "unavailable",
            detail: "cmux down",
          }),
        },
        log: (event) => {
          logs.push(event);
        },
        now: () => new Date("2026-06-18T01:00:00.000Z"),
        planId: "plan-1",
      });
      expect(result.status).toBe("unavailable");
      expect(logs).toContain("queue_triage_planner_unavailable");
      expect(await loadStandingPlan(root)).toBeNull();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("records one stable empty plan across empty-backlog heartbeats without planner degradation logs", async () => {
    const root = mkdtempSync(join(tmpdir(), "symph-shadow-"));
    const logs: string[] = [];
    const context = assembleShadowPlannerContext({
      candidates: [],
      inFlight: [],
      envelope: ENVELOPE,
    });
    try {
      const planner = {
        runClaude: async (): Promise<PlannerRunResult> => {
          throw new Error("empty backlog should not invoke the model runner");
        },
      };
      const first = await runShadowPlanCycle({
        workspaceRoot: root,
        context,
        planner,
        log: (event) => {
          logs.push(event);
        },
        now: () => new Date("2026-06-18T01:00:00.000Z"),
        planId: "plan-1",
      });
      const second = await runShadowPlanCycle({
        workspaceRoot: root,
        context,
        planner,
        log: (event) => {
          logs.push(event);
        },
        now: () => new Date("2026-06-18T01:15:00.000Z"),
        planId: "plan-1",
      });

      expect(first).toMatchObject({
        status: "ok",
        recorded: true,
        revision: 1,
        batchCount: 0,
      });
      expect(second).toMatchObject({
        status: "ok",
        recorded: false,
        revision: 1,
        batchCount: 0,
      });
      expect(logs).not.toContain("queue_triage_planner_unavailable");
      expect(logs).not.toContain("queue_triage_planner_invalid");
      expect(await loadStandingPlan(root)).toMatchObject({
        revision: 1,
        batches: [],
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

function triageConfig(
  over: Partial<WorkflowQueueTriageConfig> = {},
): WorkflowQueueTriageConfig {
  return {
    enabled: true,
    shadowMode: true,
    plannerModel: "opus",
    plannerEffort: "max",
    heartbeatMs: 900_000,
    autoReleaseFrontier: 1,
    controlDoc: { enabled: false, teamId: null },
    admissionGuardrail: { enabled: false },
    commentEnrichment: {
      enabled: false,
      maxCandidates: 25,
      maxCommentPages: 3,
      maxComments: 6,
      maxCommentChars: 400,
      maxTotalChars: 1200,
    },
    planReview: { enabled: false, plannerGroundingEnabled: false },
    envelope: ENVELOPE,
    ...over,
  };
}

describe("runStandingPlanShadowTick", () => {
  it("pins the configured model and max effort on the live planner runner", async () => {
    const root = mkdtempSync(join(tmpdir(), "symph-shadow-effort-"));
    const created: Array<{ model: string; effort: string }> = [];
    try {
      const result = await runStandingPlanShadowTick({
        config: triageConfig({ plannerModel: "opus", plannerEffort: "max" }),
        workspaceRoot: root,
        fetchCandidates: async () => [issue("u1", "SYMPH-1")],
        getInFlight: () => [],
        createPlannerRunner: (model, effort) => {
          created.push({ model, effort });
          return plannerForBatches(["SYMPH-1"]).runClaude;
        },
        log: () => undefined,
        now: () => new Date("2026-07-12T12:00:00.000Z"),
        force: true,
      });

      expect(result.status).toBe("ok");
      expect(created).toEqual([{ model: "opus", effort: "max" }]);
      expect(await loadStandingPlan(root)).toMatchObject({
        plannerModel: "opus",
        plannerEffort: "max",
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("keeps absent or false structural-advisory wiring inert", async () => {
    for (const structuralAdvisories of [undefined, false]) {
      const root = mkdtempSync(join(tmpdir(), "symph-shadow-dark-advisory-"));
      let advisoryFetches = 0;
      let prompt = "";
      try {
        await runStandingPlanShadowTick({
          config: triageConfig(
            structuralAdvisories === undefined ? {} : { structuralAdvisories },
          ),
          workspaceRoot: root,
          fetchCandidates: async () => [issue("u1", "SYMPH-1")],
          fetchAdvisoryInput: async () => {
            advisoryFetches += 1;
            return [issue("u2", "SYMPH-2")];
          },
          getInFlight: () => [],
          createPlannerRunner: () => async (renderedPrompt) => {
            prompt = renderedPrompt;
            return {
              status: "ok",
              markdown:
                '```json\n{"rationale":"go","batches":[],"structural_advisories":[{"memberIssueIdentifiers":["SYMPH-1"],"rootCauseHypothesis":"root","structuralFix":"fix","confidenceNote":"high"}]}\n```',
            };
          },
          log: () => undefined,
          now: () => new Date("2026-06-18T01:00:00.000Z"),
        });
        expect(advisoryFetches).toBe(0);
        expect(prompt).not.toContain("Backlog advisory input");
        expect(prompt).not.toContain("structural_advisories");
        expect((await loadStandingPlan(root))?.structuralAdvisories).toEqual(
          [],
        );
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    }
  });

  it("arms Backlog advisory input without admitting it to dispatch", async () => {
    const root = mkdtempSync(join(tmpdir(), "symph-shadow-armed-advisory-"));
    const logs: Array<{ event: string; fields: Record<string, unknown> }> = [];
    let prompt = "";
    const held = {
      ...issue("held", "SYMPH-3"),
      teamKey: "SYMPH",
      projectName: "Portfolio Intake / Needs Classification",
    };
    try {
      const result = await runStandingPlanShadowTick({
        config: triageConfig({
          structuralAdvisories: true,
          structuralAdvisoryDormantOkTicks: 3,
          structuralAdvisoryRenderCap: 3,
        }),
        workspaceRoot: root,
        fetchCandidates: async () => [issue("u1", "SYMPH-1")],
        fetchAdvisoryInput: async () => [
          { ...issue("u2", "SYMPH-2"), state: "Backlog" },
          held,
        ],
        resolveIssueByIdentifier: async (identifier) =>
          identifier === "SYMPH-10" ? issue("root", identifier) : null,
        getInFlight: () => [],
        createPlannerRunner: () => async (renderedPrompt) => {
          if (prompt === "") prompt = renderedPrompt;
          return {
            status: "ok",
            markdown:
              '```json\n{"rationale":"go","batches":[{"mode":"parallel-isolated","issueIdentifiers":["SYMPH-1","SYMPH-2"],"rationale":"mixed"}],"structural_advisories":[{"memberIssueIdentifiers":["SYMPH-1","SYMPH-2"],"rootCauseHypothesis":"shared root","structuralFix":"fix root","confidenceNote":"high","rootIssueIdentifier":"SYMPH-10"}]}\n```',
          };
        },
        log: (event, _message, fields) => {
          logs.push({ event, fields });
        },
        now: () => new Date("2026-06-18T01:00:00.000Z"),
      });
      expect(result, JSON.stringify(logs)).toMatchObject({ status: "ok" });
      const opening = prompt.indexOf("<SYMPHONY_UNTRUSTED_CANDIDATES_");
      const input = prompt.indexOf("## Backlog advisory input");
      const closing = prompt.indexOf("</SYMPHONY_UNTRUSTED_CANDIDATES_");
      expect(opening).toBeGreaterThanOrEqual(0);
      expect(input).toBeGreaterThan(opening);
      expect(closing).toBeGreaterThan(input);
      expect(prompt).toContain("SYMPH-2 [Backlog");
      expect(prompt).not.toContain("SYMPH-3 [Todo");
      const plan = await loadStandingPlan(root);
      expect(
        plan?.batches[0]?.members.map((member) => member.issueIdentifier),
      ).toEqual(["SYMPH-1"]);
      expect(plan?.structuralAdvisories?.[0]).toMatchObject({
        memberIssueIdentifiers: ["SYMPH-1", "SYMPH-2"],
        rootIssueIdentifier: "SYMPH-10",
        lifecycleState: "active",
        rendered: true,
      });
      expect(logs).toContainEqual({
        event: "queue_triage_structural_advisory_portfolio_held",
        fields: { outcome: "report_only", held_count: 1 },
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("withdraws an existing advisory when a majority becomes terminal", async () => {
    const root = mkdtempSync(join(tmpdir(), "symph-shadow-terminal-advisory-"));
    const transitions: Record<string, unknown>[] = [];
    let tick = 0;
    let plannerCalls = 0;
    try {
      for (tick = 0; tick < 2; tick += 1) {
        const result = await runStandingPlanShadowTick({
          config: triageConfig({ structuralAdvisories: true }),
          workspaceRoot: root,
          fetchCandidates: async () =>
            tick === 0 ? [issue("u1", "SYMPH-1")] : [],
          fetchAdvisoryInput: async () =>
            tick === 0
              ? [{ ...issue("u2", "SYMPH-2"), state: "Backlog" }]
              : [
                  { ...issue("u1", "SYMPH-1"), state: "Done" },
                  { ...issue("u2", "SYMPH-2"), state: "Done" },
                ],
          terminalStates: ["Done"],
          getInFlight: () => [],
          createPlannerRunner: () => async () => {
            plannerCalls += 1;
            return {
              status: "ok",
              markdown: advisoryPlanMarkdown("Shared root"),
            };
          },
          runPlanPostEmitReview: async () => ({
            findings: [],
            reviewRecords: [],
          }),
          log: (event, _message, fields) => {
            if (event === "queue_triage_structural_advisory_transition") {
              transitions.push(fields);
            }
          },
          now: () => new Date(`2026-06-18T0${tick + 1}:00:00.000Z`),
          force: true,
        });
        expect(result.status).toBe("ok");
      }

      expect(plannerCalls).toBe(1);
      expect(
        (await loadStandingPlan(root))?.structuralAdvisories?.[0],
      ).toMatchObject({
        memberIssueIdentifiers: ["SYMPH-1", "SYMPH-2"],
        lifecycleState: "withdrawn",
        rendered: false,
      });
      expect(transitions).toEqual([
        expect.objectContaining({ from: "active", to: "withdrawn" }),
      ]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("does not advance absence across a failed advisory-input scan", async () => {
    const root = mkdtempSync(join(tmpdir(), "symph-shadow-scan-failure-"));
    const roots = ["Shared root", null, "Shared root"] as const;
    const snapshots: NonNullable<
      Awaited<ReturnType<typeof loadStandingPlan>>
    >["structuralAdvisories"][] = [];
    const logs: string[] = [];
    let scan = 0;
    let planner = 0;
    try {
      for (let tick = 0; tick < roots.length; tick += 1) {
        const result = await runStandingPlanShadowTick({
          config: triageConfig({ structuralAdvisories: true }),
          workspaceRoot: root,
          fetchCandidates: async () => [issue("u1", "SYMPH-1")],
          fetchAdvisoryInput: async () => {
            scan += 1;
            if (scan === 2) throw new Error("Backlog unavailable");
            return [{ ...issue("u2", "SYMPH-2"), state: "Backlog" }];
          },
          getInFlight: () => [],
          createPlannerRunner: () => async () => ({
            status: "ok",
            markdown: advisoryPlanMarkdown(roots[planner++] ?? null),
          }),
          runPlanPostEmitReview: async () => ({
            findings: [],
            reviewRecords: [],
          }),
          log: (event) => {
            logs.push(event);
          },
          now: () => new Date(`2026-06-18T0${tick + 1}:00:00.000Z`),
          force: true,
        });
        expect(result.status).toBe("ok");
        snapshots.push((await loadStandingPlan(root))?.structuralAdvisories);
      }
      const [first, failedScan, reEmitted] = snapshots.map(
        (advisories) => advisories?.[0],
      );
      expect(first).toMatchObject({
        lifecycleState: "active",
        absentOkTicks: 0,
      });
      expect(failedScan).toMatchObject({
        lifecycleState: "active",
        absentOkTicks: 0,
      });
      expect(reEmitted).toMatchObject({
        lifecycleState: "active",
        absentOkTicks: 0,
      });
      expect(failedScan?.memberSetHash).toBe(first?.memberSetHash);
      expect(reEmitted?.advisoryFingerprint).toBe(first?.advisoryFingerprint);
      expect(logs).toContain("queue_triage_structural_advisory_input_failed");
      expect(logs).not.toContain("queue_triage_structural_advisory_transition");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("journals active to dormant to active with stable advisory identity", async () => {
    const root = mkdtempSync(join(tmpdir(), "symph-shadow-lifecycle-journal-"));
    const roots = ["Shared root!", null, "shared root"] as const;
    const transitionFields: Record<string, unknown>[] = [];
    let planner = 0;
    try {
      for (let tick = 0; tick < roots.length; tick += 1) {
        const result = await runStandingPlanShadowTick({
          config: triageConfig({ structuralAdvisories: true }),
          workspaceRoot: root,
          fetchCandidates: async () => [issue("u1", "SYMPH-1")],
          fetchAdvisoryInput: async () => [
            { ...issue("u2", "SYMPH-2"), state: "Backlog" },
          ],
          getInFlight: () => [],
          createPlannerRunner: () => async () => ({
            status: "ok",
            markdown: advisoryPlanMarkdown(roots[planner++] ?? null),
          }),
          runPlanPostEmitReview: async () => ({
            findings: [],
            reviewRecords: [],
          }),
          log: (event, _message, fields) => {
            if (event === "queue_triage_structural_advisory_transition") {
              transitionFields.push(fields);
            }
          },
          now: () => new Date(`2026-06-19T0${tick + 1}:00:00.000Z`),
          force: true,
        });
        expect(result.status).toBe("ok");
      }
      const revisions = (await readStandingPlanJournal(root)).flatMap(
        (entry) => (entry.kind === "plan_revision" ? [entry.revision] : []),
      );
      expect(revisions).toHaveLength(3);
      const advisories = revisions.map(
        (revision) => revision.structuralAdvisories?.[0],
      );
      expect(advisories.map((advisory) => advisory?.lifecycleState)).toEqual([
        "active",
        "dormant",
        "active",
      ]);
      expect(
        new Set(advisories.map((advisory) => advisory?.memberSetHash)).size,
      ).toBe(1);
      expect(
        new Set(advisories.map((advisory) => advisory?.advisoryFingerprint))
          .size,
      ).toBe(1);
      expect(transitionFields).toEqual([
        expect.objectContaining({ from: "active", to: "dormant" }),
        expect.objectContaining({ from: "dormant", to: "active" }),
      ]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("revives an exact rejected member set from comment-only activity using a bounded comment scan", async () => {
    const root = mkdtempSync(join(tmpdir(), "symph-shadow-comment-revival-"));
    const fetches: Array<{ issueId: string; maxPages: number | undefined }> =
      [];
    const transitions: Array<{ from: string | null; to: string }> = [];
    const memberSetHash = structuralAdvisoryMemberSetHash([
      "SYMPH-2",
      "SYMPH-3",
    ]);
    const advisoryFingerprint = structuralAdvisoryFingerprint(
      memberSetHash,
      "Shared root",
    );
    const generalIssues = Array.from({ length: 105 }, (_, index) =>
      issue(`general-${index}`, `SYMPH-${1000 + index}`),
    );
    try {
      await recordPlanRevision(
        root,
        {
          batches: [],
          options: [],
          envelope: ENVELOPE,
          rationale: "prior rejected advisory",
          source: "planner",
          dependencyEdges: [],
          structuralAdvisories: [
            {
              memberIssueIdentifiers: ["SYMPH-2", "SYMPH-3"],
              rootCauseHypothesis: "Shared root",
              structuralFix: "Fix the shared root",
              confidenceNote: "high",
              memberSetHash,
              advisoryFingerprint,
              lifecycleState: "graded",
              rendered: false,
            },
          ],
        },
        { planId: "plan-1", createdAt: "2026-06-18T00:00:00.000Z" },
      );
      const result = await runStandingPlanShadowTick({
        config: triageConfig({ structuralAdvisories: true }),
        workspaceRoot: root,
        fetchCandidates: async () => [],
        fetchAdvisoryInput: async () => [
          ...generalIssues,
          issue("u2", "SYMPH-2"),
        ],
        terminalStates: ["Done"],
        getInFlight: () => [],
        getAdvisoryRejections: () => [
          {
            advisoryId: advisoryFingerprint,
            memberSetHash,
            memberActivityAtGrade: {
              "SYMPH-2": "2026-06-18T00:00:00.000Z",
              "SYMPH-3": null,
            },
            gradeSequence: 10,
          },
        ],
        resolveIssueByIdentifier: async (identifier) =>
          identifier === "SYMPH-3"
            ? { ...issue("u3", identifier), state: "In Review" }
            : null,
        fetchIssueComments: async (issueId, options) => {
          fetches.push({ issueId, maxPages: options.maxPages });
          return issueId === "u3"
            ? [
                linearComment({
                  id: "page-2-comment",
                  createdAt: "2026-06-19T00:00:00.000Z",
                  updatedAt: "2026-06-19T00:00:00.000Z",
                }),
              ]
            : [];
        },
        createPlannerRunner: () => async () => ({
          status: "ok",
          markdown: `\`\`\`json\n${JSON.stringify({
            rationale: "revive moved member",
            batches: [],
            structural_advisories: [
              {
                memberIssueIdentifiers: ["SYMPH-2", "SYMPH-3"],
                rootCauseHypothesis: "Shared root",
                structuralFix: "Fix the shared root",
                confidenceNote: "high",
              },
            ],
          })}\n\`\`\``,
        }),
        runPlanPostEmitReview: async () => ({
          findings: [],
          reviewRecords: [],
        }),
        recordAdvisoryTransition: async ({ from, to }) => {
          transitions.push({ from, to });
        },
        log: () => undefined,
        now: () => new Date("2026-06-19T01:00:00.000Z"),
        force: true,
      });

      expect(result.status).toBe("ok");
      expect(fetches).toHaveLength(100);
      expect(fetches.slice(0, 2)).toEqual([
        { issueId: "u2", maxPages: 10 },
        { issueId: "u3", maxPages: 10 },
      ]);
      expect(fetches.some((fetch) => fetch.issueId === "general-104")).toBe(
        false,
      );
      expect(
        (await loadStandingPlan(root))?.structuralAdvisories?.[0],
      ).toMatchObject({
        memberSetHash,
        lifecycleState: "active",
        rendered: true,
        previouslyRejectedWithNewEvidence: true,
      });
      expect(transitions).toEqual([{ from: "graded", to: "active" }]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("records degraded observability when advisory comment activity cannot be fetched", async () => {
    const root = mkdtempSync(join(tmpdir(), "symph-shadow-comment-degraded-"));
    const logs: string[] = [];
    const memberSetHash = structuralAdvisoryMemberSetHash([
      "SYMPH-1",
      "SYMPH-2",
    ]);
    try {
      const result = await runStandingPlanShadowTick({
        config: triageConfig({ structuralAdvisories: true }),
        workspaceRoot: root,
        fetchCandidates: async () => [],
        fetchAdvisoryInput: async () => [
          issue("u1", "SYMPH-1"),
          issue("u2", "SYMPH-2"),
        ],
        terminalStates: ["Done"],
        getInFlight: () => [],
        getAdvisoryRejections: () => [
          {
            advisoryId: "prior-fingerprint",
            memberSetHash,
            memberActivityAtGrade: {
              "SYMPH-1": "2026-06-18T00:00:00.000Z",
              "SYMPH-2": "2026-06-18T00:00:00.000Z",
            },
            gradeSequence: 10,
          },
        ],
        fetchIssueComments: async () => {
          throw new Error("comments unavailable");
        },
        createPlannerRunner: () => async () => ({
          status: "ok",
          markdown: advisoryPlanMarkdown("Shared root"),
        }),
        runPlanPostEmitReview: async () => ({
          findings: [],
          reviewRecords: [],
        }),
        log: (event) => {
          logs.push(event);
        },
        now: () => new Date("2026-06-19T01:00:00.000Z"),
        force: true,
      });

      expect(result.status).toBe("ok");
      expect(logs).toContain("queue_triage_advisory_comment_activity_failed");
      expect((await loadStandingPlan(root))?.structuralAdvisories).toEqual([]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("does nothing when the feature is disabled", async () => {
    const root = mkdtempSync(join(tmpdir(), "symph-shadow-tick-"));
    let fetched = false;
    try {
      const result = await runStandingPlanShadowTick({
        config: triageConfig({ enabled: false }),
        workspaceRoot: root,
        fetchCandidates: async () => {
          fetched = true;
          return [];
        },
        getInFlight: () => [],
        createPlannerRunner: () => okPlanner().runClaude,
        log: () => undefined,
        now: () => new Date("2026-06-18T01:00:00.000Z"),
      });
      expect(result.status).toBe("skipped");
      expect(fetched).toBe(false);
      expect(await loadStandingPlan(root)).toBeNull();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("runs the cycle when enabled and no prior plan exists", async () => {
    const root = mkdtempSync(join(tmpdir(), "symph-shadow-tick-"));
    let requestedModel: string | null = null;
    try {
      const result = await runStandingPlanShadowTick({
        config: triageConfig(),
        workspaceRoot: root,
        fetchCandidates: async () => [issue("u1", "SYMPH-1")],
        getInFlight: () => [],
        createPlannerRunner: (model) => {
          requestedModel = model;
          return okPlanner().runClaude;
        },
        log: () => undefined,
        now: () => new Date("2026-06-18T01:00:00.000Z"),
      });
      expect(result.status).toBe("ok");
      expect(requestedModel).toBe("opus");
      expect((await loadStandingPlan(root))?.revision).toBe(1);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("leaves tier-2 review off by default and omits tier-2 telemetry", async () => {
    const root = mkdtempSync(join(tmpdir(), "symph-shadow-tick-"));
    const logs: Array<{ event: string; fields: Record<string, unknown> }> = [];
    const reviewCalls: PlanPostEmitReviewDeps[] = [];
    try {
      const result = await runStandingPlanShadowTick({
        config: triageConfig(),
        workspaceRoot: root,
        fetchCandidates: async () => [issue("u1", "SYMPH-1")],
        getInFlight: () => [],
        createPlannerRunner: () => okPlanner().runClaude,
        runPlanPostEmitReview: postEmitStub((deps) => {
          reviewCalls.push(deps);
          return { findings: [], reviewRecords: [] };
        }),
        log: (event, _message, fields) => {
          logs.push({ event, fields });
        },
        now: () => new Date("2026-06-18T01:00:00.000Z"),
      });

      expect(result.status).toBe("ok");
      expect(reviewCalls).toHaveLength(1);
      expect(reviewCalls[0]?.tier2).toBeUndefined();
      const shadowLog = logs.find(
        (entry) => entry.event === "queue_triage_shadow_plan",
      );
      expect(shadowLog?.fields).not.toHaveProperty("review_tier2");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("passes the durable tier-2 baseline and logs report-only telemetry when enabled", async () => {
    const root = mkdtempSync(join(tmpdir(), "symph-shadow-tick-"));
    const logs: Array<{ event: string; fields: Record<string, unknown> }> = [];
    const artifactDir = join(root, "tier2-artifacts");
    const workspace = join(root, "repo");
    try {
      const result = await runStandingPlanShadowTick({
        config: triageConfig({
          planReview: { enabled: true, plannerGroundingEnabled: false },
        }),
        workspaceRoot: root,
        fetchCandidates: async () => [issue("u1", "SYMPH-1")],
        getInFlight: () => [],
        createPlannerRunner: () => okPlanner().runClaude,
        loadLastReviewedContentHash: async (workspaceRoot) => {
          expect(workspaceRoot).toBe(root);
          return null;
        },
        planReviewArtifactDir: artifactDir,
        planReviewWorkspace: workspace,
        runPlanPostEmitReview: postEmitStub((deps) => {
          expect(deps.tier2).toMatchObject({
            enabled: true,
            planId: "symphony-standing-plan",
            artifactDir,
            workspace,
            plannerGroundingEnabled: false,
            lastReviewedContentHash: null,
          });
          return {
            findings: [],
            reviewRecords: [
              tier2RecordForReview(deps, {
                status: "skipped",
                gateReason: "no_baseline",
                aggregateVerdict: null,
                note: "no grounded evidence",
              }),
            ],
          };
        }),
        log: (event, _message, fields) => {
          logs.push({ event, fields });
        },
        now: () => new Date("2026-06-18T01:00:00.000Z"),
      });

      expect(result.status).toBe("ok");
      const shadowLog = logs.find(
        (entry) => entry.event === "queue_triage_shadow_plan",
      );
      expect(shadowLog?.fields).toMatchObject({
        review_tier2: {
          gate_reason: "no_baseline",
          status: "skipped",
          aggregate_verdict: null,
          finding_count: 0,
          // Skip disambiguation (SYMPH-1068): distinguishes "no grounded evidence"
          // from the content_hash_unchanged skip; no lanes ran → per_lane empty.
          note: "no grounded evidence",
          per_lane: [],
        },
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("emits per-lane tier-2 telemetry (verdict, finding count, tokens) in the shadow log (SYMPH-1068)", async () => {
    const root = mkdtempSync(join(tmpdir(), "symph-shadow-tick-"));
    const logs: Array<{ event: string; fields: Record<string, unknown> }> = [];
    try {
      const result = await runStandingPlanShadowTick({
        config: triageConfig({
          planReview: { enabled: true, plannerGroundingEnabled: true },
        }),
        workspaceRoot: root,
        fetchCandidates: async () => [issue("u1", "SYMPH-1")],
        getInFlight: () => [],
        createPlannerRunner: () => okPlanner().runClaude,
        loadLastReviewedContentHash: async () => null,
        runPlanPostEmitReview: postEmitStub((deps) => ({
          findings: [],
          reviewRecords: [
            tier2RecordForReview(deps, {
              status: "reviewed",
              gateReason: "no_baseline",
              aggregateVerdict: "fail",
              note: null,
              perLane: [
                {
                  reviewer: "codex-plan-review",
                  verdict: "CHANGES_REQUESTED",
                  findingCount: 2,
                  inputTokens: 1200,
                  outputTokens: 340,
                },
                {
                  reviewer: "opus-plan-review",
                  verdict: "PASS",
                  findingCount: 0,
                  inputTokens: 800,
                  outputTokens: 120,
                },
              ],
            }),
          ],
        })),
        log: (event, _message, fields) => {
          logs.push({ event, fields });
        },
        now: () => new Date("2026-06-18T01:00:00.000Z"),
      });

      expect(result.status).toBe("ok");
      const shadowLog = logs.find(
        (entry) => entry.event === "queue_triage_shadow_plan",
      );
      expect(shadowLog?.fields).toMatchObject({
        review_tier2: {
          status: "reviewed",
          aggregate_verdict: "fail",
          note: null,
          per_lane: [
            {
              reviewer: "codex-plan-review",
              verdict: "CHANGES_REQUESTED",
              finding_count: 2,
              input_tokens: 1200,
              output_tokens: 340,
            },
            {
              reviewer: "opus-plan-review",
              verdict: "PASS",
              finding_count: 0,
              input_tokens: 800,
              output_tokens: 120,
            },
          ],
        },
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("persists reviewed tier-2 records as the next durable baseline", async () => {
    const root = mkdtempSync(join(tmpdir(), "symph-shadow-tick-"));
    try {
      const result = await runStandingPlanShadowTick({
        config: triageConfig({
          planReview: { enabled: true, plannerGroundingEnabled: true },
        }),
        workspaceRoot: root,
        fetchCandidates: async () => [issue("u1", "SYMPH-1")],
        getInFlight: () => [],
        createPlannerRunner: () => okPlanner().runClaude,
        runPlanPostEmitReview: postEmitStub((deps) => {
          expect(deps.tier2?.lastReviewedContentHash).toBeNull();
          return {
            findings: [],
            reviewRecords: [
              tier2RecordForReview(deps, {
                status: "reviewed",
                gateReason: "no_baseline",
                aggregateVerdict: "pass",
                findingFingerprints: ["f1"],
              }),
            ],
          };
        }),
        log: () => undefined,
        now: () => new Date("2026-06-18T01:00:00.000Z"),
      });

      expect(result.status).toBe("ok");
      const plan = await loadStandingPlan(root);
      expect(plan?.reviewRecords).toMatchObject([
        {
          tier: "tier-2",
          status: "reviewed",
          gateReason: "no_baseline",
          findingFingerprints: ["f1"],
        },
      ]);
      expect(await loadLastReviewedContentHash(root)).toBe(plan?.contentHash);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("keeps the last reviewed baseline after an unchanged-tick skip refresh", async () => {
    const root = mkdtempSync(join(tmpdir(), "symph-shadow-tick-"));
    const baselines: Array<string | null | undefined> = [];
    try {
      await runStandingPlanShadowTick({
        config: triageConfig({
          planReview: { enabled: true, plannerGroundingEnabled: true },
        }),
        workspaceRoot: root,
        fetchCandidates: async () => [issue("u1", "SYMPH-1")],
        getInFlight: () => [],
        createPlannerRunner: () => okPlanner().runClaude,
        runPlanPostEmitReview: postEmitStub((deps) => {
          baselines.push(deps.tier2?.lastReviewedContentHash);
          return {
            findings: [],
            reviewRecords: [
              tier2RecordForReview(deps, {
                status: "reviewed",
                gateReason: "no_baseline",
                aggregateVerdict: "pass",
              }),
            ],
          };
        }),
        log: () => undefined,
        now: () => new Date("2026-06-18T01:00:00.000Z"),
      });
      const reviewedHash = (await loadStandingPlan(root))?.contentHash;

      await runStandingPlanShadowTick({
        config: triageConfig({
          planReview: { enabled: true, plannerGroundingEnabled: true },
        }),
        workspaceRoot: root,
        fetchCandidates: async () => [issue("u1", "SYMPH-1")],
        getInFlight: () => [],
        createPlannerRunner: () => okPlanner().runClaude,
        runPlanPostEmitReview: postEmitStub((deps) => {
          baselines.push(deps.tier2?.lastReviewedContentHash);
          return {
            findings: [],
            reviewRecords: [
              tier2RecordForReview(deps, {
                status: "skipped",
                gateReason: "content_hash_unchanged",
                aggregateVerdict: null,
                note: "plan content hash already reviewed",
              }),
            ],
          };
        }),
        log: () => undefined,
        now: () => new Date("2026-06-18T01:16:00.000Z"),
        force: true,
      });

      expect(baselines).toEqual([null, reviewedHash]);
      expect((await loadStandingPlan(root))?.reviewRecords).toMatchObject([
        { tier: "tier-2", status: "skipped" },
      ]);
      expect(await loadLastReviewedContentHash(root)).toBe(reviewedHash);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("keeps prior tier-2 findings visible after an unchanged-tick skip refresh", async () => {
    const root = mkdtempSync(join(tmpdir(), "symph-shadow-tick-"));
    const tier2Finding = {
      title: "Prior tier-2 finding",
      planAnchor: "plan:issue/SYMPH-1",
      severity: "P2" as const,
      source: "tier-2" as const,
      structuredFingerprint: "fp-tier2-prior",
    };
    try {
      await runStandingPlanShadowTick({
        config: triageConfig({
          planReview: { enabled: true, plannerGroundingEnabled: true },
        }),
        workspaceRoot: root,
        fetchCandidates: async () => [issue("u1", "SYMPH-1")],
        getInFlight: () => [],
        createPlannerRunner: () => okPlanner().runClaude,
        runPlanPostEmitReview: postEmitStub((deps) => ({
          findings: [tier2Finding],
          reviewRecords: [
            tier2RecordForReview(deps, {
              status: "reviewed",
              gateReason: "no_baseline",
              aggregateVerdict: "fail",
              findingFingerprints: ["fp-tier2-prior"],
            }),
          ],
        })),
        log: () => undefined,
        now: () => new Date("2026-06-18T01:00:00.000Z"),
      });

      await runStandingPlanShadowTick({
        config: triageConfig({
          planReview: { enabled: true, plannerGroundingEnabled: true },
        }),
        workspaceRoot: root,
        fetchCandidates: async () => [issue("u1", "SYMPH-1")],
        getInFlight: () => [],
        createPlannerRunner: () => okPlanner().runClaude,
        runPlanPostEmitReview: postEmitStub((deps) => ({
          findings: [],
          reviewRecords: [
            tier2RecordForReview(deps, {
              status: "skipped",
              gateReason: "content_hash_unchanged",
              aggregateVerdict: null,
              note: "plan content hash already reviewed",
            }),
          ],
        })),
        log: () => undefined,
        now: () => new Date("2026-06-18T01:16:00.000Z"),
        force: true,
      });

      const plan = await loadStandingPlan(root);
      expect(plan?.findings).toEqual([tier2Finding]);
      expect(
        plan === null
          ? ""
          : renderStandingPlanControlDoc({
              plan,
              recentlyShipped: [],
              inFlight: [],
              changelog: [],
            }),
      ).toContain("Prior tier-2 finding");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("feeds tier-2 the rotated persisted body when committed batches carry forward", async () => {
    const root = mkdtempSync(join(tmpdir(), "symph-shadow-tick-"));
    try {
      await recordPlanRevision(
        root,
        {
          batches: [batch("b1", "SYMPH-1"), batch("b2", "SYMPH-2")],
          options: [],
          envelope: ENVELOPE,
          rationale: "rationale",
          source: "planner",
          dependencyEdges: [],
        },
        {
          planId: "symphony-standing-plan",
          createdAt: "2026-06-18T00:00:00.000Z",
        },
      );
      const latest = [...(await readStandingPlanJournal(root))]
        .reverse()
        .find((entry) => entry.kind === "plan_revision");
      if (latest?.kind !== "plan_revision") {
        throw new Error("expected seed revision");
      }
      const carriedBatches = latest.revision.batches.map((item) =>
        item.members.some((member) => member.issueIdentifier === "SYMPH-1")
          ? { ...item, status: "in_flight" as const }
          : item,
      );
      const reviewedContentHash = computePlanContentHash({
        planId: latest.revision.planId,
        batches: carriedBatches,
        dependencyEdges: latest.revision.dependencyEdges,
        options: latest.revision.options,
        envelope: latest.revision.envelope,
        rationale: latest.revision.rationale,
        source: latest.revision.source,
      });
      const reviewedRevision = {
        ...latest.revision,
        batches: carriedBatches,
        contentHash: reviewedContentHash,
        reviewRecords: [
          tier2Record({
            status: "reviewed",
            diffHash: reviewedContentHash,
            gateReason: "no_baseline",
            aggregateVerdict: "pass",
          }),
        ],
      };
      await appendStandingPlanJournalEntriesWithLock(root, [
        {
          kind: "plan_revision",
          idempotencyKey: "symphony-standing-plan:manual-in-flight-baseline",
          timestamp: "2026-06-18T00:05:00.000Z",
          planId: latest.revision.planId,
          revision: reviewedRevision,
        },
      ]);
      const baselineHash = await loadLastReviewedContentHash(root);
      const tier2Batches: Array<{
        status: PlanBatch["status"];
        members: string[];
      }> = [];

      await runStandingPlanShadowTick({
        config: triageConfig({
          planReview: { enabled: true, plannerGroundingEnabled: true },
        }),
        workspaceRoot: root,
        fetchCandidates: async () => [issue("u2", "SYMPH-2")],
        getInFlight: () => [{ issueIdentifier: "SYMPH-1", stage: "In Review" }],
        createPlannerRunner: () => plannerFor("SYMPH-2").runClaude,
        runPlanPostEmitReview: postEmitStub((deps) => {
          expect(deps.tier2?.lastReviewedContentHash).toBe(baselineHash);
          for (const item of deps.tier2?.body?.batches ?? []) {
            tier2Batches.push({
              status: item.status,
              members: item.members.map((member) => member.issueIdentifier),
            });
          }
          return {
            findings: [],
            reviewRecords: [
              tier2RecordForReview(deps, {
                status: "skipped",
                gateReason: "content_hash_unchanged",
                aggregateVerdict: null,
                note: "plan content hash already reviewed",
              }),
            ],
          };
        }),
        log: () => undefined,
        now: () => new Date("2026-06-18T01:00:00.000Z"),
        force: true,
      });

      expect(tier2Batches).toContainEqual({
        status: "in_flight",
        members: ["SYMPH-1"],
      });
      expect(tier2Batches).toContainEqual({
        status: "lookahead",
        members: ["SYMPH-2"],
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("skips real tier-2 review when the rotated body hash matches the reviewed baseline", async () => {
    const root = mkdtempSync(join(tmpdir(), "symph-shadow-tick-"));
    const logs: Array<{ event: string; fields: Record<string, unknown> }> = [];
    try {
      const seedResult = await runStandingPlanShadowTick({
        config: triageConfig({
          planReview: { enabled: false, plannerGroundingEnabled: false },
        }),
        workspaceRoot: root,
        fetchCandidates: async () => [
          issue("u1", "SYMPH-1"),
          issue("u2", "SYMPH-2"),
        ],
        getInFlight: () => [],
        createPlannerRunner: () =>
          plannerForBatches(["SYMPH-1", "SYMPH-2"]).runClaude,
        runPlanPostEmitReview: postEmitStub(() => ({
          findings: [],
          reviewRecords: [],
        })),
        log: () => undefined,
        now: () => new Date("2026-06-18T00:00:00.000Z"),
      });
      expect(seedResult).toMatchObject({ status: "ok" });
      const latest = [...(await readStandingPlanJournal(root))]
        .reverse()
        .find((entry) => entry.kind === "plan_revision");
      if (latest?.kind !== "plan_revision") {
        throw new Error("expected seed revision");
      }
      const carriedBatches = latest.revision.batches.map((item) =>
        item.members.some((member) => member.issueIdentifier === "SYMPH-1")
          ? { ...item, status: "in_flight" as const }
          : item,
      );
      const committedBatchIds = new Set(
        carriedBatches
          .filter((item) => item.status === "in_flight")
          .map((item) => item.batchId),
      );
      const reviewedOptions = latest.revision.options
        .filter(
          (option) =>
            option.intent === null ||
            option.intent.batchId === null ||
            !committedBatchIds.has(option.intent.batchId),
        )
        .map((option, index) =>
          option.intent === null || option.intent.batchId === null
            ? option
            : { ...option, marker: `[opt-${index + 1}]` },
        );
      const reviewedHash = computePlanContentHash({
        planId: latest.revision.planId,
        batches: carriedBatches,
        dependencyEdges: latest.revision.dependencyEdges,
        options: reviewedOptions,
        envelope: latest.revision.envelope,
        rationale: latest.revision.rationale,
        source: latest.revision.source,
      });
      await appendStandingPlanJournalEntriesWithLock(root, [
        {
          kind: "plan_revision",
          idempotencyKey: "symphony-standing-plan:manual-reviewed-baseline",
          timestamp: "2026-06-18T00:05:00.000Z",
          planId: latest.revision.planId,
          revision: {
            ...latest.revision,
            batches: carriedBatches,
            options: reviewedOptions,
            contentHash: reviewedHash,
            reviewRecords: [
              tier2Record({
                status: "reviewed",
                diffHash: reviewedHash,
                gateReason: "no_baseline",
                aggregateVerdict: "pass",
              }),
            ],
          },
        },
      ]);

      const result = await runStandingPlanShadowTick({
        config: triageConfig({
          planReview: { enabled: true, plannerGroundingEnabled: true },
        }),
        workspaceRoot: root,
        fetchCandidates: async () => [issue("u2", "SYMPH-2")],
        getInFlight: () => [{ issueIdentifier: "SYMPH-1", stage: "In Review" }],
        createPlannerRunner: () => plannerForBatches(["SYMPH-2"]).runClaude,
        log: (event, _message, fields) => {
          logs.push({ event, fields });
        },
        now: () => new Date("2026-06-18T01:00:00.000Z"),
        force: true,
      });

      expect(result.status).toBe("ok");
      const plan = await loadStandingPlan(root);
      expect(plan?.contentHash).toBe(reviewedHash);
      expect(await loadLastReviewedContentHash(root)).toBe(reviewedHash);
      expect(plan?.reviewRecords).toMatchObject([
        {
          tier: "tier-2",
          status: "skipped",
          diffHash: reviewedHash,
          gateReason: "content_hash_unchanged",
          aggregateVerdict: null,
          note: "plan content hash already reviewed",
        },
      ]);
      expect(
        logs.find((entry) => entry.event === "queue_triage_shadow_plan")?.fields
          .review_tier2,
      ).toMatchObject({
        gate_reason: "content_hash_unchanged",
        status: "skipped",
        aggregate_verdict: null,
        finding_count: 0,
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("feeds the last reviewed hash into a changed-plan tier-2 review", async () => {
    const root = mkdtempSync(join(tmpdir(), "symph-shadow-tick-"));
    const baselines: Array<string | null | undefined> = [];
    try {
      await runStandingPlanShadowTick({
        config: triageConfig({
          planReview: { enabled: true, plannerGroundingEnabled: true },
        }),
        workspaceRoot: root,
        fetchCandidates: async () => [issue("u1", "SYMPH-1")],
        getInFlight: () => [],
        createPlannerRunner: () => plannerFor("SYMPH-1").runClaude,
        runPlanPostEmitReview: postEmitStub((deps) => {
          baselines.push(deps.tier2?.lastReviewedContentHash);
          return {
            findings: [],
            reviewRecords: [
              tier2RecordForReview(deps, {
                status: "reviewed",
                gateReason: "no_baseline",
                aggregateVerdict: "pass",
              }),
            ],
          };
        }),
        log: () => undefined,
        now: () => new Date("2026-06-18T01:00:00.000Z"),
      });
      const firstHash = (await loadStandingPlan(root))?.contentHash;

      await runStandingPlanShadowTick({
        config: triageConfig({
          planReview: { enabled: true, plannerGroundingEnabled: true },
        }),
        workspaceRoot: root,
        fetchCandidates: async () => [issue("u2", "SYMPH-2")],
        getInFlight: () => [],
        createPlannerRunner: () => plannerFor("SYMPH-2").runClaude,
        runPlanPostEmitReview: postEmitStub((deps) => {
          baselines.push(deps.tier2?.lastReviewedContentHash);
          return {
            findings: [],
            reviewRecords: [
              tier2RecordForReview(deps, {
                status: "reviewed",
                gateReason: "content_hash_changed",
                aggregateVerdict: "pass",
              }),
            ],
          };
        }),
        log: () => undefined,
        now: () => new Date("2026-06-18T01:16:00.000Z"),
        force: true,
      });
      const secondHash = (await loadStandingPlan(root))?.contentHash;

      expect(baselines).toEqual([null, firstHash]);
      expect(secondHash).not.toBe(firstHash);
      expect(await loadLastReviewedContentHash(root)).toBe(secondHash);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("injects report-only grounding evidence before the planner runs", async () => {
    const root = mkdtempSync(join(tmpdir(), "symph-shadow-tick-"));
    const logs: Array<{ event: string; fields: Record<string, unknown> }> = [];
    const prompts: string[] = [];
    let groundingCalls = 0;
    const sentinel = "SENSITIVE_GROUNDING_SENTINEL";
    try {
      const result = await runStandingPlanShadowTick({
        config: triageConfig(),
        workspaceRoot: root,
        fetchCandidates: async () => [issue("u1", "SYMPH-1")],
        getInFlight: () => [],
        groundPlannerContext: async ({ context }) => {
          groundingCalls += 1;
          expect(context.backlog[0]?.groundingEvidence).toBeUndefined();
          return {
            context: {
              ...context,
              backlog: context.backlog.map((candidate) => ({
                ...candidate,
                groundingEvidence: {
                  ...groundingEvidence(),
                  digest: {
                    text: sentinel,
                    status: "unverified",
                    truncated: false,
                  },
                  claims: [
                    {
                      id: "claim-1",
                      kind: "behavioral",
                      text: sentinel,
                      summary: sentinel,
                      status: "unverified",
                      citations: [],
                      missing: [sentinel],
                    },
                  ],
                },
              })),
            },
          };
        },
        createPlannerRunner: () => async (nextPrompt) => {
          prompts.push(nextPrompt);
          return okPlanner().runClaude();
        },
        log: (event, _message, fields) => {
          logs.push({ event, fields });
        },
        now: () => new Date("2026-06-18T01:00:00.000Z"),
      });

      expect(result.status).toBe("ok");
      expect(groundingCalls).toBe(1);
      const plannerPrompt = prompts[0] ?? "";
      expect(plannerPrompt).toContain("grounding evidence (report-only");
      expect(plannerPrompt).toContain(`digest [unverified]: ${sentinel}`);
      expect(logs).toContainEqual({
        event: "queue_triage_planner_grounding_measure",
        fields: expect.objectContaining({
          outcome: "shadow",
          candidate_count: 1,
          evidence_count: 1,
          grounded_count: 1,
          extractor_call_count: 1,
        }),
      });
      const measureLog = logs.find(
        (log) => log.event === "queue_triage_planner_grounding_measure",
      );
      const serializedFields = JSON.stringify(measureLog?.fields);
      expect(serializedFields).not.toContain("digest");
      expect(serializedFields).not.toContain("claims");
      expect(serializedFields).not.toContain(sentinel);
      expect(JSON.stringify(measureLog?.fields)).not.toContain("Title SYMPH-1");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("continues the report-only planner cycle when grounding fails", async () => {
    const root = mkdtempSync(join(tmpdir(), "symph-shadow-tick-"));
    const logs: string[] = [];
    let plannerCalled = false;
    try {
      const result = await runStandingPlanShadowTick({
        config: triageConfig(),
        workspaceRoot: root,
        fetchCandidates: async () => [issue("u1", "SYMPH-1")],
        getInFlight: () => [],
        groundPlannerContext: async () => {
          throw new Error("studio unavailable");
        },
        createPlannerRunner: () => async () => {
          plannerCalled = true;
          return okPlanner().runClaude();
        },
        log: (event) => {
          logs.push(event);
        },
        now: () => new Date("2026-06-18T01:00:00.000Z"),
      });

      expect(result.status).toBe("ok");
      expect(plannerCalled).toBe(true);
      expect(logs).toContain("queue_triage_planner_grounding_failed");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("does not emit grounding logs when no grounding dependency is wired", async () => {
    const root = mkdtempSync(join(tmpdir(), "symph-shadow-tick-"));
    const logs: string[] = [];
    const prompts: string[] = [];
    try {
      const result = await runStandingPlanShadowTick({
        config: triageConfig(),
        workspaceRoot: root,
        fetchCandidates: async () => [issue("u1", "SYMPH-1")],
        getInFlight: () => [],
        createPlannerRunner: () => async (nextPrompt) => {
          prompts.push(nextPrompt);
          return okPlanner().runClaude();
        },
        log: (event) => {
          logs.push(event);
        },
        now: () => new Date("2026-06-18T01:00:00.000Z"),
      });

      expect(result.status).toBe("ok");
      expect(prompts[0]).not.toContain("grounding evidence");
      expect(
        logs.some((event) =>
          event.startsWith("queue_triage_planner_grounding"),
        ),
      ).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("skips on the heartbeat window and never invokes the planner", async () => {
    const root = mkdtempSync(join(tmpdir(), "symph-shadow-tick-"));
    let plannerBuilt = false;
    try {
      // First tick records a plan.
      await runStandingPlanShadowTick({
        config: triageConfig(),
        workspaceRoot: root,
        fetchCandidates: async () => [issue("u1", "SYMPH-1")],
        getInFlight: () => [],
        createPlannerRunner: () => okPlanner().runClaude,
        log: () => undefined,
        now: () => new Date("2026-06-18T01:00:00.000Z"),
      });
      // Second tick 1 minute later is inside the 15m heartbeat window.
      const result = await runStandingPlanShadowTick({
        config: triageConfig(),
        workspaceRoot: root,
        fetchCandidates: async () => [issue("u1", "SYMPH-1")],
        getInFlight: () => [],
        createPlannerRunner: () => {
          plannerBuilt = true;
          return okPlanner().runClaude;
        },
        log: () => undefined,
        now: () => new Date("2026-06-18T01:01:00.000Z"),
      });
      expect(result.status).toBe("skipped");
      expect(plannerBuilt).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("does not rerun every tick after an unchanged non-empty plan no-ops", async () => {
    const root = mkdtempSync(join(tmpdir(), "symph-shadow-tick-"));
    let plannerCalls = 0;
    try {
      const createPlannerRunner = () => {
        plannerCalls += 1;
        return okPlanner().runClaude;
      };

      await runStandingPlanShadowTick({
        config: triageConfig(),
        workspaceRoot: root,
        fetchCandidates: async () => [issue("u1", "SYMPH-1")],
        getInFlight: () => [],
        createPlannerRunner,
        log: () => undefined,
        now: () => new Date("2026-06-18T01:00:00.000Z"),
      });
      const second = await runStandingPlanShadowTick({
        config: triageConfig(),
        workspaceRoot: root,
        fetchCandidates: async () => [issue("u1", "SYMPH-1")],
        getInFlight: () => [],
        createPlannerRunner,
        log: () => undefined,
        now: () => new Date("2026-06-18T01:20:00.000Z"),
      });
      const third = await runStandingPlanShadowTick({
        config: triageConfig(),
        workspaceRoot: root,
        fetchCandidates: async () => [issue("u1", "SYMPH-1")],
        getInFlight: () => [],
        createPlannerRunner,
        log: () => undefined,
        now: () => new Date("2026-06-18T01:21:00.000Z"),
      });

      expect(second.status).toBe("ok");
      if (second.status === "ok") {
        expect(second.recorded).toBe(false);
        expect(second.revision).toBe(1);
      }
      // After SYMPH-828 this within-window skip is served by the attempted-run
      // gate (the marker advanced on the no-op cycle) → reason "cadence".
      expect(third).toEqual({ status: "skipped", reason: "cadence" });
      expect(plannerCalls).toBe(2);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("force bypasses the heartbeat gate and re-plans now (SYMPH-787/789)", async () => {
    const root = mkdtempSync(join(tmpdir(), "symph-shadow-tick-"));
    let plannerBuilt = false;
    try {
      // First tick records a plan.
      await runStandingPlanShadowTick({
        config: triageConfig(),
        workspaceRoot: root,
        fetchCandidates: async () => [issue("u1", "SYMPH-1")],
        getInFlight: () => [],
        createPlannerRunner: () => okPlanner().runClaude,
        log: () => undefined,
        now: () => new Date("2026-06-18T01:00:00.000Z"),
      });
      // 1 minute later (inside the heartbeat window) but FORCED → must run.
      const result = await runStandingPlanShadowTick({
        config: triageConfig(),
        workspaceRoot: root,
        fetchCandidates: async () => [issue("u1", "SYMPH-1")],
        getInFlight: () => [],
        createPlannerRunner: () => {
          plannerBuilt = true;
          return okPlanner().runClaude;
        },
        log: () => undefined,
        now: () => new Date("2026-06-18T01:01:00.000Z"),
        force: true,
      });
      expect(result.status).toBe("ok");
      expect(plannerBuilt).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("swallows errors so the poll is never broken", async () => {
    const root = mkdtempSync(join(tmpdir(), "symph-shadow-tick-"));
    const logs: string[] = [];
    try {
      const result = await runStandingPlanShadowTick({
        config: triageConfig(),
        workspaceRoot: root,
        fetchCandidates: async () => {
          throw new Error("tracker down");
        },
        getInFlight: () => [],
        createPlannerRunner: () => okPlanner().runClaude,
        log: (event) => {
          logs.push(event);
        },
        now: () => new Date("2026-06-18T01:00:00.000Z"),
      });
      expect(result.status).toBe("skipped");
      expect(logs).toContain("queue_triage_shadow_failed");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("runStandingPlanShadowTick — error rate-limiting (SYMPH-828)", () => {
  it("rate-limits a persistently throwing cycle to the heartbeat cadence", async () => {
    const root = mkdtempSync(join(tmpdir(), "symph-shadow-tick-err-"));
    let fetchCalls = 0;
    const logs: string[] = [];
    const tick = (iso: string) =>
      runStandingPlanShadowTick({
        config: triageConfig(), // heartbeatMs 900_000 (15m)
        workspaceRoot: root,
        fetchCandidates: async () => {
          fetchCalls += 1;
          throw new Error("tracker down");
        },
        getInFlight: () => [],
        createPlannerRunner: () => okPlanner().runClaude,
        log: (event) => {
          logs.push(event);
        },
        now: () => new Date(iso),
      });
    try {
      const first = await tick("2026-06-18T01:00:00.000Z"); // attempts → throws
      const second = await tick("2026-06-18T01:01:00.000Z"); // <15m → skip
      const third = await tick("2026-06-18T01:05:00.000Z"); // <15m → skip
      const fourth = await tick("2026-06-18T01:20:00.000Z"); // 20m → attempts

      expect(first).toEqual({ status: "skipped", reason: "error" });
      // Rate-limited by the attempted-run gate (reason "cadence"), distinct from
      // the plan-freshness "heartbeat" gate.
      expect(second).toEqual({ status: "skipped", reason: "cadence" });
      expect(third).toEqual({ status: "skipped", reason: "cadence" });
      expect(fourth).toEqual({ status: "skipped", reason: "error" });
      // The expensive fetch ran once per heartbeat window, NOT every poll. The
      // pre-SYMPH-828 tick advanced the marker only on success and ignored it
      // when no plan exists, so it would have re-fetched on all four ticks.
      expect(fetchCalls).toBe(2);
      // …and the operator-visible degradation log fired only on real attempts.
      expect(
        logs.filter((e) => e === "queue_triage_shadow_failed").length,
      ).toBe(2);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("a forced tick bypasses the error cadence (operator re-plan still runs)", async () => {
    const root = mkdtempSync(join(tmpdir(), "symph-shadow-tick-err-"));
    let fetchCalls = 0;
    const failingFetch = async (): Promise<Issue[]> => {
      fetchCalls += 1;
      throw new Error("tracker down");
    };
    try {
      await runStandingPlanShadowTick({
        config: triageConfig(),
        workspaceRoot: root,
        fetchCandidates: failingFetch,
        getInFlight: () => [],
        createPlannerRunner: () => okPlanner().runClaude,
        log: () => undefined,
        now: () => new Date("2026-06-18T01:00:00.000Z"),
      });
      // 1 minute later (inside the cadence) but FORCED → must still attempt.
      const forced = await runStandingPlanShadowTick({
        config: triageConfig(),
        workspaceRoot: root,
        fetchCandidates: failingFetch,
        getInFlight: () => [],
        createPlannerRunner: () => okPlanner().runClaude,
        log: () => undefined,
        now: () => new Date("2026-06-18T01:01:00.000Z"),
        force: true,
      });
      expect(forced).toEqual({ status: "skipped", reason: "error" });
      expect(fetchCalls).toBe(2);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("after a restart (marker lost), a fresh plan within the window skips via the plan-freshness gate", async () => {
    // The attempted-run marker is in-memory, so a restart loses it. The next poll
    // then falls through to shouldRunShadowPlanCycle, which skips on the plan's
    // own freshness — reason "heartbeat", distinct from the "cadence" rate-limit
    // gate. Covers the old gate's integration, which the cadence gate now fronts.
    const root = mkdtempSync(join(tmpdir(), "symph-shadow-tick-restart-"));
    let plannerBuilt = false;
    try {
      // Persist a fresh plan directly (no tick → no in-memory marker = restart).
      await recordPlanRevision(
        root,
        {
          batches: [
            {
              batchId: "b1",
              mode: "parallel-isolated",
              status: "lookahead",
              members: [{ issueId: "1", issueIdentifier: "SYMPH-1" }],
              rationale: "r",
              canary: null,
            },
          ],
          options: [],
          envelope: ENVELOPE,
          rationale: "seed",
          source: "planner",
          dependencyEdges: [],
        },
        { planId: "plan-1", createdAt: "2026-06-18T01:00:00.000Z" },
      );
      const result = await runStandingPlanShadowTick({
        config: triageConfig(),
        workspaceRoot: root,
        fetchCandidates: async () => [issue("u1", "SYMPH-1")],
        getInFlight: () => [],
        createPlannerRunner: () => {
          plannerBuilt = true;
          return okPlanner().runClaude;
        },
        log: () => undefined,
        // 1 min after the recorded plan — inside the 15m heartbeat window.
        now: () => new Date("2026-06-18T01:01:00.000Z"),
      });
      expect(result).toEqual({ status: "skipped", reason: "heartbeat" });
      expect(plannerBuilt).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("enrichPlannerContextWithComments (SYMPH-896)", () => {
  const COMMENT_CONFIG = {
    enabled: true,
    maxCandidates: 25,
    maxCommentPages: 3,
    maxComments: 6,
    maxCommentChars: 400,
    maxTotalChars: 1200,
  };

  it("attaches curated comments and reports a measurement", async () => {
    const context = assembleShadowPlannerContext({
      candidates: [issue("u1", "SYMPH-1"), issue("u2", "SYMPH-2")],
      inFlight: [],
      envelope: ENVELOPE,
    });
    const fetched: string[] = [];
    const result = await enrichPlannerContextWithComments({
      context,
      config: COMMENT_CONFIG,
      fetchIssueComments: async (issueId) => {
        fetched.push(issueId);
        return issueId === "u1"
          ? [linearComment({ id: "a", body: "overlaps with SYMPH-2" })]
          : [];
      },
    });
    expect(fetched).toEqual(["u1", "u2"]);
    expect(result.context.backlog[0]?.comments?.map((c) => c.body)).toEqual([
      "overlaps with SYMPH-2",
    ]);
    expect(result.context.backlog[1]?.comments).toBeUndefined();
    expect(result.measurement.candidatesConsidered).toBe(2);
    expect(result.measurement.candidatesFetched).toBe(2);
    expect(result.measurement.totalCommentsKept).toBe(1);
    expect(result.measurement.estimatedAddedTokens).toBeGreaterThan(0);
  });

  it("bounds the fetch to maxCandidates and reports truncation", async () => {
    const context = assembleShadowPlannerContext({
      candidates: [
        issue("u1", "SYMPH-1"),
        issue("u2", "SYMPH-2"),
        issue("u3", "SYMPH-3"),
      ],
      inFlight: [],
      envelope: ENVELOPE,
    });
    const fetched: string[] = [];
    const result = await enrichPlannerContextWithComments({
      context,
      config: { ...COMMENT_CONFIG, maxCandidates: 2 },
      fetchIssueComments: async (issueId) => {
        fetched.push(issueId);
        return [];
      },
    });
    expect(fetched).toEqual(["u1", "u2"]);
    expect(result.measurement.candidatesConsidered).toBe(3);
    expect(result.measurement.candidatesFetched).toBe(2);
    expect(result.measurement.candidatesTruncated).toBe(1);
  });

  it("drops service-account noise via the operator config", async () => {
    const context = assembleShadowPlannerContext({
      candidates: [issue("u1", "SYMPH-1")],
      inFlight: [],
      envelope: ENVELOPE,
    });
    const result = await enrichPlannerContextWithComments({
      context,
      config: COMMENT_CONFIG,
      operatorConfig: {
        operatorAllowlist: [],
        serviceAccounts: ["svc@bot.com"],
      },
      fetchIssueComments: async () => [
        linearComment({
          id: "svc",
          body: "automated note",
          user: {
            kind: "user",
            id: "s",
            name: "svc",
            displayName: "svc",
            email: "svc@bot.com",
            botType: null,
            botSubType: null,
          },
        }),
        linearComment({ id: "human", body: "real signal" }),
      ],
    });
    expect(result.context.backlog[0]?.comments?.map((c) => c.body)).toEqual([
      "real signal",
    ]);
    expect(result.measurement.totalDroppedNoise).toBe(1);
  });

  it("swallows a per-candidate fetch failure (best-effort)", async () => {
    const context = assembleShadowPlannerContext({
      candidates: [issue("u1", "SYMPH-1"), issue("u2", "SYMPH-2")],
      inFlight: [],
      envelope: ENVELOPE,
    });
    const result = await enrichPlannerContextWithComments({
      context,
      config: COMMENT_CONFIG,
      fetchIssueComments: async (issueId) => {
        if (issueId === "u1") {
          throw new Error("boom");
        }
        return [linearComment({ id: "ok", body: "fine" })];
      },
    });
    expect(result.context.backlog[0]?.comments).toBeUndefined();
    expect(result.context.backlog[1]?.comments?.map((c) => c.body)).toEqual([
      "fine",
    ]);
    expect(result.measurement.candidatesFetched).toBe(1);
    // the failed fetch still cost a round trip — counted, not silently dropped.
    expect(result.measurement.candidatesFailed).toBe(1);
  });
});

function healthIssue(over: Partial<Issue> = {}): Issue {
  return { ...issue("h1", "SYMPH-100"), ...over };
}

describe("runStandingPlanShadowTick queue-health wiring", () => {
  // A fixed "now" the inflow-window math is computed against.
  const NOW = new Date("2026-06-27T00:00:00.000Z");
  // 1 day before now — inside the 7-day inflow window.
  const RECENT = "2026-06-26T00:00:00.000Z";
  // 30 days before now — outside the 7-day inflow window.
  const STALE = "2026-05-28T00:00:00.000Z";
  describe("end-to-end", () => {
    const fullHealthDeps = (root: string) => ({
      config: triageConfig(),
      workspaceRoot: root,
      fetchCandidates: async () => [issue("u1", "SYMPH-1")],
      getInFlight: () => [],
      createPlannerRunner: () => okPlanner().runClaude,
      log: () => undefined,
      now: () => NOW,
      fetchTriageIssues: async () => [
        healthIssue({ id: "t1", createdAt: RECENT }),
        healthIssue({ id: "t2", createdAt: STALE }),
      ],
      fetchResidualIssues: async () => [
        healthIssue({ id: "r1", title: "[track:abc] residual" }),
        healthIssue({ id: "r2", title: "plain" }),
      ],
      getReviewRoundDepth: async () => 3 as number | null,
      getHotFileGrowth: async () =>
        ({
          topFileChurnFraction: 0.7,
          godFileConcentration: "high",
        }) as HotFileGrowth | null,
    });

    it("completes (status ok) when all four health deps are wired", async () => {
      const root = mkdtempSync(join(tmpdir(), "symph-shadow-health-"));
      try {
        const result = await runStandingPlanShadowTick(fullHealthDeps(root));
        expect(result.status).toBe("ok");
        expect((await loadStandingPlan(root))?.revision).toBe(1);
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    });

    it("renders a non-empty Queue health block when production health deps are wired", async () => {
      const root = mkdtempSync(join(tmpdir(), "symph-shadow-health-"));
      let capturedPlannerPrompt = "";
      try {
        const result = await runStandingPlanShadowTick({
          ...fullHealthDeps(root),
          createPlannerRunner: () => async (prompt: string) => {
            if (
              !prompt.startsWith("Review this already-produced standing plan.")
            ) {
              capturedPlannerPrompt = prompt;
            }
            return okPlanner().runClaude();
          },
        });
        expect(result.status).toBe("ok");
        expect(capturedPlannerPrompt).toContain("## Queue health");
        expect(capturedPlannerPrompt).toContain("- Triage intake: depth 2");
        expect(capturedPlannerPrompt).toContain("- Residual share: 0.500");
        expect(capturedPlannerPrompt).toContain("- Hot-file growth:");
        expect(capturedPlannerPrompt).toContain("- Review-round depth: 3");
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    });

    it("keeps advisory-input volume out of queue-health counts", async () => {
      const root = mkdtempSync(join(tmpdir(), "symph-shadow-health-"));
      let capturedPlannerPrompt = "";
      try {
        await runStandingPlanShadowTick({
          ...fullHealthDeps(root),
          config: triageConfig({ structuralAdvisories: true }),
          fetchAdvisoryInput: async () =>
            Array.from({ length: 8 }, (_, index) => ({
              ...issue(`a${index}`, `SYMPH-${200 + index}`),
              state: "Backlog",
            })),
          createPlannerRunner: () => async (prompt: string) => {
            if (
              !prompt.startsWith("Review this already-produced standing plan.")
            ) {
              capturedPlannerPrompt = prompt;
            }
            return okPlanner().runClaude();
          },
        });
        expect(capturedPlannerPrompt).toContain("## Backlog advisory input");
        expect(capturedPlannerPrompt).toContain("SYMPH-207 [Backlog");
        expect(capturedPlannerPrompt).toContain("- Triage intake: depth 2");
        expect(capturedPlannerPrompt).toContain("- Residual share: 0.500");
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    });

    it("completes (status ok) when no health deps are wired (back-compat)", async () => {
      const root = mkdtempSync(join(tmpdir(), "symph-shadow-health-"));
      try {
        // No fetchTriageIssues/fetchResidualIssues/etc. → health is omitted entirely,
        // and the tick still records a plan (the prompt is byte-unchanged).
        const result = await runStandingPlanShadowTick({
          config: triageConfig(),
          workspaceRoot: root,
          fetchCandidates: async () => [issue("u1", "SYMPH-1")],
          getInFlight: () => [],
          createPlannerRunner: () => okPlanner().runClaude,
          log: () => undefined,
          now: () => NOW,
        });
        expect(result.status).toBe("ok");
        expect((await loadStandingPlan(root))?.revision).toBe(1);
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    });

    it("a health-fetch throw degrades to no health and the tick still completes", async () => {
      const root = mkdtempSync(join(tmpdir(), "symph-shadow-health-"));
      const intakeReadings: Array<TriageIntakeHealth | null> = [];
      try {
        // fetchTriageIssues throws → triageIntake null → buildQueueHealth undefined →
        // health absent. The tick must NOT throw and must still record a plan.
        const result = await runStandingPlanShadowTick({
          ...fullHealthDeps(root),
          fetchTriageIssues: async () => {
            throw new Error("tracker down");
          },
          onTriageIntakeComputed: (intake) => {
            intakeReadings.push(intake);
          },
        });
        expect(result.status).toBe("ok");
        expect((await loadStandingPlan(root))?.revision).toBe(1);
        expect(intakeReadings).toEqual([null]);
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    });
  });
});

describe("runStandingPlanShadowTick comment enrichment (SYMPH-896)", () => {
  it("does not fetch comments or log a measurement when disabled (default)", async () => {
    const root = mkdtempSync(join(tmpdir(), "symph-shadow-tick-"));
    let commentFetches = 0;
    const events: string[] = [];
    try {
      const result = await runStandingPlanShadowTick({
        config: triageConfig(), // commentEnrichment.enabled = false (default)
        workspaceRoot: root,
        fetchCandidates: async () => [issue("u1", "SYMPH-1")],
        getInFlight: () => [],
        createPlannerRunner: () => okPlanner().runClaude,
        fetchIssueComments: async () => {
          commentFetches += 1;
          return [];
        },
        log: (event) => {
          events.push(event);
        },
        now: () => new Date("2026-06-18T01:00:00.000Z"),
      });
      expect(result.status).toBe("ok");
      expect(commentFetches).toBe(0);
      expect(events).not.toContain("queue_triage_comment_enrichment_measure");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("fetches, injects curated comments, and logs a measurement when enabled", async () => {
    const root = mkdtempSync(join(tmpdir(), "symph-shadow-tick-"));
    let capturedPlannerPrompt = "";
    const logged: Array<{ event: string; fields: Record<string, unknown> }> =
      [];
    try {
      const result = await runStandingPlanShadowTick({
        config: triageConfig({
          commentEnrichment: {
            enabled: true,
            maxCandidates: 25,
            maxCommentPages: 3,
            maxComments: 6,
            maxCommentChars: 400,
            maxTotalChars: 1200,
          },
        }),
        workspaceRoot: root,
        fetchCandidates: async () => [issue("u1", "SYMPH-1")],
        getInFlight: () => [],
        createPlannerRunner: () => async (prompt: string) => {
          if (
            !prompt.startsWith("Review this already-produced standing plan.")
          ) {
            capturedPlannerPrompt = prompt;
          }
          return okPlanner().runClaude();
        },
        fetchIssueComments: async () => [
          linearComment({ id: "a", body: "overlaps with SYMPH-2" }),
        ],
        log: (event, _message, fields) => {
          logged.push({ event, fields });
        },
        now: () => new Date("2026-06-18T01:00:00.000Z"),
      });
      expect(result.status).toBe("ok");
      const measure = logged.find(
        (entry) => entry.event === "queue_triage_comment_enrichment_measure",
      );
      expect(measure).toBeDefined();
      expect(measure?.fields.totalCommentsKept).toBe(1);
      expect(capturedPlannerPrompt).toContain(
        "- [human] overlaps with SYMPH-2",
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("does not fetch or log a measurement on an empty backlog (council P2)", async () => {
    const root = mkdtempSync(join(tmpdir(), "symph-shadow-tick-"));
    let commentFetches = 0;
    const events: string[] = [];
    try {
      const result = await runStandingPlanShadowTick({
        config: triageConfig({
          commentEnrichment: {
            enabled: true,
            maxCandidates: 25,
            maxCommentPages: 3,
            maxComments: 6,
            maxCommentChars: 400,
            maxTotalChars: 1200,
          },
        }),
        workspaceRoot: root,
        fetchCandidates: async () => [],
        getInFlight: () => [],
        createPlannerRunner: () => okPlanner().runClaude,
        fetchIssueComments: async () => {
          commentFetches += 1;
          return [];
        },
        log: (event) => {
          events.push(event);
        },
        now: () => new Date("2026-06-18T01:00:00.000Z"),
      });
      expect(result.status).toBe("ok");
      expect(commentFetches).toBe(0);
      expect(events).not.toContain("queue_triage_comment_enrichment_measure");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("logs a skip when enabled but no comment fetch is wired (council Track)", async () => {
    const root = mkdtempSync(join(tmpdir(), "symph-shadow-tick-"));
    const events: string[] = [];
    try {
      const result = await runStandingPlanShadowTick({
        config: triageConfig({
          commentEnrichment: {
            enabled: true,
            maxCandidates: 25,
            maxCommentPages: 3,
            maxComments: 6,
            maxCommentChars: 400,
            maxTotalChars: 1200,
          },
        }),
        workspaceRoot: root,
        fetchCandidates: async () => [issue("u1", "SYMPH-1")],
        getInFlight: () => [],
        createPlannerRunner: () => okPlanner().runClaude,
        // fetchIssueComments deliberately NOT wired (e.g. non-Linear tracker).
        log: (event) => {
          events.push(event);
        },
        now: () => new Date("2026-06-18T01:00:00.000Z"),
      });
      expect(result.status).toBe("ok");
      expect(events).toContain("queue_triage_comment_enrichment_skipped");
      expect(events).not.toContain("queue_triage_comment_enrichment_measure");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
