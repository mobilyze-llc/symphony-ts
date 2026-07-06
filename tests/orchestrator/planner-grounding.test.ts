import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import type { PlannerContext } from "../../src/agent/triage-planner.js";
import type { Issue } from "../../src/domain/model.js";
import type { PlanEnvelope } from "../../src/domain/standing-plan.js";
import { GROUNDING_EXTRACTOR_ROUTE } from "../../src/orchestrator/grounding-extractor.js";
import type { ExtractGroundingInput } from "../../src/orchestrator/grounding-extractor.js";
import {
  PLANNER_GROUNDING_REPO_URL_FALLBACK_ENV,
  buildPlannerCodeGroundingInput,
  buildShadowGroundingDep,
  groundPlannerContext,
} from "../../src/orchestrator/planner-grounding.js";

const envelope: PlanEnvelope = {
  version: 1,
  concurrencyCeiling: 3,
  allowedRisk: "medium",
  allowedModes: ["parallel-isolated", "canary-chain"],
};

describe("planner grounding", () => {
  const target = {
    repoUrl: "file:///repo",
    commitSha: "abc123",
    repoScope: "symphony" as const,
  };

  it("returns null when the planner grounding flag is absent or disabled", () => {
    expect(
      buildPlannerCodeGroundingInput({
        workflowConfig: {
          workspace: { root: "/workspace" },
          codeGrounding: codeGroundingConfig(true),
        },
        runId: "run-1",
        target,
      }),
    ).toBeNull();
  });

  it("returns null when core code grounding is disabled", () => {
    expect(
      buildPlannerCodeGroundingInput({
        workflowConfig: {
          workspace: { root: "/workspace" },
          plannerGrounding: { enabled: true },
          codeGrounding: codeGroundingConfig(false),
        },
        runId: "run-1",
        target,
      }),
    ).toBeNull();
  });

  it("builds input when planner and core code grounding are enabled", () => {
    const input = buildPlannerCodeGroundingInput({
      workflowConfig: {
        workspace: { root: "/workspace" },
        plannerGrounding: { enabled: true },
        codeGrounding: codeGroundingConfig(true),
      },
      runId: "run-1",
      target,
    });

    expect(input).toMatchObject({
      workspaceRoot: "/workspace",
      runId: "run-1",
      target,
      config: { enabled: true },
    });
  });

  describe("buildShadowGroundingDep", () => {
    it("returns an empty dep when planner grounding is absent or disabled", () => {
      expect(
        buildShadowGroundingDep({
          workflowConfig: {},
          env: {
            [PLANNER_GROUNDING_REPO_URL_FALLBACK_ENV]:
              "https://github.com/mobilyze-llc/symphony-ts.git",
          },
          workspaceRoot: "/workspace",
          checkoutRoot: "/checkout",
        }),
      ).not.toHaveProperty("groundPlannerContext");
      expect(
        buildShadowGroundingDep({
          workflowConfig: { plannerGrounding: { enabled: false } },
          env: {
            [PLANNER_GROUNDING_REPO_URL_FALLBACK_ENV]:
              "https://github.com/mobilyze-llc/symphony-ts.git",
          },
          workspaceRoot: "/workspace",
          checkoutRoot: "/checkout",
        }),
      ).not.toHaveProperty("groundPlannerContext");
    });

    it("wires grounding from a Symphony REPO_URL even when core code grounding is absent", () => {
      const dep = buildShadowGroundingDep({
        workflowConfig: {
          plannerGrounding: { enabled: true },
        },
        env: {
          [PLANNER_GROUNDING_REPO_URL_FALLBACK_ENV]:
            "https://github.com/mobilyze-llc/symphony-ts.git",
        },
        workspaceRoot: "/workspace",
        checkoutRoot: "/checkout",
      });

      expect(dep).toHaveProperty("groundPlannerContext");
    });

    it("does not let disabled core code grounding suppress the shadow dep", () => {
      const workflowConfig = {
        plannerGrounding: { enabled: true },
        codeGrounding: codeGroundingConfig(false),
      };
      const dep = buildShadowGroundingDep({
        workflowConfig,
        env: {
          [PLANNER_GROUNDING_REPO_URL_FALLBACK_ENV]:
            "https://github.com/mobilyze-llc/symphony-ts.git",
        },
        workspaceRoot: "/workspace",
        checkoutRoot: "/checkout",
      });

      expect(dep).toHaveProperty("groundPlannerContext");
    });

    it("skips non-Symphony and unset REPO_URL without constructing a dep", () => {
      const dep = buildShadowGroundingDep({
        workflowConfig: {
          plannerGrounding: { enabled: true },
        },
        env: {
          [PLANNER_GROUNDING_REPO_URL_FALLBACK_ENV]:
            "https://github.com/example/product.git",
        },
        workspaceRoot: "/workspace",
        checkoutRoot: "/checkout",
      });
      const unset = buildShadowGroundingDep({
        workflowConfig: {
          plannerGrounding: { enabled: true },
        },
        env: {},
        workspaceRoot: "/workspace",
        checkoutRoot: "/checkout",
      });

      expect(dep).not.toHaveProperty("groundPlannerContext");
      expect(unset).not.toHaveProperty("groundPlannerContext");
    });
  });

  it("grounds matching backlog candidates and preserves unmatched candidates", async () => {
    const checkoutRoot = await mkdtemp(join(tmpdir(), "planner-grounding-"));
    try {
      await mkdir(join(checkoutRoot, "docs"));
      await writeFile(
        join(checkoutRoot, "docs", "grounding.md"),
        "The standing-plan tick should reuse the planner grounding helper.",
      );
      const calls: ExtractGroundingInput[] = [];
      const context = plannerContext();
      const result = await groundPlannerContext({
        context,
        candidates: [
          issue({
            id: "issue-1",
            identifier: "SYMPH-1",
            documentAttachments: [
              {
                title: "Linear design",
                url: "https://linear.app/doc/planner-grounding-doc-1",
                documentId: "doc-1",
              },
            ],
          }),
        ],
        env: {},
        now: steppedNow(
          "2026-07-06T12:00:00.000Z",
          "2026-07-06T12:00:00.050Z",
          "2026-07-06T12:00:00.125Z",
        ),
        repoUrl: "file:///repo",
        commitSha: "abc123",
        repoScope: "symphony",
        workspaceRoot: "/workspace",
        checkoutRoot,
        runIdPrefix: "test-shadow",
        target,
        readLinearDocument: async (documentId) =>
          documentId === "doc-1"
            ? "Linear document content for planner grounding."
            : null,
        extractGroundingEvidence: async (input) => {
          calls.push(input);
          return groundingExtractionResult();
        },
      });

      expect(calls).toHaveLength(1);
      expect(calls[0]?.candidateId).toBe("issue-1");
      expect(calls[0]?.candidateIdentifier).toBe("SYMPH-1");
      expect(calls[0]?.grounding?.workspaceRoot).toBe("/workspace");
      expect(calls[0]?.grounding?.runId).toMatch(/^test-shadow-/);
      expect(calls[0]?.grounding?.target).toEqual(target);
      expect(calls[0]?.sources.map((source) => source.id)).toEqual([
        "title",
        "body",
        "comment:comment-1",
        "document:filesystem:docs/grounding.md",
        "document:linear:doc-1",
      ]);
      expect(calls[0]?.sources.map((source) => source.kind)).toEqual([
        "ticket_title",
        "ticket_body",
        "comment",
        "document",
        "document",
      ]);

      expect(result.context.backlog[0]?.groundingEvidence).toMatchObject({
        status: "grounded",
        reason: null,
        extractorCallCount: 2,
        wallClockMs: 125,
        digest: {
          text: "Grounded digest",
          status: "unverified",
          truncated: false,
        },
        claims: [
          {
            id: "claim-1",
            status: "verified",
            citations: [
              {
                path: "src/orchestrator/standing-plan-shadow.ts",
                lineRange: [10, 12],
                matchedSpan: "runStandingPlanShadowTick",
              },
            ],
          },
        ],
        units: [
          {
            unitId: "U1",
            completionState: "verified_presence",
          },
        ],
        warnings: ["extractor warning", "grounding report warning"],
      });
      expect(result.context.backlog[1]?.groundingEvidence).toBeUndefined();
      expect(context.backlog[0]?.groundingEvidence).toBeUndefined();
    } finally {
      await rm(checkoutRoot, { recursive: true, force: true });
    }
  });
});

