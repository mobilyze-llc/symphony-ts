/**
 * SYMPH-406 + SYMPH-401: replay-reduced explicit-resume marks and durable
 * escalation/triage/spend counters.
 *
 * Both tickets collapse into the SYMPH-405 journal: the marks and counters
 * are REDUCED from already-journaled events at startup (recoverFromRunJournal)
 * instead of living in a bespoke persistence store. These tests restart the
 * orchestrator by handing one core's journal to a fresh core.
 */
import { describe, expect, it, vi } from "vitest";

import type { ResolvedWorkflowConfig } from "../../src/config/types.js";
import type {
  DispatcherDecisionEvent,
  DispatcherLease,
  DispatcherRunJournal,
  DispatcherRunJournalEntry,
  Issue,
} from "../../src/domain/model.js";
import { normalizeErrorSignature } from "../../src/errors/signature.js";
import { compactDispatcherRunJournalWithCheckpoint } from "../../src/logging/run-journal.js";
import { buildRuntimeSnapshot } from "../../src/logging/runtime-snapshot.js";
import {
  OrchestratorCore,
  type OrchestratorCoreOptions,
} from "../../src/orchestrator/core.js";
import type { IssueTracker } from "../../src/tracker/tracker.js";

const NOW = new Date("2026-06-12T00:00:05.000Z");
const WATCHDOG_SIGNATURE = normalizeErrorSignature(
  "worker exited: EPERM: operation not permitted, open '.git/index.lock'",
);

const BUDGET_PAUSE = {
  outcome: "PAUSED-budget" as const,
  trigger: "token_budget" as const,
  reason: "Token budget exceeded: 250001 >= 250000.",
  turnCount: 2,
  totalTokens: 250_001,
  estimatedCostUsd: 5.2,
};

describe("SYMPH-406: requires-explicit-resume marks are persistent and visible", () => {
  it("surfaces the mark in the snapshot with reason + event cursor, and the skip emits a deduped verdict", async () => {
    const orchestrator = createOrchestrator();

    await orchestrator.pollTick();
    await orchestrator.onWorkerExit({
      issueId: "1",
      outcome: "normal",
      hardStop: BUDGET_PAUSE,
    });

    expect(orchestrator.getState().resumeRequired.has("1")).toBe(true);

    const hardStopEntry = orchestrator
      .getState()
      .dispatcherRunJournal.find(
        (entry) =>
          entry.kind === "hard_stop_trigger" &&
          entry.metadata.outcome === "PAUSED-budget",
      );
    expect(hardStopEntry).toBeDefined();

    const snapshot = buildRuntimeSnapshot(orchestrator.getState(), {
      now: NOW,
    });
    expect(snapshot.explicit_resume_required?.["1"]).toEqual({
      reason: "hard_stop:token_budget",
      set_by_sequence: hardStopEntry?.sequence,
      since: expect.any(String),
    });

    // Todo alone is skipped — loudly, once.
    const todoIssue = createIssue({ id: "1", state: "Todo" });
    expect(orchestrator.isDispatchEligible(todoIssue)).toBe(false);
    expect(orchestrator.isDispatchEligible(todoIssue)).toBe(false);
    const skips = verdictEntries(orchestrator).filter(
      (entry) => entry.metadata.reason_code === "requires_explicit_resume",
    );
    expect(skips).toHaveLength(1);
    expect(skips[0]?.metadata.disposition).toBe("skip");
  });

  it("preserves the mark across a restart via journal replay; a skipped Todo issue still says so", async () => {
    const orchestrator = createOrchestrator();
    await orchestrator.pollTick();
    await orchestrator.onWorkerExit({
      issueId: "1",
      outcome: "normal",
      hardStop: BUDGET_PAUSE,
    });
    const todoIssue = createIssue({ id: "1", state: "Todo" });
    expect(orchestrator.isDispatchEligible(todoIssue)).toBe(false);
    const hardStopSequence = orchestrator
      .getState()
      .dispatcherRunJournal.find(
        (entry) => entry.kind === "hard_stop_trigger",
      )?.sequence;

    // Restart: a fresh core reduces the same journal back into state.
    const restarted = createOrchestrator({
      runJournal: orchestrator.getState().dispatcherRunJournal,
    });

    expect(restarted.getState().resumeRequired.has("1")).toBe(true);
    const snapshot = buildRuntimeSnapshot(restarted.getState(), { now: NOW });
    expect(snapshot.explicit_resume_required?.["1"]).toMatchObject({
      reason: "hard_stop:token_budget",
      set_by_sequence: hardStopSequence,
    });

    // The skip is still visible post-restart: the disposition replayed and
    // a fresh eligibility check stays deduped (no duplicate verdict entry).
    expect(restarted.isDispatchEligible(todoIssue)).toBe(false);
    expect(restarted.getState().issueDispositions["1"]).toMatchObject({
      disposition: "skip",
      reasonCode: "requires_explicit_resume",
    });
    expect(
      verdictEntries(restarted).filter(
        (entry) => entry.metadata.reason_code === "requires_explicit_resume",
      ),
    ).toHaveLength(1);
  });

  it("clears the mark only via the fenced release verb with actor attribution in the Linear comment", async () => {
    const comments: string[] = [];
    const orchestrator = createOrchestrator({
      postComment: async (_issueId, body) => {
        comments.push(body);
      },
    });

    const parked = await orchestrator.writeIntent({
      verb: "park",
      issueId: "1",
      issueIdentifier: "ISSUE-1",
      actor: { kind: "operator", host: "pro14" },
      reason: { class: "manual_park", human: "operator parked for review" },
      issueState: "In Progress",
    });
    expect(parked.status).toBe("applied");

    let snapshot = buildRuntimeSnapshot(orchestrator.getState(), { now: NOW });
    expect(snapshot.explicit_resume_required?.["1"]).toMatchObject({
      reason: "intent:park:manual_park",
      set_by_sequence: parked.sequence,
    });

    // A stale fence is rejected and the mark stands.
    const stale = await orchestrator.writeIntent({
      verb: "release",
      issueId: "1",
      issueIdentifier: "ISSUE-1",
      actor: { kind: "operator", host: "pro14" },
      reason: { class: "manual_release", human: "stale release" },
      fence: { expectedParkSeq: 9_999 },
    });
    expect(stale.status).toBe("rejected_stale");
    expect(orchestrator.getState().resumeRequired.has("1")).toBe(true);

    // The current park generation is journaled on the park entry; a
    // correctly fenced release clears the mark and renders attribution.
    const parkEntry = orchestrator
      .getState()
      .dispatcherRunJournal.find((entry) => entry.sequence === parked.sequence);
    const generation = parkEntry?.metadata.parkGeneration as number;
    const released = await orchestrator.writeIntent({
      verb: "release",
      issueId: "1",
      issueIdentifier: "ISSUE-1",
      actor: { kind: "operator", host: "pro14" },
      reason: { class: "manual_release", human: "reviewed; releasing" },
      fence: { expectedParkSeq: generation },
    });
    expect(released.status).toBe("applied");
    expect(orchestrator.getState().resumeRequired.has("1")).toBe(false);
    snapshot = buildRuntimeSnapshot(orchestrator.getState(), { now: NOW });
    expect(snapshot.explicit_resume_required?.["1"]).toBeUndefined();
    expect(
      comments.some(
        (body) =>
          body.includes("Intent applied: release") &&
          body.includes("by operator@pro14"),
      ),
    ).toBe(true);
  });

  it("converges a replayed park → release on released (mark stays cleared after restart)", async () => {
    const orchestrator = createOrchestrator();
    await orchestrator.writeIntent({
      verb: "park",
      issueId: "1",
      issueIdentifier: "ISSUE-1",
      actor: { kind: "operator", host: "pro14" },
      reason: { class: "manual_park", human: "park" },
    });
    await orchestrator.writeIntent({
      verb: "release",
      issueId: "1",
      issueIdentifier: "ISSUE-1",
      actor: { kind: "operator", host: "pro14" },
      reason: { class: "manual_release", human: "release" },
    });

    const restarted = createOrchestrator({
      runJournal: orchestrator.getState().dispatcherRunJournal,
    });
    expect(restarted.getState().resumeRequired.has("1")).toBe(false);
    const snapshot = buildRuntimeSnapshot(restarted.getState(), { now: NOW });
    expect(snapshot.explicit_resume_required).toEqual({});
  });
});

