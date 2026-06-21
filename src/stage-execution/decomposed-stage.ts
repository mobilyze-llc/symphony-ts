import type { AgentRunInput } from "../agent/runner.js";
import type {
  StageExecutionProfile,
  StageExecutionSubStage,
} from "../config/types.js";
import {
  type DelegatedStageMissingCapsulePolicy,
  type StageExecutionCapsuleRef,
  evaluateDelegatedStageCapsuleReadiness,
} from "../domain/model.js";
import type {
  StageExecutionBackendResult,
  StageExecutionBackendRunner,
  StageExecutionJobSpec,
} from "./backend.js";

/**
 * SYMPH-835 — run a stage that has been decomposed into bounded, capsule-scoped
 * sub-stages (e.g. patch-plan → first-patch → focused-tests → repair →
 * pr-assembly).
 *
 * The sub-stage list is data-driven (it comes from the stage's
 * `StageExecutionProfile.subStages`, parsed from WORKFLOW config — never
 * hard-coded here). This runner only sequences the sub-stages; it deliberately
 * does NOT own stage transitions, the rework counter, or merge-readiness. Those
 * stay orchestrator-owned and journal-derived (no sub-stage advances stage
 * state). The runner returns aggregate data for the caller to finalize.
 *
 * Four invariants are enforced here:
 *   1. Seam insulation — every sub-stage is dispatched ONLY through a resolved
 *      `StageExecutionBackendRunner.execute`. This module never references the
 *      crabrunner scheduler client or its submit/status/collect calls, so the
 *      optional crabrunner provider (SYMPH-850) stays an internal swap.
 *   2. Capsule handoff by path — a sub-stage consumes the prior sub-stage's
 *      capsule by path, never the full prior transcript. A capsule becomes
 *      available to later sub-stages only when the caller's
 *      `resolveProducedCapsules` confirms the producing sub-stage actually
 *      emitted it (config declarations alone never satisfy the handoff), so a
 *      missing required capsule fails closed.
 *   3. Per-sub-stage budget isolation — each sub-stage carries its own ceiling;
 *      a sub-stage that exceeds its ceiling stops the sequence at the boundary,
 *      the next sub-stage is NOT dispatched, and its produced capsules are
 *      withheld, so cumulative spend is bounded by the sum of the per-sub-stage
 *      ceilings.
 *   4. Per-sub-stage missing-capsule policy — the handoff readiness gate uses
 *      each sub-stage's own `dependencies.missingCapsule` policy (overridable
 *      via `missingCapsulePolicy`). `"fail"` (the default) stops the sequence;
 *      `"degrade"` proceeds with the sub-stage marked degraded.
 *
 * Capsule identity note: `capsules.consume`/`capsules.produce` entries are
 * capsule PATHS, and this runner treats the path as the capsule identity
 * (`id === path`) for by-path handoff.
 */

export type DecomposedStageStopReason =
  | "completed"
  | "missing_required_capsule"
  | "budget_exceeded"
  | "sub_stage_failed";

export type DecomposedSubStageStatus =
  | "succeeded"
  | "failed"
  | "degraded"
  | "budget_exceeded";

export interface DecomposedSubStageContext {
  /** Zero-based position of this sub-stage in the ordered sequence. */
  index: number;
  /** Sub-stage name, e.g. "patch-plan". */
  name: string;
  /** The sub-stage's own execution profile. */
  execution: StageExecutionProfile;
  /**
   * Capsules this sub-stage consumes, resolved BY PATH from what earlier
   * sub-stages actually produced. A capsule whose path is "" was not produced
   * and fails the readiness gate. There is intentionally no prior-transcript
   * surface here.
   */
  consumeCapsules: readonly StageExecutionCapsuleRef[];
}

export interface DecomposedSubStageOutcome {
  name: string;
  status: DecomposedSubStageStatus;
  spentTokens: number;
  ceilingTokens: number | null;
  consumeCapsules: readonly StageExecutionCapsuleRef[];
  producedCapsulePaths: readonly string[];
  missingCapsules: readonly string[];
  /**
   * Backend result for a dispatched sub-stage. Present (non-null) even when
   * `status` is "budget_exceeded" — in that case `producedCapsulePaths` is
   * empty because the breaching sub-stage's capsules are withheld from the
   * handoff. Null when the sub-stage never ran (missing required capsule) or
   * its dispatch threw.
   */
  result: StageExecutionBackendResult | null;
  error: unknown;
}

