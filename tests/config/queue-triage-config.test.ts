import { describe, expect, it } from "vitest";

import { resolveWorkflowConfig } from "../../src/config/config-resolver.js";
import {
  DEFAULT_QUEUE_TRIAGE_ENABLED,
  DEFAULT_QUEUE_TRIAGE_HEARTBEAT_MS,
  DEFAULT_QUEUE_TRIAGE_PLANNER_EFFORT,
  DEFAULT_QUEUE_TRIAGE_PLANNER_MODEL,
  DEFAULT_QUEUE_TRIAGE_PLAN_REVIEW_ENABLED,
  DEFAULT_QUEUE_TRIAGE_PLAN_REVIEW_PLANNER_GROUNDING_ENABLED,
  DEFAULT_QUEUE_TRIAGE_SHADOW_MODE,
  DEFAULT_QUEUE_TRIAGE_STRUCTURAL_ADVISORIES,
  DEFAULT_QUEUE_TRIAGE_STRUCTURAL_ADVISORY_DORMANT_OK_TICKS,
  DEFAULT_QUEUE_TRIAGE_STRUCTURAL_ADVISORY_RENDER_CAP,
} from "../../src/config/defaults.js";

describe("config-resolver queue triage (SYMPH-784)", () => {
  it("defaults to disabled, shadow-on, opus planner, with an envelope derived from concurrency", () => {
    const resolved = resolveWorkflowConfig({
      workflowPath: "/repo/WORKFLOW.md",
      config: { agent: { max_concurrent_agents: 4 } },
      promptTemplate: "Prompt",
    });

    expect(resolved.queueTriage?.enabled).toBe(DEFAULT_QUEUE_TRIAGE_ENABLED);
    expect(resolved.queueTriage?.enabled).toBe(false);
    expect(resolved.queueTriage?.shadowMode).toBe(
      DEFAULT_QUEUE_TRIAGE_SHADOW_MODE,
    );
    expect(resolved.queueTriage?.plannerModel).toBe(
      DEFAULT_QUEUE_TRIAGE_PLANNER_MODEL,
    );
    // An absent key is explicitly pinned to max, never inherited from a lane.
    expect(resolved.queueTriage?.plannerEffort).toBe(
      DEFAULT_QUEUE_TRIAGE_PLANNER_EFFORT,
    );
    expect(resolved.queueTriage?.heartbeatMs).toBe(
      DEFAULT_QUEUE_TRIAGE_HEARTBEAT_MS,
    );
    expect(resolved.queueTriage).toMatchObject({
      structuralAdvisories: DEFAULT_QUEUE_TRIAGE_STRUCTURAL_ADVISORIES,
      structuralAdvisoryDormantOkTicks:
        DEFAULT_QUEUE_TRIAGE_STRUCTURAL_ADVISORY_DORMANT_OK_TICKS,
      structuralAdvisoryRenderCap:
        DEFAULT_QUEUE_TRIAGE_STRUCTURAL_ADVISORY_RENDER_CAP,
    });
    // concurrency ceiling defaults to the agent concurrency.
    expect(resolved.queueTriage?.envelope.concurrencyCeiling).toBe(4);
    // parallel-isolated + canary-chain by default (canary's execution path
    // shipped in SYMPH-800); shared-surface still gated until its path ships.
    expect(resolved.queueTriage?.envelope.allowedModes).toEqual([
      "parallel-isolated",
      "canary-chain",
    ]);
    expect(resolved.queueTriage?.envelope.version).toBe(1);
    expect(resolved.queueTriage?.autoReleaseFrontier).toBe(1);
    // control doc surface off by default (needs a team id + live verification).
    expect(resolved.queueTriage?.controlDoc).toEqual({
      enabled: false,
      teamId: null,
    });
    // admission guardrail (SYMPH-794) off by default — a bare project field keeps
    // admitting until an operator opts into explicit-signal-only dispatch.
    expect(resolved.queueTriage?.admissionGuardrail).toEqual({
      enabled: false,
    });
    // comment enrichment (SYMPH-896) off by default — the N+1 comment fetch is an
    // unmeasured cost surface; an operator opts in once the measurement is trusted.
    expect(resolved.queueTriage?.commentEnrichment).toEqual({
      enabled: false,
      maxCandidates: 25,
      maxCommentPages: 3,
      maxComments: 6,
      maxCommentChars: 25_000,
      maxTotalChars: 25_000,
    });
    expect(resolved.queueTriage?.planReview).toEqual({
      enabled: DEFAULT_QUEUE_TRIAGE_PLAN_REVIEW_ENABLED,
      plannerGroundingEnabled:
        DEFAULT_QUEUE_TRIAGE_PLAN_REVIEW_PLANNER_GROUNDING_ENABLED,
    });
  });

  it("parses the structural-advisory arming key and lifecycle bounds", () => {
    const resolved = resolveWorkflowConfig({
      workflowPath: "/repo/WORKFLOW.md",
      config: {
        queue_triage: {
          structural_advisories: true,
          structural_advisory_dormant_ok_ticks: 5,
          structural_advisory_render_cap: 7,
        },
      },
      promptTemplate: "Prompt",
    });
    expect(resolved.queueTriage).toMatchObject({
      structuralAdvisories: true,
      structuralAdvisoryDormantOkTicks: 5,
      structuralAdvisoryRenderCap: 7,
    });
  });

  it("honors explicit comment_enrichment overrides (SYMPH-896)", () => {
    const resolved = resolveWorkflowConfig({
      workflowPath: "/repo/WORKFLOW.md",
      config: {
        queue_triage: {
          enabled: true,
          comment_enrichment: {
            enabled: true,
            max_candidates: 10,
            max_comment_pages: 2,
            max_comments: 4,
            max_comment_chars: 200,
            max_total_chars: 600,
          },
        },
      },
      promptTemplate: "Prompt",
    });

    expect(resolved.queueTriage?.commentEnrichment).toEqual({
      enabled: true,
      maxCandidates: 10,
      maxCommentPages: 2,
      maxComments: 4,
      maxCommentChars: 200,
      maxTotalChars: 600,
    });
  });

  it("honors explicit plan_review overrides (SYMPH-1066)", () => {
    const resolved = resolveWorkflowConfig({
      workflowPath: "/repo/WORKFLOW.md",
      config: {
        queue_triage: {
          enabled: true,
          plan_review: {
            enabled: true,
            planner_grounding_enabled: true,
          },
        },
      },
      promptTemplate: "Prompt",
    });

    expect(resolved.queueTriage?.planReview).toEqual({
      enabled: true,
      plannerGroundingEnabled: true,
    });
  });

  it("falls back to plan_review defaults for malformed values (SYMPH-1066)", () => {
    const resolved = resolveWorkflowConfig({
      workflowPath: "/repo/WORKFLOW.md",
      config: {
        queue_triage: {
          enabled: true,
          plan_review: {
            enabled: "yes",
            planner_grounding_enabled: "yes",
          },
        },
      },
      promptTemplate: "Prompt",
    });

    expect(resolved.queueTriage?.planReview).toEqual({
      enabled: false,
      plannerGroundingEnabled: false,
    });
  });

  it("honors an explicit admission_guardrail.enabled override (SYMPH-794)", () => {
    const resolved = resolveWorkflowConfig({
      workflowPath: "/repo/WORKFLOW.md",
      config: {
        queue_triage: {
          enabled: true,
          admission_guardrail: { enabled: true },
        },
      },
      promptTemplate: "Prompt",
    });

    expect(resolved.queueTriage?.admissionGuardrail.enabled).toBe(true);
  });

  it("honors explicit queue_triage overrides", () => {
    const resolved = resolveWorkflowConfig({
      workflowPath: "/repo/WORKFLOW.md",
      config: {
        queue_triage: {
          enabled: true,
          shadow_mode: false,
          planner_model: "opus-custom",
          planner_effort: "high",
          heartbeat_ms: 120_000,
          envelope: {
            version: 3,
            concurrency_ceiling: 6,
            allowed_risk: "high",
            allowed_modes: ["parallel-isolated"],
          },
        },
      },
      promptTemplate: "Prompt",
    });

    expect(resolved.queueTriage?.enabled).toBe(true);
    expect(resolved.queueTriage?.shadowMode).toBe(false);
    expect(resolved.queueTriage?.plannerModel).toBe("opus-custom");
    expect(resolved.queueTriage?.plannerEffort).toBe("high");
    expect(resolved.queueTriage?.heartbeatMs).toBe(120_000);
    expect(resolved.queueTriage?.envelope).toEqual({
      version: 3,
      concurrencyCeiling: 6,
      allowedRisk: "high",
      allowedModes: ["parallel-isolated"],
    });
  });

  it("throws on a malformed envelope rather than silently widening authority", () => {
    expect(() =>
      resolveWorkflowConfig({
        workflowPath: "/repo/WORKFLOW.md",
        config: {
          queue_triage: {
            enabled: true,
            envelope: { allowed_modes: ["bogus-mode"] },
          },
        },
        promptTemplate: "Prompt",
      }),
    ).toThrow(/unknown batch mode/);
  });
});
