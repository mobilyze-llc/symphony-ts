import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";

import type {
  DispatcherRunJournal,
  DispatcherRunJournalEntry,
} from "../../src/domain/model.js";
import { mapCrabrunnerUsageToStageUsage } from "../../src/domain/stage-usage.js";
import {
  appendDispatcherRunJournalEntriesWithLock,
  appendDispatcherRunJournalEntry,
  getDispatcherRunJournalPath,
  readDispatcherRunJournal,
} from "../../src/logging/run-journal.js";
import {
  DELEGATED_STAGE_ATTEMPT_JOURNAL_KIND,
  buildDelegatedStageAttemptJournalEntry,
  reduceDelegatedStageAttempts,
  summarizeDelegatedStageProjection,
} from "../../src/stage-execution/delegated-stage-projection.js";

describe("buildDelegatedStageAttemptJournalEntry", () => {
  it("builds an idempotent delegated_stage_attempt journal draft", () => {
    const draft = buildDelegatedStageAttemptJournalEntry({
      issueId: "issue-811",
      issueIdentifier: "SYMPH-811",
      runGroupId: "rg-1",
      stageName: "implement/patch-plan",
      stageAttempt: 0,
      status: "running",
      attemptIdempotencyKey: "k-pp-0",
      timestamp: "2026-06-20T05:00:00.000Z",
    });

    expect(draft.kind).toBe(DELEGATED_STAGE_ATTEMPT_JOURNAL_KIND);
    // Distinct per (attempt, status) so transitions are not deduped, but a
    // repeated identical transition is.
    expect(draft.idempotencyKey).toBe("delegated_stage_attempt:k-pp-0:running");
    expect(draft.stage).toBe("implement/patch-plan");
    expect(draft.attempt).toBe(0);
    expect(draft.metadata.runGroupId).toBe("rg-1");
    expect(draft.metadata.status).toBe("running");
  });
});

