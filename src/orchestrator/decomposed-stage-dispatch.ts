import { statSync } from "node:fs";
import { isAbsolute, resolve, sep } from "node:path";

import type { AgentRunInput, AgentRunResult } from "../agent/runner.js";
import type {
  StageExecutionSubStage,
  WorkflowHardStopsConfig,
} from "../config/types.js";
import {
  type DelegatedStageAttemptStatus,
  type Issue,
  type LiveSession,
  createEmptyLiveSession,
} from "../domain/model.js";
import { mapCrabrunnerUsageToStageUsage } from "../domain/stage-usage.js";
import type { StageUsageMeasurement } from "../domain/stage-usage.js";
import type { DispatcherRunJournalEntryDraft } from "../logging/run-journal.js";
import type { HardStopDecision } from "../policy/hard-stops.js";
import type {
  StageExecutionBackendRunner,
  StageExecutionJobSpec,
} from "../stage-execution/backend.js";
import {
  type DecomposedStageResult,
  type DecomposedSubStageContext,
  type DecomposedSubStageOutcome,
  runDecomposedStage,
} from "../stage-execution/decomposed-stage.js";
import { buildDelegatedStageAttemptJournalEntry } from "../stage-execution/delegated-stage-projection.js";

/**
 * SYMPH-852 — live dispatch wiring for decomposed stages.
 *
 * `runDecomposedStage` (SYMPH-835, Wave 2) sequences a stage's bounded
 * sub-stages through the StageExecutionBackend seam. This module is the thin
 * adapter that lets the runtime-host invoke it on the live path: it builds the
 * per-sub-stage job specs / runner inputs from the runtime-host's context,
 * journals every delegated attempt through the SYMPH-811 projection, and folds
 * the sub-stage outcomes into ONE aggregate `AgentRunResult` that the
 * runtime-host feeds into its EXISTING finalization — so the orchestrator still
 * performs exactly one stage transition and rework / merge-readiness stay
 * journal-derived.
 *
 * Ownership boundary (mirrors `runDecomposedStage`): this module returns data
 * only. It MUST NOT advance stage state, mutate rework counters, or call
 * onWorkerExit/advanceStage. Finalization stays runtime-host-owned. The
 * injected-deps surface deliberately exposes no stage-advance hook.
 *
 * Per-sub-stage identity: each sub-stage's job (and journal entry) is keyed by a
 * COMPOSITE `${parentStageName}/${subStageName}`, so two sub-stages that share a
 * profile and run group still get distinct backend idempotency keys and distinct
 * SYMPH-811 projection keys (the reducer keys on `runGroupId` + `stageName`).
 * The PARENT stage name still drives the single runtime-host stage transition.
 *
 * Sub-stages must be delegated lanes (crabrunner): the capsule-scoped runner
 * input intentionally drops stage/modePolicy/AC/rework context, which a
 * current-runner lane depends on, so a non-delegated sub-stage fails closed
 * before any dispatch.
 *
 * Journaling model: each considered sub-stage is journaled twice — an admission
 * (`running`) entry and a terminal (`succeeded`/`failed`/`degraded`) entry —
 * keyed in the projection by `(runGroupId, composite sub-stage name)`. The
 * entries are emitted from the deterministic `DecomposedStageResult.outcomes`
 * after the sequence resolves, so a fail-closed sub-stage (a missing required
 * capsule, which never dispatches) is recorded uniformly with the dispatched
 * ones, and there is no interleaving hazard with the dispatch loop. Replaying
 * running→terminal yields the terminal state, exactly the projection contract.
 * (Running/terminal entries carry distinct idempotency keys; the reducer orders
 * by journal sequence, not timestamp — the distinct timestamps are
 * observability only.)
 */

/**
 * A produced-capsule existence check (filesystem by default; injectable).
 * Synchronous because `runDecomposedStage`'s `resolveProducedCapsules` seam is
 * synchronous; a bounded local stat right after a sub-stage's awaited dispatch
 * is acceptable and keeps config alone from satisfying the fail-closed handoff.
 */