export interface DecomposedStageResult {
  stopReason: DecomposedStageStopReason;
  completedAll: boolean;
  outcomes: readonly DecomposedSubStageOutcome[];
  cumulativeSpentTokens: number;
  /** Sum of the per-sub-stage token ceilings (the cumulative spend bound). */
  ceilingSumTokens: number;
  /** Capsule paths available after the run (initial inputs + verified produced). */
  availableCapsulePaths: readonly string[];
}

export interface ResolveProducedCapsulesInput {
  ctx: DecomposedSubStageContext;
  result: StageExecutionBackendResult;
}

export interface RunDecomposedStageInput {
  /** Ordered sub-stages (data-driven, from StageExecutionProfile.subStages). */
  subStages: readonly StageExecutionSubStage[];
  /** Resolve a backend for a job — the ONLY dispatch path (seam insulation). */
  resolveBackend: (job: StageExecutionJobSpec) => StageExecutionBackendRunner;
  /** Build the per-sub-stage job spec (carries the sub-stage's own ceiling). */
  buildJobSpec: (ctx: DecomposedSubStageContext) => StageExecutionJobSpec;
  /** Build the runner input from capsule paths only (never a prior transcript). */
  buildRunnerInput: (ctx: DecomposedSubStageContext) => AgentRunInput;
  /** Tokens a completed sub-stage spent, read from its backend result. */
  spendTokensOf: (result: StageExecutionBackendResult) => number;
  /**
   * Capsule paths the sub-stage ACTUALLY produced, derived from the backend
   * result (e.g. artifact evidence or a filesystem check). Only these paths
   * become available to later sub-stages — config `capsules.produce`
   * declarations alone never satisfy the handoff, so a declared-but-unproduced
   * capsule fails the next sub-stage closed. Intentionally required (no
   * default): a default that trusted config `capsules.produce` would silently
   * re-break the fail-closed handoff contract.
   */
  resolveProducedCapsules: (
    input: ResolveProducedCapsulesInput,
  ) => readonly string[];
  /** Capsule paths available before the first sub-stage (e.g. plan output). */
  initialCapsulePaths?: readonly string[];
  /**
   * Optional override of every sub-stage's missing-capsule policy. When unset,
   * each sub-stage's own `dependencies.missingCapsule` policy applies (default
   * "fail").
   */
  missingCapsulePolicy?: DelegatedStageMissingCapsulePolicy;
}