describe("reduceDelegatedStageAttempts", () => {
  it("reconstructs the latest status across a pending -> running -> terminal sequence", () => {
    const journal = journalFrom([
      attempt({ stage: "implement/patch-plan", attempt: 0, status: "pending" }),
      attempt({ stage: "implement/patch-plan", attempt: 0, status: "running" }),
      attempt({
        stage: "implement/patch-plan",
        attempt: 0,
        status: "succeeded",
      }),
    ]);

    const projection = reduceDelegatedStageAttempts(journal);
    expect(projection.active).toHaveLength(1);
    expect(projection.active[0]?.stageName).toBe("implement/patch-plan");
    expect(projection.active[0]?.status).toBe("succeeded");
    expect(projection.ignoredLate).toEqual([]);
    expect(projection.degraded).toEqual([]);
  });

  it("does not double-advance on duplicate results", () => {
    // The journal append dedupes by idempotencyKey...
    let journal: DispatcherRunJournal = [];
    const draft = buildDelegatedStageAttemptJournalEntry({
      issueId: "issue-811",
      issueIdentifier: "SYMPH-811",
      runGroupId: "rg-1",
      stageName: "implement/patch-plan",
      stageAttempt: 0,
      status: "succeeded",
      attemptIdempotencyKey: "k-pp-0",
      timestamp: "2026-06-20T05:00:00.000Z",
    });
    const first = appendDispatcherRunJournalEntry(journal, draft);
    journal = first.journal;
    const second = appendDispatcherRunJournalEntry(journal, draft);
    journal = second.journal;
    expect(first.appended).toBe(true);
    expect(second.appended).toBe(false);
    expect(journal).toHaveLength(1);

    // ...and the reducer is idempotent even if a duplicate slipped through.
    const projection = reduceDelegatedStageAttempts([...journal, journal[0]!]);
    expect(projection.active).toHaveLength(1);
    expect(projection.active[0]?.status).toBe("succeeded");
  });

  it("records a late result from a superseded attempt without advancing the active attempt", () => {
    const journal = journalFrom([
      attempt({
        stage: "implement/first-patch",
        attempt: 0,
        status: "running",
      }),
      attempt({
        stage: "implement/first-patch",
        attempt: 1,
        status: "running",
      }),
      // late terminal for the superseded attempt 0
      attempt({
        stage: "implement/first-patch",
        attempt: 0,
        status: "failed",
        failureClass: "infra",
      }),
      attempt({
        stage: "implement/first-patch",
        attempt: 1,
        status: "succeeded",
      }),
    ]);

    const projection = reduceDelegatedStageAttempts(journal);
    // The active attempt is the newest (1); the late attempt-0 result never
    // advances it.
    expect(projection.active).toHaveLength(1);
    expect(projection.active[0]?.stageAttempt).toBe(1);
    expect(projection.active[0]?.status).toBe("succeeded");
    expect(projection.ignoredLate).toHaveLength(1);
    expect(projection.ignoredLate[0]?.stageAttempt).toBe(0);
    expect(projection.ignoredLate[0]?.status).toBe("ignored_late_result");
  });

  it("classifies unknown status and missing metadata as explicit degraded, never silent success", () => {
    const journal = journalFrom([
      attempt({ stage: "implement/repair", attempt: 0, status: "succeeded" }),
    ]);
    // Unknown status value.
    journal.push(
      rawEntry(2, {
        runGroupId: "rg-1",
        stageName: "implement/repair",
        stageAttempt: 1,
        status: "definitely-not-a-status",
      }),
    );
    // Missing required metadata (no status key).
    journal.push(
      rawEntry(3, {
        runGroupId: "rg-1",
        stageName: "implement/repair",
        stageAttempt: 2,
      }),
    );

    const projection = reduceDelegatedStageAttempts(journal);
    expect(projection.degraded).toHaveLength(2);
    const reasons = projection.degraded.map((d) => d.reason);
    expect(reasons.some((r) => r.startsWith("unknown_status"))).toBe(true);
    expect(reasons.some((r) => r.startsWith("missing_metadata"))).toBe(true);
    // The malformed entries never present as a successful active attempt — only
    // the one well-formed succeeded attempt is active.
    expect(projection.active.map((a) => a.status)).toEqual(["succeeded"]);
  });

  it("ignores non-delegated journal kinds", () => {
    const journal: DispatcherRunJournal = [
      {
        sequence: 1,
        idempotencyKey: "merge_candidate:x",
        timestamp: "2026-06-20T05:00:00.000Z",
        kind: "merge_candidate",
        issueId: "issue-811",
        issueIdentifier: "SYMPH-811",
        operation: "gate",
        stage: "merge",
        attempt: 1,
        ownerId: null,
        lease: null,
        summary: "candidate",
        metadata: {},
      },
    ];
    const projection = reduceDelegatedStageAttempts(journal);
    expect(projection.active).toEqual([]);
    expect(projection.degraded).toEqual([]);
  });

  it("preserves usage-unavailable as unavailable, never zero", () => {
    const usage = mapCrabrunnerUsageToStageUsage({
      usage: { status: "unavailable", reason: "no usage row collected" },
      runnerKind: "codex",
      provider: "openai",
      model: "gpt-5.3-codex",
      profile: null,
    });
    const journal = journalFrom([
      attempt({
        stage: "implement/patch-plan",
        attempt: 0,
        status: "succeeded",
        usage,
      }),
    ]);

    const projection = reduceDelegatedStageAttempts(journal);
    const active = projection.active[0];
    expect(active?.usage?.measurementQuality).toBe("unavailable");
    // Tokens stay null — NOT coerced to 0.
    expect(active?.usage?.tokens.totalTokens).toBeNull();
    expect(active?.usage?.cost.amountUsd).toBeNull();
  });

  it("classifies an unknown metadata schema as degraded, never active", () => {
    const journal: DispatcherRunJournal = [
      rawEntry(1, {
        schema: "symphony.delegated-stage-attempt.v2",
        runGroupId: "rg-1",
        stageName: "implement/patch-plan",
        stageAttempt: 0,
        status: "succeeded",
      }),
    ];
    const projection = reduceDelegatedStageAttempts(journal);
    expect(projection.active).toEqual([]);
    expect(projection.degraded).toHaveLength(1);
    expect(projection.degraded[0]?.reason).toMatch(/unknown_schema/);
  });

  it("classifies a negative stageAttempt as degraded", () => {
    const journal: DispatcherRunJournal = [
      rawEntry(1, {
        runGroupId: "rg-1",
        stageName: "implement/patch-plan",
        stageAttempt: -1,
        status: "succeeded",
      }),
    ];
    const projection = reduceDelegatedStageAttempts(journal);
    expect(projection.active).toEqual([]);
    expect(projection.degraded).toHaveLength(1);
    expect(projection.degraded[0]?.reason).toMatch(/stageAttempt/);
  });

  it("does not let an out-of-order non-terminal entry revert a terminal attempt", () => {
    const journal = journalFrom([
      attempt({
        stage: "implement/patch-plan",
        attempt: 0,
        status: "succeeded",
      }),
      // A late / out-of-order running retry for the SAME attempt.
      attempt({ stage: "implement/patch-plan", attempt: 0, status: "running" }),
    ]);

    const projection = reduceDelegatedStageAttempts(journal);
    expect(projection.active).toHaveLength(1);
    expect(projection.active[0]?.status).toBe("succeeded");
    // The contradictory regression is recorded explicitly, never silently applied.
    expect(projection.degraded).toHaveLength(1);
    expect(projection.degraded[0]?.reason).toMatch(/contradictory/);
  });

  it("rejects a persisted ignored_late_result status as degraded, never active", () => {
    // ignored_late_result is reducer-synthetic; a writer must never persist it.
    const journal: DispatcherRunJournal = [
      rawEntry(1, {
        runGroupId: "rg-1",
        stageName: "implement/patch-plan",
        stageAttempt: 0,
        status: "ignored_late_result",
      }),
    ];
    const projection = reduceDelegatedStageAttempts(journal);
    expect(projection.active).toEqual([]);
    expect(projection.degraded).toHaveLength(1);
    expect(projection.degraded[0]?.reason).toMatch(/ignored_late_result/);
  });

  it("classifies a completely missing metadata schema as degraded", () => {
    const journal: DispatcherRunJournal = [
      {
        sequence: 1,
        idempotencyKey: "raw:1",
        timestamp: "2026-06-20T05:00:00.000Z",
        kind: DELEGATED_STAGE_ATTEMPT_JOURNAL_KIND,
        issueId: "issue-811",
        issueIdentifier: "SYMPH-811",
        operation: "dispatcher",
        stage: "implement/patch-plan",
        attempt: 0,
        ownerId: null,
        lease: null,
        summary: "no schema",
        // metadata intentionally has no `schema` key.
        metadata: {
          runGroupId: "rg-1",
          stageName: "implement/patch-plan",
          stageAttempt: 0,
          status: "succeeded",
          attemptIdempotencyKey: "k-pp-0",
        },
      },
    ];
    const projection = reduceDelegatedStageAttempts(journal);
    expect(projection.active).toEqual([]);
    expect(projection.degraded).toHaveLength(1);
    expect(projection.degraded[0]?.reason).toBe("unknown_schema:<missing>");
  });
});