export type CapsuleFileExistsFn = (absolutePath: string) => boolean;

export interface ExecuteDecomposedStageDispatchInput {
  /** The issue the parent stage is running for. */
  issue: Issue;
  /** Stage attempt index (null before the first numbered attempt). */
  attempt: number | null;
  /** The PARENT stage name (e.g. "implement"); flows into each job identity. */
  stageName: string | null;
  /** Ordered sub-stages from the parent stage's StageExecutionProfile. */
  subStages: readonly StageExecutionSubStage[];
  /** Effective (stage-resolved) hard stops, carried into each sub-stage job. */
  effectiveHardStops: WorkflowHardStopsConfig | null;
  /** Base ref each sub-stage job is anchored to. */
  baseRef: string;
  /** Run-group artifact root; produced-capsule paths resolve against it. */
  artifactRoot: string;
  /** Abort signal threaded into each sub-stage runner input. */
  signal?: AbortSignal;
  /** Capsule paths available before the first sub-stage (rarely set). */
  initialCapsulePaths?: readonly string[];
  /** Resolve a backend for a job — the only dispatch path (seam insulation). */
  resolveBackend: (job: StageExecutionJobSpec) => StageExecutionBackendRunner;
  /**
   * Build a StageExecutionJobSpec for a sub-stage. The runtime-host adapts its
   * own `createStageExecutionJobSpec` here, passing the SUB-STAGE's execution
   * profile but the PARENT stage name (so the run group correlates).
   */
  createStageExecutionJobSpec: (input: {
    execution: StageExecutionSubStage["execution"];
    stageName: string | null;
  }) => StageExecutionJobSpec;
  /**
   * Adapt a base runner input into the per-sub-stage runner input. The base
   * input is built from capsule paths only (no prior-stage context); the
   * runtime-host may attach a mode policy or other run-scoped fields.
   */
  buildRunnerInput: (runnerInput: AgentRunInput) => AgentRunInput;
  /** Append a journal draft through the single-writer (returns when committed). */
  appendJournalEntry: (draft: DispatcherRunJournalEntryDraft) => Promise<void>;
  /** Produced-capsule existence check; defaults to a real fs.stat. */
  fileExists?: CapsuleFileExistsFn;
  /** Clock for journal timestamps. */
  now: () => Date;
}

const DEFAULT_FILE_EXISTS: CapsuleFileExistsFn = (absolutePath) => {
  try {
    return statSync(absolutePath).isFile();
  } catch {
    return false;
  }
};