export async function runDecomposedStage(
  input: RunDecomposedStageInput,
): Promise<DecomposedStageResult> {
  const {
    subStages,
    resolveBackend,
    buildJobSpec,
    buildRunnerInput,
    spendTokensOf,
    resolveProducedCapsules,
  } = input;

  const available = new Set<string>(input.initialCapsulePaths ?? []);
  const outcomes: DecomposedSubStageOutcome[] = [];
  let cumulativeSpentTokens = 0;
  const ceilingSumTokens = subStages.reduce(
    (sum, subStage) => sum + (subStage.execution.budget.maxTokens ?? 0),
    0,
  );

  const finish = (
    stopReason: DecomposedStageStopReason,
  ): DecomposedStageResult => ({
    stopReason,
    completedAll: stopReason === "completed",
    outcomes,
    cumulativeSpentTokens,
    ceilingSumTokens,
    availableCapsulePaths: [...available],
  });

  for (const [index, subStage] of subStages.entries()) {
    const execution = subStage.execution;
    const ceilingTokens = execution.budget.maxTokens;

    // Capsule handoff is BY PATH: a consumed capsule is ready only if a prior
    // sub-stage (or the initial inputs) actually produced its path.
    const consumeCapsules: StageExecutionCapsuleRef[] =
      execution.capsules.consume.map((capsulePath) => ({
        id: capsulePath,
        path: available.has(capsulePath) ? capsulePath : "",
        sha256: null,
        required: true,
        producedByStage: null,
        consumedByStage: subStage.name,
      }));

    const ctx: DecomposedSubStageContext = {
      index,
      name: subStage.name,
      execution,
      consumeCapsules,
    };

    // Readiness uses the sub-stage's own missing-capsule policy (overridable).
    const policy =
      input.missingCapsulePolicy ?? execution.dependencies.missingCapsule;
    const readiness = evaluateDelegatedStageCapsuleReadiness(
      { capsules: consumeCapsules },
      policy,
    );
    let degraded = false;
    if (!readiness.ok) {
      if (readiness.status !== "degraded") {
        // Fail closed: a required handoff capsule is missing — stop the
        // sequence before dispatch and do not run the sub-stage. Only an
        // explicit "degrade" status proceeds; any other non-ok status
        // (today only "failed") fails closed.
        outcomes.push({
          name: subStage.name,
          status: "failed",
          spentTokens: 0,
          ceilingTokens,
          consumeCapsules,
          producedCapsulePaths: [],
          missingCapsules: readiness.missingCapsules,
          result: null,
          error: null,
        });
        return finish("missing_required_capsule");
      }
      // "degrade" policy: proceed with the sub-stage but mark it degraded.
      degraded = true;
    }

    const job = buildJobSpec(ctx);
    const backend = resolveBackend(job);

    let result: StageExecutionBackendResult;
    try {
      result = await backend.execute({
        job,
        runnerInput: buildRunnerInput(ctx),
      });
    } catch (error) {
      // Between-sub-stage control: a failed sub-stage stops the sequence. The
      // orchestrator — not this runner — owns failure classification, rework,
      // and stage transitions, so the error is preserved for it.
      outcomes.push({
        name: subStage.name,
        status: "failed",
        spentTokens: 0,
        ceilingTokens,
        consumeCapsules,
        producedCapsulePaths: [],
        missingCapsules: readiness.ok ? [] : readiness.missingCapsules,
        result: null,
        error,
      });
      return finish("sub_stage_failed");
    }

    const spentTokens = spendTokensOf(result);
    if (!Number.isFinite(spentTokens) || spentTokens < 0) {
      // A bogus usage reading must not silently defeat budget isolation
      // (NaN > ceiling is always false). Fail closed at the boundary.
      outcomes.push({
        name: subStage.name,
        status: "failed",
        spentTokens: 0,
        ceilingTokens,
        consumeCapsules,
        producedCapsulePaths: [],
        missingCapsules: readiness.ok ? [] : readiness.missingCapsules,
        result,
        error: new Error(
          `spendTokensOf returned a non-finite or negative value for sub-stage "${subStage.name}".`,
        ),
      });
      return finish("sub_stage_failed");
    }
    cumulativeSpentTokens += spentTokens;

    // Per-sub-stage budget isolation: a ceiling breach stops at the boundary,
    // the next sub-stage is NOT dispatched, and the breaching sub-stage's
    // produced capsules are withheld from the handoff. Spending exactly the
    // ceiling is permitted; only strict-exceed (> ceiling) triggers the stop.
    if (ceilingTokens !== null && spentTokens > ceilingTokens) {
      outcomes.push({
        name: subStage.name,
        status: "budget_exceeded",
        spentTokens,
        ceilingTokens,
        consumeCapsules,
        producedCapsulePaths: [],
        missingCapsules: readiness.ok ? [] : readiness.missingCapsules,
        result,
        error: null,
      });
      return finish("budget_exceeded");
    }

    // Only capsules the backend actually produced become available downstream.
    // A resolver that throws (e.g. failed artifact verification) fails closed
    // with a recorded outcome rather than escaping mid-sequence.
    let producedCapsulePaths: readonly string[];
    try {
      producedCapsulePaths = resolveProducedCapsules({ ctx, result });
    } catch (error) {
      outcomes.push({
        name: subStage.name,
        status: "failed",
        spentTokens,
        ceilingTokens,
        consumeCapsules,
        producedCapsulePaths: [],
        missingCapsules: readiness.ok ? [] : readiness.missingCapsules,
        result,
        error,
      });
      return finish("sub_stage_failed");
    }
    for (const capsulePath of producedCapsulePaths) {
      available.add(capsulePath);
    }

    outcomes.push({
      name: subStage.name,
      status: degraded ? "degraded" : "succeeded",
      spentTokens,
      ceilingTokens,
      consumeCapsules,
      producedCapsulePaths,
      missingCapsules: readiness.ok ? [] : readiness.missingCapsules,
      result,
      error: null,
    });
  }

  return finish("completed");
}