describe("summarizeDelegatedStageProjection", () => {
  it("exposes substrate failure class and usage quality without raw JSON", () => {
    const usage = mapCrabrunnerUsageToStageUsage({
      usage: { status: "unavailable" },
      runnerKind: "codex",
      provider: "openai",
      model: "gpt-5.3-codex",
      profile: null,
    });
    const journal = journalFrom([
      attempt({
        stage: "implement/first-patch",
        attempt: 0,
        status: "failed",
        failureClass: "infra",
        usage,
      }),
    ]);
    journal.push(
      rawEntry(2, {
        runGroupId: "rg-1",
        stageName: "implement/repair",
        stageAttempt: 0,
      }),
    );

    const summary = summarizeDelegatedStageProjection(
      reduceDelegatedStageAttempts(journal),
    );
    expect(summary.active[0]?.failureClass).toBe("infra");
    expect(summary.active[0]?.usageQuality).toBe("unavailable");
    expect(summary.degradedCount).toBe(1);
    // No raw JSON blob as the primary surface.
    expect(JSON.stringify(summary)).not.toContain(
      "symphony.delegated-stage-attempt.v1",
    );
  });
});

describe("delegated stage projection durability", () => {
  it("reconstructs delegated stage state from the durable journal and is idempotent", async () => {
    const workspaceRoot = await mkdtemp(
      join(tmpdir(), "symphony-delegated-projection-"),
    );
    const drafts = [
      buildDelegatedStageAttemptJournalEntry({
        issueId: "issue-811",
        issueIdentifier: "SYMPH-811",
        runGroupId: "rg-1",
        stageName: "implement/patch-plan",
        stageAttempt: 0,
        status: "running",
        attemptIdempotencyKey: "k-pp-0",
        timestamp: "2026-06-20T05:00:00.000Z",
      }),
      buildDelegatedStageAttemptJournalEntry({
        issueId: "issue-811",
        issueIdentifier: "SYMPH-811",
        runGroupId: "rg-1",
        stageName: "implement/patch-plan",
        stageAttempt: 0,
        status: "succeeded",
        attemptIdempotencyKey: "k-pp-0",
        timestamp: "2026-06-20T05:01:00.000Z",
      }),
    ];

    await appendDispatcherRunJournalEntriesWithLock(workspaceRoot, drafts);
    // Re-appending the same drafts is a no-op (Symphony is the only writer and
    // writes are idempotent).
    const second = await appendDispatcherRunJournalEntriesWithLock(
      workspaceRoot,
      drafts,
    );
    expect(second.appendedEntries).toHaveLength(0);
    expect(second.skippedEntries).toHaveLength(2);

    const replayed = await readDispatcherRunJournal(workspaceRoot);
    const projection = reduceDelegatedStageAttempts(replayed);
    expect(projection.active).toHaveLength(1);
    expect(projection.active[0]?.status).toBe("succeeded");
  });
});

