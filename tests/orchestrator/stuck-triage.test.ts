/**
 * Tests for the watchdog L2 stuck-ticket triage lane (SYMPH-399).
 *
 * Invariants:
 * - The lane fires only on watchdog parks (novelty short-circuit / breaker),
 *   only when watchdog.stuck_triage.enabled, and at most once per park.
 * - All four bounded actions execute as fenced writeIntent calls with actor
 *   watchdog-l2; verdicts post as Linear comments + triage_verdict journal
 *   events.
 * - retry_once grants exactly one attempt exempt from the novelty
 *   short-circuit; an identical-signature failure goes straight back to
 *   park with NO second triage.
 * - Low confidence ⇒ park; retry_once for a permanent failure class ⇒ park
 *   (the 332 fixture); rework without a hint ⇒ park.
 * - Disabled config ⇒ byte-identical behavior (zero new side effects).
 */
import { describe, expect, it, vi } from "vitest";

import type { StuckTriageVerdict } from "../../src/agent/stuck-triage.js";
import type {
  ResolvedWorkflowConfig,
  StagesConfig,
  WorkflowStuckTriageConfig,
} from "../../src/config/types.js";
import type { Issue } from "../../src/domain/model.js";
import {
  OrchestratorCore,
  type OrchestratorCoreOptions,
} from "../../src/orchestrator/core.js";
import type { IssueTracker } from "../../src/tracker/tracker.js";

// SYMPH-332 fixture: identical EPERM class with differing /var/folders paths.
const SYMPH332_EPERM_ATTEMPT1 =
  "EPERM: operation not permitted, open '/var/folders/xk/3q8vz5cd2r1/T/tmp-12345/workspace/src/index.ts'";
const SYMPH332_EPERM_ATTEMPT2 =
  "EPERM: operation not permitted, open '/var/folders/zp/9mhd1b7xyq0/T/tmp-67890/workspace/src/index.ts'";

const ENABLED_TRIAGE: WorkflowStuckTriageConfig = {
  enabled: true,
  baseUrl: "http://studio2.local:8000/v1",
  model: "deepseek-v4-flash",
  apiKey: null,
  timeoutMs: 600_000,
};

// Unknown-class failure (no classification rule matches): eligible for the
// novelty park (class !== "transient") but NOT subject to the permanent-class
// retry_once coercion — the shape the retry_once grant exists for.
const UNKNOWN_CLASS_FAILURE =
  "AssertionError: rendered snapshot diverged from stable baseline in widget tree";

function settle(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 25));
}

async function driveNoveltyPark(
  orchestrator: OrchestratorCore,
  failures: [string, string] = [
    SYMPH332_EPERM_ATTEMPT1,
    SYMPH332_EPERM_ATTEMPT2,
  ],
): Promise<void> {
  await orchestrator.pollTick();
  await orchestrator.onWorkerExit({
    issueId: "1",
    outcome: "abnormal",
    reason: failures[0],
  });
  await orchestrator.onRetryTimer("1");
  await orchestrator.onWorkerExit({
    issueId: "1",
    outcome: "abnormal",
    reason: failures[1],
  });
  await settle();
}

function triageVerdictEntries(orchestrator: OrchestratorCore) {
  return orchestrator
    .getState()
    .dispatcherRunJournal.filter((entry) => entry.kind === "triage_verdict");
}

function intentEntries(orchestrator: OrchestratorCore) {
  return orchestrator
    .getState()
    .dispatcherRunJournal.filter((entry) => entry.kind === "intent");
}

describe("stuck triage: lane gating", () => {
  it("does not fire when watchdog.stuck_triage is absent (byte-identical journal/comment behavior)", async () => {
    const runStuckTriage = vi.fn();
    const postCommentDisabled = vi.fn().mockResolvedValue(undefined);
    const disabled = createOrchestrator({
      runStuckTriage,
      postComment: postCommentDisabled,
    });
    await driveNoveltyPark(disabled);

    const postCommentBaseline = vi.fn().mockResolvedValue(undefined);
    const baseline = createOrchestrator({
      postComment: postCommentBaseline,
    });
    await driveNoveltyPark(baseline);

    expect(runStuckTriage).not.toHaveBeenCalled();
    expect(triageVerdictEntries(disabled)).toHaveLength(0);
    expect(intentEntries(disabled)).toHaveLength(0);
    // Zero new side effects: identical comments and identical journal kinds.
    expect(postCommentDisabled.mock.calls).toEqual(
      postCommentBaseline.mock.calls,
    );
    expect(
      disabled.getState().dispatcherRunJournal.map((entry) => entry.kind),
    ).toEqual(
      baseline.getState().dispatcherRunJournal.map((entry) => entry.kind),
    );
  });

  it("does not fire when the block is present but enabled is false", async () => {
    const runStuckTriage = vi.fn();
    const orchestrator = createOrchestrator({
      runStuckTriage,
      stuckTriage: { ...ENABLED_TRIAGE, enabled: false },
    });
    await driveNoveltyPark(orchestrator);
    expect(runStuckTriage).not.toHaveBeenCalled();
    expect(triageVerdictEntries(orchestrator)).toHaveLength(0);
  });

  it("does not fire for a plain max-retry exhaustion park (not a watchdog park kind)", async () => {
    const runStuckTriage = vi.fn().mockResolvedValue(null);
    const orchestrator = createOrchestrator({
      runStuckTriage,
      stuckTriage: ENABLED_TRIAGE,
      maxRetryAttempts: 1,
    });
    await orchestrator.pollTick();
    // Distinct signatures each attempt → never the novelty park; attempt 2
    // exceeds maxRetryAttempts=1 → plain exhaustion park.
    await orchestrator.onWorkerExit({
      issueId: "1",
      outcome: "abnormal",
      reason: "Error: alpha failure mode",
    });
    await orchestrator.onRetryTimer("1");
    await orchestrator.onWorkerExit({
      issueId: "1",
      outcome: "abnormal",
      reason: "Cannot find module './beta' from 'src/index.ts'",
    });
    await settle();

    expect(orchestrator.getState().failed.has("1")).toBe(true);
    expect(runStuckTriage).not.toHaveBeenCalled();
  });
});