export async function executeDecomposedStageDispatch(
  input: ExecuteDecomposedStageDispatchInput,
): Promise<AgentRunResult> {
  const fileExists = input.fileExists ?? DEFAULT_FILE_EXISTS;

  // Fail closed BEFORE any dispatch if a sub-stage targets a non-delegated
  // backend. Decomposed sub-stages run as bounded delegated lanes; the
  // capsule-scoped runner input deliberately drops stage/modePolicy/AC/etc.,
  // which a current-runner (or manual) lane would need — so those would run
  // mis-configured. The live decomposed use case is crabrunner. (SYMPH-852 P2-2)
  assertSubStagesAreDelegated(input.subStages);

  // Per-sub-stage identity: compose the PARENT stage name with the sub-stage
  // name so each sub-stage gets a UNIQUE backend idempotency key AND a unique
  // SYMPH-811 projection key (the reducer keys on runGroupId + stageName), even
  // when two sub-stages share a profile and run group. The PARENT stage name
  // still drives the single runtime-host stage transition (unchanged).
  // (SYMPH-852 P2-1)
  const subStageNames = input.subStages.map((subStage) =>
    composeSubStageStageName(input.stageName, subStage.name),
  );

  // Build the per-sub-stage job specs up front so the journal entries can use a
  // stable idempotency key per sub-stage. Index-aligned with `subStages`.
  const subStageJobs = input.subStages.map((subStage, index) =>
    input.createStageExecutionJobSpec({
      execution: subStage.execution,
      stageName: subStageNames[index] ?? null,
    }),
  );

  const decomposed = await runDecomposedStage({
    subStages: input.subStages,
    ...(input.initialCapsulePaths === undefined
      ? {}
      : { initialCapsulePaths: input.initialCapsulePaths }),
    resolveBackend: input.resolveBackend,
    buildJobSpec: (ctx) => requireSubStageJob(subStageJobs, ctx),
    buildRunnerInput: (ctx) =>
      input.buildRunnerInput(
        buildCapsuleScopedRunnerInput({
          issue: input.issue,
          attempt: input.attempt,
          // Per-sub-stage name (parent/sub-stage) so the lane is uniquely
          // identified, matching the job identity. (SYMPH-852 P2-1)
          stageName: subStageNames[ctx.index] ?? null,
          ...(input.signal === undefined ? {} : { signal: input.signal }),
          ctx,
        }),
      ),
    spendTokensOf: (result) => readStageTotalTokens(result.result.liveSession),
    resolveProducedCapsules: ({ ctx }) =>
      // Fail-closed handoff: a declared produced capsule counts only when the
      // file actually exists under the run-group artifact root. Config alone
      // never satisfies the handoff.
      verifyProducedCapsules({
        ctx,
        artifactRoot: input.artifactRoot,
        fileExists,
      }),
  });

  // Journal every considered sub-stage (admission + terminal) from the
  // deterministic outcomes. Done after the sequence so a fail-closed sub-stage
  // is recorded uniformly and there is no interleaving with dispatch.
  await journalSubStageOutcomes({
    outcomes: decomposed.outcomes,
    subStageJobs,
    subStageNames,
    issue: input.issue,
    attempt: input.attempt,
    now: input.now,
    appendJournalEntry: input.appendJournalEntry,
  });

  return aggregateRunResult({
    decomposed,
    issue: input.issue,
    attempt: input.attempt,
    now: input.now,
  });
}

function composeSubStageStageName(
  parentStageName: string | null,
  subStageName: string,
): string {
  return parentStageName === null
    ? subStageName
    : `${parentStageName}/${subStageName}`;
}

const DELEGATED_STAGE_EXECUTION_BACKENDS: ReadonlySet<string> = new Set([
  "crabrunner",
]);

function assertSubStagesAreDelegated(
  subStages: readonly StageExecutionSubStage[],
): void {
  for (const subStage of subStages) {
    const backend = subStage.execution.backend;
    if (!DELEGATED_STAGE_EXECUTION_BACKENDS.has(backend)) {
      throw new Error(
        `Decomposed sub-stage "${subStage.name}" declares a non-delegated backend "${backend}". Decomposed stages may only run delegated lanes (crabrunner); the capsule-scoped runner input drops the stage/modePolicy/rework context a current-runner lane needs.`,
      );
    }
  }
}

function requireSubStageJob(
  subStageJobs: readonly StageExecutionJobSpec[],
  ctx: DecomposedSubStageContext,
): StageExecutionJobSpec {
  const job = subStageJobs[ctx.index];
  if (job === undefined) {
    throw new Error(
      `No prebuilt job spec for sub-stage index ${ctx.index} ("${ctx.name}").`,
    );
  }
  return job;
}

