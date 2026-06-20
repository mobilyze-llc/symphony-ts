/**
 * Config contracts at load (SYMPH-409).
 *
 * WORKFLOW configs DECLARE sets (tracker.active_states, stage names) while
 * runtime code CONSUMES them (stage linear_state writes, the Resume
 * readmission path, stage transition targets) with no cross-check. The same
 * bug class — a consumed value missing from its declared set — has recurred
 * at least 3 times via active_states alone, always as a silent failure
 * (issues drop out of polling, or escalated issues silently respawn).
 *
 * This module is a load-time lint over a table of declared-vs-consumed
 * pairs. Each {@link ContractRule} names the declared config key and the
 * consuming code path, and enumerates violations mechanically from the
 * RESOLVED config (never from hardcoded state lists). Future pairs — prompt
 * template variables vs the strictVariables render context, verb→state view
 * mappings — slot in as new table entries.
 *
 * NOT covered here on purpose:
 * - The owner_host non-blank / single-homing rule (SYMPH-383) already lives
 *   in validateDispatchConfig (config-resolver.ts); it is not duplicated.
 *
 * Escape hatch: `contracts.override: true` suppresses contract failures, but
 * validateDispatchConfig still carries the suppressed violations so the
 * runtime host re-warns LOUDLY at every startup and config reload until the
 * override is removed.
 */

import { normalizeIssueState } from "../domain/model.js";
import { resolveRunnerProviderCapability } from "../runners/provider-capabilities.js";
import type { ResolvedWorkflowConfig, StagesConfig } from "./types.js";

/**
 * The readmission state consumed by the orchestrator's pause/hard-stop
 * machinery. Mirrors EXPLICIT_RESUME_STATE in src/orchestrator/core.ts:
 * issues parked by hard stops are only re-dispatched after an explicit
 * transition into this state, and the tracker poll only sees issues whose
 * state is in tracker.active_states — so a staged pipeline with "Resume"
 * missing from active_states can never readmit a paused issue.
 */
const RESUME_ADMISSION_STATE = "Resume";

export interface ContractViolation {
  /** Stable rule id from the contract table. */
  rule: string;
  /** The exact config key on the declared side of the pair. */
  key: string;
  /** The offending consumed value. */
  value: string;
  /** Human-readable message naming the key, the value, and the fix. */
  message: string;
}

/**
 * One declared-vs-consumed pair. `declared` names the config key holding the
 * declared set; `consumed` describes where code consumes values against it.
 */
interface ContractRule {
  id: string;
  declared: string;
  consumed: string;
  check: (config: ResolvedWorkflowConfig) => ContractViolation[];
}

function activeStateSet(config: ResolvedWorkflowConfig): Set<string> {
  return new Set(config.tracker.activeStates.map(normalizeIssueState));
}

/**
 * tracker.active_states must contain every state the staged pipeline writes
 * (each non-terminal stage's linear_state) plus the Resume readmission
 * state. Terminal-stage linear_state values (e.g. "Done") are excluded:
 * they move issues OUT of the poll on purpose.
 */
