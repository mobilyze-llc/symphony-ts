import { execFileSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { beforeEach, describe, expect, it, vi } from "vitest";

import type {
  AgentRunInput,
  AgentRunResult,
  AgentRunnerEvent,
} from "../../src/agent/runner.js";
import type { ResolvedWorkflowConfig } from "../../src/config/types.js";
import type {
  DispatcherRunJournal,
  DispatcherRunJournalEntry,
  Issue,
  LoopTraceJournal,
  ManagerRunJournal,
} from "../../src/domain/model.js";
import { ERROR_CODES } from "../../src/errors/codes.js";
import { writeLoopTraceJournal } from "../../src/logging/loop-trace.js";
import { compactDispatcherRunJournalWithCheckpoint } from "../../src/logging/run-journal.js";
import {
  type StructuredLogEntry,
  StructuredLogger,
} from "../../src/logging/structured-logger.js";
import {
  SERVICE_SHUTDOWN_ABORT_REASON,
  type StopSignalDelivery,
} from "../../src/orchestrator/core.js";
import type { MergeCandidateRecord } from "../../src/orchestrator/merge-candidate.js";
import type { PipelineNotificationEvent } from "../../src/orchestrator/pipeline-notifier.js";
import {
  loadPersistedRateLimitSnapshot,
  persistRateLimitSnapshot,
} from "../../src/orchestrator/rate-limit-persistence.js";
import {
  OrchestratorRuntimeHost,
  RuntimeHostStartupError,
  createWorkspaceHookLogger,
  deliverTrackedWorkerStopSignal,
  extractProductName,
  findWorkspaceCwdProcessIds,
  parseLsofCwdProcessEntries,
  readGitBaseRevision,
  readGitChangedFiles,
  runtimeHostMergeActuatorTesting,
  signalPid,
  startRuntimeService,
} from "../../src/orchestrator/runtime-host.js";
import type {
  TrackFindingFilingRequest,
  TrackFindingFilingResult,
} from "../../src/orchestrator/track-finding-filing.js";
import type {
  ProcessIdentitySnapshot,
  ProcessTreeTerminationResult,
} from "../../src/shared/process-tree.js";
import { TrackerError } from "../../src/tracker/errors.js";
import { LinearTrackerClient } from "../../src/tracker/linear-client.js";
import type {
  IssueStateSnapshot,
  IssueTracker,
} from "../../src/tracker/tracker.js";
import {
  sanitizeWorkspaceKey,
  toWorkspaceArtifactKey,
} from "../../src/workspace/path-safety.js";
import { WorkspaceManager } from "../../src/workspace/workspace-manager.js";

const RATE_LIMIT_CLEANUP_SLEEP_BUFFER = new Int32Array(
  new SharedArrayBuffer(4),
);

beforeEach(() => {
  rmSync(join("/tmp/workspaces", ".symphony", "run-journals"), {
    recursive: true,
    force: true,
  });
});

describe("runtime host merge actuator parsing (SYMPH-735)", () => {
  // fetchMergeActuatorLiveState drives gh through the non-injectable module
  // execFileAsync, so its parse path is exercised here via the pure helpers it
  // composes: a complete gh JSON payload maps to a usable live state, an
  // incomplete one fails closed to null.
  it("maps a complete gh pr view payload to a usable live state", () => {
    const payload = JSON.stringify({
      url: "https://github.com/acme/repo/pull/7",
      state: "OPEN",
      isDraft: false,
      mergeStateStatus: "CLEAN",
      mergeable: "MERGEABLE",
      reviewDecision: "APPROVED",
      headRefOid: "deadbeef",
      baseRefName: "main",
      statusCheckRollup: [
        { name: "ci", status: "COMPLETED", conclusion: "SUCCESS" },
        { name: "broken", status: "COMPLETED", conclusion: "FAILURE" },
        { name: "queued", status: "QUEUED", conclusion: "ACTION_REQUIRED" },
      ],
      mergedAt: null,
      mergeCommit: null,
    });

    const parsed = runtimeHostMergeActuatorTesting.parseJsonObject(payload);
    expect(parsed).not.toBeNull();
    expect(runtimeHostMergeActuatorTesting.parsePrState(parsed?.state)).toBe(
      "OPEN",
    );
    // The mined SYMPH-735 substrate maps gh check conclusions to required-check
    // buckets: SUCCESS -> pass, a terminal non-skip conclusion -> fail,
    // ACTION_REQUIRED -> pending.
    expect(
      runtimeHostMergeActuatorTesting.parseStatusCheckRollup(
        parsed?.statusCheckRollup,
      ),
    ).toEqual([
      { name: "ci", status: "pass" },
      { name: "broken", status: "fail" },
      { name: "queued", status: "pending" },
    ]);
  });

  it("fails closed to null for incomplete gh pr view payloads", () => {
    expect(
      runtimeHostMergeActuatorTesting.parseJsonObject("{not-json"),
    ).toBeNull();
    // Missing/blank required fields the fetcher gates on (state, headRefOid,
    // baseRefName) collapse to null rather than yielding a partial live state.
    expect(runtimeHostMergeActuatorTesting.parsePrState(undefined)).toBeNull();
    expect(runtimeHostMergeActuatorTesting.parsePrState("LOCKED")).toBeNull();
    const missingHead = runtimeHostMergeActuatorTesting.parseJsonObject(
      JSON.stringify({ state: "OPEN", baseRefName: "main" }),
    );
    expect(missingHead?.headRefOid).toBeUndefined();
    expect(
      runtimeHostMergeActuatorTesting.parseStatusCheckRollup("not-an-array"),
    ).toEqual([]);
  });

  // SYMPH-751: in-flight CheckRuns (conclusion: null while QUEUED/IN_PROGRESS/
  // PENDING) must map to pending, not fail — otherwise the now-enabled merge
  // actuator parks a healthy PR merely waiting on CI.
  it("maps an in-flight CheckRun (conclusion: null) to pending", () => {
    expect(
      runtimeHostMergeActuatorTesting.parseStatusCheckRollup([
        { name: "test", status: "IN_PROGRESS", conclusion: null },
      ]),
    ).toEqual([{ name: "test", status: "pending" }]);
  });

  it("maps a queued CheckRun (conclusion: null) to pending", () => {
    expect(
      runtimeHostMergeActuatorTesting.parseStatusCheckRollup([
        { name: "q", status: "QUEUED", conclusion: null },
      ]),
    ).toEqual([{ name: "q", status: "pending" }]);
  });

  it("maps a CheckRun with an absent conclusion field to pending", () => {
    expect(
      runtimeHostMergeActuatorTesting.parseStatusCheckRollup([
        { name: "x", status: "PENDING" },
      ]),
    ).toEqual([{ name: "x", status: "pending" }]);
  });

  // SYMPH-751: legacy StatusContext nodes (context/state, no name/status/
  // conclusion) were silently dropped — hiding a failing legacy check from the
  // actuator. Parse them by field presence.
  it("maps a StatusContext PENDING state to pending", () => {
    expect(
      runtimeHostMergeActuatorTesting.parseStatusCheckRollup([
        { context: "ci/circleci", state: "PENDING" },
      ]),
    ).toEqual([{ name: "ci/circleci", status: "pending" }]);
  });

  it("maps a StatusContext SUCCESS state to pass", () => {
    expect(
      runtimeHostMergeActuatorTesting.parseStatusCheckRollup([
        { context: "ci/circleci", state: "SUCCESS" },
      ]),
    ).toEqual([{ name: "ci/circleci", status: "pass" }]);
  });

  it("maps a StatusContext FAILURE state to fail", () => {
    expect(
      runtimeHostMergeActuatorTesting.parseStatusCheckRollup([
        { context: "ci/circleci", state: "FAILURE" },
      ]),
    ).toEqual([{ name: "ci/circleci", status: "fail" }]);
  });

  it("maps a StatusContext ERROR state to fail", () => {
    expect(
      runtimeHostMergeActuatorTesting.parseStatusCheckRollup([
        { context: "ci/circleci", state: "ERROR" },
      ]),
    ).toEqual([{ name: "ci/circleci", status: "fail" }]);
  });

  it("maps a StatusContext EXPECTED state to pending", () => {
    expect(
      runtimeHostMergeActuatorTesting.parseStatusCheckRollup([
        { context: "ci/circleci", state: "EXPECTED" },
      ]),
    ).toEqual([{ name: "ci/circleci", status: "pending" }]);
  });

  it("preserves both node types and order in a mixed rollup", () => {
    expect(
      runtimeHostMergeActuatorTesting.parseStatusCheckRollup([
        { name: "ga", status: "COMPLETED", conclusion: "SUCCESS" },
        { context: "legacy", state: "FAILURE" },
      ]),
    ).toEqual([
      { name: "ga", status: "pass" },
      { name: "legacy", status: "fail" },
    ]);
  });

  it("drops a rollup entry with neither name nor context", () => {
    expect(
      runtimeHostMergeActuatorTesting.parseStatusCheckRollup([
        {},
        { name: "ok", status: "COMPLETED", conclusion: "SUCCESS" },
      ]),
    ).toEqual([{ name: "ok", status: "pass" }]);
  });

  // SYMPH-751 fail-closed contract (council Track): any terminal CheckRun
  // conclusion that is not an explicit pass/pending value — including unknown
  // future values — must map to fail, never silently to pass. A false pass
  // would let the actuator merge a broken PR.
  it.each(["CANCELLED", "TIMED_OUT", "STARTUP_FAILURE", "STALE", "MYSTERY"])(
    "maps terminal CheckRun conclusion %s to fail (fail-closed)",
    (conclusion) => {
      expect(
        runtimeHostMergeActuatorTesting.parseStatusCheckRollup([
          { name: "c", status: "COMPLETED", conclusion },
        ]),
      ).toEqual([{ name: "c", status: "fail" }]);
    },
  );

  // Same fail-closed contract for legacy StatusContext: an unrecognized state
  // (incl. a non-string state coerced to undefined) must fail closed.
  it.each(["MYSTERY_STATE", "", "BROKEN"])(
    "maps unknown StatusContext state %s to fail (fail-closed)",
    (state) => {
      expect(
        runtimeHostMergeActuatorTesting.parseStatusCheckRollup([
          { context: "legacy", state },
        ]),
      ).toEqual([{ name: "legacy", status: "fail" }]);
    },
  );

  it("maps an empty-string CheckRun conclusion to pending (not-yet-concluded)", () => {
    expect(
      runtimeHostMergeActuatorTesting.parseStatusCheckRollup([
        { name: "c", status: "IN_PROGRESS", conclusion: "" },
      ]),
    ).toEqual([{ name: "c", status: "pending" }]);
  });
});

describe("runtime host merge actuator enqueue args (SYMPH-750)", () => {
  function mergeCandidate(
    overrides: Partial<MergeCandidateRecord> = {},
  ): MergeCandidateRecord {
    return {
      candidateId: "candidate-1",
      issueId: "issue-1",
      issueIdentifier: "SYMPH-750",
      repo: "mobilyze-llc/symphony-ts",
      prNumber: 552,
      prUrl: "https://github.com/mobilyze-llc/symphony-ts/pull/552",
      baseRef: "main",
      baseSha: "base-1",
      headRef: "claude/SYMPH-750",
      headSha: "reviewed-head-1",
      reviewedHeadSha: "reviewed-head-1",
      reviewResultPath: "/tmp/review-result.json",
      councilVerdict: "pass",
      decorrelationMergeEligible: true,
      round: 1,
      stage: "merge",
      actorKind: "dispatcher",
      actorId: "owner-1",
      ownerId: "owner-1",
      leaseId: "lease-1",
      createdAt: "2026-06-16T00:00:00.000Z",
      updatedAt: "2026-06-16T00:00:00.000Z",
      status: "candidate",
      supersededBy: null,
      lastActuation: null,
      mergeCommit: null,
      mergedAt: null,
      blockedReason: null,
      cursorRange: { firstSequence: 1, lastSequence: 2 },
      ...overrides,
    };
  }

  // Locks the exact enqueue arg vector so the reviewed-head pin can never be
  // silently dropped. `--match-head-commit <reviewedHeadSha>` is a MERGE-time
  // check (GraphQL expectedHeadOid "must match to allow merge"), riding into the
  // enablePullRequestAutoMerge mutation via `--auto`, so an advancing head cannot
  // merge unreviewed code. See buildMergeActuatorEnqueueArgs doc comment.
  it("pins the reviewed head and enables auto-merge", () => {
    const candidate = mergeCandidate({
      prNumber: 731,
      repo: "mobilyze-llc/symphony-ts",
      reviewedHeadSha: "abc1234deadbeef",
    });

    expect(
      runtimeHostMergeActuatorTesting.buildMergeActuatorEnqueueArgs(candidate),
    ).toEqual([
      "pr",
      "merge",
      "731",
      "--repo",
      "mobilyze-llc/symphony-ts",
      "--match-head-commit",
      "abc1234deadbeef",
      "--auto",
    ]);
  });

  // The pin tracks reviewedHeadSha specifically — never the (possibly advanced)
  // working headSha — so review identity, not the latest push, gates the merge.
  it("pins reviewedHeadSha even when the working headSha has advanced", () => {
    const candidate = mergeCandidate({
      reviewedHeadSha: "reviewed-sha",
      headSha: "advanced-sha",
    });

    const args =
      runtimeHostMergeActuatorTesting.buildMergeActuatorEnqueueArgs(candidate);
    const matchIndex = args.indexOf("--match-head-commit");

    expect(matchIndex).toBeGreaterThanOrEqual(0);
    expect(args[matchIndex + 1]).toBe("reviewed-sha");
    expect(args).not.toContain("advanced-sha");
  });

  // Locks the dequeue arg vector (SYMPH-766): `--disable-auto` only turns
  // auto-merge off; it must NEVER carry `--auto` or a merge strategy, so the
  // dequeue side effect can never silently become a merge.
  it("dequeues with --disable-auto and never merges", () => {
    const candidate = mergeCandidate({
      prNumber: 731,
      repo: "mobilyze-llc/symphony-ts",
    });

    const args =
      runtimeHostMergeActuatorTesting.buildMergeActuatorDisableAutoArgs(
        candidate,
      );

    expect(args).toEqual([
      "pr",
      "merge",
      "731",
      "--repo",
      "mobilyze-llc/symphony-ts",
      "--disable-auto",
    ]);
    expect(args).not.toContain("--auto");
    expect(args).not.toContain("--match-head-commit");
    expect(args).not.toContain("--squash");
    expect(args).not.toContain("--merge");
    expect(args).not.toContain("--rebase");
  });
});

function removeWorkspaceWithRetry(workspaceRoot: string): void {
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      rmSync(workspaceRoot, { recursive: true, force: true });
      return;
    } catch (error) {
      const code =
        typeof error === "object" && error !== null && "code" in error
          ? error.code
          : null;
      if (
        (code !== "ENOTEMPTY" && code !== "EBUSY" && code !== "EPERM") ||
        attempt === 4
      ) {
        throw error;
      }
      // Test-only synchronous sleep: give macOS file handles a short window to settle.
      Atomics.wait(RATE_LIMIT_CLEANUP_SLEEP_BUFFER, 0, 0, 25);
    }
  }
}

async function ignoreDispatcherRunJournalEntry(
  _workspaceRoot: string,
  _entry: DispatcherRunJournalEntry,
): Promise<void> {}