function buildCapsuleScopedRunnerInput(input: {
  issue: Issue;
  attempt: number | null;
  stageName: string | null;
  signal?: AbortSignal;
  ctx: DecomposedSubStageContext;
}): AgentRunInput {
  // Capsule handoff replaces prior-stage context: only issue / attempt / signal
  // / stageName are threaded. Deliberately NOT set:
  // implementationCommentDeltas, workpadContext, acceptanceCriteria,
  // reworkCount — the sub-stage consumes its inputs by capsule path.
  //
  // NOTE(SYMPH-856 / SYMPH-857): `stage` is also intentionally absent here. The
  // crabrunner backend's default prompt resolver renders `promptTemplate ??
  // runnerInput.stage?.prompt ?? config.promptTemplate`; with no promptTemplate
  // or `stage`, a decomposed sub-stage lane renders the WORKFLOW-GLOBAL
  // promptTemplate. That is the only prompt the config model exposes today — a
  // sub-stage (`StageExecutionSubStage`) carries a `StageExecutionProfile` with
  // NO prompt field. Per-sub-stage prompts (so investigate/plan/implement get
  // phase-specific prompts) are a config-schema change tracked in SYMPH-857;
  // they are required before a *decomposed* canary but do not block the
  // single-transition canary (SYMPH-852/808), which carries the full
  // StageDefinition prompt.
  return {
    issue: input.issue,
    attempt: input.attempt,
    ...(input.signal === undefined ? {} : { signal: input.signal }),
    stageName: input.stageName,
  };
}

function verifyProducedCapsules(input: {
  ctx: DecomposedSubStageContext;
  artifactRoot: string;
  fileExists: CapsuleFileExistsFn;
}): readonly string[] {
  const declared = input.ctx.execution.capsules.produce;
  const present: string[] = [];
  for (const capsulePath of declared) {
    const absolutePath = resolveCapsulePathWithinRoot(
      input.artifactRoot,
      capsulePath,
    );
    // A path that escapes the artifact root (absolute or `..` traversal) is
    // rejected (null) so an unrelated existing file can never count as a
    // produced capsule. A declared-but-absent path is also not-produced — both
    // fail closed. (SYMPH-852 Track: path traversal)
    if (absolutePath !== null && input.fileExists(absolutePath)) {
      present.push(capsulePath);
    }
  }
  return present;
}

/**
 * Resolve a declared capsule path against the run-group artifact root, confined
 * to a file STRICTLY UNDER that root. Returns null for:
 *   - an absolute path,
 *   - an empty or "." path (which would resolve to the root directory itself),
 *   - any `..` traversal that escapes the root,
 *   - any path that resolves to the root itself (not a file under it),
 * so the fail-closed "produced under the artifact root" guarantee holds and a
 * capsule can never "produce" the artifact-root directory. (SYMPH-852 T3)
 */
function resolveCapsulePathWithinRoot(
  artifactRoot: string,
  capsulePath: string,
): string | null {
  const trimmed = capsulePath.trim();
  if (trimmed === "" || trimmed === "." || isAbsolute(trimmed)) {
    return null;
  }
  const root = resolve(artifactRoot);
  const resolved = resolve(root, trimmed);
  // Must be strictly under the root — the root itself is not a produced capsule.
  if (!resolved.startsWith(root + sep)) {
    return null;
  }
  return resolved;
}

function readStageTotalTokens(liveSession: LiveSession): number {
  // Prefer the per-stage rollup; fall back to the codex live total ONLY when the
  // rollup is genuinely absent/non-finite. A legitimate 0 (e.g. a zero-turn or
  // synthesized sub-stage) is accepted as 0 — treating 0 as "unset" would fall
  // back to codexTotalTokens and inflate per-sub-stage spend, falsely tripping a
  // budget breach. (SYMPH-852 P2-1)
  const stageTotal = liveSession.totalStageTotalTokens;
  if (Number.isFinite(stageTotal) && stageTotal >= 0) {
    return stageTotal;
  }
  return liveSession.codexTotalTokens;
}

