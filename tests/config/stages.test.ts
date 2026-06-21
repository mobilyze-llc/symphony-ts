import { describe, expect, it } from "vitest";

import {
  resolveStagesConfig,
  validateStagesConfig,
} from "../../src/config/config-resolver.js";
import type { StagesConfig } from "../../src/config/types.js";

describe("resolveStagesConfig", () => {
  it("returns null when stages is undefined or not an object", () => {
    expect(resolveStagesConfig(undefined)).toBeNull();
    expect(resolveStagesConfig(null)).toBeNull();
    expect(resolveStagesConfig("not-an-object")).toBeNull();
    expect(resolveStagesConfig([])).toBeNull();
  });

  it("returns null when no stage entries have a valid type", () => {
    expect(
      resolveStagesConfig({
        investigate: { type: "invalid" },
        implement: {},
      }),
    ).toBeNull();
  });

  it("parses a minimal two-stage workflow", () => {
    const result = resolveStagesConfig({
      implement: {
        type: "agent",
        runner: "claude-code",
        model: "claude-sonnet-4-5",
        max_turns: 30,
        prompt: "implement.liquid",
        on_complete: "done",
      },
      done: {
        type: "terminal",
      },
    });

    expect(result).not.toBeNull();
    expect(result!.initialStage).toBe("implement");
    expect(Object.keys(result!.stages)).toEqual(["implement", "done"]);

    const implement = result!.stages.implement!;
    expect(implement.type).toBe("agent");
    expect(implement.runner).toBe("claude-code");
    expect(implement.model).toBe("claude-sonnet-4-5");
    expect(implement.reasoningEffort).toBeNull();
    expect(implement.maxTurns).toBe(30);
    expect(implement.prompt).toBe("implement.liquid");
    expect(implement.transitions.onComplete).toBe("done");
    expect(implement.transitions.onApprove).toBeNull();
    expect(implement.transitions.onRework).toBeNull();

    const done = result!.stages.done!;
    expect(done.type).toBe("terminal");
  });

  it("respects explicit initial_stage", () => {
    const result = resolveStagesConfig({
      initial_stage: "investigate",
      investigate: {
        type: "agent",
        on_complete: "implement",
      },
      implement: {
        type: "agent",
        on_complete: "done",
      },
      done: {
        type: "terminal",
      },
    });

    expect(result!.initialStage).toBe("investigate");
  });

  it("uses first stage as initial_stage when not specified", () => {
    const result = resolveStagesConfig({
      investigate: {
        type: "agent",
        on_complete: "done",
      },
      done: {
        type: "terminal",
      },
    });

    expect(result!.initialStage).toBe("investigate");
  });

  it("parses gate stages with gate_type, on_approve, on_rework, and max_rework", () => {
    const result = resolveStagesConfig({
      review: {
        type: "gate",
        gate_type: "ensemble",
        on_approve: "merge",
        on_rework: "implement",
        max_rework: 3,
      },
      implement: {
        type: "agent",
        on_complete: "review",
      },
      merge: {
        type: "agent",
        on_complete: "done",
      },
      done: {
        type: "terminal",
      },
    });

    const review = result!.stages.review!;
    expect(review.type).toBe("gate");
    expect(review.gateType).toBe("ensemble");
    expect(review.maxRework).toBe(3);
    expect(review.transitions.onApprove).toBe("merge");
    expect(review.transitions.onRework).toBe("implement");
  });

  it("parses stage-level concurrency and timeout overrides", () => {
    const result = resolveStagesConfig({
      investigate: {
        type: "agent",
        concurrency: 2,
        timeout_ms: 60000,
        on_complete: "done",
      },
      done: {
        type: "terminal",
      },
    });

    expect(result!.stages.investigate!.concurrency).toBe(2);
    expect(result!.stages.investigate!.timeoutMs).toBe(60000);
  });

  it("parses stage-level reasoning_effort overrides", () => {
    const result = resolveStagesConfig({
      investigate: {
        type: "agent",
        reasoning_effort: "MEDIUM",
        on_complete: "done",
      },
      done: {
        type: "terminal",
      },
    });

    expect(result!.stages.investigate!.reasoningEffort).toBe("medium");
  });

  it("parses behavior-neutral delegated execution profiles", () => {
    const result = resolveStagesConfig({
      investigate: {
        type: "agent",
        runner: "codex",
        model: "gpt-5.3-codex",
        on_complete: "implement",
        execution: {
          role: "investigator",
          phase: "investigate",
          backend: "crabrunner",
          provider: "openai",
          model: "gpt-5.3-codex",
          reasoning_effort: "medium",
          profile: "readonly.pro16",
          timeout_ms: 600000,
          artifact_contract: {
            requires: ["issue-snapshot"],
            produces: ["investigation-brief"],
          },
          budget: {
            max_tokens: 12000,
            max_usd: 2.5,
          },
          dependencies: {
            stages: ["intake"],
            capsules: ["issue-snapshot"],
            missing_capsule: "fail",
          },
          run_group: {
            id: "rg-SYMPH-805",
            key: "stage-exec-v1",
          },
          capsules: {
            consume: ["capsules/issue-snapshot.json"],
            produce: ["capsules/investigation.json"],
          },
        },
      },
      implement: {
        type: "agent",
        on_complete: "done",
      },
      done: {
        type: "terminal",
      },
    });

    const stage = result!.stages.investigate!;
    expect(stage.runner).toBe("codex");
    expect(stage.model).toBe("gpt-5.3-codex");
    expect(stage.executionValidationErrors).toEqual([]);
    expect(stage.execution).toEqual({
      role: "investigator",
      phase: "investigate",
      backend: "crabrunner",
      controlNeeding: false,
      provider: "openai",
      model: "gpt-5.3-codex",
      reasoningEffort: "medium",
      profile: "readonly.pro16",
      artifacts: {
        requires: ["issue-snapshot"],
        produces: ["investigation-brief"],
      },
      timeoutMs: 600000,
      budget: {
        maxTokens: 12000,
        maxUsd: 2.5,
      },
      dependencies: {
        stages: ["intake"],
        capsules: ["issue-snapshot"],
        missingCapsule: "fail",
      },
      runGroup: {
        id: "rg-SYMPH-805",
        key: "stage-exec-v1",
      },
      capsules: {
        consume: ["capsules/issue-snapshot.json"],
        produce: ["capsules/investigation.json"],
      },
      subStages: [],
    });

    expect(validateStagesConfig(result).ok).toBe(true);
  });

  it("parses ordered implement sub-stages each carrying an independent execution profile and budget", () => {
    const result = resolveStagesConfig({
      implement: {
        type: "agent",
        on_complete: "done",
        execution: {
          role: "implementer",
          phase: "implement",
          backend: "crabrunner",
          sub_stages: [
            {
              name: "patch-plan",
              execution: {
                role: "implementer",
                phase: "implement",
                backend: "crabrunner",
                budget: { max_tokens: 20000 },
                capsules: { produce: ["capsules/patch-plan.json"] },
              },
            },
            {
              name: "first-patch",
              execution: {
                role: "implementer",
                phase: "implement",
                backend: "crabrunner",
                budget: { max_tokens: 40000 },
                capsules: {
                  consume: ["capsules/patch-plan.json"],
                  produce: ["capsules/first-patch.json"],
                },
              },
            },
          ],
        },
      },
      done: { type: "terminal" },
    });

    const stage = result!.stages.implement!;
    expect(stage.executionValidationErrors).toEqual([]);
    // Ordered sub-stage sequence is data-driven, not hard-coded.
    expect(stage.execution!.subStages.map((sub) => sub.name)).toEqual([
      "patch-plan",
      "first-patch",
    ]);
    // Each sub-stage carries its own independent budget ceiling.
    expect(stage.execution!.subStages[0]!.execution.budget).toEqual({
      maxTokens: 20000,
      maxUsd: null,
    });
    expect(stage.execution!.subStages[1]!.execution.budget).toEqual({
      maxTokens: 40000,
      maxUsd: null,
    });
    // Capsule handoff wiring (consume prior produce) is data-driven.
    expect(stage.execution!.subStages[1]!.execution.capsules).toEqual({
      consume: ["capsules/patch-plan.json"],
      produce: ["capsules/first-patch.json"],
    });
    // The parent profile defaults to no sub-stages; nesting is bounded to one level.
    expect(stage.execution!.subStages[0]!.execution.subStages).toEqual([]);
    expect(validateStagesConfig(result).ok).toBe(true);
  });

  it("path-scopes sub-stage validation errors and rejects nesting and missing names", () => {
    const result = resolveStagesConfig({
      implement: {
        type: "agent",
        on_complete: "done",
        execution: {
          role: "implementer",
          phase: "implement",
          backend: "crabrunner",
          sub_stages: [
            {
              // name omitted -> required error
              execution: {
                role: "implementer",
                phase: "implement",
                budget: { max_tokens: -5 },
              },
            },
            {
              name: "nested",
              execution: {
                role: "implementer",
                phase: "implement",
                sub_stages: [
                  {
                    name: "too-deep",
                    execution: { role: "implementer", phase: "implement" },
                  },
                ],
              },
            },
          ],
        },
      },
      done: { type: "terminal" },
    });

    const errorPaths = (
      result!.stages.implement!.executionValidationErrors ?? []
    ).map((error) => error.path);
    expect(errorPaths).toEqual(
      expect.arrayContaining([
        "stages.implement.execution.sub_stages.0.name",
        "stages.implement.execution.sub_stages.0.execution.budget.max_tokens",
        "stages.implement.execution.sub_stages.1.execution.sub_stages",
      ]),
    );
    expect(validateStagesConfig(result).ok).toBe(false);
  });

  it("parses thinking as the delegated execution reasoning_effort fallback", () => {
    const result = resolveStagesConfig({
      plan: {
        type: "agent",
        on_complete: "implement",
        execution: {
          role: "planner",
          phase: "plan",
          thinking: "high",
        },
      },
      implement: {
        type: "agent",
        on_complete: "done",
      },
      done: {
        type: "terminal",
      },
    });

    const stage = result!.stages.plan!;
    expect(stage.executionValidationErrors).toEqual([]);
    expect(stage.execution!.reasoningEffort).toBe("high");
  });

  it("prefers delegated execution reasoning_effort over thinking", () => {
    const result = resolveStagesConfig({
      review: {
        type: "agent",
        on_complete: "done",
        execution: {
          role: "reviewer",
          phase: "review",
          reasoning_effort: "medium",
          thinking: "high",
        },
      },
      done: {
        type: "terminal",
      },
    });

    const stage = result!.stages.review!;
    expect(stage.executionValidationErrors).toEqual([]);
    expect(stage.execution!.reasoningEffort).toBe("medium");
  });

  it("parses control_needing on delegated execution profiles", () => {
    const result = resolveStagesConfig({
      investigate: {
        type: "agent",
        on_complete: "done",
        execution: {
          role: "investigator",
          phase: "investigate",
          control_needing: true,
        },
      },
      done: {
        type: "terminal",
      },
    });

    expect(result!.stages.investigate!.executionValidationErrors).toEqual([]);
    expect(result!.stages.investigate!.execution!.controlNeeding).toBe(true);
  });

  it("attributes delegated execution thinking fallback errors to thinking", () => {
    const result = resolveStagesConfig({
      investigate: {
        type: "agent",
        on_complete: "done",
        execution: {
          role: "investigator",
          phase: "investigate",
          reasoning_effort: null,
          thinking: "extreme",
        },
      },
      done: {
        type: "terminal",
      },
    });

    const errors = result!.stages.investigate!.executionValidationErrors ?? [];
    expect(errors.map((error) => error.path)).toEqual([
      "stages.investigate.execution.thinking",
    ]);
  });

  it("does not treat artifacts as a delegated execution artifact_contract alias", () => {
    const result = resolveStagesConfig({
      implement: {
        type: "agent",
        on_complete: "done",
        execution: {
          role: "implementer",
          phase: "implement",
          artifacts: {
            requires: ["legacy-input"],
            produces: ["legacy-output"],
          },
        },
      },
      done: {
        type: "terminal",
      },
    });

    const stage = result!.stages.implement!;
    expect(stage.executionValidationErrors).toEqual([]);
    expect(stage.execution!.artifacts).toEqual({
      requires: [],
      produces: [],
    });
  });

  it("surfaces path-specific errors for invalid delegated execution profiles", () => {
    const result = resolveStagesConfig({
      implement: {
        type: "agent",
        on_complete: "done",
        execution: {
          role: "worker",
          phase: "execute",
          backend: "codex-crabrunner",
          control_needing: "yes",
          profile: "bad profile",
          artifact_contract: {
            requires: [123],
            produces: "",
          },
          timeout_ms: 0,
          budget: {
            max_tokens: "many",
            max_usd: 0,
          },
          dependencies: {
            stages: [""],
            capsules: [false],
            missing_capsule: "ignore",
          },
          capsules: {
            consume: [null],
          },
        },
      },
      done: {
        type: "terminal",
      },
    });

    const errors = result!.stages.implement!.executionValidationErrors ?? [];
    expect(errors.map((error) => error.path)).toEqual(
      expect.arrayContaining([
        "stages.implement.execution.role",
        "stages.implement.execution.phase",
        "stages.implement.execution.backend",
        "stages.implement.execution.control_needing",
        "stages.implement.execution.profile",
        "stages.implement.execution.artifact_contract.requires.0",
        "stages.implement.execution.artifact_contract.produces",
        "stages.implement.execution.timeout_ms",
        "stages.implement.execution.budget.max_tokens",
        "stages.implement.execution.budget.max_usd",
        "stages.implement.execution.dependencies.stages.0",
        "stages.implement.execution.dependencies.capsules.0",
        "stages.implement.execution.dependencies.missing_capsule",
        "stages.implement.execution.capsules.consume.0",
      ]),
    );

    const validation = validateStagesConfig(result);
    expect(validation.ok).toBe(false);
    expect(validation.errors).toEqual(
      expect.arrayContaining([
        expect.stringContaining("stages.implement.execution.role"),
        expect.stringContaining("stages.implement.execution.profile"),
        expect.stringContaining("stages.implement.execution.timeout_ms"),
        expect.stringContaining(
          "stages.implement.execution.dependencies.missing_capsule",
        ),
      ]),
    );
  });

  it("parses linear_state from stage definition", () => {
    const result = resolveStagesConfig({
      investigate: {
        type: "agent",
        linear_state: "In Progress",
        on_complete: "done",
      },
      done: {
        type: "terminal",
      },
    });

    expect(result!.stages.investigate!.linearState).toBe("In Progress");
  });

  it("defaults linearState to null when not specified", () => {
    const result = resolveStagesConfig({
      implement: {
        type: "agent",
        on_complete: "done",
      },
      done: {
        type: "terminal",
      },
    });

    expect(result!.stages.implement!.linearState).toBeNull();
    expect(result!.stages.done!.linearState).toBeNull();
  });

  it("treats unrecognized gate_type as null", () => {
    const result = resolveStagesConfig({
      review: {
        type: "gate",
        gate_type: "unknown",
        on_approve: "done",
      },
      done: {
        type: "terminal",
      },
    });

    expect(result!.stages.review!.gateType).toBeNull();
  });
});