describe("SYMPH-401: budget-escalation steps survive restarts", () => {
  it("resumes the ladder at step 2 after a restart with no duplicate step-1 event", async () => {
    const config = createConfig({
      budgetEscalation: { maxSteps: 3, multiplier: 2 },
    });
    const orchestrator = createOrchestrator({ config });

    await orchestrator.pollTick();
    const first = await orchestrator.onWorkerExit({
      issueId: "1",
      outcome: "normal",
      hardStop: BUDGET_PAUSE,
    });
    expect(first?.delayType).toBe("continuation");
    await orchestrator.onRetryTimer("1");
    const second = await orchestrator.onWorkerExit({
      issueId: "1",
      outcome: "normal",
      hardStop: BUDGET_PAUSE,
    });
    expect(second?.delayType).toBe("continuation");
    expect(orchestrator.getState().issueBudgetEscalations["1"]).toBe(2);

    // Restart: the ladder position reduces from the journaled steps.
    const restarted = createOrchestrator({
      config,
      runJournal: orchestrator.getState().dispatcherRunJournal,
    });
    expect(restarted.getState().issueBudgetEscalations["1"]).toBe(2);
    expect(restarted.budgetMultiplierForIssue("1")).toBe(4);

    // The next pause escalates to step 3 — not back to step 1.
    await restarted.pollTick();
    const third = await restarted.onWorkerExit({
      issueId: "1",
      outcome: "normal",
      hardStop: BUDGET_PAUSE,
    });
    expect(third?.delayType).toBe("continuation");
    expect(restarted.getState().issueBudgetEscalations["1"]).toBe(3);

    const escalationSteps = restarted
      .getState()
      .dispatcherRunJournal.filter(
        (entry) => entry.kind === "budget_escalation",
      )
      .map((entry) => entry.metadata.step);
    expect(escalationSteps).toEqual([1, 2, 3]);
  });
});

