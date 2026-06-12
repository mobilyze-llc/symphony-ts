/**
 * Tests for the shared intent-verb layer (SYMPH-399 / SYMPH-408 carve-out).
 *
 * The four writeIntent semantics, one per block:
 * 1. Idempotency — a verb that would not change state records a no_op and
 *    fires no duplicate side effects.
 * 2. Fencing — a stale park-generation fence is rejected_stale and mutates
 *    nothing (park-then-revise nonce pattern).
 * 3. Attribution — the actor is journaled and rendered into the
 *    human-visible comment ("by {kind}@{host}").
 * 4. Replay convergence — replay of park → release converges on released
 *    (SYMPH-368 regression: operator releases used to be invisible to the
 *    journal, so replay re-parked over them).
 */
import { describe, expect, it, vi } from "vitest";

import type {
  ResolvedWorkflowConfig,
  StagesConfig,
} from "../../src/config/types.js";
import type { Issue } from "../../src/domain/model.js";
import {
  OrchestratorCore,
  type OrchestratorCoreOptions,
} from "../../src/orchestrator/core.js";
import type { IntentActor } from "../../src/orchestrator/intent.js";
import type { IssueTracker } from "../../src/tracker/tracker.js";

const OPERATOR: IntentActor = { kind: "operator", host: "pro14" };

const EPERM_A =
  "EPERM: operation not permitted, open '/var/folders/xk/3q8vz5cd2r1/T/tmp-12345/workspace/src/index.ts'";
const EPERM_B =
  "EPERM: operation not permitted, open '/var/folders/zp/9mhd1b7xyq0/T/tmp-67890/workspace/src/index.ts'";

function intentEntries(orchestrator: OrchestratorCore) {
  return orchestrator
    .getState()
    .dispatcherRunJournal.filter((entry) => entry.kind === "intent");
}

/** Drive the SYMPH-396 novelty short-circuit so the issue ends watchdog-parked. */
async function driveNoveltyPark(orchestrator: OrchestratorCore): Promise<void> {
  await orchestrator.pollTick();
  await orchestrator.onWorkerExit({
    issueId: "1",
    outcome: "abnormal",
    reason: EPERM_A,
  });
  await orchestrator.onRetryTimer("1");
  await orchestrator.onWorkerExit({
    issueId: "1",
    outcome: "abnormal",
    reason: EPERM_B,
  });
  // Let void-chained park side effects (journal, escalation) settle.
  await new Promise((resolve) => setTimeout(resolve, 20));
  expect(orchestrator.getState().failed.has("1")).toBe(true);
}

describe("writeIntent semantics 1: idempotency", () => {
  it("park on an un-parked issue applies; a second park is a no_op with no duplicate side effects", async () => {
    const postComment = vi.fn().mockResolvedValue(undefined);
    const orchestrator = createOrchestrator({ postComment });

    const first = await orchestrator.writeIntent({
      verb: "park",
      issueId: "1",
      issueIdentifier: "ISSUE-1",
      actor: OPERATOR,
      reason: { class: "operator_pause", human: "operator requested pause" },
    });
    expect(first.status).toBe("applied");
    expect(orchestrator.getState().resumeRequired.has("1")).toBe(true);

    const second = await orchestrator.writeIntent({
      verb: "park",
      issueId: "1",
      issueIdentifier: "ISSUE-1",
      actor: OPERATOR,
      reason: { class: "operator_pause", human: "operator requested pause" },
    });
    expect(second.status).toBe("no_op");

    const applied = intentEntries(orchestrator).filter(
      (entry) => entry.metadata.status === "applied",
    );
    expect(applied).toHaveLength(1);
    // The attribution comment fired exactly once (no duplicate side effects).
    const intentComments = postComment.mock.calls.filter(([, body]) =>
      String(body).startsWith("Intent applied:"),
    );
    expect(intentComments).toHaveLength(1);
  });

  it("release on a never-parked issue is a no_op", async () => {
    const orchestrator = createOrchestrator();
    const result = await orchestrator.writeIntent({
      verb: "release",
      issueId: "1",
      issueIdentifier: "ISSUE-1",
      actor: OPERATOR,
      reason: { class: "operator_release", human: "release" },
    });
    expect(result.status).toBe("no_op");
    expect(intentEntries(orchestrator)[0]?.metadata.status).toBe("no_op");
  });

  it("repeated identical no_op writes dedupe to a single journal entry", async () => {
    const orchestrator = createOrchestrator();
    for (let i = 0; i < 3; i += 1) {
      await orchestrator.writeIntent({
        verb: "release",
        issueId: "1",
        issueIdentifier: "ISSUE-1",
        actor: OPERATOR,
        reason: { class: "operator_release", human: "release" },
      });
    }
    expect(intentEntries(orchestrator)).toHaveLength(1);
  });
});

