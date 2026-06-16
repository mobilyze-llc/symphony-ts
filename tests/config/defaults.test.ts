import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import {
  DEFAULT_ACTIVE_STATES,
  DEFAULT_CODEX_COMMAND,
  DEFAULT_CODEX_DISABLE_SKILLS,
  DEFAULT_CODEX_EPHEMERAL_HOME,
  DEFAULT_CODEX_MAX_HEALTHY_COMPACTIONS_PER_STAGE,
  DEFAULT_CODEX_MODEL_AUTO_COMPACT_TOKEN_LIMIT,
  DEFAULT_CODEX_TOOL_OUTPUT_TOKEN_LIMIT,
  DEFAULT_HOOK_TIMEOUT_MS,
  DEFAULT_MAX_CONCURRENT_AGENTS,
  DEFAULT_MAX_RETRY_BACKOFF_MS,
  DEFAULT_MAX_TURNS,
  DEFAULT_MERGE_ACTUATOR_MAX_PENDING_CHECKS_WAIT_OBSERVATIONS,
  DEFAULT_MERGE_ACTUATOR_MAX_UNKNOWN_MERGEABILITY_WAIT_OBSERVATIONS,
  DEFAULT_OBSERVABILITY_ENABLED,
  DEFAULT_OBSERVABILITY_REFRESH_MS,
  DEFAULT_OBSERVABILITY_RENDER_INTERVAL_MS,
  DEFAULT_POLL_INTERVAL_MS,
  DEFAULT_READ_TIMEOUT_MS,
  DEFAULT_RISK_PREDICATE_REASONING_EFFORT,
  DEFAULT_STALL_TIMEOUT_MS,
  DEFAULT_TURN_TIMEOUT_MS,
  DEFAULT_WORKSPACE_ROOT,
  SPEC_DEFAULTS,
  WORKFLOW_FILENAME,
} from "../../src/config/defaults.js";

describe("SPEC_DEFAULTS", () => {
  it("matches the required spec baseline values", () => {
    expect(DEFAULT_POLL_INTERVAL_MS).toBe(30_000);
    expect(DEFAULT_HOOK_TIMEOUT_MS).toBe(60_000);
    expect(DEFAULT_MAX_CONCURRENT_AGENTS).toBe(10);
    expect(DEFAULT_MAX_TURNS).toBe(20);
    expect(DEFAULT_MAX_RETRY_BACKOFF_MS).toBe(300_000);
    expect(DEFAULT_TURN_TIMEOUT_MS).toBe(3_600_000);
    expect(DEFAULT_READ_TIMEOUT_MS).toBe(5_000);
    expect(DEFAULT_STALL_TIMEOUT_MS).toBe(300_000);
    expect(DEFAULT_OBSERVABILITY_ENABLED).toBe(true);
    expect(DEFAULT_OBSERVABILITY_REFRESH_MS).toBe(1_000);
    expect(DEFAULT_OBSERVABILITY_RENDER_INTERVAL_MS).toBe(16);
    expect(DEFAULT_CODEX_COMMAND).toBe("codex app-server");
    expect(DEFAULT_CODEX_EPHEMERAL_HOME).toBe(false);
    expect(DEFAULT_CODEX_DISABLE_SKILLS).toBe(false);
    expect(DEFAULT_CODEX_TOOL_OUTPUT_TOKEN_LIMIT).toBe(2_500);
    expect(DEFAULT_CODEX_MODEL_AUTO_COMPACT_TOKEN_LIMIT).toBe(40_000);
    expect(DEFAULT_CODEX_MAX_HEALTHY_COMPACTIONS_PER_STAGE).toBe(3);
    expect(DEFAULT_RISK_PREDICATE_REASONING_EFFORT).toBeNull();
    expect(DEFAULT_ACTIVE_STATES).toEqual([
      "Todo",
      "In Progress",
      "In Review",
      "Resume",
    ]);
  });

  it("uses the expected workflow and workspace defaults", () => {
    expect(WORKFLOW_FILENAME).toBe("WORKFLOW.md");
    expect(DEFAULT_WORKSPACE_ROOT).toBe(join(tmpdir(), "symphony_workspaces"));
    expect(SPEC_DEFAULTS.workspace.root).toBe(DEFAULT_WORKSPACE_ROOT);
  });

  it("keeps the frozen default tree internally consistent", () => {
    expect(SPEC_DEFAULTS.polling.intervalMs).toBe(DEFAULT_POLL_INTERVAL_MS);
    expect(SPEC_DEFAULTS.agent.maxConcurrentAgents).toBe(
      DEFAULT_MAX_CONCURRENT_AGENTS,
    );
    expect(SPEC_DEFAULTS.codex.command).toBe(DEFAULT_CODEX_COMMAND);
    expect(SPEC_DEFAULTS.codex.ephemeralHome).toBe(
      DEFAULT_CODEX_EPHEMERAL_HOME,
    );
    expect(SPEC_DEFAULTS.codex.disableSkills).toBe(
      DEFAULT_CODEX_DISABLE_SKILLS,
    );
    expect(SPEC_DEFAULTS.codex.toolOutputTokenLimit).toBe(
      DEFAULT_CODEX_TOOL_OUTPUT_TOKEN_LIMIT,
    );
    expect(SPEC_DEFAULTS.codex.modelAutoCompactTokenLimit).toBe(
      DEFAULT_CODEX_MODEL_AUTO_COMPACT_TOKEN_LIMIT,
    );
    expect(SPEC_DEFAULTS.codex.maxHealthyCompactionsPerStage).toBe(
      DEFAULT_CODEX_MAX_HEALTHY_COMPACTIONS_PER_STAGE,
    );
    expect(SPEC_DEFAULTS.riskPredicateReasoning.effort).toBe(
      DEFAULT_RISK_PREDICATE_REASONING_EFFORT,
    );
    expect(SPEC_DEFAULTS.tracker.activeStates).toBe(DEFAULT_ACTIVE_STATES);
    expect(SPEC_DEFAULTS.observability.dashboardEnabled).toBe(
      DEFAULT_OBSERVABILITY_ENABLED,
    );
    // The frozen merge-actuator subtree must carry the bounded pre-enqueue wait
    // ceilings (SYMPH-752/755); SPEC_DEFAULTS is Object.freeze with an inferred
    // type, so an omission compiles silently — assert them explicitly here.
    expect(SPEC_DEFAULTS.mergeActuator.maxPendingChecksWaitObservations).toBe(
      DEFAULT_MERGE_ACTUATOR_MAX_PENDING_CHECKS_WAIT_OBSERVATIONS,
    );
    expect(
      SPEC_DEFAULTS.mergeActuator.maxUnknownMergeabilityWaitObservations,
    ).toBe(DEFAULT_MERGE_ACTUATOR_MAX_UNKNOWN_MERGEABILITY_WAIT_OBSERVATIONS);
    expect(Object.isFrozen(SPEC_DEFAULTS)).toBe(true);
  });
});
