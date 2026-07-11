import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import type {
  PlanBatch,
  PlanDecision,
  PlanDependencyEdge,
  PlanEnvelope,
  PlanReviewRecord,
} from "../../src/domain/standing-plan.js";
import { appendStandingPlanJournalEntriesWithLock } from "../../src/logging/standing-plan-journal.js";
import { readStandingPlanJournal } from "../../src/logging/standing-plan-journal.js";
import { resolveDocComment } from "../../src/orchestrator/standing-plan-comment-resolve.js";
import { renderStandingPlanControlDoc } from "../../src/orchestrator/standing-plan-doc-render.js";
import {
  listHonoredDecisions,
  loadLastReviewedContentHash,
  loadStandingPlan,
  projectHonoredDecisions,
  projectLastReviewedContentHash,
  recordPlanControlDecision,
  recordPlanDecision,
  recordPlanRevision,
  recordStructuralAdvisoryState,
} from "../../src/orchestrator/standing-plan-store.js";
import type { PlanBody } from "../../src/orchestrator/standing-plan-supersession.js";

const ENVELOPE: PlanEnvelope = {
  version: 1,
  concurrencyCeiling: 3,
  allowedRisk: "medium",
  allowedModes: ["parallel-isolated"],
};

function lookahead(id: string, identifier: string): PlanBatch {
  return {
    batchId: id,
    mode: "parallel-isolated",
    status: "lookahead",
    members: [{ issueId: id, issueIdentifier: identifier }],
    rationale: "r",
    canary: null,
  };
}

function body(
  batches: PlanBatch[],
  dependencyEdges: PlanDependencyEdge[] = [],
): PlanBody {
  return {
    batches,
    options: [{ marker: "[opt-1]", label: "Release", intent: null }],
    envelope: ENVELOPE,
    rationale: "rationale",
    source: "planner",
    dependencyEdges,
  };
}

