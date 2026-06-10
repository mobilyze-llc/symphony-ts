import { execFile } from "node:child_process";
import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { afterEach, describe, expect, it, vi } from "vitest";

import type {
  ResolvedWorkflowConfig,
  StageDefinition,
} from "../../src/config/types.js";
import type { Issue } from "../../src/domain/model.js";
import { ERROR_CODES } from "../../src/errors/codes.js";
import {
  AgentRunner,
  type AgentRunnerCodexClientFactoryInput,
  type AgentRunnerError,
  WorkspaceHookError,
} from "../../src/index.js";
import type {
  IssueStateSnapshot,
  IssueTracker,
} from "../../src/tracker/tracker.js";

const fixturePath = join(
  dirname(fileURLToPath(import.meta.url)),
  "../fixtures/codex-fake-server.mjs",
);
const execFileAsync = promisify(execFile);

const roots: string[] = [];

afterEach(async () => {
  await Promise.allSettled(
    roots.splice(0).map(async (root) => {
      await rm(root, { recursive: true, force: true });
    }),
  );
});

describe("AgentRunner", () => {
  it("runs a single issue through workspace setup, dynamic Linear tool injection, continuation turns, and state refresh", async () => {
    const root = await createRoot();
    const tracker = createTracker({
      refreshStates: [
        { id: "issue-1", identifier: "ABC-123", state: "In Progress" },
        { id: "issue-1", identifier: "ABC-123", state: "Done" },
      ],
    });
    const fetchFn = vi.fn<typeof fetch>().mockResolvedValue(
      jsonResponse({
        data: {
          viewer: {
            id: "viewer-1",
            name: "Example User",
          },
        },
      }),
    );
    const events: Array<{
      event: string;
      workspacePath: string;
      turnCount: number;
    }> = [];
    const runner = new AgentRunner({
      config: createConfig(root, "linear-tool"),
      tracker,
      fetchFn,
      onEvent: (event) => {
        events.push({
          event: event.event,
          workspacePath: event.workspacePath,
          turnCount: event.turnCount,
        });
      },
    });

    const result = await runner.run({
      issue: ISSUE_FIXTURE,
      attempt: null,
    });

    expect(result.runAttempt.status).toBe("succeeded");
    expect(result.workspace.createdNow).toBe(true);
    expect(result.turnsCompleted).toBe(2);
    expect(result.issue.state).toBe("Done");
    expect(result.liveSession.threadId).toBe("thread-1");
    expect(result.liveSession.turnId).toBe("turn-2");
    expect(result.liveSession.turnCount).toBe(2);
    expect(result.rateLimits).toEqual({
      requests_remaining: 9,
      tokens_remaining: 999,
    });
    expect(fetchFn).toHaveBeenCalledTimes(1);
    expect(tracker.fetchIssueStatesByIds).toHaveBeenCalledTimes(2);
    expect(events.map((event) => event.event)).toContain("turn_completed");
    expect(events.at(-1)).toEqual(
      expect.objectContaining({
        workspacePath: result.workspace.path,
        turnCount: 2,
      }),
    );
  });

  it("keeps the workspace path stable when the issue identifier changes", async () => {
    const root = await createRoot();
    const tracker = createTracker({
      refreshStates: [
        { id: "issue-1", identifier: "RENAMED-456", state: "Done" },
      ],
    });
    const runner = new AgentRunner({
      config: createConfig(root, "unused"),
      tracker,
      createCodexClient: (input) =>
        createStubCodexClient([], input, {
          statuses: ["completed"],
        }),
    });

    const result = await runner.run({
      issue: ISSUE_FIXTURE,
      attempt: null,
    });

    expect(result.issue.identifier).toBe("RENAMED-456");
    expect(result.workspace.path).toBe(join(root, "issue-1"));
    expect(result.runAttempt.workspacePath).toBe(join(root, "issue-1"));
  });

  it("fetches the configured base ref before refreshing a reused workspace", async () => {
    const root = await createRoot();
    const source = join(root, "source");
    const bare = join(root, "source.git");
    const workspacePath = join(root, "issue-1");
    const originalBaseBranch = process.env.SYMPHONY_BASE_BRANCH;
    const refreshLogs: Array<{
      action: string;
      currentHead: string | null;
      desiredBase: string | null;
      previousDesiredBase?: string | null;
      fetchedBaseRef?: string | null;
    }> = [];

    try {
      await mkdir(source);
      await execFileAsync("git", ["init", "-b", "main", source]);
      await git(source, ["config", "user.email", "test@example.com"]);
      await git(source, ["config", "user.name", "Test User"]);
      await writeFile(join(source, "file.txt"), "old\n");
      await git(source, ["add", "file.txt"]);
      await git(source, ["commit", "-m", "old"]);
      const oldRevision = await git(source, ["rev-parse", "HEAD"]);

      await execFileAsync("git", ["clone", "--bare", source, bare]);
      await git(bare, ["update-ref", "refs/remotes/origin/main", oldRevision]);
      await execFileAsync("git", [
        "-C",
        bare,
        "worktree",
        "add",
        workspacePath,
        "-b",
        "worktree/ABC-123",
        "main",
      ]);

      await writeFile(join(source, "file.txt"), "new\n");
      await git(source, ["commit", "-am", "new"]);
      const newRevision = await git(source, ["rev-parse", "HEAD"]);
      process.env.SYMPHONY_BASE_BRANCH = "main";

      const runner = new AgentRunner({
        config: createConfig(root, "unused"),
        tracker: createTracker({
          refreshStates: [
            { id: "issue-1", identifier: "ABC-123", state: "Done" },
          ],
        }),
        workspaceBaseRefreshLogger: (entry) => {
          refreshLogs.push(entry);
        },
        createCodexClient: (input) =>
          createStubCodexClient([], input, {
            statuses: ["completed"],
          }),
      });

      const result = await runner.run({
        issue: ISSUE_FIXTURE,
        attempt: null,
      });

      expect(result.workspace.createdNow).toBe(false);
      expect(await git(workspacePath, ["rev-parse", "HEAD"])).toBe(newRevision);
      expect(refreshLogs).toContainEqual(
        expect.objectContaining({
          action: "reset_hard",
          currentHead: oldRevision,
          desiredBase: newRevision,
          previousDesiredBase: oldRevision,
          fetchedBaseRef: "main",
        }),
      );
    } finally {
      if (originalBaseBranch === undefined) {
        Reflect.deleteProperty(process.env, "SYMPHONY_BASE_BRANCH");
      } else {
        process.env.SYMPHONY_BASE_BRANCH = originalBaseBranch;
      }
    }
  });

  it("falls back to a broad fetch when targeted base candidates are absent", async () => {
    const root = await createRoot();
    const source = join(root, "source");
    const bare = join(root, "source.git");
    const workspacePath = join(root, "issue-1");
    const originalBaseBranch = process.env.SYMPHONY_BASE_BRANCH;
    const refreshLogs: Array<{
      action: string;
      fetchedBaseRef?: string | null;
      reason?: string;
    }> = [];

    try {
      Reflect.deleteProperty(process.env, "SYMPHONY_BASE_BRANCH");
      await mkdir(source);
      await execFileAsync("git", ["init", "-b", "trunk", source]);
      await git(source, ["config", "user.email", "test@example.com"]);
      await git(source, ["config", "user.name", "Test User"]);
      await writeFile(join(source, "file.txt"), "content\n");
      await git(source, ["add", "file.txt"]);
      await git(source, ["commit", "-m", "initial"]);

      await execFileAsync("git", ["clone", "--bare", source, bare]);
      await execFileAsync("git", [
        "-C",
        bare,
        "worktree",
        "add",
        workspacePath,
        "-b",
        "worktree/ABC-123",
        "trunk",
      ]);

      const runner = new AgentRunner({
        config: createConfig(root, "unused"),
        tracker: createTracker({
          refreshStates: [
            { id: "issue-1", identifier: "ABC-123", state: "Done" },
          ],
        }),
        workspaceBaseRefreshLogger: (entry) => {
          refreshLogs.push(entry);
        },
        createCodexClient: (input) =>
          createStubCodexClient([], input, {
            statuses: ["completed"],
          }),
      });

      const result = await runner.run({
        issue: ISSUE_FIXTURE,
        attempt: null,
      });

      expect(result.workspace.createdNow).toBe(false);
      expect(refreshLogs).toContainEqual(
        expect.objectContaining({
          action: "no_base_ref",
          fetchedBaseRef: null,
          reason: "no_candidate_base_ref_resolved",
        }),
      );
    } finally {
      if (originalBaseBranch === undefined) {
        Reflect.deleteProperty(process.env, "SYMPHONY_BASE_BRANCH");
      } else {
        process.env.SYMPHONY_BASE_BRANCH = originalBaseBranch;
      }
    }
  });

  it("sends the rendered workflow prompt first and continuation guidance afterwards", async () => {
    const root = await createRoot();
    const prompts: string[] = [];
    const tracker = createTracker({
      refreshStates: [
        { id: "issue-1", identifier: "ABC-123", state: "In Progress" },
        { id: "issue-1", identifier: "ABC-123", state: "Human Review" },
      ],
    });
    const runner = new AgentRunner({
      config: createConfig(root, "unused"),
      tracker,
      createCodexClient: (input) =>
        createStubCodexClient(prompts, input, {
          statuses: ["completed", "completed"],
        }),
    });

    const result = await runner.run({
      issue: ISSUE_FIXTURE,
      attempt: 2,
    });

    expect(result.turnsCompleted).toBe(2);
    expect(prompts[0]).toBe("Initial prompt for ABC-123 attempt=2");
    expect(prompts[1]).toContain("Continue working on issue ABC-123");
    expect(prompts[1]).toContain("continuation turn 2 of 3");
    expect(prompts[1]).not.toContain("Initial prompt for ABC-123 attempt=2");
  });

  it("returns a hard-stop result when the iteration cap is reached", async () => {
    const root = await createRoot();
    const runner = new AgentRunner({
      config: {
        ...createConfig(root, "unused"),
        hardStops: {
          maxIterations: 2,
          noProgressTurns: 10,
          maxTokensPerUnit: 10_000,
          maxDollarBudgetUsd: 100,
          premiumBudgetPauseRatio: 0.9,
          estimatedCostPer1kTokensUsd: 0.01,
          cachedTokenCostRatio: 0.1,
          maxPrimaryWindowPctPerUnit: null,
          maxSecondaryWindowPctPerUnit: null,
        },
      },
      tracker: createTracker({
        refreshStates: [
          { id: "issue-1", identifier: "ABC-123", state: "In Progress" },
          { id: "issue-1", identifier: "ABC-123", state: "In Progress" },
        ],
      }),
      createCodexClient: (input) =>
        createStubCodexClient([], input, {
          messages: ["still working", "still working more"],
        }),
    });

    const result = await runner.run({
      issue: ISSUE_FIXTURE,
      attempt: null,
    });

    expect(result.turnsCompleted).toBe(2);
    expect(result.hardStop).toMatchObject({
      outcome: "STALLED",
      trigger: "iteration_cap",
    });
  });

  it("returns a hard-stop result after repeated no-progress turns", async () => {
    const root = await createRoot();
    const runner = new AgentRunner({
      config: {
        ...createConfig(root, "unused"),
        hardStops: {
          maxIterations: 5,
          noProgressTurns: 2,
          maxTokensPerUnit: 10_000,
          maxDollarBudgetUsd: 100,
          premiumBudgetPauseRatio: 0.9,
          estimatedCostPer1kTokensUsd: 0.01,
          cachedTokenCostRatio: 0.1,
          maxPrimaryWindowPctPerUnit: null,
          maxSecondaryWindowPctPerUnit: null,
        },
      },
      tracker: createTracker({
        refreshStates: [
          { id: "issue-1", identifier: "ABC-123", state: "In Progress" },
          { id: "issue-1", identifier: "ABC-123", state: "In Progress" },
        ],
      }),
      createCodexClient: (input) =>
        createStubCodexClient([], input, {
          messages: ["same output", "same output"],
        }),
    });

    const result = await runner.run({
      issue: ISSUE_FIXTURE,
      attempt: null,
    });

    expect(result.turnsCompleted).toBe(2);
    expect(result.hardStop).toMatchObject({
      outcome: "STALLED",
      trigger: "no_progress",
    });
  });

  it("pauses for a token budget ceiling before another continuation turn", async () => {
    const root = await createRoot();
    const prompts: string[] = [];
    const tracker = createTracker({
      refreshStates: [
        { id: "issue-1", identifier: "ABC-123", state: "In Progress" },
      ],
    });
    const runner = new AgentRunner({
      config: {
        ...createConfig(root, "unused"),
        hardStops: {
          maxIterations: 5,
          noProgressTurns: 10,
          maxTokensPerUnit: 15,
          maxDollarBudgetUsd: 100,
          premiumBudgetPauseRatio: 0.9,
          estimatedCostPer1kTokensUsd: 0.01,
          cachedTokenCostRatio: 0.1,
          maxPrimaryWindowPctPerUnit: null,
          maxSecondaryWindowPctPerUnit: null,
        },
      },
      tracker,
      createCodexClient: (input) => createStubCodexClient(prompts, input),
    });

    const result = await runner.run({
      issue: ISSUE_FIXTURE,
      attempt: null,
    });

    expect(prompts).toHaveLength(1);
    expect(tracker.fetchIssueStatesByIds).not.toHaveBeenCalled();
    expect(result.hardStop).toMatchObject({
      outcome: "PAUSED-budget",
      trigger: "token_budget",
    });
  });

  it("pauses from in-flight token telemetry before the turn resolves", async () => {
    const root = await createRoot();
    const prompts: string[] = [];
    const close = vi.fn().mockResolvedValue(undefined);
    const continueTurn = vi.fn();
    const tracker = createTracker({
      refreshStates: [
        { id: "issue-1", identifier: "ABC-123", state: "In Progress" },
      ],
    });
    const runner = new AgentRunner({
      config: {
        ...createConfig(root, "unused"),
        hardStops: {
          maxIterations: 5,
          noProgressTurns: 10,
          maxTokensPerUnit: 20,
          maxDollarBudgetUsd: 100,
          premiumBudgetPauseRatio: 0.9,
          estimatedCostPer1kTokensUsd: 0.01,
          cachedTokenCostRatio: 0.1,
          maxPrimaryWindowPctPerUnit: null,
          maxSecondaryWindowPctPerUnit: null,
        },
      },
      tracker,
      createCodexClient: (input) => ({
        async startSession({ prompt }: { prompt: string; title: string }) {
          prompts.push(prompt);
          input.onEvent({
            event: "session_started",
            timestamp: new Date("2026-03-06T00:00:00.000Z").toISOString(),
            codexAppServerPid: "1001",
            sessionId: "thread-1-turn-1",
            threadId: "thread-1",
            turnId: "turn-1",
          });
          input.onEvent({
            event: "notification",
            timestamp: new Date("2026-03-06T00:00:01.000Z").toISOString(),
            codexAppServerPid: "1001",
            sessionId: "thread-1-turn-1",
            threadId: "thread-1",
            turnId: "turn-1",
            message: "live usage update",
            usage: {
              inputTokens: 21,
              outputTokens: 0,
              totalTokens: 21,
            },
          });

          const error = new Error(
            "Codex session closed while a turn was running.",
          ) as Error & { code: string };
          error.code = ERROR_CODES.codexProtocolError;
          throw error;
        },
        continueTurn,
        close,
      }),
    });

    const result = await runner.run({
      issue: ISSUE_FIXTURE,
      attempt: null,
    });

    expect(prompts).toHaveLength(1);
    expect(close).toHaveBeenCalled();
    expect(continueTurn).not.toHaveBeenCalled();
    expect(tracker.fetchIssueStatesByIds).not.toHaveBeenCalled();
    expect(result.turnsCompleted).toBe(1);
    expect(result.lastTurn).toBeNull();
    expect(result.hardStop).toMatchObject({
      outcome: "PAUSED-budget",
      trigger: "token_budget",
      totalTokens: 21,
    });
    expect(result.hardStop?.reason).toContain("Live token telemetry");
  });

  it("pauses with rate_limit_budget from live window telemetry", async () => {
    const root = await createRoot();
    const close = vi.fn().mockResolvedValue(undefined);
    const continueTurn = vi.fn();
    const codexRateLimits = (primaryUsed: number) => ({
      limit_id: "codex",
      primary: {
        used_percent: primaryUsed,
        window_minutes: 300,
        resets_at: 1781093929,
      },
      secondary: {
        used_percent: 50,
        window_minutes: 10080,
        resets_at: 1781137743,
      },
    });
    const runner = new AgentRunner({
      config: {
        ...createConfig(root, "unused"),
        hardStops: {
          maxIterations: 5,
          noProgressTurns: 10,
          maxTokensPerUnit: 1_000_000,
          maxDollarBudgetUsd: 100,
          premiumBudgetPauseRatio: 0.9,
          estimatedCostPer1kTokensUsd: 0.01,
          cachedTokenCostRatio: 0.1,
          maxPrimaryWindowPctPerUnit: 5,
          maxSecondaryWindowPctPerUnit: null,
        },
      },
      tracker: createTracker(),
      createCodexClient: (input) => ({
        async startSession() {
          input.onEvent({
            event: "notification",
            timestamp: new Date("2026-03-06T00:00:01.000Z").toISOString(),
            codexAppServerPid: "1001",
            sessionId: "thread-1-turn-1",
            threadId: "thread-1",
            turnId: "turn-1",
            message: "rate limit baseline",
            rateLimits: codexRateLimits(40),
          });
          input.onEvent({
            event: "notification",
            timestamp: new Date("2026-03-06T00:00:02.000Z").toISOString(),
            codexAppServerPid: "1001",
            sessionId: "thread-1-turn-1",
            threadId: "thread-1",
            turnId: "turn-1",
            message: "rate limit burn",
            rateLimits: codexRateLimits(46),
          });

          const error = new Error(
            "Codex session closed while a turn was running.",
          ) as Error & { code: string };
          error.code = ERROR_CODES.codexProtocolError;
          throw error;
        },
        continueTurn,
        close,
      }),
    });

    const result = await runner.run({
      issue: ISSUE_FIXTURE,
      attempt: null,
    });

    expect(close).toHaveBeenCalled();
    expect(continueTurn).not.toHaveBeenCalled();
    expect(result.hardStop).toMatchObject({
      outcome: "PAUSED-budget",
      trigger: "rate_limit_budget",
    });
    expect(result.hardStop?.reason).toContain("primary window burned 6.0%");
    expect(result.hardStop?.reason).toContain("Live token telemetry");
  });

  it("widens unit budgets by the escalation multiplier (SYMPH-337)", async () => {
    const root = await createRoot();
    const close = vi.fn().mockResolvedValue(undefined);
    const tracker = createTracker({
      refreshStates: [{ id: "issue-1", identifier: "ABC-123", state: "Done" }],
    });
    const runner = new AgentRunner({
      config: {
        ...createConfig(root, "unused"),
        hardStops: {
          maxIterations: 5,
          noProgressTurns: 10,
          maxTokensPerUnit: 20,
          maxDollarBudgetUsd: 100,
          premiumBudgetPauseRatio: 0.9,
          estimatedCostPer1kTokensUsd: 0.01,
          cachedTokenCostRatio: 0.1,
          maxPrimaryWindowPctPerUnit: null,
          maxSecondaryWindowPctPerUnit: null,
        },
      },
      tracker,
      createCodexClient: (input) => ({
        async startSession() {
          input.onEvent({
            event: "notification",
            timestamp: new Date("2026-03-06T00:00:01.000Z").toISOString(),
            codexAppServerPid: "1001",
            sessionId: "thread-1-turn-1",
            threadId: "thread-1",
            turnId: "turn-1",
            message: "live usage update",
            usage: {
              inputTokens: 21,
              outputTokens: 0,
              totalTokens: 21,
            },
          });
          return {
            status: "completed" as const,
            threadId: "thread-1",
            turnId: "turn-1",
            sessionId: "thread-1-turn-1",
            usage: null,
            rateLimits: null,
            message: "turn 1 done",
          };
        },
        continueTurn: vi.fn(),
        close,
      }),
    });

    // 21 tokens exceeds the base 20-token unit budget, but a 2x escalation
    // widens the cap to 40 — the run must NOT pause.
    const result = await runner.run({
      issue: ISSUE_FIXTURE,
      attempt: null,
      budgetMultiplier: 2,
    });

    expect(result.hardStop ?? null).toBeNull();
  });

  it("uses stage hard-stop overrides for live telemetry budget enforcement", async () => {
    const root = await createRoot();
    const close = vi.fn().mockResolvedValue(undefined);
    const continueTurn = vi.fn();
    const stage: StageDefinition = {
      type: "agent",
      runner: null,
      model: null,
      prompt: null,
      maxTurns: null,
      timeoutMs: null,
      hardStops: {
        maxTokensPerUnit: 20,
      },
      concurrency: null,
      gateType: null,
      maxRework: null,
      reviewers: [],
      transitions: { onComplete: "implement", onApprove: null, onRework: null },
      linearState: null,
    };
    const runner = new AgentRunner({
      config: {
        ...createConfig(root, "unused"),
        hardStops: {
          maxIterations: 5,
          noProgressTurns: 10,
          maxTokensPerUnit: 10_000,
          maxDollarBudgetUsd: 100,
          premiumBudgetPauseRatio: 0.9,
          estimatedCostPer1kTokensUsd: 0.01,
          cachedTokenCostRatio: 0.1,
          maxPrimaryWindowPctPerUnit: null,
          maxSecondaryWindowPctPerUnit: null,
        },
      },
      tracker: createTracker(),
      createCodexClient: (input) => ({
        async startSession() {
          input.onEvent({
            event: "notification",
            timestamp: new Date("2026-03-06T00:00:01.000Z").toISOString(),
            codexAppServerPid: "1001",
            sessionId: "thread-1-turn-1",
            threadId: "thread-1",
            turnId: "turn-1",
            message: "live usage update",
            usage: {
              inputTokens: 21,
              outputTokens: 0,
              totalTokens: 21,
            },
          });

          const error = new Error(
            "Codex session closed while a turn was running.",
          ) as Error & { code: string };
          error.code = ERROR_CODES.codexProtocolError;
          throw error;
        },
        continueTurn,
        close,
      }),
    });

    const result = await runner.run({
      issue: ISSUE_FIXTURE,
      attempt: null,
      stageName: "investigate",
      stage,
    });

    expect(close).toHaveBeenCalled();
    expect(continueTurn).not.toHaveBeenCalled();
    expect(result.hardStop).toMatchObject({
      outcome: "PAUSED-budget",
      trigger: "token_budget",
      totalTokens: 21,
    });
    expect(result.hardStop?.reason).toContain("Live token telemetry");
  });

  it("uses stage max_iterations to cap turns below the stage max_turns", async () => {
    const root = await createRoot();
    const prompts: string[] = [];
    const stage: StageDefinition = {
      type: "agent",
      runner: null,
      model: null,
      prompt: null,
      maxTurns: 5,
      timeoutMs: null,
      hardStops: {
        maxIterations: 2,
      },
      concurrency: null,
      gateType: null,
      maxRework: null,
      reviewers: [],
      transitions: { onComplete: "implement", onApprove: null, onRework: null },
      linearState: null,
    };
    const tracker = createTracker({
      refreshStates: [
        { id: "issue-1", identifier: "ABC-123", state: "In Progress" },
        { id: "issue-1", identifier: "ABC-123", state: "In Progress" },
      ],
    });
    const runner = new AgentRunner({
      config: {
        ...createConfig(root, "unused"),
        hardStops: {
          maxIterations: 5,
          noProgressTurns: 10,
          maxTokensPerUnit: 10_000,
          maxDollarBudgetUsd: 100,
          premiumBudgetPauseRatio: 0.9,
          estimatedCostPer1kTokensUsd: 0.01,
          cachedTokenCostRatio: 0.1,
          maxPrimaryWindowPctPerUnit: null,
          maxSecondaryWindowPctPerUnit: null,
        },
      },
      tracker,
      createCodexClient: (input) =>
        createStubCodexClient(prompts, input, {
          messages: ["still working", "still working more"],
        }),
    });

    const result = await runner.run({
      issue: ISSUE_FIXTURE,
      attempt: null,
      stageName: "investigate",
      stage,
    });

    expect(prompts).toHaveLength(2);
    expect(result.hardStop).toMatchObject({
      outcome: "STALLED",
      trigger: "iteration_cap",
      turnCount: 2,
    });
  });

  it("does not use heartbeat telemetry as the live budget stop trigger", async () => {
    const root = await createRoot();
    const prompts: string[] = [];
    const close = vi.fn().mockResolvedValue(undefined);
    const tracker = createTracker({
      refreshStates: [
        { id: "issue-1", identifier: "ABC-123", state: "In Progress" },
      ],
    });
    const runner = new AgentRunner({
      config: {
        ...createConfig(root, "unused"),
        hardStops: {
          maxIterations: 5,
          noProgressTurns: 10,
          maxTokensPerUnit: 20,
          maxDollarBudgetUsd: 100,
          premiumBudgetPauseRatio: 0.9,
          estimatedCostPer1kTokensUsd: 0.01,
          cachedTokenCostRatio: 0.1,
          maxPrimaryWindowPctPerUnit: null,
          maxSecondaryWindowPctPerUnit: null,
        },
      },
      tracker,
      createCodexClient: (input) => ({
        async startSession({ prompt }: { prompt: string; title: string }) {
          prompts.push(prompt);
          input.onEvent({
            event: "session_started",
            timestamp: new Date("2026-03-06T00:00:00.000Z").toISOString(),
            codexAppServerPid: "1001",
            sessionId: "thread-1-turn-1",
            threadId: "thread-1",
            turnId: "turn-1",
          });
          input.onEvent({
            event: "activity_heartbeat",
            timestamp: new Date("2026-03-06T00:00:01.000Z").toISOString(),
            codexAppServerPid: "1001",
            sessionId: "thread-1-turn-1",
            threadId: "thread-1",
            turnId: "turn-1",
            message: "workspace activity",
            usage: {
              inputTokens: 21,
              outputTokens: 0,
              totalTokens: 21,
            },
          });
          expect(close).not.toHaveBeenCalled();

          return {
            status: "completed" as const,
            threadId: "thread-1",
            turnId: "turn-1",
            sessionId: "thread-1-turn-1",
            usage: {
              inputTokens: 21,
              outputTokens: 0,
              totalTokens: 21,
            },
            rateLimits: null,
            message: "turn 1",
          };
        },
        continueTurn: vi.fn(),
        close,
      }),
    });

    const result = await runner.run({
      issue: ISSUE_FIXTURE,
      attempt: null,
    });

    expect(prompts).toHaveLength(1);
    expect(result.hardStop).toMatchObject({
      outcome: "PAUSED-budget",
      trigger: "token_budget",
      totalTokens: 21,
    });
    expect(result.hardStop?.reason).not.toContain("Live token telemetry");
  });

  it("lets explicit stage completion win over a same-turn budget ceiling", async () => {
    const root = await createRoot();
    const prompts: string[] = [];
    const tracker = createTracker({
      refreshStates: [
        { id: "issue-1", identifier: "ABC-123", state: "In Progress" },
      ],
    });
    const runner = new AgentRunner({
      config: {
        ...createConfig(root, "unused"),
        hardStops: {
          maxIterations: 5,
          noProgressTurns: 10,
          maxTokensPerUnit: 15,
          maxDollarBudgetUsd: 100,
          premiumBudgetPauseRatio: 0.9,
          estimatedCostPer1kTokensUsd: 0.01,
          cachedTokenCostRatio: 0.1,
          maxPrimaryWindowPctPerUnit: null,
          maxSecondaryWindowPctPerUnit: null,
        },
      },
      tracker,
      createCodexClient: (input) =>
        createStubCodexClient(prompts, input, {
          messages: ["Done with implementation.\n[STAGE_COMPLETE]"],
        }),
    });

    const result = await runner.run({
      issue: ISSUE_FIXTURE,
      attempt: null,
      stageName: "implement",
    });

    expect(prompts).toHaveLength(1);
    expect(result.turnsCompleted).toBe(1);
    expect(result.lastTurn?.message).toContain("[STAGE_COMPLETE]");
    expect(result.hardStop).toBeNull();
    expect(tracker.fetchIssueStatesByIds).not.toHaveBeenCalled();
  });

  it("passes mode-scoped approval and sandbox policy to the Codex client", async () => {
    const root = await createRoot();
    const prompts: string[] = [];
    const factoryInputs: AgentRunnerCodexClientFactoryInput[] = [];
    const runner = new AgentRunner({
      config: createConfig(root, "unused"),
      tracker: createTracker({
        refreshStates: [
          { id: "issue-1", identifier: "ABC-123", state: "Done" },
        ],
      }),
      createCodexClient: (input) => {
        factoryInputs.push(input);
        return createStubCodexClient(prompts, input);
      },
    });

    await runner.run({
      issue: ISSUE_FIXTURE,
      attempt: null,
      modePolicy: {
        mode: "prototype",
        approvalPolicy: "never",
        threadSandbox: "workspace-write",
        turnSandboxPolicy: { type: "workspace-write", networkAccess: false },
        claudePermissionMode: "acceptEdits",
        canOpenPullRequest: false,
        canAutoMerge: false,
        canBypassGates: false,
        maxBudgetUsd: 5,
      },
    });

    expect(factoryInputs[0]).toMatchObject({
      approvalPolicy: "never",
      threadSandbox: "workspace-write",
      turnSandboxPolicy: { type: "workspace-write", networkAccess: false },
    });
    expect(factoryInputs[0]?.artifactDirectory).toBe(
      join(root, ".symphony", "codex-sessions", ISSUE_FIXTURE.id),
    );
    expect(factoryInputs[0]?.artifactDirectory).not.toContain(
      join(root, ISSUE_FIXTURE.id, ".symphony"),
    );
    expect(prompts[0]).toContain("## Mode Permission Envelope");
    expect(prompts[0]).toContain("Mode: prototype");
    expect(prompts[0]).toContain("Pull requests: denied");
  });

  it("uses the sanitized workspace key for durable Codex trace artifacts", async () => {
    const root = await createRoot();
    const workspacePath = join(root, "safe-workspace-key");
    const factoryInputs: AgentRunnerCodexClientFactoryInput[] = [];
    const mockWorkspaceManager = {
      root,
      createForIssue: vi.fn().mockResolvedValue({
        path: workspacePath,
        workspaceKey: "safe-workspace-key",
        createdNow: true,
      }),
      removeForIssue: vi.fn(),
      resolveForIssue: vi.fn(),
    };
    const issue: Issue = {
      ...ISSUE_FIXTURE,
      id: "../unsafe-issue-id",
    };
    const runner = new AgentRunner({
      config: createConfig(root, "unused"),
      tracker: createTracker({
        refreshStates: [
          { id: issue.id, identifier: issue.identifier, state: "Done" },
        ],
      }),
      workspaceManager: mockWorkspaceManager as never,
      createCodexClient: (input) => {
        factoryInputs.push(input);
        return createStubCodexClient([], input, {
          statuses: ["completed"],
        });
      },
    });

    await runner.run({ issue, attempt: null });

    expect(mockWorkspaceManager.createForIssue).toHaveBeenCalledWith(
      "../unsafe-issue-id",
    );
    expect(factoryInputs[0]?.artifactDirectory).toBe(
      join(root, ".symphony", "codex-sessions", "safe-workspace-key"),
    );
    expect(factoryInputs[0]?.artifactDirectory).not.toContain("unsafe");
  });

  it("emits promptChars and estimatedPromptTokens on agent events", async () => {
    const root = await createRoot();
    const prompts: string[] = [];
    const capturedEvents: Array<{
      event: string;
      promptChars: number | undefined;
      estimatedPromptTokens: number | undefined;
      turnCount: number;
    }> = [];
    const tracker = createTracker({
      refreshStates: [
        { id: "issue-1", identifier: "ABC-123", state: "In Progress" },
        { id: "issue-1", identifier: "ABC-123", state: "Human Review" },
      ],
    });
    const promptTemplate =
      "You are an expert software engineer working on the following issue.\n\nIssue: {{ issue.identifier }}\nTitle: {{ issue.title }}\nDescription: {{ issue.description }}\nState: {{ issue.state }}\nAttempt: {{ attempt }}\n\nInstructions:\n- Read the issue description carefully.\n- Implement all required changes.\n- Write tests for any new functionality.\n- Run the full test suite and fix any failures.\n- Follow the existing code style and conventions.\n- Write clear commit messages.\n- Open a pull request when done.\n- Do not modify unrelated code.\n- Do not skip tests.\n- Document any architectural decisions.\n";
    const runner = new AgentRunner({
      config: { ...createConfig(root, "unused"), promptTemplate },
      tracker,
      onEvent: (event) => {
        capturedEvents.push({
          event: event.event,
          promptChars: event.promptChars,
          estimatedPromptTokens: event.estimatedPromptTokens,
          turnCount: event.turnCount,
        });
      },
      createCodexClient: (input) =>
        createStubCodexClient(prompts, input, {
          statuses: ["completed", "completed"],
        }),
    });

    await runner.run({
      issue: ISSUE_FIXTURE,
      attempt: null,
    });

    expect(prompts).toHaveLength(2);

    // Events for turn 1 should carry turn 1 prompt metrics
    const turn1Events = capturedEvents.filter((e) => e.turnCount === 1);
    expect(turn1Events.length).toBeGreaterThan(0);
    const turn1PromptChars = turn1Events[0]?.promptChars;
    expect(turn1PromptChars).toBe(prompts[0]?.length);
    expect(turn1Events[0]?.estimatedPromptTokens).toBe(
      Math.ceil((turn1PromptChars ?? 0) / 4),
    );

    // Events for turn 2 should carry turn 2 prompt metrics
    const turn2Events = capturedEvents.filter((e) => e.turnCount === 2);
    expect(turn2Events.length).toBeGreaterThan(0);
    const turn2PromptChars = turn2Events[0]?.promptChars;
    expect(turn2PromptChars).toBe(prompts[1]?.length);
    expect(prompts[1]).toContain("cmd_status");
    expect(turn2Events[0]?.estimatedPromptTokens).toBe(
      Math.ceil((turn2PromptChars ?? 0) / 4),
    );
  });

  it("loads file-backed stage prompts before starting the first turn", async () => {
    const root = await createRoot();
    const prompts: string[] = [];
    const workspacePath = join(root, "issue-workspace");
    await mkdir(join(root, "prompts"), { recursive: true });
    await writeFile(
      join(root, "prompts", "investigate.liquid"),
      "Investigation Token Brake {{ issue.identifier }} {{ stageName }}",
    );

    const config = createConfig(root, "unused");
    config.workflowPath = join(root, "WORKFLOW.md");
    config.stages = {
      initialStage: "investigate",
      fastTrack: null,
      stages: {
        investigate: {
          type: "agent",
          runner: null,
          model: null,
          prompt: "prompts/investigate.liquid",
          maxTurns: 1,
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
    const stage = config.stages.stages.investigate;
    if (stage === undefined) {
      throw new Error("Expected investigate stage");
    }
    const runner = new AgentRunner({
      config,
      tracker: createTracker(),
      workspaceManager: {
        root,
        createForIssue: vi.fn().mockResolvedValue({
          path: workspacePath,
          workspaceKey: "issue-workspace",
          createdNow: true,
        }),
        removeForIssue: vi.fn().mockResolvedValue(true),
        resolveForIssue: vi.fn(),
      } as never,
      createCodexClient: (input) =>
        createStubCodexClient(prompts, input, {
          statuses: ["completed"],
        }),
    });

    await runner.run({
      issue: ISSUE_FIXTURE,
      attempt: null,
      stage,
      stageName: "investigate",
    });

    expect(prompts).toHaveLength(1);
    expect(prompts[0]).toContain("Investigation Token Brake ABC-123");
    expect(prompts[0]).toContain("investigate");
    expect(prompts[0]).not.toContain("prompts/investigate.liquid");
  });

  it("fails immediately when before_run fails and still invokes after_run best-effort", async () => {
    const root = await createRoot();
    const hooks = {
      run: vi.fn(async ({ name }: { name: string }) => {
        if (name !== "beforeRun") {
          return false;
        }

        throw new WorkspaceHookError({
          code: ERROR_CODES.hookFailed,
          message: "before_run hook failed",
          hook: "beforeRun",
          workspacePath: join(root, "issue-1"),
          exitCode: 1,
        });
      }),
      runBestEffort: vi.fn(),
    };
    const createCodexClient = vi.fn();
    const runner = new AgentRunner({
      config: createConfig(root, "unused"),
      tracker: createTracker(),
      hooks: hooks as never,
      createCodexClient,
    });

    await expect(
      runner.run({
        issue: ISSUE_FIXTURE,
        attempt: null,
      }),
    ).rejects.toMatchObject({
      name: "AgentRunnerError",
      code: ERROR_CODES.hookFailed,
      status: "failed",
      failedPhase: "preparing_workspace",
    } satisfies Partial<AgentRunnerError>);

    expect(createCodexClient).not.toHaveBeenCalled();
    expect(hooks.runBestEffort).toHaveBeenCalledWith({
      name: "afterRun",
      workspacePath: join(root, "issue-1"),
    });
  });

  it("removes temporary workspace artifacts before each attempt starts", async () => {
    const root = await createRoot();
    const workspacePath = join(root, "issue-1");
    await mkdir(join(workspacePath, "tmp"), { recursive: true });

    const hooks = {
      run: vi.fn(
        async ({
          name,
          workspacePath,
        }: {
          name: string;
          workspacePath: string;
        }) => {
          if (name === "beforeRun") {
            await expect(
              stat(join(workspacePath, "tmp")),
            ).rejects.toMatchObject({ code: "ENOENT" });
          }
          return true;
        },
      ),
      runBestEffort: vi.fn().mockResolvedValue(true),
    };

    const runner = new AgentRunner({
      config: createConfig(root, "unused"),
      tracker: createTracker({
        refreshStates: [
          { id: "issue-1", identifier: "ABC-123", state: "Done" },
        ],
      }),
      hooks: hooks as never,
      createCodexClient: (input) =>
        createStubCodexClient([], input, {
          statuses: ["completed"],
        }),
    });

    const result = await runner.run({
      issue: ISSUE_FIXTURE,
      attempt: 1,
    });

    expect(result.runAttempt.status).toBe("succeeded");
    expect(hooks.run).toHaveBeenCalledWith({
      name: "beforeRun",
      workspacePath,
    });
  });

  it("closes the session and still runs after_run best-effort when refresh fails", async () => {
    const root = await createRoot();
    const close = vi.fn().mockResolvedValue(undefined);
    const hooks = {
      run: vi.fn().mockResolvedValue(true),
      runBestEffort: vi.fn().mockResolvedValue(false),
    };
    const runner = new AgentRunner({
      config: createConfig(root, "unused"),
      tracker: {
        fetchCandidateIssues: vi.fn(),
        fetchIssuesByStates: vi.fn(),
        fetchIssueStatesByIds: vi
          .fn()
          .mockRejectedValue(new Error("refresh failed")),
      },
      hooks: hooks as never,
      createCodexClient: (input) =>
        createStubCodexClient([], input, {
          close,
          statuses: ["completed"],
        }),
    });

    await expect(
      runner.run({
        issue: ISSUE_FIXTURE,
        attempt: null,
      }),
    ).rejects.toMatchObject({
      name: "AgentRunnerError",
      status: "failed",
      failedPhase: "finishing",
      message: "refresh failed",
    } satisfies Partial<AgentRunnerError>);

    expect(close).toHaveBeenCalledTimes(1);
    expect(hooks.runBestEffort).toHaveBeenCalledWith({
      name: "afterRun",
      workspacePath: expect.stringContaining("issue-1"),
    });
  });

  it("removes existing workspace on fresh dispatch at initial stage", async () => {
    const root = await createRoot();
    const workspacePath = join(root, "issue-1");
    const removeForIssue = vi.fn().mockResolvedValue(true);
    const createForIssue = vi.fn().mockResolvedValue({
      path: workspacePath,
      workspaceKey: "issue-1",
      createdNow: true,
    });
    const mockWorkspaceManager = {
      root,
      createForIssue,
      removeForIssue,
      resolveForIssue: vi.fn(),
    };
    const config = createConfig(root, "unused");
    config.stages = {
      initialStage: "investigate",
      fastTrack: null,
      stages: {
        investigate: {
          type: "agent",
          runner: null,
          model: null,
          prompt: null,
          maxTurns: 3,
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
    const runner = new AgentRunner({
      config,
      tracker: createTracker({
        refreshStates: [
          { id: "issue-1", identifier: "ABC-123", state: "Done" },
        ],
      }),
      workspaceManager: mockWorkspaceManager as never,
      createCodexClient: (input) =>
        createStubCodexClient([], input, {
          statuses: ["completed"],
        }),
    });

    await runner.run({
      issue: ISSUE_FIXTURE,
      attempt: null,
      stageName: "investigate",
    });

    expect(removeForIssue).toHaveBeenCalledWith("issue-1");
    expect(createForIssue).toHaveBeenCalledWith("issue-1");
  });

  it("does NOT remove workspace on flat dispatch (no stages)", async () => {
    const root = await createRoot();
    const workspacePath = join(root, "issue-1");
    const removeForIssue = vi.fn().mockResolvedValue(true);
    const createForIssue = vi.fn().mockResolvedValue({
      path: workspacePath,
      workspaceKey: "issue-1",
      createdNow: true,
    });
    const mockWorkspaceManager = {
      root,
      createForIssue,
      removeForIssue,
      resolveForIssue: vi.fn(),
    };
    const runner = new AgentRunner({
      config: createConfig(root, "unused"),
      tracker: createTracker({
        refreshStates: [
          { id: "issue-1", identifier: "ABC-123", state: "Done" },
        ],
      }),
      workspaceManager: mockWorkspaceManager as never,
      createCodexClient: (input) =>
        createStubCodexClient([], input, {
          statuses: ["completed"],
        }),
    });

    await runner.run({
      issue: ISSUE_FIXTURE,
      attempt: null,
    });

    expect(removeForIssue).not.toHaveBeenCalled();
    expect(createForIssue).toHaveBeenCalledWith("issue-1");
  });

  it("refreshes a reused stale workspace to the fetched base before dispatch", async () => {
    const sandbox = await createRoot();
    const remotePath = join(sandbox, "remote.git");
    const seedPath = join(sandbox, "seed");
    const workspaceRoot = join(sandbox, "workspaces");
    const workspacePath = join(workspaceRoot, "issue-1");
    await mkdir(workspaceRoot, { recursive: true });

    await execFileAsync("git", ["init", "--bare", remotePath]);
    await execFileAsync("git", ["init", seedPath]);
    await git(seedPath, ["config", "user.email", "symphony@example.test"]);
    await git(seedPath, ["config", "user.name", "Symphony Test"]);
    await writeFile(join(seedPath, "README.md"), "first\n");
    await writeFile(join(seedPath, "workpad.md"), "committed workpad\n");
    await git(seedPath, ["add", "README.md", "workpad.md"]);
    await git(seedPath, ["commit", "-m", "initial"]);
    await git(seedPath, ["branch", "-M", "main"]);
    await git(seedPath, ["remote", "add", "origin", remotePath]);
    await git(seedPath, ["push", "-u", "origin", "main"]);
    await execFileAsync("git", [
      "-C",
      remotePath,
      "symbolic-ref",
      "HEAD",
      "refs/heads/main",
    ]);
    const staleHead = await git(seedPath, ["rev-parse", "HEAD"]);

    await writeFile(join(seedPath, "README.md"), "second\n");
    await git(seedPath, ["commit", "-am", "advance main"]);
    await git(seedPath, ["push", "origin", "main"]);
    const currentBase = await git(seedPath, ["rev-parse", "HEAD"]);

    await execFileAsync("git", ["clone", remotePath, workspacePath]);
    await git(workspacePath, ["checkout", "-b", "worker", staleHead]);
    await writeFile(join(workspacePath, "workpad.md"), "local worker note\n");

    const refreshLogs: unknown[] = [];
    const config = createConfig(workspaceRoot, "unused");
    config.stages = {
      initialStage: "investigate",
      fastTrack: null,
      stages: {
        investigate: {
          type: "agent",
          runner: null,
          model: null,
          prompt: null,
          maxTurns: 3,
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
          maxTurns: 3,
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
    const runner = new AgentRunner({
      config,
      tracker: createTracker({
        refreshStates: [
          { id: "issue-1", identifier: "ABC-123", state: "Done" },
        ],
      }),
      workspaceBaseRefreshLogger: (entry) => {
        refreshLogs.push(entry);
      },
      createCodexClient: (input) =>
        createStubCodexClient([], input, {
          statuses: ["completed"],
        }),
    });

    await runner.run({
      issue: ISSUE_FIXTURE,
      attempt: null,
      stageName: "implement",
    });

    expect(await git(workspacePath, ["rev-parse", "HEAD"])).toBe(currentBase);
    await expect(
      readFile(join(workspacePath, "workpad.md"), "utf8"),
    ).resolves.toBe("local worker note\n");
    expect(refreshLogs).toContainEqual(
      expect.objectContaining({
        issueId: "issue-1",
        issueIdentifier: "ABC-123",
        workspacePath,
        stageName: "implement",
        currentHead: staleHead,
        desiredBase: currentBase,
        baseRef: "origin/main",
        action: "rebase_autostash",
        dirty: true,
      }),
    );
  });

  it("does NOT remove workspace on continuation (attempt !== null)", async () => {
    const root = await createRoot();
    const workspacePath = join(root, "issue-1");
    const removeForIssue = vi.fn().mockResolvedValue(true);
    const createForIssue = vi.fn().mockResolvedValue({
      path: workspacePath,
      workspaceKey: "issue-1",
      createdNow: false,
    });
    const mockWorkspaceManager = {
      root,
      createForIssue,
      removeForIssue,
      resolveForIssue: vi.fn(),
    };
    const runner = new AgentRunner({
      config: createConfig(root, "unused"),
      tracker: createTracker({
        refreshStates: [
          { id: "issue-1", identifier: "ABC-123", state: "Done" },
        ],
      }),
      workspaceManager: mockWorkspaceManager as never,
      createCodexClient: (input) =>
        createStubCodexClient([], input, {
          statuses: ["completed"],
        }),
    });

    await runner.run({
      issue: ISSUE_FIXTURE,
      attempt: 1,
    });

    expect(removeForIssue).not.toHaveBeenCalled();
    expect(createForIssue).toHaveBeenCalledWith("issue-1");
  });

  it("breaks the turn loop early when the agent emits [STAGE_COMPLETE]", async () => {
    const root = await createRoot();
    const tracker = createTracker({
      refreshStates: [
        // Would keep going if not for early exit — issue stays active
        { id: "issue-1", identifier: "ABC-123", state: "In Progress" },
        { id: "issue-1", identifier: "ABC-123", state: "In Progress" },
      ],
    });
    const runner = new AgentRunner({
      config: createConfig(root, "unused"),
      tracker,
      createCodexClient: (input) => {
        let turn = 0;
        return {
          async startSession({ prompt }: { prompt: string; title: string }) {
            turn += 1;
            input.onEvent({
              event: "session_started",
              timestamp: new Date().toISOString(),
              codexAppServerPid: "1001",
              sessionId: `thread-1-turn-${turn}`,
              threadId: "thread-1",
              turnId: `turn-${turn}`,
            });
            return {
              status: "completed" as const,
              threadId: "thread-1",
              turnId: `turn-${turn}`,
              sessionId: `thread-1-turn-${turn}`,
              usage: null,
              rateLimits: null,
              message: "Done with investigation.\n[STAGE_COMPLETE]",
            };
          },
          async continueTurn(prompt: string) {
            turn += 1;
            input.onEvent({
              event: "session_started",
              timestamp: new Date().toISOString(),
              codexAppServerPid: "1001",
              sessionId: `thread-1-turn-${turn}`,
              threadId: "thread-1",
              turnId: `turn-${turn}`,
            });
            return {
              status: "completed" as const,
              threadId: "thread-1",
              turnId: `turn-${turn}`,
              sessionId: `thread-1-turn-${turn}`,
              usage: null,
              rateLimits: null,
              message: `turn ${turn}`,
            };
          },
          close: vi.fn().mockResolvedValue(undefined),
        };
      },
    });

    const result = await runner.run({
      issue: ISSUE_FIXTURE,
      attempt: null,
      stageName: "investigate",
    });

    // maxTurns is 3, but should break after turn 1 due to [STAGE_COMPLETE]
    expect(result.turnsCompleted).toBe(1);
    expect(result.runAttempt.status).toBe("succeeded");
    // refreshIssueState should NOT have been called since we broke before it
    expect(tracker.fetchIssueStatesByIds).not.toHaveBeenCalled();
  });

  it("breaks the turn loop when [STAGE_COMPLETE] leads the final message", async () => {
    const root = await createRoot();
    const tracker = createTracker({
      refreshStates: [
        { id: "issue-1", identifier: "ABC-123", state: "In Progress" },
      ],
    });
    const continueTurn = vi.fn();
    const runner = new AgentRunner({
      config: createConfig(root, "unused"),
      tracker,
      createCodexClient: (input) => ({
        async startSession() {
          input.onEvent({
            event: "session_started",
            timestamp: new Date().toISOString(),
            codexAppServerPid: "1001",
            sessionId: "thread-1-turn-1",
            threadId: "thread-1",
            turnId: "turn-1",
          });
          return {
            status: "completed" as const,
            threadId: "thread-1",
            turnId: "turn-1",
            sessionId: "thread-1-turn-1",
            usage: null,
            rateLimits: null,
            // Verbatim shape from the SYMPH-330 round-3 canary: marker
            // leads, explanation follows. endsWith missed this (SYMPH-350).
            message:
              "[STAGE_COMPLETE]  Investigation workpad updated on the existing Linear comment `71de44d1`.",
          };
        },
        continueTurn,
        close: vi.fn().mockResolvedValue(undefined),
      }),
    });

    const result = await runner.run({
      issue: ISSUE_FIXTURE,
      attempt: null,
      stageName: "investigate",
    });

    expect(result.turnsCompleted).toBe(1);
    expect(continueTurn).not.toHaveBeenCalled();
    expect(result.runAttempt.status).toBe("succeeded");
  });

  it("breaks the turn loop early when the agent emits [STAGE_FAILED: ...]", async () => {
    const root = await createRoot();
    const tracker = createTracker({
      refreshStates: [
        { id: "issue-1", identifier: "ABC-123", state: "In Progress" },
        { id: "issue-1", identifier: "ABC-123", state: "In Progress" },
      ],
    });
    const runner = new AgentRunner({
      config: createConfig(root, "unused"),
      tracker,
      createCodexClient: (input) => {
        let turn = 0;
        return {
          async startSession({ prompt }: { prompt: string; title: string }) {
            turn += 1;
            input.onEvent({
              event: "session_started",
              timestamp: new Date().toISOString(),
              codexAppServerPid: "1001",
              sessionId: `thread-1-turn-${turn}`,
              threadId: "thread-1",
              turnId: `turn-${turn}`,
            });
            return {
              status: "completed" as const,
              threadId: "thread-1",
              turnId: `turn-${turn}`,
              sessionId: `thread-1-turn-${turn}`,
              usage: null,
              rateLimits: null,
              message: "Tests failed.\n[STAGE_FAILED: verify]\nSee logs.",
            };
          },
          async continueTurn(prompt: string) {
            turn += 1;
            input.onEvent({
              event: "session_started",
              timestamp: new Date().toISOString(),
              codexAppServerPid: "1001",
              sessionId: `thread-1-turn-${turn}`,
              threadId: "thread-1",
              turnId: `turn-${turn}`,
            });
            return {
              status: "completed" as const,
              threadId: "thread-1",
              turnId: `turn-${turn}`,
              sessionId: `thread-1-turn-${turn}`,
              usage: null,
              rateLimits: null,
              message: `turn ${turn}`,
            };
          },
          close: vi.fn().mockResolvedValue(undefined),
        };
      },
    });

    const result = await runner.run({
      issue: ISSUE_FIXTURE,
      attempt: null,
      stageName: "implement",
    });

    // maxTurns is 3, but should break after turn 1 due to [STAGE_FAILED: verify]
    expect(result.turnsCompleted).toBe(1);
    expect(result.lastTurn?.message).toContain("[STAGE_FAILED: verify]");
  });

  it("throws AgentRunnerError when a turn fails without a STAGE_FAILED signal", async () => {
    const root = await createRoot();
    const tracker = createTracker({
      refreshStates: [
        { id: "issue-1", identifier: "ABC-123", state: "In Progress" },
      ],
    });
    const runner = new AgentRunner({
      config: createConfig(root, "unused"),
      tracker,
      createCodexClient: (input) =>
        createStubCodexClient([], input, {
          statuses: ["failed"],
          messages: ["The operation was aborted"],
        }),
    });

    await expect(
      runner.run({
        issue: ISSUE_FIXTURE,
        attempt: null,
      }),
    ).rejects.toMatchObject({
      name: "AgentRunnerError",
      status: "failed",
      failedPhase: "initializing_session",
      message: "The operation was aborted",
    } satisfies Partial<AgentRunnerError>);

    // Should NOT have called refreshIssueState since we threw before it
    expect(tracker.fetchIssueStatesByIds).not.toHaveBeenCalled();
  });

  it("returns succeeded when infrastructure marks turn failed but agent emitted STAGE_FAILED signal", async () => {
    const root = await createRoot();
    const tracker = createTracker({
      refreshStates: [
        { id: "issue-1", identifier: "ABC-123", state: "In Progress" },
      ],
    });
    const runner = new AgentRunner({
      config: createConfig(root, "unused"),
      tracker,
      createCodexClient: (input) =>
        createStubCodexClient([], input, {
          statuses: ["failed"],
          messages: ["Tests failed.\n[STAGE_FAILED: verify]\nSee logs."],
        }),
    });

    const result = await runner.run({
      issue: ISSUE_FIXTURE,
      attempt: null,
    });

    // STAGE_FAILED is an intentional agent signal — runner should succeed
    expect(result.runAttempt.status).toBe("succeeded");
    expect(result.lastTurn?.message).toContain("[STAGE_FAILED: verify]");
  });

  it("cancels the run when the orchestrator aborts the worker signal", async () => {
    const root = await createRoot();
    const close = vi.fn().mockResolvedValue(undefined);
    const controller = new AbortController();
    const runner = new AgentRunner({
      config: createConfig(root, "unused"),
      tracker: createTracker({
        refreshStates: [
          { id: "issue-1", identifier: "ABC-123", state: "In Progress" },
        ],
      }),
      createCodexClient: (input) =>
        createStubCodexClient([], input, {
          close,
          startSession: async ({
            prompt,
          }: {
            prompt: string;
            title: string;
          }) =>
            await new Promise((resolve, reject) => {
              const timeout = setTimeout(() => {
                resolve({
                  status: "completed" as const,
                  threadId: "thread-1",
                  turnId: "turn-1",
                  sessionId: "thread-1-turn-1",
                  usage: null,
                  rateLimits: null,
                  message: prompt,
                });
              }, 500);
              controller.signal.addEventListener(
                "abort",
                () => {
                  clearTimeout(timeout);
                  reject(new Error("Stopped due to terminal_state."));
                },
                { once: true },
              );
            }),
        }),
    });

    const pending = runner.run({
      issue: ISSUE_FIXTURE,
      attempt: null,
      signal: controller.signal,
    });
    controller.abort("Stopped due to terminal_state.");

    await expect(pending).rejects.toMatchObject({
      name: "AgentRunnerError",
      status: "canceled_by_reconciliation",
      failedPhase: "launching_agent_process",
      message: "Stopped due to terminal_state.",
    } satisfies Partial<AgentRunnerError>);
    expect(close).toHaveBeenCalled();
  });
});

function createStubCodexClient(
  prompts: string[],
  input: AgentRunnerCodexClientFactoryInput,
  overrides?: Partial<{
    close: ReturnType<typeof vi.fn>;
    statuses: Array<"completed" | "failed" | "cancelled">;
    messages: Array<string | null>;
    startSession: (input: { prompt: string; title: string }) => Promise<{
      status: "completed" | "failed" | "cancelled";
      threadId: string;
      turnId: string;
      sessionId: string;
      usage: {
        inputTokens: number;
        outputTokens: number;
        totalTokens: number;
      } | null;
      rateLimits: Record<string, unknown> | null;
      message: string | null;
    }>;
  }>,
) {
  let turn = 0;
  const statuses = overrides?.statuses ?? ["completed"];
  const messages = overrides?.messages;

  return {
    async startSession({ prompt, title }: { prompt: string; title: string }) {
      if (overrides?.startSession) {
        return overrides.startSession({ prompt, title });
      }

      turn += 1;
      prompts.push(prompt);
      input.onEvent({
        event: "session_started",
        timestamp: new Date("2026-03-06T00:00:00.000Z").toISOString(),
        codexAppServerPid: "1001",
        sessionId: `thread-1-turn-${turn}`,
        threadId: "thread-1",
        turnId: `turn-${turn}`,
      });
      return {
        status: statuses[turn - 1] ?? "completed",
        threadId: "thread-1",
        turnId: `turn-${turn}`,
        sessionId: `thread-1-turn-${turn}`,
        usage: {
          inputTokens: 10 * turn,
          outputTokens: 5 * turn,
          totalTokens: 15 * turn,
        },
        rateLimits: {
          requestsRemaining: 10 - turn,
        },
        message: messages
          ? (messages[turn - 1] ?? `turn ${turn}`)
          : `turn ${turn}`,
      };
    },
    async continueTurn(prompt: string) {
      turn += 1;
      prompts.push(prompt);
      input.onEvent({
        event: "session_started",
        timestamp: new Date("2026-03-06T00:00:00.000Z").toISOString(),
        codexAppServerPid: "1001",
        sessionId: `thread-1-turn-${turn}`,
        threadId: "thread-1",
        turnId: `turn-${turn}`,
      });
      return {
        status: statuses[turn - 1] ?? "completed",
        threadId: "thread-1",
        turnId: `turn-${turn}`,
        sessionId: `thread-1-turn-${turn}`,
        usage: {
          inputTokens: 10 * turn,
          outputTokens: 5 * turn,
          totalTokens: 15 * turn,
        },
        rateLimits: {
          requestsRemaining: 10 - turn,
        },
        message: messages
          ? (messages[turn - 1] ?? `turn ${turn}`)
          : `turn ${turn}`,
      };
    },
    close: overrides?.close ?? vi.fn().mockResolvedValue(undefined),
  };
}

function createTracker(input?: {
  refreshStates?: IssueStateSnapshot[];
}): IssueTracker {
  const refreshStates = [...(input?.refreshStates ?? [])];

  return {
    fetchCandidateIssues: vi.fn(),
    fetchIssuesByStates: vi.fn(),
    fetchIssueStatesByIds: vi.fn(async () => {
      const next = refreshStates.shift();
      return next === undefined ? [] : [next];
    }),
  };
}

function createConfig(root: string, scenario: string): ResolvedWorkflowConfig {
  return {
    workflowPath: join(root, "WORKFLOW.md"),
    promptTemplate:
      "Initial prompt for {{ issue.identifier }} attempt={{ attempt }}",
    tracker: {
      kind: "linear",
      endpoint: "https://api.linear.app/graphql",
      apiKey: "linear-token",
      projectSlug: "example",
      activeStates: ["In Progress"],
      terminalStates: ["Done", "Canceled"],
    },
    polling: {
      intervalMs: 30_000,
    },
    workspace: {
      root,
    },
    hooks: {
      afterCreate: null,
      beforeRun: null,
      afterRun: null,
      beforeRemove: null,
      timeoutMs: 500,
    },
    agent: {
      maxConcurrentAgents: 2,
      maxTurns: 3,
      maxRetryBackoffMs: 300_000,
      maxRetryAttempts: 5,
      maxConcurrentAgentsByState: {},
    },
    codex: {
      command: `${process.execPath} "${fixturePath}" ${scenario}`,
      ephemeralHome: false,
      disableSkills: false,
      approvalPolicy: "full-auto",
      threadSandbox: "workspace-write",
      turnSandboxPolicy: {
        type: "workspace-write",
      },
      turnTimeoutMs: 1_000,
      readTimeoutMs: 1_000,
      stallTimeoutMs: 2_000,
    },
    pauseTriage: {
      baseUrl: null,
      model: null,
      apiKey: null,
      maxResumes: 2,
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
      slackNotifyChannel: null,
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
    stages: null,
    escalationState: null,
  };
}

async function createRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "symphony-task11-"));
  roots.push(root);
  return root;
}

async function git(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await execFileAsync("git", ["-C", cwd, ...args], {
    encoding: "utf8",
  });
  return stdout.trim();
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json",
    },
  });
}

const ISSUE_FIXTURE: Issue = {
  id: "issue-1",
  identifier: "ABC-123",
  title: "Ship agent runner",
  description: "Implement the runner",
  priority: 1,
  state: "In Progress",
  branchName: null,
  url: "https://linear.app/example/issue/ABC-123",
  labels: ["automation"],
  blockedBy: [],
  createdAt: "2026-03-06T00:00:00.000Z",
  updatedAt: "2026-03-06T01:00:00.000Z",
};

describe("Agent runner startup diagnostics", () => {
  it("logs the workspace path being used", async () => {
    const root = await createRoot();
    const warnings: string[] = [];
    const origWarn = console.warn;
    console.warn = (...args: unknown[]) => {
      warnings.push(args.map(String).join(" "));
    };

    try {
      const tracker = createTracker({
        refreshStates: [
          { id: "issue-1", identifier: "ABC-123", state: "Done" },
        ],
      });
      const runner = new AgentRunner({
        config: createConfig(root, "unused"),
        tracker,
        createCodexClient: (input) =>
          createStubCodexClient([], input, {
            statuses: ["completed"],
          }),
      });

      await runner.run({
        issue: ISSUE_FIXTURE,
        attempt: null,
      });

      const workspaceLog = warnings.find(
        (msg) =>
          msg.includes("[agent-runner]") &&
          msg.includes("ABC-123") &&
          msg.includes("Using workspace path"),
      );
      expect(workspaceLog).toBeDefined();
      expect(workspaceLog).toContain(root);
    } finally {
      console.warn = origWarn;
    }
  });

  it("logs CC process spawn confirmation with PID", async () => {
    const root = await createRoot();
    const warnings: string[] = [];
    const origWarn = console.warn;
    console.warn = (...args: unknown[]) => {
      warnings.push(args.map(String).join(" "));
    };

    try {
      const tracker = createTracker({
        refreshStates: [
          { id: "issue-1", identifier: "ABC-123", state: "Done" },
        ],
      });
      const runner = new AgentRunner({
        config: createConfig(root, "unused"),
        tracker,
        createCodexClient: (input) =>
          createStubCodexClient([], input, {
            statuses: ["completed"],
          }),
      });

      await runner.run({
        issue: ISSUE_FIXTURE,
        attempt: null,
      });

      const pidLog = warnings.find(
        (msg) =>
          msg.includes("[agent-runner]") &&
          msg.includes("ABC-123") &&
          msg.includes("CC process spawned with PID"),
      );
      expect(pidLog).toBeDefined();
      expect(pidLog).toContain("1001");
    } finally {
      console.warn = origWarn;
    }
  });
});
