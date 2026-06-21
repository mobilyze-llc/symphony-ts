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
 * Three invariants are enforced here:
 *   1. Seam insulation — every sub-stage is dispatched ONLY through a resolved
 *      `StageExecutionBackendRunner.execute`. This module never references the
 *      crabrunner scheduler client or its submit/status/collect calls, so the
 *      optional crabrunner provider (SYMPH-850) stays an internal swap.
 *   2. Capsule handoff by path — a sub-stage consumes the prior sub-stage's
 *      capsule by path (resolved from what earlier sub-stages produced), never
 *      the full prior transcript. Missing required capsules fail closed.
 *   3. Per-sub-stage budget isolation — each sub-stage carries its own ceiling;
 *      a sub-stage that exceeds its ceiling stops the sequence at the boundary
 *      and the next sub-stage is NOT dispatched, so cumulative spend is bounded
 *      by the sum of the per-sub-stage ceilings.
 */

export type DecomposedStageStopReason =
  | "completed"
  | "missing_required_capsule"
  | "budget_exceeded"
  | "sub_stage_failed";

export interface DecomposedSubStageContext {
  /** Zero-based position of this sub-stage in the ordered sequence. */
  index: number;
  /** Sub-stage name, e.g. "patch-plan". */
  name: string;
  /** The sub-stage's own execution profile. */
  execution: StageExecutionProfile;
  /**
   * Capsules this sub-stage consumes, resolved BY PATH from what earlier
   * sub-stages produced. A capsule whose path is "" was not produced and fails
   * the readiness gate. There is intentionally no prior-transcript surface here.
   */
  consumeCapsules: readonly StageExecutionCapsuleRef[];
}

export interface DecomposedSubStageOutcome {
  name: string;
  status: "succeeded" | "failed" | "degraded";
  spentTokens: number;
  ceilingTokens: number | null;
  consumeCapsules: readonly StageExecutionCapsuleRef[];
  producedCapsulePaths: readonly string[];
  missingCapsules: readonly string[];
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
  /** Capsule paths available after the run (initial inputs + produced). */
  availableCapsulePaths: readonly string[];
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
  /** Capsule paths available before the first sub-stage (e.g. plan output). */
  initialCapsulePaths?: readonly string[];
  /** Missing-required-capsule policy (default "fail" — fail closed). */
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
    missingCapsulePolicy = "fail",
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
    // sub-stage (or the initial inputs) produced its path.
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

    // Fail closed before dispatch when a required handoff capsule is missing.
    const readiness = evaluateDelegatedStageCapsuleReadiness(
      { capsules: consumeCapsules },
      missingCapsulePolicy,
    );
    if (!readiness.ok) {
      outcomes.push({
        name: subStage.name,
        status: readiness.status,
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
        missingCapsules: [],
        result: null,
        error,
      });
      return finish("sub_stage_failed");
    }

    const spentTokens = spendTokensOf(result);
    cumulativeSpentTokens += spentTokens;

    const producedCapsulePaths = [...execution.capsules.produce];
    for (const capsulePath of producedCapsulePaths) {
      available.add(capsulePath);
    }

    outcomes.push({
      name: subStage.name,
      status: "succeeded",
      spentTokens,
      ceilingTokens,
      consumeCapsules,
      producedCapsulePaths,
      missingCapsules: [],
      result,
      error: null,
    });

    // Per-sub-stage budget isolation: a ceiling breach stops at the boundary and
    // the next sub-stage is NOT dispatched.
    if (ceilingTokens !== null && spentTokens > ceilingTokens) {
      return finish("budget_exceeded");
    }
  }

  return finish("completed");
}