function codeGroundingConfig(enabled: boolean) {
  return {
    enabled,
    baseDir: ".grounding",
    ttlMs: 1000,
    maxCheckoutsPerRepo: 2,
  };
}

function plannerContext(): PlannerContext {
  return {
    backlog: [
      {
        issueId: "issue-1",
        issueIdentifier: "SYMPH-1",
        title: "Wire planner grounding",
        priority: 1,
        state: "In Progress",
        blockedBy: [],
        description: "Read docs/grounding.md before wiring the tick.",
        labels: ["area:orchestrator"],
        comments: [
          {
            id: "comment-1",
            body: "Use the existing CLI helper and include the Linear doc.",
            createdAt: "2026-07-06T00:00:00.000Z",
            authorClass: "operator",
            relevanceScore: 0.9,
            relevanceRationale: "cites implementation guidance",
          },
        ],
      },
      {
        issueId: "missing-issue",
        issueIdentifier: "SYMPH-404",
        title: "Missing from candidate list",
        priority: null,
        state: "Triage",
        blockedBy: [],
      },
    ],
    openPrs: [],
    recentlyMerged: [],
    inFlight: [],
    envelope,
  };
}

function issue(input: {
  id: string;
  identifier: string;
  documentAttachments?: Issue["documentAttachments"];
}): Issue {
  return {
    id: input.id,
    identifier: input.identifier,
    title: "Wire planner grounding",
    description: "Issue body",
    priority: 1,
    state: "In Progress",
    branchName: null,
    url: null,
    labels: [],
    ...(input.documentAttachments === undefined
      ? {}
      : { documentAttachments: input.documentAttachments }),
    blockedBy: [],
    createdAt: "2026-07-06T00:00:00.000Z",
    updatedAt: "2026-07-06T00:00:00.000Z",
  };
}