describe("SYMPH-401: pause-triage resume counts survive restarts", () => {
  it("enforces the authorized-resume cap across a deploy boundary", async () => {
    const config = createConfig({
      pauseTriage: {
        baseUrl: "http://studio2.local:8000/v1",
        model: "deepseek-v4-flash",
        apiKey: null,
        maxResumes: 1,
      },
    });
    const orchestrator = createOrchestrator({
      config,
      runPauseTriage: async () => ({
        verdict: "continue",
        rationale: "Real diff in progress; one unit should finish.",
      }),
    });

    await orchestrator.pollTick();
    const resumed = await orchestrator.onWorkerExit({
      issueId: "1",
      outcome: "normal",
      hardStop: BUDGET_PAUSE,
    });
    expect(resumed?.delayType).toBe("continuation");
    expect(orchestrator.getState().issuePauseTriageResumes["1"]).toBe(1);

    // Restart: the consumed resume reduces back from the journal, so the
    // post-restart pause parks WITHOUT consulting triage again.
    const postRestartTriageCalls: string[] = [];
    const restarted = createOrchestrator({
      config,
      runJournal: orchestrator.getState().dispatcherRunJournal,
      runPauseTriage: async (evidence) => {
        postRestartTriageCalls.push(evidence.issueIdentifier);
        return { verdict: "continue", rationale: "should never be asked" };
      },
    });
    expect(restarted.getState().issuePauseTriageResumes["1"]).toBe(1);

    await restarted.pollTick();
    const parked = await restarted.onWorkerExit({
      issueId: "1",
      outcome: "normal",
      hardStop: BUDGET_PAUSE,
    });
    expect(parked).toBeNull();
    expect(postRestartTriageCalls).toEqual([]);
    expect(restarted.getState().resumeRequired.has("1")).toBe(true);
  });
});

describe("SYMPH-401: per-issue cumulative spend survives restarts", () => {
  it("reports pre-restart spend + post-restart deltas in the /state snapshot", async () => {
    const config = createConfig({ stages: createImplementStages() });
    const orchestrator = createOrchestrator({ config });
    await orchestrator.pollTick();
    expect(orchestrator.getState().issueStages["1"]).toBe("implement");
    feedTokens(orchestrator, { inputTokens: 60, outputTokens: 40 });
    await orchestrator.onWorkerExit({
      issueId: "1",
      outcome: "normal",
      hardStop: BUDGET_PAUSE,
    });
    expect(
      orchestrator.getState().issueExecutionHistory["1"]?.[0]?.totalTokens,
    ).toBe(100);

    // Restart: the stage record reduces back into execution history.
    const restarted = createOrchestrator({
      config,
      runJournal: orchestrator.getState().dispatcherRunJournal,
    });
    const replayedHistory = restarted.getState().issueExecutionHistory["1"];
    expect(replayedHistory).toHaveLength(1);
    expect(replayedHistory?.[0]).toMatchObject({
      stageName: "implement",
      totalTokens: 100,
      inputTokens: 60,
      outputTokens: 40,
    });

    // Release the park, re-dispatch, accrue a post-restart delta: the
    // snapshot's pipeline total is pre-restart + post-restart.
    const release = await restarted.writeIntent({
      verb: "release",
      issueId: "1",
      issueIdentifier: "ISSUE-1",
      actor: { kind: "operator", host: "pro14" },
      reason: { class: "manual_release", human: "resume after deploy" },
    });
    expect(release.status).toBe("applied");
    const tick = await restarted.pollTick();
    expect(tick.dispatchedIssueIds).toEqual(["1"]);
    feedTokens(restarted, { inputTokens: 30, outputTokens: 20 });

    const snapshot = buildRuntimeSnapshot(restarted.getState(), { now: NOW });
    const row = snapshot.running.find((entry) => entry.issue_id === "1");
    expect(row?.total_pipeline_tokens).toBe(150);
    expect(row?.pipeline_tokens.input_tokens).toBe(90);
    expect(row?.pipeline_tokens.output_tokens).toBe(60);
  });
});

describe("SYMPH-401 council R1: journal-first failure contracts", () => {
  it("omits a stage record from BOTH live history and replay when its journal write fails", async () => {
    const config = createConfig({ stages: createImplementStages() });
    const orchestrator = createOrchestrator({
      config,
      writeRunJournalEntry: async (entry) => {
        if (entry.kind === "stage_record") {
          throw new Error("disk full");
        }
      },
    });
    await orchestrator.pollTick();
    feedTokens(orchestrator, { inputTokens: 60, outputTokens: 40 });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      await orchestrator.onWorkerExit({
        issueId: "1",
        outcome: "normal",
        hardStop: BUDGET_PAUSE,
      });
    } finally {
      warn.mockRestore();
    }

    // Journal-first: the un-journaled spend never reached live history…
    expect(orchestrator.getState().issueExecutionHistory["1"]).toBeUndefined();
    expect(
      orchestrator
        .getState()
        .dispatcherRunJournal.filter((entry) => entry.kind === "stage_record"),
    ).toHaveLength(0);

    // …so a restart reconstructs exactly what live had (both omit).
    const restarted = createOrchestrator({
      config,
      runJournal: orchestrator.getState().dispatcherRunJournal,
    });
    expect(restarted.getState().issueExecutionHistory["1"]).toBeUndefined();
  });

  it("does not grant or count a triage resume when the verdict journal write fails; replay agrees", async () => {
    const config = createConfig({
      pauseTriage: {
        baseUrl: "http://studio2.local:8000/v1",
        model: "deepseek-v4-flash",
        apiKey: null,
        maxResumes: 1,
      },
    });
    const orchestrator = createOrchestrator({
      config,
      runPauseTriage: async () => ({
        verdict: "continue",
        rationale: "Real diff in progress; one unit should finish.",
      }),
      writeRunJournalEntry: async (entry) => {
        if (entry.kind === "pause_triage") {
          throw new Error("disk full");
        }
      },
    });

    await orchestrator.pollTick();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    let parked: unknown;
    try {
      parked = await orchestrator.onWorkerExit({
        issueId: "1",
        outcome: "normal",
        hardStop: BUDGET_PAUSE,
      });
    } finally {
      warn.mockRestore();
    }

    // The resume was NOT authorized: the issue parked and no resume was
    // consumed, so memory matches the (resume-less) journal.
    expect(parked).toBeNull();
    expect(orchestrator.getState().resumeRequired.has("1")).toBe(true);
    expect(
      orchestrator.getState().issuePauseTriageResumes["1"],
    ).toBeUndefined();

    // Replay reconstructs the same count: the cap (1) is still fully
    // available after a restart instead of having been silently consumed.
    const restarted = createOrchestrator({
      config,
      runJournal: orchestrator.getState().dispatcherRunJournal,
    });
    expect(restarted.getState().issuePauseTriageResumes["1"]).toBeUndefined();
    expect(restarted.getState().resumeRequired.has("1")).toBe(true);
  });
});