describe("OrchestratorRuntimeHost", () => {
  it("retains untracked files when HEAD-based git diffs fail in a fresh repo", async () => {
    const repoPath = mkdtempSync(join(tmpdir(), "symphony-read-git-"));
    try {
      execFileSync("git", ["init", repoPath]);
      writeFileSync(join(repoPath, "new-file.ts"), "export {};\n");

      await expect(readGitChangedFiles(repoPath)).resolves.toEqual([
        "new-file.ts",
      ]);
    } finally {
      rmSync(repoPath, { recursive: true, force: true });
    }
  });

  it("resolves base revision in a bare-clone worktree without origin/main", async () => {
    const rootPath = mkdtempSync(join(tmpdir(), "symphony-base-ref-"));
    const sourcePath = join(rootPath, "source");
    const barePath = join(rootPath, "source.git");
    const worktreePath = join(rootPath, "worker");
    try {
      mkdirSync(sourcePath);
      execFileSync("git", ["init", "-b", "main", sourcePath]);
      execFileSync("git", [
        "-C",
        sourcePath,
        "config",
        "user.email",
        "test@example.com",
      ]);
      execFileSync("git", [
        "-C",
        sourcePath,
        "config",
        "user.name",
        "Test User",
      ]);
      writeFileSync(join(sourcePath, "file.txt"), "base\n");
      execFileSync("git", ["-C", sourcePath, "add", "file.txt"]);
      execFileSync("git", ["-C", sourcePath, "commit", "-m", "base"]);
      const baseRevision = execFileSync(
        "git",
        ["-C", sourcePath, "rev-parse", "HEAD"],
        {
          encoding: "utf8",
        },
      ).trim();
      execFileSync("git", ["clone", "--bare", sourcePath, barePath], {
        stdio: "ignore",
      });
      execFileSync(
        "git",
        [
          "-C",
          barePath,
          "worktree",
          "add",
          worktreePath,
          "-b",
          "worktree/ISSUE-1",
          "main",
        ],
        { stdio: "ignore" },
      );

      expect(() =>
        execFileSync(
          "git",
          [
            "-C",
            worktreePath,
            "show-ref",
            "--verify",
            "refs/remotes/origin/main",
          ],
          { stdio: "ignore" },
        ),
      ).toThrow();
      await expect(readGitBaseRevision(worktreePath)).resolves.toBe(
        baseRevision,
      );
    } finally {
      rmSync(rootPath, { recursive: true, force: true });
    }
  });

  it("prefers SYMPHONY_BASE_BRANCH over existing main refs", async () => {
    const rootPath = mkdtempSync(join(tmpdir(), "symphony-base-env-"));
    const sourcePath = join(rootPath, "source");
    const barePath = join(rootPath, "source.git");
    const worktreePath = join(rootPath, "worker");
    const originalBaseBranch = process.env.SYMPHONY_BASE_BRANCH;
    try {
      mkdirSync(sourcePath);
      execFileSync("git", ["init", "-b", "main", sourcePath]);
      execFileSync("git", [
        "-C",
        sourcePath,
        "config",
        "user.email",
        "test@example.com",
      ]);
      execFileSync("git", [
        "-C",
        sourcePath,
        "config",
        "user.name",
        "Test User",
      ]);
      writeFileSync(join(sourcePath, "file.txt"), "main\n");
      execFileSync("git", ["-C", sourcePath, "add", "file.txt"]);
      execFileSync("git", ["-C", sourcePath, "commit", "-m", "main"], {
        stdio: "ignore",
      });
      execFileSync("git", ["-C", sourcePath, "checkout", "-b", "develop"], {
        stdio: "ignore",
      });
      writeFileSync(join(sourcePath, "file.txt"), "develop\n");
      execFileSync("git", ["-C", sourcePath, "commit", "-am", "develop"], {
        stdio: "ignore",
      });
      const developRevision = execFileSync(
        "git",
        ["-C", sourcePath, "rev-parse", "HEAD"],
        {
          encoding: "utf8",
        },
      ).trim();
      execFileSync("git", ["clone", "--bare", sourcePath, barePath], {
        stdio: "ignore",
      });
      execFileSync("git", [
        "-C",
        barePath,
        "update-ref",
        "refs/remotes/origin/main",
        "main",
      ]);
      execFileSync("git", [
        "-C",
        barePath,
        "update-ref",
        "refs/remotes/origin/develop",
        "develop",
      ]);
      execFileSync(
        "git",
        [
          "-C",
          barePath,
          "worktree",
          "add",
          worktreePath,
          "-b",
          "worktree/ISSUE-2",
          "origin/develop",
        ],
        { stdio: "ignore" },
      );
      process.env.SYMPHONY_BASE_BRANCH = "develop";

      await expect(readGitBaseRevision(worktreePath)).resolves.toBe(
        developRevision,
      );
    } finally {
      if (originalBaseBranch === undefined) {
        Reflect.deleteProperty(process.env, "SYMPHONY_BASE_BRANCH");
      } else {
        process.env.SYMPHONY_BASE_BRANCH = originalBaseBranch;
      }
      rmSync(rootPath, { recursive: true, force: true });
    }
  });

  it("reports all attempted refs when base revision cannot be resolved", async () => {
    const repoPath = mkdtempSync(join(tmpdir(), "symphony-base-missing-"));
    try {
      execFileSync("git", ["init", "-b", "main", repoPath], {
        stdio: "ignore",
      });

      await expect(readGitBaseRevision(repoPath)).rejects.toThrow(
        /origin\/main: ref not found.*main: ref not found.*origin\/master: ref not found.*master: ref not found/,
      );
    } finally {
      rmSync(repoPath, { recursive: true, force: true });
    }
  });

  it("feeds codex events into orchestrator state and schedules continuation retry after a normal worker exit", async () => {
    const tracker = createTracker();
    const fakeRunner = new FakeAgentRunner();
    const host = new OrchestratorRuntimeHost({
      config: createConfig(),
      tracker,
      createAgentRunner: ({ onEvent }) => {
        fakeRunner.onEvent = onEvent;
        return fakeRunner;
      },
      now: () => new Date("2026-03-06T00:00:05.000Z"),
    });

    const tick = await host.pollOnce();

    expect(tick.dispatchedIssueIds).toEqual(["1"]);
    fakeRunner.emit("1", {
      event: "session_started",
      timestamp: "2026-03-06T00:00:01.000Z",
      codexAppServerPid: "1001",
      sessionId: "thread-1-turn-1",
      threadId: "thread-1",
      turnId: "turn-1",
    });
    fakeRunner.emit("1", {
      event: "turn_completed",
      timestamp: "2026-03-06T00:00:02.000Z",
      codexAppServerPid: "1001",
      sessionId: "thread-1-turn-1",
      threadId: "thread-1",
      turnId: "turn-1",
      usage: {
        inputTokens: 11,
        outputTokens: 7,
        totalTokens: 18,
      },
      rateLimits: {
        requestsRemaining: 9,
      },
      message: "turn completed",
    });
    fakeRunner.emit("1", {
      event: "session_artifact_saved",
      timestamp: "2026-03-06T00:00:03.000Z",
      codexAppServerPid: "1001",
      sessionId: "thread-1-turn-1",
      threadId: "thread-1",
      turnId: "turn-1",
      artifacts: [
        {
          label: "sessions/2026/rollout-test.jsonl",
          path: "/tmp/workspaces/1/.symphony/codex-sessions/rollout-test.jsonl",
          sourcePath: "/tmp/symphony-codex-home-1/sessions/rollout-test.jsonl",
          bytes: 80,
        },
      ],
      message: "Preserved 1 Codex session artifact(s).",
    });
    await host.flushEvents();

    let snapshot = await host.getRuntimeSnapshot();
    expect(snapshot.running).toEqual([
      expect.objectContaining({
        issue_id: "1",
        session_id: "thread-1-turn-1",
        turn_count: 1,
        last_event: "session_artifact_saved",
        last_message: "Preserved 1 Codex session artifact(s).",
        tokens: {
          input_tokens: 11,
          output_tokens: 7,
          total_tokens: 18,
          cache_read_tokens: 0,
          cache_write_tokens: 0,
          reasoning_tokens: 0,
        },
      }),
    ]);
    expect(snapshot.codex_totals.total_tokens).toBe(18);
    const details = await host.getIssueDetails("ISSUE-1");
    expect(details?.running?.token_telemetry).toEqual([
      expect.objectContaining({
        at: "2026-03-06T00:00:02.000Z",
        event: "turn_completed",
        session_id: "thread-1-turn-1",
        turn_id: "turn-1",
        input_tokens: 11,
        output_tokens: 7,
        total_tokens: 18,
        input_tokens_delta: 11,
        output_tokens_delta: 7,
        total_tokens_delta: 18,
      }),
    ]);
    expect(details?.running?.token_telemetry_total_entries).toBe(1);
    expect(details?.running?.token_telemetry_truncated).toBe(false);
    expect(details?.logs.codex_session_logs).toEqual([
      {
        label: "sessions/2026/rollout-test.jsonl",
        path: "/tmp/workspaces/1/.symphony/codex-sessions/rollout-test.jsonl",
        url: null,
        bytes: 80,
      },
    ]);

    fakeRunner.resolve("1", {
      issue: createIssue({ state: "In Progress" }),
      workspace: {
        path: "/tmp/workspaces/1",
        workspaceKey: "1",
        createdNow: true,
      },
      runAttempt: {
        issueId: "1",
        issueIdentifier: "ISSUE-1",
        attempt: null,
        workspacePath: "/tmp/workspaces/1",
        startedAt: "2026-03-06T00:00:00.000Z",
        status: "succeeded",
      },
      liveSession: {
        sessionId: "thread-1-turn-1",
        threadId: "thread-1",
        turnId: "turn-1",
        codexAppServerPid: "1001",
        codexAppServerIdentity: null,
        lastCodexEvent: "turn_completed",
        lastCodexTimestamp: "2026-03-06T00:00:02.000Z",
        lastCodexMessage: "turn completed",
        codexInputTokens: 11,
        codexOutputTokens: 7,
        codexTotalTokens: 18,
        codexCacheReadTokens: 0,
        codexCacheWriteTokens: 0,
        codexNoCacheTokens: 0,
        codexReasoningTokens: 0,
        codexTotalInputTokens: 11,
        codexTotalOutputTokens: 7,
        lastReportedInputTokens: 11,
        lastReportedOutputTokens: 7,
        lastReportedTotalTokens: 18,
        lastReportedCacheReadTokens: 0,
        lastReportedCacheWriteTokens: 0,
        lastReportedNoCacheTokens: 0,
        lastReportedReasoningTokens: 0,
        turnCount: 1,
        totalStageInputTokens: 0,
        totalStageOutputTokens: 0,
        totalStageTotalTokens: 0,
        totalStageCacheReadTokens: 0,
        totalStageCacheWriteTokens: 0,
        turnHistory: [],
        recentActivity: [],
        tokenTelemetry: [],
        tokenTelemetryObservedCount: 0,
        codexSessionLogs: [],
        rateLimitWindows: {
          primary: null,
          secondary: null,
        },
      },
      turnsCompleted: 1,
      lastTurn: null,
      rateLimits: {
        requestsRemaining: 9,
      },
    });
    await host.waitForIdle();

    snapshot = await host.getRuntimeSnapshot();
    expect(snapshot.running).toEqual([]);
    expect(snapshot.retrying).toEqual([
      expect.objectContaining({
        issue_id: "1",
        issue_identifier: "ISSUE-1",
        attempt: 1,
        error: null,
      }),
    ]);
  });

  it("cleans up unconfirmed emergency-stop process trees during journal hydration", async () => {
    const tracker = createTracker({
      candidates: [createIssue({ state: "Resume" })],
      stateSnapshots: [{ id: "1", identifier: "ISSUE-1", state: "Resume" }],
    });
    const fakeRunner = new FakeAgentRunner();
    const terminateDetachedPidTree = vi.fn(async () => ({
      pid: 1001,
      sigtermSent: true,
      sigkillSent: true,
    }));
    const codexAppServerIdentity = createProcessIdentity(1001, {
      sessionId: 0,
      launchToken: null,
    });
    const writtenEntries: DispatcherRunJournalEntry[] = [];
    const journal: DispatcherRunJournal = [
      {
        sequence: 1,
        idempotencyKey: "hard_stop:1:implement:initial:emergency_stop:1",
        timestamp: "2026-03-05T23:59:00.000Z",
        kind: "hard_stop_trigger",
        issueId: "1",
        issueIdentifier: "ISSUE-1",
        operation: "dispatcher",
        stage: "implement",
        attempt: null,
        ownerId: "previous-runtime",
        lease: null,
        summary: "Prior emergency stop completed.",
        metadata: {
          status: "completed",
          reason: "emergency_stop",
          issueState: "Todo",
        },
      },
      {
        sequence: 2,
        idempotencyKey: "intent:pipeline_stop:operator@pro14:seq-0",
        timestamp: "2026-03-06T00:00:00.000Z",
        kind: "intent",
        issueId: "__pipeline__",
        issueIdentifier: "PIPELINE",
        operation: "dispatcher",
        stage: null,
        attempt: null,
        ownerId: "previous-runtime",
        lease: null,
        summary: "Emergency stop applied.",
        metadata: {
          status: "applied",
          verb: "pipeline_stop",
          actor: { kind: "operator", host: "pro14", session: null },
          reason: { class: "operator_emergency_stop", human: "stop now" },
          interruptedIssues: [
            {
              issueId: "1",
              issueIdentifier: "ISSUE-1",
              stage: "implement",
              attempt: null,
              codexAppServerPid: "1001",
              codexAppServerIdentity,
            },
          ],
        },
      },
      {
        sequence: 3,
        idempotencyKey: "intent:pipeline_resume:operator@pro14:seq-1",
        timestamp: "2026-03-06T00:01:00.000Z",
        kind: "intent",
        issueId: "__pipeline__",
        issueIdentifier: "PIPELINE",
        operation: "dispatcher",
        stage: null,
        attempt: null,
        ownerId: "previous-runtime",
        lease: null,
        summary: "Emergency stop resumed.",
        metadata: {
          status: "applied",
          verb: "pipeline_resume",
          actor: { kind: "operator", host: "pro14", session: null },
          reason: { class: "operator_resume", human: "triaged" },
        },
      },
    ];
    const host = new OrchestratorRuntimeHost({
      config: createConfig(),
      tracker,
      createAgentRunner: ({ onEvent }) => {
        fakeRunner.onEvent = onEvent;
        return fakeRunner;
      },
      readDispatcherRunJournal: async () => journal,
      writeDispatcherRunJournalEntry: async (_workspaceRoot, entry) => {
        writtenEntries.push(entry);
      },
      terminateDetachedPidTree,
      now: () => new Date("2026-03-06T00:02:00.000Z"),
    });

    const tick = await host.pollOnce();

    expect(terminateDetachedPidTree).toHaveBeenCalledWith(1001, {
      graceMs: 1_000,
      expectedIdentity: codexAppServerIdentity,
    });
    expect(tick.dispatchedIssueIds).toEqual(["1"]);
    expect(fakeRunner.runInputs).toHaveLength(1);
    expect(host.getState().resumeRequired.has("1")).toBe(false);
    expect(writtenEntries).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: "hard_stop_trigger",
          issueId: "1",
          metadata: expect.objectContaining({
            status: "completed",
            reason: "emergency_stop",
            recovery: "journal_hydration",
            sourceSequence: 2,
            codexAppServerPid: "1001",
            codexAppServerIdentity,
          }),
        }),
      ]),
    );

    fakeRunner.resolve("1", createNormalResult());
    await host.waitForIdle();
  });

  it("surfaces redacted emergency-stop cleanup proof in runtime and pipeline status", async () => {
    const tracker = createTracker({
      candidates: [],
      stateSnapshots: [{ id: "1", identifier: "ISSUE-1", state: "Resume" }],
    });
    const codexAppServerIdentity = createProcessIdentity(1001);
    const writtenEntries: DispatcherRunJournalEntry[] = [];
    const journal: DispatcherRunJournal = [
      createPipelineStopJournalEntry(1, "1001", codexAppServerIdentity),
    ];
    const host = new OrchestratorRuntimeHost({
      config: createConfig(),
      tracker,
      agentRunner: new FakeAgentRunner(),
      readDispatcherRunJournal: async () => journal,
      writeDispatcherRunJournalEntry: async (_workspaceRoot, entry) => {
        writtenEntries.push(entry);
      },
      terminateDetachedPidTree: async () =>
        createProcessTreeTerminationResult({
          pid: 1001,
          processGroupId: 1001,
        }),
      now: () => new Date("2026-03-06T00:02:00.000Z"),
    });

    const snapshot = await host.getRuntimeSnapshot();
    const status = await host.getPipelineStatus();

    const expectedInterruptedIssue = expect.objectContaining({
      issue_id: "1",
      issue_identifier: "ISSUE-1",
      codex_app_server_pid: "1001",
      identity_status: "present",
      cleanup_status: "confirmed",
      process_identity: {
        pid: 1001,
        process_group_id: 1001,
        session_id: 1001,
        started_at: "linux-starttime:123456",
        command_present: true,
        launch_token_present: true,
      },
    });
    expect(snapshot.emergency_stop?.interrupted_issues).toEqual([
      expectedInterruptedIssue,
    ]);
    expect(status.emergency_stop?.interrupted_issues).toEqual([
      expectedInterruptedIssue,
    ]);
    expect(
      snapshot.emergency_stop?.interrupted_issues[0]?.process_identity,
    ).not.toHaveProperty("command");
    expect(
      snapshot.emergency_stop?.interrupted_issues[0]?.process_identity,
    ).not.toHaveProperty("launch_token");
    expect(writtenEntries).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: "hard_stop_trigger",
          metadata: expect.objectContaining({
            recovery: "journal_hydration",
            sourceSequence: 1,
          }),
        }),
      ]),
    );
  });

  it("does not let later same-issue emergency-stop proof suppress older recovered cleanup", async () => {
    const tracker = createTracker({
      candidates: [createIssue({ state: "Resume" })],
      stateSnapshots: [{ id: "1", identifier: "ISSUE-1", state: "Resume" }],
    });
    const fakeRunner = new FakeAgentRunner();
    const terminateDetachedPidTree = vi.fn(async (pid: number) => ({
      pid,
      sigtermSent: true,
      sigkillSent: true,
    }));
    const writtenEntries: DispatcherRunJournalEntry[] = [];
    const journal: DispatcherRunJournal = [
      createPipelineStopJournalEntry(1, "1001"),
      createPipelineResumeJournalEntry(2),
      createPipelineStopJournalEntry(3, "2002"),
      createEmergencyStopHardStopJournalEntry(4, {
        codexAppServerPid: "2002",
        codexAppServerIdentity: createProcessIdentity(2002),
        sourceSequence: 3,
      }),
      createPipelineResumeJournalEntry(5),
    ];
    const host = new OrchestratorRuntimeHost({
      config: createConfig(),
      tracker,
      createAgentRunner: ({ onEvent }) => {
        fakeRunner.onEvent = onEvent;
        return fakeRunner;
      },
      readDispatcherRunJournal: async () => journal,
      writeDispatcherRunJournalEntry: async (_workspaceRoot, entry) => {
        writtenEntries.push(entry);
      },
      terminateDetachedPidTree,
      now: () => new Date("2026-03-06T00:02:00.000Z"),
    });

    const tick = await host.pollOnce();

    expect(terminateDetachedPidTree).toHaveBeenCalledTimes(1);
    expect(terminateDetachedPidTree).toHaveBeenCalledWith(1001, {
      graceMs: 1_000,
      expectedIdentity: createProcessIdentity(1001),
    });
    expect(terminateDetachedPidTree).not.toHaveBeenCalledWith(
      2002,
      expect.anything(),
    );
    expect(tick.dispatchedIssueIds).toEqual(["1"]);
    expect(fakeRunner.runInputs).toHaveLength(1);
    expect(host.getState().resumeRequired.has("1")).toBe(false);
    expect(writtenEntries).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: "hard_stop_trigger",
          issueId: "1",
          metadata: expect.objectContaining({
            status: "completed",
            reason: "emergency_stop",
            recovery: "journal_hydration",
            sourceSequence: 1,
            codexAppServerPid: "1001",
            codexAppServerIdentity: createProcessIdentity(1001),
          }),
        }),
      ]),
    );

    fakeRunner.resolve("1", createNormalResult());
    await host.waitForIdle();
  });

  it.each([
    { label: "missing", codexAppServerPid: null },
    { label: "malformed", codexAppServerPid: "not-a-pid" },
    { label: "self", codexAppServerPid: String(process.pid) },
  ])(
    "keeps recovered emergency-stop cleanup fail-closed for $label app-server PID",
    async ({ codexAppServerPid }) => {
      const tracker = createTracker({
        candidates: [createIssue({ state: "Resume" })],
        stateSnapshots: [{ id: "1", identifier: "ISSUE-1", state: "Resume" }],
      });
      const fakeRunner = new FakeAgentRunner();
      const terminateDetachedPidTree = vi.fn(async (pid: number) => ({
        pid,
        sigtermSent: true,
        sigkillSent: true,
      }));
      const writtenEntries: DispatcherRunJournalEntry[] = [];
      const journal: DispatcherRunJournal = [
        createPipelineStopJournalEntry(1, codexAppServerPid),
        createPipelineResumeJournalEntry(2),
      ];
      const host = new OrchestratorRuntimeHost({
        config: createConfig(),
        tracker,
        createAgentRunner: ({ onEvent }) => {
          fakeRunner.onEvent = onEvent;
          return fakeRunner;
        },
        readDispatcherRunJournal: async () => journal,
        writeDispatcherRunJournalEntry: async (_workspaceRoot, entry) => {
          writtenEntries.push(entry);
        },
        terminateDetachedPidTree,
        now: () => new Date("2026-03-06T00:02:00.000Z"),
      });

      const tick = await host.pollOnce();

      expect(terminateDetachedPidTree).not.toHaveBeenCalled();
      expect(tick.dispatchedIssueIds).toEqual([]);
      expect(fakeRunner.runInputs).toHaveLength(0);
      expect(host.getState().resumeRequired.has("1")).toBe(true);
      expect(host.getState().resumeRequiredMarks["1"]).toMatchObject({
        reason: "killed_mid_run_unconfirmed",
        setBySequence: 1,
      });
      expect(
        writtenEntries.some(
          (entry) =>
            entry.kind === "hard_stop_trigger" &&
            entry.metadata.reason === "emergency_stop" &&
            entry.metadata.recovery === "journal_hydration",
        ),
      ).toBe(false);
    },
  );

  it("keeps recovered emergency-stop cleanup fail-closed when process identity no longer matches", async () => {
    const tracker = createTracker({
      candidates: [createIssue({ state: "Resume" })],
      stateSnapshots: [{ id: "1", identifier: "ISSUE-1", state: "Resume" }],
    });
    const fakeRunner = new FakeAgentRunner();
    const terminateDetachedPidTree = vi.fn(async () => ({
      pid: 1001,
      sigtermSent: false,
      sigkillSent: false,
    }));
    const writtenEntries: DispatcherRunJournalEntry[] = [];
    const journal: DispatcherRunJournal = [
      createPipelineStopJournalEntry(1, "1001", createProcessIdentity(1001)),
      createPipelineResumeJournalEntry(2),
    ];
    const host = new OrchestratorRuntimeHost({
      config: createConfig(),
      tracker,
      createAgentRunner: ({ onEvent }) => {
        fakeRunner.onEvent = onEvent;
        return fakeRunner;
      },
      readDispatcherRunJournal: async () => journal,
      writeDispatcherRunJournalEntry: async (_workspaceRoot, entry) => {
        writtenEntries.push(entry);
      },
      terminateDetachedPidTree,
      now: () => new Date("2026-03-06T00:02:00.000Z"),
    });

    const tick = await host.pollOnce();

    expect(terminateDetachedPidTree).toHaveBeenCalledWith(
      1001,
      expect.objectContaining({
        expectedIdentity: createProcessIdentity(1001),
      }),
    );
    expect(tick.dispatchedIssueIds).toEqual([]);
    expect(fakeRunner.runInputs).toHaveLength(0);
    expect(host.getState().resumeRequired.has("1")).toBe(true);
    expect(host.getState().resumeRequiredMarks["1"]).toMatchObject({
      reason: "killed_mid_run_unconfirmed",
      setBySequence: 1,
    });
    expect(
      writtenEntries.some(
        (entry) =>
          entry.kind === "hard_stop_trigger" &&
          entry.metadata.reason === "emergency_stop" &&
          entry.metadata.recovery === "journal_hydration",
      ),
    ).toBe(false);
  });

  it("keeps recovered emergency-stop cleanup fail-closed when SIGKILL is not confirmed", async () => {
    const tracker = createTracker({
      candidates: [createIssue({ state: "Resume" })],
      stateSnapshots: [{ id: "1", identifier: "ISSUE-1", state: "Resume" }],
    });
    const fakeRunner = new FakeAgentRunner();
    const terminateDetachedPidTree = vi.fn(async () => ({
      pid: 1001,
      sigtermSent: true,
      sigkillSent: false,
    }));
    const writtenEntries: DispatcherRunJournalEntry[] = [];
    const journal: DispatcherRunJournal = [
      createPipelineStopJournalEntry(1, "1001", createProcessIdentity(1001)),
      createPipelineResumeJournalEntry(2),
    ];
    const host = new OrchestratorRuntimeHost({
      config: createConfig(),
      tracker,
      createAgentRunner: ({ onEvent }) => {
        fakeRunner.onEvent = onEvent;
        return fakeRunner;
      },
      readDispatcherRunJournal: async () => journal,
      writeDispatcherRunJournalEntry: async (_workspaceRoot, entry) => {
        writtenEntries.push(entry);
      },
      terminateDetachedPidTree,
      now: () => new Date("2026-03-06T00:02:00.000Z"),
    });

    const tick = await host.pollOnce();

    expect(terminateDetachedPidTree).toHaveBeenCalledWith(
      1001,
      expect.objectContaining({
        expectedIdentity: createProcessIdentity(1001),
      }),
    );
    expect(tick.dispatchedIssueIds).toEqual([]);
    expect(fakeRunner.runInputs).toHaveLength(0);
    expect(host.getState().resumeRequired.has("1")).toBe(true);
    expect(host.getState().resumeRequiredMarks["1"]).toMatchObject({
      reason: "killed_mid_run_unconfirmed",
      setBySequence: 1,
    });
    expect(
      writtenEntries.some(
        (entry) =>
          entry.kind === "hard_stop_trigger" &&
          entry.metadata.reason === "emergency_stop" &&
          entry.metadata.recovery === "journal_hydration",
      ),
    ).toBe(false);
  });

  it("keeps recovered emergency-stop cleanup fail-closed when detailed SIGKILL delivery failed", async () => {
    const tracker = createTracker({
      candidates: [createIssue({ state: "Resume" })],
      stateSnapshots: [{ id: "1", identifier: "ISSUE-1", state: "Resume" }],
    });
    const fakeRunner = new FakeAgentRunner();
    const entries: StructuredLogEntry[] = [];
    const logger = new StructuredLogger([
      {
        write(entry) {
          entries.push(entry);
        },
      },
    ]);
    const terminateDetachedPidTree = vi.fn(async () =>
      createProcessTreeTerminationResult({
        pid: 1001,
        sigkillStatus: "failed",
        // Proves rich SIGKILL status wins over legacy booleans.
        sigkillSent: true,
      }),
    );
    const writtenEntries: DispatcherRunJournalEntry[] = [];
    const journal: DispatcherRunJournal = [
      createPipelineStopJournalEntry(1, "1001", createProcessIdentity(1001)),
      createPipelineResumeJournalEntry(2),
    ];
    const host = new OrchestratorRuntimeHost({
      config: createConfig(),
      tracker,
      logger,
      createAgentRunner: ({ onEvent }) => {
        fakeRunner.onEvent = onEvent;
        return fakeRunner;
      },
      readDispatcherRunJournal: async () => journal,
      writeDispatcherRunJournalEntry: async (_workspaceRoot, entry) => {
        writtenEntries.push(entry);
      },
      listWorkspaceCwdProcessIds: async () => [],
      terminateDetachedPidTree,
      now: () => new Date("2026-03-06T00:02:00.000Z"),
    });

    const tick = await host.pollOnce();

    expect(terminateDetachedPidTree).toHaveBeenCalledWith(
      1001,
      expect.objectContaining({
        expectedIdentity: createProcessIdentity(1001),
      }),
    );
    expect(tick.dispatchedIssueIds).toEqual([]);
    expect(fakeRunner.runInputs).toHaveLength(0);
    expect(host.getState().resumeRequired.has("1")).toBe(true);
    expect(host.getState().resumeRequiredMarks["1"]).toMatchObject({
      reason: "killed_mid_run_unconfirmed",
      setBySequence: 1,
    });
    expect(
      writtenEntries.some(
        (entry) =>
          entry.kind === "hard_stop_trigger" &&
          entry.metadata.reason === "emergency_stop" &&
          entry.metadata.recovery === "journal_hydration",
      ),
    ).toBe(false);
    expect(entries).toContainEqual(
      expect.objectContaining({
        event: "emergency_stop_recovery_cleanup_unconfirmed",
        outcome: "degraded",
        issue_identifier: "ISSUE-1",
        process_tree_cleanup_confirmed: false,
        process_tree_sigkill_status: "failed",
      }),
    );
  });

  it("logs confirmed and degraded workspace-cwd orphan cleanup outcomes during emergency-stop recovery", async () => {
    const tracker = createTracker({
      candidates: [createIssue({ state: "Resume" })],
      stateSnapshots: [{ id: "1", identifier: "ISSUE-1", state: "Resume" }],
    });
    const fakeRunner = new FakeAgentRunner();
    const entries: StructuredLogEntry[] = [];
    const logger = new StructuredLogger([
      {
        write(entry) {
          entries.push(entry);
        },
      },
    ]);
    const listWorkspaceCwdProcessIds = vi.fn(async () => [3003, 4004]);
    const readProcessIdentity = vi.fn(async (pid: number) =>
      pid === 4004
        ? createProcessIdentity(4004, { processGroupId: 5005 })
        : createProcessIdentity(pid),
    );
    const terminateDetachedPidTree = vi.fn(async (pid: number) =>
      createProcessTreeTerminationResult({
        pid,
      }),
    );
    const terminateDetachedProcessGroupTree = vi.fn(
      async (processGroupId: number) =>
        createProcessTreeTerminationResult({
          pid: null,
          processGroupId,
          sigkillStatus: "failed",
        }),
    );
    const writtenEntries: DispatcherRunJournalEntry[] = [];
    const journal: DispatcherRunJournal = [
      createPipelineStopJournalEntry(1, "1001", createProcessIdentity(1001)),
      createPipelineResumeJournalEntry(2),
    ];
    const host = new OrchestratorRuntimeHost({
      config: createConfig(),
      tracker,
      logger,
      createAgentRunner: ({ onEvent }) => {
        fakeRunner.onEvent = onEvent;
        return fakeRunner;
      },
      readDispatcherRunJournal: async () => journal,
      writeDispatcherRunJournalEntry: async (_workspaceRoot, entry) => {
        writtenEntries.push(entry);
      },
      listWorkspaceCwdProcessIds,
      readProcessIdentity,
      terminateDetachedPidTree,
      terminateDetachedProcessGroupTree,
      now: () => new Date("2026-03-06T00:02:00.000Z"),
    });

    const tick = await host.pollOnce();

    expect(listWorkspaceCwdProcessIds).toHaveBeenCalledTimes(1);
    expect(listWorkspaceCwdProcessIds).toHaveBeenCalledWith(
      "/tmp/workspaces/1",
      expect.objectContaining({
        onSkippedRecheck: expect.any(Function),
      }),
    );
    expect(terminateDetachedPidTree).toHaveBeenCalledWith(1001, {
      graceMs: 1_000,
      expectedIdentity: createProcessIdentity(1001),
    });
    expect(terminateDetachedPidTree).toHaveBeenCalledWith(3003, {
      graceMs: 1_000,
      expectedIdentity: createProcessIdentity(3003),
    });
    expect(terminateDetachedProcessGroupTree).toHaveBeenCalledWith(5005, {
      graceMs: 1_000,
    });
    expect(tick.dispatchedIssueIds).toEqual(["1"]);
    expect(host.getState().resumeRequired.has("1")).toBe(false);
    expect(writtenEntries).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: "hard_stop_trigger",
          issueId: "1",
          metadata: expect.objectContaining({
            status: "completed",
            reason: "emergency_stop",
            recovery: "journal_hydration",
            sourceSequence: 1,
          }),
        }),
      ]),
    );
    expect(entries).toContainEqual(
      expect.objectContaining({
        event: "orphaned_processes_killed",
        issue_identifier: "ISSUE-1",
        pids: ["3003"],
      }),
    );
    expect(entries).toContainEqual(
      expect.objectContaining({
        event: "orphaned_process_cleanup_degraded",
        outcome: "degraded",
        issue_identifier: "ISSUE-1",
        pids: ["4004"],
      }),
    );

    fakeRunner.resolve("1", createNormalResult());
    await host.waitForIdle();
  });

  it("logs bounded workspace-cwd recheck skips during emergency-stop recovery", async () => {
    const tracker = createTracker({
      candidates: [createIssue({ state: "Resume" })],
      stateSnapshots: [{ id: "1", identifier: "ISSUE-1", state: "Resume" }],
    });
    const fakeRunner = new FakeAgentRunner();
    const entries: StructuredLogEntry[] = [];
    const logger = new StructuredLogger([
      {
        write(entry) {
          entries.push(entry);
        },
      },
    ]);
    const writtenEntries: DispatcherRunJournalEntry[] = [];
    const terminateDetachedPidTree = vi.fn(async (pid: number) =>
      createProcessTreeTerminationResult({ pid }),
    );
    const listWorkspaceCwdProcessIds = vi.fn(
      async (
        _workspacePath: string,
        options?: {
          onSkippedRecheck?: (skip: {
            pid: number;
            discoveredCwdPath: string;
            currentCwdPath: string | null;
            reason:
              | "current_cwd_unavailable"
              | "current_cwd_timed_out"
              | "current_cwd_outside_workspace";
          }) => void | Promise<void>;
        },
      ) => {
        for (let pid = 3000; pid < 3025; pid += 1) {
          options?.onSkippedRecheck?.({
            pid,
            discoveredCwdPath: `/tmp/workspaces/1/process-${pid}`,
            currentCwdPath: null,
            reason: "current_cwd_unavailable",
          });
        }
        return [];
      },
    );
    const journal: DispatcherRunJournal = [
      createPipelineStopJournalEntry(1, "1001", createProcessIdentity(1001)),
      createPipelineResumeJournalEntry(2),
    ];
    const host = new OrchestratorRuntimeHost({
      config: createConfig(),
      tracker,
      logger,
      createAgentRunner: ({ onEvent }) => {
        fakeRunner.onEvent = onEvent;
        return fakeRunner;
      },
      readDispatcherRunJournal: async () => journal,
      writeDispatcherRunJournalEntry: async (_workspaceRoot, entry) => {
        writtenEntries.push(entry);
      },
      listWorkspaceCwdProcessIds,
      terminateDetachedPidTree,
      now: () => new Date("2026-03-06T00:02:00.000Z"),
    });

    await host.pollOnce();

    expect(entries).toContainEqual(
      expect.objectContaining({
        event: "workspace_cwd_recheck_skipped",
        outcome: "degraded",
        issue_identifier: "ISSUE-1",
        workspace_path: "/tmp/workspaces/1",
        discovery: "workspace_cwd",
        skipped_count: 25,
        truncated: true,
        skipped_rechecks: expect.arrayContaining([
          expect.objectContaining({
            pid: 3000,
            reason: "current_cwd_unavailable",
            discovered_cwd_path: "/tmp/workspaces/1/process-3000",
            current_cwd_path: null,
          }),
        ]),
      }),
    );
    const logEntry = entries.find(
      (entry) => entry.event === "workspace_cwd_recheck_skipped",
    );
    expect(logEntry?.skipped_rechecks).toHaveLength(20);
    expect(terminateDetachedPidTree).toHaveBeenCalledWith(1001, {
      graceMs: 1_000,
      expectedIdentity: createProcessIdentity(1001),
    });
    expect(writtenEntries).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: "hard_stop_trigger",
          issueId: "1",
          metadata: expect.objectContaining({
            status: "completed",
            reason: "emergency_stop",
            recovery: "journal_hydration",
            sourceSequence: 1,
          }),
        }),
      ]),
    );

    await vi.waitFor(() => {
      expect(fakeRunner.runs.has("1")).toBe(true);
    });
    fakeRunner.resolve("1", createNormalResult());
    await host.waitForIdle();
  });

  it("sweeps workspace-cwd orphan groups during cold-start hydration without an emergency-stop journal", async () => {
    const tracker = createTracker({ candidates: [] });
    const fakeRunner = new FakeAgentRunner();
    const listWorkspaceCwdProcessIds = vi.fn(async () => [4004]);
    const readProcessIdentity = vi.fn(async () =>
      createProcessIdentity(4004, { processGroupId: 5005 }),
    );
    const terminateDetachedPidTree = vi.fn(async (pid: number) =>
      createProcessTreeTerminationResult({ pid }),
    );
    const terminateDetachedProcessGroupTree = vi.fn(
      async (processGroupId: number) =>
        createProcessTreeTerminationResult({ pid: null, processGroupId }),
    );
    const journal: DispatcherRunJournal = [
      createRuntimeJournalEntry({
        sequence: 1,
        kind: "admission",
        issueId: "1",
        issueIdentifier: "ISSUE-1",
        summary: "Prior dispatcher admission started.",
        lease: {
          leaseId: "dispatcher:1:implement:initial",
          issueId: "1",
          issueIdentifier: "ISSUE-1",
          operation: "dispatcher",
          ownerId: "previous-runtime",
          status: "active",
          acquiredAt: "2026-03-06T00:00:00.000Z",
          expiresAt: "2026-03-06T00:10:00.000Z",
          completedAt: null,
          stage: "implement",
          attempt: null,
          lastJournalSequence: 1,
        },
        metadata: { status: "started" },
      }),
    ];
    const host = new OrchestratorRuntimeHost({
      config: createConfig(),
      tracker,
      createAgentRunner: ({ onEvent }) => {
        fakeRunner.onEvent = onEvent;
        return fakeRunner;
      },
      readDispatcherRunJournal: async () => journal,
      listWorkspaceCwdProcessIds,
      readProcessIdentity,
      terminateDetachedPidTree,
      terminateDetachedProcessGroupTree,
      now: () => new Date("2026-03-06T00:02:00.000Z"),
    });

    const tick = await host.pollOnce();

    expect(tick.dispatchedIssueIds).toEqual([]);
    expect(fakeRunner.runInputs).toHaveLength(0);
    expect(listWorkspaceCwdProcessIds).toHaveBeenCalledTimes(1);
    expect(listWorkspaceCwdProcessIds).toHaveBeenCalledWith(
      "/tmp/workspaces/1",
      expect.objectContaining({
        onSkippedRecheck: expect.any(Function),
      }),
    );
    expect(readProcessIdentity).toHaveBeenCalledWith(4004);
    expect(terminateDetachedPidTree).not.toHaveBeenCalled();
    expect(terminateDetachedProcessGroupTree).toHaveBeenCalledWith(5005, {
      graceMs: 1_000,
    });
  });

  it.each([
    {
      events: 30,
      retainedEntries: 30,
      responseStart: 6,
      retentionTruncated: false,
    },
    {
      events: 200,
      retainedEntries: 200,
      responseStart: 176,
      retentionTruncated: false,
    },
    {
      events: 205,
      retainedEntries: 200,
      responseStart: 181,
      retentionTruncated: true,
    },
  ])(
    "exposes token telemetry response, retained, and observed counts for $events events",
    async ({ events, retainedEntries, responseStart, retentionTruncated }) => {
      const tracker = createTracker();
      const fakeRunner = new FakeAgentRunner();
      const host = new OrchestratorRuntimeHost({
        config: createConfig(),
        tracker,
        createAgentRunner: ({ onEvent }) => {
          fakeRunner.onEvent = onEvent;
          return fakeRunner;
        },
        now: () => new Date("2026-03-06T00:00:05.000Z"),
      });

      await host.pollOnce();

      for (let index = 1; index <= events; index += 1) {
        fakeRunner.emit("1", {
          event: "notification",
          timestamp: `2026-03-06T00:${String(Math.floor(index / 60)).padStart(2, "0")}:${String(index % 60).padStart(2, "0")}.000Z`,
          codexAppServerPid: "1001",
          sessionId: "thread-1-turn-1",
          threadId: "thread-1",
          turnId: "turn-1",
          usage: {
            inputTokens: index,
            outputTokens: index,
            totalTokens: index * 2,
          },
        });
      }
      await host.flushEvents();

      const details = await host.getIssueDetails("ISSUE-1");
      expect(details?.running?.token_telemetry).toHaveLength(25);
      expect(details?.running?.token_telemetry_total_entries).toBe(events);
      expect(details?.running?.token_telemetry_observed_entries).toBe(events);
      expect(details?.running?.token_telemetry_retained_entries).toBe(
        retainedEntries,
      );
      expect(details?.running?.token_telemetry_truncated).toBe(true);
      expect(details?.running?.token_telemetry_retention_truncated).toBe(
        retentionTruncated,
      );
      expect(details?.running?.token_telemetry[0]?.input_tokens).toBe(
        responseStart,
      );
      expect(details?.running?.token_telemetry.at(-1)?.input_tokens).toBe(
        events,
      );

      fakeRunner.resolve("1", createNormalResult());
      await host.waitForIdle();
    },
  );

  it("cancels a reconciled worker and releases the claim when the issue is no longer eligible on retry", async () => {
    const workspaceRoot = mkdtempSync(join(tmpdir(), "symph-loop-retry-"));
    try {
      const config = createConfig();
      config.workspace.root = workspaceRoot;
      const tracker = createTracker();
      const fakeRunner = new FakeAgentRunner();
      const host = new OrchestratorRuntimeHost({
        config,
        tracker,
        createAgentRunner: ({ onEvent }) => {
          fakeRunner.onEvent = onEvent;
          return fakeRunner;
        },
        deliverWorkerStopSignal: async (
          input,
        ): Promise<StopSignalDelivery> => ({
          status: "not_attempted",
          reason: input.reason,
          attemptedAt: input.attemptedAt.toISOString(),
          workspacePath: input.workspacePath,
          attempts: [],
          warning: null,
        }),
        now: () => new Date("2026-03-06T00:00:05.000Z"),
      });

      await host.pollOnce();
      tracker.setStateSnapshots([
        { id: "1", identifier: "ISSUE-1", state: "Done" },
      ]);

      const reconcileTick = await host.pollOnce();
      expect(reconcileTick.stopRequests).toEqual([
        {
          issueId: "1",
          issueIdentifier: "ISSUE-1",
          cleanupWorkspace: true,
          reason: "terminal_state",
          signalDelivery: {
            status: "not_attempted",
            reason: "terminal_state",
            attemptedAt: "2026-03-06T00:00:05.000Z",
            workspacePath: join(workspaceRoot, "1"),
            attempts: [],
            warning: null,
          },
        },
      ]);
      await host.waitForIdle();

      expect(fakeRunner.abortReasons).toEqual([
        "Stopped due to terminal_state.",
      ]);
      expect(Object.keys(host.getState().retryAttempts)).toEqual(["1"]);

      tracker.setCandidates([]);
      // SYMPH-775: a single absent fetch is re-deferred (possible stale
      // snapshot); the genuinely-departed issue releases on the second.
      const deferResult = await host.runRetryTimer("1");
      expect(deferResult.released).toBe(false);

      const retryResult = await host.runRetryTimer("1");

      expect(retryResult).toEqual({
        dispatched: false,
        released: true,
        retryEntry: null,
      });
      await host.flushEvents();
      expect([...host.getState().claimed]).toEqual([]);
      expect(host.getState().loopTraceJournal["1"]).toBeUndefined();

      const details = await host.getIssueDetails("ISSUE-1");

      expect(details).toMatchObject({
        issue_identifier: "ISSUE-1",
        issue_id: "1",
        status: "failed",
      });
      expect(details!.loop_trace_journal.entries.at(-1)).toMatchObject({
        kind: "stage_transition",
        stage_transition: {
          status: "failed",
        },
      });
    } finally {
      rmSync(workspaceRoot, { recursive: true, force: true });
    }
  });

  it("plumbs the budget-escalation multiplier through to the agent runner", async () => {
    const tracker = createTracker();
    const fakeRunner = new FakeAgentRunner();
    const host = new OrchestratorRuntimeHost({
      config: createConfig(),
      tracker,
      createAgentRunner: ({ onEvent }) => {
        fakeRunner.onEvent = onEvent;
        return fakeRunner;
      },
      now: () => new Date("2026-03-06T00:00:05.000Z"),
    });

    // Seed one consumed escalation step before the first dispatch.
    host.getState().issueBudgetEscalations["1"] = 1;
    await host.pollOnce();

    expect(fakeRunner.runInputs).toHaveLength(1);
    expect(fakeRunner.runInputs[0]?.budgetMultiplier).toBe(2);
    expect(fakeRunner.runInputs[0]?.modePolicy?.maxBudgetUsd).toBeDefined();
  });

  it("passes spec-review comment deltas into implementation workers", async () => {
    const tracker = createLinearTrackerForPipelineStatus();
    vi.spyOn(tracker, "fetchCandidateIssues").mockResolvedValue([
      createIssue(),
    ]);
    vi.spyOn(tracker, "fetchIssuesByStates").mockResolvedValue([]);
    vi.spyOn(tracker, "fetchIssueStatesByIds").mockResolvedValue([
      { id: "1", identifier: "ISSUE-1", state: "In Progress" },
    ]);
    vi.spyOn(tracker, "fetchIssueComments").mockResolvedValue([
      {
        id: "comment-post-cutoff",
        body: "Operator changed the exact implementation requirement.",
        createdAt: "2026-03-06T00:05:00.000Z",
        updatedAt: "2026-03-06T00:05:00.000Z",
        user: {
          kind: "user",
          id: "user-operator",
          name: "Eric",
          displayName: "Eric",
          email: "eric@example.com",
          botType: null,
          botSubType: null,
        },
        botActor: null,
      },
      {
        id: "comment-carried-forward",
        body: "Keep this older nuance in the implementation.",
        createdAt: "2026-03-06T00:01:00.000Z",
        updatedAt: "2026-03-06T00:01:00.000Z",
        user: null,
        botActor: {
          kind: "bot",
          id: "bot-reviewer",
          name: "Spec Reviewer",
          displayName: "Spec Reviewer",
          email: null,
          botType: "app",
          botSubType: "automation",
        },
      },
      {
        id: "comment-uncited-a",
        body: "This older human comment was missed.",
        createdAt: "2026-03-06T00:02:00.000Z",
        updatedAt: "2026-03-06T00:02:00.000Z",
        user: {
          kind: "user",
          id: "unknown-human",
          name: "Reviewer",
          displayName: "Reviewer",
          email: "reviewer@example.com",
          botType: null,
          botSubType: null,
        },
        botActor: null,
      },
      {
        id: "comment-uncited-b",
        body: "This older operator comment was also missed.",
        createdAt: "2026-03-06T00:02:30.000Z",
        updatedAt: "2026-03-06T00:02:30.000Z",
        user: {
          kind: "user",
          id: "user-operator",
          name: "Eric",
          displayName: "Eric",
          email: "eric@example.com",
          botType: null,
          botSubType: null,
        },
        botActor: null,
      },
    ]);
    const fakeRunner = new FakeAgentRunner();
    const host = new OrchestratorRuntimeHost({
      config: createStagedConfig({
        stages: {
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
              transitions: {
                onComplete: null,
                onApprove: null,
                onRework: null,
              },
              linearState: null,
            },
          },
        },
      }),
      tracker,
      createAgentRunner: ({ onEvent }) => {
        fakeRunner.onEvent = onEvent;
        return fakeRunner;
      },
      readDispatcherRunJournal: async () => [
        createRuntimeJournalEntry({
          sequence: 1,
          kind: "spec_review_result",
          timestamp: "2026-03-06T00:03:00.000Z",
          metadata: {
            readiness_state: "valid",
            source_intent_hash: "source-hash",
            completed_at: "2026-03-06T00:03:00.000Z",
            comment_dispositions: [
              {
                id: "comment-carried-forward",
                disposition: "carried_forward",
                rationale: "Still required.",
              },
              {
                id: "comment-uncited-a",
                disposition: "uncited",
                rationale: "Not covered by the body.",
              },
              {
                id: "comment-uncited-b",
                disposition: "uncited",
                rationale: "Not covered by the body.",
              },
            ],
          },
        }),
      ],
      now: () => new Date("2026-03-06T00:04:00.000Z"),
    });

    await host.pollOnce();

    expect(fakeRunner.runInputs).toHaveLength(1);
    expect(fakeRunner.runInputs[0]?.implementationCommentDeltas).toEqual({
      sourceIntentHash: "source-hash",
      cutoff: "2026-03-06T00:03:00.000Z",
      requiresOperatorContext: true,
      operatorContextReason:
        "Uncited comments at or before the spec-review cutoff require operator reconciliation: comment-uncited-a (unknown), comment-uncited-b (unknown).",
      comments: [
        expect.objectContaining({
          id: "comment-post-cutoff",
          disposition: "post_cutoff",
          effectiveAt: "2026-03-06T00:05:00.000Z",
          body: "Operator changed the exact implementation requirement.",
        }),
        expect.objectContaining({
          id: "comment-carried-forward",
          disposition: "carried_forward",
          effectiveAt: "2026-03-06T00:01:00.000Z",
          body: "Keep this older nuance in the implementation.",
        }),
      ],
    });
  });

  it("passes latest workpad context into investigate retry workers", async () => {
    const tracker = createLinearTrackerForPipelineStatus();
    vi.spyOn(tracker, "fetchCandidateIssues").mockResolvedValue([
      createIssue({ state: "In Progress" }),
    ]);
    vi.spyOn(tracker, "fetchIssuesByStates").mockResolvedValue([]);
    vi.spyOn(tracker, "fetchIssueStatesByIds").mockResolvedValue([
      { id: "1", identifier: "ISSUE-1", state: "In Progress" },
    ]);
    vi.spyOn(tracker, "fetchIssueComments").mockResolvedValue([
      {
        id: "workpad-old",
        body: "## Workpad\n\nOlder plan.",
        createdAt: "2026-03-06T00:01:00.000Z",
        updatedAt: "2026-03-06T00:01:00.000Z",
        user: null,
        botActor: null,
      },
      {
        id: "not-workpad",
        body: "A regular issue comment.",
        createdAt: "2026-03-06T00:03:00.000Z",
        updatedAt: "2026-03-06T00:03:00.000Z",
        user: null,
        botActor: null,
      },
      {
        id: "workpad-new",
        body: "  ## Workpad\n\nLatest plan.",
        createdAt: "2026-03-06T00:02:00.000Z",
        updatedAt: "2026-03-06T00:04:00.000Z",
        user: null,
        botActor: null,
      },
    ]);
    const fakeRunner = new FakeAgentRunner();
    const host = new OrchestratorRuntimeHost({
      config: createStagedConfig(),
      tracker,
      createAgentRunner: ({ onEvent }) => {
        fakeRunner.onEvent = onEvent;
        return fakeRunner;
      },
      now: () => new Date("2026-03-06T00:05:00.000Z"),
    });

    host.getState().issueStages["1"] = "investigate";
    host.getState().retryAttempts["1"] = {
      issueId: "1",
      identifier: "ISSUE-1",
      attempt: 1,
      dueAtMs: Date.parse("2026-03-06T00:04:00.000Z"),
      timerHandle: null,
      error: null,
      delayType: "continuation",
    };

    const retryResult = await host.runRetryTimer("1");

    expect(retryResult).toMatchObject({
      dispatched: true,
    });
    expect(fakeRunner.runInputs).toHaveLength(1);
    expect(fakeRunner.runInputs[0]).toMatchObject({
      attempt: 1,
      stageName: "investigate",
      workpadContext: {
        present: true,
        commentId: "workpad-new",
      },
    });
  });

  it("persists rate-limit snapshots and hydrates them into a cold host", async () => {
    const workspaceRoot = mkdtempSync(join(tmpdir(), "symph-rl-snapshot-"));
    try {
      const rateLimits = {
        limit_id: "codex",
        primary: {
          used_percent: 39,
          window_minutes: 300,
          resets_at: 1772800000,
        },
        secondary: {
          used_percent: 97,
          window_minutes: 10080,
          resets_at: 1772900000,
        },
      };
      const config = createConfig();
      config.workspace.root = workspaceRoot;
      const tracker = createTracker();
      const fakeRunner = new FakeAgentRunner();
      const host = new OrchestratorRuntimeHost({
        config,
        tracker,
        createAgentRunner: ({ onEvent }) => {
          fakeRunner.onEvent = onEvent;
          return fakeRunner;
        },
        writeDispatcherRunJournalEntry: ignoreDispatcherRunJournalEntry,
        now: () => new Date("2026-03-06T00:00:05.000Z"),
      });

      await host.pollOnce();
      fakeRunner.emit("1", {
        event: "notification",
        timestamp: "2026-03-06T00:00:01.000Z",
        codexAppServerPid: "1001",
        sessionId: "thread-1-turn-1",
        threadId: "thread-1",
        turnId: "turn-1",
        rateLimits,
      });
      await host.flushEvents();

      const persisted = await loadPersistedRateLimitSnapshot(workspaceRoot);
      expect(persisted).toEqual({
        observedAt: "2026-03-06T00:00:05.000Z",
        rateLimits,
      });

      // A cold host in the same workspace hydrates the snapshot before its
      // first tick, so the admission floor has data from tick one.
      const coldTracker = createTracker({ candidates: [] });
      const coldRunner = new FakeAgentRunner();
      const coldHost = new OrchestratorRuntimeHost({
        config,
        tracker: coldTracker,
        createAgentRunner: ({ onEvent }) => {
          coldRunner.onEvent = onEvent;
          return coldRunner;
        },
        writeDispatcherRunJournalEntry: ignoreDispatcherRunJournalEntry,
        now: () => new Date("2026-03-06T00:10:00.000Z"),
      });

      await coldHost.pollOnce();
      await coldHost.flushEvents();
      expect(coldHost.getState().codexRateLimits).toEqual(rateLimits);
      expect(coldHost.getState().codexRateLimitsObservedAt).toBe(
        "2026-03-06T00:00:05.000Z",
      );
    } finally {
      removeWorkspaceWithRetry(workspaceRoot);
    }
  });

  it("blocks cold-start dispatch from a persisted low-headroom snapshot", async () => {
    const workspaceRoot = mkdtempSync(join(tmpdir(), "symph-rl-floor-"));
    try {
      // Persisted snapshot: 2% secondary headroom, resets in the future
      // relative to the host clock (2026-03-06T00:00:05Z = 1772755205).
      await persistRateLimitSnapshot(workspaceRoot, {
        observedAt: "2026-03-06T00:00:00.000Z",
        rateLimits: {
          limit_id: "codex",
          secondary: {
            used_percent: 98,
            window_minutes: 10080,
            resets_at: 1772800000,
          },
        },
      });

      const config = createConfig();
      config.workspace.root = workspaceRoot;
      config.rateLimitAdmission = {
        minPrimaryHeadroomPct: 10,
        minSecondaryHeadroomPct: 5,
      };
      const tracker = createTracker();
      const fakeRunner = new FakeAgentRunner();
      const host = new OrchestratorRuntimeHost({
        config,
        tracker,
        createAgentRunner: ({ onEvent }) => {
          fakeRunner.onEvent = onEvent;
          return fakeRunner;
        },
        writeDispatcherRunJournalEntry: ignoreDispatcherRunJournalEntry,
        now: () => new Date("2026-03-06T00:00:05.000Z"),
      });

      const tick = await host.pollOnce();
      await host.flushEvents();

      expect(tick.dispatchedIssueIds).toEqual([]);
      expect(host.getState().rateLimitAdmission).toMatchObject({
        blocked: true,
        secondaryUsedPercent: 98,
      });
    } finally {
      removeWorkspaceWithRetry(workspaceRoot);
    }
  });

  it("fails open on cold-start when the persisted snapshot is stale and no worker can refresh it (SYMPH-778)", async () => {
    const workspaceRoot = mkdtempSync(join(tmpdir(), "symph-rl-stale-"));
    try {
      // Snapshot observed ~48h before the host clock (2026-03-06T00:00:05Z),
      // secondary window 98% used and resets far in the future (not expired).
      // With no worker able to emit fresh telemetry, this stale snapshot would
      // otherwise deadlock admission forever (SYMPH-778).
      await persistRateLimitSnapshot(workspaceRoot, {
        observedAt: "2026-03-04T00:00:00.000Z",
        rateLimits: {
          limit_id: "codex",
          secondary: {
            used_percent: 98,
            window_minutes: 10080,
            resets_at: 1772800000,
          },
        },
      });

      const config = createConfig();
      config.workspace.root = workspaceRoot;
      config.rateLimitAdmission = {
        minPrimaryHeadroomPct: 10,
        minSecondaryHeadroomPct: 5,
        snapshotMaxAgeMs: 21_600_000,
      };
      const tracker = createTracker();
      const fakeRunner = new FakeAgentRunner();
      const host = new OrchestratorRuntimeHost({
        config,
        tracker,
        createAgentRunner: ({ onEvent }) => {
          fakeRunner.onEvent = onEvent;
          return fakeRunner;
        },
        writeDispatcherRunJournalEntry: ignoreDispatcherRunJournalEntry,
        now: () => new Date("2026-03-06T00:00:05.000Z"),
      });

      const tick = await host.pollOnce();
      await host.flushEvents();

      // The stale snapshot no longer closes dispatch by itself: a probe runs.
      expect(host.getState().rateLimitAdmission).toMatchObject({
        blocked: false,
        snapshotStale: true,
        staleBypass: true,
        snapshotObservedAt: "2026-03-04T00:00:00.000Z",
      });
      expect(tick.dispatchedIssueIds).toEqual(["1"]);
    } finally {
      removeWorkspaceWithRetry(workspaceRoot);
    }
  });

  it("preserves legacy Codex session log entries without byte metadata", async () => {
    const tracker = createTracker();
    const fakeRunner = new FakeAgentRunner();
    const host = new OrchestratorRuntimeHost({
      config: createConfig(),
      tracker,
      createAgentRunner: ({ onEvent }) => {
        fakeRunner.onEvent = onEvent;
        return fakeRunner;
      },
      now: () => new Date("2026-03-06T00:00:05.000Z"),
    });

    await host.pollOnce();
    host.getState().running["1"]?.codexSessionLogs.push({
      label: "legacy-rollout.jsonl",
      path: "/tmp/workspaces/1/.symphony/codex-sessions/legacy-rollout.jsonl",
      url: null,
    });

    const details = await host.getIssueDetails("ISSUE-1");

    expect(details?.logs.codex_session_logs).toEqual([
      {
        label: "legacy-rollout.jsonl",
        path: "/tmp/workspaces/1/.symphony/codex-sessions/legacy-rollout.jsonl",
        url: null,
      },
    ]);
    expect("bytes" in details!.logs.codex_session_logs[0]!).toBe(false);

    fakeRunner.resolve("1", createNormalResult());
    await host.waitForIdle();
  });

  it("exposes durable Codex session artifact sizes for retry and terminal issue details", async () => {
    const workspaceRoot = mkdtempSync(join(tmpdir(), "symph-artifacts-"));
    try {
      const config = createConfig();
      config.workspace.root = workspaceRoot;
      const tracker = createTracker();
      const fakeRunner = new FakeAgentRunner();
      const host = new OrchestratorRuntimeHost({
        config,
        tracker,
        createAgentRunner: ({ onEvent }) => {
          fakeRunner.onEvent = onEvent;
          return fakeRunner;
        },
        now: () => new Date("2026-03-06T00:00:05.000Z"),
      });

      await host.pollOnce();
      fakeRunner.emit("1", {
        event: "session_artifact_saved",
        timestamp: "2026-03-06T00:00:03.000Z",
        codexAppServerPid: "1001",
        sessionId: "thread-1-turn-1",
        threadId: "thread-1",
        turnId: "turn-1",
        artifacts: [
          {
            label: "sessions/2026/rollout-live.jsonl",
            path: join(
              workspaceRoot,
              ".symphony/codex-sessions/1/home-a/sessions/2026/rollout-live.jsonl",
            ),
            sourcePath:
              "/tmp/symphony-codex-home-1/sessions/rollout-live.jsonl",
            bytes: 12,
          },
        ],
      });
      await host.flushEvents();

      const artifactPath = join(
        workspaceRoot,
        ".symphony/codex-sessions/1/home-a/sessions/2026/rollout-live.jsonl",
      );
      mkdirSync(dirname(artifactPath), { recursive: true });
      writeFileSync(artifactPath, "hello world\n");
      const outsideDirectory = join(workspaceRoot, "outside-artifacts");
      mkdirSync(outsideDirectory, { recursive: true });
      writeFileSync(join(outsideDirectory, "outside.jsonl"), "outside\n");
      symlinkSync(
        outsideDirectory,
        join(workspaceRoot, ".symphony/codex-sessions/1/home-symlink"),
      );
      symlinkSync(
        join(outsideDirectory, "outside.jsonl"),
        join(workspaceRoot, ".symphony/codex-sessions/1/linked.jsonl"),
      );

      fakeRunner.resolve("1", createNormalResult());
      await host.waitForIdle();

      const details = await host.getIssueDetails("ISSUE-1");

      expect(details?.status).toBe("retry_queued");
      expect(details?.logs.codex_session_logs).toEqual([
        {
          label: "home-a/sessions/2026/rollout-live.jsonl",
          path: artifactPath,
          url: null,
          bytes: 12,
        },
      ]);

      const terminalArtifactPath = join(
        workspaceRoot,
        ".symphony/codex-sessions/terminal-1/home-b/sessions/2026/rollout-terminal.jsonl",
      );
      mkdirSync(dirname(terminalArtifactPath), { recursive: true });
      writeFileSync(terminalArtifactPath, "terminal artifact\n");
      await writeLoopTraceJournal(
        {
          workspaceRoot,
          workspaceKey: "terminal-1",
        },
        [
          {
            sequence: 1,
            timestamp: "2026-03-06T00:01:00.000Z",
            kind: "stage_transition",
            issueId: "terminal-1",
            issueIdentifier: "ISSUE-TERMINAL",
            stage: "implement",
            attempt: null,
            sessionId: "thread-terminal",
            summary: "Stage implement moved to released.",
            stageTransition: {
              from: "implement",
              to: "implement",
              status: "released",
            },
          },
        ],
      );

      const coldHost = new OrchestratorRuntimeHost({
        config,
        tracker: createTracker({ candidates: [] }),
        createAgentRunner: ({ onEvent }) => {
          fakeRunner.onEvent = onEvent;
          return fakeRunner;
        },
        now: () => new Date("2026-03-06T00:01:05.000Z"),
      });

      const terminalDetails = await coldHost.getIssueDetails("ISSUE-TERMINAL");
      expect(terminalDetails?.status).toBe("released");
      expect(terminalDetails?.logs.codex_session_logs).toEqual([
        {
          label: "home-b/sessions/2026/rollout-terminal.jsonl",
          path: terminalArtifactPath,
          url: null,
          bytes: 18,
        },
      ]);

      const terminalDetailsById = await coldHost.getIssueDetails("terminal-1");
      expect(terminalDetailsById).toMatchObject({
        issue_identifier: "ISSUE-TERMINAL",
        issue_id: "terminal-1",
        status: "released",
      });
      expect(terminalDetailsById?.logs.codex_session_logs).toEqual([
        {
          label: "home-b/sessions/2026/rollout-terminal.jsonl",
          path: terminalArtifactPath,
          url: null,
          bytes: 18,
        },
      ]);
    } finally {
      rmSync(workspaceRoot, { recursive: true, force: true });
    }
  });

  it("reads durable Codex session logs from the sanitized workspace key", async () => {
    const workspaceRoot = mkdtempSync(join(tmpdir(), "symph-artifact-key-"));
    try {
      const unsafeIssueId = "../unsafe-issue-id";
      const workspaceKey = sanitizeWorkspaceKey(unsafeIssueId);
      const artifactKey = toWorkspaceArtifactKey(workspaceKey);
      const safeArtifactPath = join(
        workspaceRoot,
        ".symphony/codex-sessions",
        artifactKey,
        "home-a/sessions/2026/rollout-safe.jsonl",
      );
      const rawArtifactPath = join(
        workspaceRoot,
        ".symphony/codex-sessions",
        unsafeIssueId,
        "home-b/sessions/2026/rollout-raw.jsonl",
      );
      mkdirSync(dirname(safeArtifactPath), { recursive: true });
      mkdirSync(dirname(rawArtifactPath), { recursive: true });
      writeFileSync(safeArtifactPath, "safe artifact\n");
      writeFileSync(rawArtifactPath, "raw artifact\n");

      await writeLoopTraceJournal(
        {
          workspaceRoot,
          workspaceKey,
        },
        [
          {
            sequence: 1,
            timestamp: "2026-03-06T00:01:00.000Z",
            kind: "stage_transition",
            issueId: unsafeIssueId,
            issueIdentifier: "ISSUE-UNSAFE",
            stage: "implement",
            attempt: null,
            sessionId: "thread-unsafe",
            summary: "Stage implement moved to released.",
            stageTransition: {
              from: "implement",
              to: "implement",
              status: "released",
            },
          },
        ],
      );

      const config = createConfig();
      config.workspace.root = workspaceRoot;
      const host = new OrchestratorRuntimeHost({
        config,
        tracker: createTracker({ candidates: [] }),
        agentRunner: new FakeAgentRunner(),
        now: () => new Date("2026-03-06T00:01:05.000Z"),
      });

      const details = await host.getIssueDetails("ISSUE-UNSAFE");

      expect(details?.logs.codex_session_logs).toEqual([
        {
          label: "home-a/sessions/2026/rollout-safe.jsonl",
          path: safeArtifactPath,
          url: null,
          bytes: 14,
        },
      ]);
    } finally {
      rmSync(workspaceRoot, { recursive: true, force: true });
    }
  });

  it("loads cold terminal details for issue ids whose workspace key contains dot-dot", async () => {
    const workspaceRoot = mkdtempSync(join(tmpdir(), "symph-loop-dotdot-"));
    try {
      const issueId = "../unsafe-issue-id";
      const issueIdentifier = "ISSUE-UNSAFE-DOTDOT";
      const workspaceKey = sanitizeWorkspaceKey(issueId);
      const artifactKey = toWorkspaceArtifactKey(workspaceKey);

      await writeLoopTraceJournal(
        {
          workspaceRoot,
          workspaceKey,
        },
        [
          {
            sequence: 1,
            timestamp: "2026-03-06T00:02:00.000Z",
            kind: "stage_transition",
            issueId,
            issueIdentifier,
            stage: "implement",
            attempt: null,
            sessionId: "thread-dotdot",
            summary: "Stage implement moved to released.",
            stageTransition: {
              from: "implement",
              to: "implement",
              status: "released",
            },
          },
        ],
      );

      const config = createConfig();
      config.workspace.root = workspaceRoot;
      const coldHost = new OrchestratorRuntimeHost({
        config,
        tracker: createTracker({ candidates: [] }),
        agentRunner: new FakeAgentRunner(),
        now: () => new Date("2026-03-06T00:02:05.000Z"),
      });

      const details = await coldHost.getIssueDetails(issueIdentifier);

      expect(details).toMatchObject({
        issue_id: issueId,
        issue_identifier: issueIdentifier,
        status: "released",
        loop_trace_journal: {
          path: join(
            workspaceRoot,
            ".symphony/loop-traces",
            `${artifactKey}.jsonl`,
          ),
          total_entries: 1,
          stored_entries: 1,
          truncated: false,
        },
      });
    } finally {
      rmSync(workspaceRoot, { recursive: true, force: true });
    }
  });

  it("coalesces manual refresh requests onto a single queued poll", async () => {
    const tracker = createTracker({
      candidates: [],
    });
    const host = new OrchestratorRuntimeHost({
      config: createConfig(),
      tracker,
      agentRunner: new FakeAgentRunner(),
      now: () => new Date("2026-03-06T00:00:05.000Z"),
    });

    const [first, second] = await Promise.all([
      host.requestRefresh(),
      host.requestRefresh(),
    ]);
    await host.waitForIdle();

    expect(first).toMatchObject({
      queued: true,
      coalesced: false,
      operations: ["poll", "reconcile"],
    });
    expect(second).toMatchObject({
      queued: true,
      coalesced: true,
    });
    expect(tracker.fetchCandidateIssues).toHaveBeenCalledTimes(1);
  });

  it("reports restart safe when the Pipeline queue and runtime lanes are drained", async () => {
    const tracker = createLinearTrackerForPipelineStatus();
    vi.spyOn(tracker, "fetchOpenIssuesByLabels").mockResolvedValue([]);
    vi.spyOn(tracker, "fetchIssuesByStates").mockResolvedValue([]);

    const host = new OrchestratorRuntimeHost({
      config: createConfig(),
      tracker,
      agentRunner: new FakeAgentRunner(),
    });

    const status = await host.getPipelineStatus();

    expect(tracker.fetchIssuesByStates).toHaveBeenCalledWith([
      "Todo",
      "In Progress",
      "In Review",
      "Resume",
    ]);
    expect(status).toMatchObject({
      paused: false,
      issues: [],
      restart_safety: {
        restart_safe: true,
        reason: "drained",
        running_lane_count: 0,
        retrying_lane_count: 0,
        active_issue_count: 0,
        active_issues: [],
      },
    });
  });

  it("reports restart blocked when active Pipeline issues remain", async () => {
    const tracker = createLinearTrackerForPipelineStatus();
    vi.spyOn(tracker, "fetchOpenIssuesByLabels").mockResolvedValue([]);
    vi.spyOn(tracker, "fetchIssuesByStates").mockResolvedValue([
      createIssue({
        id: "2",
        identifier: "SYMPH-271",
        title: "Add Pipeline queue drain guard",
        state: "Todo",
      }),
      createIssue({
        id: "halt",
        identifier: "SYMPH-200",
        title: "Pipeline Halt",
        state: "Todo",
        labels: ["pipeline-halt"],
      }),
    ]);

    const host = new OrchestratorRuntimeHost({
      config: createConfig(),
      tracker,
      agentRunner: new FakeAgentRunner(),
    });

    const status = await host.getPipelineStatus();

    expect(status.restart_safety).toMatchObject({
      restart_safe: false,
      reason: "active_pipeline_issues",
      running_lane_count: 0,
      retrying_lane_count: 0,
      active_issue_count: 1,
      active_issues: [
        {
          identifier: "SYMPH-271",
          title: "Add Pipeline queue drain guard",
          state: "Todo",
        },
      ],
    });
  });

  it("reports restart blocked while a runtime lane is running", async () => {
    const tracker = createLinearTrackerForPipelineStatus();
    vi.spyOn(tracker, "fetchCandidateIssues").mockResolvedValue([
      createIssue(),
    ]);
    vi.spyOn(tracker, "fetchOpenIssuesByLabels").mockResolvedValue([]);
    vi.spyOn(tracker, "fetchIssuesByStates").mockResolvedValue([]);
    vi.spyOn(tracker, "fetchIssueStatesByIds").mockResolvedValue([
      { id: "1", identifier: "ISSUE-1", state: "In Progress" },
    ]);
    const fakeRunner = new FakeAgentRunner();
    const host = new OrchestratorRuntimeHost({
      config: createConfig(),
      tracker,
      createAgentRunner: ({ onEvent }) => {
        fakeRunner.onEvent = onEvent;
        return fakeRunner;
      },
    });

    await host.pollOnce();

    const status = await host.getPipelineStatus();

    expect(status.restart_safety).toMatchObject({
      restart_safe: false,
      reason: "running_or_retrying_lanes",
      running_lane_count: 1,
      retrying_lane_count: 0,
      active_issue_count: 0,
    });

    fakeRunner.resolve("1", createNormalResult());
    await host.waitForIdle();
  });

  it("fails restart safety closed when Pipeline queue inspection fails", async () => {
    const tracker = createLinearTrackerForPipelineStatus();
    vi.spyOn(tracker, "fetchOpenIssuesByLabels").mockResolvedValue([]);
    vi.spyOn(tracker, "fetchIssuesByStates").mockRejectedValue(
      new Error("Linear unavailable"),
    );

    const host = new OrchestratorRuntimeHost({
      config: createConfig(),
      tracker,
      agentRunner: new FakeAgentRunner(),
    });

    const status = await host.getPipelineStatus();

    expect(status.restart_safety).toMatchObject({
      restart_safe: false,
      reason: "queue_status_unavailable",
      running_lane_count: 0,
      retrying_lane_count: 0,
      active_issue_count: 0,
      active_issues: [],
      error_message: "Linear unavailable",
    });
  });

  it("resolves running workspace details from issue id after identifier changes", async () => {
    const tracker = createTracker();
    const fakeRunner = new FakeAgentRunner();
    const host = new OrchestratorRuntimeHost({
      config: createConfig(),
      tracker,
      createAgentRunner: ({ onEvent }) => {
        fakeRunner.onEvent = onEvent;
        return fakeRunner;
      },
      now: () => new Date("2026-03-06T00:00:05.000Z"),
    });

    await host.pollOnce();
    tracker.setStateSnapshots([
      { id: "1", identifier: "RENAMED-2", state: "In Progress" },
    ]);
    await host.pollOnce();

    const details = await host.getIssueDetails("RENAMED-2");

    expect(details).toMatchObject({
      issue_identifier: "RENAMED-2",
      workspace: {
        path: "/tmp/workspaces/1",
      },
    });
  });

  it("maps recentActivity entries to recent_events in issue details", async () => {
    const tracker = createTracker();
    const fakeRunner = new FakeAgentRunner();
    const host = new OrchestratorRuntimeHost({
      config: createConfig(),
      tracker,
      createAgentRunner: ({ onEvent }) => {
        fakeRunner.onEvent = onEvent;
        return fakeRunner;
      },
      now: () => new Date("2026-03-06T00:00:05.000Z"),
    });

    await host.pollOnce();

    fakeRunner.emit("1", {
      event: "session_started",
      timestamp: "2026-03-06T00:00:01.000Z",
      codexAppServerPid: "1001",
      sessionId: "thread-1-turn-1",
      threadId: "thread-1",
      turnId: "turn-1",
    });
    fakeRunner.emit("1", {
      event: "notification",
      timestamp: "2026-03-06T00:00:02.000Z",
      codexAppServerPid: "1001",
      sessionId: "thread-1-turn-1",
      threadId: "thread-1",
      turnId: "turn-1",
      message: "Working on tests",
    });
    fakeRunner.emit("1", {
      event: "turn_completed",
      timestamp: "2026-03-06T00:00:03.000Z",
      codexAppServerPid: "1001",
      sessionId: "thread-1-turn-1",
      threadId: "thread-1",
      turnId: "turn-1",
      usage: {
        inputTokens: 100,
        outputTokens: 50,
        totalTokens: 150,
      },
    });
    fakeRunner.emit("1", {
      event: "notification",
      timestamp: "2026-03-06T00:00:04.000Z",
      codexAppServerPid: "1001",
      sessionId: "thread-1-turn-1",
      threadId: "thread-1",
      turnId: "turn-1",
      message: "Refactoring module",
    });
    fakeRunner.emit("1", {
      event: "turn_completed",
      timestamp: "2026-03-06T00:00:05.000Z",
      codexAppServerPid: "1001",
      sessionId: "thread-1-turn-1",
      threadId: "thread-1",
      turnId: "turn-1",
      usage: {
        inputTokens: 200,
        outputTokens: 100,
        totalTokens: 300,
      },
    });
    await host.flushEvents();

    const details = await host.getIssueDetails("ISSUE-1");

    expect(details).not.toBeNull();
    expect(details!.recent_events).toEqual([
      {
        at: "2026-03-06T00:00:01.000Z",
        event: "Session started",
        message: null,
      },
      {
        at: "2026-03-06T00:00:02.000Z",
        event: "Notification",
        message: "Working on tests",
      },
      {
        at: "2026-03-06T00:00:03.000Z",
        event: "Turn completed",
        message: null,
      },
      {
        at: "2026-03-06T00:00:04.000Z",
        event: "Notification",
        message: "Refactoring module",
      },
      {
        at: "2026-03-06T00:00:05.000Z",
        event: "Turn completed",
        message: null,
      },
    ]);
  });

  it("loads artifact-backed loop trace details after a cold restart", async () => {
    const workspaceRoot = mkdtempSync(join(tmpdir(), "symph-loop-trace-"));

    try {
      const tracker = createTracker();
      const fakeRunner = new FakeAgentRunner();
      const config = createStagedConfig({
        workspace: {
          root: workspaceRoot,
        },
      });
      const host = new OrchestratorRuntimeHost({
        config,
        tracker,
        createAgentRunner: ({ onEvent }) => {
          fakeRunner.onEvent = onEvent;
          return fakeRunner;
        },
        now: () => new Date("2026-03-06T00:00:05.000Z"),
      });

      await host.pollOnce();

      fakeRunner.emit("1", {
        event: "session_started",
        timestamp: "2026-03-06T00:00:01.000Z",
        codexAppServerPid: "1001",
        sessionId: "thread-1-turn-1",
        threadId: "thread-1",
        turnId: "turn-1",
        turnCount: 1,
        promptChars: 480,
        estimatedPromptTokens: 120,
      });
      await host.flushEvents();

      fakeRunner.resolve("1", createNormalResult());
      await host.waitForIdle();

      expect(host.getState().loopTraceJournal["1"]).toBeUndefined();

      const coldHost = new OrchestratorRuntimeHost({
        config,
        tracker: createTracker({
          candidates: [],
          stateSnapshots: [],
        }),
        agentRunner: new FakeAgentRunner(),
        now: () => new Date("2026-03-06T00:00:06.000Z"),
      });

      const details = await coldHost.getIssueDetails("ISSUE-1");

      expect(details).not.toBeNull();
      expect(details).toMatchObject({
        issue_identifier: "ISSUE-1",
        status: "completed",
        loop_trace_journal: {
          path: `${workspaceRoot}/.symphony/loop-traces/1.jsonl`,
          total_entries: 4,
          stored_entries: 4,
          truncated: false,
        },
      });
      expect(
        details!.loop_trace_journal.entries.map((entry) => entry.kind),
      ).toEqual([
        "session_start",
        "prompt_summary",
        "stage_transition",
        "worker_exit",
      ]);

      const artifact = readFileSync(details!.loop_trace_journal.path, "utf8");
      expect(artifact).toContain('"kind":"session_start"');
      expect(artifact).toContain('"kind":"worker_exit"');

      const detailsByIssueId = await coldHost.getIssueDetails("1");
      expect(detailsByIssueId).toMatchObject({
        issue_identifier: "ISSUE-1",
        issue_id: "1",
        status: "completed",
        loop_trace_journal: {
          path: `${workspaceRoot}/.symphony/loop-traces/1.jsonl`,
          total_entries: 4,
          stored_entries: 4,
          truncated: false,
        },
      });

      await expect(coldHost.getIssueDetails("MISSING-1")).resolves.toBeNull();
    } finally {
      rmSync(workspaceRoot, { recursive: true, force: true });
    }
  });

  it("loads stored issue-id details through an injected loop trace reader", async () => {
    const workspaceRoot = mkdtempSync(
      join(tmpdir(), "symph-loop-trace-reader-"),
    );

    try {
      const journal: LoopTraceJournal = [
        {
          sequence: 1,
          timestamp: "2026-03-06T00:01:00.000Z",
          kind: "stage_transition",
          issueId: "issue-uuid-1",
          issueIdentifier: "ISSUE-READER",
          stage: "implement",
          attempt: null,
          sessionId: "thread-reader",
          summary: "Stage implement moved to released.",
          stageTransition: {
            from: "implement",
            to: "implement",
            status: "released",
          },
        },
      ];
      const readCalls: string[] = [];
      const config = createStagedConfig({
        workspace: {
          root: workspaceRoot,
        },
      });
      const host = new OrchestratorRuntimeHost({
        config,
        tracker: createTracker({
          candidates: [],
          stateSnapshots: [],
        }),
        agentRunner: new FakeAgentRunner(),
        readLoopTraceJournal: async (locator) => {
          readCalls.push(locator.workspaceKey);
          return journal;
        },
        now: () => new Date("2026-03-06T00:01:05.000Z"),
      });

      const details = await host.getIssueDetails("issue-uuid-1");

      expect(details).toMatchObject({
        issue_identifier: "ISSUE-READER",
        issue_id: "issue-uuid-1",
        status: "released",
        loop_trace_journal: {
          path: `${workspaceRoot}/.symphony/loop-traces/issue-uuid-1.jsonl`,
          total_entries: 1,
          stored_entries: 1,
          truncated: false,
        },
      });
      expect(readCalls).toEqual(["issue-uuid-1"]);
    } finally {
      rmSync(workspaceRoot, { recursive: true, force: true });
    }
  });

  it("hydrates dispatcher run journal from disk before dispatch on restart", async () => {
    const workspaceRoot = mkdtempSync(join(tmpdir(), "symph-run-journal-"));

    try {
      const config = createConfig();
      config.workspace.root = workspaceRoot;
      const firstRunner = new FakeAgentRunner();
      const firstHost = new OrchestratorRuntimeHost({
        config,
        tracker: createTracker(),
        createAgentRunner: ({ onEvent }) => {
          firstRunner.onEvent = onEvent;
          return firstRunner;
        },
        now: () => new Date("2026-03-06T00:00:05.000Z"),
      });

      const firstTick = await firstHost.pollOnce();

      expect(firstTick.dispatchedIssueIds).toEqual(["1"]);
      const journalPath = join(
        workspaceRoot,
        ".symphony",
        "run-journals",
        "dispatcher.jsonl",
      );
      const artifact = readFileSync(journalPath, "utf8");
      expect(artifact).toContain('"kind":"admission"');

      const coldRunner = new FakeAgentRunner();
      const coldHost = new OrchestratorRuntimeHost({
        config,
        tracker: createTracker(),
        createAgentRunner: ({ onEvent }) => {
          coldRunner.onEvent = onEvent;
          return coldRunner;
        },
        now: () => new Date("2026-03-06T00:00:06.000Z"),
      });

      const coldTick = await coldHost.pollOnce();

      expect(coldTick.dispatchedIssueIds).toEqual([]);
      expect(coldRunner.runs.size).toBe(0);
      expect(coldHost.getState().claimed.has("1")).toBe(true);
    } finally {
      rmSync(workspaceRoot, { recursive: true, force: true });
    }
  });

  it("keeps worker-exit lease completion in the original root after workspace root swap", async () => {
    const originalRoot = mkdtempSync(join(tmpdir(), "symph-run-root-a-"));
    const swappedRoot = mkdtempSync(join(tmpdir(), "symph-run-root-b-"));

    try {
      const config = createConfig();
      config.workspace.root = originalRoot;
      const fakeRunner = new FakeAgentRunner();
      const host = new OrchestratorRuntimeHost({
        config,
        tracker: createTracker(),
        createAgentRunner: ({ onEvent }) => {
          fakeRunner.onEvent = onEvent;
          return fakeRunner;
        },
        now: () => new Date("2026-03-06T00:00:05.000Z"),
      });

      const firstTick = await host.pollOnce();

      expect(firstTick.dispatchedIssueIds).toEqual(["1"]);
      expect(readDispatcherJournal(originalRoot)).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            kind: "admission",
            lease: expect.objectContaining({ status: "active" }),
          }),
        ]),
      );

      const swappedConfig = {
        ...config,
        workspace: {
          ...config.workspace,
          root: swappedRoot,
        },
      };
      host.updateConfig({
        config: swappedConfig,
        workspaceManager: new WorkspaceManager({ root: swappedRoot }),
      });

      await expect(host.pollOnce()).rejects.toThrow("pending active leases");
      expect(fakeRunner.runs.size).toBe(1);

      fakeRunner.resolve("1", createNormalResult());
      await host.waitForIdle();

      const originalJournal = readDispatcherJournal(originalRoot);
      expect(originalJournal).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            kind: "admission",
            lease: expect.objectContaining({ status: "completed" }),
          }),
        ]),
      );
      expect(readDispatcherJournal(swappedRoot)).toEqual([]);

      const afterCompletionTick = await host.pollOnce();
      expect(afterCompletionTick.dispatchedIssueIds).toEqual([]);
      expect(fakeRunner.runs.size).toBe(0);
    } finally {
      rmSync(originalRoot, { recursive: true, force: true });
      rmSync(swappedRoot, { recursive: true, force: true });
    }
  });

  it("hydrates manager-run journal only for snapshot projection", async () => {
    const journal: ManagerRunJournal = [
      {
        sequence: 1,
        idempotencyKey: "run:start",
        timestamp: "2026-06-08T12:00:00.000Z",
        runId: "run-1",
        sourceSessionId: "019ea700-80b7-7032-8ef5-dd8e638f0205",
        summary: "Manager run started.",
        type: "manager_run_started",
        managerThreadId: "manager-thread",
        title: "Wave run",
      },
      {
        sequence: 2,
        idempotencyKey: "run:lane",
        timestamp: "2026-06-08T12:01:00.000Z",
        runId: "run-1",
        sourceSessionId: "019ea700-80b7-7032-8ef5-dd8e638f0205",
        summary: "Lane admitted.",
        type: "worker_lane_admitted",
        laneId: "lane-1",
        workerThreadId: "worker-thread",
        issueIdentifier: "MOB-87",
        title: "Map manager-thread runs",
      },
    ];
    const readManagerRunJournal = vi.fn(async () => journal);
    const fakeRunner = new FakeAgentRunner();
    const host = new OrchestratorRuntimeHost({
      config: createConfig(),
      tracker: createTracker({ candidates: [] }),
      agentRunner: fakeRunner,
      readManagerRunJournal,
      now: () => new Date("2026-06-08T12:02:00.000Z"),
    });

    const snapshot = await host.getRuntimeSnapshot();

    expect(readManagerRunJournal).toHaveBeenCalledTimes(1);
    expect(fakeRunner.runs.size).toBe(0);
    expect(host.getState().managerRunJournal).toEqual(journal);
    expect(snapshot.manager_runs).toEqual([
      expect.objectContaining({
        run_id: "run-1",
        lanes: [
          expect.objectContaining({
            issue_identifier: "MOB-87",
            status: "active",
          }),
        ],
      }),
    ]);
  });

  it("refreshes manager-run journal snapshots after external appends", async () => {
    const workspaceRoot = mkdtempSync(join(tmpdir(), "symph-manager-run-"));
    try {
      const journalDir = join(workspaceRoot, ".symphony", "run-journals");
      const journalPath = join(journalDir, "manager-runs.jsonl");
      mkdirSync(journalDir, { recursive: true });
      const firstEntry: ManagerRunJournal[number] = {
        sequence: 1,
        idempotencyKey: "run:start",
        timestamp: "2026-06-08T12:00:00.000Z",
        runId: "run-1",
        sourceSessionId: "019ea700-80b7-7032-8ef5-dd8e638f0205",
        summary: "Manager run started.",
        type: "manager_run_started",
        managerThreadId: "019ea8a6-bc42-72a3-ade0-72be7663232e",
        title: "Wave run",
      };
      writeFileSync(journalPath, `${JSON.stringify(firstEntry)}\n`);
      const config = createConfig();
      config.workspace.root = workspaceRoot;
      const host = new OrchestratorRuntimeHost({
        config,
        tracker: createTracker({ candidates: [] }),
        agentRunner: new FakeAgentRunner(),
        now: () => new Date("2026-06-08T12:02:00.000Z"),
      });

      const firstSnapshot = await host.getRuntimeSnapshot();

      expect(firstSnapshot.manager_runs).toEqual([
        expect.objectContaining({
          run_id: "run-1",
          lanes: [],
        }),
      ]);

      const appendedEntry: ManagerRunJournal[number] = {
        sequence: 2,
        idempotencyKey: "run:lane",
        timestamp: "2026-06-08T12:01:00.000Z",
        runId: "run-1",
        sourceSessionId: "019ea700-80b7-7032-8ef5-dd8e638f0205",
        summary: "Lane admitted after first snapshot.",
        type: "worker_lane_admitted",
        laneId: "lane-1",
        workerThreadId: "worker-thread",
        issueIdentifier: "MOB-87",
        title: "Map manager-thread runs",
      };
      writeFileSync(journalPath, `${JSON.stringify(appendedEntry)}\n`, {
        flag: "a",
      });

      const secondSnapshot = await host.getRuntimeSnapshot();

      expect(secondSnapshot.manager_runs).toEqual([
        expect.objectContaining({
          run_id: "run-1",
          lanes: [
            expect.objectContaining({
              lane_id: "lane-1",
              issue_identifier: "MOB-87",
              status: "active",
            }),
          ],
        }),
      ]);
      expect(host.getState().managerRunJournal).toHaveLength(2);
    } finally {
      rmSync(workspaceRoot, { recursive: true, force: true });
    }
  });

  it("fails dispatch before side effects when dispatcher journal cannot be persisted", async () => {
    const fakeRunner = new FakeAgentRunner();
    const host = new OrchestratorRuntimeHost({
      config: createConfig(),
      tracker: createTracker(),
      createAgentRunner: ({ onEvent }) => {
        fakeRunner.onEvent = onEvent;
        return fakeRunner;
      },
      writeDispatcherRunJournalEntry: async () => {
        throw new Error("journal disk unavailable");
      },
      now: () => new Date("2026-03-06T00:00:05.000Z"),
    });

    await expect(host.pollOnce()).rejects.toThrow("journal disk unavailable");
    expect(fakeRunner.runs.size).toBe(0);
    expect(host.getState().dispatcherRunJournal).toEqual([]);
    expect(host.getState().claimed.has("1")).toBe(false);
  });

  it("fails closed and retries hydration when dispatcher journal cannot be read", async () => {
    const fakeRunner = new FakeAgentRunner();
    let readCalls = 0;
    const host = new OrchestratorRuntimeHost({
      config: createConfig(),
      tracker: createTracker(),
      createAgentRunner: ({ onEvent }) => {
        fakeRunner.onEvent = onEvent;
        return fakeRunner;
      },
      readDispatcherRunJournal: async () => {
        readCalls += 1;
        if (readCalls === 1) {
          throw new Error("journal read unavailable");
        }
        return [];
      },
      now: () => new Date("2026-03-06T00:00:05.000Z"),
    });

    await expect(host.pollOnce()).rejects.toThrow("journal read unavailable");
    expect(fakeRunner.runs.size).toBe(0);
    expect(host.getState().dispatcherRunJournal).toEqual([]);
    expect(host.getState().claimed.has("1")).toBe(false);

    const tick = await host.pollOnce();

    expect(readCalls).toBe(2);
    expect(tick.dispatchedIssueIds).toEqual(["1"]);
    expect(fakeRunner.runs.size).toBe(1);
  });

  it("compacts and replays the dispatcher journal after successful hydration", async () => {
    const fakeRunner = new FakeAgentRunner();
    const sourceJournal: DispatcherRunJournal = [
      createRuntimeJournalEntry({
        sequence: 1,
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
      createRuntimeJournalEntry({
        sequence: 2,
        kind: "supervision_finding",
        issueId: "supervised",
        issueIdentifier: "SYMPH-SUPERVISED",
        summary: "Supervision finding covered by checkpoint.",
        metadata: {
          status: "completed",
          findingKind: "ignored_setup_instruction_collision",
          signature: "ignored-setup-signature",
        },
      }),
      createRuntimeJournalEntry({
        sequence: 3,
        kind: "admission",
        issueId: "tail",
        issueIdentifier: "SYMPH-TAIL",
        summary: "Raw tail retained.",
      }),
    ];
    const compactCalls: Array<{
      coveredThroughSequence: unknown;
      tailEntryCount: number | undefined;
    }> = [];
    const host = new OrchestratorRuntimeHost({
      config: createConfig(),
      tracker: createTracker({ candidates: [] }),
      createAgentRunner: ({ onEvent }) => {
        fakeRunner.onEvent = onEvent;
        return fakeRunner;
      },
      readDispatcherRunJournal: async () => sourceJournal,
      compactDispatcherRunJournal: async (
        _workspaceRoot,
        checkpointDraft,
        options,
      ) => {
        compactCalls.push({
          coveredThroughSequence:
            checkpointDraft.metadata.coveredThroughSequence,
          tailEntryCount: options?.tailEntryCount,
        });
        return compactDispatcherRunJournalWithCheckpoint(
          sourceJournal,
          checkpointDraft,
          { tailEntryCount: 1, minEntryCount: 2 },
        );
      },
      dispatcherRunJournalCompactionTailEntries: 1,
      now: () => new Date("2026-03-06T00:00:05.000Z"),
    });

    const tick = await host.pollOnce();

    expect(tick.dispatchedIssueIds).toEqual([]);
    expect(compactCalls).toEqual([
      { coveredThroughSequence: 3, tailEntryCount: 1 },
    ]);
    expect(
      host.getState().dispatcherRunJournal.map((entry) => entry.kind),
    ).toEqual(["journal_checkpoint", "admission"]);
    expect(host.getState().resumeRequired.has("parked")).toBe(true);
    expect(host.getState().resumeRequiredMarks.parked).toMatchObject({
      reason: "hard_stop:token_budget",
      setBySequence: 1,
    });
  });

  it("skips dispatcher journal compaction while emergency-stop cleanup proof is unconfirmed", async () => {
    const entries: StructuredLogEntry[] = [];
    const logger = new StructuredLogger([
      {
        write(entry) {
          entries.push(entry);
        },
      },
    ]);
    const compactDispatcherRunJournal = vi.fn(async () => {
      throw new Error("compaction should not run with unconfirmed cleanup");
    });
    const host = new OrchestratorRuntimeHost({
      config: createConfig(),
      tracker: createTracker({ candidates: [] }),
      agentRunner: new FakeAgentRunner(),
      logger,
      readDispatcherRunJournal: async () => [
        createPipelineStopJournalEntry(1, null, null),
        createRuntimeJournalEntry({
          sequence: 2,
          kind: "admission",
          issueId: "tail",
          issueIdentifier: "SYMPH-TAIL",
          summary: "Raw tail retained.",
        }),
      ],
      compactDispatcherRunJournal,
      now: () => new Date("2026-03-06T00:00:05.000Z"),
    });

    await host.pollOnce();

    expect(compactDispatcherRunJournal).not.toHaveBeenCalled();
    expect(
      host.getState().dispatcherRunJournal.map((entry) => entry.kind),
    ).toEqual(expect.arrayContaining(["intent", "admission"]));
    expect(
      host
        .getState()
        .dispatcherRunJournal.some(
          (entry) => entry.kind === "journal_checkpoint",
        ),
    ).toBe(false);
    expect(entries).toContainEqual(
      expect.objectContaining({
        event: "dispatcher_run_journal_compaction_skipped",
        skipped_reason: "unconfirmed_emergency_stop_cleanup",
        unconfirmed_cleanup_plan_count: 1,
      }),
    );
  });

  it("serves missing stored details when stored loop trace lookup fails", async () => {
    const workspaceRoot = mkdtempSync(join(tmpdir(), "symph-loop-trace-bad-"));

    try {
      mkdirSync(join(workspaceRoot, ".symphony"));
      writeFileSync(
        join(workspaceRoot, ".symphony", "loop-traces"),
        "not a directory\n",
      );
      const config = createStagedConfig({
        workspace: {
          root: workspaceRoot,
        },
      });
      const entries: StructuredLogEntry[] = [];
      const logger = new StructuredLogger([
        {
          write(entry) {
            entries.push(entry);
          },
        },
      ]);
      const host = new OrchestratorRuntimeHost({
        config,
        tracker: createTracker({
          candidates: [],
          stateSnapshots: [],
        }),
        logger,
        agentRunner: new FakeAgentRunner(),
        now: () => new Date("2026-03-06T00:00:06.000Z"),
      });

      await expect(host.getIssueDetails("ISSUE-1")).resolves.toBeNull();
      expect(entries).toContainEqual(
        expect.objectContaining({
          event: "loop_trace_hydration_failed",
          level: "warn",
          issue_identifier: "ISSUE-1",
          workspace_root: workspaceRoot,
        }),
      );
    } finally {
      rmSync(workspaceRoot, { recursive: true, force: true });
    }
  });

  it("shares in-flight loop trace hydration between details reads and agent events", async () => {
    const tracker = createTracker();
    const fakeRunner = new FakeAgentRunner();
    let releaseRead!: () => void;
    let markReadStarted!: () => void;
    const readStarted = new Promise<void>((resolve) => {
      markReadStarted = resolve;
    });
    const readGate = new Promise<void>((resolve) => {
      releaseRead = resolve;
    });
    const readLoopTraceJournal = vi.fn(async () => {
      markReadStarted();
      await readGate;
      return [];
    });
    const writeLoopTraceJournal = vi.fn(async () => {});
    const host = new OrchestratorRuntimeHost({
      config: createConfig(),
      tracker,
      readLoopTraceJournal,
      writeLoopTraceJournal,
      createAgentRunner: ({ onEvent }) => {
        fakeRunner.onEvent = onEvent;
        return fakeRunner;
      },
      now: () => new Date("2026-03-06T00:00:05.000Z"),
    });

    await host.pollOnce();
    const detailsPromise = host.getIssueDetails("ISSUE-1");
    await readStarted;

    fakeRunner.emit("1", {
      event: "session_started",
      timestamp: "2026-03-06T00:00:01.000Z",
      codexAppServerPid: "1001",
      sessionId: "thread-1-turn-1",
      threadId: "thread-1",
      turnId: "turn-1",
    });
    const flushPromise = host.flushEvents();
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(readLoopTraceJournal).toHaveBeenCalledTimes(1);

    releaseRead();
    await Promise.all([detailsPromise, flushPromise]);

    const details = await host.getIssueDetails("ISSUE-1");
    expect(
      details!.loop_trace_journal.entries.map((entry) => entry.kind),
    ).toEqual(["session_start"]);
    expect(writeLoopTraceJournal).toHaveBeenCalledTimes(1);
  });

  it("serves issue details when loop trace hydration fails", async () => {
    const tracker = createTracker();
    const fakeRunner = new FakeAgentRunner();
    const entries: StructuredLogEntry[] = [];
    const logger = new StructuredLogger([
      {
        write(entry) {
          entries.push(entry);
        },
      },
    ]);
    const readLoopTraceJournal = vi.fn(async () => {
      throw new Error("permission denied");
    });
    const host = new OrchestratorRuntimeHost({
      config: createConfig(),
      tracker,
      logger,
      readLoopTraceJournal,
      createAgentRunner: ({ onEvent }) => {
        fakeRunner.onEvent = onEvent;
        return fakeRunner;
      },
      now: () => new Date("2026-03-06T00:00:05.000Z"),
    });

    await host.pollOnce();
    const details = await host.getIssueDetails("ISSUE-1");

    expect(details).toMatchObject({
      issue_identifier: "ISSUE-1",
      issue_id: "1",
      status: "running",
      loop_trace_journal: {
        stored_entries: 0,
        total_entries: 0,
        entries: [],
      },
    });
    expect(entries).toContainEqual(
      expect.objectContaining({
        event: "loop_trace_hydration_failed",
        level: "warn",
        issue_id: "1",
        reason: "permission denied",
      }),
    );
  });

  it("runs the production continuous-feedback provider on checkpoint events", async () => {
    const tracker = createTracker();
    const fakeRunner = new FakeAgentRunner();
    const config = createConfig();
    config.continuousFeedback = {
      enabled: true,
      events: ["checkpoint"],
      runner: "pi",
      model: "local-flash",
      role: "continuous-feedback",
      bounceOnFinding: true,
      preflightFailClosed: false,
    };
    const commands: Array<{
      command: string;
      args: string[];
      cwd: string;
      prompt: string;
    }> = [];
    const host = new OrchestratorRuntimeHost({
      config,
      tracker,
      runContinuousFeedbackCommand: async (input) => {
        commands.push({
          command: input.command,
          args: input.args,
          cwd: input.cwd,
          prompt: input.prompt,
        });
        return {
          exitCode: 0,
          stderr: "",
          stdout: JSON.stringify({
            summary: "One checkpoint finding.",
            findings: [
              {
                signature: "src/core.ts:null-check",
                title: "Missing null check",
                detail:
                  "Guard the optional reviewer output before dereferencing.",
                severity: "warning",
                file: "src/core.ts",
                line: 42,
              },
            ],
          }),
        };
      },
      createAgentRunner: ({ onEvent }) => {
        fakeRunner.onEvent = onEvent;
        return fakeRunner;
      },
      now: () => new Date("2026-03-06T00:00:05.000Z"),
    });

    await host.pollOnce();
    fakeRunner.emit("1", {
      event: "turn_completed",
      timestamp: "2026-03-06T00:00:02.000Z",
      codexAppServerPid: "1001",
      sessionId: "thread-1-turn-1",
      threadId: "thread-1",
      turnId: "turn-1",
      message: "turn completed",
    });
    await host.flushEvents();

    expect(commands).toHaveLength(1);
    expect(commands[0]).toMatchObject({
      command: "pi",
      cwd: "/tmp/workspaces/1",
    });
    expect(commands[0]?.args).toEqual(
      expect.arrayContaining([
        "--no-session",
        "--print",
        "--no-tools",
        "--model",
        "local-flash",
      ]),
    );
    expect(commands[0]?.prompt).toContain("non-authoritative");

    const snapshot = await host.getRuntimeSnapshot();
    expect(snapshot.running[0]?.continuous_feedback).toMatchObject({
      status: "finding",
      reviewer_lane: {
        runner: "pi",
        model: "local-flash",
        role: "continuous-feedback",
      },
      findings: [
        expect.objectContaining({
          signature: "src/core.ts:null-check",
          status: "open",
        }),
      ],
    });
    const details = await host.getIssueDetails("ISSUE-1");
    expect(details?.loop_trace_journal.entries.at(-1)).toMatchObject({
      kind: "continuous_feedback",
      continuous_feedback: {
        status: "finding",
        finding_signatures: ["src/core.ts:null-check"],
      },
    });
  });

  it("surfaces an unavailable continuous-feedback model at startup without blocking by default (SYMPH-761)", async () => {
    const config = createConfig();
    config.continuousFeedback = {
      enabled: true,
      events: ["checkpoint"],
      runner: "pi",
      model: "ds4-studio2/missing-model",
      role: "continuous-feedback",
      bounceOnFinding: true,
      preflightFailClosed: false,
    };
    const host = new OrchestratorRuntimeHost({
      config,
      tracker: createTracker(),
      runContinuousFeedbackCommand: async () => ({
        exitCode: 1,
        stderr: "model not found: ds4-studio2/missing-model",
        stdout: "",
      }),
      now: () => new Date("2026-03-06T00:00:05.000Z"),
    });

    const result = await host.runContinuousFeedbackModelPreflight();
    expect(result).toMatchObject({ available: false });

    const snapshot = await host.getRuntimeSnapshot();
    expect(snapshot.continuous_feedback_preflight).toMatchObject({
      available: false,
      model: "ds4-studio2/missing-model",
      runner: "pi",
    });
    expect(snapshot.continuous_feedback_preflight?.detail).toContain(
      "model not found",
    );
  });

  it("fails startup closed when the continuous-feedback model is unavailable and fail-closed is opted in (SYMPH-761)", async () => {
    const config = createConfig();
    config.continuousFeedback = {
      enabled: true,
      events: ["checkpoint"],
      runner: "pi",
      model: "ds4-studio2/missing-model",
      role: "continuous-feedback",
      bounceOnFinding: true,
      preflightFailClosed: true,
    };
    const host = new OrchestratorRuntimeHost({
      config,
      tracker: createTracker(),
      runContinuousFeedbackCommand: async () => ({
        exitCode: 1,
        stderr: "model not found: ds4-studio2/missing-model",
        stdout: "",
      }),
      now: () => new Date("2026-03-06T00:00:05.000Z"),
    });

    await expect(
      host.runContinuousFeedbackModelPreflight(),
    ).rejects.toBeInstanceOf(RuntimeHostStartupError);
  });

  it("records an available continuous-feedback model and never blocks startup (SYMPH-761)", async () => {
    const config = createConfig();
    config.continuousFeedback = {
      enabled: true,
      events: ["checkpoint"],
      runner: "pi",
      model: "ds4-studio2/deepseek-v4-flash",
      role: "continuous-feedback",
      bounceOnFinding: true,
      preflightFailClosed: true,
    };
    const host = new OrchestratorRuntimeHost({
      config,
      tracker: createTracker(),
      runContinuousFeedbackCommand: async () => ({
        exitCode: 0,
        stderr: "",
        stdout: "OK",
      }),
      now: () => new Date("2026-03-06T00:00:05.000Z"),
    });

    const result = await host.runContinuousFeedbackModelPreflight();
    expect(result).toMatchObject({ available: true });
    const snapshot = await host.getRuntimeSnapshot();
    expect(snapshot.continuous_feedback_preflight).toMatchObject({
      available: true,
      model: "ds4-studio2/deepseek-v4-flash",
      runner: "pi",
    });
  });

  it("skips the continuous-feedback preflight when no model is configured (SYMPH-761)", async () => {
    const config = createConfig();
    config.continuousFeedback = {
      enabled: true,
      events: ["checkpoint"],
      runner: "pi",
      model: null,
      role: "continuous-feedback",
      bounceOnFinding: true,
      // Fail-closed opt-in must not trip when there is no configured model to
      // probe — a null model means "runner default", nothing to preflight.
      preflightFailClosed: true,
    };
    let probed = false;
    const host = new OrchestratorRuntimeHost({
      config,
      tracker: createTracker(),
      runContinuousFeedbackCommand: async () => {
        probed = true;
        return { exitCode: 0, stderr: "", stdout: "" };
      },
      now: () => new Date("2026-03-06T00:00:05.000Z"),
    });

    const result = await host.runContinuousFeedbackModelPreflight();
    expect(result).toBeNull();
    expect(probed).toBe(false);
    const snapshot = await host.getRuntimeSnapshot();
    expect(snapshot.continuous_feedback_preflight).toBeNull();
  });

  it("skips the continuous-feedback preflight when the model is a blank string (SYMPH-761)", async () => {
    const config = createConfig();
    config.continuousFeedback = {
      enabled: true,
      events: ["checkpoint"],
      runner: "pi",
      // A blank model would otherwise spawn `--model ""` and crash a fail-closed
      // launch; it means "nothing specific to probe" and must skip like null.
      model: "   ",
      role: "continuous-feedback",
      bounceOnFinding: true,
      preflightFailClosed: true,
    };
    let probed = false;
    const host = new OrchestratorRuntimeHost({
      config,
      tracker: createTracker(),
      runContinuousFeedbackCommand: async () => {
        probed = true;
        return { exitCode: 0, stderr: "", stdout: "" };
      },
      now: () => new Date("2026-03-06T00:00:05.000Z"),
    });

    const result = await host.runContinuousFeedbackModelPreflight();
    expect(result).toBeNull();
    expect(probed).toBe(false);
    const snapshot = await host.getRuntimeSnapshot();
    expect(snapshot.continuous_feedback_preflight).toBeNull();
  });

  it("probes the continuous-feedback model at most once across repeat calls (SYMPH-761)", async () => {
    const config = createConfig();
    config.continuousFeedback = {
      enabled: true,
      events: ["checkpoint"],
      runner: "pi",
      model: "ds4-studio2/deepseek-v4-flash",
      role: "continuous-feedback",
      bounceOnFinding: true,
      preflightFailClosed: false,
    };
    let probeCalls = 0;
    const host = new OrchestratorRuntimeHost({
      config,
      tracker: createTracker(),
      runContinuousFeedbackCommand: async () => {
        probeCalls += 1;
        return { exitCode: 0, stderr: "", stdout: "OK" };
      },
      now: () => new Date("2026-03-06T00:00:05.000Z"),
    });

    const first = await host.runContinuousFeedbackModelPreflight();
    expect(first).toMatchObject({ available: true });
    // A second call is a no-op: no re-spawn, recorded state preserved.
    const second = await host.runContinuousFeedbackModelPreflight();
    expect(second).toBeNull();
    expect(probeCalls).toBe(1);
  });

  it("projects failed continuous-feedback provider runs as unavailable in snapshot and loop trace", async () => {
    const tracker = createTracker();
    const fakeRunner = new FakeAgentRunner();
    const config = createConfig();
    config.continuousFeedback = {
      enabled: true,
      events: ["checkpoint"],
      runner: "pi",
      model: "local-flash",
      role: "continuous-feedback",
      bounceOnFinding: true,
      preflightFailClosed: false,
    };
    const host = new OrchestratorRuntimeHost({
      config,
      tracker,
      runContinuousFeedbackCommand: async () => ({
        exitCode: 1,
        stderr: 'Error: Model "local-flash" not found.',
        stdout: "",
      }),
      createAgentRunner: ({ onEvent }) => {
        fakeRunner.onEvent = onEvent;
        return fakeRunner;
      },
      now: () => new Date("2026-03-06T00:00:05.000Z"),
    });

    await host.pollOnce();
    fakeRunner.emit("1", {
      event: "turn_completed",
      timestamp: "2026-03-06T00:00:02.000Z",
      codexAppServerPid: "1001",
      sessionId: "thread-1-turn-1",
      threadId: "thread-1",
      turnId: "turn-1",
      message: "turn completed",
    });
    await host.flushEvents();

    const snapshot = await host.getRuntimeSnapshot();
    expect(snapshot.running[0]?.continuous_feedback).toMatchObject({
      status: "unavailable",
      summary:
        'Continuous feedback provider exited with 1: Error: Model "local-flash" not found.',
      findings: [],
    });

    const details = await host.getIssueDetails("ISSUE-1");
    expect(details?.loop_trace_journal.entries.at(-1)).toMatchObject({
      kind: "continuous_feedback",
      summary:
        'Continuous feedback unavailable. Continuous feedback provider exited with 1: Error: Model "local-flash" not found.',
      continuous_feedback: {
        status: "unavailable",
        unavailable_summary:
          'Continuous feedback provider exited with 1: Error: Model "local-flash" not found.',
        finding_signatures: [],
      },
    });
  });

  it("keeps structured agent-event logging when loop trace persistence fails", async () => {
    const tracker = createTracker();
    const fakeRunner = new FakeAgentRunner();
    const entries: StructuredLogEntry[] = [];
    const logger = new StructuredLogger([
      {
        write(entry) {
          entries.push(entry);
        },
      },
    ]);
    const writeLoopTraceJournal = vi.fn(async () => {
      throw new Error("disk full");
    });
    const host = new OrchestratorRuntimeHost({
      config: createConfig(),
      tracker,
      logger,
      writeLoopTraceJournal,
      createAgentRunner: ({ onEvent }) => {
        fakeRunner.onEvent = onEvent;
        return fakeRunner;
      },
      now: () => new Date("2026-03-06T00:00:05.000Z"),
    });

    await host.pollOnce();
    fakeRunner.emit("1", {
      event: "session_started",
      timestamp: "2026-03-06T00:00:01.000Z",
      codexAppServerPid: "1001",
      sessionId: "thread-1-turn-1",
      threadId: "thread-1",
      turnId: "turn-1",
    });
    await host.flushEvents();

    expect(entries).toContainEqual(
      expect.objectContaining({
        event: "session_started",
        issue_id: "1",
        issue_identifier: "ISSUE-1",
      }),
    );
    expect(entries).toContainEqual(
      expect.objectContaining({
        event: "loop_trace_persist_failed",
        level: "warn",
        issue_id: "1",
        reason: "disk full",
      }),
    );
  });

  it("coalesces queued loop trace persistence writes for the latest journal", async () => {
    const workspaceRoot = mkdtempSync(join(tmpdir(), "symph-loop-coalesce-"));
    try {
      const tracker = createTracker();
      const fakeRunner = new FakeAgentRunner();
      const persistedJournals: LoopTraceJournal[] = [];
      const writeLoopTraceJournal = vi.fn(async (_locator, journal) => {
        persistedJournals.push(journal);
      });
      const config = createConfig();
      config.workspace.root = workspaceRoot;
      const host = new OrchestratorRuntimeHost({
        config,
        tracker,
        writeLoopTraceJournal,
        createAgentRunner: ({ onEvent }) => {
          fakeRunner.onEvent = onEvent;
          return fakeRunner;
        },
        now: () => new Date("2026-03-06T00:00:05.000Z"),
      });

      await host.pollOnce();
      fakeRunner.emit("1", {
        event: "session_started",
        timestamp: "2026-03-06T00:00:01.000Z",
        codexAppServerPid: "1001",
        sessionId: "thread-1-turn-1",
        threadId: "thread-1",
        turnId: "turn-1",
      });
      fakeRunner.emit("1", {
        event: "turn_completed",
        timestamp: "2026-03-06T00:00:02.000Z",
        codexAppServerPid: "1001",
        sessionId: "thread-1-turn-1",
        threadId: "thread-1",
        turnId: "turn-1",
        usage: {
          inputTokens: 10,
          outputTokens: 5,
          totalTokens: 15,
        },
      });
      await host.flushEvents();

      expect(writeLoopTraceJournal).toHaveBeenCalledTimes(1);
      expect(persistedJournals[0]?.map((entry) => entry.kind)).toEqual([
        "session_start",
        "feedback_event",
      ]);
    } finally {
      rmSync(workspaceRoot, { recursive: true, force: true });
    }
  });

  it("keeps terminal loop trace details in memory when final persistence fails", async () => {
    const workspaceRoot = mkdtempSync(join(tmpdir(), "symph-loop-persist-"));
    try {
      const tracker = createTracker();
      const fakeRunner = new FakeAgentRunner();
      const entries: StructuredLogEntry[] = [];
      const logger = new StructuredLogger([
        {
          write(entry) {
            entries.push(entry);
          },
        },
      ]);
      const writeLoopTraceJournal = vi.fn(async () => {
        throw new Error("disk full");
      });
      const host = new OrchestratorRuntimeHost({
        config: createStagedConfig({
          workspace: {
            root: workspaceRoot,
          },
        }),
        tracker,
        logger,
        writeLoopTraceJournal,
        createAgentRunner: ({ onEvent }) => {
          fakeRunner.onEvent = onEvent;
          return fakeRunner;
        },
        now: () => new Date("2026-03-06T00:00:05.000Z"),
      });

      await host.pollOnce();
      fakeRunner.emit("1", {
        event: "session_started",
        timestamp: "2026-03-06T00:00:01.000Z",
        codexAppServerPid: "1001",
        sessionId: "thread-1-turn-1",
        threadId: "thread-1",
        turnId: "turn-1",
      });
      fakeRunner.resolve("1", createNormalResult());
      await host.waitForIdle();

      expect(host.getState().loopTraceJournal["1"]).toBeDefined();
      const details = await host.getIssueDetails("ISSUE-1");
      expect(details).toMatchObject({
        issue_identifier: "ISSUE-1",
        status: "completed",
      });
      expect(
        details!.loop_trace_journal.entries.map((entry) => entry.kind),
      ).toEqual(
        expect.arrayContaining([
          "session_start",
          "stage_transition",
          "worker_exit",
        ]),
      );
      expect(entries).toContainEqual(
        expect.objectContaining({
          event: "loop_trace_persist_failed",
          level: "warn",
          issue_id: "1",
          reason: "disk full",
        }),
      );
    } finally {
      rmSync(workspaceRoot, { recursive: true, force: true });
    }
  });

  it("records cancellation feedback and repo-relative file deltas in loop traces", async () => {
    const tracker = createTracker();
    const fakeRunner = new FakeAgentRunner();
    const host = new OrchestratorRuntimeHost({
      config: createConfig(),
      tracker,
      createAgentRunner: ({ onEvent }) => {
        fakeRunner.onEvent = onEvent;
        return fakeRunner;
      },
      now: () => new Date("2026-03-06T00:00:05.000Z"),
    });

    await host.pollOnce();
    fakeRunner.emit("1", {
      event: "approval_auto_approved",
      timestamp: "2026-03-06T00:00:01.000Z",
      codexAppServerPid: "1001",
      raw: {
        params: {
          toolName: "Edit",
          input: {
            file_path: "/tmp/workspaces/1/src/features/trace.ts",
          },
        },
      },
    });
    fakeRunner.emit("1", {
      event: "turn_cancelled",
      timestamp: "2026-03-06T00:00:02.000Z",
      codexAppServerPid: "1001",
      message: "turn cancelled by operator",
    });
    fakeRunner.emit("1", {
      event: "compaction",
      timestamp: "2026-03-06T00:00:02.500Z",
      codexAppServerPid: "1001",
      message: "thread/autoCompact/completed",
    });
    fakeRunner.emit("1", {
      event: "other_message",
      timestamp: "2026-03-06T00:00:03.000Z",
      codexAppServerPid: "1001",
      message: "server emitted keepalive",
    });
    await host.flushEvents();

    const details = await host.getIssueDetails("ISSUE-1");

    expect(
      details!.loop_trace_journal.entries.map((entry) => ({
        kind: entry.kind,
        summary: entry.summary,
        files: entry.file_delta?.files,
      })),
    ).toContainEqual({
      kind: "file_delta",
      summary: "Updated src/features/trace.ts.",
      files: ["src/features/trace.ts"],
    });
    expect(
      details!.loop_trace_journal.entries.map((entry) => entry.summary),
    ).toEqual(
      expect.arrayContaining([
        "turn cancelled by operator",
        "thread/autoCompact/completed",
        "server emitted keepalive",
      ]),
    );
  });

  it("emits issue and session context for agent lifecycle logs", async () => {
    const tracker = createTracker();
    const fakeRunner = new FakeAgentRunner();
    const entries: StructuredLogEntry[] = [];
    const logger = new StructuredLogger([
      {
        write(entry) {
          entries.push(entry);
        },
      },
    ]);
    const host = new OrchestratorRuntimeHost({
      config: createConfig(),
      tracker,
      logger,
      createAgentRunner: ({ onEvent }) => {
        fakeRunner.onEvent = onEvent;
        return fakeRunner;
      },
      now: () => new Date("2026-03-06T00:00:05.000Z"),
    });

    await host.pollOnce();
    fakeRunner.emit("1", {
      event: "session_started",
      timestamp: "2026-03-06T00:00:01.000Z",
      codexAppServerPid: "1001",
      sessionId: "thread-1-turn-1",
      threadId: "thread-1",
      turnId: "turn-1",
    });
    await host.flushEvents();

    expect(entries).toContainEqual(
      expect.objectContaining({
        event: "worker_spawned",
        issue_id: "1",
        issue_identifier: "ISSUE-1",
      }),
    );
    expect(entries).toContainEqual(
      expect.objectContaining({
        event: "session_started",
        issue_id: "1",
        issue_identifier: "ISSUE-1",
        session_id: "thread-1-turn-1",
      }),
    );
  });

  it("logs a triggered re-steer when live worker writes collide", async () => {
    const tracker = createTracker({
      candidates: [
        createIssue({ id: "1", identifier: "ISSUE-1" }),
        createIssue({ id: "2", identifier: "ISSUE-2", priority: 2 }),
      ],
      stateSnapshots: [
        { id: "1", identifier: "ISSUE-1", state: "In Progress" },
        { id: "2", identifier: "ISSUE-2", state: "In Progress" },
      ],
    });
    const fakeRunner = new FakeAgentRunner();
    const entries: StructuredLogEntry[] = [];
    const logger = new StructuredLogger([
      {
        write(entry) {
          entries.push(entry);
        },
      },
    ]);
    const readWorkspaceChangedFiles = vi.fn(async (workspacePath: string) =>
      workspacePath.endsWith("/1")
        ? ["CLAUDE.md", "src/shared/config.ts"]
        : ["./CLAUDE.md", "./src/shared/config.ts", "src/features/two.ts"],
    );
    const host = new OrchestratorRuntimeHost({
      config: createConfig(),
      tracker,
      logger,
      readWorkspaceChangedFiles,
      createAgentRunner: ({ onEvent }) => {
        fakeRunner.onEvent = onEvent;
        return fakeRunner;
      },
      now: () => new Date("2026-03-06T00:00:05.000Z"),
    });

    await host.pollOnce();
    await host.pollOnce();

    expect(readWorkspaceChangedFiles).toHaveBeenCalledWith("/tmp/workspaces/1");
    expect(readWorkspaceChangedFiles).toHaveBeenCalledWith("/tmp/workspaces/2");
    expect(entries).toContainEqual(
      expect.objectContaining({
        event: "supervision_resteer_requested",
        level: "warn",
        phase: "running",
        finding_count: 1,
        finding_kinds: ["actual_write_collision"],
        issue_identifiers: ["ISSUE-1", "ISSUE-2"],
        files: ["src/shared/config.ts"],
        ignored_files: ["CLAUDE.md"],
      }),
    );
  });

  it("records ignored setup-instruction overlaps without re-steering", async () => {
    const tracker = createTracker({
      candidates: [
        createIssue({ id: "1", identifier: "ISSUE-1" }),
        createIssue({ id: "2", identifier: "ISSUE-2", priority: 2 }),
      ],
      stateSnapshots: [
        { id: "1", identifier: "ISSUE-1", state: "In Progress" },
        { id: "2", identifier: "ISSUE-2", state: "In Progress" },
      ],
    });
    const fakeRunner = new FakeAgentRunner();
    const entries: StructuredLogEntry[] = [];
    const logger = new StructuredLogger([
      {
        write(entry) {
          entries.push(entry);
        },
      },
    ]);
    const readWorkspaceChangedFiles = vi.fn(async (workspacePath: string) =>
      workspacePath.endsWith("/1")
        ? ["CLAUDE.md", "src/features/one.ts"]
        : ["./CLAUDE.md", "src/features/two.ts"],
    );
    const host = new OrchestratorRuntimeHost({
      config: createConfig(),
      tracker,
      logger,
      readWorkspaceChangedFiles,
      createAgentRunner: ({ onEvent }) => {
        fakeRunner.onEvent = onEvent;
        return fakeRunner;
      },
      now: () => new Date("2026-03-06T00:00:05.000Z"),
    });

    await host.pollOnce();
    await host.pollOnce();

    expect(
      entries.some((entry) => entry.event === "supervision_resteer_requested"),
    ).toBe(false);
    expect(host.getState().dispatcherRunJournal).toContainEqual(
      expect.objectContaining({
        kind: "supervision_finding",
        summary:
          "ISSUE-1 and ISSUE-2 share setup-only instruction-file changes that were ignored for write-collision supervision.",
        metadata: expect.objectContaining({
          action: "ignored",
          files: ["CLAUDE.md"],
          findingKind: "ignored_setup_instruction_collision",
          ignored: true,
          issueIdentifiers: ["ISSUE-1", "ISSUE-2"],
          nonBlocking: true,
          workerIds: ["1", "2"],
        }),
      }),
    );
  });

  it("logs tracker follow-up write failures for bounded supervision findings", async () => {
    const tracker = new LinearTrackerClient({
      endpoint: "https://api.linear.app/graphql",
      apiKey: "token",
      projectSlug: "project",
      activeStates: ["Todo", "In Progress", "In Review", "Resume"],
      fetchFn: vi.fn(),
    });
    vi.spyOn(tracker, "fetchCandidateIssues").mockResolvedValue([
      createIssue({ id: "1", identifier: "ISSUE-1" }),
      createIssue({ id: "2", identifier: "ISSUE-2", priority: 2 }),
    ]);
    vi.spyOn(tracker, "fetchIssueStatesByIds").mockResolvedValue([
      { id: "1", identifier: "ISSUE-1", state: "In Progress" },
      { id: "2", identifier: "ISSUE-2", state: "In Progress" },
    ]);
    vi.spyOn(tracker, "fetchOpenIssuesByLabels").mockResolvedValue([]);
    vi.spyOn(tracker, "fetchIssueReferencesByIds").mockRejectedValue(
      new Error("tracker unavailable"),
    );

    const fakeRunner = new FakeAgentRunner();
    const entries: StructuredLogEntry[] = [];
    const logger = new StructuredLogger([
      {
        write(entry) {
          entries.push(entry);
        },
      },
    ]);
    const readWorkspaceChangedFiles = vi.fn(async (workspacePath: string) =>
      workspacePath.endsWith("/1")
        ? ["src/shared/config.ts"]
        : ["src/shared/config.ts", "src/features/two.ts"],
    );
    const host = new OrchestratorRuntimeHost({
      config: createConfig(),
      tracker,
      logger,
      readWorkspaceChangedFiles,
      createAgentRunner: ({ onEvent }) => {
        fakeRunner.onEvent = onEvent;
        return fakeRunner;
      },
      now: () => new Date("2026-03-06T00:00:05.000Z"),
    });

    await host.pollOnce();
    await host.pollOnce();

    expect(entries).toContainEqual(
      expect.objectContaining({
        event: "tracker_follow_up_write_failed",
        level: "warn",
        outcome: "degraded",
        title:
          "Dispatcher follow-up: actual_write_collision for ISSUE-1 + ISSUE-2",
        source_issue_ids: ["1", "2"],
        reason: "tracker unavailable",
      }),
    );
  });

  it("logs structured tracker error code, status, and diagnostics on follow-up write failures", async () => {
    const tracker = new LinearTrackerClient({
      endpoint: "https://api.linear.app/graphql",
      apiKey: "token",
      projectSlug: "project",
      activeStates: ["Todo", "In Progress", "In Review", "Resume"],
      fetchFn: vi.fn(),
    });
    vi.spyOn(tracker, "fetchCandidateIssues").mockResolvedValue([
      createIssue({ id: "1", identifier: "ISSUE-1" }),
      createIssue({ id: "2", identifier: "ISSUE-2", priority: 2 }),
    ]);
    vi.spyOn(tracker, "fetchIssueStatesByIds").mockResolvedValue([
      { id: "1", identifier: "ISSUE-1", state: "In Progress" },
      { id: "2", identifier: "ISSUE-2", state: "In Progress" },
    ]);
    vi.spyOn(tracker, "fetchOpenIssuesByLabels").mockResolvedValue([]);
    vi.spyOn(tracker, "fetchIssueReferencesByIds").mockResolvedValue([
      {
        id: "1",
        identifier: "ISSUE-1",
        title: "First issue",
        description: null,
        url: null,
        teamId: "team-1",
        teamKey: "SYMPH",
        projectId: "project-1",
        projectSlug: "symphony",
        labels: [],
        parent: null,
      },
    ]);
    const labelDiagnostics = {
      operationName: "SymphonyIssueLabelsByNames",
      variables: { teamKey: "SYMPH", labelNames: ["supervision"] },
    };
    vi.spyOn(tracker, "resolveLabelIdsByNames").mockRejectedValue(
      new TrackerError(
        ERROR_CODES.linearApiStatus,
        "Linear API request failed with HTTP 400.",
        { status: 400, details: labelDiagnostics },
      ),
    );

    const fakeRunner = new FakeAgentRunner();
    const entries: StructuredLogEntry[] = [];
    const logger = new StructuredLogger([
      {
        write(entry) {
          entries.push(entry);
        },
      },
    ]);
    const readWorkspaceChangedFiles = vi.fn(async (workspacePath: string) =>
      workspacePath.endsWith("/1")
        ? ["src/shared/config.ts"]
        : ["src/shared/config.ts", "src/features/two.ts"],
    );
    const host = new OrchestratorRuntimeHost({
      config: createConfig(),
      tracker,
      logger,
      readWorkspaceChangedFiles,
      createAgentRunner: ({ onEvent }) => {
        fakeRunner.onEvent = onEvent;
        return fakeRunner;
      },
      now: () => new Date("2026-03-06T00:00:05.000Z"),
    });

    await host.pollOnce();
    await host.pollOnce();

    expect(entries).toContainEqual(
      expect.objectContaining({
        event: "tracker_follow_up_write_failed",
        level: "warn",
        outcome: "degraded",
        title:
          "Dispatcher follow-up: actual_write_collision for ISSUE-1 + ISSUE-2",
        source_issue_ids: ["1", "2"],
        reason: "Linear API request failed with HTTP 400.",
        error_code: ERROR_CODES.linearApiStatus,
        http_status: 400,
        // Serialized JSON, never "[object Object]" (SYMPH-413).
        details: JSON.stringify(labelDiagnostics),
      }),
    );
  });

  it("emits a tracker_write_failed Slack alert with serialized details on follow-up write failures", async () => {
    const tracker = new LinearTrackerClient({
      endpoint: "https://api.linear.app/graphql",
      apiKey: "token",
      projectSlug: "project",
      activeStates: ["Todo", "In Progress", "In Review"],
      fetchFn: vi.fn(),
    });
    vi.spyOn(tracker, "fetchCandidateIssues").mockResolvedValue([
      createIssue({ id: "1", identifier: "ISSUE-1" }),
      createIssue({ id: "2", identifier: "ISSUE-2", priority: 2 }),
    ]);
    vi.spyOn(tracker, "fetchIssueStatesByIds").mockResolvedValue([
      { id: "1", identifier: "ISSUE-1", state: "In Progress" },
      { id: "2", identifier: "ISSUE-2", state: "In Progress" },
    ]);
    vi.spyOn(tracker, "fetchOpenIssuesByLabels").mockResolvedValue([]);
    const writeDiagnostics = {
      operationName: "SymphonyOpenIssuesByTitle",
      variables: { projectId: "project-1" },
      responseBody: {
        errors: [
          {
            message:
              'Variable "$projectId" of type "String!" used in position expecting type "ID".',
            extensions: { code: "GRAPHQL_VALIDATION_FAILED" },
          },
        ],
      },
    };
    vi.spyOn(tracker, "fetchIssueReferencesByIds").mockRejectedValue(
      new TrackerError(
        ERROR_CODES.linearApiStatus,
        "Linear API request failed with HTTP 400.",
        { status: 400, details: writeDiagnostics },
      ),
    );

    const fakeRunner = new FakeAgentRunner();
    const notifierEvents: PipelineNotificationEvent[] = [];
    const readWorkspaceChangedFiles = vi.fn(async (workspacePath: string) =>
      workspacePath.endsWith("/1")
        ? ["src/shared/config.ts"]
        : ["src/shared/config.ts", "src/features/two.ts"],
    );
    const host = new OrchestratorRuntimeHost({
      config: createConfig(),
      tracker,
      notifier: {
        notify(event: PipelineNotificationEvent) {
          notifierEvents.push(event);
        },
      },
      readWorkspaceChangedFiles,
      createAgentRunner: ({ onEvent }) => {
        fakeRunner.onEvent = onEvent;
        return fakeRunner;
      },
      now: () => new Date("2026-03-06T00:00:05.000Z"),
    });

    await host.pollOnce();
    await host.pollOnce();

    expect(notifierEvents).toContainEqual(
      expect.objectContaining({
        type: "tracker_write_failed",
        followUpTitle:
          "Dispatcher follow-up: actual_write_collision for ISSUE-1 + ISSUE-2",
        sourceIssueIds: ["1", "2"],
        reason: "Linear API request failed with HTTP 400.",
        httpStatus: 400,
        details: JSON.stringify(writeDiagnostics),
      }),
    );
    const alert = notifierEvents.find(
      (event) => event.type === "tracker_write_failed",
    );
    expect(alert).toBeDefined();
    if (alert !== undefined && alert.type === "tracker_write_failed") {
      expect(alert.details).not.toContain("[object Object]");
      expect(alert.details).toContain("GRAPHQL_VALIDATION_FAILED");
    }
  });

  it("truncates oversized tracker_write_failed details at the 500-char Slack bound", async () => {
    const tracker = new LinearTrackerClient({
      endpoint: "https://api.linear.app/graphql",
      apiKey: "token",
      projectSlug: "project",
      activeStates: ["Todo", "In Progress", "In Review"],
      fetchFn: vi.fn(),
    });
    vi.spyOn(tracker, "fetchCandidateIssues").mockResolvedValue([
      createIssue({ id: "1", identifier: "ISSUE-1" }),
      createIssue({ id: "2", identifier: "ISSUE-2", priority: 2 }),
    ]);
    vi.spyOn(tracker, "fetchIssueStatesByIds").mockResolvedValue([
      { id: "1", identifier: "ISSUE-1", state: "In Progress" },
      { id: "2", identifier: "ISSUE-2", state: "In Progress" },
    ]);
    vi.spyOn(tracker, "fetchOpenIssuesByLabels").mockResolvedValue([]);
    // A diagnostic payload whose serialized form far exceeds the 500-char
    // Slack bound, so the notifier-path truncation is actually exercised
    // (SYMPH-413 council finding: the existing fixture was ~271 chars).
    const writeDiagnostics = {
      operationName: "SymphonyOpenIssuesByTitle",
      responseBody: { errors: [{ message: "x".repeat(2_000) }] },
    };
    vi.spyOn(tracker, "fetchIssueReferencesByIds").mockRejectedValue(
      new TrackerError(
        ERROR_CODES.linearApiStatus,
        "Linear API request failed with HTTP 400.",
        { status: 400, details: writeDiagnostics },
      ),
    );

    const fakeRunner = new FakeAgentRunner();
    const notifierEvents: PipelineNotificationEvent[] = [];
    const readWorkspaceChangedFiles = vi.fn(async (workspacePath: string) =>
      workspacePath.endsWith("/1")
        ? ["src/shared/config.ts"]
        : ["src/shared/config.ts", "src/features/two.ts"],
    );
    const host = new OrchestratorRuntimeHost({
      config: createConfig(),
      tracker,
      notifier: {
        notify(event: PipelineNotificationEvent) {
          notifierEvents.push(event);
        },
      },
      readWorkspaceChangedFiles,
      createAgentRunner: ({ onEvent }) => {
        fakeRunner.onEvent = onEvent;
        return fakeRunner;
      },
      now: () => new Date("2026-03-06T00:00:05.000Z"),
    });

    await host.pollOnce();
    await host.pollOnce();

    const alert = notifierEvents.find(
      (event) => event.type === "tracker_write_failed",
    );
    expect(alert).toBeDefined();
    if (alert !== undefined && alert.type === "tracker_write_failed") {
      expect(alert.details).not.toBeNull();
      expect(alert.details?.length).toBeLessThanOrEqual(500);
      expect(alert.details?.endsWith("…[truncated]")).toBe(true);
    }
  });

  it("logs a triggered re-steer when a worker branch base changes after admission", async () => {
    const tracker = createTracker();
    const fakeRunner = new FakeAgentRunner();
    const entries: StructuredLogEntry[] = [];
    const logger = new StructuredLogger([
      {
        write(entry) {
          entries.push(entry);
        },
      },
    ]);
    const readWorkspaceBaseRevision = vi
      .fn<(_: string) => Promise<string | null>>()
      .mockResolvedValueOnce("base-a")
      .mockResolvedValueOnce("base-b");
    const host = new OrchestratorRuntimeHost({
      config: createConfig(),
      tracker,
      logger,
      readWorkspaceBaseRevision,
      createAgentRunner: ({ onEvent }) => {
        fakeRunner.onEvent = onEvent;
        return fakeRunner;
      },
      now: () => new Date("2026-03-06T00:00:05.000Z"),
    });

    await host.pollOnce();
    await host.pollOnce();
    await host.pollOnce();

    expect(readWorkspaceBaseRevision).toHaveBeenCalledWith("/tmp/workspaces/1");
    expect(entries).toContainEqual(
      expect.objectContaining({
        event: "supervision_resteer_requested",
        level: "warn",
        phase: "running",
        finding_count: 1,
        finding_kinds: ["branch_divergence"],
        issue_identifiers: ["ISSUE-1"],
      }),
    );
  });

  it("logs turn_number, prompt_chars, and estimated_prompt_tokens for turn_completed events", async () => {
    const tracker = createTracker();
    const fakeRunner = new FakeAgentRunner();
    const entries: StructuredLogEntry[] = [];
    const logger = new StructuredLogger([
      {
        write(entry) {
          entries.push(entry);
        },
      },
    ]);
    const host = new OrchestratorRuntimeHost({
      config: createConfig(),
      tracker,
      logger,
      createAgentRunner: ({ onEvent }) => {
        fakeRunner.onEvent = onEvent;
        return fakeRunner;
      },
      now: () => new Date("2026-03-06T00:00:05.000Z"),
    });

    await host.pollOnce();
    fakeRunner.emit("1", {
      event: "turn_completed",
      timestamp: "2026-03-06T00:00:02.000Z",
      codexAppServerPid: "1001",
      sessionId: "thread-1-turn-1",
      threadId: "thread-1",
      turnId: "turn-1",
      turnCount: 1,
      promptChars: 1200,
      estimatedPromptTokens: 300,
      usage: {
        inputTokens: 100,
        outputTokens: 50,
        totalTokens: 150,
      },
      message: "turn done",
    });
    await host.flushEvents();

    const turnCompletedEntry = entries.find(
      (e) => e.event === "turn_completed",
    );
    expect(turnCompletedEntry).toBeDefined();
    expect(turnCompletedEntry).toMatchObject({
      event: "turn_completed",
      turn_number: 1,
      prompt_chars: 1200,
      estimated_prompt_tokens: 300,
    });
  });

  it("emits stage_completed event on normal worker exit with token and turn fields", async () => {
    const tracker = createTracker();
    const fakeRunner = new FakeAgentRunner();
    const entries: StructuredLogEntry[] = [];
    const logger = new StructuredLogger([
      {
        write(entry) {
          entries.push(entry);
        },
      },
    ]);
    const host = new OrchestratorRuntimeHost({
      config: createConfig(),
      tracker,
      logger,
      createAgentRunner: ({ onEvent }) => {
        fakeRunner.onEvent = onEvent;
        return fakeRunner;
      },
      now: () => new Date("2026-03-06T00:00:05.000Z"),
    });

    await host.pollOnce();
    fakeRunner.resolve("1", {
      issue: createIssue({ state: "In Progress" }),
      workspace: {
        path: "/tmp/workspaces/1",
        workspaceKey: "1",
        createdNow: true,
      },
      runAttempt: {
        issueId: "1",
        issueIdentifier: "ISSUE-1",
        attempt: null,
        workspacePath: "/tmp/workspaces/1",
        startedAt: "2026-03-06T00:00:00.000Z",
        status: "succeeded",
      },
      liveSession: {
        sessionId: "thread-1-turn-1",
        threadId: "thread-1",
        turnId: "turn-1",
        codexAppServerPid: "1001",
        codexAppServerIdentity: null,
        lastCodexEvent: "turn_completed",
        lastCodexTimestamp: "2026-03-06T00:00:02.000Z",
        lastCodexMessage: "done",
        codexInputTokens: 100,
        codexOutputTokens: 50,
        codexTotalTokens: 150,
        codexCacheReadTokens: 10,
        codexCacheWriteTokens: 5,
        codexNoCacheTokens: 0,
        codexReasoningTokens: 20,
        codexTotalInputTokens: 280,
        codexTotalOutputTokens: 140,
        lastReportedInputTokens: 100,
        lastReportedOutputTokens: 50,
        lastReportedTotalTokens: 150,
        lastReportedCacheReadTokens: 0,
        lastReportedCacheWriteTokens: 0,
        lastReportedNoCacheTokens: 0,
        lastReportedReasoningTokens: 0,
        turnCount: 3,
        totalStageInputTokens: 300,
        totalStageOutputTokens: 150,
        totalStageTotalTokens: 450,
        totalStageCacheReadTokens: 30,
        totalStageCacheWriteTokens: 15,
        turnHistory: [],
        recentActivity: [],
        tokenTelemetry: [],
        tokenTelemetryObservedCount: 0,
        codexSessionLogs: [],
        rateLimitWindows: {
          primary: null,
          secondary: null,
        },
      },
      turnsCompleted: 3,
      lastTurn: null,
      rateLimits: null,
    });
    await host.waitForIdle();

    const stageCompletedEntry = entries.find(
      (e) => e.event === "stage_completed",
    );
    expect(stageCompletedEntry).toBeDefined();
    expect(stageCompletedEntry).toMatchObject({
      event: "stage_completed",
      level: "info",
      issue_id: "1",
      issue_identifier: "ISSUE-1",
      session_id: "thread-1-turn-1",
      stage_name: null,
      input_tokens: 100,
      output_tokens: 50,
      total_tokens: 150,
      cache_read_tokens: 10,
      cache_write_tokens: 5,
      reasoning_tokens: 20,
      turns_used: 3,
      total_input_tokens: 300,
      total_output_tokens: 150,
      total_total_tokens: 450,
      total_cache_read_tokens: 30,
      total_cache_write_tokens: 15,
      turn_count: 3,
      duration_ms: 5000,
      outcome: "completed",
    });
  });

  it("emits stage_completed event on abnormal worker exit with outcome failed", async () => {
    const tracker = createTracker();
    const fakeRunner = new FakeAgentRunner();
    const entries: StructuredLogEntry[] = [];
    const logger = new StructuredLogger([
      {
        write(entry) {
          entries.push(entry);
        },
      },
    ]);
    const host = new OrchestratorRuntimeHost({
      config: createConfig(),
      tracker,
      logger,
      createAgentRunner: ({ onEvent }) => {
        fakeRunner.onEvent = onEvent;
        return fakeRunner;
      },
      now: () => new Date("2026-03-06T00:00:05.000Z"),
    });

    await host.pollOnce();
    fakeRunner.reject("1", new Error("something went wrong"));
    await host.waitForIdle();

    const stageCompletedEntry = entries.find(
      (e) => e.event === "stage_completed",
    );
    expect(stageCompletedEntry).toBeDefined();
    expect(stageCompletedEntry).toMatchObject({
      event: "stage_completed",
      level: "info",
      issue_id: "1",
      issue_identifier: "ISSUE-1",
      stage_name: null,
      input_tokens: 0,
      output_tokens: 0,
      total_tokens: 0,
      turns_used: 0,
      total_input_tokens: 0,
      total_output_tokens: 0,
      total_total_tokens: 0,
      turn_count: 0,
      duration_ms: 0,
      outcome: "failed",
    });
  });

  it("emits stage_completed with correct stage_name when stages are configured", async () => {
    const tracker = createTracker();
    const fakeRunner = new FakeAgentRunner();
    const entries: StructuredLogEntry[] = [];
    const logger = new StructuredLogger([
      {
        write(entry) {
          entries.push(entry);
        },
      },
    ]);
    const host = new OrchestratorRuntimeHost({
      config: createStagedConfig(),
      tracker,
      logger,
      createAgentRunner: ({ onEvent }) => {
        fakeRunner.onEvent = onEvent;
        return fakeRunner;
      },
      now: () => new Date("2026-03-06T00:00:05.000Z"),
    });

    await host.pollOnce();
    fakeRunner.resolve("1", {
      issue: createIssue({ state: "In Progress" }),
      workspace: {
        path: "/tmp/workspaces/1",
        workspaceKey: "1",
        createdNow: true,
      },
      runAttempt: {
        issueId: "1",
        issueIdentifier: "ISSUE-1",
        attempt: null,
        workspacePath: "/tmp/workspaces/1",
        startedAt: "2026-03-06T00:00:00.000Z",
        status: "succeeded",
      },
      liveSession: {
        sessionId: "thread-1-turn-1",
        threadId: "thread-1",
        turnId: "turn-1",
        codexAppServerPid: "1001",
        codexAppServerIdentity: null,
        lastCodexEvent: "turn_completed",
        lastCodexTimestamp: "2026-03-06T00:00:02.000Z",
        lastCodexMessage: "done",
        codexInputTokens: 30,
        codexOutputTokens: 20,
        codexTotalTokens: 50,
        codexCacheReadTokens: 0,
        codexCacheWriteTokens: 0,
        codexNoCacheTokens: 0,
        codexReasoningTokens: 0,
        codexTotalInputTokens: 60,
        codexTotalOutputTokens: 40,
        lastReportedInputTokens: 30,
        lastReportedOutputTokens: 20,
        lastReportedTotalTokens: 50,
        lastReportedCacheReadTokens: 0,
        lastReportedCacheWriteTokens: 0,
        lastReportedNoCacheTokens: 0,
        lastReportedReasoningTokens: 0,
        turnCount: 2,
        totalStageInputTokens: 0,
        totalStageOutputTokens: 0,
        totalStageTotalTokens: 0,
        totalStageCacheReadTokens: 0,
        totalStageCacheWriteTokens: 0,
        turnHistory: [],
        recentActivity: [],
        tokenTelemetry: [],
        tokenTelemetryObservedCount: 0,
        codexSessionLogs: [],
        rateLimitWindows: {
          primary: null,
          secondary: null,
        },
      },
      turnsCompleted: 2,
      lastTurn: null,
      rateLimits: null,
    });
    await host.waitForIdle();

    const stageCompletedEntry = entries.find(
      (e) => e.event === "stage_completed",
    );
    expect(stageCompletedEntry).toBeDefined();
    expect(stageCompletedEntry).toMatchObject({
      event: "stage_completed",
      stage_name: "investigate",
      turns_used: 2,
      turn_count: 2,
    });
  });

  it("includes no_cache_tokens in stage_completed when codexNoCacheTokens is non-zero", async () => {
    const tracker = createTracker();
    const fakeRunner = new FakeAgentRunner();
    const entries: StructuredLogEntry[] = [];
    const logger = new StructuredLogger([
      {
        write(entry) {
          entries.push(entry);
        },
      },
    ]);
    const host = new OrchestratorRuntimeHost({
      config: createConfig(),
      tracker,
      logger,
      createAgentRunner: ({ onEvent }) => {
        fakeRunner.onEvent = onEvent;
        return fakeRunner;
      },
      now: () => new Date("2026-03-06T00:00:05.000Z"),
    });

    await host.pollOnce();
    fakeRunner.resolve("1", {
      issue: createIssue({ state: "In Progress" }),
      workspace: {
        path: "/tmp/workspaces/1",
        workspaceKey: "1",
        createdNow: true,
      },
      runAttempt: {
        issueId: "1",
        issueIdentifier: "ISSUE-1",
        attempt: null,
        workspacePath: "/tmp/workspaces/1",
        startedAt: "2026-03-06T00:00:00.000Z",
        status: "succeeded",
      },
      liveSession: {
        sessionId: "thread-1-turn-1",
        threadId: "thread-1",
        turnId: "turn-1",
        codexAppServerPid: "1001",
        codexAppServerIdentity: null,
        lastCodexEvent: "turn_completed",
        lastCodexTimestamp: "2026-03-06T00:00:02.000Z",
        lastCodexMessage: "done",
        codexInputTokens: 100,
        codexOutputTokens: 50,
        codexTotalTokens: 150,
        codexCacheReadTokens: 0,
        codexCacheWriteTokens: 0,
        codexNoCacheTokens: 42,
        codexReasoningTokens: 0,
        codexTotalInputTokens: 100,
        codexTotalOutputTokens: 50,
        lastReportedInputTokens: 100,
        lastReportedOutputTokens: 50,
        lastReportedTotalTokens: 150,
        lastReportedCacheReadTokens: 0,
        lastReportedCacheWriteTokens: 0,
        lastReportedNoCacheTokens: 0,
        lastReportedReasoningTokens: 0,
        turnCount: 1,
        totalStageInputTokens: 0,
        totalStageOutputTokens: 0,
        totalStageTotalTokens: 0,
        totalStageCacheReadTokens: 0,
        totalStageCacheWriteTokens: 0,
        turnHistory: [],
        recentActivity: [],
        tokenTelemetry: [],
        tokenTelemetryObservedCount: 0,
        codexSessionLogs: [],
        rateLimitWindows: {
          primary: null,
          secondary: null,
        },
      },
      turnsCompleted: 1,
      lastTurn: null,
      rateLimits: null,
    });
    await host.waitForIdle();

    const stageCompletedEntry = entries.find(
      (e) => e.event === "stage_completed",
    );
    expect(stageCompletedEntry).toBeDefined();
    expect(stageCompletedEntry).toMatchObject({
      event: "stage_completed",
      no_cache_tokens: 42,
    });
  });

  it("omits no_cache_tokens from stage_completed when codexNoCacheTokens is zero", async () => {
    const tracker = createTracker();
    const fakeRunner = new FakeAgentRunner();
    const entries: StructuredLogEntry[] = [];
    const logger = new StructuredLogger([
      {
        write(entry) {
          entries.push(entry);
        },
      },
    ]);
    const host = new OrchestratorRuntimeHost({
      config: createConfig(),
      tracker,
      logger,
      createAgentRunner: ({ onEvent }) => {
        fakeRunner.onEvent = onEvent;
        return fakeRunner;
      },
      now: () => new Date("2026-03-06T00:00:05.000Z"),
    });

    await host.pollOnce();
    fakeRunner.resolve("1", {
      issue: createIssue({ state: "In Progress" }),
      workspace: {
        path: "/tmp/workspaces/1",
        workspaceKey: "1",
        createdNow: true,
      },
      runAttempt: {
        issueId: "1",
        issueIdentifier: "ISSUE-1",
        attempt: null,
        workspacePath: "/tmp/workspaces/1",
        startedAt: "2026-03-06T00:00:00.000Z",
        status: "succeeded",
      },
      liveSession: {
        sessionId: "thread-1-turn-1",
        threadId: "thread-1",
        turnId: "turn-1",
        codexAppServerPid: "1001",
        codexAppServerIdentity: null,
        lastCodexEvent: "turn_completed",
        lastCodexTimestamp: "2026-03-06T00:00:02.000Z",
        lastCodexMessage: "done",
        codexInputTokens: 100,
        codexOutputTokens: 50,
        codexTotalTokens: 150,
        codexCacheReadTokens: 0,
        codexCacheWriteTokens: 0,
        codexNoCacheTokens: 0,
        codexReasoningTokens: 0,
        codexTotalInputTokens: 100,
        codexTotalOutputTokens: 50,
        lastReportedInputTokens: 100,
        lastReportedOutputTokens: 50,
        lastReportedTotalTokens: 150,
        lastReportedCacheReadTokens: 0,
        lastReportedCacheWriteTokens: 0,
        lastReportedNoCacheTokens: 0,
        lastReportedReasoningTokens: 0,
        turnCount: 1,
        totalStageInputTokens: 0,
        totalStageOutputTokens: 0,
        totalStageTotalTokens: 0,
        totalStageCacheReadTokens: 0,
        totalStageCacheWriteTokens: 0,
        turnHistory: [],
        recentActivity: [],
        tokenTelemetry: [],
        tokenTelemetryObservedCount: 0,
        codexSessionLogs: [],
        rateLimitWindows: {
          primary: null,
          secondary: null,
        },
      },
      turnsCompleted: 1,
      lastTurn: null,
      rateLimits: null,
    });
    await host.waitForIdle();

    const stageCompletedEntry = entries.find(
      (e) => e.event === "stage_completed",
    );
    expect(stageCompletedEntry).toBeDefined();
    expect(stageCompletedEntry).not.toHaveProperty("no_cache_tokens");
  });

  it("aggregates total_input_tokens and total_output_tokens across multiple turns in stage_completed", async () => {
    const tracker = createTracker();
    const fakeRunner = new FakeAgentRunner();
    const entries: StructuredLogEntry[] = [];
    const logger = new StructuredLogger([
      {
        write(entry) {
          entries.push(entry);
        },
      },
    ]);
    const host = new OrchestratorRuntimeHost({
      config: createConfig(),
      tracker,
      logger,
      createAgentRunner: ({ onEvent }) => {
        fakeRunner.onEvent = onEvent;
        return fakeRunner;
      },
      now: () => new Date("2026-03-06T00:00:05.000Z"),
    });

    await host.pollOnce();

    // Turn 1: 100 input, 40 output
    fakeRunner.emit("1", {
      event: "session_started",
      timestamp: "2026-03-06T00:00:01.000Z",
      codexAppServerPid: "1001",
      sessionId: "thread-1-turn-1",
      threadId: "thread-1",
      turnId: "turn-1",
    });
    fakeRunner.emit("1", {
      event: "turn_completed",
      timestamp: "2026-03-06T00:00:02.000Z",
      codexAppServerPid: "1001",
      sessionId: "thread-1-turn-1",
      threadId: "thread-1",
      turnId: "turn-1",
      usage: {
        inputTokens: 100,
        outputTokens: 40,
        totalTokens: 140,
        cacheReadTokens: 5,
        cacheWriteTokens: 3,
      },
      message: "turn 1 done",
    });

    // Turn 2: 120 input, 60 output (absolute counters reset per turn)
    fakeRunner.emit("1", {
      event: "session_started",
      timestamp: "2026-03-06T00:00:03.000Z",
      codexAppServerPid: "1001",
      sessionId: "thread-1-turn-2",
      threadId: "thread-1",
      turnId: "turn-2",
    });
    fakeRunner.emit("1", {
      event: "turn_completed",
      timestamp: "2026-03-06T00:00:04.000Z",
      codexAppServerPid: "1001",
      sessionId: "thread-1-turn-2",
      threadId: "thread-1",
      turnId: "turn-2",
      usage: {
        inputTokens: 120,
        outputTokens: 60,
        totalTokens: 180,
        cacheReadTokens: 8,
        cacheWriteTokens: 4,
      },
      message: "turn 2 done",
    });
    await host.flushEvents();

    fakeRunner.resolve("1", {
      issue: createIssue({ state: "In Progress" }),
      workspace: {
        path: "/tmp/workspaces/1",
        workspaceKey: "1",
        createdNow: true,
      },
      runAttempt: {
        issueId: "1",
        issueIdentifier: "ISSUE-1",
        attempt: null,
        workspacePath: "/tmp/workspaces/1",
        startedAt: "2026-03-06T00:00:00.000Z",
        status: "succeeded",
      },
      liveSession: {
        sessionId: "thread-1-turn-2",
        threadId: "thread-1",
        turnId: "turn-2",
        codexAppServerPid: "1001",
        codexAppServerIdentity: null,
        lastCodexEvent: "turn_completed",
        lastCodexTimestamp: "2026-03-06T00:00:04.000Z",
        lastCodexMessage: "turn 2 done",
        codexInputTokens: 120,
        codexOutputTokens: 60,
        codexTotalTokens: 180,
        codexCacheReadTokens: 13,
        codexCacheWriteTokens: 7,
        codexNoCacheTokens: 0,
        codexReasoningTokens: 0,
        codexTotalInputTokens: 220,
        codexTotalOutputTokens: 100,
        lastReportedInputTokens: 120,
        lastReportedOutputTokens: 60,
        lastReportedTotalTokens: 180,
        lastReportedCacheReadTokens: 0,
        lastReportedCacheWriteTokens: 0,
        lastReportedNoCacheTokens: 0,
        lastReportedReasoningTokens: 0,
        turnCount: 4,
        totalStageInputTokens: 220,
        totalStageOutputTokens: 100,
        totalStageTotalTokens: 320,
        totalStageCacheReadTokens: 13,
        totalStageCacheWriteTokens: 7,
        turnHistory: [],
        recentActivity: [],
        tokenTelemetry: [],
        tokenTelemetryObservedCount: 0,
        codexSessionLogs: [],
        rateLimitWindows: {
          primary: null,
          secondary: null,
        },
      },
      turnsCompleted: 4,
      lastTurn: null,
      rateLimits: null,
    });
    await host.waitForIdle();

    const stageCompletedEntry = entries.find(
      (e) => e.event === "stage_completed",
    );
    expect(stageCompletedEntry).toBeDefined();
    expect(stageCompletedEntry).toMatchObject({
      event: "stage_completed",
      total_input_tokens: 220,
      total_output_tokens: 100,
      total_total_tokens: 320,
      total_cache_read_tokens: 13,
      total_cache_write_tokens: 7,
      turn_count: 4,
    });
  });
});

