import { describe, expect, it } from "vitest";

import type {
  ResolvedWorkflowConfig,
  StagesConfig,
} from "../../src/config/types.js";
import type {
  DispatcherRunJournalEntry,
  Issue,
} from "../../src/domain/model.js";
import {
  OrchestratorCore,
  type OrchestratorCoreOptions,
} from "../../src/orchestrator/core.js";
import type { IssueTracker } from "../../src/tracker/tracker.js";

describe("dispatcher decision event emission", () => {
  it("emits measurable admission, right-sizing, and model-routing events on dispatch", async () => {
    const orchestrator = createOrchestrator({
      tracker: createTracker({
        candidates: [
          createIssue({
            id: "1",
            identifier: "ISSUE-1",
            priority: 3,
            labels: ["trivial"],
            description: "## Declared file scope\n- src/features/copy.ts\n",
          }),
        ],
      }),
    });

    await orchestrator.pollTick();

    const decisionEntries = orchestrator
      .getState()
      .dispatcherRunJournal.filter(
        (entry) => entry.kind === "dispatcher_decision",
      );

    expect(decisionEntries).toHaveLength(3);
    expect(
      decisionEntries.map((entry) => entry.metadata.decisionEvent),
    ).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          category: "admission",
          expectedOutcome: expect.objectContaining({
            decision: "admit",
          }),
          observedOutcome: expect.objectContaining({
            decision: "admit",
          }),
        }),
        expect.objectContaining({
          category: "right_sizing",
          expectedOutcome: expect.objectContaining({
            decision: "prototype",
          }),
          observedOutcome: null,
        }),
        expect.objectContaining({
          category: "model_routing",
          expectedOutcome: expect.objectContaining({
            decision: "stay_deterministic",
          }),
          observedOutcome: null,
        }),
      ]),
    );
  });

  it("journals queue-baseline control-arm fields after a dispatch poll", async () => {
    const orchestrator = createOrchestrator({
      tracker: createTracker({
        candidates: [
          createIssue({
            id: "1",
            identifier: "ISSUE-1",
            priority: 2,
          }),
          createIssue({
            id: "2",
            identifier: "ISSUE-2",
            priority: 1,
          }),
        ],
      }),
    });

    await orchestrator.pollTick();

    const baseline = orchestrator
      .getState()
      .dispatcherRunJournal.find((entry) => entry.kind === "queue_baseline");

    expect(baseline).toMatchObject({
      kind: "queue_baseline",
      issueId: "__dispatch__",
      metadata: expect.objectContaining({
        comparator_version: "dispatch-comparator-v1",
        computed_order_status: "linearized",
        outcome_since_sequence: 0,
        outcome_window_semantics: expect.stringContaining(
          "urgent_reopen_outcomes may reference the earlier failure",
        ),
        considered_issue_ids: ["2", "1"],
        dispatch_picks: ["2", "1"],
        manual_jumps_reorders: [],
        quiet_death_outcomes: [],
        urgent_reopen_outcomes: [],
        delivery_outcomes: [],
      }),
    });
  });

  it("does not journal queue-baseline samples for empty idle polls", async () => {
    const orchestrator = createOrchestrator({
      tracker: createTracker({ candidates: [] }),
    });

    await orchestrator.pollTick();
    await orchestrator.pollTick();

    expect(
      orchestrator
        .getState()
        .dispatcherRunJournal.filter(
          (entry) => entry.kind === "queue_baseline",
        ),
    ).toEqual([]);
  });

  it("journals outcome-only queue-baseline samples when the queue is empty", async () => {
    const orchestrator = createOrchestrator({
      runJournal: [
        journalEntry({
          sequence: 1,
          kind: "failure_exhausted",
          issueId: "dead",
          issueIdentifier: "ISSUE-DEAD",
          summary: "Retries exhausted.",
          metadata: {
            status: "completed",
            reason: "max_retries",
            failure_signature: "sig-dead",
          },
        }),
      ],
      tracker: createTracker({ candidates: [] }),
    });

    await orchestrator.pollTick();

    const baseline = orchestrator
      .getState()
      .dispatcherRunJournal.findLast(
        (entry) => entry.kind === "queue_baseline",
      );

    expect(baseline?.metadata).toMatchObject({
      considered_issue_ids: [],
      dispatch_picks: [],
      quiet_death_outcomes: [
        expect.objectContaining({
          issue_id: "dead",
          failure_signature: "sig-dead",
        }),
      ],
    });
  });

  it("journals non-empty queue-baseline outcome samples from prior journal entries", async () => {
    const orchestrator = createOrchestrator({
      runJournal: [
        journalEntry({
          sequence: 1,
          kind: "failure_exhausted",
          issueId: "dead",
          issueIdentifier: "ISSUE-DEAD",
          summary: "Retries exhausted.",
          metadata: {
            status: "completed",
            reason: "max_retries",
            failure_signature: "sig-dead",
            failure_class: "infra",
          },
        }),
        journalEntry({
          sequence: 2,
          kind: "intent",
          issueId: "dead",
          issueIdentifier: "ISSUE-DEAD",
          summary: "Operator released issue.",
          metadata: {
            status: "applied",
            verb: "release",
            actor: { kind: "operator", host: "desk" },
            reason: { class: "operator_release", human: "urgent reopen" },
          },
        }),
        journalEntry({
          sequence: 3,
          kind: "stage_record",
          issueId: "delivered",
          issueIdentifier: "ISSUE-DONE",
          stage: "implement",
          summary: "Stage completed.",
          metadata: {
            stageName: "implement",
            durationMs: 1200,
            totalTokens: 1234,
            inputTokens: 1000,
            outputTokens: 234,
            turns: 3,
            outcome: "succeeded",
            status: "completed",
          },
        }),
        journalEntry({
          sequence: 4,
          kind: "tracker_write",
          issueId: "delivered",
          issueIdentifier: "ISSUE-DONE",
          stage: "merge",
          idempotencyKey: "tracker:delivered:terminal:completed",
          summary: "Marked issue complete.",
          metadata: { status: "completed" },
        }),
      ],
      tracker: createTracker({
        candidates: [createIssue({ id: "next", identifier: "ISSUE-NEXT" })],
      }),
    });

    await orchestrator.pollTick();

    const baseline = orchestrator
      .getState()
      .dispatcherRunJournal.findLast(
        (entry) => entry.kind === "queue_baseline",
      );

    expect(baseline?.metadata).toMatchObject({
      manual_jumps_reorders: [
        expect.objectContaining({
          sequence: 2,
          issue_id: "dead",
          issue_identifier: "ISSUE-DEAD",
          verb: "release",
        }),
      ],
      quiet_death_outcomes: [
        expect.objectContaining({
          sequence: 1,
          issue_id: "dead",
          issue_identifier: "ISSUE-DEAD",
          failure_signature: "sig-dead",
        }),
      ],
      urgent_reopen_outcomes: [
        expect.objectContaining({
          issue_id: "dead",
          reopened_after_sequence: 1,
        }),
      ],
      delivery_outcomes: [
        expect.objectContaining({
          issue_id: "delivered",
          issue_identifier: "ISSUE-DONE",
          spend: {
            scope: "baseline_window",
            since_sequence: 0,
            total_tokens: 1234,
            turns: 3,
            stages: 1,
          },
        }),
      ],
    });
  });

  it("journals only queue-baseline outcomes observed since the previous baseline", async () => {
    const orchestrator = createOrchestrator({
      runJournal: [
        journalEntry({
          sequence: 1,
          kind: "failure_exhausted",
          issueId: "old-dead",
          issueIdentifier: "ISSUE-OLD",
          summary: "Old retries exhausted.",
          metadata: {
            status: "completed",
            reason: "max_retries",
            failure_signature: "sig-old",
          },
        }),
        journalEntry({
          sequence: 2,
          kind: "queue_baseline",
          issueId: "__dispatch__",
          issueIdentifier: "__dispatch__",
          summary: "Prior baseline.",
          metadata: {
            schema_version: 1,
            comparator_version: "priority-fifo-control-v0",
          },
        }),
        journalEntry({
          sequence: 3,
          kind: "failure_exhausted",
          issueId: "new-dead",
          issueIdentifier: "ISSUE-NEW",
          summary: "New retries exhausted.",
          metadata: {
            status: "completed",
            reason: "max_retries",
            failure_signature: "sig-new",
          },
        }),
        journalEntry({
          sequence: 4,
          kind: "intent",
          issueId: "old-dead",
          issueIdentifier: "ISSUE-OLD",
          summary: "Operator released old issue after the prior baseline.",
          metadata: {
            status: "applied",
            verb: "release",
            actor: { kind: "operator", host: "desk" },
          },
        }),
      ],
      tracker: createTracker({
        candidates: [createIssue({ id: "next", identifier: "ISSUE-NEXT" })],
      }),
    });

    await orchestrator.pollTick();

    const baseline = orchestrator
      .getState()
      .dispatcherRunJournal.findLast(
        (entry) => entry.kind === "queue_baseline",
      );

    expect(baseline?.metadata).toMatchObject({
      outcome_since_sequence: 2,
      manual_jumps_reorders: [
        expect.objectContaining({
          sequence: 4,
          issue_id: "old-dead",
        }),
      ],
      quiet_death_outcomes: [
        expect.objectContaining({
          sequence: 3,
          issue_id: "new-dead",
          failure_signature: "sig-new",
        }),
      ],
      urgent_reopen_outcomes: [
        expect.objectContaining({
          sequence: 4,
          issue_id: "old-dead",
          reopened_after_sequence: 1,
        }),
      ],
    });
    expect(baseline?.metadata).not.toMatchObject({
      quiet_death_outcomes: [
        expect.objectContaining({
          issue_id: "old-dead",
        }),
      ],
    });
  });

  it("keeps delivery spend windowed to stage records after the previous baseline", async () => {
    const orchestrator = createOrchestrator({
      runJournal: [
        journalEntry({
          sequence: 1,
          kind: "stage_record",
          issueId: "redelivered",
          issueIdentifier: "ISSUE-REDO",
          stage: "implement",
          metadata: {
            status: "completed",
            stageName: "implement",
            durationMs: 100,
            totalTokens: 10_000,
            inputTokens: 9_000,
            outputTokens: 1_000,
            turns: 9,
            outcome: "succeeded",
          },
        }),
        journalEntry({
          sequence: 2,
          kind: "tracker_write",
          issueId: "redelivered",
          issueIdentifier: "ISSUE-REDO",
          stage: "merge",
          idempotencyKey: "tracker:redelivered:terminal:completed",
          metadata: { status: "completed" },
        }),
        journalEntry({
          sequence: 3,
          kind: "queue_baseline",
          issueId: "__dispatch__",
          issueIdentifier: "__dispatch__",
          summary: "Prior baseline.",
          metadata: {
            schema_version: 1,
            comparator_version: "priority-fifo-control-v0",
          },
        }),
        journalEntry({
          sequence: 4,
          kind: "stage_record",
          issueId: "redelivered",
          issueIdentifier: "ISSUE-REDO",
          stage: "implement",
          metadata: {
            status: "completed",
            stageName: "implement",
            durationMs: 200,
            totalTokens: 250,
            inputTokens: 200,
            outputTokens: 50,
            turns: 2,
            outcome: "succeeded",
          },
        }),
        journalEntry({
          sequence: 5,
          kind: "tracker_write",
          issueId: "redelivered",
          issueIdentifier: "ISSUE-REDO",
          stage: "merge",
          idempotencyKey: "tracker:redelivered:terminal:completed",
          metadata: { status: "completed" },
        }),
      ],
      tracker: createTracker({
        candidates: [createIssue({ id: "next", identifier: "ISSUE-NEXT" })],
      }),
    });

    await orchestrator.pollTick();

    const baseline = orchestrator
      .getState()
      .dispatcherRunJournal.findLast(
        (entry) => entry.kind === "queue_baseline",
      );

    expect(baseline?.metadata).toMatchObject({
      outcome_since_sequence: 3,
      delivery_outcomes: [
        expect.objectContaining({
          sequence: 5,
          issue_id: "redelivered",
          spend: {
            scope: "baseline_window",
            since_sequence: 3,
            total_tokens: 250,
            turns: 2,
            stages: 1,
          },
        }),
      ],
    });
  });

  it("partitions delivery spend between repeated terminal writes in one baseline window", async () => {
    const orchestrator = createOrchestrator({
      runJournal: [
        journalEntry({
          sequence: 1,
          kind: "stage_record",
          issueId: "redelivered",
          issueIdentifier: "ISSUE-REDO",
          stage: "implement",
          metadata: {
            status: "completed",
            stageName: "implement",
            durationMs: 100,
            totalTokens: 100,
            turns: 1,
            outcome: "succeeded",
          },
        }),
        journalEntry({
          sequence: 2,
          kind: "tracker_write",
          issueId: "redelivered",
          issueIdentifier: "ISSUE-REDO",
          stage: "merge",
          idempotencyKey: "tracker:redelivered:terminal:completed",
          metadata: { status: "completed" },
        }),
        journalEntry({
          sequence: 3,
          kind: "stage_record",
          issueId: "redelivered",
          issueIdentifier: "ISSUE-REDO",
          stage: "implement",
          metadata: {
            status: "completed",
            stageName: "implement",
            durationMs: 200,
            totalTokens: 250,
            turns: 2,
            outcome: "succeeded",
          },
        }),
        journalEntry({
          sequence: 4,
          kind: "tracker_write",
          issueId: "redelivered",
          issueIdentifier: "ISSUE-REDO",
          stage: "merge",
          idempotencyKey: "tracker:redelivered:terminal:completed",
          metadata: { status: "completed" },
        }),
      ],
      tracker: createTracker({
        candidates: [createIssue({ id: "next", identifier: "ISSUE-NEXT" })],
      }),
    });

    await orchestrator.pollTick();

    const baseline = orchestrator
      .getState()
      .dispatcherRunJournal.findLast(
        (entry) => entry.kind === "queue_baseline",
      );

    expect(baseline?.metadata).toMatchObject({
      delivery_outcomes: [
        expect.objectContaining({
          sequence: 2,
          spend: expect.objectContaining({
            total_tokens: 100,
            turns: 1,
            stages: 1,
          }),
        }),
        expect.objectContaining({
          sequence: 4,
          spend: expect.objectContaining({
            total_tokens: 250,
            turns: 2,
            stages: 1,
          }),
        }),
      ],
    });
  });

  it("journals a queue-baseline sample when pipeline-halt blocks dispatch", async () => {
    const haltIssue = createIssue({
      id: "halt",
      identifier: "ISSUE-HALT",
      title: "Pipeline halted",
      labels: ["pipeline-halt"],
    });
    const tracker: IssueTracker = {
      ...createTracker({
        candidates: [
          createIssue({ id: "1", identifier: "ISSUE-1", priority: 2 }),
          createIssue({ id: "2", identifier: "ISSUE-2", priority: 1 }),
        ],
      }),
      async fetchOpenIssuesByLabels() {
        return [haltIssue];
      },
    };
    const orchestrator = createOrchestrator({ tracker });

    const result = await orchestrator.pollTick();

    expect(result.dispatchedIssueIds).toEqual([]);
    const baseline = orchestrator
      .getState()
      .dispatcherRunJournal.findLast(
        (entry) => entry.kind === "queue_baseline",
      );
    expect(baseline?.metadata).toMatchObject({
      considered_issue_ids: ["2", "1"],
      dispatch_picks: [],
    });
  });

  it("journals a queue-baseline sample when the rate-limit admission gate blocks dispatch", async () => {
    const orchestrator = createOrchestrator({
      config: createConfig({
        rateLimitAdmission: {
          minPrimaryHeadroomPct: 10,
          minSecondaryHeadroomPct: 5,
        },
      }),
      tracker: createTracker({
        candidates: [createIssue({ id: "1", identifier: "ISSUE-1" })],
      }),
    });
    orchestrator.getState().codexRateLimits = {
      limit_id: "codex",
      primary: {
        used_percent: 40,
        window_minutes: 300,
        resets_at: 1772760000,
      },
      secondary: {
        used_percent: 98,
        window_minutes: 10080,
        resets_at: 1772800000,
      },
    };

    const result = await orchestrator.pollTick();

    expect(result.dispatchedIssueIds).toEqual([]);
    const baseline = orchestrator
      .getState()
      .dispatcherRunJournal.findLast(
        (entry) => entry.kind === "queue_baseline",
      );
    expect(baseline?.metadata).toMatchObject({
      considered_issue_ids: ["1"],
      dispatch_picks: [],
    });
  });

  it("emits measurable pause and re-steer events when deterministic supervision blocks a co-run", async () => {
    const orchestrator = createOrchestrator({
      tracker: createTracker({
        candidates: [
          createIssue({
            id: "1",
            identifier: "ISSUE-1",
            description: "## Declared file scope\n- src/shared/config.ts\n",
          }),
          createIssue({
            id: "2",
            identifier: "ISSUE-2",
            priority: 2,
            description:
              "## Declared file scope\n- src/shared/config.ts\n- src/features/two.ts\n",
          }),
        ],
      }),
      requestSupervisionResteer: async () => undefined,
    });

    await orchestrator.pollTick();

    const decisionEvents = orchestrator
      .getState()
      .dispatcherRunJournal.filter(
        (entry) => entry.kind === "dispatcher_decision",
      )
      .map((entry) => entry.metadata.decisionEvent);

    expect(decisionEvents).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          category: "admission",
          issueIdentifier: "ISSUE-2",
          expectedOutcome: expect.objectContaining({
            decision: "pause",
          }),
          observedOutcome: expect.objectContaining({
            decision: "pause",
          }),
        }),
        expect.objectContaining({
          category: "re_steer",
          expectedOutcome: expect.objectContaining({
            decision: "request_re_steer",
          }),
          observedOutcome: expect.objectContaining({
            decision: "request_re_steer",
          }),
        }),
      ]),
    );
  });
});

