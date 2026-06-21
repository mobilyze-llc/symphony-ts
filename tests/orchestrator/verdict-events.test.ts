import { describe, expect, it, vi } from "vitest";

import type { ResolvedWorkflowConfig } from "../../src/config/types.js";
import type {
  DispatchGateInfo,
  DispatcherRunJournal,
  DispatcherRunJournalEntry,
  Issue,
} from "../../src/domain/model.js";
import { normalizeErrorSignature } from "../../src/errors/signature.js";
import { buildRuntimeSnapshot } from "../../src/logging/runtime-snapshot.js";
import {
  OrchestratorCore,
  type OrchestratorCoreOptions,
  PIPELINE_VERDICT_SCOPE_ID,
} from "../../src/orchestrator/core.js";
import { formatNotification } from "../../src/orchestrator/pipeline-notifier.js";
import type { IssueTracker } from "../../src/tracker/tracker.js";

const NOW = new Date("2026-03-06T00:00:05.000Z");

describe("dispatch verdict events (SYMPH-405)", () => {
  it("emits one halt verdict keyed on the halt issue and dedupes across ticks", async () => {
    const haltIssue = createIssue({
      id: "halt-1",
      identifier: "OPS-HALT",
      title: "Stop the pipeline",
      state: "Todo",
    });
    const tracker = createTracker({
      candidates: [createIssue({ id: "1", identifier: "ISSUE-1" })],
    });
    tracker.fetchIssuesByLabels = async () => [haltIssue];
    const orchestrator = createOrchestrator({ tracker });

    const first = await orchestrator.pollTick();
    expect(first.dispatchedIssueIds).toEqual([]);

    const verdicts = verdictEntries(orchestrator);
    expect(verdicts).toHaveLength(1);
    expect(verdicts[0]).toMatchObject({
      issueId: "halt-1",
      issueIdentifier: "OPS-HALT",
      metadata: {
        schema_version: 1,
        disposition: "halt",
        reason_code: "pipeline_halt",
      },
    });
    expect(verdicts[0]?.metadata.actor).toMatchObject({ kind: "dispatcher" });
    expect((verdicts[0]?.metadata.actor as { host?: unknown }).host).toBeTypeOf(
      "string",
    );

    // Unchanged disposition: a second tick must not append a new entry.
    await orchestrator.pollTick();
    expect(verdictEntries(orchestrator)).toHaveLength(1);

    expect(orchestrator.getState().issueDispositions["halt-1"]).toMatchObject({
      disposition: "halt",
      reasonCode: "pipeline_halt",
    });
  });

  it("emits a gate verdict with floor + headroom remedy when the rate-limit floor blocks, and journals the recovery flip", async () => {
    const transitions: Array<{ disposition: string; reasonCode: string }> = [];
    const orchestrator = createOrchestrator({
      config: createConfig({
        rateLimitAdmission: {
          minPrimaryHeadroomPct: null,
          minSecondaryHeadroomPct: 5,
        },
      }),
      onVerdictTransition: (input) => {
        transitions.push({
          disposition: input.disposition,
          reasonCode: input.reasonCode,
        });
      },
    });
    orchestrator.getState().codexRateLimits = {
      secondary: {
        used_percent: 98,
        window_minutes: 10_080,
        resets_at: 4_102_444_800,
      },
    };

    await orchestrator.pollTick();
    let verdicts = verdictEntries(orchestrator);
    expect(verdicts).toHaveLength(1);
    expect(verdicts[0]).toMatchObject({
      issueId: PIPELINE_VERDICT_SCOPE_ID,
      metadata: {
        disposition: "gate",
        reason_code: "rate_window_secondary_floor",
      },
    });
    const remedy = verdicts[0]?.metadata.remedy;
    expect(remedy).toContain("floor 5%");
    expect(remedy).toContain("2.0%"); // observed headroom (100 - 98)
    expect(transitions).toEqual([
      { disposition: "gate", reasonCode: "rate_window_secondary_floor" },
    ]);

    // Second blocked tick: no new entry, no re-alert.
    await orchestrator.pollTick();
    expect(verdictEntries(orchestrator)).toHaveLength(1);
    expect(transitions).toHaveLength(1);

    // Floor clears → the flip back is journaled on the synthetic scope.
    orchestrator.getState().codexRateLimits = {
      secondary: {
        used_percent: 10,
        window_minutes: 10_080,
        resets_at: 4_102_444_800,
      },
    };
    await orchestrator.pollTick();
    verdicts = verdictEntries(orchestrator).filter(
      (entry) => entry.issueId === PIPELINE_VERDICT_SCOPE_ID,
    );
    expect(verdicts).toHaveLength(2);
    expect(verdicts[1]?.metadata).toMatchObject({
      disposition: "admit",
      reason_code: "rate_window_clear",
    });
  });

  it("emits the requires_explicit_resume skip verdict with the Resume remedy, dedupes, then flips to admit on Resume", async () => {
    let issueState = "Todo";
    const config = createConfig();
    config.tracker.activeStates = [
      "Todo",
      "In Progress",
      "In Review",
      "Resume",
    ];
    const orchestrator = createOrchestrator({
      config,
      tracker: createTracker({
        candidatesFn: () => [
          createIssue({ id: "1", identifier: "ISSUE-1", state: issueState }),
        ],
      }),
    });

    await orchestrator.pollTick();
    await orchestrator.onWorkerExit({
      issueId: "1",
      outcome: "normal",
      hardStop: {
        outcome: "PAUSED-budget",
        trigger: "premium_spend_near_ceiling",
        reason: "Estimated premium spend is near ceiling.",
        turnCount: 2,
        totalTokens: 150_000,
        estimatedCostUsd: 40,
      },
    });

    // Todo alone is skipped — THIS is the verdict that was invisible on
    // 2026-06-11.
    await orchestrator.pollTick();
    const skips = verdictEntries(orchestrator).filter(
      (entry) => entry.metadata.reason_code === "requires_explicit_resume",
    );
    expect(skips).toHaveLength(1);
    expect(skips[0]).toMatchObject({
      issueId: "1",
      metadata: {
        disposition: "skip",
        remedy: "transition the issue into Resume (Todo alone is skipped)",
      },
    });

    // Unchanged on the next tick.
    await orchestrator.pollTick();
    expect(
      verdictEntries(orchestrator).filter(
        (entry) => entry.metadata.reason_code === "requires_explicit_resume",
      ),
    ).toHaveLength(1);

    // Operator transitions to Resume → dispatch → verdict flips to admit.
    issueState = "Resume";
    const resumed = await orchestrator.pollTick();
    expect(resumed.dispatchedIssueIds).toEqual(["1"]);
    expect(orchestrator.getState().issueDispositions["1"]).toMatchObject({
      disposition: "admit",
      reasonCode: "dispatched",
    });
  });

  it("emits claimed / no_slots / no_state_slots / blocked_by_open skip verdicts", async () => {
    const orchestrator = createOrchestrator({
      config: createConfig({
        agent: {
          maxConcurrentAgents: 2,
          maxConcurrentAgentsByState: { "in progress": 1 },
        },
      }),
      tracker: createTracker({
        candidates: [createIssue({ id: "1", identifier: "ISSUE-1" })],
      }),
    });

    // claimed: a live claim without a running entry.
    orchestrator.getState().claimed.add("c1");
    expect(
      orchestrator.isDispatchEligible(
        createIssue({ id: "c1", identifier: "ISSUE-C1" }),
      ),
    ).toBe(false);
    expect(lastVerdict(orchestrator)).toMatchObject({
      issueId: "c1",
      metadata: { disposition: "skip", reason_code: "claimed" },
    });

    // blocked_by_open: blocker identifiers ride in details.
    expect(
      orchestrator.isDispatchEligible(
        createIssue({
          id: "b1",
          identifier: "ISSUE-B1",
          blockedBy: [{ id: "x", identifier: "BLOCK-1", state: "In Progress" }],
        }),
      ),
    ).toBe(false);
    expect(lastVerdict(orchestrator)).toMatchObject({
      issueId: "b1",
      metadata: { disposition: "skip", reason_code: "blocked_by_open" },
    });
    expect(
      (lastVerdict(orchestrator)?.metadata.details as { blockers: unknown[] })
        .blockers,
    ).toEqual([{ id: "x", identifier: "BLOCK-1", state: "In Progress" }]);

    // Occupy one In Progress slot (state cap 1) → no_state_slots for a
    // second In Progress candidate; raw slots remain (max 2).
    await orchestrator.pollTick();
    expect(
      orchestrator.isDispatchEligible(
        createIssue({ id: "s1", identifier: "ISSUE-S1", state: "In Progress" }),
      ),
    ).toBe(false);
    expect(lastVerdict(orchestrator)).toMatchObject({
      issueId: "s1",
      metadata: { disposition: "skip", reason_code: "no_state_slots" },
    });
  });

  it("emits no_slots when global concurrency is exhausted", async () => {
    const orchestrator = createOrchestrator({
      config: createConfig({ agent: { maxConcurrentAgents: 1 } }),
      tracker: createTracker({
        candidates: [createIssue({ id: "1", identifier: "ISSUE-1" })],
      }),
    });
    await orchestrator.pollTick(); // fills the single slot

    expect(
      orchestrator.isDispatchEligible(
        createIssue({ id: "2", identifier: "ISSUE-2" }),
      ),
    ).toBe(false);
    expect(lastVerdict(orchestrator)).toMatchObject({
      issueId: "2",
      metadata: { disposition: "skip", reason_code: "no_slots" },
    });
  });

  it("emits an admit verdict with the right-sizing summary on successful dispatch", async () => {
    const orchestrator = createOrchestrator();

    const result = await orchestrator.pollTick();
    expect(result.dispatchedIssueIds).toEqual(["1"]);

    const admits = verdictEntries(orchestrator).filter(
      (entry) => entry.metadata.disposition === "admit",
    );
    expect(admits).toHaveLength(1);
    expect(admits[0]).toMatchObject({
      issueId: "1",
      metadata: { reason_code: "dispatched" },
    });
    expect((admits[0]?.metadata.details as { mode?: unknown }).mode).toBeTypeOf(
      "string",
    );
  });

  it("journals a flip-back (A→B→A) with a unique idempotency key instead of silently dropping it", () => {
    const orchestrator = createOrchestrator();
    const blocked = createIssue({
      id: "f1",
      identifier: "ISSUE-F1",
      blockedBy: [{ id: "x", identifier: "BLOCK-1", state: "In Progress" }],
    });
    const claimedIssue = createIssue({ id: "f1", identifier: "ISSUE-F1" });

    orchestrator.isDispatchEligible(blocked); // skip/blocked_by_open
    orchestrator.getState().claimed.add("f1");
    orchestrator.isDispatchEligible(claimedIssue); // skip/claimed
    orchestrator.getState().claimed.delete("f1");
    orchestrator.isDispatchEligible(blocked); // back to skip/blocked_by_open

    const entries = verdictEntries(orchestrator).filter(
      (entry) => entry.issueId === "f1",
    );
    expect(entries).toHaveLength(3);
    expect(entries.map((entry) => entry.metadata.reason_code)).toEqual([
      "blocked_by_open",
      "claimed",
      "blocked_by_open",
    ]);
    const keys = entries.map((entry) => entry.idempotencyKey);
    expect(new Set(keys).size).toBe(3);
  });

  it("journals cluster growth and systemic transitions with full membership snapshots", async () => {
    const tracker = createTracker({
      candidates: [
        createIssue({ id: "1", identifier: "ISSUE-1" }),
        createIssue({ id: "2", identifier: "ISSUE-2" }),
      ],
    });
    const orchestrator = createOrchestrator({ tracker });
    await orchestrator.pollTick();

    const reason =
      "EPERM: operation not permitted, open '.git/index.lock' (permanent)";
    await orchestrator.onWorkerExit({
      issueId: "1",
      outcome: "abnormal",
      reason,
    });
    await orchestrator.onWorkerExit({
      issueId: "2",
      outcome: "abnormal",
      reason,
    });

    const clusterEntries = orchestrator
      .getState()
      .dispatcherRunJournal.filter(
        (entry) => entry.kind === "cluster_transition",
      );
    expect(clusterEntries).toHaveLength(2);
    expect(clusterEntries[0]?.metadata).toMatchObject({
      schema_version: 1,
      transition: "growth",
      issueCount: 1,
    });
    expect(clusterEntries[1]?.metadata).toMatchObject({
      schema_version: 1,
      transition: "systemic",
      issueCount: 2,
    });
    const details = clusterEntries[1]?.metadata.details as {
      members: Array<{ issueId: string }>;
      lastAlertSize: number;
    };
    expect(details.members.map((member) => member.issueId).sort()).toEqual([
      "1",
      "2",
    ]);
    expect(details.lastAlertSize).toBe(2);
  });

  it("rehydrates the signature cluster registry from journaled cluster transitions (restart amnesia)", async () => {
    const reason =
      "EPERM: operation not permitted, open '.git/index.lock' (permanent)";
    const signature = normalizeErrorSignature(`worker exited: ${reason}`);

    // Journal from a previous process: issue A already counted once.
    const journal: DispatcherRunJournal = [
      {
        sequence: 1,
        idempotencyKey: `cluster:${signature.signature}:prev-A:t0`,
        timestamp: "2026-03-06T00:00:00.000Z",
        kind: "cluster_transition",
        issueId: "prev-A",
        issueIdentifier: "ISSUE-A",
        operation: "dispatcher",
        stage: null,
        attempt: null,
        ownerId: "previous-runtime",
        lease: null,
        summary: "cluster growth",
        metadata: {
          schema_version: 1,
          transition: "growth",
          signature: signature.signature,
          issueCount: 1,
          stages: [],
          details: {
            errorClass: signature.class,
            normalizedText: signature.normalizedText,
            members: [
              {
                issueId: "prev-A",
                issueIdentifier: "ISSUE-A",
                stageName: null,
                recordedAt: "2026-03-06T00:00:00.000Z",
                normalizedText: signature.normalizedText,
              },
            ],
            lastAlertSize: 0,
          },
        },
      },
    ];

    const alerts: Array<{ clusterSize: number; issueIdentifiers: string[] }> =
      [];
    const orchestrator = createOrchestrator({
      runJournal: journal,
      onSystemicCluster: (input) => {
        alerts.push({
          clusterSize: input.clusterSize,
          issueIdentifiers: input.issueIdentifiers,
        });
      },
    });

    // Replay must not perturb lease/claim rebuilds.
    expect(orchestrator.getState().claimed.size).toBe(0);
    expect(Object.keys(orchestrator.getState().dispatcherLeases)).toHaveLength(
      0,
    );

    // One more distinct issue failing post-restart tips the cluster to
    // SYSTEMIC — without hydration the count would have reset to zero.
    await orchestrator.pollTick();
    await orchestrator.onWorkerExit({
      issueId: "1",
      outcome: "abnormal",
      reason,
    });

    expect(alerts).toHaveLength(1);
    expect(alerts[0]?.clusterSize).toBe(2);
    expect(alerts[0]?.issueIdentifiers.sort()).toEqual(["ISSUE-1", "ISSUE-A"]);
  });

  it("rehydrates dispatch verdicts on replay so an unchanged disposition does not re-journal", () => {
    const journal: DispatcherRunJournal = [
      {
        sequence: 1,
        idempotencyKey: "verdict:c1:skip:claimed",
        timestamp: "2026-03-06T00:00:00.000Z",
        kind: "dispatch_verdict",
        issueId: "c1",
        issueIdentifier: "ISSUE-C1",
        operation: "dispatcher",
        stage: null,
        attempt: null,
        ownerId: "previous-runtime",
        lease: null,
        summary: "verdict fixture",
        metadata: {
          schema_version: 1,
          disposition: "skip",
          reason_code: "claimed",
          remedy: "wait",
          actor: { kind: "dispatcher", host: "prev-host" },
          details: {},
        },
      },
    ];
    const orchestrator = createOrchestrator({ runJournal: journal });

    expect(orchestrator.getState().issueDispositions.c1).toMatchObject({
      disposition: "skip",
      reasonCode: "claimed",
      since: "2026-03-06T00:00:00.000Z",
    });

    // Same condition post-restart: dedup map was rehydrated, no new entry.
    orchestrator.getState().claimed.add("c1");
    orchestrator.isDispatchEligible(
      createIssue({ id: "c1", identifier: "ISSUE-C1" }),
    );
    expect(verdictEntries(orchestrator)).toHaveLength(1);
  });

  it("journals breaker open/close transitions and rehydrates breaker state on replay", async () => {
    const config = createConfig({ agent: { maxConcurrentAgents: 2 } });
    config.tracker.activeStates = [
      "Todo",
      "In Progress",
      "In Review",
      "Resume",
    ];
    config.stages = createImplementStages();
    const tracker = createTracker({
      candidates: [
        createIssue({ id: "1", identifier: "ISSUE-1" }),
        createIssue({ id: "2", identifier: "ISSUE-2" }),
      ],
    });
    const orchestrator = createOrchestrator({ config, tracker });
    await orchestrator.pollTick();

    const reason =
      "EPERM: operation not permitted, open '.git/index.lock' (permanent)";
    await orchestrator.onWorkerExit({
      issueId: "1",
      outcome: "abnormal",
      reason,
    });
    await orchestrator.onWorkerExit({
      issueId: "2",
      outcome: "abnormal",
      reason,
    });

    const breakerEntries = () =>
      orchestrator
        .getState()
        .dispatcherRunJournal.filter(
          (entry) => entry.kind === "breaker_transition",
        );
    expect(breakerEntries()).toHaveLength(1);
    expect(breakerEntries()[0]?.metadata).toMatchObject({
      schema_version: 1,
      transition: "opened",
      stage: "implement",
    });
    expect(breakerEntries()[0]?.metadata.actor).toMatchObject({
      kind: "dispatcher",
    });

    // Operator resume closes the breaker → "closed" transition journaled.
    orchestrator.getState().failed.add("1");
    orchestrator.isDispatchEligible(
      createIssue({ id: "1", identifier: "ISSUE-1", state: "Resume" }),
    );
    expect(breakerEntries()).toHaveLength(2);
    expect(breakerEntries()[1]?.metadata).toMatchObject({
      transition: "closed",
      stage: "implement",
    });

    // Replay: an opened entry without a closed entry parks dispatch at the
    // boundary; opened+closed dispatches normally.
    const openedOnly = breakerEntries().slice(0, 1);
    const replayConfig = createConfig();
    replayConfig.tracker.activeStates = [
      "Todo",
      "In Progress",
      "In Review",
      "Resume",
    ];
    replayConfig.stages = createImplementStages();
    const replayed = createOrchestrator({
      config: replayConfig,
      tracker: createTracker({
        candidates: [createIssue({ id: "9", identifier: "ISSUE-9" })],
      }),
      runJournal: openedOnly.map((entry, index) => ({
        ...entry,
        sequence: index + 1,
      })),
    });
    const parked = await replayed.pollTick();
    expect(parked.dispatchedIssueIds).toEqual([]);
    expect(replayed.getState().failed.has("9")).toBe(true);

    const bothConfig = createConfig();
    bothConfig.tracker.activeStates = [
      "Todo",
      "In Progress",
      "In Review",
      "Resume",
    ];
    bothConfig.stages = createImplementStages();
    const recovered = createOrchestrator({
      config: bothConfig,
      tracker: createTracker({
        candidates: [createIssue({ id: "9", identifier: "ISSUE-9" })],
      }),
      runJournal: breakerEntries().map((entry, index) => ({
        ...entry,
        sequence: index + 1,
      })),
    });
    const dispatched = await recovered.pollTick();
    expect(dispatched.dispatchedIssueIds).toEqual(["9"]);
  });

  it("journals same-millisecond breaker opened→closed→opened and cluster re-entry under distinct idempotency keys", async () => {
    // Frozen clock: every transition shares one timestamp, so a
    // timestamp-suffixed key would silently drop the re-opened breaker
    // entry and the re-entered cluster membership snapshot.
    const config = createConfig({ agent: { maxConcurrentAgents: 2 } });
    config.tracker.activeStates = [
      "Todo",
      "In Progress",
      "In Review",
      "Resume",
    ];
    config.stages = createImplementStages();
    let candidates = [
      createIssue({ id: "1", identifier: "ISSUE-1" }),
      createIssue({ id: "2", identifier: "ISSUE-2" }),
    ];
    const tracker = createTracker({ candidatesFn: () => candidates });
    const orchestrator = createOrchestrator({ config, tracker });
    await orchestrator.pollTick();

    const reason =
      "EPERM: operation not permitted, open '.git/index.lock' (permanent)";
    await orchestrator.onWorkerExit({
      issueId: "1",
      outcome: "abnormal",
      reason,
    });
    await orchestrator.onWorkerExit({
      issueId: "2",
      outcome: "abnormal",
      reason,
    });

    const entriesOfKind = (kind: string) =>
      orchestrator
        .getState()
        .dispatcherRunJournal.filter((entry) => entry.kind === kind);
    expect(entriesOfKind("breaker_transition")).toHaveLength(1);

    // Operator resume of issue 1 closes the breaker and clears its cluster
    // membership — all at the same frozen timestamp as the open.
    orchestrator.getState().failed.add("1");
    orchestrator.isDispatchEligible(
      createIssue({ id: "1", identifier: "ISSUE-1", state: "Resume" }),
    );
    expect(entriesOfKind("breaker_transition")).toHaveLength(2);

    // Re-dispatch issue 1 and fail it again with the same signature: the
    // cluster re-crosses threshold and the breaker re-opens in the same
    // millisecond as the first open. Perturb the stored per-issue failure
    // signature so the repeat is NOT parked as retry-futile (that park path
    // skips cluster recording) and reaches the cluster registry.
    candidates = [createIssue({ id: "1", identifier: "ISSUE-1" })];
    orchestrator.getState().issueFailureSignatures["1:implement"] = {
      signature: "different-prior-signature",
      class: "transient",
    };
    const redispatch = await orchestrator.onRetryTimer("1");
    expect(redispatch.dispatched).toBe(true);
    await orchestrator.onWorkerExit({
      issueId: "1",
      outcome: "abnormal",
      reason,
    });

    const breakerEntries = entriesOfKind("breaker_transition");
    expect(
      breakerEntries.map(
        (entry) => entry.metadata.transition as "opened" | "closed",
      ),
    ).toEqual(["opened", "closed", "opened"]);
    expect(
      new Set(breakerEntries.map((entry) => entry.idempotencyKey)).size,
    ).toBe(3);

    // Issue 1 produced two cluster_transition entries (initial growth +
    // post-resume re-entry) at the same timestamp; both must survive.
    const issueOneClusterEntries = entriesOfKind("cluster_transition").filter(
      (entry) => entry.issueId === "1",
    );
    expect(issueOneClusterEntries).toHaveLength(2);
    expect(
      new Set(issueOneClusterEntries.map((entry) => entry.idempotencyKey)).size,
    ).toBe(2);
  });

  it("exposes the dispositions map in the runtime snapshot", async () => {
    const orchestrator = createOrchestrator();
    orchestrator.isDispatchEligible(
      createIssue({
        id: "b1",
        identifier: "ISSUE-B1",
        blockedBy: [{ id: "x", identifier: "BLOCK-1", state: "In Progress" }],
      }),
    );

    const snapshot = buildRuntimeSnapshot(orchestrator.getState(), {
      now: NOW,
    });
    expect(snapshot.dispositions?.b1).toMatchObject({
      disposition: "skip",
      reason_code: "blocked_by_open",
      since: NOW.toISOString(),
    });
    expect(snapshot.dispositions?.b1?.remedy).toContain("terminal state");
  });

  it("surfaces the synthetic __dispatch__ scope as dispatch_gate, never as a dispositions entry", async () => {
    const orchestrator = createOrchestrator({
      config: createConfig({
        rateLimitAdmission: {
          minPrimaryHeadroomPct: null,
          minSecondaryHeadroomPct: 5,
        },
      }),
    });
    orchestrator.getState().codexRateLimits = {
      secondary: {
        used_percent: 98,
        window_minutes: 10_080,
        resets_at: 4_102_444_800,
      },
    };
    await orchestrator.pollTick();

    const snapshot = buildRuntimeSnapshot(orchestrator.getState(), {
      now: NOW,
    });
    expect(snapshot.dispositions?.[PIPELINE_VERDICT_SCOPE_ID]).toBeUndefined();
    expect(snapshot.dispatch_gate).toMatchObject({
      disposition: "gate",
      reason_code: "rate_window_secondary_floor",
    });

    // No pipeline-wide verdict yet → the gate field is null, not a fake row.
    const idle = createOrchestrator();
    expect(
      buildRuntimeSnapshot(idle.getState(), { now: NOW }).dispatch_gate,
    ).toBeNull();
  });

  it("qualifies a starvation page with the active rate gate when the secondary floor blocks admission", async () => {
    const pages: Array<{
      kind: string;
      consecutiveTicks: number;
      gate: DispatchGateInfo | undefined;
    }> = [];
    const config = createConfig({
      rateLimitAdmission: {
        minPrimaryHeadroomPct: null,
        minSecondaryHeadroomPct: 5,
      },
    });
    config.verdicts = { pageAfterTicks: 3 };
    const orchestrator = createOrchestrator({
      config,
      onDispatchPage: (input) => {
        pages.push({
          kind: input.kind,
          consecutiveTicks: input.consecutiveTicks,
          gate: input.gate,
        });
      },
    });
    orchestrator.getState().codexRateLimits = {
      secondary: {
        used_percent: 98,
        window_minutes: 10_080,
        resets_at: 4_102_444_800,
      },
    };

    await orchestrator.pollTick();
    await orchestrator.pollTick();
    expect(pages).toHaveLength(0);
    await orchestrator.pollTick();
    expect(pages).toEqual([
      {
        kind: "page",
        consecutiveTicks: 3,
        gate: {
          reasonCode: "rate_window_secondary_floor",
          remedy:
            "Wait for the secondary rate-limit window to reset: floor 5% headroom, observed 2.0%.",
        },
      },
    ]);

    // Latched: a fourth starved tick does not re-alert.
    await orchestrator.pollTick();
    expect(pages).toHaveLength(1);

    // The floor clears, dispatch resumes → exactly one recovery alert.
    orchestrator.getState().codexRateLimits = {
      secondary: {
        used_percent: 10,
        window_minutes: 10_080,
        resets_at: 4_102_444_800,
      },
    };
    const resumed = await orchestrator.pollTick();
    expect(resumed.dispatchedIssueIds).toEqual(["1"]);
    expect(pages).toHaveLength(2);
    expect(pages[1]?.kind).toBe("recovery");

    await orchestrator.pollTick();
    expect(pages).toHaveLength(2);
  });

  it("preserves generic starvation paging when no pipeline-wide gate is active", async () => {
    const pages: Array<{
      kind: string;
      consecutiveTicks: number;
      gate: DispatchGateInfo | undefined;
    }> = [];
    const config = createConfig();
    config.verdicts = { pageAfterTicks: 1 };
    const orchestrator = createOrchestrator({
      config,
      spawnWorker: async () => {
        throw new Error("spawn unavailable");
      },
      onDispatchPage: (input) => {
        pages.push({
          kind: input.kind,
          consecutiveTicks: input.consecutiveTicks,
          gate: input.gate,
        });
      },
    });

    await orchestrator.pollTick();

    expect(pages).toEqual([
      { kind: "page", consecutiveTicks: 1, gate: undefined },
    ]);
    expect(
      buildRuntimeSnapshot(orchestrator.getState(), { now: NOW }).dispatch_gate,
    ).toBeNull();
  });

  it("qualifies starvation pages for sibling pipeline-wide blockers", async () => {
    const createPageConfig = (): ResolvedWorkflowConfig => {
      const config = createConfig();
      config.verdicts = { pageAfterTicks: 1 };
      return config;
    };
    const expectPageGate = async (
      setup: (
        onDispatchPage: NonNullable<OrchestratorCoreOptions["onDispatchPage"]>,
      ) => OrchestratorCore | Promise<OrchestratorCore>,
      expected: DispatchGateInfo,
    ): Promise<void> => {
      const pages: Array<{ kind: string; gate: DispatchGateInfo | undefined }> =
        [];
      const orchestrator = await setup((input) => {
        pages.push({ kind: input.kind, gate: input.gate });
      });
      await orchestrator.pollTick();
      expect(pages).toEqual([{ kind: "page", gate: expected }]);
    };

    const haltIssue = createIssue({
      id: "halt-1",
      identifier: "OPS-HALT",
      title: "Pause dispatch",
      state: "Todo",
    });
    const haltTracker = createTracker({
      candidates: [createIssue({ id: "1", identifier: "ISSUE-1" })],
    });
    haltTracker.fetchIssuesByLabels = async () => [haltIssue];
    await expectPageGate(
      (onDispatchPage) =>
        createOrchestrator({
          config: createPageConfig(),
          tracker: haltTracker,
          onDispatchPage,
        }),
      {
        reasonCode: "pipeline_halt",
        remedy:
          "Move the pipeline-halt issue OPS-HALT to a terminal state to resume dispatch.",
      },
    );

    await expectPageGate(
      async (onDispatchPage) => {
        const orchestrator = createOrchestrator({
          config: createPageConfig(),
          onDispatchPage,
        });
        await orchestrator.setDispatchFence({
          issueIdentifiers: ["SYMPH-999"],
          source: "api",
          actor: { kind: "operator", host: "pro14", session: "api" },
          reason: {
            class: "operator_dispatch_fence",
            human: "single-issue canary",
          },
        });
        return orchestrator;
      },
      {
        reasonCode: "dispatch_fence_no_eligible_candidates",
        remedy:
          "Clear or update the dispatch fence, or make an allowlisted issue eligible.",
      },
    );

    await expectPageGate(
      (onDispatchPage) => {
        const orchestrator = createOrchestrator({
          config: createPageConfig(),
          onDispatchPage,
        });
        orchestrator.getState().emergencyStop = {
          active: true,
          since: NOW.toISOString(),
          reason: "operator stop",
          actor: { kind: "operator", host: "pro14", session: "api" },
          setBySequence: 1,
          interruptedIssues: [],
        };
        return orchestrator;
      },
      {
        reasonCode: "emergency_stop",
        remedy:
          "Run pipeline resume after triaging killed-mid-run tickets and clearing the halt issue.",
      },
    );

    await expectPageGate(
      (onDispatchPage) => {
        const orchestrator = createOrchestrator({
          config: createPageConfig(),
          onDispatchPage,
        });
        orchestrator.getState().pipelinePause = {
          active: true,
          since: NOW.toISOString(),
          reason: "operator pause",
          actor: { kind: "operator", host: "pro14", session: "api" },
          setBySequence: 2,
          haltView: {
            status: "uncertain",
            issueIdentifier: null,
            issueTitle: null,
            errorMessage: null,
          },
        };
        return orchestrator;
      },
      {
        reasonCode: "runtime_pipeline_pause",
        remedy:
          "Run pipeline resume after verifying the halt view and clearing the pause.",
      },
    );
  });

  it("rehydrates the page latch from journaled page events: a restart mid-starvation neither double-pages nor drops the recovery alert", async () => {
    const blockedRates = {
      secondary: {
        used_percent: 98,
        window_minutes: 10_080,
        resets_at: 4_102_444_800,
      },
    };
    const clearRates = {
      secondary: {
        used_percent: 10,
        window_minutes: 10_080,
        resets_at: 4_102_444_800,
      },
    };
    const gatedConfig = () => {
      const config = createConfig({
        rateLimitAdmission: {
          minPrimaryHeadroomPct: null,
          minSecondaryHeadroomPct: 5,
        },
      });
      config.verdicts = { pageAfterTicks: 2 };
      return config;
    };

    // First process: starve past the threshold so the page fires and the
    // page event lands in the journal.
    const firstPages: string[] = [];
    const first = createOrchestrator({
      config: gatedConfig(),
      onDispatchPage: (input) => firstPages.push(input.kind),
    });
    first.getState().codexRateLimits = blockedRates;
    await first.pollTick();
    await first.pollTick();
    expect(firstPages).toEqual(["page"]);

    // Simulated restart mid-starvation: the latch must rehydrate, so more
    // starved ticks do NOT re-page, and the recovery alert still fires.
    const restartedPages: string[] = [];
    const restarted = createOrchestrator({
      config: gatedConfig(),
      runJournal: first.getState().dispatcherRunJournal,
      onDispatchPage: (input) => restartedPages.push(input.kind),
    });
    restarted.getState().codexRateLimits = blockedRates;
    await restarted.pollTick();
    await restarted.pollTick();
    await restarted.pollTick();
    expect(restartedPages).toEqual([]);

    restarted.getState().codexRateLimits = clearRates;
    const resumed = await restarted.pollTick();
    expect(resumed.dispatchedIssueIds).toEqual(["1"]);
    expect(restartedPages).toEqual(["recovery"]);

    // The recovery event is journaled too: a restart after recovery starts
    // unlatched and needs the full threshold before paging again.
    const thirdPages: string[] = [];
    const third = createOrchestrator({
      config: gatedConfig(),
      runJournal: restarted.getState().dispatcherRunJournal,
      onDispatchPage: (input) => thirdPages.push(input.kind),
    });
    third.getState().codexRateLimits = blockedRates;
    await third.pollTick();
    expect(thirdPages).toEqual([]);
    await third.pollTick();
    expect(thirdPages).toEqual(["page"]);
  });

  it("flushes journal entries to disk in sequence order even when a fire-and-forget verdict write is slow", async () => {
    const written: number[] = [];
    const writeRunJournalEntry = async (entry: DispatcherRunJournalEntry) => {
      // Stall the fire-and-forget verdict write so any unordered awaited
      // write would overtake it on disk.
      if (entry.kind === "dispatch_verdict" && entry.issueId === "b1") {
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
      written.push(entry.sequence);
    };
    const orchestrator = createOrchestrator({
      tracker: createTracker({
        candidates: [
          createIssue({
            id: "b1",
            identifier: "ISSUE-B1",
            blockedBy: [
              { id: "x", identifier: "BLOCK-1", state: "In Progress" },
            ],
          }),
          createIssue({ id: "1", identifier: "ISSUE-1" }),
        ],
      }),
      writeRunJournalEntry,
    });

    const result = await orchestrator.pollTick();
    expect(result.dispatchedIssueIds).toEqual(["1"]);

    const journal = orchestrator.getState().dispatcherRunJournal;
    expect(journal.length).toBeGreaterThan(2);
    await vi.waitFor(() => {
      expect(written).toHaveLength(journal.length);
    });
    expect(written).toEqual(journal.map((entry) => entry.sequence));
  });

  it("journals repeated flip-backs to the same verdict within one tick under distinct idempotency keys", () => {
    const orchestrator = createOrchestrator();
    const blocked = createIssue({
      id: "f1",
      identifier: "ISSUE-F1",
      blockedBy: [{ id: "x", identifier: "BLOCK-1", state: "In Progress" }],
    });
    const plain = createIssue({ id: "f1", identifier: "ISSUE-F1" });

    // A→B→A→B→A with a frozen clock: every re-emission shares the same
    // millisecond timestamp, so a timestamp-suffixed key would collide and
    // the journal's exact-key idempotency would silently drop entries.
    orchestrator.isDispatchEligible(blocked);
    orchestrator.getState().claimed.add("f1");
    orchestrator.isDispatchEligible(plain);
    orchestrator.getState().claimed.delete("f1");
    orchestrator.isDispatchEligible(blocked);
    orchestrator.getState().claimed.add("f1");
    orchestrator.isDispatchEligible(plain);
    orchestrator.getState().claimed.delete("f1");
    orchestrator.isDispatchEligible(blocked);

    const entries = verdictEntries(orchestrator).filter(
      (entry) => entry.issueId === "f1",
    );
    expect(entries.map((entry) => entry.metadata.reason_code)).toEqual([
      "blocked_by_open",
      "claimed",
      "blocked_by_open",
      "claimed",
      "blocked_by_open",
    ]);
    expect(new Set(entries.map((entry) => entry.idempotencyKey)).size).toBe(5);
  });

  it("formats the new notifier events with attribution", () => {
    const paused = formatNotification({
      type: "issue_paused",
      issueIdentifier: "ISSUE-1",
      issueTitle: "Pause notifications",
      issueUrl: "https://linear.app/test/issue/ISSUE-1",
      stageName: "implementation",
      reason: "token budget - Token budget exceeded.",
      operatorAction: "Move the issue to Resume after review.",
    });
    expect(paused.text).toContain("Issue paused");
    expect(paused.text).toContain("Resume required");
    expect(paused.text).toContain("https://linear.app/test/issue/ISSUE-1");
    expect(paused.text).toContain("Stage: implementation");
    expect(paused.text).toContain("token budget - Token budget exceeded.");
    expect(paused.text).toContain("Move the issue to Resume after review.");

    const verdict = formatNotification({
      type: "dispatch_verdict_alert",
      issueIdentifier: "ISSUE-1",
      disposition: "halt",
      reasonCode: "pipeline_halt",
      remedy: "Close the halt issue.",
      actor: { kind: "dispatcher", host: "pro14" },
    });
    expect(verdict.text).toContain("Dispatch HALTED");
    expect(verdict.text).toContain("by dispatcher@pro14");
    expect(verdict.text).toContain("Remedy: Close the halt issue.");

    const page = formatNotification({
      type: "dispatch_page_alert",
      kind: "page",
      eligibleCount: 2,
      consecutiveTicks: 10,
    });
    expect(page.text).toContain("Dispatch starvation");
    expect(page.text).toContain("10 consecutive ticks");
    expect(page.text).toContain("Check the dispositions map");

    const gatedPage = formatNotification({
      type: "dispatch_page_alert",
      kind: "page",
      eligibleCount: 1,
      consecutiveTicks: 10,
      gate: {
        reasonCode: "rate_window_secondary_floor",
        remedy:
          "Wait for the secondary rate-limit window to reset: floor 5% headroom, observed 4.0%.",
      },
    });
    expect(gatedPage.text).toContain("Dispatch admission gated");
    expect(gatedPage.text).toContain("rate_window_secondary_floor");
    expect(gatedPage.text).toContain("observed 4.0%");
    expect(gatedPage.text).not.toContain("Check the dispositions map");
  });
});

// ---------------------------------------------------------------------------
// Helpers (mirroring tests/orchestrator/core.test.ts fixtures)
// ---------------------------------------------------------------------------

function verdictEntries(
  orchestrator: OrchestratorCore,
): DispatcherRunJournalEntry[] {
  return orchestrator
    .getState()
    .dispatcherRunJournal.filter((entry) => entry.kind === "dispatch_verdict");
}

function lastVerdict(
  orchestrator: OrchestratorCore,
): DispatcherRunJournalEntry | undefined {
  return verdictEntries(orchestrator).at(-1);
}

function createOrchestrator(overrides?: {
  config?: ResolvedWorkflowConfig;
  tracker?: IssueTracker;
  runJournal?: DispatcherRunJournal;
  onSystemicCluster?: OrchestratorCoreOptions["onSystemicCluster"];
  onVerdictTransition?: OrchestratorCoreOptions["onVerdictTransition"];
  onDispatchPage?: OrchestratorCoreOptions["onDispatchPage"];
  writeRunJournalEntry?: OrchestratorCoreOptions["writeRunJournalEntry"];
  spawnWorker?: OrchestratorCoreOptions["spawnWorker"];
}): OrchestratorCore {
  const tracker =
    overrides?.tracker ??
    createTracker({
      candidates: [createIssue({ id: "1", identifier: "ISSUE-1" })],
    });
  const options: OrchestratorCoreOptions = {
    config: overrides?.config ?? createConfig(),
    tracker,
    spawnWorker:
      overrides?.spawnWorker ??
      (async () => ({
        workerHandle: { pid: 1001 },
        monitorHandle: { ref: "monitor-1" },
      })),
    now: () => NOW,
  };
  if (overrides?.runJournal !== undefined) {
    options.runJournal = overrides.runJournal;
  }
  if (overrides?.onSystemicCluster !== undefined) {
    options.onSystemicCluster = overrides.onSystemicCluster;
  }
  if (overrides?.onVerdictTransition !== undefined) {
    options.onVerdictTransition = overrides.onVerdictTransition;
  }
  if (overrides?.onDispatchPage !== undefined) {
    options.onDispatchPage = overrides.onDispatchPage;
  }
  if (overrides?.writeRunJournalEntry !== undefined) {
    options.writeRunJournalEntry = overrides.writeRunJournalEntry;
  }
  return new OrchestratorCore(options);
}

function createTracker(input?: {
  candidates?: Issue[];
  candidatesFn?: () => Issue[];
}): IssueTracker {
  return {
    async fetchCandidateIssues() {
      return (
        input?.candidatesFn?.() ??
        input?.candidates ?? [createIssue({ id: "1", identifier: "ISSUE-1" })]
      );
    },
    async fetchIssuesByStates() {
      return [];
    },
    async fetchIssueStatesByIds() {
      return [];
    },
  };
}

function createConfig(overrides?: {
  agent?: Partial<ResolvedWorkflowConfig["agent"]>;
  rateLimitAdmission?: ResolvedWorkflowConfig["rateLimitAdmission"];
}): ResolvedWorkflowConfig {
  return {
    workflowPath: "/tmp/WORKFLOW.md",
    promptTemplate: "Prompt",
    tracker: {
      kind: "linear",
      endpoint: "https://api.linear.app/graphql",
      apiKey: "token",
      projectSlug: "project",
      activeStates: ["Todo", "In Progress", "In Review"],
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
      ...overrides?.agent,
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
    rateLimitAdmission: overrides?.rateLimitAdmission ?? {
      minPrimaryHeadroomPct: null,
      minSecondaryHeadroomPct: null,
    },
    budgetEscalation: { maxSteps: null, multiplier: 2 },
    pauseTriage: { baseUrl: null, model: null, apiKey: null, maxResumes: 2 },
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
    stages: null,
    escalationState: null,
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
    createdAt: overrides?.createdAt ?? "2026-03-01T00:00:00.000Z",
    updatedAt: overrides?.updatedAt ?? "2026-03-01T00:00:00.000Z",
  };
}
