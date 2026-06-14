import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it, vi } from "vitest";

import {
  buildLinearDocumentPublishRequest,
  createLinearDocumentPublisher,
  parseDocumentCreateOutput,
  parseDocumentListOutput,
  parseSpecReviewWatchArgs,
  runSpecReviewWatchCli,
} from "../../src/cli/spec-review-watch.js";
import type { ResolvedWorkflowConfig } from "../../src/config/types.js";
import type {
  DispatcherRunJournalEntry,
  Issue,
} from "../../src/domain/model.js";
import {
  SENSITIVE_SOURCE_INTENT_HASH,
  type SpecReviewRunIssueResult,
} from "../../src/spec-review/spec-review.js";

describe("symphony-spec-review-watch CLI", () => {
  it("parses workflow, workspace, mode, states, issue filters, and dry-run", () => {
    expect(
      parseSpecReviewWatchArgs(
        [
          "WORKFLOW.custom.md",
          "--workspace",
          "repo",
          "--artifact-root",
          "artifacts",
          "--mode",
          "warn",
          "--states",
          "Backlog,Todo",
          "--issue",
          "SYMPH-1",
          "--cmux-spawn-bin",
          "/bin/cmux-spawn",
          "--dry-run",
        ],
        "/tmp",
      ),
    ).toEqual({
      workflowPath: "/tmp/WORKFLOW.custom.md",
      workspaceRoot: "/tmp/repo",
      artifactRoot: "/tmp/artifacts",
      mode: "warn",
      states: ["Backlog", "Todo"],
      issues: ["SYMPH-1"],
      cmuxSpawnBin: "/bin/cmux-spawn",
      dryRun: true,
      help: false,
    });
  });

  it("prints help and usage errors through injectable io", async () => {
    const stdout = vi.fn();
    const stderr = vi.fn();

    await expect(
      runSpecReviewWatchCli(["--help"], { stdout, stderr }),
    ).resolves.toBe(0);
    expect(stdout).toHaveBeenCalledWith(expect.stringContaining("Usage:"));

    await expect(
      runSpecReviewWatchCli(["--mode", "nope"], { stdout, stderr }),
    ).resolves.toBe(2);
    expect(stderr).toHaveBeenCalledWith(
      expect.stringContaining("--mode must be observe, warn, or enforce"),
    );
  });

  it("runs selection, records blocked privacy state, and writes a selection artifact", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "spec-review-watch-"));
    const artifactRoot = join(workspace, "artifacts");
    const stdout = vi.fn();
    const selectedIssue = makeIssue({
      id: "selected",
      identifier: "SYMPH-1",
      labels: ["needs:spec-review"],
    });
    const blockedIssue = makeIssue({
      id: "blocked",
      identifier: "SYMPH-2",
      labels: ["security"],
      title: "Secret customer key",
      description: "private body",
    });
    const appendJournal = vi.fn(async (_workspaceRoot, input) => [
      makeJournalEntry(input.issue, input.readinessState),
    ]);
    const runReview = vi.fn(async ({ issue }) => makeRunResult(issue, "valid"));

    const exitCode = await runSpecReviewWatchCli(
      [
        "WORKFLOW.md",
        "--workspace",
        workspace,
        "--artifact-root",
        artifactRoot,
        "--mode",
        "warn",
      ],
      {
        stdout,
        now: () => new Date("2026-06-14T00:00:00.000Z"),
        loadWorkflowDefinition: async (workflowPath) => ({
          workflowPath: workflowPath ?? join(workspace, "WORKFLOW.md"),
          config: {},
          promptTemplate: "",
        }),
        resolveWorkflowConfig: () => fakeConfig(),
        createTracker: () => ({
          fetchIssuesByStates: async (states) => {
            expect(states).toEqual(["Backlog"]);
            return [selectedIssue, blockedIssue];
          },
          fetchIssueReferencesByIds: async () => [],
          fetchTicketFeatureIssuesByStates: async () => [],
          updateIssueDescription: async () => ({
            id: "issue",
            identifier: "SYMPH-1",
            title: "Issue",
          }),
          postComment: async () => undefined,
        }),
        runSpecReviewForIssue: runReview,
        appendSpecReviewResultJournal: appendJournal,
        documentPublisher: {
          publish: async () => ({
            url: "https://linear.example/doc",
            identifier: "doc-id",
          }),
        },
      },
    );

    expect(exitCode).toBe(1);
    expect(runReview).toHaveBeenCalledOnce();
    expect(appendJournal).toHaveBeenCalledWith(
      workspace,
      expect.objectContaining({
        issue: blockedIssue,
        readinessState: "privacy_blocked",
      }),
    );
    const output = JSON.parse(String(stdout.mock.calls[0]?.[0])) as {
      selectionArtifactPath: string;
      selectedCount: number;
      results: Array<{ issueIdentifier: string; readinessState: string }>;
    };
    expect(output.selectedCount).toBe(1);
    expect(output.results).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          issueIdentifier: "SYMPH-1",
          readinessState: "valid",
        }),
        expect.objectContaining({
          issueIdentifier: "SYMPH-2",
          readinessState: "privacy_blocked",
        }),
      ]),
    );
    const selectionArtifact = JSON.parse(
      await readFile(output.selectionArtifactPath, "utf8"),
    ) as {
      decisions: Array<{
        status: string;
        sourceIntentHash: string;
        reasons: string[];
        issue: { title: string; description: string | null };
      }>;
    };
    expect(selectionArtifact.decisions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ status: "selected" }),
        expect.objectContaining({
          status: "blocked",
          sourceIntentHash: SENSITIVE_SOURCE_INTENT_HASH,
          reasons: ["privacy_sensitive_label"],
        }),
      ]),
    );
    expect(JSON.stringify(selectionArtifact)).not.toContain("private body");
    expect(JSON.stringify(selectionArtifact)).not.toContain(
      "Secret customer key",
    );
    expect(selectionArtifact.decisions).toContainEqual(
      expect.objectContaining({
        issue: expect.objectContaining({
          title: "[redacted: privacy-sensitive]",
          description: null,
        }),
      }),
    );
  });

  it("redacts sensitive decisions from dry-run output", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "spec-review-watch-"));
    const stdout = vi.fn();
    const blockedIssue = makeIssue({
      id: "blocked",
      identifier: "SYMPH-2",
      labels: ["security"],
      title: "Secret customer key",
      description: "private body",
    });

    const exitCode = await runSpecReviewWatchCli(
      ["WORKFLOW.md", "--workspace", workspace, "--dry-run"],
      {
        stdout,
        loadWorkflowDefinition: async (workflowPath) => ({
          workflowPath: workflowPath ?? join(workspace, "WORKFLOW.md"),
          config: {},
          promptTemplate: "",
        }),
        resolveWorkflowConfig: () => fakeConfig(),
        createTracker: () => ({
          fetchIssuesByStates: async () => [blockedIssue],
          fetchIssueReferencesByIds: async () => [],
          fetchTicketFeatureIssuesByStates: async () => [],
          updateIssueDescription: async () => ({
            id: "issue",
            identifier: "SYMPH-1",
            title: "Issue",
          }),
          postComment: async () => undefined,
        }),
      },
    );

    expect(exitCode).toBe(0);
    const output = String(stdout.mock.calls[0]?.[0]);
    expect(output).not.toContain("private body");
    expect(output).not.toContain("Secret customer key");
    expect(output).toContain("[redacted: privacy-sensitive]");
  });

  it("continues the batch when one selected issue throws", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "spec-review-watch-"));
    const stdout = vi.fn();
    const firstIssue = makeIssue({
      id: "first",
      identifier: "SYMPH-1",
      labels: ["needs:spec-review"],
    });
    const secondIssue = makeIssue({
      id: "second",
      identifier: "SYMPH-2",
      labels: ["needs:spec-review"],
    });
    const appendJournal = vi.fn(async (_workspaceRoot, input) => [
      makeJournalEntry(input.issue, input.readinessState),
    ]);
    const runReview = vi.fn(async ({ issue }) => {
      if (issue.id === "first") {
        throw new Error("linear write failed");
      }
      return makeRunResult(issue, "valid");
    });

    const exitCode = await runSpecReviewWatchCli(
      ["WORKFLOW.md", "--workspace", workspace],
      {
        stdout,
        loadWorkflowDefinition: async (workflowPath) => ({
          workflowPath: workflowPath ?? join(workspace, "WORKFLOW.md"),
          config: {},
          promptTemplate: "",
        }),
        resolveWorkflowConfig: () => fakeConfig(),
        createTracker: () => ({
          fetchIssuesByStates: async () => [firstIssue, secondIssue],
          fetchIssueReferencesByIds: async () => [],
          fetchTicketFeatureIssuesByStates: async () => [],
          updateIssueDescription: async () => ({
            id: "issue",
            identifier: "SYMPH-1",
            title: "Issue",
          }),
          postComment: async () => undefined,
        }),
        runSpecReviewForIssue: runReview,
        appendSpecReviewResultJournal: appendJournal,
      },
    );

    expect(exitCode).toBe(1);
    expect(runReview).toHaveBeenCalledTimes(2);
    const output = JSON.parse(String(stdout.mock.calls[0]?.[0])) as {
      results: Array<{ issueIdentifier: string; readinessState: string }>;
    };
    expect(output.results).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          issueIdentifier: "SYMPH-1",
          readinessState: "failed",
        }),
        expect.objectContaining({
          issueIdentifier: "SYMPH-2",
          readinessState: "valid",
        }),
      ]),
    );
  });

  it.each([
    ["observe", 0],
    ["warn", 0],
    ["enforce", 1],
  ] as const)(
    "returns mode-aware status for needs_operator_context in %s mode",
    async (mode, expectedExitCode) => {
      const workspace = await mkdtemp(join(tmpdir(), "spec-review-watch-"));
      const stdout = vi.fn();
      const issue = makeIssue({
        id: "selected",
        identifier: "SYMPH-1",
        labels: ["needs:spec-review"],
      });
      const runReview = vi.fn(async ({ issue }) =>
        makeRunResult(issue, "needs_operator_context"),
      );

      const exitCode = await runSpecReviewWatchCli(
        ["WORKFLOW.md", "--workspace", workspace, "--mode", mode],
        {
          stdout,
          loadWorkflowDefinition: async (workflowPath) => ({
            workflowPath: workflowPath ?? join(workspace, "WORKFLOW.md"),
            config: {},
            promptTemplate: "",
          }),
          resolveWorkflowConfig: () => fakeConfig(),
          createTracker: () => ({
            fetchIssuesByStates: async () => [issue],
            fetchIssueReferencesByIds: async () => [],
            fetchTicketFeatureIssuesByStates: async () => [],
            updateIssueDescription: async () => ({
              id: "issue",
              identifier: "SYMPH-1",
              title: "Issue",
            }),
            postComment: async () => undefined,
          }),
          runSpecReviewForIssue: runReview,
        },
      );

      expect(exitCode).toBe(expectedExitCode);
      expect(runReview).toHaveBeenCalledOnce();
      const output = JSON.parse(String(stdout.mock.calls[0]?.[0])) as {
        results: Array<{ issueIdentifier: string; readinessState: string }>;
      };
      expect(output.results).toEqual([
        expect.objectContaining({
          issueIdentifier: "SYMPH-1",
          readinessState: "needs_operator_context",
        }),
      ]);
    },
  );

  it("parses known Linear document create output envelopes", () => {
    expect(
      parseDocumentCreateOutput(
        JSON.stringify({
          results: {
            url: "https://linear.example/doc",
            slugId: "abc123",
          },
        }),
      ),
    ).toEqual({
      url: "https://linear.example/doc",
      identifier: "abc123",
    });

    expect(
      parseDocumentCreateOutput(
        JSON.stringify({
          data: {
            documentCreate: {
              document: {
                url: "https://linear.example/doc2",
                id: "doc-2",
              },
            },
          },
        }),
      ),
    ).toEqual({
      url: "https://linear.example/doc2",
      identifier: "doc-2",
    });

    expect(() =>
      parseDocumentCreateOutput(JSON.stringify({ results: { id: "doc-3" } })),
    ).toThrow("did not include a URL");
  });

  it("parses known Linear document list output envelopes", () => {
    expect(
      parseDocumentListOutput(
        JSON.stringify({
          results: {
            documents: [
              {
                title: "Spec Review - SYMPH-1",
                url: "https://linear.example/doc",
                slugId: "abc123",
              },
            ],
          },
        }),
      ),
    ).toEqual([
      {
        title: "Spec Review - SYMPH-1",
        url: "https://linear.example/doc",
        identifier: "abc123",
      },
    ]);
  });

  it("adds deterministic idempotency metadata to Linear Docs publish requests", () => {
    const first = buildLinearDocumentPublishRequest({
      title: "Spec Review - SYMPH-1",
      markdown: "# Review\n",
      idempotencyKey: "spec-review:issue-1:source-hash",
    });
    const second = buildLinearDocumentPublishRequest({
      title: "Spec Review - SYMPH-1",
      markdown: "# Review again\n",
      idempotencyKey: "spec-review:issue-1:source-hash",
    });

    expect(first.title).toBe(second.title);
    expect(first.idempotencyHash).toBe(second.idempotencyHash);
    expect(first.markdown).toContain(
      `<!-- symphony-spec-review-doc-idempotency-sha256:${first.idempotencyHash} -->`,
    );
  });

  it("creates a deterministic Linear Doc with idempotent create when none exists", async () => {
    const calls: Array<{ file: string; args: readonly string[] }> = [];
    let contentFile: string | null = null;
    let contentFileText = "";
    const execFile = vi.fn(async (file: string, args: readonly string[]) => {
      calls.push({ file, args });
      if (args[1] === "list") {
        return {
          stdout: JSON.stringify({ results: { documents: [] } }),
          stderr: "",
        };
      }
      if (args[1] === "create") {
        contentFile = String(args[args.indexOf("--content-file") + 1]);
        contentFileText = await readFile(contentFile, "utf8");
        return {
          stdout: JSON.stringify({
            results: {
              url: "https://linear.example/doc",
              slugId: "doc-new",
            },
          }),
          stderr: "",
        };
      }
      throw new Error(`unexpected command ${args.join(" ")}`);
    });

    const publisher = createLinearDocumentPublisher(execFile);
    const result = await publisher.publish({
      issueIdentifier: "SYMPH-1",
      title: "Spec Review - SYMPH-1",
      markdown: "# Durable rationale",
      idempotencyKey: "spec-review:issue-1:source-hash",
    });

    expect(result).toEqual({
      url: "https://linear.example/doc",
      identifier: "doc-new",
    });
    const createCall = calls.find((call) => call.args[1] === "create");
    expect(createCall?.args).toContain("--idempotent");
    expect(createCall?.args).toContainEqual(
      expect.stringContaining("Spec Review - SYMPH-1"),
    );
    expect(contentFile).not.toBeNull();
    expect(contentFileText).toContain(
      "symphony-spec-review-doc-idempotency-sha256",
    );
    await expect(readFile(String(contentFile), "utf8")).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("edits the matching deterministic Linear Doc on same-intent rerun", async () => {
    const prepared = buildLinearDocumentPublishRequest({
      title: "Spec Review - SYMPH-1",
      markdown: "# Review",
      idempotencyKey: "spec-review:issue-1:source-hash",
    });
    const calls: Array<{ file: string; args: readonly string[] }> = [];
    const execFile = vi.fn(async (file: string, args: readonly string[]) => {
      calls.push({ file, args });
      if (args[1] === "list") {
        return {
          stdout: JSON.stringify({
            results: {
              documents: [
                {
                  title: prepared.title,
                  url: "https://linear.example/doc",
                  slugId: "existing-doc",
                },
              ],
            },
          }),
          stderr: "",
        };
      }
      if (args[1] === "edit") {
        return {
          stdout: JSON.stringify({
            results: {
              url: "https://linear.example/doc",
              slugId: "existing-doc",
            },
          }),
          stderr: "",
        };
      }
      throw new Error(`unexpected command ${args.join(" ")}`);
    });

    const publisher = createLinearDocumentPublisher(execFile);
    const result = await publisher.publish({
      issueIdentifier: "SYMPH-1",
      title: "Spec Review - SYMPH-1",
      markdown: "# Updated rationale",
      idempotencyKey: "spec-review:issue-1:source-hash",
    });

    expect(result.identifier).toBe("existing-doc");
    expect(calls.map((call) => call.args[1])).toEqual(["list", "edit"]);
    expect(calls[1]?.args).toEqual(
      expect.arrayContaining(["edit", "existing-doc"]),
    );
  });
});