describe("startRuntimeService shutdown", () => {
  it("aborts running workers before waiting for idle on shutdown", async () => {
    const tracker = createTracker();
    const fakeRunner = new FakeAgentRunner();
    const entries: StructuredLogEntry[] = [];
    const logger = new StructuredLogger([
      {
        write(entry) {
          entries.push(entry);
        },
      },
    ]);

    const service = await startRuntimeService({
      config: createConfig(),
      tracker,
      logger,
      workflowWatcher: null,
      runtimeHost: new OrchestratorRuntimeHost({
        config: createConfig(),
        tracker,
        logger,
        createAgentRunner: ({ onEvent }) => {
          fakeRunner.onEvent = onEvent;
          return fakeRunner;
        },
        now: () => new Date("2026-03-06T00:00:05.000Z"),
      }),
    });

    // Wait for the initial poll to dispatch the worker
    await service.runtimeHost.flushEvents();

    // Call shutdown — should abort all workers
    await service.shutdown();

    expect(fakeRunner.abortReasons).toContain(SERVICE_SHUTDOWN_ABORT_REASON);
  });

  it("proceeds with exit after shutdown timeout if waitForIdle hangs", async () => {
    const tracker = createTracker();
    const entries: StructuredLogEntry[] = [];
    const logger = new StructuredLogger([
      {
        write(entry) {
          entries.push(entry);
        },
      },
    ]);

    // A runner that never settles — ignores abort signals
    const hangingRunner = {
      run(_input: Parameters<FakeAgentRunner["run"]>[0]): Promise<never> {
        return new Promise(() => {
          /* never resolves */
        });
      },
    };

    const service = await startRuntimeService({
      config: createConfig(),
      tracker,
      logger,
      workflowWatcher: null,
      shutdownTimeoutMs: 50,
      runtimeHost: new OrchestratorRuntimeHost({
        config: createConfig(),
        tracker,
        logger,
        agentRunner: hangingRunner,
        now: () => new Date("2026-03-06T00:00:05.000Z"),
      }),
    });

    // Wait for the initial poll to dispatch the worker
    await service.runtimeHost.flushEvents();

    // Shutdown should complete within a reasonable time despite the hanging runner
    const shutdownStart = Date.now();
    await service.shutdown();
    const elapsed = Date.now() - shutdownStart;

    // Should have completed well within a second (timeout is 50ms)
    expect(elapsed).toBeLessThan(5_000);

    const timeoutEntry = entries.find(
      (e) => e.event === "shutdown_idle_timeout",
    );
    expect(timeoutEntry).toBeDefined();
  });

  it("logs shutdown_complete event with correct fields after clean shutdown", async () => {
    const tracker = createTracker();
    const fakeRunner = new FakeAgentRunner();
    const entries: StructuredLogEntry[] = [];
    const logger = new StructuredLogger([
      {
        write(entry) {
          entries.push(entry);
        },
      },
    ]);

    const service = await startRuntimeService({
      config: createConfig(),
      tracker,
      logger,
      workflowWatcher: null,
      runtimeHost: new OrchestratorRuntimeHost({
        config: createConfig(),
        tracker,
        logger,
        createAgentRunner: ({ onEvent }) => {
          fakeRunner.onEvent = onEvent;
          return fakeRunner;
        },
        now: () => new Date("2026-03-06T00:00:05.000Z"),
      }),
    });

    // Wait for initial poll to dispatch worker
    await service.runtimeHost.flushEvents();

    // Call shutdown
    await service.shutdown();

    const completeEntry = entries.find((e) => e.event === "shutdown_complete");
    expect(completeEntry).toBeDefined();
    expect(completeEntry).toHaveProperty("workers_aborted");
    expect(typeof completeEntry?.workers_aborted).toBe("number");
    expect(completeEntry).toHaveProperty("timed_out", false);
    expect(completeEntry).toHaveProperty("duration_ms");
    expect(typeof completeEntry?.duration_ms).toBe("number");
  });

  it("logs shutdown_complete with timed_out=true when shutdown timeout fires", async () => {
    const tracker = createTracker();
    const entries: StructuredLogEntry[] = [];
    const logger = new StructuredLogger([
      {
        write(entry) {
          entries.push(entry);
        },
      },
    ]);

    // A runner that never settles — ignores abort signals
    const hangingRunner = {
      run(_input: Parameters<FakeAgentRunner["run"]>[0]): Promise<never> {
        return new Promise(() => {
          /* never resolves */
        });
      },
    };

    const service = await startRuntimeService({
      config: createConfig(),
      tracker,
      logger,
      workflowWatcher: null,
      shutdownTimeoutMs: 50,
      runtimeHost: new OrchestratorRuntimeHost({
        config: createConfig(),
        tracker,
        logger,
        agentRunner: hangingRunner,
        now: () => new Date("2026-03-06T00:00:05.000Z"),
      }),
    });

    // Wait for initial poll to dispatch worker
    await service.runtimeHost.flushEvents();

    // Shutdown should complete after timeout
    await service.shutdown();

    const completeEntry = entries.find((e) => e.event === "shutdown_complete");
    expect(completeEntry).toBeDefined();
    expect(completeEntry).toHaveProperty("timed_out", true);
    expect(completeEntry).toHaveProperty("workers_aborted");
    expect(typeof completeEntry?.duration_ms).toBe("number");
  });
});