function checkActiveStatesCoverConsumedStates(
  config: ResolvedWorkflowConfig,
): ContractViolation[] {
  const stages = config.stages;
  if (stages === null) {
    return [];
  }

  const declared = activeStateSet(config);
  const violations: ContractViolation[] = [];

  // Consumed: states written by stages. Dedupe by normalized state so two
  // stages writing "In Progress" report one violation naming both stages.
  const writersByState = new Map<string, { value: string; stages: string[] }>();
  for (const [name, stage] of Object.entries(stages.stages)) {
    if (stage.type === "terminal" || stage.linearState === null) {
      continue;
    }
    const normalized = normalizeIssueState(stage.linearState);
    if (declared.has(normalized)) {
      continue;
    }
    const entry = writersByState.get(normalized);
    if (entry === undefined) {
      writersByState.set(normalized, {
        value: stage.linearState,
        stages: [name],
      });
    } else {
      entry.stages.push(name);
    }
  }

  for (const { value, stages: writerStages } of writersByState.values()) {
    const writers = writerStages
      .map((name) => `stages.${name}.linear_state`)
      .join(", ");
    violations.push({
      rule: "active_states_cover_consumed_states",
      key: "tracker.active_states",
      value,
      message:
        `tracker.active_states is missing '${value}', which ${writers} writes — ` +
        `issues moved to '${value}' would silently drop out of polling. ` +
        `Fix: add '${value}' to tracker.active_states.`,
    });
  }

  // Consumed: the Resume readmission path. Hard-stop pauses on a staged
  // pipeline park issues that only re-dispatch from RESUME_ADMISSION_STATE.
  if (!declared.has(normalizeIssueState(RESUME_ADMISSION_STATE))) {
    violations.push({
      rule: "active_states_cover_consumed_states",
      key: "tracker.active_states",
      value: RESUME_ADMISSION_STATE,
      message: `tracker.active_states is missing '${RESUME_ADMISSION_STATE}', the readmission state consumed by the orchestrator's pause/hard-stop machinery — paused issues could never be readmitted. Fix: add '${RESUME_ADMISSION_STATE}' to tracker.active_states.`,
    });
  }

  return violations;
}

/**
 * escalation_state must NOT be in tracker.active_states: an escalated
 * (parked) issue whose state is still polled would be silently re-dispatched
 * — the exact respawn the escalation parked it to prevent.
 */
function checkEscalationStateNotActive(
  config: ResolvedWorkflowConfig,
): ContractViolation[] {
  const escalationState = config.escalationState?.trim();
  if (escalationState === undefined || escalationState === "") {
    return [];
  }

  if (!activeStateSet(config).has(normalizeIssueState(escalationState))) {
    return [];
  }

  return [
    {
      rule: "escalation_state_not_active",
      key: "escalation_state",
      value: escalationState,
      message: `escalation_state '${escalationState}' is listed in tracker.active_states — escalated issues would be re-polled and silently respawned instead of staying parked for the operator. Fix: remove '${escalationState}' from tracker.active_states (or pick a non-active escalation_state).`,
    },
  ];
}

/**
 * Stage transition targets (on_complete, on_approve, on_rework,
 * initial_stage, fast_track.initial_stage) must name defined stages.
 * resolveStagesConfig parses without validating any of this. The fuller
 * structural checker, validateStagesConfig (below), additionally requires a
 * terminal stage and full reachability — deliberately NOT enforced at
 * dispatch here (it would reject partial-pipeline configs that run fine);
 * only dangling transition targets are load-time contract failures.
 */
function checkStageTransitionTargets(
  config: ResolvedWorkflowConfig,
): ContractViolation[] {
  const stages = config.stages;
  if (stages === null) {
    return [];
  }

  const stageNames = new Set(Object.keys(stages.stages));
  const violations: ContractViolation[] = [];
  const violation = (key: string, value: string): ContractViolation => ({
    rule: "stage_transition_targets_defined",
    key,
    value,
    message:
      `${key} names stage '${value}', which is not a defined stage ` +
      `(defined: ${[...stageNames].join(", ")}). Fix: point ${key} at a defined stage ` +
      `or add a 'stages.${value}' definition.`,
  });

  if (!stageNames.has(stages.initialStage)) {
    violations.push(violation("stages.initial_stage", stages.initialStage));
  }

  if (
    stages.fastTrack !== null &&
    !stageNames.has(stages.fastTrack.initialStage)
  ) {
    violations.push(
      violation(
        "stages.fast_track.initial_stage",
        stages.fastTrack.initialStage,
      ),
    );
  }

  for (const [name, stage] of Object.entries(stages.stages)) {
    const transitionKeys = [
      ["on_complete", stage.transitions.onComplete],
      ["on_approve", stage.transitions.onApprove],
      ["on_rework", stage.transitions.onRework],
    ] as const;
    for (const [transitionKey, target] of transitionKeys) {
      if (target !== null && !stageNames.has(target)) {
        violations.push(violation(`stages.${name}.${transitionKey}`, target));
      }
    }
  }

  return violations;
}