function fakeConfig(): ResolvedWorkflowConfig {
  return {
    tracker: {
      endpoint: "https://linear.example/graphql",
      apiKey: "key",
      projectSlug: "symphony",
      activeStates: ["Backlog"],
    },
  } as ResolvedWorkflowConfig;
}

function makeIssue(overrides: Partial<Issue> = {}): Issue {
  return {
    id: "issue-1",
    identifier: "SYMPH-1",
    title: "Add review",
    description: "Body",
    priority: 2,
    state: "Backlog",
    branchName: null,
    url: "https://linear.example/SYMPH-1",
    labels: [],
    blockedBy: [],
    createdAt: "2026-06-14T00:00:00.000Z",
    updatedAt: "2026-06-14T00:00:00.000Z",
    ...overrides,
  };
}

function makeRunResult(
  issue: Issue,
  readinessState: SpecReviewRunIssueResult["readinessState"],
): SpecReviewRunIssueResult {
  return {
    issueId: issue.id,
    issueIdentifier: issue.identifier,
    sourceIntentHash: "source-hash",
    readinessState,
    verdict: "ready_as_written",
    runnerStatus: "passed",
    artifactPath: "/tmp/artifact.md",
    linearDocUrl: null,
    markerCommentPosted: true,
    journalEntries: [makeJournalEntry(issue, readinessState)],
    message: "ok",
  };
}

function makeJournalEntry(
  issue: Issue,
  readinessState: string,
): DispatcherRunJournalEntry {
  return {
    sequence: 1,
    idempotencyKey: `spec-review:${issue.id}`,
    timestamp: "2026-06-14T00:00:00.000Z",
    kind: "spec_review_result",
    issueId: issue.id,
    issueIdentifier: issue.identifier,
    operation: "tracker_write",
    stage: "spec_review",
    attempt: null,
    ownerId: "test",
    lease: null,
    summary: "test",
    metadata: {
      readiness_state: readinessState,
    },
  };
}
