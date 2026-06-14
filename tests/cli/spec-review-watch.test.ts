import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it, vi } from "vitest";

import {
  buildLinearDocumentPublishRequest,
  createLinearDocumentPublisher,
  parseDocumentCreateOutput,
  parseDocumentListOutput,
  parseSpecReviewWatchArgs,
  preflightLinearDocumentPublisher,
  runSpecReviewWatchCli,
} from "../../src/cli/spec-review-watch.js";
import type { ResolvedWorkflowConfig } from "../../src/config/types.js";
import type {
  DispatcherRunJournalEntry,
  Issue,
} from "../../src/domain/model.js";
import {
  SENSITIVE_SOURCE_INTENT_HASH,
  SPEC_REVIEW_SOURCE_REF_MAX_CHARS,
  type SpecReviewRunIssueResult,
  buildReviewedIssueDescription,
  computeSourceIntentHash,
} from "../../src/spec-review/spec-review.js";

describe("symphony-spec-review-watch CLI", () => {
  it("parses workflow, workspace, mode, states, issue filters, source refs, and dry-run", () => {
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
          "--source-ref",
          "SPEC.mobilyze.md",
          "--source-ref",
          "docs/review.md",
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
      sourceRefs: ["SPEC.mobilyze.md", "docs/review.md"],
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
      labels: ["secret", "needs:spec-review"],
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

  it("passes configured source refs with truncation, missing, and path metadata", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "spec-review-watch-"));
    await mkdir(join(workspace, "docs"), { recursive: true });
    await mkdir(join(workspace, "..source"), { recursive: true });
    await writeFile(
      join(workspace, "SPEC.mobilyze.md"),
      "a".repeat(SPEC_REVIEW_SOURCE_REF_MAX_CHARS + 5),
      "utf8",
    );
    await writeFile(
      join(workspace, "..source", "truth.md"),
      "workspace-local dot-prefixed source",
      "utf8",
    );
    const stdout = vi.fn();
    const issue = makeIssue({
      id: "selected",
      identifier: "SYMPH-1",
      labels: ["needs:spec-review"],
    });
    const runReview = vi.fn(async ({ issue }) => makeRunResult(issue, "valid"));

    const exitCode = await runSpecReviewWatchCli(
      [
        "WORKFLOW.md",
        "--workspace",
        workspace,
        "--source-ref",
        "SPEC.mobilyze.md",
        "--source-ref",
        "docs/missing.md",
        "--source-ref",
        "..source/truth.md",
        "--source-ref",
        "../escape.md",
      ],
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
        preflightDocumentPublisher: async () => undefined,
      },
    );

    expect(exitCode).toBe(0);
    expect(runReview).toHaveBeenCalledOnce();
    const reviewInput = runReview.mock.calls[0]?.[0];
    expect(reviewInput?.sourceOfTruthRefs).toEqual([
      expect.objectContaining({
        path: "SPEC.mobilyze.md",
        status: "truncated",
        truncated: true,
        originalChars: SPEC_REVIEW_SOURCE_REF_MAX_CHARS + 5,
        includedChars: SPEC_REVIEW_SOURCE_REF_MAX_CHARS,
        maxChars: SPEC_REVIEW_SOURCE_REF_MAX_CHARS,
        error: null,
      }),
      expect.objectContaining({
        path: "docs/missing.md",
        status: "missing",
        excerpt: null,
        truncated: false,
        originalChars: null,
        includedChars: 0,
        maxChars: SPEC_REVIEW_SOURCE_REF_MAX_CHARS,
      }),
      expect.objectContaining({
        path: "..source/truth.md",
        status: "available",
        excerpt: "workspace-local dot-prefixed source",
        truncated: false,
        originalChars: "workspace-local dot-prefixed source".length,
        includedChars: "workspace-local dot-prefixed source".length,
        maxChars: SPEC_REVIEW_SOURCE_REF_MAX_CHARS,
        error: null,
      }),
      expect.objectContaining({
        path: "../escape.md",
        status: "invalid_source_path",
        excerpt: null,
        truncated: false,
        originalChars: null,
        includedChars: 0,
        maxChars: SPEC_REVIEW_SOURCE_REF_MAX_CHARS,
        error: "Source ref must resolve inside the workspace.",
      }),
    ]);
    expect(reviewInput?.sourceOfTruthRefs?.[0]?.excerpt).toHaveLength(
      SPEC_REVIEW_SOURCE_REF_MAX_CHARS,
    );
  });

  it("does not block unrelated sensitive active issues", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "spec-review-watch-"));
    const stdout = vi.fn();
    const sensitiveIssue = makeIssue({
      id: "sensitive",
      identifier: "SYMPH-2",
      labels: ["private"],
      title: "Secret customer key",
      description: "private body",
    });
    const appendJournal = vi.fn(async (_workspaceRoot, input) => [
      makeJournalEntry(input.issue, input.readinessState),
    ]);
    const runReview = vi.fn(async ({ issue }) => makeRunResult(issue, "valid"));

    const exitCode = await runSpecReviewWatchCli(
      ["WORKFLOW.md", "--workspace", workspace, "--mode", "warn"],
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
          fetchIssuesByStates: async () => [sensitiveIssue],
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

    expect(exitCode).toBe(0);
    expect(runReview).not.toHaveBeenCalled();
    expect(appendJournal).not.toHaveBeenCalled();
    const output = JSON.parse(String(stdout.mock.calls[0]?.[0])) as {
      selectionArtifactPath: string;
      selectedCount: number;
      results: Array<{ issueIdentifier: string; readinessState: string }>;
    };
    expect(output.selectedCount).toBe(0);
    expect(output.results).toEqual([]);
    const selectionArtifact = JSON.parse(
      await readFile(output.selectionArtifactPath, "utf8"),
    ) as {
      decisions: Array<{
        status: string;
        sourceIntentHash: string;
        issue: { title: string; description: string | null };
      }>;
    };
    expect(selectionArtifact.decisions).toContainEqual(
      expect.objectContaining({
        status: "skipped",
        sourceIntentHash: SENSITIVE_SOURCE_INTENT_HASH,
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
      labels: ["private"],
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

  it("uses latest matching spec-review journal state when selecting dry-run candidates", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "spec-review-watch-"));
    const stdout = vi.fn();
    const issue = makeIssue({
      labels: ["needs:spec-review"],
      description: "Build the thing.\n",
    });
    const sourceIntentHash = computeSourceIntentHash(issue);
    const reviewedDescription = buildReviewedIssueDescription({
      originalDescription: issue.description ?? "",
      sourceIntentHash,
      artifactHash: "artifact",
      artifactPath: "/tmp/artifact.md",
      mode: "observe",
      readinessState: "valid",
      verdict: "ready_as_written",
      linearDocUrl: null,
      generatedAt: "2026-06-14T00:00:00.000Z",
      reconciliation: {
        schemaVersion: 1,
        verdict: "ready_as_written",
        summary: "Looks good.",
        issueBodyAppend: null,
        acceptanceCriteria: [],
        linearDocMarkdown: null,
        childTicketPlan: [],
        requiresOperatorContext: false,
        operatorContextReason: null,
      },
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
          fetchIssuesByStates: async () => [
            { ...issue, description: reviewedDescription },
          ],
          fetchIssueReferencesByIds: async () => [],
          fetchTicketFeatureIssuesByStates: async () => [],
          updateIssueDescription: async () => ({
            id: "issue",
            identifier: "SYMPH-1",
            title: "Issue",
          }),
          postComment: async () => undefined,
        }),
        readDispatcherRunJournal: async () => [
          makeJournalEntry(issue, "valid", 1, sourceIntentHash),
          makeJournalEntry(issue, "failed", 2, sourceIntentHash),
        ],
      },
    );

    expect(exitCode).toBe(0);
    const output = JSON.parse(String(stdout.mock.calls[0]?.[0])) as {
      selectedCount: number;
      decisions: Array<{ status: string; reasons: string[] }>;
    };
    expect(output.selectedCount).toBe(1);
    expect(output.decisions).toContainEqual(
      expect.objectContaining({
        status: "selected",
        reasons: expect.arrayContaining([
          "latest_spec_review_journal:failed",
          "trigger_label:needs:spec-review",
        ]),
      }),
    );
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
        preflightDocumentPublisher: async () => undefined,
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
          preflightDocumentPublisher: async () => undefined,
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

  it("fails selected candidates before invoking Claude when Linear Docs CLI preflight fails", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "spec-review-watch-"));
    const artifactRoot = join(workspace, "artifacts");
    const stdout = vi.fn();
    const stderr = vi.fn();
    const issue = makeIssue({
      id: "selected",
      identifier: "SYMPH-1",
      labels: ["needs:spec-review"],
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
      ],
      {
        stdout,
        stderr,
        now: () => new Date("2026-06-14T00:00:00.000Z"),
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
        appendSpecReviewResultJournal: appendJournal,
        preflightDocumentPublisher: async () => {
          throw new Error(
            "Linear Docs publisher preflight failed: linear-pp-cli unavailable",
          );
        },
      },
    );

    expect(exitCode).toBe(1);
    expect(runReview).not.toHaveBeenCalled();
    expect(stderr).toHaveBeenCalledWith(
      expect.stringContaining("linear-pp-cli unavailable"),
    );
    expect(appendJournal).toHaveBeenCalledWith(
      workspace,
      expect.objectContaining({
        issue,
        readinessState: "failed",
        artifactPath: expect.stringContaining("selection-2026-06-14T00-00-00"),
        summary: expect.stringContaining("linear-pp-cli unavailable"),
      }),
    );
    const output = JSON.parse(String(stdout.mock.calls[0]?.[0])) as {
      selectionArtifactPath: string;
      selectedCount: number;
      results: Array<{
        issueIdentifier: string;
        readinessState: string;
        runnerStatus: string;
        artifactPath: string;
      }>;
    };
    expect(output.selectedCount).toBe(1);
    expect(output.results).toEqual([
      expect.objectContaining({
        issueIdentifier: "SYMPH-1",
        readinessState: "failed",
        runnerStatus: "failed",
        artifactPath: output.selectionArtifactPath,
      }),
    ]);
  });

  it("checks the Linear Docs CLI command surface during default publisher preflight", async () => {
    const execFile = vi.fn(async () => ({ stdout: "", stderr: "" }));

    await expect(preflightLinearDocumentPublisher(execFile)).resolves.toBe(
      undefined,
    );

    expect(execFile).toHaveBeenCalledWith(
      "linear-pp-cli",
      ["documents", "--help"],
      { maxBuffer: 512 * 1024, timeout: 10_000 },
    );
  });

  it("reports a clear diagnostic when default publisher preflight cannot run", async () => {
    const execFile = vi.fn(async () => {
      throw new Error("spawn ENOENT");
    });

    await expect(preflightLinearDocumentPublisher(execFile)).rejects.toThrow(
      "Linear Docs publisher preflight failed: linear-pp-cli is unavailable or not executable",
    );
  });

  it("wraps timeout-shaped preflight failures in the operator diagnostic", async () => {
    const timeoutError = Object.assign(new Error("spawn ETIMEDOUT"), {
      code: "ETIMEDOUT",
      killed: true,
    });
    const execFile = vi.fn(async () => {
      throw timeoutError;
    });

    await expect(preflightLinearDocumentPublisher(execFile)).rejects.toThrow(
      "Linear Docs publisher preflight failed: linear-pp-cli is unavailable or not executable for the spec-review watcher. Install or repair linear-pp-cli before running Claude. spawn ETIMEDOUT",
    );
  });

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
    const calls: Array<{
      file: string;
      args: readonly string[];
      options: { maxBuffer?: number; timeout?: number } | undefined;
    }> = [];
    let contentFile: string | null = null;
    let contentFileText = "";
    const execFile = vi.fn(
      async (
        file: string,
        args: readonly string[],
        options?: { maxBuffer?: number; timeout?: number },
      ) => {
        calls.push({ file, args, options });
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
      },
    );

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
    expect(calls.map((call) => call.options)).toEqual([
      { maxBuffer: 2 * 1024 * 1024, timeout: 30_000 },
      { maxBuffer: 2 * 1024 * 1024, timeout: 30_000 },
    ]);
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
    const calls: Array<{
      file: string;
      args: readonly string[];
      options: { maxBuffer?: number; timeout?: number } | undefined;
    }> = [];
    const execFile = vi.fn(
      async (
        file: string,
        args: readonly string[],
        options?: { maxBuffer?: number; timeout?: number },
      ) => {
        calls.push({ file, args, options });
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
      },
    );

    const publisher = createLinearDocumentPublisher(execFile);
    const result = await publisher.publish({
      issueIdentifier: "SYMPH-1",
      title: "Spec Review - SYMPH-1",
      markdown: "# Updated rationale",
      idempotencyKey: "spec-review:issue-1:source-hash",
    });

    expect(result.identifier).toBe("existing-doc");
    expect(calls.map((call) => call.args[1])).toEqual(["list", "edit"]);
    expect(calls.map((call) => call.options)).toEqual([
      { maxBuffer: 2 * 1024 * 1024, timeout: 30_000 },
      { maxBuffer: 2 * 1024 * 1024, timeout: 30_000 },
    ]);
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
  sequence = 1,
  sourceIntentHash?: string,
): DispatcherRunJournalEntry {
  return {
    sequence,
    idempotencyKey: `spec-review:${issue.id}:${sequence}`,
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
      ...(sourceIntentHash === undefined
        ? {}
        : { source_intent_hash: sourceIntentHash }),
    },
  };
}
