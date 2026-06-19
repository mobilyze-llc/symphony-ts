import { describe, expect, it } from "vitest";

import { resolveWorkflowConfig } from "../../src/config/config-resolver.js";
import {
  DEFAULT_QUEUE_TRIAGE_ENABLED,
  DEFAULT_QUEUE_TRIAGE_HEARTBEAT_MS,
  DEFAULT_QUEUE_TRIAGE_PLANNER_MODEL,
  DEFAULT_QUEUE_TRIAGE_SHADOW_MODE,
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
    expect(resolved.queueTriage?.heartbeatMs).toBe(
      DEFAULT_QUEUE_TRIAGE_HEARTBEAT_MS,
    );
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