describe("writeIntent semantics 2: fencing (rejected_stale)", () => {
  it("a release carrying a stale park generation is rejected and mutates nothing", async () => {
    const orchestrator = createOrchestrator();
    await driveNoveltyPark(orchestrator);

    const journal = orchestrator.getState().dispatcherRunJournal;
    expect(journal.some((entry) => entry.kind === "failure_exhausted")).toBe(
      true,
    );

    const stale = await orchestrator.writeIntent({
      verb: "release",
      issueId: "1",
      issueIdentifier: "ISSUE-1",
      actor: OPERATOR,
      reason: { class: "operator_release", human: "release" },
      fence: { expectedParkSeq: 999_999 },
    });
    expect(stale.status).toBe("rejected_stale");
    expect(orchestrator.getState().failed.has("1")).toBe(true);

    const staleEntry = intentEntries(orchestrator).find(
      (entry) => entry.metadata.status === "rejected_stale",
    );
    expect(staleEntry).toBeDefined();
    expect(String(staleEntry?.metadata.detail)).toContain("stale fence");
  });

  it("a release carrying the current park generation applies", async () => {
    const orchestrator = createOrchestrator();
    await driveNoveltyPark(orchestrator);

    // The park generation is observable on the issue's parked state via a
    // park no_op probe (parkGeneration metadata).
    const probe = await orchestrator.writeIntent({
      verb: "park",
      issueId: "1",
      issueIdentifier: "ISSUE-1",
      actor: OPERATOR,
      reason: { class: "probe", human: "probe" },
    });
    expect(probe.status).toBe("no_op");
    const probeEntry = intentEntries(orchestrator).at(-1);
    const generation = probeEntry?.metadata.parkGeneration;
    expect(typeof generation).toBe("number");

    const release = await orchestrator.writeIntent({
      verb: "release",
      issueId: "1",
      issueIdentifier: "ISSUE-1",
      actor: OPERATOR,
      reason: { class: "operator_release", human: "release" },
      fence: { expectedParkSeq: generation as number },
    });
    expect(release.status).toBe("applied");
    expect(orchestrator.getState().failed.has("1")).toBe(false);
  });
});

describe("writeIntent semantics 3: mandatory rendered attribution", () => {
  it("an applied intent posts a Linear comment carrying by {kind}@{host}", async () => {
    const postComment = vi.fn().mockResolvedValue(undefined);
    const orchestrator = createOrchestrator({ postComment });

    await orchestrator.writeIntent({
      verb: "park",
      issueId: "1",
      issueIdentifier: "ISSUE-1",
      actor: { kind: "operator", host: "pro14", session: "cli-7" },
      reason: { class: "operator_pause", human: "pausing for deploy" },
    });

    expect(postComment).toHaveBeenCalledWith(
      "1",
      expect.stringContaining("by operator@pro14 (session cli-7)"),
    );
    expect(postComment).toHaveBeenCalledWith(
      "1",
      expect.stringContaining("pausing for deploy"),
    );
    // The journal summary carries the same attribution.
    const entry = intentEntries(orchestrator)[0];
    expect(entry?.summary).toContain("by operator@pro14");
  });

  it("manual halts route through the intent layer with operator attribution", async () => {
    const orchestrator = createOrchestrator();
    await orchestrator.pollTick();
    expect(orchestrator.getState().running["1"]).toBeDefined();

    const stopRequest = await orchestrator.requestStopByIdentifier("ISSUE-1");
    expect(stopRequest).not.toBeNull();
    expect(stopRequest?.reason).toBe("manual_stop");

    const haltEntry = intentEntries(orchestrator).find(
      (entry) => entry.metadata.verb === "halt",
    );
    expect(haltEntry).toBeDefined();
    expect(haltEntry?.metadata.status).toBe("applied");
    const actor = haltEntry?.metadata.actor as { kind: string; host: string };
    expect(actor.kind).toBe("operator");
    expect(actor.host.length).toBeGreaterThan(0);
  });
});