describe("validateStagesConfig", () => {
  it("returns ok for null stages (no stages configured)", () => {
    const result = validateStagesConfig(null);
    expect(result.ok).toBe(true);
    expect(result.errors).toEqual([]);
  });

  it("returns ok for a valid stage machine", () => {
    const stages: StagesConfig = {
      initialStage: "investigate",
      fastTrack: null,
      stages: {
        investigate: {
          type: "agent",
          runner: null,
          model: null,
          prompt: null,
          maxTurns: null,
          timeoutMs: null,
          concurrency: null,
          gateType: null,
          maxRework: null,
          reviewers: [],
          transitions: {
            onComplete: "review",
            onApprove: null,
            onRework: null,
          },
          linearState: null,
        },
        review: {
          type: "gate",
          runner: null,
          model: null,
          prompt: null,
          maxTurns: null,
          timeoutMs: null,
          concurrency: null,
          gateType: "ensemble",
          maxRework: 3,
          reviewers: [],
          transitions: {
            onComplete: null,
            onApprove: "done",
            onRework: "investigate",
          },
          linearState: null,
        },
        done: {
          type: "terminal",
          runner: null,
          model: null,
          prompt: null,
          maxTurns: null,
          timeoutMs: null,
          concurrency: null,
          gateType: null,
          maxRework: null,
          reviewers: [],
          transitions: { onComplete: null, onApprove: null, onRework: null },
          linearState: null,
        },
      },
    };
    const result = validateStagesConfig(stages);
    expect(result.ok).toBe(true);
    expect(result.errors).toEqual([]);
  });

  it("rejects when initial_stage references unknown stage", () => {
    const stages: StagesConfig = {
      initialStage: "nonexistent",
      fastTrack: null,
      stages: {
        implement: {
          type: "agent",
          runner: null,
          model: null,
          prompt: null,
          maxTurns: null,
          timeoutMs: null,
          concurrency: null,
          gateType: null,
          maxRework: null,
          reviewers: [],
          transitions: { onComplete: "done", onApprove: null, onRework: null },
          linearState: null,
        },
        done: {
          type: "terminal",
          runner: null,
          model: null,
          prompt: null,
          maxTurns: null,
          timeoutMs: null,
          concurrency: null,
          gateType: null,
          maxRework: null,
          reviewers: [],
          transitions: { onComplete: null, onApprove: null, onRework: null },
          linearState: null,
        },
      },
    };
    const result = validateStagesConfig(stages);
    expect(result.ok).toBe(false);
    expect(result.errors).toContainEqual(
      expect.stringContaining("initial_stage 'nonexistent'"),
    );
  });

  it("rejects agent stage without on_complete transition", () => {
    const stages: StagesConfig = {
      initialStage: "implement",
      fastTrack: null,
      stages: {
        implement: {
          type: "agent",
          runner: null,
          model: null,
          prompt: null,
          maxTurns: null,
          timeoutMs: null,
          concurrency: null,
          gateType: null,
          maxRework: null,
          reviewers: [],
          transitions: { onComplete: null, onApprove: null, onRework: null },
          linearState: null,
        },
        done: {
          type: "terminal",
          runner: null,
          model: null,
          prompt: null,
          maxTurns: null,
          timeoutMs: null,
          concurrency: null,
          gateType: null,
          maxRework: null,
          reviewers: [],
          transitions: { onComplete: null, onApprove: null, onRework: null },
          linearState: null,
        },
      },
    };
    const result = validateStagesConfig(stages);
    expect(result.ok).toBe(false);
    expect(result.errors).toContainEqual(
      expect.stringContaining("'implement' (agent) has no on_complete"),
    );
  });

  it("rejects gate stage without on_approve transition", () => {
    const stages: StagesConfig = {
      initialStage: "review",
      fastTrack: null,
      stages: {
        review: {
          type: "gate",
          runner: null,
          model: null,
          prompt: null,
          maxTurns: null,
          timeoutMs: null,
          concurrency: null,
          gateType: "ensemble",
          maxRework: null,
          reviewers: [],
          transitions: { onComplete: null, onApprove: null, onRework: null },
          linearState: null,
        },
        done: {
          type: "terminal",
          runner: null,
          model: null,
          prompt: null,
          maxTurns: null,
          timeoutMs: null,
          concurrency: null,
          gateType: null,
          maxRework: null,
          reviewers: [],
          transitions: { onComplete: null, onApprove: null, onRework: null },
          linearState: null,
        },
      },
    };
    const result = validateStagesConfig(stages);
    expect(result.ok).toBe(false);
    expect(result.errors).toContainEqual(
      expect.stringContaining("'review' (gate) has no on_approve"),
    );
  });

  it("rejects transitions referencing unknown stages", () => {
    const stages: StagesConfig = {
      initialStage: "implement",
      fastTrack: null,
      stages: {
        implement: {
          type: "agent",
          runner: null,
          model: null,
          prompt: null,
          maxTurns: null,
          timeoutMs: null,
          concurrency: null,
          gateType: null,
          maxRework: null,
          reviewers: [],
          transitions: {
            onComplete: "nonexistent",
            onApprove: null,
            onRework: null,
          },
          linearState: null,
        },
        done: {
          type: "terminal",
          runner: null,
          model: null,
          prompt: null,
          maxTurns: null,
          timeoutMs: null,
          concurrency: null,
          gateType: null,
          maxRework: null,
          reviewers: [],
          transitions: { onComplete: null, onApprove: null, onRework: null },
          linearState: null,
        },
      },
    };
    const result = validateStagesConfig(stages);
    expect(result.ok).toBe(false);
    expect(result.errors).toContainEqual(
      expect.stringContaining(
        "on_complete references unknown stage 'nonexistent'",
      ),
    );
  });

  it("rejects when no terminal stage is defined", () => {
    const stages: StagesConfig = {
      initialStage: "a",
      fastTrack: null,
      stages: {
        a: {
          type: "agent",
          runner: null,
          model: null,
          prompt: null,
          maxTurns: null,
          timeoutMs: null,
          concurrency: null,
          gateType: null,
          maxRework: null,
          reviewers: [],
          transitions: { onComplete: "b", onApprove: null, onRework: null },
          linearState: null,
        },
        b: {
          type: "agent",
          runner: null,
          model: null,
          prompt: null,
          maxTurns: null,
          timeoutMs: null,
          concurrency: null,
          gateType: null,
          maxRework: null,
          reviewers: [],
          transitions: { onComplete: "a", onApprove: null, onRework: null },
          linearState: null,
        },
      },
    };
    const result = validateStagesConfig(stages);
    expect(result.ok).toBe(false);
    expect(result.errors).toContainEqual(
      expect.stringContaining("No terminal stage defined"),
    );
  });

  it("detects unreachable stages", () => {
    const stages: StagesConfig = {
      initialStage: "implement",
      fastTrack: null,
      stages: {
        implement: {
          type: "agent",
          runner: null,
          model: null,
          prompt: null,
          maxTurns: null,
          timeoutMs: null,
          concurrency: null,
          gateType: null,
          maxRework: null,
          reviewers: [],
          transitions: { onComplete: "done", onApprove: null, onRework: null },
          linearState: null,
        },
        orphan: {
          type: "agent",
          runner: null,
          model: null,
          prompt: null,
          maxTurns: null,
          timeoutMs: null,
          concurrency: null,
          gateType: null,
          maxRework: null,
          reviewers: [],
          transitions: { onComplete: "done", onApprove: null, onRework: null },
          linearState: null,
        },
        done: {
          type: "terminal",
          runner: null,
          model: null,
          prompt: null,
          maxTurns: null,
          timeoutMs: null,
          concurrency: null,
          gateType: null,
          maxRework: null,
          reviewers: [],
          transitions: { onComplete: null, onApprove: null, onRework: null },
          linearState: null,
        },
      },
    };
    const result = validateStagesConfig(stages);
    expect(result.ok).toBe(false);
    expect(result.errors).toContainEqual(
      expect.stringContaining("'orphan' is unreachable"),
    );
  });

  it("validates agent stage on_rework referencing valid stage", () => {
    const stages: StagesConfig = {
      initialStage: "implement",
      fastTrack: null,
      stages: {
        implement: {
          type: "agent",
          runner: null,
          model: null,
          prompt: null,
          maxTurns: null,
          timeoutMs: null,
          concurrency: null,
          gateType: null,
          maxRework: null,
          reviewers: [],
          transitions: {
            onComplete: "review",
            onApprove: null,
            onRework: null,
          },
          linearState: null,
        },
        review: {
          type: "agent",
          runner: null,
          model: null,
          prompt: null,
          maxTurns: null,
          timeoutMs: null,
          concurrency: null,
          gateType: null,
          maxRework: 3,
          reviewers: [],
          transitions: {
            onComplete: "done",
            onApprove: null,
            onRework: "implement",
          },
          linearState: null,
        },
        done: {
          type: "terminal",
          runner: null,
          model: null,
          prompt: null,
          maxTurns: null,
          timeoutMs: null,
          concurrency: null,
          gateType: null,
          maxRework: null,
          reviewers: [],
          transitions: { onComplete: null, onApprove: null, onRework: null },
          linearState: null,
        },
      },
    };
    const result = validateStagesConfig(stages);
    expect(result.ok).toBe(true);
    expect(result.errors).toEqual([]);
  });

  it("rejects agent stage on_rework referencing unknown stage", () => {
    const stages: StagesConfig = {
      initialStage: "implement",
      fastTrack: null,
      stages: {
        implement: {
          type: "agent",
          runner: null,
          model: null,
          prompt: null,
          maxTurns: null,
          timeoutMs: null,
          concurrency: null,
          gateType: null,
          maxRework: null,
          reviewers: [],
          transitions: {
            onComplete: "review",
            onApprove: null,
            onRework: null,
          },
          linearState: null,
        },
        review: {
          type: "agent",
          runner: null,
          model: null,
          prompt: null,
          maxTurns: null,
          timeoutMs: null,
          concurrency: null,
          gateType: null,
          maxRework: 3,
          reviewers: [],
          transitions: {
            onComplete: "done",
            onApprove: null,
            onRework: "nonexistent",
          },
          linearState: null,
        },
        done: {
          type: "terminal",
          runner: null,
          model: null,
          prompt: null,
          maxTurns: null,
          timeoutMs: null,
          concurrency: null,
          gateType: null,
          maxRework: null,
          reviewers: [],
          transitions: { onComplete: null, onApprove: null, onRework: null },
          linearState: null,
        },
      },
    };
    const result = validateStagesConfig(stages);
    expect(result.ok).toBe(false);
    expect(result.errors).toContainEqual(
      expect.stringContaining(
        "'review' on_rework references unknown stage 'nonexistent'",
      ),
    );
  });
});
