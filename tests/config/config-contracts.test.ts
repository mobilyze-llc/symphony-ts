import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { checkConfigContracts } from "../../src/config/config-contracts.js";
import {
  resolveWorkflowConfig,
  validateDispatchConfig,
} from "../../src/config/config-resolver.js";
import { loadWorkflowDefinition } from "../../src/config/workflow-loader.js";
import { ERROR_CODES } from "../../src/errors/codes.js";

function resolveConfig(config: Record<string, unknown>) {
  return resolveWorkflowConfig({
    workflowPath: "/repo/WORKFLOW.md",
    promptTemplate: "Prompt",
    config: {
      tracker: {
        api_key: "token",
        project_slug: "proj",
        ...(config.tracker as Record<string, unknown> | undefined),
      },
      ...config,
    },
  });
}

function stagedConfig(overrides: Record<string, unknown> = {}) {
  return resolveConfig({
    tracker: {
      api_key: "token",
      project_slug: "proj",
      active_states: ["Todo", "In Progress", "Resume"],
    },
    stages: {
      work: {
        type: "agent",
        linear_state: "In Progress",
        on_complete: "done",
      },
      done: { type: "terminal" },
    },
    ...overrides,
  });
}

describe("config-contracts", () => {
  it("fails dispatch validation when a stage writes a state missing from active_states", () => {
    const resolved = stagedConfig({
      tracker: {
        api_key: "token",
        project_slug: "proj",
        active_states: ["Todo", "Resume"],
      },
    });

    const validation = validateDispatchConfig(resolved);
    expect(validation.ok).toBe(false);
    if (validation.ok) {
      throw new Error("expected contract violation");
    }
    expect(validation.error.code).toBe(ERROR_CODES.configContractViolation);
    // The message names the declared key, the consumed value, and the writer.
    expect(validation.error.message).toContain("tracker.active_states");
    expect(validation.error.message).toContain("'In Progress'");
    expect(validation.error.message).toContain("stages.work.linear_state");
  });

  it("fails dispatch validation when 'Resume' is missing from active_states on a staged pipeline", () => {
    const resolved = stagedConfig({
      tracker: {
        api_key: "token",
        project_slug: "proj",
        active_states: ["Todo", "In Progress"],
      },
    });

    const validation = validateDispatchConfig(resolved);
    expect(validation.ok).toBe(false);
    if (validation.ok) {
      throw new Error("expected contract violation");
    }
    expect(validation.error.code).toBe(ERROR_CODES.configContractViolation);
    expect(validation.error.message).toContain("'Resume'");
    expect(validation.error.message).toContain("tracker.active_states");
  });

  it("compares states case-insensitively (normalizeIssueState semantics)", () => {
    const resolved = stagedConfig({
      tracker: {
        api_key: "token",
        project_slug: "proj",
        active_states: ["Todo", "in progress", "RESUME"],
      },
    });

    expect(validateDispatchConfig(resolved)).toEqual({ ok: true });
  });

  it("fails dispatch validation when escalation_state is listed in active_states", () => {
    const resolved = stagedConfig({
      tracker: {
        api_key: "token",
        project_slug: "proj",
        active_states: ["Todo", "In Progress", "Resume", "Blocked"],
      },
      escalation_state: "Blocked",
    });

    const validation = validateDispatchConfig(resolved);
    expect(validation.ok).toBe(false);
    if (validation.ok) {
      throw new Error("expected contract violation");
    }
    expect(validation.error.code).toBe(ERROR_CODES.configContractViolation);
    expect(validation.error.message).toContain("escalation_state");
    expect(validation.error.message).toContain("'Blocked'");
    expect(validation.error.message).toContain("tracker.active_states");
  });

  it("allows escalation_state outside active_states", () => {
    const resolved = stagedConfig({ escalation_state: "Blocked" });

    expect(validateDispatchConfig(resolved)).toEqual({ ok: true });
  });

  it("fails dispatch validation when a stage transition targets an undefined stage", () => {
    const resolved = stagedConfig({
      stages: {
        work: {
          type: "agent",
          linear_state: "In Progress",
          on_complete: "missing-stage",
        },
        done: { type: "terminal" },
      },
    });

    const validation = validateDispatchConfig(resolved);
    expect(validation.ok).toBe(false);
    if (validation.ok) {
      throw new Error("expected contract violation");
    }
    expect(validation.error.code).toBe(ERROR_CODES.configContractViolation);
    expect(validation.error.message).toContain("missing-stage");
  });

  it("reports no contract violations for a stage-less config", () => {
    const resolved = resolveConfig({});

    expect(checkConfigContracts(resolved)).toEqual([]);
    expect(validateDispatchConfig(resolved)).toEqual({ ok: true });
  });

  it("contracts.override suppresses failures but carries the suppressed violation list", () => {
    const resolved = stagedConfig({
      tracker: {
        api_key: "token",
        project_slug: "proj",
        active_states: ["Todo"],
      },
      contracts: { override: true },
    });

    const validation = validateDispatchConfig(resolved);
    expect(validation.ok).toBe(true);
    if (!validation.ok) {
      throw new Error("expected override to suppress the failure");
    }
    const suppressed = validation.suppressedContractViolations ?? [];
    expect(suppressed.length).toBe(2);
    const values = suppressed.map((violation) => violation.value).sort();
    expect(values).toEqual(["In Progress", "Resume"]);
    for (const violation of suppressed) {
      expect(violation.key).toBe("tracker.active_states");
      expect(violation.rule).toBe("active_states_cover_consumed_states");
    }
  });

  it("override on a clean config yields a plain ok result (no suppressed list)", () => {
    const resolved = stagedConfig({ contracts: { override: true } });

    expect(validateDispatchConfig(resolved)).toEqual({ ok: true });
  });

  it("shipped WORKFLOW-symphony.md passes the contract checker on its owner host", async () => {
    const workflowPath = join(
      process.cwd(),
      "pipeline-config",
      "workflows",
      "WORKFLOW-symphony.md",
    );
    const definition = await loadWorkflowDefinition(workflowPath);
    const resolved = resolveWorkflowConfig(definition, {
      LINEAR_API_KEY: "test-token",
    });

    expect(checkConfigContracts(resolved)).toEqual([]);
    expect(validateDispatchConfig(resolved, { hostname: "pro14" })).toEqual({
      ok: true,
    });
  });

  it("shipped WORKFLOW-symphony.md grants the actuator auto-merge permission (SYMPH-754)", async () => {
    // Deploy-safety guard: the symphony actuator is enabled and its whole purpose
    // is to auto-merge. Since the permission defaults CLOSED, the WORKFLOW must
    // grant it explicitly — otherwise every symphony PR would park as
    // auto_merge_permission_denied instead of merging.
    const workflowPath = join(
      process.cwd(),
      "pipeline-config",
      "workflows",
      "WORKFLOW-symphony.md",
    );
    const definition = await loadWorkflowDefinition(workflowPath);
    const resolved = resolveWorkflowConfig(definition, {
      LINEAR_API_KEY: "test-token",
    });

    expect(resolved.mergeActuator?.enabled).toBe(true);
    expect(resolved.mergeActuator?.autoMerge).toBe(true);
  });
});