describe("stuck triage: park verdict", () => {
  it("posts the attributed verdict comment, journals triage_verdict, and the park stands", async () => {
    const postComment = vi.fn().mockResolvedValue(undefined);
    const runStuckTriage = vi.fn().mockResolvedValue({
      classification: "env",
      action: "park",
      confidence: "high",
      rationale: "Dependency install fails deterministically; needs a human.",
    } satisfies StuckTriageVerdict);
    const orchestrator = createOrchestrator({
      runStuckTriage,
      stuckTriage: ENABLED_TRIAGE,
      postComment,
    });

    await driveNoveltyPark(orchestrator);

    expect(runStuckTriage).toHaveBeenCalledTimes(1);
    const evidence = runStuckTriage.mock.calls[0]?.[0];
    expect(evidence.parkKind).toBe("novelty");
    expect(evidence.issueIdentifier).toBe("ISSUE-1");
    expect(evidence.failureSignature).toMatch(/^[0-9a-f]{7}$/);
    expect(evidence.failureRecords[0]?.raw).toContain("EPERM");

    expect(orchestrator.getState().failed.has("1")).toBe(true);
    expect(postComment).toHaveBeenCalledWith(
      "1",
      expect.stringContaining("Stuck-ticket triage verdict: park"),
    );
    expect(postComment).toHaveBeenCalledWith(
      "1",
      expect.stringContaining("by watchdog-l2@"),
    );

    const verdictEntry = triageVerdictEntries(orchestrator)[0];
    expect(verdictEntry).toBeDefined();
    expect(verdictEntry?.metadata.status).toBe("applied");
    expect(verdictEntry?.metadata.action).toBe("park");
    expect(verdictEntry?.metadata.classification).toBe("env");
    expect(verdictEntry?.metadata.schema_version).toBe(1);
    const actor = verdictEntry?.metadata.actor as { kind: string };
    expect(actor.kind).toBe("watchdog-l2");
  });

  it("triage unavailable (null verdict) fails closed: park stands, journal records unavailable", async () => {
    const runStuckTriage = vi.fn().mockResolvedValue(null);
    const orchestrator = createOrchestrator({
      runStuckTriage,
      stuckTriage: ENABLED_TRIAGE,
    });
    await driveNoveltyPark(orchestrator);

    expect(orchestrator.getState().failed.has("1")).toBe(true);
    expect(triageVerdictEntries(orchestrator)[0]?.metadata.status).toBe(
      "unavailable",
    );
  });
});

describe("stuck triage: retry_once", () => {
  it("grants exactly one attempt; an identical-signature failure goes straight back to park with NO second triage", async () => {
    const runStuckTriage = vi.fn().mockResolvedValue({
      classification: "flaky",
      action: "retry_once",
      confidence: "med",
      rationale: "Looks like a transient workspace race.",
    } satisfies StuckTriageVerdict);
    const postComment = vi.fn().mockResolvedValue(undefined);
    const orchestrator = createOrchestrator({
      runStuckTriage,
      stuckTriage: ENABLED_TRIAGE,
      postComment,
    });

    await driveNoveltyPark(orchestrator, [
      UNKNOWN_CLASS_FAILURE,
      UNKNOWN_CLASS_FAILURE,
    ]);
    const state = orchestrator.getState();

    // The verdict released the park and scheduled exactly one retry.
    expect(state.failed.has("1")).toBe(false);
    expect(state.retryAttempts["1"]).toBeDefined();
    expect(state.retryAttempts["1"]?.delayType).toBe("continuation");
    expect(state.issueStages["1"]).toBe("investigate");
    const retryIntent = intentEntries(orchestrator).find(
      (entry) => entry.metadata.verb === "retry_once",
    );
    expect(retryIntent?.metadata.status).toBe("applied");

    // The granted attempt runs and fails with the SAME signature.
    await orchestrator.onRetryTimer("1");
    expect(state.running["1"]).toBeDefined();
    await orchestrator.onWorkerExit({
      issueId: "1",
      outcome: "abnormal",
      reason: UNKNOWN_CLASS_FAILURE,
    });
    await settle();

    // Straight back to park; the model was consulted exactly once.
    expect(state.failed.has("1")).toBe(true);
    expect(runStuckTriage).toHaveBeenCalledTimes(1);
    expect(postComment).toHaveBeenCalledWith(
      "1",
      expect.stringContaining("no second triage"),
    );
    expect(triageVerdictEntries(orchestrator)).toHaveLength(1);
  });

  it("a novel failure after the granted retry re-enters the normal ladder (no park)", async () => {
    const runStuckTriage = vi.fn().mockResolvedValue({
      classification: "flaky",
      action: "retry_once",
      confidence: "high",
      rationale: "Single transient failure shape.",
    } satisfies StuckTriageVerdict);
    const orchestrator = createOrchestrator({
      runStuckTriage,
      stuckTriage: ENABLED_TRIAGE,
    });

    await driveNoveltyPark(orchestrator, [
      UNKNOWN_CLASS_FAILURE,
      UNKNOWN_CLASS_FAILURE,
    ]);
    const state = orchestrator.getState();
    expect(state.failed.has("1")).toBe(false);

    await orchestrator.onRetryTimer("1");
    await orchestrator.onWorkerExit({
      issueId: "1",
      outcome: "abnormal",
      reason: "TypeError: cannot read properties of undefined (reading render)",
    });
    await settle();

    // Novel signature → normal failure retry, not a park.
    expect(state.failed.has("1")).toBe(false);
    expect(state.retryAttempts["1"]?.delayType).toBe("failure");
    expect(runStuckTriage).toHaveBeenCalledTimes(1);
  });
});