describe("startRuntimeService continuous-feedback preflight (SYMPH-761)", () => {
  function preflightConfig(
    preflightFailClosed: boolean,
  ): ResolvedWorkflowConfig {
    const config = createConfig();
    config.continuousFeedback = {
      enabled: true,
      events: ["checkpoint"],
      runner: "pi",
      model: "ds4-studio2/missing-model",
      role: "continuous-feedback",
      bounceOnFinding: true,
      preflightFailClosed,
    };
    return config;
  }

  const unavailableCommand = async () => ({
    exitCode: 1,
    stderr: "model not found: ds4-studio2/missing-model",
    stdout: "",
  });

  it("fails startup closed through startRuntimeService when fail-closed and the model is unavailable", async () => {
    await expect(
      startRuntimeService({
        config: preflightConfig(true),
        tracker: createTracker(),
        workflowWatcher: null,
        runContinuousFeedbackCommand: unavailableCommand,
      }),
    ).rejects.toBeInstanceOf(RuntimeHostStartupError);
  });

  it("starts (warn-not-block) through startRuntimeService when the model is unavailable but not fail-closed", async () => {
    const service = await startRuntimeService({
      config: preflightConfig(false),
      tracker: createTracker(),
      workflowWatcher: null,
      runContinuousFeedbackCommand: unavailableCommand,
    });

    const snapshot = await service.runtimeHost.getRuntimeSnapshot();
    expect(snapshot.continuous_feedback_preflight).toMatchObject({
      available: false,
      model: "ds4-studio2/missing-model",
      runner: "pi",
    });

    await service.shutdown();
  });
});