function createOrchestrator(overrides?: {
  config?: ResolvedWorkflowConfig;
  tracker?: IssueTracker;
  requestSupervisionResteer?: OrchestratorCoreOptions["requestSupervisionResteer"];
  stages?: StagesConfig | null;
  runJournal?: DispatcherRunJournalEntry[];
}): OrchestratorCore {
  const stages = overrides?.stages !== undefined ? overrides.stages : null;
  const options: OrchestratorCoreOptions = {
    config: overrides?.config ?? createConfig({ stages }),
    tracker: overrides?.tracker ?? createTracker(),
    spawnWorker: async () => ({
      workerHandle: { pid: 1001 },
      monitorHandle: { ref: "monitor-1" },
    }),
    now: () => new Date("2026-03-06T00:00:05.000Z"),
  };
  if (overrides?.runJournal !== undefined) {
    options.runJournal = overrides.runJournal;
  }
  if (overrides?.requestSupervisionResteer !== undefined) {
    options.requestSupervisionResteer = overrides.requestSupervisionResteer;
  }
  return new OrchestratorCore(options);
}

function journalEntry(
  overrides: Partial<DispatcherRunJournalEntry> & {
    sequence: number;
    kind: DispatcherRunJournalEntry["kind"];
    issueId: string;
    issueIdentifier: string;
  },
): DispatcherRunJournalEntry {
  return {
    sequence: overrides.sequence,
    idempotencyKey:
      overrides.idempotencyKey ??
      `test:${overrides.kind}:${overrides.sequence}`,
    timestamp: overrides.timestamp ?? "2026-03-05T00:00:00.000Z",
    kind: overrides.kind,
    issueId: overrides.issueId,
    issueIdentifier: overrides.issueIdentifier,
    operation: overrides.operation ?? "dispatcher",
    stage: overrides.stage ?? null,
    attempt: overrides.attempt ?? null,
    ownerId: overrides.ownerId ?? "test-owner",
    lease: overrides.lease ?? null,
    summary: overrides.summary ?? "Synthetic journal entry.",
    metadata: overrides.metadata ?? {},
  };
}