describe("stuck triage: rework_with_hint", () => {
  it("routes the hint through the Review Findings comment and the stage's on_rework target", async () => {
    const postComment = vi.fn().mockResolvedValue(undefined);
    const runStuckTriage = vi.fn().mockResolvedValue({
      classification: "spec_defect",
      action: "rework_with_hint",
      hint: "The verify command references a script removed in PR #12 — update package.json first.",
      confidence: "high",
      rationale: "Failure text names a missing npm script.",
    } satisfies StuckTriageVerdict);
    const orchestrator = createOrchestrator({
      runStuckTriage,
      stuckTriage: ENABLED_TRIAGE,
      postComment,
      stages: createStagesWithRework(),
    });

    await driveNoveltyPark(orchestrator);
    const state = orchestrator.getState();

    expect(state.failed.has("1")).toBe(false);
    expect(state.issueStages["1"]).toBe("investigate");
    expect(state.issueReworkCounts["1"]).toBe(1);
    expect(state.retryAttempts["1"]?.delayType).toBe("continuation");

    expect(postComment).toHaveBeenCalledWith(
      "1",
      expect.stringContaining("## Review Findings"),
    );
    expect(postComment).toHaveBeenCalledWith(
      "1",
      expect.stringContaining("Watchdog triage hint"),
    );
    expect(postComment).toHaveBeenCalledWith(
      "1",
      expect.stringContaining("update package.json first"),
    );
    const reworkIntent = intentEntries(orchestrator).find(
      (entry) => entry.metadata.verb === "rework_with_hint",
    );
    expect(reworkIntent?.metadata.status).toBe("applied");
  });

  it("falls back to park when the parked stage has no on_rework target", async () => {
    const postComment = vi.fn().mockResolvedValue(undefined);
    const runStuckTriage = vi.fn().mockResolvedValue({
      classification: "spec_defect",
      action: "rework_with_hint",
      hint: "Some hint.",
      confidence: "high",
      rationale: "Wants a rework.",
    } satisfies StuckTriageVerdict);
    const orchestrator = createOrchestrator({
      runStuckTriage,
      stuckTriage: ENABLED_TRIAGE,
      postComment,
    });

    await driveNoveltyPark(orchestrator);
    expect(orchestrator.getState().failed.has("1")).toBe(true);
    expect(postComment).toHaveBeenCalledWith(
      "1",
      expect.stringContaining("rework_with_hint not executable"),
    );
  });

  it("a rework_with_hint verdict without a hint is coerced to park", async () => {
    const runStuckTriage = vi.fn().mockResolvedValue({
      classification: "spec_defect",
      action: "rework_with_hint",
      confidence: "high",
      rationale: "Forgot the hint.",
    } satisfies StuckTriageVerdict);
    const orchestrator = createOrchestrator({
      runStuckTriage,
      stuckTriage: ENABLED_TRIAGE,
      stages: createStagesWithRework(),
    });
    await driveNoveltyPark(orchestrator);
    expect(orchestrator.getState().failed.has("1")).toBe(true);
    expect(triageVerdictEntries(orchestrator)[0]?.metadata.action).toBe("park");
  });
});

describe("stuck triage: escalate_human", () => {
  it("pages through the notifier with the model's case and the park stands", async () => {
    const onTriageEscalation = vi.fn();
    const runStuckTriage = vi.fn().mockResolvedValue({
      classification: "infra",
      action: "escalate_human",
      confidence: "high",
      rationale:
        "EPERM recurs across attempts with rotating temp paths; the host's sandbox profile is denying file writes — a human needs to inspect the box.",
    } satisfies StuckTriageVerdict);
    const orchestrator = createOrchestrator({
      runStuckTriage,
      stuckTriage: ENABLED_TRIAGE,
      onTriageEscalation,
    });

    await driveNoveltyPark(orchestrator);

    expect(orchestrator.getState().failed.has("1")).toBe(true);
    expect(onTriageEscalation).toHaveBeenCalledTimes(1);
    expect(onTriageEscalation).toHaveBeenCalledWith(
      expect.objectContaining({
        issueIdentifier: "ISSUE-1",
        classification: "infra",
        caseText: expect.stringContaining("sandbox profile"),
      }),
    );
    const escalateIntent = intentEntries(orchestrator).find(
      (entry) => entry.metadata.verb === "escalate_human",
    );
    expect(escalateIntent?.metadata.status).toBe("applied");
  });
});