describe("writeIntent semantics 4: replay convergence (SYMPH-368 regression)", () => {
  it("replay of a watchdog park followed by an intent release converges on released", async () => {
    const first = createOrchestrator();
    await driveNoveltyPark(first);

    // Without a release, replay re-creates the park (baseline).
    const replayParked = createOrchestrator({
      runJournal: first.getState().dispatcherRunJournal,
    });
    expect(replayParked.getState().resumeRequired.has("1")).toBe(true);

    // Operator releases through the intent layer...
    const release = await first.writeIntent({
      verb: "release",
      issueId: "1",
      issueIdentifier: "ISSUE-1",
      actor: OPERATOR,
      reason: { class: "operator_release", human: "released after host fix" },
    });
    expect(release.status).toBe("applied");

    // ...and replay now converges on released instead of re-parking over
    // the operator (the SYMPH-368 incident shape).
    const replayReleased = createOrchestrator({
      runJournal: first.getState().dispatcherRunJournal,
    });
    expect(replayReleased.getState().resumeRequired.has("1")).toBe(false);
    expect(replayReleased.getState().failed.has("1")).toBe(false);
  });

  it("replay of park → release → park converges on parked (sequence order wins)", async () => {
    const first = createOrchestrator();
    await first.writeIntent({
      verb: "park",
      issueId: "1",
      issueIdentifier: "ISSUE-1",
      actor: OPERATOR,
      reason: { class: "operator_pause", human: "pause 1" },
    });
    await first.writeIntent({
      verb: "release",
      issueId: "1",
      issueIdentifier: "ISSUE-1",
      actor: OPERATOR,
      reason: { class: "operator_release", human: "release 1" },
    });
    await first.writeIntent({
      verb: "park",
      issueId: "1",
      issueIdentifier: "ISSUE-1",
      actor: OPERATOR,
      reason: { class: "operator_pause", human: "pause 2" },
    });

    const replayed = createOrchestrator({
      runJournal: first.getState().dispatcherRunJournal,
    });
    expect(replayed.getState().resumeRequired.has("1")).toBe(true);
  });
});