interface JournalSubStageOutcomesInput {
  // `outcomes`, `subStageJobs`, and `subStageNames` are index-aligned (one per
  // declared sub-stage; outcomes covers each considered sub-stage).
  outcomes: readonly DecomposedSubStageOutcome[];
  subStageJobs: readonly StageExecutionJobSpec[];
  /** Per-sub-stage composite names (parent/sub-stage), index-aligned. */
  subStageNames: readonly string[];
  issue: Issue;
  attempt: number | null;
  now: () => Date;
  appendJournalEntry: (draft: DispatcherRunJournalEntryDraft) => Promise<void>;
}

async function journalSubStageOutcomes(
  input: JournalSubStageOutcomesInput,
): Promise<void> {
  // `attempt ?? 0` MUST match the job-identity stageAttempt coercion in
  // createStageExecutionJobSpec (job-spec.ts uses `attempt ?? 0`); the delegated
  // journal's stageAttempt has to equal the job's so the projection correlates.
  const stageAttempt = input.attempt ?? 0;
  for (const [index, outcome] of input.outcomes.entries()) {
    const job = input.subStageJobs[index];
    if (job === undefined) {
      continue;
    }
    const runGroupId = job.identity.runGroupId;
    const attemptIdempotencyKey = job.identity.idempotencyKey;
    // Composite (parent/sub-stage) name keys the SYMPH-811 projection uniquely
    // per sub-stage, matching the job identity. Falls back to the bare outcome
    // name only if names somehow drift out of alignment.
    const stageName = input.subStageNames[index] ?? outcome.name;
    const usage = stageUsageOfOutcome(outcome, job);
    const producedCapsulePaths = [...outcome.producedCapsulePaths];

    // Distinct timestamps for running vs terminal aid operator observability.
    // NOTE: the projection reduces by JOURNAL SEQUENCE, not timestamp, and
    // running/terminal already carry distinct idempotency keys — the timestamps
    // are observability only, never the correctness ordering.
    // Admission: the sub-stage entered the sequence ("running").
    await input.appendJournalEntry(
      buildDelegatedStageAttemptJournalEntry({
        issueId: input.issue.id,
        issueIdentifier: input.issue.identifier,
        runGroupId,
        // The projection keys per (runGroupId, stageName); the builder also sets
        // the journal entry's `stage` field to this same composite name.
        stageName,
        stageAttempt,
        status: "running",
        attemptIdempotencyKey,
        timestamp: input.now().toISOString(),
        summary: `delegated ${stageName} attempt ${stageAttempt}: running`,
      }),
    );

    // Terminal: the sub-stage's resolved outcome.
    await input.appendJournalEntry(
      buildDelegatedStageAttemptJournalEntry({
        issueId: input.issue.id,
        issueIdentifier: input.issue.identifier,
        runGroupId,
        stageName,
        stageAttempt,
        status: terminalStatusOfOutcome(outcome),
        attemptIdempotencyKey,
        failureClass: failureClassOfOutcome(outcome),
        ...(usage === null ? {} : { usage }),
        artifactPaths: producedCapsulePaths,
        timestamp: input.now().toISOString(),
        summary: `delegated ${stageName} attempt ${stageAttempt}: ${outcome.status}`,
      }),
    );
  }
}

function terminalStatusOfOutcome(
  outcome: DecomposedSubStageOutcome,
): Exclude<DelegatedStageAttemptStatus, "ignored_late_result"> {
  switch (outcome.status) {
    case "succeeded":
      return "succeeded";
    case "degraded":
      return "degraded";
    // A budget breach is a terminal failure of the sub-stage attempt; the
    // distinguishing detail is carried in failureClass.
    case "budget_exceeded":
    case "failed":
      return "failed";
  }
}

function failureClassOfOutcome(
  outcome: DecomposedSubStageOutcome,
): string | null {
  if (outcome.status === "budget_exceeded") {
    return "budget_exceeded";
  }
  if (outcome.status === "failed") {
    return outcome.result === null && outcome.missingCapsules.length > 0
      ? "missing_required_capsule"
      : "sub_stage_failed";
  }
  return null;
}