describe("stuck triage: envelope bounds", () => {
  it("a low-confidence retry_once is coerced to park", async () => {
    const postComment = vi.fn().mockResolvedValue(undefined);
    const runStuckTriage = vi.fn().mockResolvedValue({
      classification: "flaky",
      action: "retry_once",
      confidence: "low",
      rationale: "Maybe transient?",
    } satisfies StuckTriageVerdict);
    const orchestrator = createOrchestrator({
      runStuckTriage,
      stuckTriage: ENABLED_TRIAGE,
      postComment,
    });
    await driveNoveltyPark(orchestrator);

    expect(orchestrator.getState().failed.has("1")).toBe(true);
    expect(orchestrator.getState().retryAttempts["1"]).toBeUndefined();
    expect(postComment).toHaveBeenCalledWith(
      "1",
      expect.stringContaining("coerced to park"),
    );
  });

  it("332 fixture: a permanent-class park never yields retry_once — infra retry_once is coerced to park", async () => {
    const runStuckTriage = vi.fn().mockResolvedValue({
      classification: "infra",
      action: "retry_once",
      confidence: "high",
      rationale: "Model over-optimistically wants a retry.",
    } satisfies StuckTriageVerdict);
    const orchestrator = createOrchestrator({
      runStuckTriage,
      stuckTriage: ENABLED_TRIAGE,
    });
    // The 332 sequence: identical EPERM (permanent class) across attempts.
    await driveNoveltyPark(orchestrator);
    const state = orchestrator.getState();

    // Envelope bound: never retry_once for a permanent failure class.
    expect(state.failed.has("1")).toBe(true);
    expect(state.retryAttempts["1"]).toBeUndefined();
    const verdictEntry = triageVerdictEntries(orchestrator)[0];
    expect(verdictEntry?.metadata.modelAction).toBe("retry_once");
    expect(verdictEntry?.metadata.action).toBe("park");
    expect(verdictEntry?.metadata.failure_class).toBe("permanent");
  });
});

describe("stuck triage: one-triage-per-park + lifecycle", () => {
  it("resume-then-recur: an operator resume starts a fresh lifecycle and a new park triages again", async () => {
    const issue = createIssue();
    const runStuckTriage = vi.fn().mockResolvedValue({
      classification: "env",
      action: "park",
      confidence: "high",
      rationale: "Park it.",
    } satisfies StuckTriageVerdict);
    const orchestrator = createOrchestrator({
      runStuckTriage,
      stuckTriage: ENABLED_TRIAGE,
      issue,
    });

    await driveNoveltyPark(orchestrator);
    expect(runStuckTriage).toHaveBeenCalledTimes(1);
    expect(orchestrator.getState().failed.has("1")).toBe(true);

    // Operator resume: tracker now reports the issue in Resume.
    issue.state = "Resume";
    await orchestrator.pollTick();
    expect(orchestrator.getState().failed.has("1")).toBe(false);
    expect(orchestrator.getState().running["1"]).toBeDefined();

    // Recur: the same identical-signature pair parks again — and the fresh
    // park generation triages again (the guard is per-park, not per-issue).
    issue.state = "In Progress";
    await orchestrator.onWorkerExit({
      issueId: "1",
      outcome: "abnormal",
      reason: SYMPH332_EPERM_ATTEMPT1,
    });
    await orchestrator.onRetryTimer("1");
    await orchestrator.onWorkerExit({
      issueId: "1",
      outcome: "abnormal",
      reason: SYMPH332_EPERM_ATTEMPT2,
    });
    await settle();

    expect(orchestrator.getState().failed.has("1")).toBe(true);
    expect(runStuckTriage).toHaveBeenCalledTimes(2);
    expect(triageVerdictEntries(orchestrator)).toHaveLength(2);
  });

  it("a verdict that arrives after the operator already resumed is stale and mutates nothing", async () => {
    const issue = createIssue();
    let resolveVerdict: (verdict: StuckTriageVerdict | null) => void = () => {};
    const runStuckTriage = vi.fn().mockReturnValue(
      new Promise<StuckTriageVerdict | null>((resolve) => {
        resolveVerdict = resolve;
      }),
    );
    const orchestrator = createOrchestrator({
      runStuckTriage,
      stuckTriage: ENABLED_TRIAGE,
      issue,
    });

    await driveNoveltyPark(orchestrator);
    expect(orchestrator.getState().failed.has("1")).toBe(true);

    // Operator resumes before the verdict lands.
    issue.state = "Resume";
    await orchestrator.pollTick();
    expect(orchestrator.getState().running["1"]).toBeDefined();

    resolveVerdict({
      classification: "flaky",
      action: "retry_once",
      confidence: "high",
      rationale: "Late verdict.",
    });
    await settle();

    // Stale: the running issue is untouched, no second retry scheduled.
    expect(orchestrator.getState().running["1"]).toBeDefined();
    expect(orchestrator.getState().retryAttempts["1"]).toBeUndefined();
    expect(triageVerdictEntries(orchestrator)[0]?.metadata.status).toBe(
      "stale",
    );
  });
});

// ---------------------------------------------------------------------------
// Council R1 fixes
// ---------------------------------------------------------------------------

describe("council R1 fix 1: rework_with_hint respects maxRework budget", () => {
  it("maxRework:0 stage → rework_with_hint verdict → no rework, issue stays parked, intent records no_op", async () => {
    const postComment = vi.fn().mockResolvedValue(undefined);
    const runStuckTriage = vi.fn().mockResolvedValue({
      classification: "spec_defect",
      action: "rework_with_hint",
      hint: "Fix the spec.",
      confidence: "high",
      rationale: "Spec is wrong.",
    } satisfies StuckTriageVerdict);
    // Stage with onRework set but maxRework: 0 (rework explicitly disabled).
    const base = createStagesWithRework();
    const stages: StagesConfig = {
      ...base,
      stages: {
        ...base.stages,
        investigate: {
          ...(base.stages.investigate as StagesConfig["stages"][string]),
          maxRework: 0,
        },
      },
    };
    const orchestrator = createOrchestrator({
      runStuckTriage,
      stuckTriage: ENABLED_TRIAGE,
      postComment,
      stages,
    });

    await driveNoveltyPark(orchestrator);
    const state = orchestrator.getState();

    // Rework budget exhausted — issue must remain parked.
    expect(state.failed.has("1")).toBe(true);
    expect(state.retryAttempts["1"]).toBeUndefined();
    // The intent was applied as no_op (budget exhausted).
    const reworkIntent = intentEntries(orchestrator).find(
      (entry) => entry.metadata.verb === "rework_with_hint",
    );
    expect(reworkIntent?.metadata.status).toBe("no_op");
    expect(String(reworkIntent?.metadata.detail)).toContain(
      "rework budget exhausted",
    );
    // The "park stands" comment was posted, not a Review Findings comment.
    const reviewFindingsCall = postComment.mock.calls.find(([, body]) =>
      String(body).includes("## Review Findings"),
    );
    expect(reviewFindingsCall).toBeUndefined();
  });
});