describe("idempotency-key actor discriminator (SYMPH-422)", () => {
  const WATCHDOG: IntentActor = { kind: "watchdog-l2", host: "pro14" };

  it("distinct actors minting same-verb-same-generation intents journal separately", async () => {
    const orchestrator = createOrchestrator();
    await driveNoveltyPark(orchestrator);

    // escalate_human at the SAME park generation — exactly the collision
    // the discriminator exists for (pre-SYMPH-422 the second actor's entry
    // silently collapsed onto the first actor's key). The verb itself is
    // idempotent per park (council P2), so the second actor records a
    // no_op — but its attribution and rationale now survive as a journal
    // entry of its own instead of vanishing.
    const first = await orchestrator.writeIntent({
      verb: "escalate_human",
      issueId: "1",
      issueIdentifier: "ISSUE-1",
      actor: OPERATOR,
      reason: { class: "operator_escalate", human: "paging on-call" },
    });
    const second = await orchestrator.writeIntent({
      verb: "escalate_human",
      issueId: "1",
      issueIdentifier: "ISSUE-1",
      actor: WATCHDOG,
      reason: { class: "stuck_triage_escalate", human: "model paged human" },
    });
    expect(first.status).toBe("applied");
    expect(second.status).toBe("no_op");
    expect(second.detail).toContain("already escalated");

    const escalations = intentEntries(orchestrator).filter(
      (entry) => entry.metadata.verb === "escalate_human",
    );
    expect(escalations).toHaveLength(2);
    const kinds = escalations.map(
      (entry) => (entry.metadata.actor as { kind: string }).kind,
    );
    expect(kinds).toEqual(["operator", "watchdog-l2"]);
  });

  it("distinct actors' no_op audit entries journal separately", async () => {
    const orchestrator = createOrchestrator();
    await orchestrator.writeIntent({
      verb: "release",
      issueId: "1",
      issueIdentifier: "ISSUE-1",
      actor: OPERATOR,
      reason: { class: "operator_release", human: "release" },
    });
    await orchestrator.writeIntent({
      verb: "release",
      issueId: "1",
      issueIdentifier: "ISSUE-1",
      actor: WATCHDOG,
      reason: { class: "stuck_triage_release", human: "release" },
    });
    expect(intentEntries(orchestrator)).toHaveLength(2);
  });

  it("the same actor+session re-issuing an identical write still dedupes", async () => {
    const orchestrator = createOrchestrator();
    await driveNoveltyPark(orchestrator);

    const sessionActor: IntentActor = {
      kind: "operator",
      host: "pro14",
      session: "cli-7",
    };
    for (let i = 0; i < 3; i += 1) {
      await orchestrator.writeIntent({
        verb: "escalate_human",
        issueId: "1",
        issueIdentifier: "ISSUE-1",
        actor: sessionActor,
        reason: { class: "operator_escalate", human: "paging on-call" },
      });
    }
    // First call applies; the second records a no_op (already escalated for
    // this park, council P2); the third is an identical no_op that dedupes
    // onto the second's key — exactly two entries, never three.
    const escalations = intentEntries(orchestrator).filter(
      (entry) => entry.metadata.verb === "escalate_human",
    );
    expect(escalations).toHaveLength(2);
    expect(escalations.map((entry) => entry.metadata.status)).toEqual([
      "applied",
      "no_op",
    ]);
  });

  it("the same kind+host with different sessions journal separately", async () => {
    const orchestrator = createOrchestrator();
    await driveNoveltyPark(orchestrator);

    for (const session of ["cli-7", "cli-8"]) {
      await orchestrator.writeIntent({
        verb: "escalate_human",
        issueId: "1",
        issueIdentifier: "ISSUE-1",
        actor: { kind: "operator", host: "pro14", session },
        reason: { class: "operator_escalate", human: "paging on-call" },
      });
    }
    const escalations = intentEntries(orchestrator).filter(
      (entry) => entry.metadata.verb === "escalate_human",
    );
    expect(escalations).toHaveLength(2);
  });

  it("delimiter escaping: hosts/sessions composing the same raw string still mint distinct keys", async () => {
    const orchestrator = createOrchestrator();
    // Without component escaping both actors would compose the raw key
    // segment "operator@h#a#b" and the second no_op would silently dedupe
    // onto the first actor's entry.
    await orchestrator.writeIntent({
      verb: "release",
      issueId: "1",
      issueIdentifier: "ISSUE-1",
      actor: { kind: "operator", host: "h", session: "a#b" },
      reason: { class: "operator_release", human: "release" },
    });
    await orchestrator.writeIntent({
      verb: "release",
      issueId: "1",
      issueIdentifier: "ISSUE-1",
      actor: { kind: "operator", host: "h#a", session: "b" },
      reason: { class: "operator_release", human: "release" },
    });
    expect(intentEntries(orchestrator)).toHaveLength(2);
  });

  it("replay with multi-actor entries at one generation still converges", async () => {
    const first = createOrchestrator();
    await driveNoveltyPark(first);

    await first.writeIntent({
      verb: "escalate_human",
      issueId: "1",
      issueIdentifier: "ISSUE-1",
      actor: OPERATOR,
      reason: { class: "operator_escalate", human: "paging on-call" },
    });
    await first.writeIntent({
      verb: "escalate_human",
      issueId: "1",
      issueIdentifier: "ISSUE-1",
      actor: WATCHDOG,
      reason: { class: "stuck_triage_escalate", human: "model paged human" },
    });

    // Both escalations are state-preserving: replay keeps the park standing.
    const replayParked = createOrchestrator({
      runJournal: first.getState().dispatcherRunJournal,
    });
    expect(replayParked.getState().resumeRequired.has("1")).toBe(true);

    // A release after the multi-actor escalations still wins on replay
    // (sequence order converges regardless of how many actors journaled).
    await first.writeIntent({
      verb: "release",
      issueId: "1",
      issueIdentifier: "ISSUE-1",
      actor: OPERATOR,
      reason: { class: "operator_release", human: "released after page" },
    });
    const replayReleased = createOrchestrator({
      runJournal: first.getState().dispatcherRunJournal,
    });
    expect(replayReleased.getState().resumeRequired.has("1")).toBe(false);
    expect(replayReleased.getState().failed.has("1")).toBe(false);
  });
});