function stageUsageOfOutcome(
  outcome: DecomposedSubStageOutcome,
  job: StageExecutionJobSpec,
): StageUsageMeasurement | null {
  const liveSession = outcome.result?.result.liveSession;
  if (liveSession === undefined) {
    return null;
  }
  if (
    liveSession.usageMeasurement !== undefined &&
    liveSession.usageMeasurement !== null
  ) {
    return liveSession.usageMeasurement;
  }
  // Derive a usage measurement from the live-session counters when the runner
  // did not attach one. Unavailable counts stay unavailable (never zeroed).
  return mapCrabrunnerUsageToStageUsage({
    usage: {
      inputTokens: liveSession.totalStageInputTokens,
      outputTokens: liveSession.totalStageOutputTokens,
      totalTokens: readStageTotalTokens(liveSession),
      cacheReadTokens: liveSession.totalStageCacheReadTokens,
      cacheWriteTokens: liveSession.totalStageCacheWriteTokens,
      reasoningTokens: liveSession.codexReasoningTokens,
    },
    runnerKind: job.runner.runnerKind,
    provider: job.runner.provider,
    model: job.runner.model,
    profile: job.identity.profileId,
  });
}

interface AggregateRunResultInput {
  decomposed: DecomposedStageResult;
  issue: Issue;
  attempt: number | null;
  now: () => Date;
}

/**
 * Fold the sub-stage outcomes into ONE AgentRunResult for the runtime-host's
 * single finalization. Contract:
 *   - Token COUNTERS on the live session are SUMMED across all dispatched
 *     sub-stages (cumulative spend).
 *   - All other (non-counter) LiveSession fields and the session/run identity
 *     come from the TERMINAL (last-dispatched) sub-stage. This is correct
 *     because `runDecomposedStage` stops at the first failure, so the
 *     last-dispatched sub-stage IS the terminal state of the sequence.
 *   - `hardStop` is set explicitly whenever `stopReason !== "completed"`, so a
 *     non-completed sequence pauses finalization rather than transitioning
 *     forward — independent of the basis sub-stage's own result.
 */
function aggregateRunResult(input: AggregateRunResultInput): AgentRunResult {
  const dispatched = input.decomposed.outcomes.filter(
    (
      outcome,
    ): outcome is DecomposedSubStageOutcome & {
      result: NonNullable<DecomposedSubStageOutcome["result"]>;
    } => outcome.result !== null,
  );

  const hardStop = hardStopForStopReason(input.decomposed);

  if (dispatched.length === 0) {
    // Nothing dispatched (e.g. first sub-stage's required capsule missing):
    // synthesize a minimal result so finalization still performs one
    // transition. The hardStop is always present here (stopReason !== completed).
    // startedAt uses the actual clock — never the epoch — so finalization does
    // not report a decades-long duration. (SYMPH-852 P2-3)
    return {
      issue: input.issue,
      workspace: {
        path: "",
        workspaceKey: input.issue.id,
        createdNow: false,
      },
      runAttempt: {
        issueId: input.issue.id,
        issueIdentifier: input.issue.identifier,
        attempt: input.attempt,
        workspacePath: "",
        startedAt: input.now().toISOString(),
        status: "failed",
      },
      liveSession: createEmptyLiveSession(),
      turnsCompleted: 0,
      lastTurn: null,
      rateLimits: null,
      ...(hardStop === null ? {} : { hardStop }),
    };
  }

  // Base the aggregate on the LAST dispatched sub-stage's real result, then
  // overwrite the live-session token rollups with the cross-sub-stage sums.
  // `dispatched` is non-empty here (the empty case returned above); the
  // explicit guard keeps the access type-safe without a non-null assertion.
  const lastDispatched = dispatched.at(-1);
  if (lastDispatched === undefined) {
    throw new Error(
      "Unreachable: dispatched sub-stage list is empty after the empty-case guard.",
    );
  }
  const last = lastDispatched.result.result;
  const summedLiveSession = sumLiveSessions(
    dispatched.map((outcome) => outcome.result.result.liveSession),
    last.liveSession,
  );

  return {
    ...last,
    issue: input.issue,
    liveSession: summedLiveSession,
    ...(hardStop === null ? {} : { hardStop }),
  };
}