function checkStageExecutionProfiles(
  config: ResolvedWorkflowConfig,
): ContractViolation[] {
  const stages = config.stages;
  if (stages === null) {
    return [];
  }

  const violations: ContractViolation[] = [];
  for (const stage of Object.values(stages.stages)) {
    for (const error of stage.executionValidationErrors ?? []) {
      violations.push({
        rule: "stage_execution_profiles_valid",
        key: error.path,
        value: error.value,
        message: error.message,
      });
    }
  }
  return violations;
}

function checkControlNeedingStageProviderSelection(
  config: ResolvedWorkflowConfig,
): ContractViolation[] {
  const stages = config.stages;
  if (stages === null) {
    return [];
  }

  const violations: ContractViolation[] = [];
  for (const [stageName, stage] of Object.entries(stages.stages)) {
    const execution = stage.execution ?? null;
    if (execution?.controlNeeding !== true) {
      continue;
    }

    const runnerKind = stage.runner ?? config.runner.kind;
    const provider = execution.provider ?? config.runner.provider ?? null;
    const capability = resolveRunnerProviderCapability({
      backend: execution.backend,
      runnerKind,
      provider,
    });

    if (capability === null) {
      violations.push({
        rule: "control_needing_stage_provider_supports_control_semantics",
        key: `stages.${stageName}.execution.provider`,
        value: provider ?? "<default>",
        message: `stages.${stageName}.execution.control_needing is true, but the selected runner/provider ('${runnerKind}' / '${provider ?? "<default>"}') is not in the provider capability matrix. Fix: select the Codex app-server provider for control-needing stages or add a truthful capability row.`,
      });
      continue;
    }

    if (capability.current.fullControlSemantics) {
      continue;
    }

    violations.push({
      rule: "control_needing_stage_provider_supports_control_semantics",
      key: `stages.${stageName}.execution.provider`,
      value: provider ?? capability.id,
      message: `stages.${stageName}.execution.control_needing is true, but provider '${capability.id}' does not currently preserve the Codex app-server control surface. Control-needing stages must use Codex app-server, not a one-shot or delegated provider.`,
    });
  }
  return violations;
}

/**
 * The declared-vs-consumed contract table. Future pairs (prompt variables vs
 * render context, verb→state view mappings) are added as entries here.
 */
const CONTRACT_RULES: readonly ContractRule[] = [
  {
    id: "active_states_cover_consumed_states",
    declared: "tracker.active_states",
    consumed:
      "stages.<name>.linear_state writes + the orchestrator Resume readmission path",
    check: checkActiveStatesCoverConsumedStates,
  },
  {
    id: "escalation_state_not_active",
    declared: "tracker.active_states",
    consumed: "escalation_state parking writes (silent-respawn hazard)",
    check: checkEscalationStateNotActive,
  },
  {
    id: "stage_transition_targets_defined",
    declared: "stages.<name> definitions",
    consumed:
      "stages.*.on_complete / on_approve / on_rework, stages.initial_stage, stages.fast_track.initial_stage",
    check: checkStageTransitionTargets,
  },
  {
    id: "stage_execution_profiles_valid",
    declared: "stages.<name>.execution",
    consumed:
      "delegated stage profile/run-group/capsule configuration consumed by future stage execution backends",
    check: checkStageExecutionProfiles,
  },
  {
    id: "control_needing_stage_provider_supports_control_semantics",
    declared: "stages.<name>.execution.provider",
    consumed:
      "control-needing stages that require Codex app-server budget/stall/abort/signal semantics",
    check: checkControlNeedingStageProviderSelection,
  },
];

/** Run every contract rule against a resolved config. */
export function checkConfigContracts(
  config: ResolvedWorkflowConfig,
): ContractViolation[] {
  return CONTRACT_RULES.flatMap((rule) => rule.check(config));
}