describe("escalate_human idempotency across the key-format migration (council P2)", () => {
  it("replay of a #374-era old-format applied escalation makes a post-restart re-issue a no_op with no duplicate comment", async () => {
    const first = createOrchestrator();
    await driveNoveltyPark(first);
    const escalation = await first.writeIntent({
      verb: "escalate_human",
      issueId: "1",
      issueIdentifier: "ISSUE-1",
      actor: OPERATOR,
      reason: { class: "operator_escalate", human: "paging on-call" },
    });
    expect(escalation.status).toBe("applied");

    // Rewrite the journaled escalation's idempotency key to the pre-422
    // (#374) shape — no actor discriminator. The replay restore must match
    // on verb+status, never on key shape, or every upgrade restart
    // double-applies each pre-existing journaled escalation.
    const journal = first.getState().dispatcherRunJournal.map((entry) =>
      entry.kind === "intent" &&
      entry.metadata.verb === "escalate_human" &&
      entry.metadata.status === "applied"
        ? {
            ...entry,
            idempotencyKey: `intent:escalate_human:1:gen-${entry.metadata.parkGeneration}`,
          }
        : entry,
    );

    const postComment = vi.fn().mockResolvedValue(undefined);
    const restarted = createOrchestrator({ runJournal: journal, postComment });
    expect(restarted.getState().resumeRequired.has("1")).toBe(true);

    const reissue = await restarted.writeIntent({
      verb: "escalate_human",
      issueId: "1",
      issueIdentifier: "ISSUE-1",
      actor: OPERATOR,
      reason: { class: "operator_escalate", human: "paging on-call" },
    });
    expect(reissue.status).toBe("no_op");
    expect(reissue.detail).toContain("already escalated");
    const escalationComments = postComment.mock.calls.filter(([, body]) =>
      String(body).startsWith("Intent applied: escalate_human"),
    );
    expect(escalationComments).toHaveLength(0);
  });

  it("release → re-park mints a new generation and permits re-escalation", async () => {
    const orchestrator = createOrchestrator();
    await driveNoveltyPark(orchestrator);

    const firstEscalation = await orchestrator.writeIntent({
      verb: "escalate_human",
      issueId: "1",
      issueIdentifier: "ISSUE-1",
      actor: OPERATOR,
      reason: { class: "operator_escalate", human: "paging on-call" },
    });
    expect(firstEscalation.status).toBe("applied");

    await orchestrator.writeIntent({
      verb: "release",
      issueId: "1",
      issueIdentifier: "ISSUE-1",
      actor: OPERATOR,
      reason: { class: "operator_release", human: "released after page" },
    });
    const repark = await orchestrator.writeIntent({
      verb: "park",
      issueId: "1",
      issueIdentifier: "ISSUE-1",
      actor: OPERATOR,
      reason: { class: "operator_pause", human: "new problem, new park" },
    });
    expect(repark.status).toBe("applied");

    const secondEscalation = await orchestrator.writeIntent({
      verb: "escalate_human",
      issueId: "1",
      issueIdentifier: "ISSUE-1",
      actor: OPERATOR,
      reason: { class: "operator_escalate", human: "paging on-call again" },
    });
    expect(secondEscalation.status).toBe("applied");
  });
});