describe("cross-version replay", () => {
  it("replays a pre-delegation v1 review/merge-candidate journal cleanly (no delegated rows)", async () => {
    const fixture = await readFile(
      new URL(
        "../fixtures/review/v1-review-merge-candidate-journal.jsonl",
        import.meta.url,
      ),
      "utf8",
    );
    const workspaceRoot = await mkdtemp(
      join(tmpdir(), "symphony-delegated-xver-"),
    );
    const journalPath = getDispatcherRunJournalPath(workspaceRoot);
    await mkdir(dirname(journalPath), { recursive: true });
    await writeFile(journalPath, fixture);

    const replayed = await readDispatcherRunJournal(workspaceRoot);
    const projection = reduceDelegatedStageAttempts(replayed);
    expect(projection.active).toEqual([]);
    expect(projection.ignoredLate).toEqual([]);
    expect(projection.degraded).toEqual([]);
  });

  it("replays the captured v1 delegated stage journal fixture", async () => {
    const fixture = await readFile(
      new URL(
        "../fixtures/stage-execution/v1-delegated-stage-journal.jsonl",
        import.meta.url,
      ),
      "utf8",
    );
    const workspaceRoot = await mkdtemp(
      join(tmpdir(), "symphony-delegated-v1-"),
    );
    const journalPath = getDispatcherRunJournalPath(workspaceRoot);
    await mkdir(dirname(journalPath), { recursive: true });
    await writeFile(journalPath, fixture);

    const replayed = await readDispatcherRunJournal(workspaceRoot);
    const projection = reduceDelegatedStageAttempts(replayed);

    const active = [...projection.active].sort((a, b) =>
      a.stageName.localeCompare(b.stageName),
    );
    expect(active.map((a) => [a.stageName, a.stageAttempt, a.status])).toEqual([
      ["implement/first-patch", 1, "succeeded"],
      ["implement/patch-plan", 0, "succeeded"],
    ]);
    expect(projection.ignoredLate).toHaveLength(1);
    expect(projection.ignoredLate[0]?.stageName).toBe("implement/first-patch");
    expect(projection.ignoredLate[0]?.status).toBe("ignored_late_result");
    expect(projection.degraded).toHaveLength(1);
    expect(projection.degraded[0]?.reason).toMatch(/missing_metadata/);
  });
});

// ---- helpers ----------------------------------------------------------------

let nextSequence = 1;

function journalFrom(
  entries: readonly DispatcherRunJournalEntry[],
): DispatcherRunJournal {
  return [...entries];
}

function attempt(input: {
  stage: string;
  attempt: number;
  status: string;
  failureClass?: string | null;
  usage?: unknown;
}): DispatcherRunJournalEntry {
  const seq = nextSequence++;
  const draft = buildDelegatedStageAttemptJournalEntry({
    issueId: "issue-811",
    issueIdentifier: "SYMPH-811",
    runGroupId: "rg-1",
    stageName: input.stage,
    stageAttempt: input.attempt,
    // cast: tests intentionally pass arbitrary status strings for degraded paths
    status: input.status as never,
    attemptIdempotencyKey: `k-${input.stage}-${input.attempt}-${input.status}`,
    failureClass: input.failureClass ?? null,
    usage: (input.usage ?? null) as never,
    timestamp: `2026-06-20T05:00:0${seq}.000Z`,
  });
  return { ...draft, sequence: seq };
}

function rawEntry(
  sequence: number,
  metadata: Record<string, unknown>,
): DispatcherRunJournalEntry {
  return {
    sequence,
    idempotencyKey: `raw:${sequence}`,
    timestamp: "2026-06-20T05:09:00.000Z",
    kind: DELEGATED_STAGE_ATTEMPT_JOURNAL_KIND,
    issueId: "issue-811",
    issueIdentifier: "SYMPH-811",
    operation: "dispatcher",
    stage: typeof metadata.stageName === "string" ? metadata.stageName : null,
    attempt:
      typeof metadata.stageAttempt === "number" ? metadata.stageAttempt : null,
    ownerId: null,
    lease: null,
    summary: "raw delegated entry",
    metadata: { schema: "symphony.delegated-stage-attempt.v1", ...metadata },
  };
}