export function formatContractViolations(
  violations: readonly ContractViolation[],
): string {
  return violations.map((violation) => `- ${violation.message}`).join("\n");
}

export interface StagesValidationResult {
  ok: boolean;
  errors: string[];
}

/**
 * Structural validation of a parsed stages config: every transition target
 * names a defined stage, at least one terminal stage exists, and every stage
 * is reachable from the initial stage. Wired into dispatch validation via
 * the stage_transition_targets_defined contract rule above.
 */
export function validateStagesConfig(
  stagesConfig: StagesConfig | null,
): StagesValidationResult {
  if (stagesConfig === null) {
    return { ok: true, errors: [] };
  }

  const errors: string[] = [];
  const stageNames = new Set(Object.keys(stagesConfig.stages));

  if (!stageNames.has(stagesConfig.initialStage)) {
    errors.push(
      `initial_stage '${stagesConfig.initialStage}' does not reference a defined stage.`,
    );
  }

  if (
    stagesConfig.fastTrack != null &&
    !stageNames.has(stagesConfig.fastTrack.initialStage)
  ) {
    errors.push(
      `fast_track.initial_stage '${stagesConfig.fastTrack.initialStage}' does not reference a defined stage.`,
    );
  }

  let hasTerminal = false;
  for (const [name, stage] of Object.entries(stagesConfig.stages)) {
    for (const error of stage.executionValidationErrors ?? []) {
      errors.push(error.message);
    }

    if (stage.type === "terminal") {
      hasTerminal = true;
      continue;
    }

    if (stage.type === "agent") {
      if (stage.transitions.onComplete === null) {
        errors.push(`Stage '${name}' (agent) has no on_complete transition.`);
      } else if (!stageNames.has(stage.transitions.onComplete)) {
        errors.push(
          `Stage '${name}' on_complete references unknown stage '${stage.transitions.onComplete}'.`,
        );
      }

      if (
        stage.transitions.onRework !== null &&
        !stageNames.has(stage.transitions.onRework)
      ) {
        errors.push(
          `Stage '${name}' on_rework references unknown stage '${stage.transitions.onRework}'.`,
        );
      }
    }

    if (stage.type === "gate") {
      if (stage.transitions.onApprove === null) {
        errors.push(`Stage '${name}' (gate) has no on_approve transition.`);
      } else if (!stageNames.has(stage.transitions.onApprove)) {
        errors.push(
          `Stage '${name}' on_approve references unknown stage '${stage.transitions.onApprove}'.`,
        );
      }

      if (
        stage.transitions.onRework !== null &&
        !stageNames.has(stage.transitions.onRework)
      ) {
        errors.push(
          `Stage '${name}' on_rework references unknown stage '${stage.transitions.onRework}'.`,
        );
      }
    }
  }

  if (!hasTerminal) {
    errors.push(
      "No terminal stage defined. At least one stage must have type 'terminal'.",
    );
  }

  // Check reachability from initial stage
  const reachable = new Set<string>();
  const queue = [stagesConfig.initialStage];
  while (queue.length > 0) {
    // biome-ignore lint/style/noNonNullAssertion: queue.length > 0 guarantees pop() returns a value
    const current = queue.pop()!;
    if (reachable.has(current)) {
      continue;
    }
    reachable.add(current);

    const stage = stagesConfig.stages[current];
    if (stage === undefined) {
      continue;
    }

    for (const target of [
      stage.transitions.onComplete,
      stage.transitions.onApprove,
      stage.transitions.onRework,
    ]) {
      if (target !== null && !reachable.has(target)) {
        queue.push(target);
      }
    }
  }

  for (const name of stageNames) {
    if (!reachable.has(name)) {
      errors.push(
        `Stage '${name}' is unreachable from initial stage '${stagesConfig.initialStage}'.`,
      );
    }
  }

  return { ok: errors.length === 0, errors };
}