function createTracker(input?: { candidates?: Issue[] }): IssueTracker {
  return {
    async fetchCandidateIssues() {
      return (
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
  stages?: StagesConfig | null;
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
      activeStates: ["Todo", "In Progress", "In Review", "Resume"],
      terminalStates: ["Done", "Canceled"],
    },
    polling: {
      intervalMs: 30_000,
    },
    workspace: {
      root: "/tmp/workspaces",
    },
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
    pauseTriage: {
      baseUrl: null,
      model: null,
      apiKey: null,
      maxResumes: 2,
    },
    acGate: {
      enabled: false,
    },
    specFidelity: {
      enabled: false,
    },
    admissionCard: {
      enabled: false,
    },
    watchdog: {
      systemicThreshold: 2,
      circuitBreaker: true,
      maxFilingsPerHour: 3,
    },
    budgetEscalation: {
      maxSteps: null,
      multiplier: 2,
    },
    rateLimitAdmission: {
      minPrimaryHeadroomPct:
        overrides?.rateLimitAdmission?.minPrimaryHeadroomPct ?? null,
      minSecondaryHeadroomPct:
        overrides?.rateLimitAdmission?.minSecondaryHeadroomPct ?? null,
    },
    server: {
      port: null,
      host: null,
      slackNotifyChannel: null,
    },
    notifications: {
      slackEnabled: true,
    },
    observability: {
      dashboardEnabled: true,
      refreshMs: 1_000,
      renderIntervalMs: 16,
    },
    runner: {
      kind: "codex",
      model: null,
    },
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
    createdAt: overrides?.createdAt ?? "2026-03-01T00:00:00.000Z",
    updatedAt: overrides?.updatedAt ?? "2026-03-01T00:00:00.000Z",
  };
}