describe("startRuntimeService poll_tick_completed", () => {
  it("logs poll_tick_completed event after a successful poll", async () => {
    const tracker = createTracker({ candidates: [] });
    const entries: StructuredLogEntry[] = [];
    const logger = new StructuredLogger([
      {
        write(entry) {
          entries.push(entry);
        },
      },
    ]);

    const service = await startRuntimeService({
      config: createConfig(),
      tracker,
      logger,
      workflowWatcher: null,
      runtimeHost: new OrchestratorRuntimeHost({
        config: createConfig(),
        tracker,
        logger,
        agentRunner: new FakeAgentRunner(),
        now: () => new Date("2026-03-06T00:00:05.000Z"),
      }),
    });

    await service.runtimeHost.flushEvents();
    await service.shutdown();

    const tickEntry = entries.find((e) => e.event === "poll_tick_completed");
    expect(tickEntry).toBeDefined();
    expect(tickEntry).toHaveProperty("dispatched_count");
    expect(tickEntry).toHaveProperty("running_count");
    expect(tickEntry).toHaveProperty("reconciled_stop_requests");
    expect(typeof tickEntry?.duration_ms).toBe("number");
  });

  it("logs poll_tick_completed with dispatched_count reflecting newly dispatched issues", async () => {
    const tracker = createTracker();
    const entries: StructuredLogEntry[] = [];
    const logger = new StructuredLogger([
      {
        write(entry) {
          entries.push(entry);
        },
      },
    ]);

    const service = await startRuntimeService({
      config: createConfig(),
      tracker,
      logger,
      workflowWatcher: null,
      runtimeHost: new OrchestratorRuntimeHost({
        config: createConfig(),
        tracker,
        logger,
        agentRunner: new FakeAgentRunner(),
        now: () => new Date("2026-03-06T00:00:05.000Z"),
      }),
    });

    await service.runtimeHost.flushEvents();
    await service.shutdown();

    const tickEntry = entries.find((e) => e.event === "poll_tick_completed");
    expect(tickEntry).toBeDefined();
    // One issue was dispatched in the initial poll tick
    expect(tickEntry).toHaveProperty("dispatched_count", 1);
  });
});

