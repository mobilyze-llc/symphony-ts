import { statSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";

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
 * Journaling model: each considered sub-stage is journaled twice — an admission
 * (`running`) entry and a terminal (`succeeded`/`failed`/`degraded`) entry —
 * keyed in the projection by `(runGroupId, sub-stage name)`. The entries are
 * emitted from the deterministic `DecomposedStageResult.outcomes` after the
 * sequence resolves, so a fail-closed sub-stage (a missing required capsule,
 * which never dispatches) is recorded uniformly with the dispatched ones, and
 * there is no interleaving hazard with the dispatch loop. Replaying
 * running→terminal yields the terminal state, exactly the projection contract.
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

  // Build the per-sub-stage job specs up front so the journal entries can use a
  // stable idempotency key per sub-stage. Index-aligned with `subStages`.
  const subStageJobs = input.subStages.map((subStage) =>
    input.createStageExecutionJobSpec({
      execution: subStage.execution,
      stageName: input.stageName,
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
          stageName: input.stageName,
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
    issue: input.issue,
    parentStageName: input.stageName,
    attempt: input.attempt,
    timestamp: input.now().toISOString(),
    appendJournalEntry: input.appendJournalEntry,
  });

  return aggregateRunResult({
    decomposed,
    issue: input.issue,
    attempt: input.attempt,
  });
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
    const absolutePath = resolveCapsulePath(input.artifactRoot, capsulePath);
    if (input.fileExists(absolutePath)) {
      present.push(capsulePath);
    }
    // A declared-but-absent path is treated as not-produced — fail closed.
  }
  return present;
}

function resolveCapsulePath(artifactRoot: string, capsulePath: string): string {
  return isAbsolute(capsulePath)
    ? capsulePath
    : resolve(artifactRoot, capsulePath);
}

function readStageTotalTokens(liveSession: LiveSession): number {
  // Prefer the per-stage rollup; fall back to the codex live total. Both are
  // monotonically accumulated counters on the live session.
  const stageTotal = liveSession.totalStageTotalTokens;
  if (Number.isFinite(stageTotal) && stageTotal > 0) {
    return stageTotal;
  }
  return liveSession.codexTotalTokens;
}

interface JournalSubStageOutcomesInput {
  // `outcomes` and `subStageJobs` are index-aligned (one job per declared
  // sub-stage, one outcome per considered sub-stage).
  outcomes: readonly DecomposedSubStageOutcome[];
  subStageJobs: readonly StageExecutionJobSpec[];
  issue: Issue;
  parentStageName: string | null;
  attempt: number | null;
  timestamp: string;
  appendJournalEntry: (draft: DispatcherRunJournalEntryDraft) => Promise<void>;
}

async function journalSubStageOutcomes(
  input: JournalSubStageOutcomesInput,
): Promise<void> {
  const stageAttempt = input.attempt ?? 0;
  for (const [index, outcome] of input.outcomes.entries()) {
    const job = input.subStageJobs[index];
    if (job === undefined) {
      continue;
    }
    const runGroupId = job.identity.runGroupId;
    const attemptIdempotencyKey = job.identity.idempotencyKey;
    const usage = stageUsageOfOutcome(outcome, job);
    const producedCapsulePaths = [...outcome.producedCapsulePaths];

    // Admission: the sub-stage entered the sequence ("running").
    await input.appendJournalEntry(
      buildDelegatedStageAttemptJournalEntry({
        issueId: input.issue.id,
        issueIdentifier: input.issue.identifier,
        runGroupId,
        // The projection keys per (runGroupId, sub-stage name), so each
        // sub-stage gets its own row. The builder also sets the journal entry's
        // `stage` field to this same sub-stage name.
        stageName: outcome.name,
        stageAttempt,
        status: "running",
        attemptIdempotencyKey,
        timestamp: input.timestamp,
        summary: `delegated ${input.parentStageName ?? "stage"} / ${outcome.name} attempt ${stageAttempt}: running`,
      }),
    );

    // Terminal: the sub-stage's resolved outcome.
    await input.appendJournalEntry(
      buildDelegatedStageAttemptJournalEntry({
        issueId: input.issue.id,
        issueIdentifier: input.issue.identifier,
        runGroupId,
        stageName: outcome.name,
        stageAttempt,
        status: terminalStatusOfOutcome(outcome),
        attemptIdempotencyKey,
        failureClass: failureClassOfOutcome(outcome),
        ...(usage === null ? {} : { usage }),
        artifactPaths: producedCapsulePaths,
        timestamp: input.timestamp,
        summary: `delegated ${input.parentStageName ?? "stage"} / ${outcome.name} attempt ${stageAttempt}: ${outcome.status}`,
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
}

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
        startedAt: new Date(0).toISOString(),
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
  if (decomposed.stopReason === "budget_exceeded") {
    return {
      outcome: "PAUSED-budget",
      trigger: "token_budget",
      reason:
        "Decomposed stage paused: a sub-stage exceeded its per-sub-stage token ceiling.",
      turnCount,
      totalTokens,
      estimatedCostUsd: 0,
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
    estimatedCostUsd: 0,
  };
}