describe("council R1 fix 2: replay restores rework stage transition", () => {
  it("park → rework_with_hint → restart/replay → issue is on the rework target stage", async () => {
    const runStuckTriage = vi.fn().mockResolvedValue({
      classification: "spec_defect",
      action: "rework_with_hint",
      hint: "Fix the spec.",
      confidence: "high",
      rationale: "Spec is wrong.",
    } satisfies StuckTriageVerdict);
    const orchestrator = createOrchestrator({
      runStuckTriage,
      stuckTriage: ENABLED_TRIAGE,
      stages: createStagesWithRework(),
    });

    await driveNoveltyPark(orchestrator);
    const state = orchestrator.getState();

    // Verify the rework was applied live.
    expect(state.failed.has("1")).toBe(false);
    expect(state.issueStages["1"]).toBe("investigate"); // onRework = "investigate"

    // Replay: construct a fresh orchestrator from the same run journal.
    const replayed = createOrchestrator({
      stages: createStagesWithRework(),
      runJournal: orchestrator.getState().dispatcherRunJournal,
    });

    // After replay, the issue should be on the rework stage, not parked.
    expect(replayed.getState().failed.has("1")).toBe(false);
    expect(replayed.getState().resumeRequired.has("1")).toBe(false);
    expect(replayed.getState().issueStages["1"]).toBe("investigate");
  });
});

describe("council R2: replay restores journaled rework target + count", () => {
  const REWORK_VERDICT: StuckTriageVerdict = {
    classification: "spec_defect",
    action: "rework_with_hint",
    hint: "Fix the spec.",
    confidence: "high",
    rationale: "Spec is wrong.",
  };

  function createStagesWithReworkBudget(maxRework: number): StagesConfig {
    const base = createStagesWithRework();
    return {
      ...base,
      stages: {
        ...base.stages,
        investigate: {
          ...(base.stages.investigate as StagesConfig["stages"][string]),
          maxRework,
        },
      },
    };
  }

  it("journals the resolved target + count and replay restores both; the next rework beyond maxRework escalates", async () => {
    const runStuckTriage = vi.fn().mockResolvedValue(REWORK_VERDICT);
    const stages = createStagesWithReworkBudget(1);
    const orchestrator = createOrchestrator({
      runStuckTriage,
      stuckTriage: ENABLED_TRIAGE,
      stages,
    });

    await driveNoveltyPark(orchestrator);

    // Live state: rework applied, count consumed.
    expect(orchestrator.getState().issueStages["1"]).toBe("investigate");
    expect(orchestrator.getState().issueReworkCounts["1"]).toBe(1);

    // The applied intent entry carries the resolved values.
    const reworkIntent = intentEntries(orchestrator).find(
      (entry) =>
        entry.metadata.verb === "rework_with_hint" &&
        entry.metadata.status === "applied",
    );
    expect(reworkIntent?.metadata.reworkTarget).toBe("investigate");
    expect(reworkIntent?.metadata.reworkCount).toBe(1);

    // Replay into a fresh orchestrator: both values are restored verbatim.
    const replayed = createOrchestrator({
      stages,
      runJournal: orchestrator.getState().dispatcherRunJournal,
    });
    expect(replayed.getState().issueStages["1"]).toBe("investigate");
    expect(replayed.getState().issueReworkCounts["1"]).toBe(1);

    // The consumed rework survives the replay: with maxRework: 1 already
    // spent, another rework attempt escalates instead of running.
    expect(replayed.reworkGate("1")).toBe("escalated");
    expect(replayed.getState().failed.has("1")).toBe(true);
  });

  it("config drift: replay lands on the journaled target even when the current config's onRework points elsewhere", async () => {
    const runStuckTriage = vi.fn().mockResolvedValue(REWORK_VERDICT);
    const writeStages = createStagesWithReworkBudget(3);
    const orchestrator = createOrchestrator({
      runStuckTriage,
      stuckTriage: ENABLED_TRIAGE,
      stages: writeStages,
    });
    await driveNoveltyPark(orchestrator);
    expect(orchestrator.getState().issueStages["1"]).toBe("investigate");

    // The workflow changed between journal write and replay: investigate's
    // onRework now points at "implement" instead of "investigate".
    const driftedStages: StagesConfig = {
      ...writeStages,
      stages: {
        ...writeStages.stages,
        investigate: {
          ...(writeStages.stages.investigate as StagesConfig["stages"][string]),
          transitions: {
            onComplete: "implement",
            onApprove: null,
            onRework: "implement",
          },
        },
      },
    };
    const replayed = createOrchestrator({
      stages: driftedStages,
      runJournal: orchestrator.getState().dispatcherRunJournal,
    });

    // The journaled target wins — no config lookup at replay.
    expect(replayed.getState().issueStages["1"]).toBe("investigate");
    expect(replayed.getState().issueReworkCounts["1"]).toBe(1);
  });

  it("legacy entry without journaled values falls back to current-config derivation; count stays unrestored", async () => {
    const runStuckTriage = vi.fn().mockResolvedValue(REWORK_VERDICT);
    const stages = createStagesWithReworkBudget(3);
    const orchestrator = createOrchestrator({
      runStuckTriage,
      stuckTriage: ENABLED_TRIAGE,
      stages,
    });
    await driveNoveltyPark(orchestrator);

    // Simulate a journal written before the resolved values were recorded:
    // strip reworkTarget/reworkCount from the applied intent entry.
    const legacyJournal = orchestrator
      .getState()
      .dispatcherRunJournal.map((entry) => {
        if (
          entry.kind === "intent" &&
          entry.metadata.verb === "rework_with_hint" &&
          entry.metadata.status === "applied"
        ) {
          const { reworkTarget, reworkCount, ...rest } = entry.metadata;
          expect(reworkTarget).toBe("investigate");
          expect(reworkCount).toBe(1);
          return { ...entry, metadata: rest };
        }
        return entry;
      });

    const replayed = createOrchestrator({
      stages,
      runJournal: legacyJournal,
    });

    // Fallback: target derived from the current config's onRework; the
    // consumed count cannot be recovered from a legacy entry.
    expect(replayed.getState().issueStages["1"]).toBe("investigate");
    expect(replayed.getState().issueReworkCounts["1"]).toBeUndefined();
  });
});