function tmpRoot(): string {
  return mkdtempSync(join(tmpdir(), "symph-standing-plan-store-"));
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

async function recordReviewedRevision(
  root: string,
  planBody: PlanBody,
  options: {
    planId?: string;
    createdAt: string;
    review?: Partial<PlanReviewRecord>;
  },
) {
  const recorded = await recordPlanRevision(root, planBody, {
    ...(options.planId === undefined ? {} : { planId: options.planId }),
    createdAt: options.createdAt,
  });
  return recordPlanRevision(root, planBody, {
    createdAt: options.createdAt,
    reviewRecords: [
      tier2Record({
        diffHash: recorded.plan.contentHash,
        ...(options.review ?? {}),
      }),
    ],
  });
}

describe("standing-plan store", () => {
  it("returns null when no plan has been recorded", async () => {
    const root = tmpRoot();
    try {
      expect(await loadStandingPlan(root)).toBeNull();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("projects legacy revisions without advisories as an empty report array", async () => {
    const root = tmpRoot();
    try {
      await appendStandingPlanJournalEntriesWithLock(root, [
        {
          kind: "plan_revision",
          idempotencyKey: "legacy-plan:rev:1",
          timestamp: "2026-06-18T00:00:00.000Z",
          planId: "legacy-plan",
          revision: {
            revision: 1,
            planId: "legacy-plan",
            contentHash: "legacy-hash",
            supersedes: null,
            createdAt: "2026-06-18T00:00:00.000Z",
            envelope: ENVELOPE,
            batches: [],
            dependencyEdges: [],
            options: [],
            rationale: "legacy",
            source: "planner",
          },
        },
      ]);

      expect((await loadStandingPlan(root))?.structuralAdvisories).toEqual([]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("returns null when no reviewed tier-2 baseline exists", async () => {
    const root = tmpRoot();
    try {
      expect(projectLastReviewedContentHash([])).toBeNull();
      await recordPlanRevision(root, body([lookahead("b1", "SYMPH-1")]), {
        planId: "plan-1",
        createdAt: "2026-06-18T00:00:00.000Z",
        findings: [
          {
            title: "Tier-1 finding only",
            planAnchor: "b1",
            severity: "Track",
          },
        ],
      });
      expect(await loadLastReviewedContentHash(root)).toBeNull();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("loads the latest revision with a reviewed tier-2 record as the baseline", async () => {
    const root = tmpRoot();
    try {
      await recordReviewedRevision(root, body([lookahead("b1", "SYMPH-1")]), {
        planId: "plan-1",
        createdAt: "2026-06-18T00:00:00.000Z",
      });
      const latest = await recordReviewedRevision(
        root,
        body([lookahead("b2", "SYMPH-2")]),
        {
          planId: "plan-1",
          createdAt: "2026-06-18T00:05:00.000Z",
        },
      );

      expect(await loadLastReviewedContentHash(root)).toBe(
        latest.plan.contentHash,
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("ignores reviewed tier-2 records whose diff hash does not match persisted content", async () => {
    const root = tmpRoot();
    try {
      await recordPlanRevision(root, body([lookahead("b1", "SYMPH-1")]), {
        planId: "plan-1",
        createdAt: "2026-06-18T00:00:00.000Z",
        reviewRecords: [tier2Record({ diffHash: "stale-preview-hash" })],
      });
      expect(await loadLastReviewedContentHash(root)).toBeNull();

      const reviewed = await recordReviewedRevision(
        root,
        body([lookahead("b2", "SYMPH-2")]),
        {
          createdAt: "2026-06-18T00:05:00.000Z",
        },
      );
      await recordPlanRevision(root, body([lookahead("b3", "SYMPH-3")]), {
        createdAt: "2026-06-18T00:10:00.000Z",
        reviewRecords: [tier2Record({ diffHash: "stale-preview-hash-2" })],
      });

      expect(await loadLastReviewedContentHash(root)).toBe(
        reviewed.plan.contentHash,
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("skips newer skipped or degraded tier-2 records when loading the baseline", async () => {
    const root = tmpRoot();
    try {
      const reviewed = await recordReviewedRevision(
        root,
        body([lookahead("b1", "SYMPH-1")]),
        {
          planId: "plan-1",
          createdAt: "2026-06-18T00:00:00.000Z",
        },
      );
      await recordPlanRevision(root, body([lookahead("b2", "SYMPH-2")]), {
        planId: "plan-1",
        createdAt: "2026-06-18T00:05:00.000Z",
        reviewRecords: [
          tier2Record({
            status: "skipped",
            gateReason: "content_hash_unchanged",
            aggregateVerdict: null,
            note: "plan content hash already reviewed",
          }),
        ],
      });
      await recordPlanRevision(root, body([lookahead("b3", "SYMPH-3")]), {
        planId: "plan-1",
        createdAt: "2026-06-18T00:10:00.000Z",
        reviewRecords: [
          tier2Record({
            status: "degraded",
            gateReason: "content_hash_changed",
            aggregateVerdict: "degraded",
            note: "tier-2 review degraded",
          }),
        ],
      });

      expect(await loadLastReviewedContentHash(root)).toBe(
        reviewed.plan.contentHash,
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("persists a revision and projects it back after a restart", async () => {
    const root = tmpRoot();
    try {
      const result = await recordPlanRevision(
        root,
        body([lookahead("b1", "SYMPH-1")]),
        { planId: "plan-1", createdAt: "2026-06-18T00:00:00.000Z" },
      );
      expect(result.recorded).toBe(true);
      expect(result.plan.revision).toBe(1);

      // Fresh read = restart.
      const reloaded = await loadStandingPlan(root);
      expect(reloaded?.revision).toBe(1);
      expect(reloaded?.batches.map((batch) => batch.batchId)).toEqual(["b1"]);
      expect(reloaded?.options[0]?.marker).toBe("[opt-1]");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("is idempotent: re-recording an unchanged body does not rotate the revision", async () => {
    const root = tmpRoot();
    try {
      await recordPlanRevision(root, body([lookahead("b1", "SYMPH-1")]), {
        planId: "plan-1",
        createdAt: "2026-06-18T00:00:00.000Z",
      });
      const again = await recordPlanRevision(
        root,
        body([lookahead("b1", "SYMPH-1")]),
        { createdAt: "2026-06-18T00:10:00.000Z" },
      );
      expect(again.recorded).toBe(false);
      expect(again.plan.revision).toBe(1);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("round-trips dependency edges through record and load", async () => {
    const root = tmpRoot();
    try {
      const edges: PlanDependencyEdge[] = [
        { issueIdentifier: "SYMPH-2", dependsOn: "SYMPH-1" },
      ];
      const result = await recordPlanRevision(
        root,
        body([lookahead("b1", "SYMPH-1"), lookahead("b2", "SYMPH-2")], edges),
        { planId: "plan-1", createdAt: "2026-06-18T00:00:00.000Z" },
      );

      expect(result.recorded).toBe(true);
      expect(result.plan.dependencyEdges).toEqual(edges);
      expect((await loadStandingPlan(root))?.dependencyEdges).toEqual(edges);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("round-trips premise trail and refreshes findings without rotating the revision", async () => {
    const root = tmpRoot();
    try {
      const first = await recordPlanRevision(
        root,
        {
          ...body([lookahead("b1", "SYMPH-1")]),
          premises: [
            {
              decisionAnchor: "SYMPH-1",
              kind: "verifiable",
              statement: "Candidate is in Backlog.",
            },
          ],
        },
        {
          planId: "plan-1",
          createdAt: "2026-06-18T00:00:00.000Z",
          findings: [
            {
              title: "Scheduled ineligible candidate SYMPH-1 (Cancelled)",
              planAnchor: "b1:SYMPH-1",
              severity: "P2",
            },
          ],
        },
      );

      expect(first.recorded).toBe(true);
      expect(first.plan.premises).toEqual([
        {
          decisionAnchor: "SYMPH-1",
          kind: "verifiable",
          statement: "Candidate is in Backlog.",
        },
      ]);
      expect(first.plan.findings).toEqual([
        {
          title: "Scheduled ineligible candidate SYMPH-1 (Cancelled)",
          planAnchor: "b1:SYMPH-1",
          severity: "P2",
        },
      ]);
      expect((await loadStandingPlan(root))?.findings).toEqual(
        first.plan.findings,
      );

      const sameStructure = await recordPlanRevision(
        root,
        {
          ...body([lookahead("b1", "SYMPH-1")]),
          premises: [
            {
              decisionAnchor: "SYMPH-1",
              kind: "judgment",
              statement: "Different report-only premise.",
            },
          ],
        },
        {
          createdAt: "2026-06-18T00:05:00.000Z",
          findings: [
            {
              title: "Different report-only finding",
              planAnchor: "b1",
              severity: "Track",
            },
          ],
        },
      );

      expect(sameStructure.plan.revision).toBe(1);
      expect(sameStructure.recorded).toBe(true);
      expect(sameStructure.plan.findings).toEqual([
        {
          title: "Different report-only finding",
          planAnchor: "b1",
          severity: "Track",
        },
      ]);
      expect((await loadStandingPlan(root))?.findings).toEqual(
        sameStructure.plan.findings,
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("refreshes advisory-only reports in place and preserves pending decisions", async () => {
    const root = tmpRoot();
    try {
      const planBody: PlanBody = {
        ...body([lookahead("b1", "SYMPH-1")]),
        options: [
          {
            marker: "[opt-1]",
            label: "Release b1",
            intent: { verb: "release_batch", batchId: "b1" },
          },
        ],
      };
      const first = await recordPlanRevision(
        root,
        {
          ...planBody,
          structuralAdvisories: [
            {
              memberIssueIdentifiers: ["SYMPH-1", "SYMPH-2"],
              rootCauseHypothesis: "Shared root A",
              structuralFix: "Fix root A",
              confidenceNote: "High",
            },
          ],
        },
        {
          planId: "plan-1",
          createdAt: "2026-06-18T00:00:00.000Z",
        },
      );
      const approval: PlanDecision = {
        decisionId: "decision-1",
        planId: "plan-1",
        revision: first.plan.revision,
        batchId: "b1",
        kind: "approve",
        actor: "operator@example.com",
        optionMarker: "[opt-1]",
        createdAt: "2026-06-18T00:01:00.000Z",
        note: null,
      };
      await recordPlanDecision(root, approval);

      const refreshed = await recordPlanRevision(
        root,
        {
          ...planBody,
          structuralAdvisories: [
            {
              memberIssueIdentifiers: ["SYMPH-1", "SYMPH-3"],
              rootCauseHypothesis: "Shared root B",
              structuralFix: "Fix root B",
              confidenceNote: "Medium",
            },
          ],
        },
        { createdAt: "2026-06-18T00:02:00.000Z" },
      );

      expect(refreshed.recorded).toBe(true);
      expect(refreshed.plan.revision).toBe(first.plan.revision);
      expect(refreshed.plan.contentHash).toBe(first.plan.contentHash);
      expect(refreshed.plan.structuralAdvisories?.[0]?.structuralFix).toBe(
        "Fix root B",
      );
      expect(await listHonoredDecisions(root)).toEqual([approval]);
      const reloaded = await loadStandingPlan(root);
      expect(reloaded?.structuralAdvisories).toEqual(
        refreshed.plan.structuralAdvisories,
      );
      expect(reloaded?.updatedAt).toBe("2026-06-18T00:02:00.000Z");
      expect(reloaded?.optionsPublishedAt).toBe("2026-06-18T00:00:00.000Z");
      if (reloaded === null) {
        throw new Error("expected a refreshed standing plan");
      }
      expect(
        resolveDocComment({
          comment: {
            body: "approve",
            quotedText: "[opt-1:r1] Release b1",
            authorEmail: "operator@example.com",
            createdAt: "2026-06-18T00:01:30.000Z",
          },
          plan: reloaded,
          operatorAllowlist: new Set(["operator@example.com"]),
        }),
      ).toEqual({
        kind: "intent",
        optionMarker: "[opt-1]",
        verb: "release_batch",
        batchId: "b1",
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("preserves terminal advisory state across stale report refreshes and permits only explicit rejected-evidence revival", async () => {
    const root = tmpRoot();
    const planBody = body([lookahead("b1", "SYMPH-1")]);
    const advisoryBase = {
      memberIssueIdentifiers: ["SYMPH-1", "SYMPH-2"],
      rootCauseHypothesis: "Shared root",
      structuralFix: "Fix root",
      confidenceNote: "High",
      memberSetHash: "members-1",
      advisoryFingerprint: "fp-1",
      lifecycleState: "active" as const,
      rendered: true,
    };
    const withdrawnBase = {
      ...advisoryBase,
      memberIssueIdentifiers: ["SYMPH-3", "SYMPH-4"],
      memberSetHash: "members-2",
      advisoryFingerprint: "fp-2",
    };
    try {
      await recordPlanRevision(
        root,
        {
          ...planBody,
          structuralAdvisories: [advisoryBase, withdrawnBase],
        },
        { planId: "plan-1", createdAt: "2026-06-18T00:00:00.000Z" },
      );
      await recordStructuralAdvisoryState(root, {
        advisoryFingerprint: "fp-1",
        lifecycleState: "graded",
        createdAt: "2026-06-18T00:01:00.000Z",
      });
      await recordStructuralAdvisoryState(root, {
        advisoryFingerprint: "fp-2",
        lifecycleState: "withdrawn",
        createdAt: "2026-06-18T00:02:00.000Z",
      });

      const staleRefresh = await recordPlanRevision(
        root,
        {
          ...planBody,
          structuralAdvisories: [advisoryBase, withdrawnBase],
        },
        { createdAt: "2026-06-18T00:03:00.000Z" },
      );
      expect(
        staleRefresh.plan.structuralAdvisories?.map((item) => [
          item.advisoryFingerprint,
          item.lifecycleState,
          item.rendered,
        ]),
      ).toEqual([
        ["fp-1", "graded", false],
        ["fp-2", "withdrawn", false],
      ]);

      const changedBody = body(
        [lookahead("b1", "SYMPH-1"), lookahead("b2", "SYMPH-2")],
        [{ issueIdentifier: "SYMPH-2", dependsOn: "SYMPH-1" }],
      );
      const changedContentRefresh = await recordPlanRevision(
        root,
        {
          ...changedBody,
          structuralAdvisories: [advisoryBase, withdrawnBase],
        },
        { createdAt: "2026-06-18T00:03:30.000Z" },
      );
      expect(changedContentRefresh.plan.revision).toBe(2);
      expect(changedContentRefresh.plan.dependencyEdges).toEqual([
        { issueIdentifier: "SYMPH-2", dependsOn: "SYMPH-1" },
      ]);
      expect(
        changedContentRefresh.plan.structuralAdvisories?.map((item) => [
          item.advisoryFingerprint,
          item.lifecycleState,
          item.rendered,
        ]),
      ).toEqual([
        ["fp-1", "graded", false],
        ["fp-2", "withdrawn", false],
      ]);

      const explicitRevival = await recordPlanRevision(
        root,
        {
          ...changedBody,
          structuralAdvisories: [
            {
              ...advisoryBase,
              previouslyRejectedWithNewEvidence: true,
            },
            {
              ...withdrawnBase,
              previouslyRejectedWithNewEvidence: true,
            },
          ],
        },
        { createdAt: "2026-06-18T00:04:00.000Z" },
      );
      expect(explicitRevival.plan.structuralAdvisories?.[0]).toMatchObject({
        advisoryFingerprint: "fp-1",
        lifecycleState: "active",
        rendered: true,
        previouslyRejectedWithNewEvidence: true,
      });
      expect(explicitRevival.plan.structuralAdvisories?.[1]).toMatchObject({
        advisoryFingerprint: "fp-2",
        lifecycleState: "withdrawn",
        rendered: false,
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("can return to a previously seen report state for the same structural plan", async () => {
    const root = tmpRoot();
    const reportA = {
      title: "Report A",
      planAnchor: "b1",
      severity: "Track" as const,
    };
    const reportB = {
      title: "Report B",
      planAnchor: "b1",
      severity: "Track" as const,
    };
    try {
      await recordPlanRevision(root, body([lookahead("b1", "SYMPH-1")]), {
        planId: "plan-1",
        createdAt: "2026-06-18T00:00:00.000Z",
        findings: [reportA],
      });

      await recordPlanRevision(root, body([lookahead("b1", "SYMPH-1")]), {
        createdAt: "2026-06-18T00:05:00.000Z",
        findings: [reportB],
      });
      await recordPlanRevision(root, body([lookahead("b1", "SYMPH-1")]), {
        createdAt: "2026-06-18T00:10:00.000Z",
        findings: [reportA],
      });
      const final = await recordPlanRevision(
        root,
        body([lookahead("b1", "SYMPH-1")]),
        {
          createdAt: "2026-06-18T00:15:00.000Z",
          findings: [reportB],
        },
      );

      expect(final.recorded).toBe(true);
      expect(final.plan.revision).toBe(1);
      expect(final.plan.findings).toEqual([reportB]);
      expect((await loadStandingPlan(root))?.findings).toEqual([reportB]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("preserves prior tier-2 findings when an unchanged tier-2 skip refreshes the report", async () => {
    const root = tmpRoot();
    const planBody = body([lookahead("b1", "SYMPH-1")]);
    const tier2Finding = {
      title: "Prior tier-2 finding",
      planAnchor: "plan:issue/SYMPH-1",
      severity: "P2" as const,
      source: "tier-2" as const,
      structuredFingerprint: "fp-tier2-prior",
    };
    try {
      const recorded = await recordPlanRevision(root, planBody, {
        planId: "plan-1",
        createdAt: "2026-06-18T00:00:00.000Z",
      });
      const reviewed = await recordPlanRevision(root, planBody, {
        createdAt: "2026-06-18T00:05:00.000Z",
        findings: [tier2Finding],
        reviewRecords: [
          tier2Record({
            status: "reviewed",
            diffHash: recorded.plan.contentHash,
            gateReason: "no_baseline",
            aggregateVerdict: "fail",
            findingFingerprints: ["fp-tier2-prior"],
          }),
        ],
      });

      const skipped = await recordPlanRevision(root, planBody, {
        createdAt: "2026-06-18T00:10:00.000Z",
        findings: [],
        reviewRecords: [
          tier2Record({
            status: "skipped",
            diffHash: reviewed.plan.contentHash,
            gateReason: "content_hash_unchanged",
            aggregateVerdict: null,
            note: "plan content hash already reviewed",
          }),
        ],
      });

      expect(skipped.plan.findings).toEqual([tier2Finding]);
      expect((await loadStandingPlan(root))?.findings).toEqual([tier2Finding]);
      expect(
        renderStandingPlanControlDoc({
          plan: skipped.plan,
          recentlyShipped: [],
          inFlight: [],
          changelog: [],
        }),
      ).toContain("Prior tier-2 finding");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("rotates the revision when only dependency edges change", async () => {
    const root = tmpRoot();
    try {
      const batches = [lookahead("b1", "SYMPH-1"), lookahead("b2", "SYMPH-2")];
      await recordPlanRevision(root, body(batches), {
        planId: "plan-1",
        createdAt: "2026-06-18T00:00:00.000Z",
      });

      const changed = await recordPlanRevision(
        root,
        body(batches, [{ issueIdentifier: "SYMPH-2", dependsOn: "SYMPH-1" }]),
        { createdAt: "2026-06-18T00:10:00.000Z" },
      );

      expect(changed.recorded).toBe(true);
      expect(changed.plan.revision).toBe(2);
      expect(changed.plan.dependencyEdges).toEqual([
        { issueIdentifier: "SYMPH-2", dependsOn: "SYMPH-1" },
      ]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("is idempotent when only generated rationale text changes", async () => {
    const root = tmpRoot();
    try {
      const firstBatch = lookahead("b1", "SYMPH-1");
      firstBatch.rationale = "The highest-value eligible issue.";
      await recordPlanRevision(
        root,
        {
          ...body([firstBatch]),
          options: [
            {
              marker: "[opt-1]",
              label: "Release b1",
              intent: { verb: "release_batch", batchId: "b1" },
            },
          ],
          rationale: "The eligible backlog has one obvious next step.",
        },
        {
          planId: "plan-1",
          createdAt: "2026-06-18T00:00:00.000Z",
        },
      );

      const secondBatch = lookahead("b1", "SYMPH-1");
      secondBatch.rationale = "Different prose for the same batch.";
      const again = await recordPlanRevision(
        root,
        {
          ...body([secondBatch]),
          options: [
            {
              marker: "[opt-1]",
              label: "Different display label for the same release option",
              intent: { verb: "release_batch", batchId: "b1" },
            },
          ],
          rationale: "Backlog wording changed, structure did not.",
        },
        {
          createdAt: "2026-06-18T00:10:00.000Z",
        },
      );

      expect(again.recorded).toBe(false);
      expect(again.plan.revision).toBe(1);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("pins the first revision's rationale and labels when only prose changes (SYMPH-827)", async () => {
    // PR #613 excludes rationale/labels from computePlanContentHash, so a
    // structurally-identical re-plan with FRESH reasoning is a no-op: the store
    // returns the current plan, PINNING the original rationale and labels. This
    // locks that intended churn-suppression (decision: accept pinning) and
    // documents that the displayed reasoning stays the first revision's until the
    // STRUCTURE actually changes — operators see a stable, not rotating, plan.
    const root = tmpRoot();
    try {
      const firstBatch = lookahead("b1", "SYMPH-1");
      firstBatch.rationale = "Original: the highest-value eligible issue.";
      const first = await recordPlanRevision(
        root,
        {
          ...body([firstBatch]),
          options: [{ marker: "[opt-1]", label: "Release b1", intent: null }],
          rationale: "Original plan rationale.",
        },
        { planId: "plan-1", createdAt: "2026-06-18T00:00:00.000Z" },
      );
      expect(first.recorded).toBe(true);

      const secondBatch = lookahead("b1", "SYMPH-1");
      secondBatch.rationale = "Reworded: same batch, fresh prose.";
      const again = await recordPlanRevision(
        root,
        {
          ...body([secondBatch]),
          options: [
            {
              marker: "[opt-1]",
              label: "Reworded label, same option",
              intent: null,
            },
          ],
          rationale: "Reworded plan rationale — structure unchanged.",
        },
        { createdAt: "2026-06-18T00:10:00.000Z" },
      );

      // No rotation, and the returned plan keeps the ORIGINAL (pinned) prose.
      expect(again.recorded).toBe(false);
      expect(again.plan.revision).toBe(1);
      expect(again.plan.rationale).toBe("Original plan rationale.");
      expect(again.plan.batches[0]?.rationale).toBe(
        "Original: the highest-value eligible issue.",
      );
      expect(again.plan.options[0]?.label).toBe("Release b1");

      // A fresh projection (restart) also returns the pinned original.
      const reloaded = await loadStandingPlan(root);
      expect(reloaded?.revision).toBe(1);
      expect(reloaded?.rationale).toBe("Original plan rationale.");
      expect(reloaded?.batches[0]?.rationale).toBe(
        "Original: the highest-value eligible issue.",
      );
      expect(reloaded?.options[0]?.label).toBe("Release b1");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("updates rationale when the structure DOES change (the pinning counterpart, SYMPH-827)", async () => {
    // The flip side of pinning: a structural change rotates the revision and the
    // NEW rationale takes effect — rationale is pinned only while the structure
    // is identical, never across a real re-plan. Guards against over-pinning.
    const root = tmpRoot();
    try {
      await recordPlanRevision(
        root,
        {
          ...body([lookahead("b1", "SYMPH-1")]),
          rationale: "First rationale.",
        },
        { planId: "plan-1", createdAt: "2026-06-18T00:00:00.000Z" },
      );
      const changed = await recordPlanRevision(
        root,
        {
          ...body([lookahead("b2", "SYMPH-2")]),
          rationale: "Second rationale — new structure.",
        },
        { createdAt: "2026-06-18T00:01:00.000Z" },
      );
      expect(changed.recorded).toBe(true);
      expect(changed.plan.revision).toBe(2);
      expect(changed.plan.rationale).toBe("Second rationale — new structure.");
      expect((await loadStandingPlan(root))?.rationale).toBe(
        "Second rationale — new structure.",
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("rotates the revision when the plan body changes", async () => {
    const root = tmpRoot();
    try {
      await recordPlanRevision(root, body([lookahead("b1", "SYMPH-1")]), {
        planId: "plan-1",
        createdAt: "2026-06-18T00:00:00.000Z",
      });
      const changed = await recordPlanRevision(
        root,
        body([lookahead("b2", "SYMPH-2")]),
        { createdAt: "2026-06-18T00:01:00.000Z" },
      );
      expect(changed.recorded).toBe(true);
      expect(changed.plan.revision).toBe(2);
      expect(changed.plan.updatedAt).toBe("2026-06-18T00:01:00.000Z");
      expect(changed.plan.optionsPublishedAt).toBe("2026-06-18T00:01:00.000Z");
      expect((await loadStandingPlan(root))?.batches[0]?.batchId).toBe("b2");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("records an operator decision bound to the current revision", async () => {
    const root = tmpRoot();
    try {
      await recordPlanRevision(root, body([lookahead("b1", "SYMPH-1")]), {
        planId: "plan-1",
        createdAt: "2026-06-18T00:00:00.000Z",
      });
      const decision: PlanDecision = {
        decisionId: "d1",
        planId: "plan-1",
        revision: 1,
        batchId: "b1",
        kind: "approve",
        actor: "eric@litman.org",
        optionMarker: "[opt-1]",
        createdAt: "2026-06-18T00:00:30.000Z",
        note: null,
      };
      const result = await recordPlanDecision(root, decision);
      expect(result.recorded).toBe(true);
      const honored = await listHonoredDecisions(root);
      expect(honored.map((entry) => entry.decisionId)).toEqual(["d1"]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("rejects a decision bound to a superseded revision", async () => {
    const root = tmpRoot();
    try {
      await recordPlanRevision(root, body([lookahead("b1", "SYMPH-1")]), {
        planId: "plan-1",
        createdAt: "2026-06-18T00:00:00.000Z",
      });
      await recordPlanRevision(root, body([lookahead("b2", "SYMPH-2")]), {
        createdAt: "2026-06-18T00:01:00.000Z",
      });
      // Decision against the now-superseded revision 1.
      const stale: PlanDecision = {
        decisionId: "d-stale",
        planId: "plan-1",
        revision: 1,
        batchId: "b1",
        kind: "approve",
        actor: "eric@litman.org",
        optionMarker: "[opt-1]",
        createdAt: "2026-06-18T00:02:00.000Z",
        note: null,
      };
      const result = await recordPlanDecision(root, stale);
      expect(result.recorded).toBe(false);
      expect(result.reason).toBe("stale_revision");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("carries an in-flight batch forward immutably across a re-plan", async () => {
    const root = tmpRoot();
    try {
      // Seed a revision that already has an in-flight (committed) batch by
      // writing it directly to the journal, simulating a PR2 dispatch.
      const inFlight: PlanBatch = {
        batchId: "live",
        mode: "parallel-isolated",
        status: "in_flight",
        members: [{ issueId: "live", issueIdentifier: "SYMPH-100" }],
        rationale: "running",
        canary: null,
      };
      await appendStandingPlanJournalEntriesWithLock(root, [
        {
          kind: "plan_revision",
          idempotencyKey: "plan-1:rev:1",
          timestamp: "2026-06-18T00:00:00.000Z",
          planId: "plan-1",
          revision: {
            revision: 1,
            planId: "plan-1",
            contentHash: "seed",
            supersedes: null,
            createdAt: "2026-06-18T00:00:00.000Z",
            envelope: ENVELOPE,
            batches: [inFlight, lookahead("old", "SYMPH-9")],
            dependencyEdges: [],
            options: [],
            rationale: "seed",
            source: "planner",
          },
        },
      ]);

      const replan = await recordPlanRevision(
        root,
        body([lookahead("new", "SYMPH-2")]),
        { createdAt: "2026-06-18T00:01:00.000Z" },
      );
      expect(replan.recorded).toBe(true);
      const plan = await loadStandingPlan(root);
      expect(plan?.batches.map((batch) => batch.batchId)).toEqual([
        "live",
        "new",
      ]);
      expect(plan?.batches.find((batch) => batch.batchId === "live")).toEqual(
        inFlight,
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("serializes concurrent re-plans so neither distinct body is dropped", async () => {
    const root = tmpRoot();
    try {
      const [a, b] = await Promise.all([
        recordPlanRevision(root, body([lookahead("b1", "SYMPH-1")]), {
          planId: "plan-1",
          createdAt: "2026-06-18T00:00:00.000Z",
        }),
        recordPlanRevision(root, body([lookahead("b2", "SYMPH-2")]), {
          planId: "plan-1",
          createdAt: "2026-06-18T00:00:01.000Z",
        }),
      ]);
      // Both distinct bodies must land as distinct, monotonically-rotated
      // revisions — neither silently dropped on a colliding revision id.
      expect(a.recorded).toBe(true);
      expect(b.recorded).toBe(true);
      expect([a.plan.revision, b.plan.revision].sort()).toEqual([1, 2]);
      const plan = await loadStandingPlan(root);
      expect(plan?.revision).toBe(2);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("records a decision idempotently (recorded=false on replay)", async () => {
    const root = tmpRoot();
    try {
      await recordPlanRevision(root, body([lookahead("b1", "SYMPH-1")]), {
        planId: "plan-1",
        createdAt: "2026-06-18T00:00:00.000Z",
      });
      const decision: PlanDecision = {
        decisionId: "d1",
        planId: "plan-1",
        revision: 1,
        batchId: "b1",
        kind: "approve",
        actor: "eric@litman.org",
        optionMarker: "[opt-1]",
        createdAt: "2026-06-18T00:00:30.000Z",
        note: null,
      };
      const first = await recordPlanDecision(root, decision);
      const replay = await recordPlanDecision(root, decision);
      expect(first.recorded).toBe(true);
      expect(replay.recorded).toBe(false);
      expect((await listHonoredDecisions(root)).length).toBe(1);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("projects the last-WRITTEN revision by sequence, not the largest revision id", async () => {
    const root = tmpRoot();
    try {
      // rev id 3 written first (sequence 1), rev id 2 written second (seq 2).
      const mkRevision = (revision: number, identifier: string) => ({
        revision,
        planId: "plan-1",
        contentHash: `h${revision}`,
        supersedes: null,
        createdAt: "2026-06-18T00:00:00.000Z",
        envelope: ENVELOPE,
        batches: [lookahead(`b${revision}`, identifier)],
        dependencyEdges: [],
        options: [],
        rationale: "r",
        source: "planner" as const,
      });
      await appendStandingPlanJournalEntriesWithLock(root, [
        {
          kind: "plan_revision",
          idempotencyKey: "plan-1:rev:3",
          timestamp: "2026-06-18T00:00:00.000Z",
          planId: "plan-1",
          revision: mkRevision(3, "SYMPH-3"),
        },
        {
          kind: "plan_revision",
          idempotencyKey: "plan-1:rev:2",
          timestamp: "2026-06-18T00:01:00.000Z",
          planId: "plan-1",
          revision: mkRevision(2, "SYMPH-2"),
        },
      ]);
      // The last-written (sequence 2 → revision id 2) is current, not rev id 3.
      expect((await loadStandingPlan(root))?.revision).toBe(2);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("recordPlanControlDecision resolves planId and records an approval (SYMPH-789)", async () => {
    const root = tmpRoot();
    try {
      await recordPlanRevision(root, body([lookahead("b1", "SYMPH-1")]), {
        planId: "plan-1",
        createdAt: "2026-06-18T00:00:00.000Z",
      });
      const result = await recordPlanControlDecision(root, {
        kind: "approve",
        revision: 1,
        batchId: "b1",
        actor: "operator@pro14",
        note: "release it",
        decisionId: "release_batch:b1:rev1:operator@pro14",
        createdAt: "2026-06-18T00:00:30.000Z",
      });
      expect(result.recorded).toBe(true);
      const honored = await listHonoredDecisions(root);
      expect(honored[0]?.kind).toBe("approve");
      expect(honored[0]?.planId).toBe("plan-1");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("recordPlanControlDecision rejects a stale-revision action and reports no_plan", async () => {
    const root = tmpRoot();
    try {
      // no plan yet → no_plan
      const noPlan = await recordPlanControlDecision(root, {
        kind: "approve",
        revision: 1,
        batchId: "b1",
        actor: "operator@pro14",
        note: "x",
        decisionId: "d0",
        createdAt: "2026-06-18T00:00:00.000Z",
      });
      expect(noPlan.reason).toBe("no_plan");

      await recordPlanRevision(root, body([lookahead("b1", "SYMPH-1")]), {
        planId: "plan-1",
        createdAt: "2026-06-18T00:00:00.000Z",
      });
      await recordPlanRevision(root, body([lookahead("b2", "SYMPH-2")]), {
        createdAt: "2026-06-18T00:01:00.000Z",
      });
      const stale = await recordPlanControlDecision(root, {
        kind: "approve",
        revision: 1, // superseded by rev 2
        batchId: "b1",
        actor: "operator@pro14",
        note: "x",
        decisionId: "d-stale",
        createdAt: "2026-06-18T00:02:00.000Z",
      });
      expect(stale.recorded).toBe(false);
      expect(stale.reason).toBe("stale_revision");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("recordPlanControlDecision rejects an unknown batchId (no false-positive control state)", async () => {
    const root = tmpRoot();
    try {
      await recordPlanRevision(root, body([lookahead("b1", "SYMPH-1")]), {
        planId: "plan-1",
        createdAt: "2026-06-18T00:00:00.000Z",
      });
      const result = await recordPlanControlDecision(root, {
        kind: "approve",
        revision: 1,
        batchId: "does-not-exist",
        actor: "operator@pro14",
        note: "x",
        decisionId: "d-ghost",
        createdAt: "2026-06-18T00:00:30.000Z",
      });
      expect(result.recorded).toBe(false);
      expect(result.reason).toBe("batch_not_found");
      expect((await listHonoredDecisions(root)).length).toBe(0);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("recordPlanControlDecision: a stale revision wins over an unknown batchId (precedence)", async () => {
    const root = tmpRoot();
    try {
      await recordPlanRevision(root, body([lookahead("b1", "SYMPH-1")]), {
        planId: "plan-1",
        createdAt: "2026-06-18T00:00:00.000Z",
      });
      await recordPlanRevision(root, body([lookahead("b2", "SYMPH-2")]), {
        createdAt: "2026-06-18T00:01:00.000Z",
      });
      // Revision 1 is superseded AND "b1" is not in the current (rev 2) plan;
      // the revision binding must take precedence over batch_not_found.
      const result = await recordPlanControlDecision(root, {
        kind: "approve",
        revision: 1,
        batchId: "b1",
        actor: "operator@pro14",
        note: "x",
        decisionId: "d-stale-unknown",
        createdAt: "2026-06-18T00:02:00.000Z",
      });
      expect(result.reason).toBe("stale_revision");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

// SYMPH-823: the PURE honored-decisions projection over already-read journal
// entries — the sibling of projectStandingPlan. The admission gate projects BOTH
// the plan and the honored decisions from ONE journal snapshot via this helper, so
// a re-plan can never pair plan revision N with decisions honored against N+1.
describe("projectHonoredDecisions (SYMPH-823 pure projection)", () => {
  it("returns [] for an empty journal (no plan)", () => {
    expect(projectHonoredDecisions([])).toEqual([]);
  });

  it("projects the current-revision honored decisions from one snapshot, matching the disk-reading listHonoredDecisions", async () => {
    const root = tmpRoot();
    try {
      await recordPlanRevision(root, body([lookahead("b1", "SYMPH-1")]), {
        planId: "plan-1",
        createdAt: "2026-06-18T00:00:00.000Z",
      });
      await recordPlanControlDecision(root, {
        kind: "approve",
        revision: 1,
        batchId: "b1",
        actor: "operator@pro14",
        note: null,
        decisionId: "d1",
        createdAt: "2026-06-18T00:00:30.000Z",
      });
      const journal = await readStandingPlanJournal(root);
      const honored = projectHonoredDecisions(journal);
      expect(honored.map((decision) => decision.batchId)).toEqual(["b1"]);
      // The pure projection is the exact in-memory equivalent of the disk-reading
      // store function — listHonoredDecisions now delegates to it.
      expect(honored).toEqual(await listHonoredDecisions(root));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("voids a superseded-revision approval after a rotation — honors the CURRENT revision only", async () => {
    const root = tmpRoot();
    try {
      await recordPlanRevision(root, body([lookahead("b1", "SYMPH-1")]), {
        planId: "plan-1",
        createdAt: "2026-06-18T00:00:00.000Z",
      });
      await recordPlanControlDecision(root, {
        kind: "approve",
        revision: 1,
        batchId: "b1",
        actor: "operator@pro14",
        note: null,
        decisionId: "d1",
        createdAt: "2026-06-18T00:00:30.000Z",
      });
      // A re-plan rotates to revision 2; the operator approves a revision-2 batch.
      await recordPlanRevision(root, body([lookahead("b2", "SYMPH-2")]), {
        createdAt: "2026-06-18T00:01:00.000Z",
      });
      await recordPlanControlDecision(root, {
        kind: "approve",
        revision: 2,
        batchId: "b2",
        actor: "operator@pro14",
        note: null,
        decisionId: "d2",
        createdAt: "2026-06-18T00:01:30.000Z",
      });
      const journal = await readStandingPlanJournal(root);
      const honored = projectHonoredDecisions(journal);
      // Only the revision-2 approval survives; the revision-1 approval is voided.
      expect(honored.map((decision) => decision.batchId)).toEqual(["b2"]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