describe("SYMPH-401 council R1: terminal completion clears replayed counters", () => {
  it("does not resurrect escalation/triage/spend state for an issue live completed terminally (non-gate path)", async () => {
    const config = createConfig({
      stages: createImplementToTerminalStages(),
      budgetEscalation: { maxSteps: 3, multiplier: 2 },
    });
    const orchestrator = createOrchestrator({
      config,
      updateIssueState: async () => {},
    });

    await orchestrator.pollTick();
    feedTokens(orchestrator, { inputTokens: 60, outputTokens: 40 });
    const escalated = await orchestrator.onWorkerExit({
      issueId: "1",
      outcome: "normal",
      hardStop: BUDGET_PAUSE,
    });
    expect(escalated?.delayType).toBe("continuation");
    expect(orchestrator.getState().issueBudgetEscalations["1"]).toBe(1);

    await orchestrator.onRetryTimer("1");
    feedTokens(orchestrator, { inputTokens: 30, outputTokens: 20 });
    await orchestrator.onWorkerExit({ issueId: "1", outcome: "normal" });
    expect(orchestrator.getState().completed.has("1")).toBe(true);

    // Let the fire-and-forget terminal tracker write land its completed
    // journal entry (the replay evidence).
    await new Promise((resolve) => setImmediate(resolve));
    await new Promise((resolve) => setImmediate(resolve));
    const terminalEvidence = orchestrator
      .getState()
      .dispatcherRunJournal.find(
        (entry) =>
          entry.kind === "tracker_write" &&
          entry.idempotencyKey.includes(":terminal:") &&
          entry.idempotencyKey.endsWith(":completed"),
      );
    expect(terminalEvidence).toBeDefined();

    // Restart: replay must not leave the completed issue's counters behind.
    const restarted = createOrchestrator({
      config,
      runJournal: orchestrator.getState().dispatcherRunJournal,
    });
    expect(restarted.getState().completed.has("1")).toBe(true);
    expect(restarted.getState().issueBudgetEscalations["1"]).toBeUndefined();
    expect(restarted.getState().issuePauseTriageResumes["1"]).toBeUndefined();
    expect(restarted.getState().issueExecutionHistory["1"]).toBeUndefined();
    expect(restarted.getState().resumeRequired.has("1")).toBe(false);
  });
});

describe("SYMPH-401 council R2: terminal completion without a tracker write still leaves replay evidence", () => {
  it("clears replayed counters/marks after completing into a terminal stage whose linear_state is null", async () => {
    const stages = createImplementToTerminalStages();
    const doneStage = stages.stages.done;
    if (doneStage === undefined) {
      throw new Error("fixture missing done stage");
    }
    doneStage.linearState = null;
    const config = createConfig({
      stages,
      budgetEscalation: { maxSteps: 3, multiplier: 2 },
    });
    // No updateIssueState either — together with linearState null this is
    // the config shape where no terminal tracker write can fire, so the
    // synthetic evidence entry is the only replay signal.
    const orchestrator = createOrchestrator({ config });

    await orchestrator.pollTick();
    feedTokens(orchestrator, { inputTokens: 60, outputTokens: 40 });
    const escalated = await orchestrator.onWorkerExit({
      issueId: "1",
      outcome: "normal",
      hardStop: BUDGET_PAUSE,
    });
    expect(escalated?.delayType).toBe("continuation");
    expect(orchestrator.getState().issueBudgetEscalations["1"]).toBe(1);

    await orchestrator.onRetryTimer("1");
    feedTokens(orchestrator, { inputTokens: 30, outputTokens: 20 });
    await orchestrator.onWorkerExit({ issueId: "1", outcome: "normal" });
    expect(orchestrator.getState().completed.has("1")).toBe(true);

    // Let the fire-and-forget synthetic evidence write land.
    await new Promise((resolve) => setImmediate(resolve));
    await new Promise((resolve) => setImmediate(resolve));
    const terminalEvidence = orchestrator
      .getState()
      .dispatcherRunJournal.find(
        (entry) =>
          entry.kind === "tracker_write" &&
          entry.idempotencyKey.includes(":terminal:") &&
          entry.idempotencyKey.endsWith(":completed"),
      );
    expect(terminalEvidence).toBeDefined();
    expect(terminalEvidence?.metadata.skipped).toBe(true);

    // Restart: replay must not resurrect the counters the live completion
    // cleared, even though no real tracker write was ever journaled.
    const restarted = createOrchestrator({
      config,
      runJournal: orchestrator.getState().dispatcherRunJournal,
    });
    expect(restarted.getState().completed.has("1")).toBe(true);
    expect(restarted.getState().issueBudgetEscalations["1"]).toBeUndefined();
    expect(restarted.getState().issuePauseTriageResumes["1"]).toBeUndefined();
    expect(restarted.getState().issueExecutionHistory["1"]).toBeUndefined();
    expect(restarted.getState().resumeRequired.has("1")).toBe(false);
  });
});