describe("council R1 fix 3: hint egress neutralization", () => {
  it("hint containing triple-backticks and exceeding 4000 chars is posted stripped and capped", async () => {
    const postComment = vi.fn().mockResolvedValue(undefined);
    // Hint with triple-backtick fences and length > 4000.
    const longHint = `Here is a code block:\n\`\`\`ts\nconsole.log("hi");\n\`\`\`\n${"x".repeat(5000)}`;
    const runStuckTriage = vi.fn().mockResolvedValue({
      classification: "spec_defect",
      action: "rework_with_hint",
      hint: longHint,
      confidence: "high",
      rationale: "Spec defect.",
    } satisfies StuckTriageVerdict);
    const orchestrator = createOrchestrator({
      runStuckTriage,
      stuckTriage: ENABLED_TRIAGE,
      postComment,
      stages: createStagesWithRework(),
    });

    await driveNoveltyPark(orchestrator);

    const reviewCall = postComment.mock.calls.find(([, body]) =>
      String(body).includes("## Review Findings"),
    );
    expect(reviewCall).toBeDefined();
    const postedBody = String(reviewCall?.[1] ?? "");
    // Triple-backticks must be stripped to single backticks.
    expect(postedBody).not.toContain("```");
    // The posted body must not exceed the cap + header overhead.
    expect(postedBody.length).toBeLessThan(5000);
    // The truncation marker is present when capped.
    expect(postedBody).toContain("[hint truncated]");
  });
});

describe("council R1 fix 4: retryOnceGrant survives restart", () => {
  it("replay of retry_once restores the grant so the granted attempt is still novelty-exempt", async () => {
    const runStuckTriage = vi.fn().mockResolvedValue({
      classification: "flaky",
      action: "retry_once",
      confidence: "high",
      rationale: "Single transient failure.",
    } satisfies StuckTriageVerdict);
    const orchestrator = createOrchestrator({
      runStuckTriage,
      stuckTriage: ENABLED_TRIAGE,
    });

    await driveNoveltyPark(orchestrator, [
      UNKNOWN_CLASS_FAILURE,
      UNKNOWN_CLASS_FAILURE,
    ]);
    const state = orchestrator.getState();

    // Grant was set live.
    expect(state.failed.has("1")).toBe(false);
    expect(state.retryAttempts["1"]).toBeDefined();

    // Replay into a fresh orchestrator.
    const replayed = createOrchestrator({
      runStuckTriage: vi.fn(),
      stuckTriage: ENABLED_TRIAGE,
      runJournal: orchestrator.getState().dispatcherRunJournal,
    });

    // The grant must be present on the replayed orchestrator.
    const replayedState = replayed.getState();
    expect(replayedState.failed.has("1")).toBe(false);
    // Confirm the grant is set by checking that pollTick → onWorkerExit
    // with the SAME signature parks (grant consumed, identical-sig re-park)
    // rather than re-triaging. After replay, retryAttempts is not restored
    // (timer is transient); pollTick re-dispatches the unparked issue.
    const postComment = vi.fn().mockResolvedValue(undefined);
    const replayedWithComment = createOrchestrator({
      runStuckTriage: vi.fn(),
      stuckTriage: ENABLED_TRIAGE,
      postComment,
      runJournal: orchestrator.getState().dispatcherRunJournal,
    });
    // pollTick dispatches the unparked issue (it is not in failed/resumeRequired).
    await replayedWithComment.pollTick();
    expect(replayedWithComment.getState().running["1"]).toBeDefined();
    await replayedWithComment.onWorkerExit({
      issueId: "1",
      outcome: "abnormal",
      reason: UNKNOWN_CLASS_FAILURE,
    });
    await new Promise((resolve) => setTimeout(resolve, 25));

    // Should park with "no second triage" (grant consumed, identical sig).
    expect(replayedWithComment.getState().failed.has("1")).toBe(true);
    expect(postComment).toHaveBeenCalledWith(
      "1",
      expect.stringContaining("no second triage"),
    );
  });
});