describe("pipeline notifications", () => {
  function createMockNotifier() {
    const events: PipelineNotificationEvent[] = [];
    return {
      events,
      notify(event: PipelineNotificationEvent) {
        events.push(event);
      },
    };
  }

  it("includes prototype right-sizing on issue_dispatched", async () => {
    const tracker = createTracker({
      candidates: [
        createIssue({
          priority: 3,
          labels: ["trivial"],
          description: "## Declared file scope\n- src/features/copy.ts\n",
        }),
      ],
    });
    const notifier = createMockNotifier();
    const host = new OrchestratorRuntimeHost({
      config: createConfig(),
      tracker,
      notifier,
      agentRunner: new FakeAgentRunner(),
      now: () => new Date("2026-03-06T00:00:05.000Z"),
    });

    await host.pollOnce();

    expect(notifier.events[0]).toMatchObject({
      type: "issue_dispatched",
      rightSizingDecision: {
        classifier: "deterministic-v1",
        mode: "prototype",
        modelRouting: {
          allowed: false,
          reason: "not_needed",
        },
      },
    });
  });

  it("includes thin right-sizing on issue_dispatched for a merge-path unit", async () => {
    const tracker = createTracker({
      candidates: [
        createIssue({
          description: "## Declared file scope\n- src/features/timeline.ts\n",
        }),
      ],
    });
    const notifier = createMockNotifier();
    const fakeRunner = new FakeAgentRunner();
    const host = new OrchestratorRuntimeHost({
      config: createStagedConfig({
        stages: {
          initialStage: "implement",
          fastTrack: null,
          stages: {
            implement: {
              type: "agent",
              runner: null,
              model: null,
              prompt: null,
              maxTurns: 18,
              timeoutMs: null,
              concurrency: null,
              gateType: null,
              maxRework: null,
              reviewers: [],
              transitions: {
                onComplete: "review",
                onApprove: null,
                onRework: null,
              },
              linearState: null,
            },
            review: {
              type: "gate",
              runner: null,
              model: null,
              prompt: null,
              maxTurns: null,
              timeoutMs: null,
              concurrency: null,
              gateType: "ensemble",
              maxRework: null,
              reviewers: [
                {
                  runner: "codex",
                  model: "reviewer-1",
                  role: "reviewer-1",
                  prompt: null,
                },
              ],
              transitions: {
                onComplete: null,
                onApprove: "merge",
                onRework: "implement",
              },
              linearState: null,
            },
            merge: {
              type: "agent",
              runner: null,
              model: null,
              prompt: null,
              maxTurns: 10,
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
              transitions: {
                onComplete: null,
                onApprove: null,
                onRework: null,
              },
              linearState: null,
            },
          },
        },
      }),
      tracker,
      notifier,
      agentRunner: fakeRunner,
      now: () => new Date("2026-03-06T00:00:05.000Z"),
    });

    await host.pollOnce();

    expect(notifier.events[0]).toMatchObject({
      type: "issue_dispatched",
      rightSizingDecision: {
        classifier: "deterministic-v1",
        mode: "thin",
        stageName: "implement",
        signals: {
          gateCount: 1,
          impactSurface: "narrow",
        },
      },
    });
    expect(fakeRunner.runInputs[0]?.modePolicy).toMatchObject({
      mode: "thin",
      stageName: "implement",
      canOpenPullRequest: true,
      canAutoMerge: false,
      canBypassGates: false,
    });
    fakeRunner.resolve("1", createNormalResult());
    await host.waitForIdle();
  });

  it("includes full right-sizing on issue_dispatched for a high-risk unit", async () => {
    const tracker = createTracker({
      candidates: [
        createIssue({
          priority: 1,
          labels: ["risk:high"],
          description:
            "## Declared file scope\n- src/orchestrator/runtime-host.ts\n- src/config/config-resolver.ts\n",
        }),
      ],
    });
    const notifier = createMockNotifier();
    const host = new OrchestratorRuntimeHost({
      config: createStagedConfig({
        stages: {
          initialStage: "investigate",
          fastTrack: null,
          stages: {
            investigate: {
              type: "agent",
              runner: null,
              model: null,
              prompt: null,
              maxTurns: 12,
              timeoutMs: null,
              concurrency: null,
              gateType: null,
              maxRework: null,
              reviewers: [],
              transitions: {
                onComplete: "review",
                onApprove: null,
                onRework: null,
              },
              linearState: null,
            },
            review: {
              type: "gate",
              runner: null,
              model: null,
              prompt: null,
              maxTurns: null,
              timeoutMs: null,
              concurrency: null,
              gateType: "ensemble",
              maxRework: null,
              reviewers: [
                {
                  runner: "codex",
                  model: "reviewer-1",
                  role: "reviewer-1",
                  prompt: null,
                },
                {
                  runner: "codex",
                  model: "reviewer-2",
                  role: "reviewer-2",
                  prompt: null,
                },
              ],
              transitions: {
                onComplete: null,
                onApprove: "merge",
                onRework: "investigate",
              },
              linearState: null,
            },
            merge: {
              type: "agent",
              runner: null,
              model: null,
              prompt: null,
              maxTurns: 30,
              timeoutMs: null,
              concurrency: null,
              gateType: null,
              maxRework: null,
              reviewers: [],
              transitions: {
                onComplete: "acceptance",
                onApprove: null,
                onRework: null,
              },
              linearState: null,
            },
            acceptance: {
              type: "gate",
              runner: null,
              model: null,
              prompt: null,
              maxTurns: null,
              timeoutMs: null,
              concurrency: null,
              gateType: "human",
              maxRework: null,
              reviewers: [],
              transitions: {
                onComplete: null,
                onApprove: "done",
                onRework: "investigate",
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
              transitions: {
                onComplete: null,
                onApprove: null,
                onRework: null,
              },
              linearState: null,
            },
          },
        },
      }),
      tracker,
      notifier,
      agentRunner: new FakeAgentRunner(),
      now: () => new Date("2026-03-06T00:00:05.000Z"),
    });

    await host.pollOnce();

    expect(notifier.events[0]).toMatchObject({
      type: "issue_dispatched",
      rightSizingDecision: {
        classifier: "deterministic-v1",
        mode: "full",
        modelRouting: {
          allowed: true,
          reason: "risk_trigger",
        },
        triggerHits: expect.arrayContaining([
          "heavy_gate_requirements",
          "high_cost_budget",
          "high_risk_files",
          "priority_high",
        ]),
      },
    });
  });

  it("passes stage hard-stop dollar budget into the mode policy", async () => {
    const fakeRunner = new FakeAgentRunner();
    const tracker = createTracker({
      candidates: [
        createIssue({
          priority: 1,
          labels: ["risk:high"],
          description:
            "## Declared file scope\n- src/orchestrator/runtime-host.ts\n",
        }),
      ],
    });
    const host = new OrchestratorRuntimeHost({
      config: createStagedConfig({
        hardStops: {
          maxIterations: 20,
          noProgressTurns: 3,
          maxTokensPerUnit: 250_000,
          maxDollarBudgetUsd: 12.5,
          premiumBudgetPauseRatio: 0.8,
          liveBudgetGraceRatio: 0.1,
          estimatedCostPer1kTokensUsd: 0.05,
          cachedTokenCostRatio: 0.1,
          maxPrimaryWindowPctPerUnit: null,
          maxSecondaryWindowPctPerUnit: null,
        },
        stages: {
          initialStage: "investigate",
          fastTrack: null,
          stages: {
            investigate: {
              type: "agent",
              runner: "claude-code",
              model: null,
              prompt: null,
              maxTurns: 8,
              timeoutMs: null,
              hardStops: {
                maxDollarBudgetUsd: 4,
              },
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
              transitions: {
                onComplete: null,
                onApprove: null,
                onRework: null,
              },
              linearState: null,
            },
          },
        },
      }),
      tracker,
      agentRunner: fakeRunner,
      now: () => new Date("2026-03-06T00:00:05.000Z"),
    });

    await host.pollOnce();

    expect(fakeRunner.runInputs[0]?.stageName).toBe("investigate");
    expect(fakeRunner.runInputs[0]?.modePolicy?.maxBudgetUsd).toBe(4);
    fakeRunner.resolve("1", createNormalResult());
    await host.waitForIdle();
  });

  it("fires issue_completed on terminal completion", async () => {
    const tracker = createTracker();
    const fakeRunner = new FakeAgentRunner();
    const notifier = createMockNotifier();
    const host = new OrchestratorRuntimeHost({
      config: createStagedConfig({
        stages: {
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
              transitions: {
                onComplete: null,
                onApprove: null,
                onRework: null,
              },
              linearState: null,
            },
          },
        },
      }),
      tracker,
      notifier,
      createAgentRunner: ({ onEvent }) => {
        fakeRunner.onEvent = onEvent;
        return fakeRunner;
      },
      now: () => new Date("2026-03-06T00:00:05.000Z"),
    });

    await host.pollOnce();
    fakeRunner.resolve("1", createNormalResult());
    await host.waitForIdle();

    expect(notifier.events).toHaveLength(2);
    expect(notifier.events[0]).toMatchObject({
      type: "issue_dispatched",
      issueIdentifier: "ISSUE-1",
    });
    expect(notifier.events[1]).toMatchObject({
      type: "issue_completed",
      issueIdentifier: "ISSUE-1",
      issueTitle: "Issue 1",
    });
  });

  it("includes final stage record in executionHistory for single-stage terminal completion", async () => {
    const tracker = createTracker();
    const fakeRunner = new FakeAgentRunner();
    const notifier = createMockNotifier();
    const host = new OrchestratorRuntimeHost({
      config: createStagedConfig({
        stages: {
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
              transitions: {
                onComplete: null,
                onApprove: null,
                onRework: null,
              },
              linearState: null,
            },
          },
        },
      }),
      tracker,
      notifier,
      createAgentRunner: ({ onEvent }) => {
        fakeRunner.onEvent = onEvent;
        return fakeRunner;
      },
      now: () => new Date("2026-03-06T00:00:05.000Z"),
    });

    await host.pollOnce();
    fakeRunner.resolve("1", createNormalResult());
    await host.waitForIdle();

    expect(notifier.events).toHaveLength(2);
    const event = notifier.events[1]!;
    expect(event.type).toBe("issue_completed");
    // The history must contain the final stage record — not be empty
    const completed = event as Extract<
      PipelineNotificationEvent,
      { type: "issue_completed" }
    >;
    expect(completed.executionHistory).toHaveLength(1);
    expect(completed.executionHistory[0]).toMatchObject({
      stageName: "implement",
      outcome: "normal",
    });
  });

  it("includes all stage records in executionHistory for multi-stage terminal completion", async () => {
    const tracker = createTracker();
    const fakeRunner = new FakeAgentRunner();
    const notifier = createMockNotifier();
    const host = new OrchestratorRuntimeHost({
      config: createStagedConfig({
        stages: {
          initialStage: "investigate",
          fastTrack: null,
          stages: {
            investigate: {
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
              transitions: {
                onComplete: "implement",
                onApprove: null,
                onRework: null,
              },
              linearState: null,
            },
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
              transitions: {
                onComplete: null,
                onApprove: null,
                onRework: null,
              },
              linearState: null,
            },
          },
        },
      }),
      tracker,
      notifier,
      createAgentRunner: ({ onEvent }) => {
        fakeRunner.onEvent = onEvent;
        return fakeRunner;
      },
      now: () => new Date("2026-03-06T00:00:05.000Z"),
    });

    // Stage 1: investigate → completes, advances to implement (continuation)
    await host.pollOnce();
    fakeRunner.resolve("1", createNormalResult());
    await host.waitForIdle();

    // Only the initial dispatch notification — no completion yet (stage continuation)
    expect(notifier.events).toHaveLength(1);
    expect(notifier.events[0]).toMatchObject({ type: "issue_dispatched" });

    // Stage 2: fire the continuation retry timer to dispatch "implement"
    const retryResult = await host.runRetryTimer("1");
    // The retry timer should have dispatched the worker
    expect(retryResult.dispatched).toBe(true);
    fakeRunner.resolve("1", createNormalResult());
    await host.waitForIdle();

    // Dispatch + terminal completion (no second dispatch — continuation, not rework)
    expect(notifier.events).toHaveLength(2);
    expect(notifier.events).not.toContainEqual(
      expect.objectContaining({ type: "resumed_existing_active" }),
    );
    const event = notifier.events[1]!;
    expect(event.type).toBe("issue_completed");
    // History must include records from BOTH stages
    const completed = event as Extract<
      PipelineNotificationEvent,
      { type: "issue_completed" }
    >;
    expect(completed.executionHistory).toHaveLength(2);
    expect(completed.executionHistory[0]).toMatchObject({
      stageName: "investigate",
    });
    expect(completed.executionHistory[1]).toMatchObject({
      stageName: "implement",
      outcome: "normal",
    });
  });

  it("emits resumed_existing_active for restart-replayed active work without duplicating issue_dispatched", async () => {
    const priorJournal: DispatcherRunJournal = [
      {
        sequence: 1,
        idempotencyKey: "prior:right_sizing",
        timestamp: "2026-03-06T00:00:00.000Z",
        kind: "right_sizing",
        issueId: "1",
        issueIdentifier: "ISSUE-1",
        operation: "dispatcher",
        stage: "implement",
        attempt: null,
        ownerId: "previous-runtime",
        lease: null,
        summary: "Right-sized ISSUE-1 as thin.",
        metadata: {
          mode: "thin",
        },
      },
    ];
    const writtenJournal: DispatcherRunJournalEntry[] = [];
    const tracker = createTracker();
    const fakeRunner = new FakeAgentRunner();
    const notifier = createMockNotifier();
    const host = new OrchestratorRuntimeHost({
      config: createConfig(),
      tracker,
      notifier,
      createAgentRunner: ({ onEvent }) => {
        fakeRunner.onEvent = onEvent;
        return fakeRunner;
      },
      readDispatcherRunJournal: async () => priorJournal,
      writeDispatcherRunJournalEntry: async (_workspaceRoot, entry) => {
        writtenJournal.push(entry);
      },
      now: () => new Date("2026-03-06T00:00:05.000Z"),
    });

    const tick = await host.pollOnce();

    expect(tick.dispatchedIssueIds).toEqual(["1"]);
    expect(fakeRunner.runs.size).toBe(1);
    expect(notifier.events).toEqual([
      expect.objectContaining({
        type: "resumed_existing_active",
        issueIdentifier: "ISSUE-1",
        stageName: null,
        reworkCount: 0,
        journalSequence: expect.any(Number),
      }),
    ]);
    expect(notifier.events).not.toContainEqual(
      expect.objectContaining({ type: "issue_dispatched" }),
    );

    const resumeEntry = host
      .getState()
      .dispatcherRunJournal.find(
        (entry) => entry.kind === "resumed_existing_active",
      );
    expect(resumeEntry).toMatchObject({
      issueIdentifier: "ISSUE-1",
      metadata: {
        status: "completed",
        source: "restart_replay",
        resume_reason: "prior_dispatch_replayed",
        rework_count: 0,
      },
    });
    await new Promise((resolve) => setImmediate(resolve));
    expect(writtenJournal).toContainEqual(
      expect.objectContaining({
        kind: "resumed_existing_active",
        issueIdentifier: "ISSUE-1",
      }),
    );

    const delta = await host.getStateDelta({ sinceSeq: 0 });
    expect(delta.entries).toContainEqual(
      expect.objectContaining({
        kind: "resumed_existing_active",
        issueIdentifier: "ISSUE-1",
        metadata: {
          status: "completed",
          source: "restart_replay",
          resume_reason: "prior_dispatch_replayed",
          rework_count: 0,
        },
      }),
    );
  });

  it("does not emit resumed_existing_active for restart-replayed active rework", async () => {
    const priorJournal: DispatcherRunJournal = [
      {
        sequence: 1,
        idempotencyKey: "prior:right_sizing",
        timestamp: "2026-03-06T00:00:00.000Z",
        kind: "right_sizing",
        issueId: "1",
        issueIdentifier: "ISSUE-1",
        operation: "dispatcher",
        stage: "implement",
        attempt: null,
        ownerId: "previous-runtime",
        lease: null,
        summary: "Right-sized ISSUE-1 as thin.",
        metadata: {
          mode: "thin",
        },
      },
      {
        sequence: 2,
        idempotencyKey: "prior:intent:rework",
        timestamp: "2026-03-06T00:00:01.000Z",
        kind: "intent",
        issueId: "1",
        issueIdentifier: "ISSUE-1",
        operation: "dispatcher",
        stage: "review",
        attempt: null,
        ownerId: "previous-runtime",
        lease: null,
        summary: "Intent rework_with_hint applied for ISSUE-1.",
        metadata: {
          schema_version: 1,
          status: "applied",
          verb: "rework_with_hint",
          detail: "rework requested",
          reworkTarget: "implement",
          reworkCount: 1,
        },
      },
    ];
    const writtenJournal: DispatcherRunJournalEntry[] = [];
    const tracker = createTracker();
    const fakeRunner = new FakeAgentRunner();
    const notifier = createMockNotifier();
    const host = new OrchestratorRuntimeHost({
      config: createConfig(),
      tracker,
      notifier,
      createAgentRunner: ({ onEvent }) => {
        fakeRunner.onEvent = onEvent;
        return fakeRunner;
      },
      readDispatcherRunJournal: async () => priorJournal,
      writeDispatcherRunJournalEntry: async (_workspaceRoot, entry) => {
        writtenJournal.push(entry);
      },
      now: () => new Date("2026-03-06T00:00:05.000Z"),
    });

    const tick = await host.runRetryTimer("1");

    expect(tick.dispatched).toBe(true);
    expect(host.getState().issueReworkCounts["1"]).toBe(1);
    expect(notifier.events).not.toContainEqual(
      expect.objectContaining({ type: "resumed_existing_active" }),
    );
    expect(writtenJournal).not.toContainEqual(
      expect.objectContaining({ kind: "resumed_existing_active" }),
    );
  });

  it("does NOT fire issue_completed on stage continuation", async () => {
    const tracker = createTracker();
    const fakeRunner = new FakeAgentRunner();
    const notifier = createMockNotifier();
    const host = new OrchestratorRuntimeHost({
      config: createStagedConfig({
        stages: {
          initialStage: "investigate",
          fastTrack: null,
          stages: {
            investigate: {
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
              transitions: {
                onComplete: "implement",
                onApprove: null,
                onRework: null,
              },
              linearState: null,
            },
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
              transitions: {
                onComplete: null,
                onApprove: null,
                onRework: null,
              },
              linearState: null,
            },
          },
        },
      }),
      tracker,
      notifier,
      createAgentRunner: ({ onEvent }) => {
        fakeRunner.onEvent = onEvent;
        return fakeRunner;
      },
      now: () => new Date("2026-03-06T00:00:05.000Z"),
    });

    await host.pollOnce();
    fakeRunner.resolve("1", createNormalResult());
    await host.waitForIdle();

    // Stage advanced from investigate → implement, scheduled continuation retry.
    // Only the initial dispatch notification — no terminal notification.
    expect(notifier.events).toHaveLength(1);
    expect(notifier.events[0]).toMatchObject({ type: "issue_dispatched" });
  });

  it("fires issue_failed when retries are exhausted", async () => {
    const tracker = createTracker();
    const fakeRunner = new FakeAgentRunner();
    const notifier = createMockNotifier();
    const host = new OrchestratorRuntimeHost({
      config: {
        ...createConfig(),
        agent: { ...createConfig().agent, maxRetryAttempts: 0 },
      },
      tracker,
      notifier,
      createAgentRunner: ({ onEvent }) => {
        fakeRunner.onEvent = onEvent;
        return fakeRunner;
      },
      now: () => new Date("2026-03-06T00:00:05.000Z"),
    });

    await host.pollOnce();
    fakeRunner.reject("1", new Error("agent crashed"));
    await host.waitForIdle();

    // Events: dispatched + failure_exhausted (SYMPH-397).
    // issue_failed is suppressed when retriesExhausted is true — failure_exhausted
    // is the canonical terminal alert and avoids double "retries exhausted" posts.
    expect(notifier.events).toHaveLength(2);
    expect(notifier.events[0]).toMatchObject({
      type: "issue_dispatched",
      issueIdentifier: "ISSUE-1",
    });
    expect(notifier.events).toContainEqual(
      expect.objectContaining({
        type: "failure_exhausted",
        issueIdentifier: "ISSUE-1",
      }),
    );
    expect(notifier.events).not.toContainEqual(
      expect.objectContaining({
        type: "issue_failed",
        retriesExhausted: true,
      }),
    );
  });

  it("does not emit issue_failed for an intentional manual stop", async () => {
    const tracker = createTracker();
    const fakeRunner = new FakeAgentRunner();
    const notifier = createMockNotifier();
    const host = new OrchestratorRuntimeHost({
      config: createConfig(),
      tracker,
      notifier,
      createAgentRunner: ({ onEvent }) => {
        fakeRunner.onEvent = onEvent;
        return fakeRunner;
      },
      now: () => new Date("2026-03-06T00:00:05.000Z"),
    });

    await host.pollOnce();
    const stopResponse = await host.requestIssueStop("ISSUE-1");
    await host.waitForIdle();

    expect(stopResponse).toMatchObject({
      stopped: true,
      reason: "manual_stop",
    });
    expect(notifier.events).toEqual([
      expect.objectContaining({ type: "issue_dispatched" }),
    ]);

    const snapshot = await host.getRuntimeSnapshot();
    expect(snapshot.counts.failed).toBe(0);

    const stillActive = await host.pollOnce();
    expect(stillActive.dispatchedIssueIds).toEqual([]);
  });

  it("aborts workers before awaiting stop-request telemetry logging", async () => {
    const tracker = createTracker();
    const fakeRunner = new FakeAgentRunner();
    let resolveStopLog: (() => void) | undefined;
    let observeStopLog: (() => void) | undefined;
    const stopLogStarted = new Promise<void>((resolve) => {
      observeStopLog = resolve;
    });
    const logger = new StructuredLogger([
      {
        write(entry) {
          if (entry.event !== "worker_stop_requested") {
            return;
          }
          observeStopLog?.();
          return new Promise<void>((resolve) => {
            resolveStopLog = resolve;
          });
        },
      },
    ]);
    const host = new OrchestratorRuntimeHost({
      config: createConfig(),
      tracker,
      logger,
      createAgentRunner: ({ onEvent }) => {
        fakeRunner.onEvent = onEvent;
        return fakeRunner;
      },
      now: () => new Date("2026-03-06T00:00:05.000Z"),
    });

    await host.pollOnce();
    const stopResponsePromise = host.requestIssueStop("ISSUE-1");
    await stopLogStarted;

    expect(fakeRunner.abortReasons).toContain("Stopped due to manual_stop.");

    resolveStopLog?.();
    const stopResponse = await stopResponsePromise;
    await host.waitForIdle();

    expect(stopResponse).toMatchObject({
      stopped: true,
      reason: "manual_stop",
    });
  });

  it("surfaces tracked process signal delivery failures without undoing the stop", async () => {
    const tracker = createTracker();
    const fakeRunner = new FakeAgentRunner();
    const notifier = createMockNotifier();
    const entries: StructuredLogEntry[] = [];
    const logger = new StructuredLogger([
      {
        write(entry) {
          entries.push(entry);
        },
      },
    ]);
    const host = new OrchestratorRuntimeHost({
      config: createConfig(),
      tracker,
      notifier,
      logger,
      createAgentRunner: ({ onEvent }) => {
        fakeRunner.onEvent = onEvent;
        return fakeRunner;
      },
      deliverWorkerStopSignal: async (input): Promise<StopSignalDelivery> => ({
        status: "failed",
        reason: input.reason,
        attemptedAt: input.attemptedAt.toISOString(),
        workspacePath: input.workspacePath,
        attempts: [
          {
            pid: 4242,
            processGroupId: 4242,
            sigterm: "failed",
            sigkill: "failed",
          },
        ],
        warning:
          "SIGTERM and SIGKILL both failed for 1 tracked process target: pid=4242 process_group=4242",
      }),
      now: () => new Date("2026-03-06T00:00:05.000Z"),
    });

    await host.pollOnce();
    const stopResponse = await host.requestIssueStop("ISSUE-1");
    await host.waitForIdle();

    expect(stopResponse).toMatchObject({
      stopped: true,
      reason: "manual_stop",
      signal_delivery: {
        status: "failed",
        reason: "manual_stop",
        attempted_at: "2026-03-06T00:00:05.000Z",
        workspace_path: "/tmp/workspaces/1",
        attempts: [
          {
            pid: 4242,
            process_group_id: 4242,
            sigterm: "failed",
            sigkill: "failed",
          },
        ],
      },
    });
    expect(entries).toContainEqual(
      expect.objectContaining({
        event: "worker_stop_requested",
        level: "info",
        outcome: "requested",
        reason: "manual_stop",
        attempted_reason: "manual_stop",
        issue_identifier: "ISSUE-1",
      }),
    );
    expect(entries).toContainEqual(
      expect.objectContaining({
        event: "worker_stop_signal_delivery_failed",
        level: "warn",
        outcome: "degraded",
        reason: "manual_stop",
        attempted_reason: "manual_stop",
        issue_identifier: "ISSUE-1",
        pids: [4242],
        process_group_ids: [4242],
        failed_pids: [4242],
        failed_process_group_ids: [4242],
      }),
    );
    expect(notifier.events).toEqual([
      expect.objectContaining({ type: "issue_dispatched" }),
    ]);

    const stillActive = await host.pollOnce();
    expect(stillActive.dispatchedIssueIds).toEqual([]);
  });

  it("targets the tracked app-server pid for stop signal delivery", async () => {
    const tracker = createTracker();
    const fakeRunner = new FakeAgentRunner();
    let trackedProcessPid: number | null | undefined;
    let trackedProcessIdentity: ProcessIdentitySnapshot | null | undefined;
    const identity = createProcessIdentity(4242);
    const host = new OrchestratorRuntimeHost({
      config: createConfig(),
      tracker,
      createAgentRunner: ({ onEvent }) => {
        fakeRunner.onEvent = onEvent;
        return fakeRunner;
      },
      deliverWorkerStopSignal: async (input): Promise<StopSignalDelivery> => {
        trackedProcessPid = input.trackedProcessPid;
        trackedProcessIdentity = input.trackedProcessIdentity;
        return {
          status: "delivered",
          reason: input.reason,
          attemptedAt: input.attemptedAt.toISOString(),
          workspacePath: input.workspacePath,
          attempts:
            input.trackedProcessPid === null
              ? []
              : [
                  {
                    pid: input.trackedProcessPid,
                    processGroupId: null,
                    sigterm: "delivered",
                    sigkill: "not_attempted",
                  },
                ],
          warning: null,
        };
      },
      now: () => new Date("2026-03-06T00:00:05.000Z"),
    });

    await host.pollOnce();
    fakeRunner.emit("1", {
      event: "session_started",
      timestamp: "2026-03-06T00:00:02.000Z",
      codexAppServerPid: "4242",
      codexAppServerIdentity: identity,
      sessionId: "thread-1-turn-1",
      threadId: "thread-1",
      turnId: "turn-1",
    });
    await host.flushEvents();

    const stopResponse = await host.requestIssueStop("ISSUE-1");
    await host.waitForIdle();

    expect(trackedProcessPid).toBe(4242);
    expect(trackedProcessIdentity).toEqual(identity);
    expect(stopResponse.signal_delivery).toMatchObject({
      status: "delivered",
      attempts: [
        {
          pid: 4242,
          sigterm: "delivered",
          sigkill: "not_attempted",
        },
      ],
    });
  });

  it("logs successful signal delivery separately from stop acceptance", async () => {
    const tracker = createTracker();
    const fakeRunner = new FakeAgentRunner();
    const entries: StructuredLogEntry[] = [];
    const logger = new StructuredLogger([
      {
        write(entry) {
          entries.push(entry);
        },
      },
    ]);
    const host = new OrchestratorRuntimeHost({
      config: createConfig(),
      tracker,
      logger,
      createAgentRunner: ({ onEvent }) => {
        fakeRunner.onEvent = onEvent;
        return fakeRunner;
      },
      deliverWorkerStopSignal: async (input): Promise<StopSignalDelivery> => ({
        status: "delivered",
        reason: input.reason,
        attemptedAt: input.attemptedAt.toISOString(),
        workspacePath: input.workspacePath,
        attempts: [
          {
            pid: 4242,
            processGroupId: null,
            sigterm: "delivered",
            sigkill: "not_attempted",
          },
        ],
        warning: null,
      }),
      now: () => new Date("2026-03-06T00:00:05.000Z"),
    });

    await host.pollOnce();
    const stopResponse = await host.requestIssueStop("ISSUE-1");
    await host.waitForIdle();

    expect(stopResponse.signal_delivery).toMatchObject({
      status: "delivered",
      reason: "manual_stop",
      attempts: [
        {
          pid: 4242,
          sigterm: "delivered",
          sigkill: "not_attempted",
        },
      ],
    });
    expect(entries).toContainEqual(
      expect.objectContaining({
        event: "worker_stop_requested",
        level: "info",
        message: expect.stringContaining(
          "Worker stop requested; aborting runner before tracked process signal delivery.",
        ),
        outcome: "requested",
        issue_identifier: "ISSUE-1",
      }),
    );
    expect(entries).toContainEqual(
      expect.objectContaining({
        event: "worker_stop_signal_delivery",
        level: "info",
        outcome: "delivered",
        signal_delivery_status: "delivered",
        pids: [4242],
        failed_pids: [],
      }),
    );
  });

  it("logs ownership-unverified signal delivery as not attempted", async () => {
    const tracker = createTracker();
    const fakeRunner = new FakeAgentRunner();
    const entries: StructuredLogEntry[] = [];
    const logger = new StructuredLogger([
      {
        write(entry) {
          entries.push(entry);
        },
      },
    ]);
    const host = new OrchestratorRuntimeHost({
      config: createConfig(),
      tracker,
      logger,
      createAgentRunner: ({ onEvent }) => {
        fakeRunner.onEvent = onEvent;
        return fakeRunner;
      },
      deliverWorkerStopSignal: async (input): Promise<StopSignalDelivery> => ({
        status: "not_attempted",
        reason: input.reason,
        attemptedAt: input.attemptedAt.toISOString(),
        workspacePath: input.workspacePath,
        attempts: [],
        warning:
          "Tracked process PID 4242 was not signaled: process command does not look like a Codex app-server",
      }),
      now: () => new Date("2026-03-06T00:00:05.000Z"),
    });

    await host.pollOnce();
    const stopResponse = await host.requestIssueStop("ISSUE-1");
    await host.waitForIdle();

    expect(stopResponse.signal_delivery).toMatchObject({
      status: "not_attempted",
      reason: "manual_stop",
      attempts: [],
      warning:
        "Tracked process PID 4242 was not signaled: process command does not look like a Codex app-server",
    });
    expect(entries).toContainEqual(
      expect.objectContaining({
        event: "worker_stop_signal_delivery",
        level: "info",
        outcome: "not_attempted",
        signal_delivery_status: "not_attempted",
        issue_identifier: "ISSUE-1",
        pids: [],
        failed_pids: [],
        warning:
          "Tracked process PID 4242 was not signaled: process command does not look like a Codex app-server",
      }),
    );
  });

  it("warns when signal delivery telemetry fails before attempts are recorded", async () => {
    const tracker = createTracker();
    const fakeRunner = new FakeAgentRunner();
    const notifier = createMockNotifier();
    const entries: StructuredLogEntry[] = [];
    const logger = new StructuredLogger([
      {
        write(entry) {
          entries.push(entry);
        },
      },
    ]);
    const host = new OrchestratorRuntimeHost({
      config: createConfig(),
      tracker,
      notifier,
      logger,
      createAgentRunner: ({ onEvent }) => {
        fakeRunner.onEvent = onEvent;
        return fakeRunner;
      },
      deliverWorkerStopSignal: async () => {
        throw new Error("lsof unavailable");
      },
      now: () => new Date("2026-03-06T00:00:05.000Z"),
    });

    await host.pollOnce();
    const stopResponse = await host.requestIssueStop("ISSUE-1");
    await host.waitForIdle();

    expect(stopResponse.signal_delivery).toMatchObject({
      status: "failed",
      reason: "manual_stop",
      attempted_at: "2026-03-06T00:00:05.000Z",
      workspace_path: "/tmp/workspaces/1",
      attempts: [],
      warning:
        "Tracked process signal delivery failed before attempts were recorded: lsof unavailable",
    });
    expect(entries).toContainEqual(
      expect.objectContaining({
        event: "worker_stop_signal_delivery_failed",
        level: "warn",
        outcome: "degraded",
        signal_delivery_status: "failed",
        issue_identifier: "ISSUE-1",
        pids: [],
        failed_pids: [],
        warning:
          "Tracked process signal delivery failed before attempts were recorded: lsof unavailable",
      }),
    );
    expect(notifier.events).toEqual([
      expect.objectContaining({ type: "issue_dispatched" }),
    ]);
  });

  it("rejects malformed custom signal delivery telemetry before logging attempts", async () => {
    const tracker = createTracker();
    const fakeRunner = new FakeAgentRunner();
    const entries: StructuredLogEntry[] = [];
    const logger = new StructuredLogger([
      {
        write(entry) {
          entries.push(entry);
        },
      },
    ]);
    const host = new OrchestratorRuntimeHost({
      config: createConfig(),
      tracker,
      logger,
      createAgentRunner: ({ onEvent }) => {
        fakeRunner.onEvent = onEvent;
        return fakeRunner;
      },
      deliverWorkerStopSignal: async (input): Promise<StopSignalDelivery> =>
        ({
          status: "delivered",
          reason: input.reason,
          attemptedAt: input.attemptedAt.toISOString(),
          workspacePath: input.workspacePath,
          attempts: [
            {
              pid: 4242,
              processGroupId: 0,
              sigterm: "delivered",
              sigkill: "not_attempted",
            },
          ],
          warning: null,
        }) as StopSignalDelivery,
      now: () => new Date("2026-03-06T00:00:05.000Z"),
    });

    await host.pollOnce();
    const stopResponse = await host.requestIssueStop("ISSUE-1");
    await host.waitForIdle();

    expect(stopResponse.signal_delivery).toMatchObject({
      status: "failed",
      reason: "manual_stop",
      attempted_at: "2026-03-06T00:00:05.000Z",
      workspace_path: "/tmp/workspaces/1",
      attempts: [],
      warning:
        "Tracked process signal delivery returned invalid telemetry; no attempts were recorded.",
    });
    expect(entries).toContainEqual(
      expect.objectContaining({
        event: "worker_stop_signal_delivery_failed",
        level: "warn",
        outcome: "degraded",
        signal_delivery_status: "failed",
        issue_identifier: "ISSUE-1",
        pids: [],
        failed_pids: [],
        warning:
          "Tracked process signal delivery returned invalid telemetry; no attempts were recorded.",
      }),
    );
  });

  it("signals only the tracked pid", () => {
    const calls: Array<[number, NodeJS.Signals]> = [];
    const result = signalPid(4242, "SIGTERM", (pid, signal) => {
      calls.push([pid, signal]);
    });

    expect(result).toEqual({
      status: "delivered",
      processGroupId: null,
    });
    expect(calls).toEqual([[4242, "SIGTERM"]]);
  });

  it("treats ESRCH from a signal attempt as benign already-exited delivery", () => {
    const error = new Error("no such process");
    Object.assign(error, { code: "ESRCH" });

    const result = signalPid(4242, "SIGTERM", () => {
      throw error;
    });

    expect(result).toEqual({
      status: "already_exited",
      processGroupId: null,
    });
  });

  it("does not signal unsafe tracked pids", () => {
    const calls: Array<[number, NodeJS.Signals]> = [];

    expect(
      signalPid(1, "SIGTERM", (pid, signal) => {
        calls.push([pid, signal]);
      }),
    ).toEqual({ status: "failed", processGroupId: null });

    expect(
      signalPid(process.pid, "SIGTERM", (pid, signal) => {
        calls.push([pid, signal]);
      }),
    ).toEqual({ status: "failed", processGroupId: null });
    expect(calls).toEqual([]);
  });

  it("signals the tracked pid only after process ownership verification", async () => {
    const calls: Array<[number, NodeJS.Signals]> = [];
    const delivery = await deliverTrackedWorkerStopSignal(
      {
        issueId: "1",
        issueIdentifier: "ISSUE-1",
        reason: "manual_stop",
        workspacePath: "/tmp/workspaces/1",
        trackedProcessPid: 4242,
        attemptedAt: new Date("2026-03-06T00:00:05.000Z"),
      },
      {
        readProcessCwd: async () => "/tmp/workspaces/1",
        readProcessCommand: async () => "bash -lc codex app-server",
        sendSignal: (pid, signal) => {
          calls.push([pid, signal]);
        },
      },
    );

    expect(delivery).toMatchObject({
      status: "delivered",
      warning: null,
      attempts: [
        {
          pid: 4242,
          processGroupId: null,
          sigterm: "delivered",
          sigkill: "not_attempted",
        },
      ],
    });
    expect(calls).toEqual([[4242, "SIGTERM"]]);
  });

  it("uses captured process identity when cwd ownership cannot be read", async () => {
    const calls: Array<[number, NodeJS.Signals]> = [];
    const identity = createProcessIdentity(4242);
    const delivery = await deliverTrackedWorkerStopSignal(
      {
        issueId: "1",
        issueIdentifier: "ISSUE-1",
        reason: "emergency_stop",
        workspacePath: "/tmp/workspaces/1",
        trackedProcessPid: 4242,
        trackedProcessIdentity: identity,
        attemptedAt: new Date("2026-03-06T00:00:05.000Z"),
      },
      {
        emergencyStopGraceMs: 0,
        readProcessCwd: async () => null,
        readProcessCommand: async () => null,
        readProcessIdentity: async () => identity,
        sendSignal: (pid, signal) => {
          calls.push([pid, signal]);
        },
      },
    );

    expect(delivery).toMatchObject({
      status: "delivered",
      warning: null,
      attempts: [
        {
          pid: 4242,
          processGroupId: 4242,
          sigterm: "delivered",
          sigkill: "delivered",
        },
      ],
    });
    expect(calls).toEqual([
      [-4242, "SIGTERM"],
      [-4242, "SIGKILL"],
    ]);
  });

  it("does not signal when captured process identity no longer matches", async () => {
    const calls: Array<[number, NodeJS.Signals]> = [];
    const delivery = await deliverTrackedWorkerStopSignal(
      {
        issueId: "1",
        issueIdentifier: "ISSUE-1",
        reason: "emergency_stop",
        workspacePath: "/tmp/workspaces/1",
        trackedProcessPid: 4242,
        trackedProcessIdentity: createProcessIdentity(4242),
        attemptedAt: new Date("2026-03-06T00:00:05.000Z"),
      },
      {
        emergencyStopGraceMs: 0,
        readProcessCwd: async () => null,
        readProcessCommand: async () => null,
        readProcessIdentity: async () => createProcessIdentity(4243),
        sendSignal: (pid, signal) => {
          calls.push([pid, signal]);
        },
      },
    );

    expect(delivery).toMatchObject({
      status: "not_attempted",
      attempts: [],
      warning:
        "Tracked process PID 4242 was not signaled: current process identity does not match captured app-server identity",
    });
    expect(calls).toEqual([]);
  });

  it("escalates emergency-stop delivery to SIGKILL after the grace window", async () => {
    const calls: Array<[number, NodeJS.Signals]> = [];
    const delivery = await deliverTrackedWorkerStopSignal(
      {
        issueId: "1",
        issueIdentifier: "ISSUE-1",
        reason: "emergency_stop",
        workspacePath: "/tmp/workspaces/1",
        trackedProcessPid: 4242,
        attemptedAt: new Date("2026-03-06T00:00:05.000Z"),
      },
      {
        emergencyStopGraceMs: 0,
        readProcessCwd: async () => "/tmp/workspaces/1",
        readProcessCommand: async () => "bash -lc codex app-server",
        sendSignal: (pid, signal) => {
          calls.push([pid, signal]);
        },
      },
    );

    expect(delivery).toMatchObject({
      status: "delivered",
      warning: null,
      attempts: [
        {
          pid: 4242,
          processGroupId: null,
          sigterm: "delivered",
          sigkill: "delivered",
        },
      ],
    });
    expect(calls).toEqual([
      [4242, "SIGTERM"],
      [4242, "SIGKILL"],
    ]);
  });

  it("marks emergency-stop delivery failed when SIGKILL escalation fails", async () => {
    const calls: Array<[number, NodeJS.Signals]> = [];
    const delivery = await deliverTrackedWorkerStopSignal(
      {
        issueId: "1",
        issueIdentifier: "ISSUE-1",
        reason: "emergency_stop",
        workspacePath: "/tmp/workspaces/1",
        trackedProcessPid: 4242,
        attemptedAt: new Date("2026-03-06T00:00:05.000Z"),
      },
      {
        emergencyStopGraceMs: 0,
        readProcessCwd: async () => "/tmp/workspaces/1",
        readProcessCommand: async () => "bash -lc codex app-server",
        sendSignal: (pid, signal) => {
          calls.push([pid, signal]);
          if (signal === "SIGKILL") {
            throw new Error("permission denied");
          }
        },
      },
    );

    expect(delivery).toMatchObject({
      status: "failed",
      warning:
        "Emergency stop signal proof failed for 1 worker process target(s): pid=4242",
      attempts: [
        {
          pid: 4242,
          processGroupId: null,
          sigterm: "delivered",
          sigkill: "failed",
        },
      ],
    });
    expect(calls).toEqual([
      [4242, "SIGTERM"],
      [4242, "SIGKILL"],
    ]);
  });

  it("does not signal a tracked pid whose cwd no longer matches the workspace", async () => {
    const calls: Array<[number, NodeJS.Signals]> = [];
    const delivery = await deliverTrackedWorkerStopSignal(
      {
        issueId: "1",
        issueIdentifier: "ISSUE-1",
        reason: "manual_stop",
        workspacePath: "/tmp/workspaces/1",
        trackedProcessPid: 4242,
        attemptedAt: new Date("2026-03-06T00:00:05.000Z"),
      },
      {
        readProcessCwd: async () => "/tmp/workspaces/10",
        readProcessCommand: async () => "bash -lc codex app-server",
        sendSignal: (pid, signal) => {
          calls.push([pid, signal]);
        },
      },
    );

    expect(delivery).toMatchObject({
      status: "not_attempted",
      attempts: [],
      warning:
        "Tracked process PID 4242 was not signaled: process cwd /tmp/workspaces/10 is outside workspace containment boundary /tmp/workspaces/1",
    });
    expect(calls).toEqual([]);
  });

  it("allows a tracked pid whose cwd is inside the workspace boundary", async () => {
    const calls: Array<[number, NodeJS.Signals]> = [];
    const delivery = await deliverTrackedWorkerStopSignal(
      {
        issueId: "1",
        issueIdentifier: "ISSUE-1",
        reason: "manual_stop",
        workspacePath: "/tmp/workspaces/1",
        trackedProcessPid: 4242,
        attemptedAt: new Date("2026-03-06T00:00:05.000Z"),
      },
      {
        readProcessCwd: async () => "/tmp/workspaces/1/packages/app",
        readProcessCommand: async () => "bash -lc codex app-server",
        sendSignal: (pid, signal) => {
          calls.push([pid, signal]);
        },
      },
    );

    expect(delivery).toMatchObject({
      status: "delivered",
      attempts: [
        {
          pid: 4242,
          processGroupId: null,
          sigterm: "delivered",
          sigkill: "not_attempted",
        },
      ],
    });
    expect(calls).toEqual([[4242, "SIGTERM"]]);
  });

  it("does not report failed signal delivery when the tracked pid is already gone", async () => {
    const calls: Array<[number, NodeJS.Signals]> = [];
    const delivery = await deliverTrackedWorkerStopSignal(
      {
        issueId: "1",
        issueIdentifier: "ISSUE-1",
        reason: "manual_stop",
        workspacePath: "/tmp/workspaces/1",
        trackedProcessPid: 4242,
        attemptedAt: new Date("2026-03-06T00:00:05.000Z"),
      },
      {
        readProcessCwd: async () => null,
        readProcessCommand: async () => null,
        sendSignal: (pid, signal) => {
          calls.push([pid, signal]);
        },
      },
    );

    expect(delivery).toMatchObject({
      status: "not_attempted",
      attempts: [],
      warning:
        "Tracked process PID 4242 was not signaled: process cwd could not be read for ownership verification",
    });
    expect(calls).toEqual([]);
  });

  it("does not signal a tracked pid whose command is not a Codex app-server", async () => {
    const calls: Array<[number, NodeJS.Signals]> = [];
    const delivery = await deliverTrackedWorkerStopSignal(
      {
        issueId: "1",
        issueIdentifier: "ISSUE-1",
        reason: "manual_stop",
        workspacePath: "/tmp/workspaces/1",
        trackedProcessPid: 4242,
        attemptedAt: new Date("2026-03-06T00:00:05.000Z"),
      },
      {
        readProcessCwd: async () => "/tmp/workspaces/1",
        readProcessCommand: async () => "sleep 600",
        sendSignal: (pid, signal) => {
          calls.push([pid, signal]);
        },
      },
    );

    expect(delivery).toMatchObject({
      status: "not_attempted",
      attempts: [],
      warning:
        "Tracked process PID 4242 was not signaled: process command does not look like a Codex app-server",
    });
    expect(calls).toEqual([]);
  });

  it("parses lsof cwd field output into safe PID/path entries", () => {
    expect(
      parseLsofCwdProcessEntries(
        [
          "p1001",
          "n/tmp/workspaces/1",
          "p1",
          "n/tmp/workspaces/1",
          `p${process.pid}`,
          "n/tmp/workspaces/1",
          "pnot-a-pid",
          "n/tmp/workspaces/1",
          "p2002",
          "n/tmp/workspaces/1/packages/app",
        ].join("\n"),
      ),
    ).toEqual([
      { pid: 1001, cwdPath: "/tmp/workspaces/1" },
      { pid: 2002, cwdPath: "/tmp/workspaces/1/packages/app" },
    ]);
  });

  it("parses legacy lsof cwd table output without prefix-matching sibling workspaces", async () => {
    const output = [
      "COMMAND   PID USER   FD   TYPE DEVICE SIZE/OFF NODE NAME",
      "node     1001 eric  cwd    DIR   1,23      128  100 /tmp/workspaces/1",
      "bash     2002 eric  cwd    DIR   1,23      128  101 /tmp/workspaces/1/packages/app",
      "node     3003 eric  cwd    DIR   1,23      128  102 /tmp/workspaces/10",
      "node        1 eric  cwd    DIR   1,23      128  103 /tmp/workspaces/1",
      `node ${process.pid} eric  cwd    DIR   1,23      128  104 /tmp/workspaces/1`,
    ].join("\n");

    await expect(
      findWorkspaceCwdProcessIds(output, "/tmp/workspaces/1"),
    ).resolves.toEqual([1001, 2002]);
  });

  it("preserves whitespace in legacy lsof cwd table path names", () => {
    const output = [
      "COMMAND   PID USER   FD   TYPE DEVICE SIZE/OFF NODE NAME",
      "node     1001 eric  cwd    DIR   1,23      128  100 /tmp/workspaces/team alpha/app  one",
      "node     2002 eric  cwd    DIR   1,23      128  101 /tmp/workspaces/team alpha sibling/app",
    ].join("\n");

    expect(parseLsofCwdProcessEntries(output)).toEqual([
      {
        pid: 1001,
        cwdPath: "/tmp/workspaces/team alpha/app  one",
      },
      {
        pid: 2002,
        cwdPath: "/tmp/workspaces/team alpha sibling/app",
      },
    ]);
  });

  it("deduplicates workspace cwd discovery from lsof field output", async () => {
    const output = [
      "p1001",
      "n/tmp/workspaces/1",
      "n/tmp/workspaces/1/packages/app",
      "p2002",
      "n/tmp/workspaces/10",
      "p3003",
      "n/tmp/workspaces/1-other",
      "p4004",
      "n/tmp/workspaces/1/packages/worker",
    ].join("\n");

    await expect(
      findWorkspaceCwdProcessIds(output, "/tmp/workspaces/1"),
    ).resolves.toEqual([1001, 4004]);
  });

  it("rechecks current process cwd before accepting workspace cwd discoveries", async () => {
    const output = [
      "p1001",
      "n/tmp/workspaces/1",
      "p2002",
      "n/tmp/workspaces/1/packages/app",
      "p3003",
      "n/tmp/workspaces/1/packages/test",
    ].join("\n");
    const currentCwds = new Map<number, string | null>([
      [1001, "/tmp/workspaces/10"],
      [2002, "/tmp/workspaces/1/packages/app"],
      [3003, null],
    ]);

    await expect(
      findWorkspaceCwdProcessIds(output, "/tmp/workspaces/1", {
        readCurrentProcessCwd: async (pid) => currentCwds.get(pid) ?? null,
      }),
    ).resolves.toEqual([2002]);
  });

  it("bounds concurrent workspace cwd rechecks while preserving result order", async () => {
    const output = [
      "p1001",
      "n/tmp/workspaces/1/app-a",
      "p2002",
      "n/tmp/workspaces/1/app-b",
      "p3003",
      "n/tmp/workspaces/1/app-c",
    ].join("\n");
    const releases: Array<() => void> = [];
    const started: number[] = [];
    let inFlight = 0;
    let maxInFlight = 0;
    const waitUntil = async (predicate: () => boolean) => {
      for (let attempt = 0; attempt < 50; attempt += 1) {
        if (predicate()) {
          return;
        }
        await new Promise((resolve) => setTimeout(resolve, 0));
      }
      throw new Error("condition was not reached");
    };

    const resultPromise = findWorkspaceCwdProcessIds(
      output,
      "/tmp/workspaces/1",
      {
        recheckConcurrency: 2,
        readCurrentProcessCwd: async (pid) => {
          started.push(pid);
          inFlight += 1;
          maxInFlight = Math.max(maxInFlight, inFlight);
          await new Promise<void>((resolve) => {
            releases.push(resolve);
          });
          inFlight -= 1;
          return `/tmp/workspaces/1/live-${pid}`;
        },
      },
    );

    await waitUntil(() => started.length === 2);
    expect(maxInFlight).toBe(2);
    releases.shift()?.();
    await waitUntil(() => started.length === 3);
    expect(maxInFlight).toBe(2);
    for (const release of releases.splice(0)) {
      release();
    }

    await expect(resultPromise).resolves.toEqual([1001, 2002, 3003]);
  });

  it("times out stalled workspace cwd rechecks and reports the skipped candidate", async () => {
    const skipped: unknown[] = [];
    await expect(
      findWorkspaceCwdProcessIds(
        ["p1001", "n/tmp/workspaces/1"].join("\n"),
        "/tmp/workspaces/1",
        {
          recheckTimeoutMs: 1,
          readCurrentProcessCwd: async () =>
            new Promise<string | null>(() => {}),
          onSkippedRecheck: (skip) => {
            skipped.push(skip);
          },
        },
      ),
    ).resolves.toEqual([]);
    expect(skipped).toEqual([
      {
        pid: 1001,
        discoveredCwdPath: "/tmp/workspaces/1",
        currentCwdPath: null,
        reason: "current_cwd_timed_out",
      },
    ]);
  });

  it("rechecks combined legacy lsof table output with significant trailing whitespace", async () => {
    const workspacePath = "/tmp/workspaces/team alpha/app  one ";
    const output = [
      "COMMAND   PID USER   FD   TYPE DEVICE SIZE/OFF NODE NAME",
      `node     1001 eric  cwd    DIR   1,23      128  100 ${workspacePath}`,
      `bash     2002 eric  cwd    DIR   1,23      128  101 ${workspacePath}/nested dir`,
      "node     3003 eric  txt    REG   1,23      128  102 /tmp/workspaces/team alpha/app  one ",
      `node     4004 eric  cwd    DIR   1,23      128  103 ${workspacePath}/stale dir`,
      "ambiguous row without enough columns",
    ].join("\n");
    const skipped: unknown[] = [];
    const currentCwds = new Map<number, string | null>([
      [1001, workspacePath],
      [2002, `${workspacePath}/nested dir`],
      [4004, null],
    ]);

    await expect(
      findWorkspaceCwdProcessIds(output, workspacePath, {
        readCurrentProcessCwd: async (pid) => currentCwds.get(pid) ?? null,
        onSkippedRecheck: (skip) => {
          skipped.push(skip);
        },
      }),
    ).resolves.toEqual([1001, 2002]);
    expect(parseLsofCwdProcessEntries(output)).toEqual([
      { pid: 1001, cwdPath: workspacePath },
      { pid: 2002, cwdPath: `${workspacePath}/nested dir` },
      {
        pid: 4004,
        cwdPath: `${workspacePath}/stale dir`,
      },
    ]);
    expect(skipped).toEqual([
      {
        pid: 4004,
        discoveredCwdPath: `${workspacePath}/stale dir`,
        currentCwdPath: null,
        reason: "current_cwd_unavailable",
      },
    ]);
  });

  it("does not emit issue_failed for a budget hard stop pause", async () => {
    const tracker = createTracker();
    const fakeRunner = new FakeAgentRunner();
    const notifier = createMockNotifier();
    const entries: StructuredLogEntry[] = [];
    const logger = new StructuredLogger([
      {
        write(entry) {
          entries.push(entry);
        },
      },
    ]);
    const host = new OrchestratorRuntimeHost({
      config: createConfig(),
      tracker,
      logger,
      notifier,
      createAgentRunner: ({ onEvent }) => {
        fakeRunner.onEvent = onEvent;
        return fakeRunner;
      },
      now: () => new Date("2026-03-06T00:00:05.000Z"),
    });

    await host.pollOnce();
    fakeRunner.resolve("1", {
      ...createNormalResult(),
      hardStop: {
        outcome: "PAUSED-budget",
        trigger: "token_budget",
        reason: "Token budget exceeded.",
        turnCount: 2,
        totalTokens: 250_000,
        estimatedCostUsd: 3.21,
      },
    });
    await host.waitForIdle();

    // Events: dispatched + hard_stop_budget (SYMPH-397)
    expect(notifier.events).toEqual([
      expect.objectContaining({ type: "issue_dispatched" }),
      expect.objectContaining({
        type: "hard_stop_budget",
        issueIdentifier: "ISSUE-1",
      }),
    ]);

    const snapshot = await host.getRuntimeSnapshot();
    expect(snapshot.counts.failed).toBe(0);
    expect(entries).toContainEqual(
      expect.objectContaining({
        event: "worker_exit_paused",
        level: "warn",
        outcome: "paused",
        hard_stop_outcome: "PAUSED-budget",
        hard_stop_trigger: "token_budget",
        hard_stop_total_tokens: 250_000,
      }),
    );
    expect(entries).toContainEqual(
      expect.objectContaining({
        event: "stage_completed",
        level: "warn",
        outcome: "paused",
        hard_stop_outcome: "PAUSED-budget",
        hard_stop_trigger: "token_budget",
        hard_stop_total_tokens: 250_000,
      }),
    );

    const stillActive = await host.pollOnce();
    expect(stillActive.dispatchedIssueIds).toEqual([]);
  });

  it("logs Codex input-required exits as paused and avoids retry burn", async () => {
    const tracker = createTracker();
    const fakeRunner = new FakeAgentRunner();
    const notifier = createMockNotifier();
    const entries: StructuredLogEntry[] = [];
    const logger = new StructuredLogger([
      {
        write(entry) {
          entries.push(entry);
        },
      },
    ]);
    const host = new OrchestratorRuntimeHost({
      config: createConfig(),
      tracker,
      logger,
      notifier,
      createAgentRunner: ({ onEvent }) => {
        fakeRunner.onEvent = onEvent;
        return fakeRunner;
      },
      now: () => new Date("2026-03-06T00:00:05.000Z"),
    });

    await host.pollOnce();
    const error = Object.assign(
      new Error("Codex requested operator input during a turn."),
      { code: ERROR_CODES.codexUserInputRequired },
    );
    fakeRunner.reject("1", error);
    await host.waitForIdle();

    expect(notifier.events).toEqual([
      expect.objectContaining({ type: "issue_dispatched" }),
    ]);
    const snapshot = await host.getRuntimeSnapshot();
    expect(snapshot.counts.failed).toBe(0);
    expect(entries).toContainEqual(
      expect.objectContaining({
        event: "worker_exit_paused",
        level: "warn",
        outcome: "paused",
        pause_reason: ERROR_CODES.codexUserInputRequired,
      }),
    );
    expect(entries).toContainEqual(
      expect.objectContaining({
        event: "stage_completed",
        level: "warn",
        outcome: "paused",
        pause_reason: ERROR_CODES.codexUserInputRequired,
      }),
    );

    const stillActive = await host.pollOnce();
    expect(stillActive.dispatchedIssueIds).toEqual([]);
  });

  it("fires stall_killed when a stall timeout aborts a worker", async () => {
    const tracker = createTracker();
    const fakeRunner = new FakeAgentRunner();
    const notifier = createMockNotifier();
    const host = new OrchestratorRuntimeHost({
      config: createConfig(),
      tracker,
      notifier,
      createAgentRunner: ({ onEvent }) => {
        fakeRunner.onEvent = onEvent;
        return fakeRunner;
      },
      now: () => new Date("2026-03-06T00:00:05.000Z"),
    });

    await host.pollOnce();

    // Simulate the stall timeout triggering reconcileStalledRuns → stopRunningIssue
    tracker.setStateSnapshots([
      { id: "1", identifier: "ISSUE-1", state: "In Progress" },
    ]);
    const reconcileTick = await host.pollOnce();

    // Manually mark this as a stall_timeout stop request to simulate the flow
    // biome-ignore lint/suspicious/noExplicitAny: accessing private field for test setup
    const worker = (host as any).workers.get("1");
    if (worker) {
      worker.stopRequest = {
        issueId: "1",
        issueIdentifier: "ISSUE-1",
        cleanupWorkspace: false,
        reason: "stall_timeout",
      };
      worker.controller.abort("Stopped due to stall_timeout.");
    }
    await host.waitForIdle();

    const stallEvents = notifier.events.filter(
      (e) => e.type === "stall_killed",
    );
    expect(stallEvents).toHaveLength(1);
    expect(stallEvents[0]).toMatchObject({
      type: "stall_killed",
      issueIdentifier: "ISSUE-1",
    });
  });

  it("fires infra_error when worker exits abnormally with 0 turns", async () => {
    const tracker = createTracker();
    const fakeRunner = new FakeAgentRunner();
    const notifier = createMockNotifier();
    const host = new OrchestratorRuntimeHost({
      config: createConfig(),
      tracker,
      notifier,
      createAgentRunner: ({ onEvent }) => {
        fakeRunner.onEvent = onEvent;
        return fakeRunner;
      },
      now: () => new Date("2026-03-06T00:00:05.000Z"),
    });

    await host.pollOnce();
    // Reject immediately — no turns completed, no session events
    fakeRunner.reject("1", new Error("Failed to start agent process"));
    await host.waitForIdle();

    const infraEvents = notifier.events.filter((e) => e.type === "infra_error");
    expect(infraEvents).toHaveLength(1);
    expect(infraEvents[0]).toMatchObject({
      type: "infra_error",
      issueIdentifier: "ISSUE-1",
      errorReason: "Failed to start agent process",
    });
  });

  it("does not fire infra_error when worker exits abnormally with turns completed", async () => {
    const tracker = createTracker();
    const fakeRunner = new FakeAgentRunner();
    const notifier = createMockNotifier();
    const host = new OrchestratorRuntimeHost({
      config: createConfig(),
      tracker,
      notifier,
      createAgentRunner: ({ onEvent }) => {
        fakeRunner.onEvent = onEvent;
        return fakeRunner;
      },
      now: () => new Date("2026-03-06T00:00:05.000Z"),
    });

    await host.pollOnce();
    // Emit session_started (increments turnCount to 1) then turn_completed
    fakeRunner.emit("1", {
      event: "session_started",
      timestamp: "2026-03-06T00:00:01.000Z",
      codexAppServerPid: "1001",
      sessionId: "thread-1-turn-1",
      threadId: "thread-1",
      turnId: "turn-1",
    });
    fakeRunner.emit("1", {
      event: "turn_completed",
      timestamp: "2026-03-06T00:00:02.000Z",
      codexAppServerPid: "1001",
      sessionId: "thread-1-turn-1",
      threadId: "thread-1",
      turnId: "turn-1",
      usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 },
      message: "turn done",
    });
    await host.flushEvents();

    fakeRunner.reject("1", new Error("agent crashed mid-run"));
    await host.waitForIdle();

    const infraEvents = notifier.events.filter((e) => e.type === "infra_error");
    expect(infraEvents).toHaveLength(0);
  });

  it("fires no notification when notifier is null", async () => {
    const tracker = createTracker();
    const fakeRunner = new FakeAgentRunner();
    // No notifier passed — should not throw
    const host = new OrchestratorRuntimeHost({
      config: createConfig(),
      tracker,
      createAgentRunner: ({ onEvent }) => {
        fakeRunner.onEvent = onEvent;
        return fakeRunner;
      },
      now: () => new Date("2026-03-06T00:00:05.000Z"),
    });

    await host.pollOnce();
    fakeRunner.reject("1", new Error("crash"));
    await host.waitForIdle();

    // If we got here without throwing, the test passes
    expect(host.notifier).toBeNull();
  });

  it("fires a second issue_dispatched on rework (reworkCount incrementing)", async () => {
    const tracker = createTracker();
    const fakeRunner = new FakeAgentRunner();
    const notifier = createMockNotifier();
    const host = new OrchestratorRuntimeHost({
      config: createStagedConfig({
        stages: {
          initialStage: "investigate",
          fastTrack: null,
          stages: {
            investigate: {
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
              transitions: {
                onComplete: "implement",
                onApprove: null,
                onRework: null,
              },
              linearState: null,
            },
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
              transitions: {
                onComplete: "review",
                onApprove: null,
                onRework: null,
              },
              linearState: null,
            },
            review: {
              type: "agent",
              runner: null,
              model: null,
              prompt: null,
              maxTurns: null,
              timeoutMs: null,
              concurrency: null,
              gateType: null,
              maxRework: 3,
              reviewers: [],
              transitions: {
                onComplete: "done",
                onApprove: null,
                onRework: "implement",
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
              transitions: {
                onComplete: null,
                onApprove: null,
                onRework: null,
              },
              linearState: null,
            },
          },
        },
      }),
      tracker,
      notifier,
      createAgentRunner: ({ onEvent }) => {
        fakeRunner.onEvent = onEvent;
        return fakeRunner;
      },
      now: () => new Date("2026-03-06T00:00:05.000Z"),
    });

    // Stage 1: investigate → completes, advances to implement (continuation)
    await host.pollOnce();
    fakeRunner.resolve("1", createNormalResult());
    await host.waitForIdle();

    // Only the initial dispatch notification
    expect(notifier.events).toHaveLength(1);
    expect(notifier.events[0]).toMatchObject({
      type: "issue_dispatched",
      reworkCount: 0,
    });

    // Stage 2: implement → completes, advances to review (continuation)
    const retryImpl = await host.runRetryTimer("1");
    expect(retryImpl.dispatched).toBe(true);
    fakeRunner.resolve("1", createNormalResult());
    await host.waitForIdle();

    // No new dispatch notification — continuation, not rework
    expect(notifier.events).toHaveLength(1);

    // Stage 3: review → agent outputs [STAGE_FAILED: review] to trigger rework
    const retryReview = await host.runRetryTimer("1");
    expect(retryReview.dispatched).toBe(true);
    fakeRunner.resolve("1", {
      ...createNormalResult(),
      liveSession: {
        ...createNormalResult().liveSession,
        lastCodexMessage: "[STAGE_FAILED: review]",
      },
    });
    await host.waitForIdle();

    // Still no new dispatch notification — rework is scheduled but not yet dispatched
    expect(notifier.events).toHaveLength(1);

    // Stage 4: implement (rework) — this dispatch should fire a second issue_dispatched
    const retryRework = await host.runRetryTimer("1");
    expect(retryRework.dispatched).toBe(true);

    // Second issue_dispatched notification should have fired with reworkCount: 1
    const dispatchEvents = notifier.events.filter(
      (e) => e.type === "issue_dispatched",
    );
    expect(dispatchEvents).toHaveLength(2);
    expect(dispatchEvents[1]).toMatchObject({
      type: "issue_dispatched",
      issueIdentifier: "ISSUE-1",
      reworkCount: 1,
    });

    // Clean up: resolve the rework run
    fakeRunner.resolve("1", createNormalResult());
    await host.waitForIdle();
  });

  it("onEscalationStep fires escalation_step with real issue title (not identifier)", async () => {
    // Escalation step: hardStop with PAUSED-budget outcome + maxSteps >= 1 triggers
    // onEscalationStep in the orchestrator, which the runtime host routes to the notifier.
    const tracker = createTracker({
      candidates: [createIssue({ title: "Pagination feature" })],
    });
    const fakeRunner = new FakeAgentRunner();
    const notifier = createMockNotifier();
    const host = new OrchestratorRuntimeHost({
      config: {
        ...createConfig(),
        budgetEscalation: { maxSteps: 2, multiplier: 2 },
      },
      tracker,
      notifier,
      createAgentRunner: ({ onEvent }) => {
        fakeRunner.onEvent = onEvent;
        return fakeRunner;
      },
      now: () => new Date("2026-03-06T00:00:05.000Z"),
    });

    await host.pollOnce();
    // Resolve with a budget hard stop — step 1 of 2 triggers escalation, not exhaustion
    fakeRunner.resolve("1", {
      ...createNormalResult(),
      hardStop: {
        outcome: "PAUSED-budget",
        trigger: "token_budget",
        reason: "Token budget exceeded.",
        turnCount: 2,
        totalTokens: 250_000,
        estimatedCostUsd: 3.21,
      },
    });
    await host.waitForIdle();

    const escalationEvents = notifier.events.filter(
      (e) => e.type === "escalation_step",
    );
    expect(escalationEvents).toHaveLength(1);
    expect(escalationEvents[0]).toMatchObject({
      type: "escalation_step",
      issueIdentifier: "ISSUE-1",
      // issueTitle must be the real title, not the fallback identifier
      issueTitle: "Pagination feature",
    });
  });

  it("onHardStopBudget fires hard_stop_budget with real issue title (not identifier)", async () => {
    // Verifies that the hard_stop_budget callback threads the real issue title
    // rather than falling back to the identifier.
    const tracker = createTracker({
      candidates: [createIssue({ title: "Auth refactor" })],
    });
    const fakeRunner = new FakeAgentRunner();
    const notifier = createMockNotifier();
    const host = new OrchestratorRuntimeHost({
      config: {
        ...createConfig(),
        // maxSteps: null => budget escalation ladder not available → hard_stop_budget
        budgetEscalation: { maxSteps: null, multiplier: 2 },
      },
      tracker,
      notifier,
      createAgentRunner: ({ onEvent }) => {
        fakeRunner.onEvent = onEvent;
        return fakeRunner;
      },
      now: () => new Date("2026-03-06T00:00:05.000Z"),
    });

    await host.pollOnce();
    fakeRunner.resolve("1", {
      ...createNormalResult(),
      hardStop: {
        outcome: "PAUSED-budget",
        trigger: "token_budget",
        reason: "Token budget exceeded.",
        turnCount: 2,
        totalTokens: 250_000,
        estimatedCostUsd: 3.21,
      },
    });
    await host.waitForIdle();

    const budgetEvents = notifier.events.filter(
      (e) => e.type === "hard_stop_budget",
    );
    expect(budgetEvents).toHaveLength(1);
    expect(budgetEvents[0]).toMatchObject({
      type: "hard_stop_budget",
      issueIdentifier: "ISSUE-1",
      // issueTitle must be the real title, not the fallback identifier
      issueTitle: "Auth refactor",
    });
  });

  it("onFailureExhausted fires failure_exhausted with real issue title (not identifier)", async () => {
    // Verifies that failure_exhausted threads the real issue title.
    const tracker = createTracker({
      candidates: [createIssue({ title: "Payment gateway fix" })],
    });
    const fakeRunner = new FakeAgentRunner();
    const notifier = createMockNotifier();
    const host = new OrchestratorRuntimeHost({
      config: {
        ...createConfig(),
        agent: { ...createConfig().agent, maxRetryAttempts: 0 },
      },
      tracker,
      notifier,
      createAgentRunner: ({ onEvent }) => {
        fakeRunner.onEvent = onEvent;
        return fakeRunner;
      },
      now: () => new Date("2026-03-06T00:00:05.000Z"),
    });

    await host.pollOnce();
    fakeRunner.reject("1", new Error("agent crashed"));
    await host.waitForIdle();

    const exhaustedEvents = notifier.events.filter(
      (e) => e.type === "failure_exhausted",
    );
    expect(exhaustedEvents).toHaveLength(1);
    expect(exhaustedEvents[0]).toMatchObject({
      type: "failure_exhausted",
      issueIdentifier: "ISSUE-1",
      // issueTitle must be the real title, not the fallback identifier
      issueTitle: "Payment gateway fix",
    });
  });

  it("terminal event with failure_exhausted fires only ONE alert (no redundant issue_failed)", async () => {
    // Verifies council R2 P2: the dedup guard suppresses issue_failed whenever
    // a failure_exhausted alert actually fired — not just when the count-based
    // retriesExhausted proxy is true. A spec failure parks at attempt 0 with
    // maxRetries=5, so retriesExhausted (old proxy: 0 >= 5 = false) would have
    // emitted a redundant issue_failed. The new seam checks failureExhaustedIds.
    const tracker = createTracker({
      candidates: [createIssue({ title: "Spec-fail dedup test" })],
    });
    const fakeRunner = new FakeAgentRunner();
    const notifier = createMockNotifier();
    const host = new OrchestratorRuntimeHost({
      config: {
        ...createConfig(),
        // maxRetryAttempts=5 so attempt 0 is far below the limit:
        // old dedup proxy (0 >= 5 = false) would emit issue_failed even though
        // failure_exhausted was already fired by the spec-failure path.
        agent: { ...createConfig().agent, maxRetryAttempts: 5 },
      },
      tracker,
      notifier,
      createAgentRunner: ({ onEvent }) => {
        fakeRunner.onEvent = onEvent;
        return fakeRunner;
      },
      now: () => new Date("2026-03-06T00:00:05.000Z"),
    });

    await host.pollOnce();
    // Spec failure is terminal — no retry, failure_exhausted fires immediately.
    // Pass the STAGE_FAILED signal via lastCodexMessage (the fallback agentMessage source).
    fakeRunner.resolve("1", {
      ...createNormalResult(),
      liveSession: {
        ...createNormalResult().liveSession,
        lastCodexMessage:
          "[STAGE_FAILED: spec]\nCannot satisfy the acceptance criteria.",
      },
    });
    await host.waitForIdle();

    // Should be in failed state
    const snapshot = await host.getRuntimeSnapshot();
    expect(snapshot.counts.failed).toBe(1);

    // Exactly ONE Slack post for the terminal event: failure_exhausted
    const exhaustedEvents = notifier.events.filter(
      (e) => e.type === "failure_exhausted",
    );
    const failedEvents = notifier.events.filter(
      (e) => e.type === "issue_failed",
    );
    expect(exhaustedEvents).toHaveLength(1);
    // issue_failed must be suppressed — failure_exhausted already covers the terminal alert
    expect(failedEvents).toHaveLength(0);
  });
});