describe("SYMPH-401: continuation re-pauses journal distinct stage records", () => {
  it("replays BOTH stage records for two exits on the same stage+attempt and sums the spend", async () => {
    const config = createConfig({
      stages: createImplementStages(),
      budgetEscalation: { maxSteps: 3, multiplier: 2 },
    });
    const orchestrator = createOrchestrator({ config });

    await orchestrator.pollTick();
    feedTokens(orchestrator, { inputTokens: 60, outputTokens: 40 });
    const first = await orchestrator.onWorkerExit({
      issueId: "1",
      outcome: "normal",
      hardStop: BUDGET_PAUSE,
    });
    expect(first?.delayType).toBe("continuation");

    await orchestrator.onRetryTimer("1");
    feedTokens(orchestrator, { inputTokens: 30, outputTokens: 20 });
    const second = await orchestrator.onWorkerExit({
      issueId: "1",
      outcome: "normal",
      hardStop: BUDGET_PAUSE,
    });
    expect(second?.delayType).toBe("continuation");

    const stageRecordEntries = orchestrator
      .getState()
      .dispatcherRunJournal.filter((entry) => entry.kind === "stage_record");
    expect(stageRecordEntries).toHaveLength(2);
    expect(stageRecordEntries[0]?.idempotencyKey).not.toBe(
      stageRecordEntries[1]?.idempotencyKey,
    );

    const restarted = createOrchestrator({
      config,
      runJournal: orchestrator.getState().dispatcherRunJournal,
    });
    const replayed = restarted.getState().issueExecutionHistory["1"];
    expect(replayed).toHaveLength(2);
    expect(
      (replayed ?? []).reduce((sum, record) => sum + record.totalTokens, 0),
    ).toBe(150);
  });
});

describe("SYMPH-406: degraded mark fallback", () => {
  it("falls back to the snapshot timestamp (never blank) and warns when a mark record is missing", async () => {
    const orchestrator = createOrchestrator();
    await orchestrator.writeIntent({
      verb: "park",
      issueId: "1",
      issueIdentifier: "ISSUE-1",
      actor: { kind: "operator", host: "pro14" },
      reason: { class: "manual_park", human: "park" },
    });
    // Simulate a writer that bypassed the mark surface.
    Reflect.deleteProperty(orchestrator.getState().resumeRequiredMarks, "1");

    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const snapshot = buildRuntimeSnapshot(orchestrator.getState(), {
        now: NOW,
      });
      expect(snapshot.explicit_resume_required["1"]).toEqual({
        reason: "stop_like_pause",
        set_by_sequence: null,
        since: NOW.toISOString(),
      });
      expect(
        warn.mock.calls.some((call) =>
          String(call[0]).includes("without a mark record"),
        ),
      ).toBe(true);
    } finally {
      warn.mockRestore();
    }
  });
});