describe("council R2 fix 1: budget-exhausted re-park re-establishes the fence", () => {
  it("rework budget exhausted → old fence rejected_stale, new fence applies, exhausted marker restored", async () => {
    const runStuckTriage = vi.fn().mockResolvedValue({
      classification: "spec_defect",
      action: "rework_with_hint",
      hint: "Fix the spec.",
      confidence: "high",
      rationale: "Spec is wrong.",
    } satisfies StuckTriageVerdict);
    // Stage with onRework set but maxRework: 0 (rework explicitly disabled).
    const base = createStagesWithRework();
    const stages: StagesConfig = {
      ...base,
      stages: {
        ...base.stages,
        investigate: {
          ...(base.stages.investigate as StagesConfig["stages"][string]),
          maxRework: 0,
        },
      },
    };
    const orchestrator = createOrchestrator({
      runStuckTriage,
      stuckTriage: ENABLED_TRIAGE,
      stages,
    });

    await driveNoveltyPark(orchestrator);
    const state = orchestrator.getState();
    expect(state.failed.has("1")).toBe(true);
    // The exhausted marker survives the release-then-re-park round trip
    // (alert dedup in runtime-host reads this set).
    expect(state.failureExhaustedIds.has("1")).toBe(true);

    // The generation the triage envelope acted against (the OLD fence).
    const verdictEntry = triageVerdictEntries(orchestrator)[0];
    const oldGen = verdictEntry?.metadata.parkGeneration;
    expect(typeof oldGen).toBe("number");

    // The no_op rework intent journals the post-apply generation: the
    // re-park must have minted a FRESH one, not left the fence dead.
    const reworkIntent = intentEntries(orchestrator).find(
      (entry) => entry.metadata.verb === "rework_with_hint",
    );
    const newGen = reworkIntent?.metadata.parkGeneration;
    expect(typeof newGen).toBe("number");
    expect(newGen).not.toBe(oldGen);

    // Fence liveness probe 1: a release fenced on the OLD generation is
    // rejected_stale and mutates nothing.
    const stale = await orchestrator.writeIntent({
      verb: "release",
      issueId: "1",
      issueIdentifier: "ISSUE-1",
      actor: { kind: "operator", host: "pro14" },
      reason: { class: "operator_release", human: "probe old fence" },
      fence: { expectedParkSeq: oldGen as number },
    });
    expect(stale.status).toBe("rejected_stale");
    expect(orchestrator.getState().failed.has("1")).toBe(true);

    // Fence liveness probe 2: a release fenced on the NEW generation applies.
    const fresh = await orchestrator.writeIntent({
      verb: "release",
      issueId: "1",
      issueIdentifier: "ISSUE-1",
      actor: { kind: "operator", host: "pro14" },
      reason: { class: "operator_release", human: "release on new fence" },
      fence: { expectedParkSeq: newGen as number },
    });
    expect(fresh.status).toBe("applied");
    expect(orchestrator.getState().failed.has("1")).toBe(false);
  });
});

describe("council R2 fix 2: retry_once_failed re-park keeps cluster membership", () => {
  it("issue re-parked via retry_once_failed still counts toward SYSTEMIC when a second issue shares the signature", async () => {
    const onSystemicCluster = vi.fn();
    const runStuckTriage = vi.fn().mockResolvedValue({
      classification: "flaky",
      action: "retry_once",
      confidence: "high",
      rationale: "Single transient failure.",
    } satisfies StuckTriageVerdict);
    const orchestrator = createOrchestrator({
      runStuckTriage,
      stuckTriage: ENABLED_TRIAGE,
      onSystemicCluster,
      issues: [createIssue(), createIssue({ id: "2", identifier: "ISSUE-2" })],
    });

    // Drive issue 1 to a novelty park with an identical signature on both
    // attempts (the shape the retry_once grant exists for). Issue 2 is
    // dispatched alongside and keeps running.
    await driveNoveltyPark(orchestrator, [
      UNKNOWN_CLASS_FAILURE,
      UNKNOWN_CLASS_FAILURE,
    ]);
    expect(orchestrator.getState().failed.has("1")).toBe(false); // grant released the park

    // The granted attempt fails with the identical signature →
    // retry_once_failed re-park (no second triage).
    await orchestrator.onRetryTimer("1");
    await orchestrator.onWorkerExit({
      issueId: "1",
      outcome: "abnormal",
      reason: UNKNOWN_CLASS_FAILURE,
    });
    await settle();
    expect(orchestrator.getState().failed.has("1")).toBe(true);
    expect(onSystemicCluster).not.toHaveBeenCalled();

    // Issue 2 now fails with the SAME signature. If the re-park preserved
    // issue 1's cluster membership, the cluster reaches the systemic
    // threshold (2) and alerts; before the fix the membership was lost at
    // retry_once release and never restored, so this stayed silent.
    await orchestrator.onWorkerExit({
      issueId: "2",
      outcome: "abnormal",
      reason: UNKNOWN_CLASS_FAILURE,
    });
    await settle();

    expect(onSystemicCluster).toHaveBeenCalledTimes(1);
    const clusterInput = onSystemicCluster.mock.calls[0]?.[0];
    expect(clusterInput.clusterSize).toBe(2);
    expect(clusterInput.issueIdentifiers).toEqual(
      expect.arrayContaining(["ISSUE-1", "ISSUE-2"]),
    );
  });
});

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