describe("pipeline notifications in startRuntimeService", () => {
  it("fires pipeline_started and pipeline_stopped notifications", async () => {
    const tracker = createTracker({ candidates: [] });
    const fakeRunner = new FakeAgentRunner();
    const notifier = createMockNotifierForService();
    const logger = new StructuredLogger([{ write() {} }]);

    const service = await startRuntimeService({
      config: createConfig(),
      tracker,
      logger,
      notifier,
      workflowWatcher: null,
      runtimeHost: new OrchestratorRuntimeHost({
        config: createConfig(),
        tracker,
        logger,
        notifier,
        agentRunner: fakeRunner,
        now: () => new Date("2026-03-06T00:00:05.000Z"),
      }),
    });

    await service.runtimeHost.flushEvents();

    const startedEvents = notifier.events.filter(
      (e) => e.type === "pipeline_started",
    );
    expect(startedEvents).toHaveLength(1);
    expect(startedEvents[0]).toMatchObject({
      type: "pipeline_started",
    });

    await service.shutdown();

    const stoppedEvents = notifier.events.filter(
      (e) => e.type === "pipeline_stopped",
    );
    expect(stoppedEvents).toHaveLength(1);
    expect(stoppedEvents[0]).toMatchObject({
      type: "pipeline_stopped",
      completedCount: 0,
      failedCount: 0,
    });
  });

  it("pipeline_stopped.completedCount counts only terminal completions", async () => {
    const tracker = createTracker({ candidates: [] });
    const fakeRunner = new FakeAgentRunner();
    const notifier = createMockNotifierForService();
    const logger = new StructuredLogger([{ write() {} }]);

    const runtimeHost = new OrchestratorRuntimeHost({
      config: createConfig(),
      tracker,
      logger,
      notifier,
      agentRunner: fakeRunner,
      now: () => new Date("2026-03-06T00:00:05.000Z"),
    });

    const service = await startRuntimeService({
      config: createConfig(),
      tracker,
      logger,
      notifier,
      workflowWatcher: null,
      runtimeHost,
    });

    await service.runtimeHost.flushEvents();

    // Manipulate state: issue "A" terminally completed, issue "B" mid-continuation
    const state = runtimeHost.getState();
    state.completed.add("A");
    // "B" is mid-continuation — it has a retryAttempts entry but is NOT in completed
    // (after the fix, continuations no longer add to completed)
    state.retryAttempts.B = {
      issueId: "B",
      identifier: "ISSUE-B",
      attempt: 1,
      dueAtMs: Date.parse("2026-03-06T00:01:00.000Z"),
      timerHandle: null,
      error: null,
      delayType: "continuation",
    };

    await service.shutdown();

    const stoppedEvents = notifier.events.filter(
      (e) => e.type === "pipeline_stopped",
    );
    expect(stoppedEvents).toHaveLength(1);
    expect(stoppedEvents[0]).toMatchObject({
      type: "pipeline_stopped",
      completedCount: 1,
      failedCount: 0,
    });
  });

  function createMockNotifierForService() {
    const events: PipelineNotificationEvent[] = [];
    return {
      events,
      notify(event: PipelineNotificationEvent) {
        events.push(event);
      },
    };
  }
});

describe("extractProductName", () => {
  it("extracts product name from WORKFLOW-<product>.md pattern", () => {
    expect(extractProductName("/path/to/WORKFLOW-symphony.md")).toBe(
      "symphony",
    );
  });

  it("returns base name for plain WORKFLOW.md", () => {
    expect(extractProductName("/path/to/WORKFLOW.md")).toBe("WORKFLOW");
  });

  it("handles paths without directory separators", () => {
    expect(extractProductName("WORKFLOW-jony.md")).toBe("jony");
  });
});

describe("createWorkspaceHookLogger", () => {
  it("includes stdout and stderr in structured log entries when non-empty", async () => {
    const entries: StructuredLogEntry[] = [];
    const logger = new StructuredLogger([
      {
        write: (entry) => {
          entries.push(entry);
        },
      },
    ]);
    const hookLog = createWorkspaceHookLogger(logger);

    hookLog({
      level: "error",
      event: "workspace_hook_failed",
      hook: "afterCreate",
      workspacePath: "/tmp/workspace",
      durationMs: 1234,
      exitCode: 1,
      errorCode: "HOOK_FAILED",
      stdout: "some output",
      stderr: "fatal: repository not found",
    });

    // Allow async logger to flush
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      event: "workspace_hook_failed",
      stdout: "some output",
      stderr: "fatal: repository not found",
      exit_code: 1,
      error_code: "HOOK_FAILED",
      duration_ms: 1234,
    });
  });

  it("omits stdout and stderr from structured log entries when empty", async () => {
    const entries: StructuredLogEntry[] = [];
    const logger = new StructuredLogger([
      {
        write: (entry) => {
          entries.push(entry);
        },
      },
    ]);
    const hookLog = createWorkspaceHookLogger(logger);

    hookLog({
      level: "info",
      event: "workspace_hook_completed",
      hook: "beforeRun",
      workspacePath: "/tmp/workspace",
      durationMs: 500,
      exitCode: 0,
      stdout: "",
      stderr: "",
    });

    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(entries).toHaveLength(1);
    expect(entries[0]).not.toHaveProperty("stdout");
    expect(entries[0]).not.toHaveProperty("stderr");
  });

  it("omits stdout and stderr when they are undefined", async () => {
    const entries: StructuredLogEntry[] = [];
    const logger = new StructuredLogger([
      {
        write: (entry) => {
          entries.push(entry);
        },
      },
    ]);
    const hookLog = createWorkspaceHookLogger(logger);

    hookLog({
      level: "info",
      event: "workspace_hook_started",
      hook: "afterCreate",
      workspacePath: "/tmp/workspace",
    });

    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(entries).toHaveLength(1);
    expect(entries[0]).not.toHaveProperty("stdout");
    expect(entries[0]).not.toHaveProperty("stderr");
  });
});