function sumLiveSessions(
  sessions: readonly LiveSession[],
  base: LiveSession,
): LiveSession {
  const sum = (pick: (session: LiveSession) => number): number =>
    sessions.reduce((total, session) => total + pick(session), 0);

  return {
    ...base,
    codexInputTokens: sum((s) => s.codexInputTokens),
    codexOutputTokens: sum((s) => s.codexOutputTokens),
    codexTotalTokens: sum((s) => s.codexTotalTokens),
    codexCacheReadTokens: sum((s) => s.codexCacheReadTokens),
    codexCacheWriteTokens: sum((s) => s.codexCacheWriteTokens),
    codexNoCacheTokens: sum((s) => s.codexNoCacheTokens),
    codexReasoningTokens: sum((s) => s.codexReasoningTokens),
    codexTotalInputTokens: sum((s) => s.codexTotalInputTokens),
    codexTotalOutputTokens: sum((s) => s.codexTotalOutputTokens),
    turnCount: sum((s) => s.turnCount),
    totalStageInputTokens: sum((s) => s.totalStageInputTokens),
    totalStageOutputTokens: sum((s) => s.totalStageOutputTokens),
    totalStageTotalTokens: sum((s) => s.totalStageTotalTokens),
    totalStageCacheReadTokens: sum((s) => s.totalStageCacheReadTokens),
    totalStageCacheWriteTokens: sum((s) => s.totalStageCacheWriteTokens),
  };
}

/**
 * Map a decomposed stop reason onto a HardStopDecision-shaped value. Returns
 * null only for a clean "completed" sequence; any non-completed stop yields a
 * non-null hard stop so finalization pauses rather than transitioning forward.
 */
function hardStopForStopReason(
  decomposed: DecomposedStageResult,
): HardStopDecision | null {
  if (decomposed.stopReason === "completed") {
    return null;
  }
  const totalTokens = decomposed.cumulativeSpentTokens;
  const turnCount = decomposed.outcomes.reduce(
    (total, outcome) =>
      total + (outcome.result?.result.liveSession.turnCount ?? 0),
    0,
  );
  const estimatedCostUsd = estimatedCostUsdOfOutcomes(decomposed.outcomes);
  if (decomposed.stopReason === "budget_exceeded") {
    return {
      outcome: "PAUSED-budget",
      trigger: "token_budget",
      reason:
        "Decomposed stage paused: a sub-stage exceeded its per-sub-stage token ceiling.",
      turnCount,
      totalTokens,
      estimatedCostUsd,
    };
  }
  // missing_required_capsule and sub_stage_failed both surface as a
  // needs-human block; the orchestrator's failure classification (journal-
  // derived) decides retry vs park from here.
  return {
    outcome: "BLOCKED-needs-human",
    trigger: "worker_reported_block",
    reason:
      decomposed.stopReason === "missing_required_capsule"
        ? "Decomposed stage blocked: a required handoff capsule was not produced."
        : "Decomposed stage blocked: a sub-stage failed before the sequence completed.",
    turnCount,
    totalTokens,
    estimatedCostUsd,
  };
}

function estimatedCostUsdOfOutcomes(
  outcomes: readonly DecomposedSubStageOutcome[],
): number {
  const total = outcomes.reduce((sum, outcome) => {
    const amount =
      outcome.result?.result.liveSession.usageMeasurement?.cost.amountUsd;
    return typeof amount === "number" && Number.isFinite(amount) && amount >= 0
      ? sum + amount
      : sum;
  }, 0);
  return Math.round(total * 1_000_000) / 1_000_000;
}