function createOrchestrator(overrides?: {
  runStuckTriage?: OrchestratorCoreOptions["runStuckTriage"];
  onTriageEscalation?: OrchestratorCoreOptions["onTriageEscalation"];
  onSystemicCluster?: OrchestratorCoreOptions["onSystemicCluster"];
  postComment?: (issueId: string, body: string) => Promise<void>;
  stuckTriage?: WorkflowStuckTriageConfig;
  stages?: StagesConfig;
  maxRetryAttempts?: number;
  issue?: Issue;
  issues?: Issue[];
  runJournal?: OrchestratorCoreOptions["runJournal"];
}): OrchestratorCore {
  const issue = overrides?.issue ?? createIssue();
  const options: OrchestratorCoreOptions = {
    config: createConfig({
      ...(overrides?.stuckTriage !== undefined
        ? { stuckTriage: overrides.stuckTriage }
        : {}),
      ...(overrides?.stages !== undefined ? { stages: overrides.stages } : {}),
      ...(overrides?.maxRetryAttempts !== undefined
        ? { maxRetryAttempts: overrides.maxRetryAttempts }
        : {}),
    }),
    tracker: createTracker(overrides?.issues ?? [issue]),
    spawnWorker: async () => ({
      workerHandle: { pid: 9001 },
      monitorHandle: { ref: "monitor-1" },
    }),
    ...(overrides?.runStuckTriage !== undefined
      ? { runStuckTriage: overrides.runStuckTriage }
      : {}),
    ...(overrides?.onTriageEscalation !== undefined
      ? { onTriageEscalation: overrides.onTriageEscalation }
      : {}),
    ...(overrides?.onSystemicCluster !== undefined
      ? { onSystemicCluster: overrides.onSystemicCluster }
      : {}),
    ...(overrides?.postComment !== undefined
      ? { postComment: overrides.postComment }
      : {}),
    ...(overrides?.runJournal !== undefined
      ? { runJournal: overrides.runJournal }
      : {}),
    now: () => new Date("2026-06-11T12:00:00.000Z"),
  };
  return new OrchestratorCore(options);
}

function createTracker(issues: Issue[]): IssueTracker {
  return {
    async fetchCandidateIssues() {
      return issues;
    },
    async fetchIssuesByStates() {
      return [];
    },
    async fetchIssueStatesByIds() {
      return issues.map((issue) => ({
        id: issue.id,
        identifier: issue.identifier,
        state: issue.state,
      }));
    },
  };
}

function createConfig(overrides?: {
  stuckTriage?: WorkflowStuckTriageConfig;
  stages?: StagesConfig;
  maxRetryAttempts?: number;
}): ResolvedWorkflowConfig {
  return {
    workflowPath: "/tmp/WORKFLOW.md",
    promptTemplate: "Prompt",
    tracker: {
      kind: "linear",
      endpoint: "https://api.linear.app/graphql",
      apiKey: "token",
      projectSlug: "project",
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
      maxRetryAttempts: overrides?.maxRetryAttempts ?? 5,
      maxConcurrentAgentsByState: {},
    },
    runner: { kind: "codex", model: null },
    codex: {
      command: "codex-app-server",
      approvalPolicy: "never",
      threadSandbox: null,
      turnSandboxPolicy: null,
      turnTimeoutMs: 300_000,
      readTimeoutMs: 30_000,
      stallTimeoutMs: 300_000,
    },
    pauseTriage: { baseUrl: null, model: null, apiKey: null, maxResumes: 2 },
    acGate: { enabled: false },
    specFidelity: { enabled: false },
    budgetEscalation: { maxSteps: null, multiplier: 2 },
    rateLimitAdmission: {
      minPrimaryHeadroomPct: null,
      minSecondaryHeadroomPct: null,
    },
    server: { port: null, slackNotifyChannel: null },
    notifications: { slackEnabled: true },
    observability: {
      dashboardEnabled: false,
      refreshMs: 1_000,
      renderIntervalMs: 16,
    },
    admissionCard: { enabled: false },
    watchdog: {
      systemicThreshold: 2,
      circuitBreaker: true,
      maxFilingsPerHour: 3,
      ...(overrides?.stuckTriage !== undefined
        ? { stuckTriage: overrides.stuckTriage }
        : {}),
    },
    stages: overrides?.stages ?? createStages(),
    escalationState: "Blocked",
  };
}

/** investigate → implement → done; the park lands on "implement". */
function createStages(): StagesConfig {
  return {
    initialStage: "investigate",
    fastTrack: null,
    stages: {
      investigate: {
        type: "agent",
        runner: "codex",
        model: null,
        prompt: "investigate.liquid",
        maxTurns: 8,
        timeoutMs: null,
        concurrency: null,
        gateType: null,
        maxRework: null,
        reviewers: [],
        transitions: {
          onComplete: "implement",
          onApprove: null,
          onRework: null,
        },
        linearState: null,
      },
      implement: {
        type: "agent",
        runner: "codex",
        model: null,
        prompt: "implement.liquid",
        maxTurns: 30,
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
}

/** Same shape but investigate (where the park lands) reworks to itself. */
function createStagesWithRework(): StagesConfig {
  const base = createStages();
  return {
    ...base,
    stages: {
      ...base.stages,
      investigate: {
        ...(base.stages.investigate as StagesConfig["stages"][string]),
        transitions: {
          onComplete: "implement",
          onApprove: null,
          onRework: "investigate",
        },
      },
    },
  };
}

function createIssue(overrides?: Partial<Issue>): Issue {
  return {
    id: "1",
    identifier: "ISSUE-1",
    title: "Example issue",
    description: "A ticket that loops a review stage on EPERM.",
    priority: 1,
    state: "In Progress",
    branchName: null,
    url: null,
    labels: [],
    blockedBy: [],
    createdAt: "2026-03-01T00:00:00.000Z",
    updatedAt: "2026-03-01T00:00:00.000Z",
    ...overrides,
  };
}