class FakeAgentRunner {
  onEvent: ((event: AgentRunnerEvent) => void) | undefined;
  readonly runInputs: AgentRunInput[] = [];
  readonly runs = new Map<
    string,
    {
      resolve: (result: AgentRunResult) => void;
      reject: (error: Error) => void;
    }
  >();
  readonly abortReasons: string[] = [];

  async run(input: AgentRunInput): Promise<AgentRunResult> {
    this.runInputs.push(input);
    return await new Promise<AgentRunResult>((resolve, reject) => {
      this.runs.set(input.issue.id, { resolve, reject });
      input.signal?.addEventListener(
        "abort",
        () => {
          const reason =
            typeof input.signal?.reason === "string"
              ? input.signal.reason
              : "aborted";
          this.abortReasons.push(reason);
          reject(new Error(reason));
        },
        { once: true },
      );
    });
  }

  emit(
    issueId: string,
    event: Omit<
      AgentRunnerEvent,
      "issueId" | "issueIdentifier" | "attempt" | "workspacePath" | "turnCount"
    > &
      Partial<Pick<AgentRunnerEvent, "turnCount">>,
  ): void {
    this.onEvent?.({
      ...event,
      issueId,
      issueIdentifier: "ISSUE-1",
      attempt: null,
      workspacePath: "/tmp/workspaces/1",
      turnCount: event.turnCount ?? 0,
    });
  }

  resolve(issueId: string, result: AgentRunResult): void {
    const run = this.runs.get(issueId);
    if (run === undefined) {
      throw new Error(`No fake run registered for ${issueId}.`);
    }
    this.runs.delete(issueId);
    run.resolve(result);
  }

  reject(issueId: string, error: Error): void {
    const run = this.runs.get(issueId);
    if (run === undefined) {
      throw new Error(`No fake run registered for ${issueId}.`);
    }
    this.runs.delete(issueId);
    run.reject(error);
  }
}

describe("track-finding filer (SYMPH-763)", () => {
  const sampleRequest = (): TrackFindingFilingRequest => ({
    issueId: "1",
    issueIdentifier: "ISSUE-1",
    issueTitle: "Source issue",
    issueUrl: "https://linear.app/x/issue/ISSUE-1",
    stageName: "review",
    reviewedHeadSha: "head-sha",
    repo: "mobilyze-llc/symphony-ts",
    prNumber: 812,
    findings: [
      {
        fingerprint: "fp-1",
        title: "Track A",
        category: "correctness",
        rationale: "rationale",
        evidence: [],
      },
    ],
  });

  const invokeFiler = (
    host: OrchestratorRuntimeHost,
    request: TrackFindingFilingRequest,
  ): Promise<TrackFindingFilingResult> =>
    (
      host as unknown as {
        fileTrackFindingsBestEffort(
          request: TrackFindingFilingRequest,
        ): Promise<TrackFindingFilingResult>;
      }
    ).fileTrackFindingsBestEffort(request);

  const linearTracker = (): LinearTrackerClient =>
    new LinearTrackerClient({
      endpoint: "https://api.linear.app/graphql",
      apiKey: "token",
      projectSlug: "project",
      activeStates: ["Todo", "In Progress", "In Review", "Resume"],
      fetchFn: vi.fn(),
    });

  const issueReference = () => ({
    id: "1",
    identifier: "ISSUE-1",
    title: "Source issue",
    description: null,
    url: null,
    teamId: "team-1",
    teamKey: "SYMPH",
    projectId: "project-1",
    projectSlug: "symphony",
    labels: [],
    parent: null,
  });

  it("reports every finding unfiled when the tracker is not Linear-backed", async () => {
    const host = new OrchestratorRuntimeHost({
      config: createConfig(),
      tracker: createTracker(),
      createAgentRunner: ({ onEvent }) => {
        const runner = new FakeAgentRunner();
        runner.onEvent = onEvent;
        return runner;
      },
      now: () => new Date("2026-03-06T00:00:05.000Z"),
    });

    const result = await invokeFiler(host, sampleRequest());

    expect(result.filed).toEqual([]);
    expect(result.unfiled).toEqual([
      {
        fingerprint: "fp-1",
        reason: expect.stringContaining("not Linear-backed"),
      },
    ]);
  });

  it("files findings via the Linear client and returns durable refs", async () => {
    const tracker = linearTracker();
    vi.spyOn(tracker, "fetchIssueReferencesByIds").mockResolvedValue([
      issueReference(),
    ]);
    const createSpy = vi
      .spyOn(tracker, "createTrackFindingIssue")
      .mockResolvedValue({
        id: "new-1",
        identifier: "SYMPH-900",
        title: "[track:fp-1] Track A",
        url: "https://linear.app/x/issue/SYMPH-900",
        created: true,
      });
    const host = new OrchestratorRuntimeHost({
      config: createConfig(),
      tracker,
      createAgentRunner: ({ onEvent }) => {
        const runner = new FakeAgentRunner();
        runner.onEvent = onEvent;
        return runner;
      },
      now: () => new Date("2026-03-06T00:00:05.000Z"),
    });

    const result = await invokeFiler(host, sampleRequest());

    expect(createSpy).toHaveBeenCalledTimes(1);
    expect(createSpy.mock.calls[0]?.[0]).toMatchObject({
      teamId: "team-1",
      teamKey: "SYMPH",
      fingerprint: "fp-1",
    });
    expect(result.filed).toEqual([
      {
        fingerprint: "fp-1",
        issueId: "new-1",
        identifier: "SYMPH-900",
        url: "https://linear.app/x/issue/SYMPH-900",
      },
    ]);
    expect(result.unfiled).toEqual([]);
  });

  it("records the exact reason for a finding the tracker fails to file", async () => {
    const tracker = linearTracker();
    vi.spyOn(tracker, "fetchIssueReferencesByIds").mockResolvedValue([
      issueReference(),
    ]);
    vi.spyOn(tracker, "createTrackFindingIssue").mockRejectedValue(
      new Error("Linear 500 Internal Server Error"),
    );
    const host = new OrchestratorRuntimeHost({
      config: createConfig(),
      tracker,
      createAgentRunner: ({ onEvent }) => {
        const runner = new FakeAgentRunner();
        runner.onEvent = onEvent;
        return runner;
      },
      now: () => new Date("2026-03-06T00:00:05.000Z"),
    });

    const result = await invokeFiler(host, sampleRequest());

    expect(result.filed).toEqual([]);
    expect(result.unfiled).toEqual([
      { fingerprint: "fp-1", reason: "Linear 500 Internal Server Error" },
    ]);
  });
});

function createTracker(input?: {
  candidates?: Issue[];
  stateSnapshots?: IssueStateSnapshot[];
}) {
  let candidates = input?.candidates ?? [createIssue()];
  let stateSnapshots: IssueStateSnapshot[] = input?.stateSnapshots ?? [
    { id: "1", identifier: "ISSUE-1", state: "In Progress" },
  ];

  const tracker: IssueTracker & {
    setCandidates(next: Issue[]): void;
    setStateSnapshots(next: IssueStateSnapshot[]): void;
  } = {
    fetchCandidateIssues: vi.fn(async () => candidates),
    fetchIssuesByStates: vi.fn(async () => []),
    fetchIssueStatesByIds: vi.fn(async () => stateSnapshots),
    setCandidates(next) {
      candidates = next;
    },
    setStateSnapshots(next) {
      stateSnapshots = next;
    },
  };

  return tracker;
}

function createLinearTrackerForPipelineStatus(): LinearTrackerClient {
  return new LinearTrackerClient({
    endpoint: "https://api.linear.app/graphql",
    apiKey: "token",
    projectSlug: "pipeline",
    activeStates: ["Todo", "In Progress", "In Review", "Resume"],
    fetchFn: vi.fn(),
  });
}

function readDispatcherJournal(workspaceRoot: string): DispatcherRunJournal {
  const journalPath = join(
    workspaceRoot,
    ".symphony",
    "run-journals",
    "dispatcher.jsonl",
  );
  let raw: string;
  try {
    raw = readFileSync(journalPath, "utf8");
  } catch (error) {
    if (
      typeof error === "object" &&
      error !== null &&
      "code" in error &&
      error.code === "ENOENT"
    ) {
      return [];
    }
    throw error;
  }
  return raw
    .trim()
    .split("\n")
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line) as DispatcherRunJournal[number]);
}

function createRuntimeJournalEntry(
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
      `2026-03-06T00:00:${String(input.sequence).padStart(2, "0")}.000Z`,
    kind: input.kind,
    issueId: input.issueId ?? "1",
    issueIdentifier: input.issueIdentifier ?? "ISSUE-1",
    operation: input.operation ?? "dispatcher",
    stage: input.stage ?? null,
    attempt: input.attempt ?? null,
    ownerId: input.ownerId ?? "previous-runtime",
    lease: input.lease ?? null,
    summary: input.summary ?? "Runtime journal entry.",
    metadata: input.metadata ?? { status: "completed" },
  };
}

function createPipelineStopJournalEntry(
  sequence: number,
  codexAppServerPid: string | null,
  codexAppServerIdentity: ProcessIdentitySnapshot | null = codexAppServerPid !==
    null && /^\d+$/.test(codexAppServerPid)
    ? createProcessIdentity(Number(codexAppServerPid))
    : null,
): DispatcherRunJournalEntry {
  return {
    sequence,
    idempotencyKey: `intent:pipeline_stop:operator@pro14:seq-${sequence}`,
    timestamp: `2026-03-06T00:00:${String(sequence).padStart(2, "0")}.000Z`,
    kind: "intent",
    issueId: "__pipeline__",
    issueIdentifier: "PIPELINE",
    operation: "dispatcher",
    stage: null,
    attempt: null,
    ownerId: "previous-runtime",
    lease: null,
    summary: "Emergency stop applied.",
    metadata: {
      status: "applied",
      verb: "pipeline_stop",
      actor: { kind: "operator", host: "pro14", session: null },
      reason: { class: "operator_emergency_stop", human: "stop now" },
      interruptedIssues: [
        {
          issueId: "1",
          issueIdentifier: "ISSUE-1",
          stage: "implement",
          attempt: null,
          codexAppServerPid,
          codexAppServerIdentity,
        },
      ],
    },
  };
}

function createPipelineResumeJournalEntry(
  sequence: number,
): DispatcherRunJournalEntry {
  return {
    sequence,
    idempotencyKey: `intent:pipeline_resume:operator@pro14:seq-${sequence}`,
    timestamp: `2026-03-06T00:01:${String(sequence).padStart(2, "0")}.000Z`,
    kind: "intent",
    issueId: "__pipeline__",
    issueIdentifier: "PIPELINE",
    operation: "dispatcher",
    stage: null,
    attempt: null,
    ownerId: "previous-runtime",
    lease: null,
    summary: "Emergency stop resumed.",
    metadata: {
      status: "applied",
      verb: "pipeline_resume",
      actor: { kind: "operator", host: "pro14", session: null },
      reason: { class: "operator_resume", human: "triaged" },
    },
  };
}

function createEmergencyStopHardStopJournalEntry(
  sequence: number,
  input: {
    codexAppServerPid: string | null;
    codexAppServerIdentity?: ProcessIdentitySnapshot | null;
    sourceSequence: number;
  },
): DispatcherRunJournalEntry {
  return {
    sequence,
    idempotencyKey: `hard_stop:1:implement:initial:emergency_stop:${sequence}`,
    timestamp: `2026-03-06T00:02:${String(sequence).padStart(2, "0")}.000Z`,
    kind: "hard_stop_trigger",
    issueId: "1",
    issueIdentifier: "ISSUE-1",
    operation: "dispatcher",
    stage: "implement",
    attempt: null,
    ownerId: "previous-runtime",
    lease: null,
    summary: "Emergency stop completed.",
    metadata: {
      status: "completed",
      reason: "emergency_stop",
      issueState: "Todo",
      sourceSequence: input.sourceSequence,
      codexAppServerPid: input.codexAppServerPid,
      codexAppServerIdentity: input.codexAppServerIdentity ?? null,
    },
  };
}

function createProcessIdentity(
  pid: number,
  overrides: Partial<ProcessIdentitySnapshot> = {},
): ProcessIdentitySnapshot {
  return {
    pid,
    processGroupId: pid,
    sessionId: pid,
    startedAt: "linux-starttime:123456",
    command: "bash -lc codex-app-server",
    launchToken: "launch-token",
    ...overrides,
  };
}

function createProcessTreeTerminationResult(input: {
  pid: number | null;
  processGroupId?: number | null;
  sigtermStatus?: NonNullable<
    ProcessTreeTerminationResult["sigterm"]
  >["status"];
  sigkillStatus?: NonNullable<
    ProcessTreeTerminationResult["sigkill"]
  >["status"];
  sigtermSent?: boolean;
  sigkillSent?: boolean;
  identityStatus?: ProcessTreeTerminationResult["identityStatus"];
  postGraceIdentityStatus?: ProcessTreeTerminationResult["postGraceIdentityStatus"];
}): ProcessTreeTerminationResult {
  const sigtermStatus = input.sigtermStatus ?? "delivered";
  const sigkillStatus = input.sigkillStatus ?? "delivered";
  return {
    pid: input.pid,
    processGroupId: input.processGroupId ?? null,
    sigtermSent: input.sigtermSent ?? sigtermStatus !== "failed",
    sigkillSent: input.sigkillSent ?? sigkillStatus !== "failed",
    sigterm: {
      signal: "SIGTERM",
      status: sigtermStatus,
      deliveredTo: sigtermStatus === "delivered" ? "process_group" : null,
      attempts: [],
    },
    sigkill: {
      signal: "SIGKILL",
      status: sigkillStatus,
      deliveredTo: sigkillStatus === "delivered" ? "process_group" : null,
      attempts: [],
    },
    identityStatus: input.identityStatus ?? "matched",
    postGraceIdentityStatus: input.postGraceIdentityStatus ?? "matched",
  };
}

function createIssue(overrides?: Partial<Issue>): Issue {
  return {
    id: "1",
    identifier: "ISSUE-1",
    title: "Issue 1",
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

function createConfig(): ResolvedWorkflowConfig {
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
      turnTimeoutMs: 120_000,
      readTimeoutMs: 5_000,
      stallTimeoutMs: 60_000,
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
      minPrimaryHeadroomPct: null,
      minSecondaryHeadroomPct: null,
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
    continuousFeedback: {
      enabled: false,
      events: ["checkpoint"],
      runner: "pi",
      model: "local-flash",
      role: "continuous-feedback",
      bounceOnFinding: true,
      preflightFailClosed: false,
    },
    stages: null,
    escalationState: null,
  };
}

function createStagedConfig(
  overrides?: Partial<ResolvedWorkflowConfig>,
): ResolvedWorkflowConfig {
  return {
    ...createConfig(),
    stages: {
      initialStage: "investigate",
      fastTrack: null,
      stages: {
        investigate: {
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
          transitions: {
            onComplete: null,
            onApprove: null,
            onRework: null,
          },
          linearState: null,
        },
      },
    },
    ...overrides,
  };
}

function createNormalResult(): AgentRunResult {
  return {
    issue: createIssue({ state: "In Progress" }),
    workspace: {
      path: "/tmp/workspaces/1",
      workspaceKey: "1",
      createdNow: true,
    },
    runAttempt: {
      issueId: "1",
      issueIdentifier: "ISSUE-1",
      attempt: null,
      workspacePath: "/tmp/workspaces/1",
      startedAt: "2026-03-06T00:00:00.000Z",
      status: "succeeded",
    },
    liveSession: {
      sessionId: "thread-1-turn-1",
      threadId: "thread-1",
      turnId: "turn-1",
      codexAppServerPid: "1001",
      codexAppServerIdentity: null,
      lastCodexEvent: "turn_completed",
      lastCodexTimestamp: "2026-03-06T00:00:02.000Z",
      lastCodexMessage: "done",
      codexInputTokens: 100,
      codexOutputTokens: 50,
      codexTotalTokens: 150,
      codexCacheReadTokens: 0,
      codexCacheWriteTokens: 0,
      codexNoCacheTokens: 0,
      codexReasoningTokens: 0,
      codexTotalInputTokens: 100,
      codexTotalOutputTokens: 50,
      lastReportedInputTokens: 100,
      lastReportedOutputTokens: 50,
      lastReportedTotalTokens: 150,
      lastReportedCacheReadTokens: 0,
      lastReportedCacheWriteTokens: 0,
      lastReportedNoCacheTokens: 0,
      lastReportedReasoningTokens: 0,
      turnCount: 1,
      totalStageInputTokens: 0,
      totalStageOutputTokens: 0,
      totalStageTotalTokens: 0,
      totalStageCacheReadTokens: 0,
      totalStageCacheWriteTokens: 0,
      turnHistory: [],
      recentActivity: [],
      tokenTelemetry: [],
      tokenTelemetryObservedCount: 0,
      codexSessionLogs: [],
      rateLimitWindows: {
        primary: null,
        secondary: null,
      },
    },
    turnsCompleted: 1,
    lastTurn: null,
    rateLimits: null,
  };
}

describe("pruneLocalBranches", () => {
  it("PRUNE_DEBOUNCE_MS is 5 minutes", () => {
    expect(OrchestratorRuntimeHost.PRUNE_DEBOUNCE_MS).toBe(300_000);
  });

  it("does not log prune events when SYMPHONY_SKIP_BRANCH_PRUNE is set", async () => {
    vi.stubEnv("SYMPHONY_SKIP_BRANCH_PRUNE", "1");

    const tracker = createTracker();
    const fakeRunner = new FakeAgentRunner();
    const entries: StructuredLogEntry[] = [];
    const logger = new StructuredLogger([
      {
        write(entry) {
          entries.push(entry);
        },
      },
    ]);
    const host = new OrchestratorRuntimeHost({
      config: createConfig(),
      tracker,
      logger,
      createAgentRunner: ({ onEvent }) => {
        fakeRunner.onEvent = onEvent;
        return fakeRunner;
      },
      now: () => new Date("2026-03-06T00:00:05.000Z"),
    });

    await host.pollOnce();
    tracker.setStateSnapshots([
      { id: "1", identifier: "ISSUE-1", state: "Done" },
    ]);
    await host.pollOnce();
    await host.waitForIdle();

    const pruneEvents = entries.filter(
      (e) =>
        e.event === "branch_prune_triggered" ||
        e.event === "branch_prune_debounced",
    );
    expect(pruneEvents).toHaveLength(0);
  });

  it("logs branch_prune_triggered on workspace cleanup", async () => {
    vi.stubEnv("SYMPHONY_SKIP_BRANCH_PRUNE", "");

    const tracker = createTracker();
    const fakeRunner = new FakeAgentRunner();
    const entries: StructuredLogEntry[] = [];
    const logger = new StructuredLogger([
      {
        write(entry) {
          entries.push(entry);
        },
      },
    ]);
    const host = new OrchestratorRuntimeHost({
      config: createConfig(),
      tracker,
      logger,
      createAgentRunner: ({ onEvent }) => {
        fakeRunner.onEvent = onEvent;
        return fakeRunner;
      },
      now: () => new Date("2026-03-06T00:00:05.000Z"),
    });

    await host.pollOnce();
    tracker.setStateSnapshots([
      { id: "1", identifier: "ISSUE-1", state: "Done" },
    ]);
    await host.pollOnce();
    await host.waitForIdle();

    const pruneEvents = entries.filter(
      (e) => e.event === "branch_prune_triggered",
    );
    // pruneLocalBranches fires after workspace cleanup for terminal issues.
    // The spawn itself may fail (symphony-ctl not at test path), but the
    // log event should still be emitted before the spawn attempt.
    expect(pruneEvents.length).toBeGreaterThanOrEqual(1);
  });

  it("debounces rapid successive prune invocations", async () => {
    vi.stubEnv("SYMPHONY_SKIP_BRANCH_PRUNE", "");

    const tracker = createTracker({
      candidates: [
        createIssue({ id: "1", identifier: "ISSUE-1" }),
        createIssue({ id: "2", identifier: "ISSUE-2" }),
      ],
    });
    const fakeRunner = new FakeAgentRunner();
    const entries: StructuredLogEntry[] = [];
    const logger = new StructuredLogger([
      {
        write(entry) {
          entries.push(entry);
        },
      },
    ]);
    const host = new OrchestratorRuntimeHost({
      config: createConfig(),
      tracker,
      logger,
      createAgentRunner: ({ onEvent }) => {
        fakeRunner.onEvent = onEvent;
        return fakeRunner;
      },
      now: () => new Date("2026-03-06T00:00:05.000Z"),
    });

    // Dispatch both issues
    await host.pollOnce();

    // Move both to Done (terminal) — triggers cleanup for both
    tracker.setStateSnapshots([
      { id: "1", identifier: "ISSUE-1", state: "Done" },
      { id: "2", identifier: "ISSUE-2", state: "Done" },
    ]);
    await host.pollOnce();
    await host.waitForIdle();

    const triggered = entries.filter(
      (e) => e.event === "branch_prune_triggered",
    );
    const debounced = entries.filter(
      (e) => e.event === "branch_prune_debounced",
    );

    // First cleanup triggers prune, second is debounced
    expect(triggered.length).toBeGreaterThanOrEqual(1);
    expect(debounced.length).toBeGreaterThanOrEqual(1);
  });
});

describe("state-document enrichment wiring (SYMPH-407)", () => {
  it("composes components, watchdog, as_of_sequence, and deploy drift into one snapshot", async () => {
    const tracker = createTracker();
    const fakeRunner = new FakeAgentRunner();
    const host = new OrchestratorRuntimeHost({
      config: createConfig(),
      tracker,
      createAgentRunner: ({ onEvent }) => {
        fakeRunner.onEvent = onEvent;
        return fakeRunner;
      },
      captureDeployDrift: async () => ({
        running_commit: "aaa1111",
        origin_main_commit: "bbb2222",
        drift: true,
        captured_at: "2026-06-12T10:00:00.000Z",
        note: "captured once at startup",
      }),
      now: () => new Date("2026-06-12T10:00:05.000Z"),
    });

    // First snapshot kicks off the non-blocking deploy-drift capture.
    const first = await host.getRuntimeSnapshot();
    expect(typeof first.as_of_sequence).toBe("number");
    expect(first.watchdog).toEqual({ clusters: [], open_breakers: [] });
    // No notifier wired: the fail-open component reports degraded.
    expect(first.components.slack_notifier).toEqual({
      enabled: false,
      degraded_reason: expect.stringContaining("no notification sink"),
    });
    expect(first.components.ac_gate?.enabled).toBe(false);

    // Let the single-flight capture settle, then it must appear.
    await new Promise((resolve) => setImmediate(resolve));
    const second = await host.getRuntimeSnapshot();
    expect(second.deploy_drift).toEqual({
      running_commit: "aaa1111",
      origin_main_commit: "bbb2222",
      drift: true,
      captured_at: "2026-06-12T10:00:00.000Z",
      note: "captured once at startup",
      freshness: {
        status: "fresh",
        captured_age_seconds: 5,
        threshold_seconds: 600,
      },
      qualified_status: "drift",
    });
  });

  it("serves journal-backed deltas through getStateDelta after dispatch activity", async () => {
    const tracker = createTracker();
    const fakeRunner = new FakeAgentRunner();
    const host = new OrchestratorRuntimeHost({
      config: createConfig(),
      tracker,
      createAgentRunner: ({ onEvent }) => {
        fakeRunner.onEvent = onEvent;
        return fakeRunner;
      },
      captureDeployDrift: async () => null,
      now: () => new Date("2026-06-12T10:00:05.000Z"),
    });

    await host.pollOnce();
    const snapshot = await host.getRuntimeSnapshot();
    expect(snapshot.as_of_sequence).toBeGreaterThan(0);

    const delta = await host.getStateDelta({ sinceSeq: 0 });
    expect(delta.as_of_sequence).toBe(snapshot.as_of_sequence);
    expect(delta.count).toBeGreaterThan(0);
    expect(delta.entries.map((entry) => entry.sequence)).toEqual(
      [...delta.entries.map((entry) => entry.sequence)].sort(
        (left, right) => left - right,
      ),
    );

    // Exact between-cursors read: everything after the first entry.
    const firstSeq = delta.entries[0]!.sequence;
    const tail = await host.getStateDelta({ sinceSeq: firstSeq });
    expect(tail.entries.every((entry) => entry.sequence > firstSeq)).toBe(true);
    expect(tail.count).toBe(delta.count - 1);
  });

  it("hydrates the durable journal for reads issued before the first poll", async () => {
    const workspaceRoot = mkdtempSync(join(tmpdir(), "symph-early-read-"));
    try {
      const config = createConfig();
      config.workspace.root = workspaceRoot;
      const warmRunner = new FakeAgentRunner();
      const warmHost = new OrchestratorRuntimeHost({
        config,
        tracker: createTracker(),
        createAgentRunner: ({ onEvent }) => {
          warmRunner.onEvent = onEvent;
          return warmRunner;
        },
        captureDeployDrift: async () => null,
        now: () => new Date("2026-06-12T10:00:05.000Z"),
      });
      await warmHost.pollOnce();

      // A cold host in the same workspace serves the persisted journal on
      // its very first read — the dashboard starts listening before the
      // first poll cycle, so reads must not see an empty journal.
      const coldRunner = new FakeAgentRunner();
      const coldHost = new OrchestratorRuntimeHost({
        config,
        tracker: createTracker({ candidates: [] }),
        createAgentRunner: ({ onEvent }) => {
          coldRunner.onEvent = onEvent;
          return coldRunner;
        },
        captureDeployDrift: async () => null,
        now: () => new Date("2026-06-12T10:00:06.000Z"),
      });

      const delta = await coldHost.getStateDelta({ sinceSeq: 0 });
      expect(delta.count).toBeGreaterThan(0);
      expect(delta.as_of_sequence).toBeGreaterThan(0);

      const snapshot = await coldHost.getRuntimeSnapshot();
      expect(snapshot.as_of_sequence).toBe(delta.as_of_sequence);
    } finally {
      removeWorkspaceWithRetry(workspaceRoot);
    }
  });

  it("refreshes spec-review snapshots after external dispatcher journal appends", async () => {
    const workspaceRoot = mkdtempSync(join(tmpdir(), "symph-spec-review-"));
    try {
      const config = createConfig();
      config.workspace.root = workspaceRoot;
      const journalDir = join(workspaceRoot, ".symphony", "run-journals");
      const journalPath = join(journalDir, "dispatcher.jsonl");
      mkdirSync(journalDir, { recursive: true });
      const host = new OrchestratorRuntimeHost({
        config,
        tracker: createTracker({ candidates: [] }),
        agentRunner: new FakeAgentRunner(),
        captureDeployDrift: async () => null,
        now: () => new Date("2026-06-12T10:00:05.000Z"),
      });

      const emptySnapshot = await host.getRuntimeSnapshot();
      expect(emptySnapshot.spec_reviews).toEqual({});

      const reviewEntry = createRuntimeJournalEntry({
        sequence: 1,
        idempotencyKey: "spec-review:issue-571:hash-571:valid:artifact-571",
        timestamp: "2026-06-12T10:01:00.000Z",
        kind: "spec_review_result",
        issueId: "issue-571",
        issueIdentifier: "SYMPH-571",
        operation: "tracker_write",
        stage: "spec_review",
        ownerId: "symphony-spec-review-watch",
        summary: "Spec review completed for SYMPH-571.",
        metadata: {
          mode: "warn",
          source: "symphony-spec-review-watch",
          source_intent_hash: "hash-571",
          readiness_state: "valid",
          review_verdict: "ready_as_written",
          artifact_path: "/tmp/spec-review/SYMPH-571.md",
          review_artifact_hash: "artifact-571",
          linear_doc_url: "https://linear.app/mobilyze-llc/document/spec",
          completed_at: "2026-06-12T10:01:00.000Z",
        },
      });
      writeFileSync(journalPath, `${JSON.stringify(reviewEntry)}\n`, {
        flag: "a",
      });

      const refreshedSnapshot = await host.getRuntimeSnapshot();

      expect(refreshedSnapshot.as_of_sequence).toBe(1);
      expect(refreshedSnapshot.spec_reviews?.["issue-571"]).toMatchObject({
        issue_identifier: "SYMPH-571",
        readiness_state: "valid",
        verdict: "ready_as_written",
        mode: "warn",
        source_intent_hash: "hash-571",
        review_artifact_hash: "artifact-571",
        artifact_path: "/tmp/spec-review/SYMPH-571.md",
        linear_doc_url: "https://linear.app/mobilyze-llc/document/spec",
        cursor_range: {
          first_sequence: 1,
          last_sequence: 1,
        },
      });

      const delta = await host.getStateDelta({ sinceSeq: 0 });
      expect(delta.as_of_sequence).toBe(1);
      expect(delta.entries).toEqual([
        expect.objectContaining({
          kind: "spec_review_result",
          issueIdentifier: "SYMPH-571",
        }),
      ]);
    } finally {
      removeWorkspaceWithRetry(workspaceRoot);
    }
  });

  it("limits snapshot refreshes to deduped external read-model journal rows", async () => {
    const workspaceRoot = mkdtempSync(join(tmpdir(), "symph-read-model-"));
    try {
      const config = createConfig();
      config.workspace.root = workspaceRoot;
      const journalDir = join(workspaceRoot, ".symphony", "run-journals");
      const journalPath = join(journalDir, "dispatcher.jsonl");
      mkdirSync(journalDir, { recursive: true });
      const host = new OrchestratorRuntimeHost({
        config,
        tracker: createTracker({ candidates: [] }),
        agentRunner: new FakeAgentRunner(),
        captureDeployDrift: async () => null,
        now: () => new Date("2026-06-12T10:00:05.000Z"),
      });

      await host.getRuntimeSnapshot();
      const unsupportedExternalEntry = createRuntimeJournalEntry({
        sequence: 1,
        kind: "admission",
        issueId: "issue-ignored",
        issueIdentifier: "SYMPH-IGNORED",
        idempotencyKey: "external-admission:issue-ignored",
      });
      writeFileSync(
        journalPath,
        `${JSON.stringify(unsupportedExternalEntry)}\n`,
        {
          flag: "a",
        },
      );

      const ignoredSnapshot = await host.getRuntimeSnapshot();
      expect(ignoredSnapshot.as_of_sequence).toBe(0);
      expect(ignoredSnapshot.spec_reviews).toEqual({});

      const reviewEntry = createRuntimeJournalEntry({
        sequence: 2,
        idempotencyKey: "spec-review:issue-571:hash-571:valid:artifact-571",
        timestamp: "2026-06-12T10:01:00.000Z",
        kind: "spec_review_result",
        issueId: "issue-571",
        issueIdentifier: "SYMPH-571",
        operation: "tracker_write",
        stage: "spec_review",
        ownerId: "symphony-spec-review-watch",
        summary: "Spec review completed for SYMPH-571.",
        metadata: {
          mode: "warn",
          source_intent_hash: "hash-571",
          readiness_state: "valid",
          review_verdict: "ready_as_written",
          review_artifact_hash: "artifact-571",
          completed_at: "2026-06-12T10:01:00.000Z",
        },
      });
      const duplicateReviewEntry = {
        ...reviewEntry,
        sequence: 3,
        summary: "Duplicate spec review row.",
      };
      writeFileSync(
        journalPath,
        `${JSON.stringify(reviewEntry)}\n${JSON.stringify(duplicateReviewEntry)}\n`,
        { flag: "a" },
      );

      const refreshedSnapshot = await host.getRuntimeSnapshot();
      expect(refreshedSnapshot.as_of_sequence).toBe(2);
      expect(
        refreshedSnapshot.spec_reviews?.["issue-571"]?.cursor_range,
      ).toEqual({
        first_sequence: 2,
        last_sequence: 2,
      });

      const delta = await host.getStateDelta({ sinceSeq: 0 });
      expect(delta.entries).toHaveLength(1);
      expect(delta.entries[0]).toMatchObject({
        sequence: 2,
        kind: "spec_review_result",
      });
    } finally {
      removeWorkspaceWithRetry(workspaceRoot);
    }
  });

  it("preserves runtime execution history during spec-review snapshot refreshes", async () => {
    const workspaceRoot = mkdtempSync(join(tmpdir(), "symph-read-model-"));
    try {
      const config = createConfig();
      config.workspace.root = workspaceRoot;
      const journalDir = join(workspaceRoot, ".symphony", "run-journals");
      const journalPath = join(journalDir, "dispatcher.jsonl");
      mkdirSync(journalDir, { recursive: true });
      const host = new OrchestratorRuntimeHost({
        config,
        tracker: createTracker({ candidates: [] }),
        agentRunner: new FakeAgentRunner(),
        captureDeployDrift: async () => null,
        now: () => new Date("2026-06-12T10:00:05.000Z"),
      });

      await host.getRuntimeSnapshot();
      const runtimeOnlyHistory = [
        {
          stageName: "implement",
          durationMs: 12_345,
          totalTokens: 678,
          inputTokens: 456,
          outputTokens: 222,
          turns: 3,
          outcome: "running",
        },
      ];
      host.getState().issueExecutionHistory["issue-583"] = runtimeOnlyHistory;

      const reviewEntry = createRuntimeJournalEntry({
        sequence: 1,
        idempotencyKey: "spec-review:issue-583:hash-583:valid:artifact-583",
        timestamp: "2026-06-12T10:01:00.000Z",
        kind: "spec_review_result",
        issueId: "issue-583",
        issueIdentifier: "SYMPH-583",
        operation: "tracker_write",
        stage: "spec_review",
        ownerId: "symphony-spec-review-watch",
        summary: "Spec review completed for SYMPH-583.",
        metadata: {
          mode: "warn",
          source_intent_hash: "hash-583",
          readiness_state: "valid",
          review_verdict: "ready_as_written",
          review_artifact_hash: "artifact-583",
          completed_at: "2026-06-12T10:01:00.000Z",
        },
      });
      writeFileSync(journalPath, `${JSON.stringify(reviewEntry)}\n`, {
        flag: "a",
      });

      const refreshedSnapshot = await host.getRuntimeSnapshot();

      expect(refreshedSnapshot.spec_reviews?.["issue-583"]).toMatchObject({
        issue_identifier: "SYMPH-583",
        readiness_state: "valid",
      });
      expect(host.getState().issueExecutionHistory["issue-583"]).toEqual(
        runtimeOnlyHistory,
      );
    } finally {
      removeWorkspaceWithRetry(workspaceRoot);
    }
  });

  it("mirrors the persisted runner file view even when live telemetry exists", async () => {
    const workspaceRoot = mkdtempSync(join(tmpdir(), "symph-rl-fileview-"));
    try {
      const fileRateLimits = {
        limit_id: "codex",
        primary: {
          used_percent: 12,
          window_minutes: 300,
          resets_at: 1781200000,
        },
      };
      await persistRateLimitSnapshot(workspaceRoot, {
        observedAt: "2026-06-12T09:00:00.000Z",
        rateLimits: fileRateLimits,
      });

      const config = createConfig();
      config.workspace.root = workspaceRoot;
      const fakeRunner = new FakeAgentRunner();
      const host = new OrchestratorRuntimeHost({
        config,
        tracker: createTracker({ candidates: [] }),
        createAgentRunner: ({ onEvent }) => {
          fakeRunner.onEvent = onEvent;
          return fakeRunner;
        },
        captureDeployDrift: async () => null,
        now: () => new Date("2026-06-12T10:00:05.000Z"),
      });

      // Live telemetry observed before hydration runs: hydration must not
      // assign live state, but it must still mirror the file into the
      // runner_snapshot_file view.
      const liveRateLimits = {
        limit_id: "codex",
        primary: {
          used_percent: 55,
          window_minutes: 300,
          resets_at: 1781300000,
        },
      };
      host.getState().codexRateLimits = liveRateLimits;
      host.getState().codexRateLimitsObservedAt = "2026-06-12T09:30:00.000Z";

      await host.pollOnce();
      const snapshot = await host.getRuntimeSnapshot();

      expect(host.getState().codexRateLimits).toEqual(liveRateLimits);
      expect(snapshot.rate_limit_views.runner_snapshot_file).not.toBeNull();
      expect(snapshot.rate_limit_views.runner_snapshot_file).toMatchObject({
        observed_at: "2026-06-12T09:00:00.000Z",
        primary_used_pct: 12,
      });
      expect(snapshot.rate_limit_views.live_telemetry).toMatchObject({
        observed_at: "2026-06-12T09:30:00.000Z",
        primary_used_pct: 55,
      });
    } finally {
      removeWorkspaceWithRetry(workspaceRoot);
    }
  });
});
