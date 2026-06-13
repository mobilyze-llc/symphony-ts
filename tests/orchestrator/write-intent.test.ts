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
import type {
  DispatcherRunJournalEntry,
  Issue,
} from "../../src/domain/model.js";
import { buildRuntimeSnapshot } from "../../src/logging/runtime-snapshot.js";
import {
  OrchestratorCore,
  type OrchestratorCoreOptions,
  sortIssuesForDispatch,
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

describe("anchor intent family (SYMPH-486)", () => {
  it("anchor journals attribution, idempotency, provenance, and visible read-model state", async () => {
    const orchestrator = createOrchestrator();

    const first = await orchestrator.writeIntent({
      verb: "anchor",
      issueId: "1",
      issueIdentifier: "ISSUE-1",
      actor: OPERATOR,
      reason: { class: "operator_anchor", human: "keep first" },
      anchor: {
        placement: { kind: "above", issueIdentifier: "ISSUE-0" },
        expiry: { kind: "until_merged" },
        source: "symphonyctl",
      },
    });
    expect(first.status).toBe("applied");

    const second = await orchestrator.writeIntent({
      verb: "anchor",
      issueId: "1",
      issueIdentifier: "ISSUE-1",
      actor: OPERATOR,
      reason: { class: "operator_anchor", human: "keep first" },
      anchor: {
        placement: { kind: "above", issueIdentifier: "ISSUE-0" },
        expiry: { kind: "until_merged" },
        source: "symphonyctl",
      },
    });
    expect(second.status).toBe("no_op");

    const anchor = orchestrator.getState().issueAnchors["1"];
    expect(anchor).toMatchObject({
      issueIdentifier: "ISSUE-1",
      placement: { kind: "above", issueIdentifier: "ISSUE-0" },
      expiry: { kind: "until_merged" },
      source: "symphonyctl",
      setBySequence: first.sequence,
    });

    const entries = intentEntries(orchestrator).filter(
      (entry) => entry.metadata.verb === "anchor",
    );
    expect(entries.map((entry) => entry.metadata.status)).toEqual([
      "applied",
      "no_op",
    ]);
    expect(entries[0]?.metadata.actor).toEqual({
      kind: "operator",
      host: "pro14",
      session: null,
    });
    expect(entries[0]?.metadata.anchor).toMatchObject({
      placement: { kind: "above", issueIdentifier: "ISSUE-0" },
      expiry: { kind: "until_merged" },
      source: "symphonyctl",
    });

    const snapshot = buildRuntimeSnapshot(orchestrator.getState(), {
      now: new Date("2026-06-11T12:30:00.000Z"),
    });
    expect(snapshot.anchors).toEqual([
      expect.objectContaining({
        issue_id: "1",
        issue_identifier: "ISSUE-1",
        placement: { kind: "above", issue_identifier: "ISSUE-0" },
        expiry: { kind: "until_merged" },
        set_by_sequence: first.sequence,
      }),
    ]);
  });

  it("unanchor removes the active anchor and replays cleanly", async () => {
    const orchestrator = createOrchestrator();
    await orchestrator.writeIntent({
      verb: "anchor",
      issueId: "1",
      issueIdentifier: "ISSUE-1",
      actor: OPERATOR,
      reason: { class: "operator_anchor", human: "pin" },
      anchor: {
        placement: { kind: "top" },
        expiry: { kind: "until_merged" },
        source: "symphonyctl",
      },
    });

    const result = await orchestrator.writeIntent({
      verb: "unanchor",
      issueId: "1",
      issueIdentifier: "ISSUE-1",
      actor: OPERATOR,
      reason: { class: "operator_unanchor", human: "done" },
    });
    expect(result.status).toBe("applied");
    expect(orchestrator.getState().issueAnchors["1"]).toBeUndefined();

    const replayed = createOrchestrator({
      runJournal: orchestrator.getState().dispatcherRunJournal,
    });
    expect(replayed.getState().issueAnchors["1"]).toBeUndefined();
  });

  it("flip-back anchors append fresh journal evidence and replay to the live state", async () => {
    const orchestrator = createOrchestrator();
    await orchestrator.writeIntent({
      verb: "anchor",
      issueId: "1",
      issueIdentifier: "ISSUE-1",
      actor: OPERATOR,
      reason: { class: "operator_anchor", human: "pin to top" },
      anchor: {
        placement: { kind: "top" },
        expiry: { kind: "until_merged" },
        source: "symphonyctl",
      },
    });
    await orchestrator.writeIntent({
      verb: "anchor",
      issueId: "1",
      issueIdentifier: "ISSUE-1",
      actor: OPERATOR,
      reason: { class: "operator_anchor", human: "pin below" },
      anchor: {
        placement: { kind: "below", issueIdentifier: "ISSUE-0" },
        expiry: { kind: "until_merged" },
        source: "symphonyctl",
      },
    });

    const flipBack = await orchestrator.writeIntent({
      verb: "anchor",
      issueId: "1",
      issueIdentifier: "ISSUE-1",
      actor: OPERATOR,
      reason: { class: "operator_anchor", human: "pin to top again" },
      anchor: {
        placement: { kind: "top" },
        expiry: { kind: "until_merged" },
        source: "symphonyctl",
      },
    });

    expect(flipBack.status).toBe("applied");
    expect(flipBack.sequence).toBe(3);
    expect(
      intentEntries(orchestrator).filter(
        (entry) => entry.metadata.verb === "anchor",
      ),
    ).toHaveLength(3);
    expect(orchestrator.getState().issueAnchors["1"]?.placement).toEqual({
      kind: "top",
    });

    const replayed = createOrchestrator({
      runJournal: orchestrator.getState().dispatcherRunJournal,
    });
    expect(replayed.getState().issueAnchors["1"]?.placement).toEqual({
      kind: "top",
    });
    expect(replayed.getState().issueAnchors["1"]?.setBySequence).toBe(3);
  });

  it("expired anchors drop from the explicit anchor read-model", async () => {
    const orchestrator = createOrchestrator();
    await orchestrator.writeIntent({
      verb: "anchor",
      issueId: "1",
      issueIdentifier: "ISSUE-1",
      actor: OPERATOR,
      reason: { class: "operator_anchor", human: "short pin" },
      anchor: {
        placement: { kind: "top" },
        expiry: { kind: "until_date", at: "2026-06-11T11:00:00.000Z" },
        source: "symphonyctl",
      },
    });
    expect(
      buildRuntimeSnapshot(orchestrator.getState(), {
        now: new Date("2026-06-11T12:00:00.000Z"),
      }).anchors,
    ).toEqual([]);
  });

  it("until-merged anchors are consumed by terminal journal evidence and do not resurrect on reopen", async () => {
    const config = createConfig();
    config.operatorAnchors = {
      operatorAllowlist: ["operator@mobilyze.com"],
      serviceAccounts: [],
      fieldName: "Queue Anchor",
      ingestSecret: null,
    };
    const orchestrator = createOrchestrator({ config });
    const anchorResult = await orchestrator.writeIntent({
      verb: "anchor",
      issueId: "1",
      issueIdentifier: "ISSUE-1",
      actor: OPERATOR,
      reason: { class: "operator_anchor", human: "until merged" },
      anchor: {
        placement: { kind: "top" },
        expiry: { kind: "until_merged" },
        source: "symphonyctl",
      },
    });
    const terminalEntry: DispatcherRunJournalEntry = {
      sequence: (anchorResult.sequence ?? 1) + 1,
      idempotencyKey: "tracker_write:1:terminal:done:Done:completed",
      timestamp: "2026-06-11T12:01:00.000Z",
      kind: "tracker_write",
      issueId: "1",
      issueIdentifier: "ISSUE-1",
      operation: "tracker_write",
      stage: "done",
      attempt: null,
      ownerId: "test-owner",
      lease: null,
      summary: "Move ISSUE-1 to terminal state Done.",
      metadata: { status: "completed" },
    };

    const replayed = createOrchestrator({
      config,
      runJournal: [
        ...orchestrator.getState().dispatcherRunJournal,
        terminalEntry,
      ],
    });
    expect(replayed.getState().completed.has("1")).toBe(true);
    expect(replayed.getState().issueAnchors["1"]).toBeUndefined();
    expect(
      buildRuntimeSnapshot(replayed.getState(), {
        now: new Date("2026-06-11T12:00:00.000Z"),
      }).anchors,
    ).toEqual([]);

    // A close/reopen cycle must not reveal a consumed anchor again.
    replayed.getState().completed.delete("1");
    expect(
      buildRuntimeSnapshot(replayed.getState(), {
        now: new Date("2026-06-11T12:02:00.000Z"),
      }).anchors,
    ).toEqual([]);

    const delayedEdit = await replayed.ingestAnchorFieldEdit({
      issueId: "1",
      issueIdentifier: "ISSUE-1",
      fieldName: "Queue Anchor",
      value: "below ISSUE-0 until-merged",
      editorEmail: "operator@mobilyze.com",
      editedAt: "2026-06-11T12:00:30.000Z",
    });
    expect(delayedEdit.status).toBe("rejected_stale");
    expect(delayedEdit.sequence).toBeNull();
    expect(replayed.getState().issueAnchors["1"]).toBeUndefined();
  });

  it("service-account field edits never produce operator anchors; allowlisted operator edits do", async () => {
    const config = createConfig();
    config.operatorAnchors = {
      operatorAllowlist: ["operator@mobilyze.com"],
      serviceAccounts: ["eric@mobilyze.com"],
      fieldName: "Queue Anchor",
      ingestSecret: null,
    };
    const orchestrator = createOrchestrator({ config });

    const service = await orchestrator.ingestAnchorFieldEdit({
      issueId: "1",
      issueIdentifier: "ISSUE-1",
      fieldName: "Queue Anchor",
      value: "top until-merged",
      editorEmail: "eric@mobilyze.com",
      editedAt: "2026-06-11T12:00:00.000Z",
    });
    expect(service.status).toBe("ignored");
    expect(orchestrator.getState().issueAnchors["1"]).toBeUndefined();
    expect(intentEntries(orchestrator)).toHaveLength(0);

    const operator = await orchestrator.ingestAnchorFieldEdit({
      issueId: "1",
      issueIdentifier: "ISSUE-1",
      fieldName: "Queue Anchor",
      value: "below ISSUE-0 until-merged",
      editorEmail: "Operator@Mobilyze.com",
      editedAt: "2026-06-11T12:01:00.000Z",
    });
    expect(operator.status).toBe("applied");
    expect(orchestrator.getState().issueAnchors["1"]).toMatchObject({
      placement: { kind: "below", issueIdentifier: "ISSUE-0" },
      source: "linear_field_edit",
      editorEmail: "operator@mobilyze.com",
    });
  });

  it("rejects field edit values with trailing tokens after until-merged", async () => {
    const config = createConfig();
    config.operatorAnchors = {
      operatorAllowlist: ["operator@mobilyze.com"],
      serviceAccounts: [],
      fieldName: "Queue Anchor",
      ingestSecret: null,
    };
    const orchestrator = createOrchestrator({ config });

    for (const { value, editedAt } of [
      {
        value: "top until-merged below ISSUE-2",
        editedAt: "2026-06-11T12:00:00.000Z",
      },
      {
        value: "above ISSUE-0 until-merged typo",
        editedAt: "2026-06-11T12:01:00.000Z",
      },
    ]) {
      const result = await orchestrator.ingestAnchorFieldEdit({
        issueId: "1",
        issueIdentifier: "ISSUE-1",
        fieldName: "Queue Anchor",
        value,
        editorEmail: "operator@mobilyze.com",
        editedAt,
      });
      expect(result.status).toBe("invalid");
      expect(typeof result.sequence).toBe("number");
    }
    expect(orchestrator.getState().issueAnchors["1"]).toBeUndefined();
    const entries = intentEntries(orchestrator);
    expect(entries).toHaveLength(2);
    expect(entries.map((entry) => entry.metadata.status)).toEqual([
      "no_op",
      "no_op",
    ]);
    expect(entries.map((entry) => entry.metadata.reason)).toEqual([
      expect.objectContaining({ class: "linear_field_edit_anchor_invalid" }),
      expect.objectContaining({ class: "linear_field_edit_anchor_invalid" }),
    ]);
    expect(entries.map((entry) => entry.metadata.anchorEditedAt)).toEqual([
      "2026-06-11T12:00:00.000Z",
      "2026-06-11T12:01:00.000Z",
    ]);
  });

  it("invalid allowlisted field edits advance the cursor against older delayed edits", async () => {
    const config = createConfig();
    config.operatorAnchors = {
      operatorAllowlist: ["operator@mobilyze.com"],
      serviceAccounts: [],
      fieldName: "Queue Anchor",
      ingestSecret: null,
    };
    const orchestrator = createOrchestrator({ config });

    const invalid = await orchestrator.ingestAnchorFieldEdit({
      issueId: "1",
      issueIdentifier: "ISSUE-1",
      fieldName: "Queue Anchor",
      value: "top until-merged below ISSUE-2",
      editorEmail: "operator@mobilyze.com",
      editedAt: "2026-06-11T12:05:00.000Z",
    });
    expect(invalid.status).toBe("invalid");
    expect(typeof invalid.sequence).toBe("number");

    const replayed = createOrchestrator({
      config,
      runJournal: orchestrator.getState().dispatcherRunJournal,
    });
    const delayedAfterReplay = await replayed.ingestAnchorFieldEdit({
      issueId: "1",
      issueIdentifier: "ISSUE-1",
      fieldName: "Queue Anchor",
      value: "top until-merged",
      editorEmail: "operator@mobilyze.com",
      editedAt: "2026-06-11T12:04:00.000Z",
    });
    expect(delayedAfterReplay.status).toBe("rejected_stale");
    expect(delayedAfterReplay.sequence).toBeNull();
    expect(replayed.getState().issueAnchors["1"]).toBeUndefined();

    const delayedValid = await orchestrator.ingestAnchorFieldEdit({
      issueId: "1",
      issueIdentifier: "ISSUE-1",
      fieldName: "Queue Anchor",
      value: "top until-merged",
      editorEmail: "operator@mobilyze.com",
      editedAt: "2026-06-11T12:04:00.000Z",
    });
    expect(delayedValid.status).toBe("rejected_stale");
    expect(delayedValid.sequence).toBeNull();
    expect(orchestrator.getState().issueAnchors["1"]).toBeUndefined();
  });

  it("field edit ingestion is inert when no anchor field name is configured", async () => {
    const config = createConfig();
    config.operatorAnchors = {
      operatorAllowlist: ["operator@mobilyze.com"],
      serviceAccounts: [],
      fieldName: null,
      ingestSecret: null,
    };
    const orchestrator = createOrchestrator({ config });

    const result = await orchestrator.ingestAnchorFieldEdit({
      issueId: "1",
      issueIdentifier: "ISSUE-1",
      fieldName: "Any Field",
      value: "top until-merged",
      editorEmail: "operator@mobilyze.com",
      editedAt: "2026-06-11T12:00:00.000Z",
    });
    expect(result.status).toBe("ignored");
    expect(orchestrator.getState().issueAnchors["1"]).toBeUndefined();
  });

  it("field edits older than the anchor cursor are rejected stale", async () => {
    const config = createConfig();
    config.operatorAnchors = {
      operatorAllowlist: ["operator@mobilyze.com"],
      serviceAccounts: [],
      fieldName: "Queue Anchor",
      ingestSecret: null,
    };
    const orchestrator = createOrchestrator({ config });

    const newer = await orchestrator.ingestAnchorFieldEdit({
      issueId: "1",
      issueIdentifier: "ISSUE-1",
      fieldName: "Queue Anchor",
      value: "top until-merged",
      editorEmail: "operator@mobilyze.com",
      editedAt: "2026-06-11T12:01:00.000Z",
    });
    expect(newer.status).toBe("applied");

    const stale = await orchestrator.ingestAnchorFieldEdit({
      issueId: "1",
      issueIdentifier: "ISSUE-1",
      fieldName: "Queue Anchor",
      value: "below ISSUE-0 until-merged",
      editorEmail: "operator@mobilyze.com",
      editedAt: "2026-06-11T12:00:00.000Z",
    });
    expect(stale.status).toBe("rejected_stale");
    expect(stale.sequence).toBeNull();
    expect(orchestrator.getState().issueAnchors["1"]?.placement).toEqual({
      kind: "top",
    });
  });

  it("same-value field edit no-ops advance the cursor across replay", async () => {
    const config = createConfig();
    config.operatorAnchors = {
      operatorAllowlist: ["operator@mobilyze.com"],
      serviceAccounts: [],
      fieldName: "Queue Anchor",
      ingestSecret: null,
    };
    const orchestrator = createOrchestrator({ config });

    const first = await orchestrator.ingestAnchorFieldEdit({
      issueId: "1",
      issueIdentifier: "ISSUE-1",
      fieldName: "Queue Anchor",
      value: "top until-merged",
      editorEmail: "operator@mobilyze.com",
      editedAt: "2026-06-11T12:01:00.000Z",
    });
    expect(first.status).toBe("applied");

    const sameValue = await orchestrator.ingestAnchorFieldEdit({
      issueId: "1",
      issueIdentifier: "ISSUE-1",
      fieldName: "Queue Anchor",
      value: "top until-merged",
      editorEmail: "operator@mobilyze.com",
      editedAt: "2026-06-11T12:05:00.000Z",
    });
    expect(sameValue.status).toBe("no_op");

    const delayed = await orchestrator.ingestAnchorFieldEdit({
      issueId: "1",
      issueIdentifier: "ISSUE-1",
      fieldName: "Queue Anchor",
      value: "below ISSUE-0 until-merged",
      editorEmail: "operator@mobilyze.com",
      editedAt: "2026-06-11T12:03:00.000Z",
    });
    expect(delayed.status).toBe("rejected_stale");
    expect(delayed.sequence).toBeNull();
    expect(orchestrator.getState().issueAnchors["1"]?.placement).toEqual({
      kind: "top",
    });

    const replayed = createOrchestrator({
      config,
      runJournal: orchestrator.getState().dispatcherRunJournal,
    });
    const delayedAfterReplay = await replayed.ingestAnchorFieldEdit({
      issueId: "1",
      issueIdentifier: "ISSUE-1",
      fieldName: "Queue Anchor",
      value: "below ISSUE-0 until-merged",
      editorEmail: "operator@mobilyze.com",
      editedAt: "2026-06-11T12:03:00.000Z",
    });
    expect(delayedAfterReplay.status).toBe("rejected_stale");
    expect(delayedAfterReplay.sequence).toBeNull();
    expect(replayed.getState().issueAnchors["1"]?.placement).toEqual({
      kind: "top",
    });
  });

  it("repeated clear field edit no-ops advance the cursor across replay", async () => {
    const config = createConfig();
    config.operatorAnchors = {
      operatorAllowlist: ["operator@mobilyze.com"],
      serviceAccounts: [],
      fieldName: "Queue Anchor",
      ingestSecret: null,
    };
    const orchestrator = createOrchestrator({ config });

    const anchor = await orchestrator.ingestAnchorFieldEdit({
      issueId: "1",
      issueIdentifier: "ISSUE-1",
      fieldName: "Queue Anchor",
      value: "top until-merged",
      editorEmail: "operator@mobilyze.com",
      editedAt: "2026-06-11T12:01:00.000Z",
    });
    expect(anchor.status).toBe("applied");

    const clear = await orchestrator.ingestAnchorFieldEdit({
      issueId: "1",
      issueIdentifier: "ISSUE-1",
      fieldName: "Queue Anchor",
      value: null,
      editorEmail: "operator@mobilyze.com",
      editedAt: "2026-06-11T12:05:00.000Z",
    });
    expect(clear.status).toBe("applied");
    expect(orchestrator.getState().issueAnchors["1"]).toBeUndefined();

    const repeatedClear = await orchestrator.ingestAnchorFieldEdit({
      issueId: "1",
      issueIdentifier: "ISSUE-1",
      fieldName: "Queue Anchor",
      value: "",
      editorEmail: "operator@mobilyze.com",
      editedAt: "2026-06-11T12:07:00.000Z",
    });
    expect(repeatedClear.status).toBe("no_op");

    const delayed = await orchestrator.ingestAnchorFieldEdit({
      issueId: "1",
      issueIdentifier: "ISSUE-1",
      fieldName: "Queue Anchor",
      value: "below ISSUE-0 until-merged",
      editorEmail: "operator@mobilyze.com",
      editedAt: "2026-06-11T12:06:00.000Z",
    });
    expect(delayed.status).toBe("rejected_stale");
    expect(delayed.sequence).toBeNull();
    expect(orchestrator.getState().issueAnchors["1"]).toBeUndefined();

    const replayed = createOrchestrator({
      config,
      runJournal: orchestrator.getState().dispatcherRunJournal,
    });
    const delayedAfterReplay = await replayed.ingestAnchorFieldEdit({
      issueId: "1",
      issueIdentifier: "ISSUE-1",
      fieldName: "Queue Anchor",
      value: "below ISSUE-0 until-merged",
      editorEmail: "operator@mobilyze.com",
      editedAt: "2026-06-11T12:06:00.000Z",
    });
    expect(delayedAfterReplay.status).toBe("rejected_stale");
    expect(delayedAfterReplay.sequence).toBeNull();
    expect(replayed.getState().issueAnchors["1"]).toBeUndefined();
  });

  it("serializes same-issue field edits so older concurrent webhooks cannot overwrite newer edits", async () => {
    const config = createConfig();
    config.operatorAnchors = {
      operatorAllowlist: ["operator@mobilyze.com"],
      serviceAccounts: [],
      fieldName: "Queue Anchor",
      ingestSecret: null,
    };

    let flushCount = 0;
    const firstFlush = { release: null as (() => void) | null };
    let resolveFirstFlushStarted!: () => void;
    const firstFlushStarted = new Promise<void>((resolve) => {
      resolveFirstFlushStarted = resolve;
    });
    const writeRunJournalEntry = vi.fn(async () => {
      flushCount += 1;
      if (flushCount !== 1) {
        return;
      }
      resolveFirstFlushStarted();
      await new Promise<void>((resolve) => {
        firstFlush.release = resolve;
      });
    });
    const orchestrator = createOrchestrator({ config, writeRunJournalEntry });

    const newer = orchestrator.ingestAnchorFieldEdit({
      issueId: "1",
      issueIdentifier: "ISSUE-1",
      fieldName: "Queue Anchor",
      value: "top until-merged",
      editorEmail: "operator@mobilyze.com",
      editedAt: "2026-06-11T12:01:00.000Z",
    });
    await firstFlushStarted;

    const older = orchestrator.ingestAnchorFieldEdit({
      issueId: "1",
      issueIdentifier: "ISSUE-1",
      fieldName: "Queue Anchor",
      value: "below ISSUE-0 until-merged",
      editorEmail: "operator@mobilyze.com",
      editedAt: "2026-06-11T12:00:00.000Z",
    });
    await Promise.resolve();
    await Promise.resolve();

    const releaseFirstFlush = firstFlush.release;
    if (releaseFirstFlush === null) {
      throw new Error("expected first journal flush to be pending");
    }
    releaseFirstFlush();

    await expect(newer).resolves.toMatchObject({ status: "applied" });
    await expect(older).resolves.toMatchObject({ status: "rejected_stale" });
    expect(writeRunJournalEntry).toHaveBeenCalledTimes(1);
    expect(orchestrator.getState().issueAnchors["1"]?.placement).toEqual({
      kind: "top",
    });
  });

  it("serializes direct anchor writes before mutating live anchor state", async () => {
    let flushCount = 0;
    const firstFlush = { release: null as (() => void) | null };
    let resolveFirstFlushStarted!: () => void;
    const firstFlushStarted = new Promise<void>((resolve) => {
      resolveFirstFlushStarted = resolve;
    });
    const writeRunJournalEntry = vi.fn(async () => {
      flushCount += 1;
      if (flushCount !== 1) {
        return;
      }
      resolveFirstFlushStarted();
      await new Promise<void>((resolve) => {
        firstFlush.release = resolve;
      });
    });
    const orchestrator = createOrchestrator({ writeRunJournalEntry });

    const first = orchestrator.writeIntent({
      verb: "anchor",
      issueId: "1",
      issueIdentifier: "ISSUE-1",
      actor: OPERATOR,
      reason: { class: "operator_anchor", human: "first direct anchor" },
      anchor: {
        placement: { kind: "top" },
        expiry: { kind: "until_merged" },
        source: "symphonyctl",
      },
    });
    await firstFlushStarted;

    const second = orchestrator.writeIntent({
      verb: "anchor",
      issueId: "1",
      issueIdentifier: "ISSUE-1",
      actor: OPERATOR,
      reason: { class: "operator_anchor", human: "second direct anchor" },
      anchor: {
        placement: { kind: "below", issueIdentifier: "ISSUE-0" },
        expiry: { kind: "until_merged" },
        source: "symphonyctl",
      },
    });
    await Promise.resolve();
    await Promise.resolve();

    expect(writeRunJournalEntry).toHaveBeenCalledTimes(1);
    expect(orchestrator.getState().issueAnchors["1"]?.placement).toEqual({
      kind: "top",
    });

    const releaseFirstFlush = firstFlush.release;
    if (releaseFirstFlush === null) {
      throw new Error("expected first journal flush to be pending");
    }
    releaseFirstFlush();

    const [firstResult, secondResult] = await Promise.all([first, second]);
    expect(firstResult.status).toBe("applied");
    expect(secondResult.status).toBe("applied");
    expect(orchestrator.getState().issueAnchors["1"]).toMatchObject({
      placement: { kind: "below", issueIdentifier: "ISSUE-0" },
      setBySequence: secondResult.sequence,
    });
    expect(writeRunJournalEntry).toHaveBeenCalledTimes(2);
  });

  it("field edit cursors advance by source edit time, not local process time", async () => {
    const config = createConfig();
    config.operatorAnchors = {
      operatorAllowlist: ["operator@mobilyze.com"],
      serviceAccounts: [],
      fieldName: "Queue Anchor",
      ingestSecret: null,
    };
    const orchestrator = createOrchestrator({
      config,
      now: () => new Date("2026-06-11T13:00:00.000Z"),
    });

    const first = await orchestrator.ingestAnchorFieldEdit({
      issueId: "1",
      issueIdentifier: "ISSUE-1",
      fieldName: "Queue Anchor",
      value: "top until-merged",
      editorEmail: "operator@mobilyze.com",
      editedAt: "2026-06-11T12:01:00.000Z",
    });
    expect(first.status).toBe("applied");

    const newer = await orchestrator.ingestAnchorFieldEdit({
      issueId: "1",
      issueIdentifier: "ISSUE-1",
      fieldName: "Queue Anchor",
      value: "below ISSUE-0 until-merged",
      editorEmail: "operator@mobilyze.com",
      editedAt: "2026-06-11T12:02:00.000Z",
    });
    expect(newer.status).toBe("applied");
    expect(orchestrator.getState().issueAnchors["1"]?.placement).toEqual({
      kind: "below",
      issueIdentifier: "ISSUE-0",
    });

    const replayed = createOrchestrator({
      config,
      runJournal: orchestrator.getState().dispatcherRunJournal,
      now: () => new Date("2026-06-11T13:00:00.000Z"),
    });
    const staleAfterReplay = await replayed.ingestAnchorFieldEdit({
      issueId: "1",
      issueIdentifier: "ISSUE-1",
      fieldName: "Queue Anchor",
      value: "top until-merged",
      editorEmail: "operator@mobilyze.com",
      editedAt: "2026-06-11T12:01:30.000Z",
    });
    expect(staleAfterReplay.status).toBe("rejected_stale");
  });

  it("direct anchor cursors use the journal timestamp fallback in live state and replay", async () => {
    const config = createConfig();
    config.operatorAnchors = {
      operatorAllowlist: ["operator@mobilyze.com"],
      serviceAccounts: [],
      fieldName: "Queue Anchor",
      ingestSecret: null,
    };
    const moments = [
      "2026-06-11T12:00:00.000Z",
      "2026-06-11T12:00:00.010Z",
      "2026-06-11T12:00:00.020Z",
      "2026-06-11T12:00:00.030Z",
    ];
    let nextMoment = 0;
    const orchestrator = createOrchestrator({
      config,
      now: () => {
        const moment =
          moments[Math.min(nextMoment++, moments.length - 1)] ??
          "2026-06-11T12:00:00.030Z";
        return new Date(moment);
      },
    });

    const directAnchor = await orchestrator.writeIntent({
      verb: "anchor",
      issueId: "1",
      issueIdentifier: "ISSUE-1",
      actor: OPERATOR,
      reason: { class: "operator_anchor", human: "direct anchor" },
      anchor: {
        placement: { kind: "top" },
        expiry: { kind: "until_merged" },
        source: "symphonyctl",
      },
    });
    expect(directAnchor.status).toBe("applied");
    const journalAfterDirectAnchor = orchestrator
      .getState()
      .dispatcherRunJournal.slice();
    expect(journalAfterDirectAnchor.at(-1)?.timestamp).toBe(
      "2026-06-11T12:00:00.020Z",
    );

    const liveEdit = await orchestrator.ingestAnchorFieldEdit({
      issueId: "1",
      issueIdentifier: "ISSUE-1",
      fieldName: "Queue Anchor",
      value: "below ISSUE-0 until-merged",
      editorEmail: "operator@mobilyze.com",
      editedAt: "2026-06-11T12:00:00.025Z",
    });
    expect(liveEdit.status).toBe("applied");

    const replayed = createOrchestrator({
      config,
      runJournal: journalAfterDirectAnchor,
      now: () => new Date("2026-06-11T12:00:00.030Z"),
    });
    const replayedEdit = await replayed.ingestAnchorFieldEdit({
      issueId: "1",
      issueIdentifier: "ISSUE-1",
      fieldName: "Queue Anchor",
      value: "below ISSUE-0 until-merged",
      editorEmail: "operator@mobilyze.com",
      editedAt: "2026-06-11T12:00:00.025Z",
    });
    expect(replayedEdit.status).toBe("applied");
  });

  it("expired until-date anchors do not wall-clock-pin later field edits", async () => {
    const config = createConfig();
    config.operatorAnchors = {
      operatorAllowlist: ["operator@mobilyze.com"],
      serviceAccounts: [],
      fieldName: "Queue Anchor",
      ingestSecret: null,
    };
    const orchestrator = createOrchestrator({ config });

    const expiredAnchor = await orchestrator.ingestAnchorFieldEdit({
      issueId: "1",
      issueIdentifier: "ISSUE-1",
      fieldName: "Queue Anchor",
      value: "top until 2026-06-11T11:00:00.000Z",
      editorEmail: "operator@mobilyze.com",
      editedAt: "2026-06-11T10:00:00.000Z",
    });
    expect(expiredAnchor.status).toBe("applied");

    const freshEdit = await orchestrator.ingestAnchorFieldEdit({
      issueId: "1",
      issueIdentifier: "ISSUE-1",
      fieldName: "Queue Anchor",
      value: "below ISSUE-0 until-merged",
      editorEmail: "operator@mobilyze.com",
      editedAt: "2026-06-11T11:30:00.000Z",
    });
    expect(freshEdit.status).toBe("applied");
    expect(orchestrator.getState().issueAnchors["1"]?.placement).toEqual({
      kind: "below",
      issueIdentifier: "ISSUE-0",
    });
  });

  it("stale-fenced unanchor does not lazily mutate expired anchor state", async () => {
    const orchestrator = createOrchestrator();
    await orchestrator.writeIntent({
      verb: "anchor",
      issueId: "1",
      issueIdentifier: "ISSUE-1",
      actor: OPERATOR,
      reason: { class: "operator_anchor", human: "short pin" },
      anchor: {
        placement: { kind: "top" },
        expiry: { kind: "until_date", at: "2026-06-11T11:00:00.000Z" },
        source: "symphonyctl",
      },
    });

    const stale = await orchestrator.writeIntent({
      verb: "unanchor",
      issueId: "1",
      issueIdentifier: "ISSUE-1",
      actor: OPERATOR,
      reason: { class: "operator_unanchor", human: "stale release" },
      fence: { expectedParkSeq: 99 },
    });
    expect(stale.status).toBe("rejected_stale");
    expect(orchestrator.getState().issueAnchors["1"]).toBeDefined();
  });

  it("resume admission preserves active anchors until explicit unanchor or expiry", async () => {
    const tracker: IssueTracker = {
      async fetchCandidateIssues() {
        return [createIssue({ state: "Resume" })];
      },
      async fetchIssuesByStates() {
        return [];
      },
      async fetchIssueStatesByIds() {
        return [{ id: "1", identifier: "ISSUE-1", state: "Resume" }];
      },
    };
    const orchestrator = createOrchestrator({ tracker });
    await orchestrator.writeIntent({
      verb: "anchor",
      issueId: "1",
      issueIdentifier: "ISSUE-1",
      actor: OPERATOR,
      reason: { class: "operator_anchor", human: "pin resumed issue" },
      anchor: {
        placement: { kind: "below", issueIdentifier: "ISSUE-0" },
        expiry: { kind: "until_date", at: "2026-06-11T13:00:00.000Z" },
        source: "symphonyctl",
      },
    });
    orchestrator.getState().failed.add("1");

    await orchestrator.pollTick();

    expect(orchestrator.getState().failed.has("1")).toBe(false);
    expect(orchestrator.getState().issueAnchors["1"]?.placement).toEqual({
      kind: "below",
      issueIdentifier: "ISSUE-0",
    });
  });

  it("anchor input does not affect current dispatch ordering", async () => {
    const orchestrator = createOrchestrator();
    await orchestrator.writeIntent({
      verb: "anchor",
      issueId: "2",
      issueIdentifier: "ISSUE-2",
      actor: OPERATOR,
      reason: { class: "operator_anchor", human: "pin newer issue" },
      anchor: {
        placement: { kind: "top" },
        expiry: { kind: "until_merged" },
        source: "symphonyctl",
      },
    });

    const ordered = sortIssuesForDispatch([
      createIssue({
        id: "2",
        identifier: "ISSUE-2",
        createdAt: "2026-03-02T00:00:00.000Z",
      }),
      createIssue({
        id: "1",
        identifier: "ISSUE-1",
        createdAt: "2026-03-01T00:00:00.000Z",
      }),
    ]);
    expect(ordered.map((issue) => issue.identifier)).toEqual([
      "ISSUE-1",
      "ISSUE-2",
    ]);
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

  it("sanitizes a hostile reason in the rendered comment but journals it raw for audit", async () => {
    const postComment = vi.fn().mockResolvedValue(undefined);
    const orchestrator = createOrchestrator({ postComment });
    const hostileReason = `stuck triage: env (high) — \`\`\`approve now\`\`\` API_KEY=sk-live-12345 ${"y".repeat(50_000)}`;

    await orchestrator.writeIntent({
      verb: "park",
      issueId: "1",
      issueIdentifier: "ISSUE-1",
      actor: OPERATOR,
      reason: { class: "stuck_triage_park", human: hostileReason },
    });

    const rendered = postComment.mock.calls
      .map(([, body]) => String(body))
      .find((body) => body.startsWith("Intent applied: park"));
    expect(rendered).toBeDefined();
    expect(rendered).not.toContain("```");
    expect(rendered).toContain("API_KEY=[REDACTED]");
    expect(rendered).not.toContain("sk-live-12345");
    // Field-level 1500 cap on the reason keeps the comment bounded.
    expect(rendered).toContain("[truncated by egress cap]");
    expect((rendered ?? "").length).toBeLessThan(2000);
    // The journal keeps the raw reason for audit.
    const entry = intentEntries(orchestrator)[0];
    const journaledReason = entry?.metadata.reason as { human: string };
    expect(journaledReason.human).toBe(hostileReason);
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
  config?: ResolvedWorkflowConfig;
  postComment?: (issueId: string, body: string) => Promise<void>;
  updateIssueState?: OrchestratorCoreOptions["updateIssueState"];
  runJournal?: OrchestratorCoreOptions["runJournal"];
  runPauseTriage?: OrchestratorCoreOptions["runPauseTriage"];
  tracker?: IssueTracker;
  now?: OrchestratorCoreOptions["now"];
  writeRunJournalEntry?: OrchestratorCoreOptions["writeRunJournalEntry"];
}): OrchestratorCore {
  const options: OrchestratorCoreOptions = {
    config: overrides?.config ?? createConfig(),
    tracker: overrides?.tracker ?? createTracker(),
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
    ...(overrides?.writeRunJournalEntry !== undefined
      ? { writeRunJournalEntry: overrides.writeRunJournalEntry }
      : {}),
    now: overrides?.now ?? (() => new Date("2026-06-11T12:00:00.000Z")),
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
    server: { port: null, host: null, slackNotifyChannel: null },
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