function steppedNow(...timestamps: string[]): () => Date {
  if (timestamps.length === 0) {
    throw new Error("steppedNow requires at least one timestamp");
  }
  let index = 0;
  return () => {
    const timestamp = timestamps[
      Math.min(index, timestamps.length - 1)
    ] as string;
    index += 1;
    return new Date(timestamp);
  };
}

function groundingExtractionResult() {
  return {
    route: GROUNDING_EXTRACTOR_ROUTE,
    digest: {
      text: "Grounded digest",
      charLimit: 2_000,
      truncated: false,
      status: "unverified" as const,
    },
    claims: [
      {
        id: "claim-1",
        sourceId: "body",
        kind: "behavioral" as const,
        text: "The standing-plan shadow tick grounds candidates.",
        summary: "Grounding is wired into the tick",
        status: "verified" as const,
        citations: [
          {
            checkoutId: "checkout-1",
            commitSha: "abc123",
            path: "src/orchestrator/standing-plan-shadow.ts",
            lineRange: [10, 12] as [number, number],
            contentHash: "hash",
            matchedSpan: "runStandingPlanShadowTick",
          },
        ],
        missing: [],
      },
    ],
    units: [
      {
        unitId: "U1",
        title: "Ground candidates",
        wave: "U1",
        claimIds: ["claim-1"],
        completionState: "verified_presence" as const,
        alreadyDone: false as const,
        rationale: "Evidence is present",
      },
    ],
    groundingReport: {
      generatedAt: "2026-07-06T00:00:00.000Z",
      status: "verified" as const,
      checkout: {
        checkoutId: "checkout-1",
        path: "/tmp/checkout-1",
        commitSha: "abc123",
        repoUrl: "file:///repo",
      },
      entries: [],
      cleanup: {
        leaseReleased: true,
        checkoutPurged: false,
        dirtyState: null,
      },
      warnings: ["grounding report warning"],
    },
    extractorCallCount: 2,
    warnings: ["extractor warning"],
  };
}