describe("SYMPH-293: dispatcher run-journal checkpoints bound replay", () => {
  it("preserves replay state when historical rows are compacted behind a checkpoint", () => {
    const fullReplay = createOrchestrator({
      runJournal: createCheckpointSourceJournal(),
    });
    const checkpointDraft = fullReplay.createRunJournalCheckpointDraft();
    expect(checkpointDraft).not.toBeNull();

    const compaction = compactDispatcherRunJournalWithCheckpoint(
      fullReplay.getState().dispatcherRunJournal,
      checkpointDraft!,
      { tailEntryCount: 1, minEntryCount: 2 },
    );
    expect(compaction.compacted).toBe(true);
    expect(compaction.journal.map((entry) => entry.kind)).toEqual([
      "journal_checkpoint",
      "admission",
    ]);

    const restarted = createOrchestrator({
      runJournal: compaction.journal,
    });

    expect(restarted.getState().dispatcherLeases["lease-active"]).toMatchObject(
      {
        issueId: "active",
        status: "active",
      },
    );
    expect(restarted.getState().claimed.has("active")).toBe(true);
    expect(restarted.getState().resumeRequired.has("parked")).toBe(true);
    expect(restarted.getState().resumeRequiredMarks.parked).toMatchObject({
      reason: "hard_stop:token_budget",
      setBySequence: 2,
    });
    expect(restarted.getState().decorrelatedGateOutcomes.gate).toEqual([
      expect.objectContaining({
        status: "passed",
        aggregate: "pass",
        authoritative: true,
      }),
    ]);
    expect(
      buildRuntimeSnapshot(restarted.getState(), { now: NOW }).decision_quality,
    ).toMatchObject({ total: 1 });

    const checkpointMetadata = compaction.journal[0]?.metadata;
    expect(checkpointMetadata).toMatchObject({
      coveredThroughSequence: 6,
      retainedTailEntries: 1,
    });
    expect(
      (
        checkpointMetadata?.privateState as
          | { reportedIgnoredSetupInstructionCollisionSignatures?: unknown }
          | undefined
      )?.reportedIgnoredSetupInstructionCollisionSignatures,
    ).toEqual(["ignored-setup-signature"]);
  });

  it("preserves watchdog registry state when cluster and breaker rows are compacted", () => {
    const fullReplay = createOrchestrator({
      config: createConfig({ stages: createImplementStages() }),
      runJournal: createWatchdogRegistryJournal(),
    });
    const checkpointDraft = fullReplay.createRunJournalCheckpointDraft();
    expect(checkpointDraft).not.toBeNull();

    const compaction = compactDispatcherRunJournalWithCheckpoint(
      fullReplay.getState().dispatcherRunJournal,
      checkpointDraft!,
      { tailEntryCount: 1, minEntryCount: 2 },
    );

    const restarted = createOrchestrator({
      config: createConfig({ stages: createImplementStages() }),
      runJournal: compaction.journal,
    });

    expect(restarted.getWatchdogRegistrySnapshot()).toEqual({
      clusters: [
        {
          signature: WATCHDOG_SIGNATURE.signature,
          error_class: WATCHDOG_SIGNATURE.class,
          cluster_size: 2,
          member_issue_identifiers: ["SYMPH-W1", "SYMPH-W2"],
          last_alert_size: 2,
        },
      ],
      openBreakers: [
        {
          stage_name: "implement",
          signature: WATCHDOG_SIGNATURE.signature,
          opened_at: "2026-06-13T00:00:03.000Z",
          opened_for_issue_ids: ["watch-1", "watch-2"],
        },
      ],
    });
  });

  it("does not restore stale claims for checkpointed leases that expired before restart", () => {
    const fullReplay = createOrchestrator({
      runJournal: createActiveLeaseJournal(),
      now: () => new Date("2026-06-12T00:00:05.000Z"),
    });
    expect(fullReplay.getState().claimed.has("active")).toBe(true);
    const checkpointDraft = fullReplay.createRunJournalCheckpointDraft();
    expect(checkpointDraft).not.toBeNull();

    const compaction = compactDispatcherRunJournalWithCheckpoint(
      fullReplay.getState().dispatcherRunJournal,
      checkpointDraft!,
      { tailEntryCount: 1, minEntryCount: 2 },
    );
    const restartedAfterExpiry = createOrchestrator({
      runJournal: compaction.journal,
      now: () => new Date("2026-06-12T01:00:00.000Z"),
    });

    expect(
      restartedAfterExpiry.getState().dispatcherLeases["lease-active"],
    ).toMatchObject({ issueId: "active", status: "active" });
    expect(restartedAfterExpiry.getState().claimed.has("active")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function feedTokens(
  orchestrator: OrchestratorCore,
  usage: { inputTokens: number; outputTokens: number },
): void {
  orchestrator.onCodexEvent({
    issueId: "1",
    event: {
      event: "turn_completed",
      timestamp: NOW.toISOString(),
      codexAppServerPid: "1001",
      sessionId: "s1",
      threadId: "t1",
      turnId: "turn-1",
      usage: {
        inputTokens: usage.inputTokens,
        outputTokens: usage.outputTokens,
        totalTokens: usage.inputTokens + usage.outputTokens,
      },
      rateLimits: {},
      message: "done",
    },
  });
}

function verdictEntries(
  orchestrator: OrchestratorCore,
): DispatcherRunJournalEntry[] {
  return orchestrator
    .getState()
    .dispatcherRunJournal.filter((entry) => entry.kind === "dispatch_verdict");
}

function createOrchestrator(overrides?: {
  config?: ResolvedWorkflowConfig;
  runJournal?: DispatcherRunJournal;
  postComment?: OrchestratorCoreOptions["postComment"];
  runPauseTriage?: OrchestratorCoreOptions["runPauseTriage"];
  writeRunJournalEntry?: OrchestratorCoreOptions["writeRunJournalEntry"];
  updateIssueState?: OrchestratorCoreOptions["updateIssueState"];
  now?: OrchestratorCoreOptions["now"];
}): OrchestratorCore {
  const options: OrchestratorCoreOptions = {
    config: overrides?.config ?? createConfig(),
    tracker: createTracker(),
    spawnWorker: async () => ({
      workerHandle: { pid: 1001 },
      monitorHandle: { ref: "monitor-1" },
    }),
    now: overrides?.now ?? (() => NOW),
  };
  if (overrides?.runJournal !== undefined) {
    options.runJournal = overrides.runJournal;
  }
  if (overrides?.postComment !== undefined) {
    options.postComment = overrides.postComment;
  }
  if (overrides?.runPauseTriage !== undefined) {
    options.runPauseTriage = overrides.runPauseTriage;
  }
  if (overrides?.writeRunJournalEntry !== undefined) {
    options.writeRunJournalEntry = overrides.writeRunJournalEntry;
  }
  if (overrides?.updateIssueState !== undefined) {
    options.updateIssueState = overrides.updateIssueState;
  }
  return new OrchestratorCore(options);
}

function createTracker(): IssueTracker {
  return {
    async fetchCandidateIssues() {
      return [createIssue({ id: "1", identifier: "ISSUE-1" })];
    },
    async fetchIssuesByStates() {
      return [];
    },
    async fetchIssueStatesByIds() {
      return [{ id: "1", identifier: "ISSUE-1", state: "In Progress" }];
    },
  };
}

function createImplementStages(): NonNullable<
  ResolvedWorkflowConfig["stages"]
> {
  return {
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
    },
  };
}

function createImplementToTerminalStages(): NonNullable<
  ResolvedWorkflowConfig["stages"]
> {
  return {
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
        linearState: "Done",
      },
    },
  };
}

function createConfig(overrides?: {
  budgetEscalation?: ResolvedWorkflowConfig["budgetEscalation"];
  pauseTriage?: ResolvedWorkflowConfig["pauseTriage"];
  stages?: ResolvedWorkflowConfig["stages"];
}): ResolvedWorkflowConfig {
  return {
    workflowPath: "/tmp/WORKFLOW.md",
    promptTemplate: "Prompt",
    tracker: {
      kind: "linear",
      endpoint: "https://api.linear.app/graphql",
      apiKey: "token",
      projectSlug: "project",
      // NOTE: "Resume" must stay in active_states whenever stages exist or
      // validateDispatchConfig silently fails the whole pollTick.
      activeStates: ["Todo", "In Progress", "In Review", "Resume"],
      terminalStates: ["Done", "Canceled"],
    },
    polling: { intervalMs: 30_000 },
    workspace: { root: "/tmp/workspaces" },
    hooks: {
      afterCreate: null,
      beforeRun: null,
      afterRun: null,
      beforeRemove: null,
      timeoutMs: 30_000,
    },
    agent: {
      maxConcurrentAgents: 2,
      maxTurns: 5,
      maxRetryBackoffMs: 300_000,
      maxRetryAttempts: 5,
      maxConcurrentAgentsByState: {},
    },
    codex: {
      command: "codex-app-server",
      approvalPolicy: "never",
      threadSandbox: null,
      turnSandboxPolicy: null,
      turnTimeoutMs: 300_000,
      readTimeoutMs: 30_000,
      stallTimeoutMs: 300_000,
    },
    rateLimitAdmission: {
      minPrimaryHeadroomPct: null,
      minSecondaryHeadroomPct: null,
    },
    budgetEscalation: overrides?.budgetEscalation ?? {
      maxSteps: null,
      multiplier: 2,
    },
    pauseTriage: overrides?.pauseTriage ?? {
      baseUrl: null,
      model: null,
      apiKey: null,
      maxResumes: 2,
    },
    acGate: { enabled: false },
    specFidelity: { enabled: false },
    admissionCard: { enabled: false },
    watchdog: {
      systemicThreshold: 2,
      circuitBreaker: true,
      maxFilingsPerHour: 3,
    },
    server: { port: null, host: null, slackNotifyChannel: null },
    notifications: { slackEnabled: true },
    observability: {
      dashboardEnabled: true,
      refreshMs: 1_000,
      renderIntervalMs: 16,
    },
    runner: { kind: "codex", model: null },
    stages: overrides?.stages ?? null,
    escalationState: null,
  };
}

function createIssue(overrides?: Partial<Issue>): Issue {
  return {
    id: overrides?.id ?? "1",
    identifier: overrides?.identifier ?? "ISSUE-1",
    title: overrides?.title ?? "Example issue",
    description: overrides?.description ?? null,
    priority: overrides?.priority ?? 1,
    state: overrides?.state ?? "In Progress",
    branchName: overrides?.branchName ?? null,
    url: overrides?.url ?? null,
    labels: overrides?.labels ?? [],
    blockedBy: overrides?.blockedBy ?? [],
    createdAt: overrides?.createdAt ?? "2026-06-01T00:00:00.000Z",
    updatedAt: overrides?.updatedAt ?? "2026-06-01T00:00:00.000Z",
  };
}

function createCheckpointSourceJournal(): DispatcherRunJournal {
  return [
    createJournalEntry({
      sequence: 1,
      kind: "admission",
      issueId: "active",
      issueIdentifier: "SYMPH-ACTIVE",
      lease: createDispatcherLease({
        leaseId: "lease-active",
        issueId: "active",
        issueIdentifier: "SYMPH-ACTIVE",
        status: "active",
      }),
      summary: "Active issue admitted.",
    }),
    createJournalEntry({
      sequence: 2,
      kind: "hard_stop_trigger",
      issueId: "parked",
      issueIdentifier: "SYMPH-PARKED",
      summary: "Hard stop parked issue.",
      metadata: {
        status: "completed",
        outcome: "PAUSED-budget",
        trigger: "token_budget",
        issueState: "In Progress",
      },
    }),
    createJournalEntry({
      sequence: 3,
      kind: "gate_result",
      issueId: "gate",
      issueIdentifier: "SYMPH-GATE",
      operation: "gate",
      stage: "review",
      lease: createDispatcherLease({
        leaseId: "lease-gate",
        issueId: "gate",
        issueIdentifier: "SYMPH-GATE",
        operation: "gate",
        status: "completed",
      }),
      summary: "Gate passed.",
      metadata: {
        aggregate: "pass",
        mode: "thin",
        workerLane: {
          runner: "codex",
          model: null,
          role: "worker",
          stageName: "implement",
        },
        reviewerLanes: [
          {
            runner: "pi",
            model: "local-flash",
            role: "decorrelated-reviewer",
            stageName: "review",
          },
        ],
        verifierSeparated: true,
        authoritative: true,
        reworkTarget: null,
      },
    }),
    createJournalEntry({
      sequence: 4,
      kind: "dispatcher_decision",
      issueId: "decision",
      issueIdentifier: "SYMPH-DECISION",
      summary: "Recorded dispatcher decision.",
      metadata: {
        status: "completed",
        decisionEvent: createDecisionEvent(),
      },
    }),
    createJournalEntry({
      sequence: 5,
      kind: "supervision_finding",
      issueId: "supervised",
      issueIdentifier: "SYMPH-SUPERVISED",
      summary: "Ignored setup collision found.",
      metadata: {
        status: "completed",
        findingKind: "ignored_setup_instruction_collision",
        signature: "ignored-setup-signature",
      },
    }),
    createJournalEntry({
      sequence: 6,
      kind: "admission",
      issueId: "tail",
      issueIdentifier: "SYMPH-TAIL",
      summary: "Tail row retained for cursor-forward reads.",
    }),
  ];
}

function createActiveLeaseJournal(): DispatcherRunJournal {
  return [
    createJournalEntry({
      sequence: 1,
      kind: "admission",
      issueId: "active",
      issueIdentifier: "SYMPH-ACTIVE",
      lease: createDispatcherLease({
        leaseId: "lease-active",
        issueId: "active",
        issueIdentifier: "SYMPH-ACTIVE",
        status: "active",
      }),
      summary: "Active issue admitted.",
    }),
    createJournalEntry({
      sequence: 2,
      kind: "admission",
      issueId: "tail",
      issueIdentifier: "SYMPH-TAIL",
      summary: "Tail row retained for cursor-forward reads.",
    }),
  ];
}

function createWatchdogRegistryJournal(): DispatcherRunJournal {
  return [
    createJournalEntry({
      sequence: 1,
      kind: "cluster_transition",
      issueId: "watch-1",
      issueIdentifier: "SYMPH-W1",
      stage: "implement",
      summary: "Signature cluster growth.",
      metadata: {
        schema_version: 1,
        transition: "growth",
        signature: WATCHDOG_SIGNATURE.signature,
        issueCount: 1,
        stages: ["implement"],
        details: {
          errorClass: WATCHDOG_SIGNATURE.class,
          normalizedText: WATCHDOG_SIGNATURE.normalizedText,
          members: [createWatchdogMember("watch-1", "SYMPH-W1", 1)],
          lastAlertSize: 0,
        },
      },
    }),
    createJournalEntry({
      sequence: 2,
      kind: "cluster_transition",
      issueId: "watch-2",
      issueIdentifier: "SYMPH-W2",
      stage: "implement",
      summary: "Signature cluster systemic.",
      metadata: {
        schema_version: 1,
        transition: "systemic",
        signature: WATCHDOG_SIGNATURE.signature,
        issueCount: 2,
        stages: ["implement"],
        details: {
          errorClass: WATCHDOG_SIGNATURE.class,
          normalizedText: WATCHDOG_SIGNATURE.normalizedText,
          members: [
            createWatchdogMember("watch-1", "SYMPH-W1", 1),
            createWatchdogMember("watch-2", "SYMPH-W2", 2),
          ],
          lastAlertSize: 2,
        },
      },
    }),
    createJournalEntry({
      sequence: 3,
      kind: "breaker_transition",
      issueId: "watch-2",
      issueIdentifier: "SYMPH-W2",
      stage: "implement",
      timestamp: "2026-06-13T00:00:03.000Z",
      summary: "Breaker opened.",
      metadata: {
        schema_version: 1,
        transition: "opened",
        stage: "implement",
        signature: WATCHDOG_SIGNATURE.signature,
        details: { openedForIssueIds: ["watch-1", "watch-2"] },
      },
    }),
    createJournalEntry({
      sequence: 4,
      kind: "admission",
      issueId: "tail",
      issueIdentifier: "SYMPH-TAIL",
      summary: "Tail row retained for cursor-forward reads.",
    }),
  ];
}

function createWatchdogMember(
  issueId: string,
  issueIdentifier: string,
  sequence: number,
) {
  return {
    issueId,
    issueIdentifier,
    stageName: "implement",
    recordedAt: `2026-06-13T00:00:0${sequence}.000Z`,
    normalizedText: WATCHDOG_SIGNATURE.normalizedText,
  };
}

function createDecisionEvent(): DispatcherDecisionEvent {
  return {
    decisionId: "decision-1",
    category: "admission",
    classifier: "test",
    issueId: "decision",
    issueIdentifier: "SYMPH-DECISION",
    operation: "dispatcher",
    stage: null,
    attempt: null,
    timestamp: "2026-06-13T00:00:04.000Z",
    context: {
      reason: "test decision",
      triggerHits: [],
      findingKinds: [],
      files: [],
      workerIds: [],
      details: {},
    },
    expectedOutcome: {
      decision: "admit",
      classification: "positive",
      rationale: "eligible",
      costWeight: "low",
    },
    observedOutcome: {
      decision: "admit",
      classification: "positive",
      rationale: "dispatched",
      costWeight: "low",
    },
    operatorCorrection: null,
  };
}

function createJournalEntry(
  input: Partial<DispatcherRunJournalEntry> & {
    sequence: number;
    kind: DispatcherRunJournalEntry["kind"];
  },
): DispatcherRunJournalEntry {
  return {
    sequence: input.sequence,
    idempotencyKey: input.idempotencyKey ?? `${input.kind}:${input.sequence}`,
    timestamp:
      input.timestamp ??
      `2026-06-13T00:00:${String(input.sequence).padStart(2, "0")}.000Z`,
    kind: input.kind,
    issueId: input.issueId ?? "1",
    issueIdentifier: input.issueIdentifier ?? "ISSUE-1",
    operation: input.operation ?? "dispatcher",
    stage: input.stage ?? null,
    attempt: input.attempt ?? null,
    ownerId: input.ownerId ?? "test",
    lease: input.lease ?? null,
    summary: input.summary ?? "journal entry",
    metadata: input.metadata ?? { status: "completed" },
  };
}

function createDispatcherLease(
  input: Partial<DispatcherLease> & {
    leaseId: string;
    issueId: string;
    issueIdentifier: string;
  },
): DispatcherLease {
  return {
    leaseId: input.leaseId,
    issueId: input.issueId,
    issueIdentifier: input.issueIdentifier,
    operation: input.operation ?? "dispatcher",
    ownerId: input.ownerId ?? "test",
    status: input.status ?? "active",
    acquiredAt: input.acquiredAt ?? "2026-06-12T00:00:00.000Z",
    expiresAt: input.expiresAt ?? "2026-06-12T00:30:00.000Z",
    completedAt: input.completedAt ?? null,
    stage: input.stage ?? null,
    attempt: input.attempt ?? null,
    lastJournalSequence: input.lastJournalSequence ?? 0,
  };
}