describe("sync pause-triage continue routes through writeIntent (SYMPH-422)", () => {
  const BUDGET_PAUSE = {
    outcome: "PAUSED-budget" as const,
    trigger: "token_budget" as const,
    reason: "Token budget exceeded.",
    turnCount: 2,
    totalTokens: 250_001,
    estimatedCostUsd: 5,
  };

  it("a continue verdict produces an applied resume intent attributed to watchdog-l2", async () => {
    const orchestrator = createOrchestrator({
      runPauseTriage: async () => ({
        verdict: "continue",
        rationale: "Real diff in progress; one unit should finish.",
      }),
    });

    await orchestrator.pollTick();
    const retryEntry = await orchestrator.onWorkerExit({
      issueId: "1",
      outcome: "normal",
      hardStop: BUDGET_PAUSE,
    });

    // Observable behavior is unchanged: one continuation, no park.
    expect(retryEntry?.delayType).toBe("continuation");
    expect(orchestrator.getState().resumeRequired.has("1")).toBe(false);
    expect(orchestrator.getState().issuePauseTriageResumes["1"]).toBe(1);

    // Parity gain: the continue is an intent journal entry like every
    // other verb caller — attributed, reasoned, replayable.
    const resumeEntry = intentEntries(orchestrator).find(
      (entry) => entry.metadata.verb === "resume",
    );
    expect(resumeEntry).toBeDefined();
    expect(resumeEntry?.metadata.status).toBe("applied");
    const actor = resumeEntry?.metadata.actor as { kind: string };
    expect(actor.kind).toBe("watchdog-l2");
    const reason = resumeEntry?.metadata.reason as { class: string };
    expect(reason.class).toBe("pause_triage_continue");
  });

  it("replay of a journaled resume converges on dispatch-eligible (no park)", async () => {
    const first = createOrchestrator({
      runPauseTriage: async () => ({
        verdict: "continue",
        rationale: "Real diff in progress; one unit should finish.",
      }),
    });
    await first.pollTick();
    await first.onWorkerExit({
      issueId: "1",
      outcome: "normal",
      hardStop: BUDGET_PAUSE,
    });

    const replayed = createOrchestrator({
      runJournal: first.getState().dispatcherRunJournal,
    });
    expect(replayed.getState().resumeRequired.has("1")).toBe(false);
    expect(replayed.getState().failed.has("1")).toBe(false);
  });

  it("resume on a parked issue is a no_op — release/retry_once own park clearing", async () => {
    const orchestrator = createOrchestrator();
    await driveNoveltyPark(orchestrator);

    const result = await orchestrator.writeIntent({
      verb: "resume",
      issueId: "1",
      issueIdentifier: "ISSUE-1",
      actor: { kind: "watchdog-l2", host: "pro14" },
      reason: { class: "pause_triage_continue", human: "continue" },
    });
    expect(result.status).toBe("no_op");
    expect(result.retryEntry).toBeUndefined();
    expect(orchestrator.getState().failed.has("1")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Harness (mirrors tests/orchestrator/retry-novelty.test.ts)
// ---------------------------------------------------------------------------

function createOrchestrator(overrides?: {
  postComment?: (issueId: string, body: string) => Promise<void>;
  updateIssueState?: OrchestratorCoreOptions["updateIssueState"];
  runJournal?: OrchestratorCoreOptions["runJournal"];
  runPauseTriage?: OrchestratorCoreOptions["runPauseTriage"];
}): OrchestratorCore {
  const options: OrchestratorCoreOptions = {
    config: createConfig(),
    tracker: createTracker(),
    spawnWorker: async () => ({
      workerHandle: { pid: 9001 },
      monitorHandle: { ref: "monitor-1" },
    }),
    ...(overrides?.postComment !== undefined
      ? { postComment: overrides.postComment }
      : {}),
    ...(overrides?.updateIssueState !== undefined
      ? { updateIssueState: overrides.updateIssueState }
      : {}),
    ...(overrides?.runJournal !== undefined
      ? { runJournal: overrides.runJournal }
      : {}),
    ...(overrides?.runPauseTriage !== undefined
      ? { runPauseTriage: overrides.runPauseTriage }
      : {}),
    now: () => new Date("2026-06-11T12:00:00.000Z"),
  };
  return new OrchestratorCore(options);
}

function createTracker(): IssueTracker {
  return {
    async fetchCandidateIssues() {
      return [createIssue()];
    },
    async fetchIssuesByStates() {
      return [];
    },
    async fetchIssueStatesByIds() {
      return [{ id: "1", identifier: "ISSUE-1", state: "In Progress" }];
    },
  };
}

function createConfig(): ResolvedWorkflowConfig {
  return {
    workflowPath: "/tmp/WORKFLOW.md",
    promptTemplate: "Prompt",
    tracker: {
      kind: "linear",
      endpoint: "https://api.linear.app/graphql",
      apiKey: "token",
      projectSlug: "project",
      // SYMPH-409 contract: active_states must include the Resume
      // readmission state or validateDispatchConfig fails the poll tick.
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
    },
    stages: createStages(),
    escalationState: "Blocked",
  };
}

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
          onComplete: "done",
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
}

function createIssue(overrides?: Partial<Issue>): Issue {
  return {
    id: "1",
    identifier: "ISSUE-1",
    title: "Example issue",
    description: null,
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
