#!/usr/bin/env node

import { createHash } from "node:crypto";
import { realpathSync } from "node:fs";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { resolveWorkflowConfig } from "../config/config-resolver.js";
import type { ResolvedWorkflowConfig } from "../config/types.js";
import { loadWorkflowDefinition } from "../config/workflow-loader.js";
import type { DispatcherRunJournalEntry } from "../domain/model.js";
import {
  type SpecReviewDocumentPublisher,
  type SpecReviewMode,
  type SpecReviewRunIssueResult,
  appendSpecReviewResultJournal,
  runSpecReviewForIssue,
  selectSpecReviewCandidates,
} from "../spec-review/spec-review.js";
import { LinearTrackerClient } from "../tracker/linear-client.js";
import { extractTicketFeatures } from "../tracker/ticket-feature.js";

interface ParsedArgs {
  workflowPath: string | null;
  workspaceRoot: string;
  artifactRoot: string | null;
  mode: SpecReviewMode;
  states: string[] | null;
  issues: string[];
  cmuxSpawnBin: string | null;
  dryRun: boolean;
  help: boolean;
}

type SpecReviewWatchTracker = Pick<
  LinearTrackerClient,
  | "fetchIssuesByStates"
  | "fetchIssueReferencesByIds"
  | "fetchTicketFeatureIssuesByStates"
  | "postComment"
  | "updateIssueDescription"
>;

type ExecFileAsync = (
  file: string,
  args: readonly string[],
  options?: { maxBuffer?: number; timeout?: number },
) => Promise<{ stdout: string; stderr: string }>;

const LINEAR_DOCUMENT_PUBLISH_EXEC_OPTIONS = {
  maxBuffer: 2 * 1024 * 1024,
  timeout: 30_000,
} as const;

export interface SpecReviewWatchCliDependencies {
  loadWorkflowDefinition?: typeof loadWorkflowDefinition;
  resolveWorkflowConfig?: typeof resolveWorkflowConfig;
  createTracker?: (config: ResolvedWorkflowConfig) => SpecReviewWatchTracker;
  runSpecReviewForIssue?: typeof runSpecReviewForIssue;
  appendSpecReviewResultJournal?: typeof appendSpecReviewResultJournal;
  documentPublisher?: SpecReviewDocumentPublisher;
  preflightDocumentPublisher?: () => Promise<void>;
  now?: () => Date;
  stdout?: (text: string) => void;
  stderr?: (text: string) => void;
}

class UsageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UsageError";
  }
}

function usage(): string {
  return [
    "Usage: symphony-spec-review-watch [WORKFLOW.md] --workspace <repo> [options]",
    "",
    "Runs the durable spec-time Claude review watcher in observe/warn/enforce mode.",
    "",
    "Options:",
    "  --workspace <dir>         Claude-readable repo/workspace root (default: cwd)",
    "  --artifact-root <dir>     Artifact root (default: <workspace>/.symphony/spec-review)",
    "  --mode <mode>             observe|warn|enforce (default: observe)",
    "  --states <csv>            Linear states to scan (default: workflow active states)",
    "  --issue <identifier>      Restrict to an issue identifier (repeatable)",
    "  --cmux-spawn-bin <path>   cmux-spawn binary",
    "  --dry-run                 Select and print candidates without invoking Claude or writing Linear",
    "  --help                    Show this help",
  ].join("\n");
}

export function parseSpecReviewWatchArgs(
  argv: readonly string[],
  cwd = process.cwd(),
): ParsedArgs {
  let workflowPath: string | null = null;
  let workspaceRoot = cwd;
  let artifactRoot: string | null = null;
  let mode: SpecReviewMode = "observe";
  let states: string[] | null = null;
  const issues: string[] = [];
  let cmuxSpawnBin: string | null = null;
  let dryRun = false;

  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === undefined) {
      continue;
    }
    if (token === "--help" || token === "-h") {
      return {
        workflowPath,
        workspaceRoot,
        artifactRoot,
        mode,
        states,
        issues,
        cmuxSpawnBin,
        dryRun,
        help: true,
      };
    }
    if (token === "--dry-run") {
      dryRun = true;
      continue;
    }
    if (token === "--workspace") {
      workspaceRoot = resolve(cwd, readValue(argv, ++index, token));
      continue;
    }
    if (token === "--artifact-root") {
      artifactRoot = resolve(cwd, readValue(argv, ++index, token));
      continue;
    }
    if (token === "--mode") {
      mode = parseMode(readValue(argv, ++index, token));
      continue;
    }
    if (token === "--states") {
      states = readValue(argv, ++index, token)
        .split(",")
        .map((state) => state.trim())
        .filter((state) => state !== "");
      continue;
    }
    if (token === "--issue") {
      issues.push(readValue(argv, ++index, token));
      continue;
    }
    if (token === "--cmux-spawn-bin") {
      cmuxSpawnBin = readValue(argv, ++index, token);
      continue;
    }
    if (token.startsWith("--")) {
      throw new UsageError(`Unknown option: ${token}\n\n${usage()}`);
    }
    if (workflowPath !== null) {
      throw new UsageError(`Unexpected argument: ${token}\n\n${usage()}`);
    }
    workflowPath = resolve(cwd, token);
  }

  return {
    workflowPath,
    workspaceRoot,
    artifactRoot,
    mode,
    states,
    issues,
    cmuxSpawnBin,
    dryRun,
    help: false,
  };
}

export async function runSpecReviewWatchCli(
  argv: readonly string[],
  dependencies: SpecReviewWatchCliDependencies = {},
): Promise<number> {
  const stdout =
    dependencies.stdout ?? ((text: string) => process.stdout.write(text));
  const stderr =
    dependencies.stderr ?? ((text: string) => process.stderr.write(text));
  const now = dependencies.now ?? (() => new Date());
  const loadWorkflow =
    dependencies.loadWorkflowDefinition ?? loadWorkflowDefinition;
  const resolveConfig =
    dependencies.resolveWorkflowConfig ?? resolveWorkflowConfig;
  const runReview = dependencies.runSpecReviewForIssue ?? runSpecReviewForIssue;
  const appendJournal =
    dependencies.appendSpecReviewResultJournal ?? appendSpecReviewResultJournal;
  let parsed: ParsedArgs;
  try {
    parsed = parseSpecReviewWatchArgs(argv);
  } catch (error) {
    if (error instanceof UsageError) {
      stderr(`${error.message}\n`);
      return 2;
    }
    throw error;
  }
  if (parsed.help) {
    stdout(`${usage()}\n`);
    return 0;
  }

  const workflowPath =
    parsed.workflowPath ?? resolve(parsed.workspaceRoot, "WORKFLOW.md");
  const workflow = await loadWorkflow(workflowPath);
  const config = resolveConfig(workflow);
  const artifactRoot =
    parsed.artifactRoot ??
    resolve(parsed.workspaceRoot, ".symphony", "spec-review");
  await fs.mkdir(artifactRoot, { recursive: true });

  const tracker =
    dependencies.createTracker?.(config) ??
    new LinearTrackerClient({
      endpoint: config.tracker.endpoint,
      apiKey: config.tracker.apiKey,
      projectSlug: config.tracker.projectSlug,
      activeStates: config.tracker.activeStates,
    });
  const states = parsed.states ?? config.tracker.activeStates;
  const issues = (await tracker.fetchIssuesByStates(states)).filter((issue) =>
    parsed.issues.length === 0
      ? true
      : parsed.issues.includes(issue.identifier),
  );
  const featureIssues =
    tracker.fetchTicketFeatureIssuesByStates === undefined
      ? []
      : await tracker.fetchTicketFeatureIssuesByStates(states);
  const ticketFeatures = extractTicketFeatures({ issues: featureIssues });
  const decisions = selectSpecReviewCandidates({ issues, ticketFeatures });
  const selected = decisions.filter(
    (decision) => decision.status === "selected",
  );

  if (parsed.dryRun) {
    stdout(
      `${JSON.stringify({ decisions: redactSelectionDecisions(decisions), selectedCount: selected.length }, null, 2)}\n`,
    );
    return 0;
  }

  const selectionArtifactPath = resolve(
    artifactRoot,
    `selection-${now().toISOString().replaceAll(/[:.]/g, "-")}.json`,
  );
  await fs.writeFile(
    selectionArtifactPath,
    `${JSON.stringify({ decisions: redactSelectionDecisions(decisions), selectedCount: selected.length }, null, 2)}\n`,
    "utf8",
  );

  const blockedResults: SpecReviewRunIssueResult[] = [];
  for (const decision of decisions.filter(
    (candidate) => candidate.status === "blocked",
  )) {
    const readinessState = decision.reasons.includes("privacy_sensitive_label")
      ? "privacy_blocked"
      : "needs_operator_context";
    const summary = `Spec review blocked for ${decision.issue.identifier}: ${decision.reasons.join(", ")}`;
    const entries = await appendJournal(parsed.workspaceRoot, {
      issue: decision.issue,
      mode: parsed.mode,
      sourceIntentHash: decision.sourceIntentHash,
      readinessState,
      verdict: null,
      artifactPath: selectionArtifactPath,
      artifactHash: null,
      linearDocUrl: null,
      summary,
      now: now(),
    });
    blockedResults.push({
      issueId: decision.issue.id,
      issueIdentifier: decision.issue.identifier,
      sourceIntentHash: decision.sourceIntentHash,
      readinessState,
      verdict: null,
      runnerStatus: "degraded",
      artifactPath: selectionArtifactPath,
      linearDocUrl: null,
      markerCommentPosted: false,
      journalEntries: entries,
      message: summary,
    });
  }

  const results: SpecReviewRunIssueResult[] = [...blockedResults];
  const documentPublisher =
    dependencies.documentPublisher ?? createLinearDocumentPublisher();
  const preflightDocumentPublisher =
    dependencies.preflightDocumentPublisher ??
    (dependencies.documentPublisher === undefined
      ? preflightLinearDocumentPublisher
      : undefined);
  if (selected.length > 0 && preflightDocumentPublisher !== undefined) {
    try {
      await preflightDocumentPublisher();
    } catch (error) {
      const preflightMessage = errorMessage(error);
      stderr(`${preflightMessage}\n`);
      for (const decision of selected) {
        let summary = `Spec review failed for ${decision.issue.identifier}: ${preflightMessage}`;
        let entries: DispatcherRunJournalEntry[] = [];
        try {
          entries = await appendJournal(parsed.workspaceRoot, {
            issue: decision.issue,
            mode: parsed.mode,
            sourceIntentHash: decision.sourceIntentHash,
            readinessState: "failed",
            verdict: null,
            artifactPath: selectionArtifactPath,
            artifactHash: null,
            linearDocUrl: null,
            summary,
            now: now(),
          });
        } catch (journalError) {
          summary = `${summary}; journal append failed: ${errorMessage(journalError)}`;
        }
        results.push({
          issueId: decision.issue.id,
          issueIdentifier: decision.issue.identifier,
          sourceIntentHash: decision.sourceIntentHash,
          readinessState: "failed",
          verdict: null,
          runnerStatus: "failed",
          artifactPath: selectionArtifactPath,
          linearDocUrl: null,
          markerCommentPosted: false,
          journalEntries: entries,
          message: summary,
        });
      }
      stdout(
        `${JSON.stringify({ selectedCount: selected.length, selectionArtifactPath, results }, null, 2)}\n`,
      );
      return 1;
    }
  }

  const sourceOfTruthExcerpt = await readSourceOfTruthExcerpt(
    parsed.workspaceRoot,
  );
  for (const decision of selected) {
    try {
      results.push(
        await runReview({
          issue: decision.issue,
          ticketFeature: decision.ticketFeature,
          backlogFindings: decision.backlogFindings,
          workspaceRoot: parsed.workspaceRoot,
          artifactRoot,
          mode: parsed.mode,
          ...(parsed.cmuxSpawnBin === null
            ? {}
            : { cmuxSpawnBin: parsed.cmuxSpawnBin }),
          sourceOfTruthExcerpt,
          writer: {
            fetchIssueDescription: async (issueId) => {
              const [issue] = await tracker.fetchIssueReferencesByIds([
                issueId,
              ]);
              return issue?.description ?? null;
            },
            updateIssueDescription: async (issueId, description) => {
              await tracker.updateIssueDescription(issueId, description);
            },
            postComment: async (issueId, body) => {
              await tracker.postComment(issueId, body);
            },
          },
          documentPublisher,
        }),
      );
    } catch (error) {
      let summary = `Spec review failed for ${decision.issue.identifier}: ${errorMessage(error)}`;
      let entries: DispatcherRunJournalEntry[] = [];
      try {
        entries = await appendJournal(parsed.workspaceRoot, {
          issue: decision.issue,
          mode: parsed.mode,
          sourceIntentHash: decision.sourceIntentHash,
          readinessState: "failed",
          verdict: null,
          artifactPath: null,
          artifactHash: null,
          linearDocUrl: null,
          summary,
          now: now(),
        });
      } catch (journalError) {
        summary = `${summary}; journal append failed: ${errorMessage(journalError)}`;
      }
      results.push({
        issueId: decision.issue.id,
        issueIdentifier: decision.issue.identifier,
        sourceIntentHash: decision.sourceIntentHash,
        readinessState: "failed",
        verdict: null,
        runnerStatus: "failed",
        artifactPath: null,
        linearDocUrl: null,
        markerCommentPosted: false,
        journalEntries: entries,
        message: summary,
      });
    }
  }

  stdout(
    `${JSON.stringify({ selectedCount: selected.length, selectionArtifactPath, results }, null, 2)}\n`,
  );
  return results.every((result) =>
    isSuccessfulReadinessState(parsed.mode, result.readinessState),
  )
    ? 0
    : 1;
}

function isSuccessfulReadinessState(
  mode: SpecReviewMode,
  readinessState: SpecReviewRunIssueResult["readinessState"],
): boolean {
  if (readinessState === "valid" || readinessState === "not_required") {
    return true;
  }
  return mode !== "enforce" && readinessState === "needs_operator_context";
}

async function readSourceOfTruthExcerpt(
  workspaceRoot: string,
): Promise<string | null> {
  try {
    const text = await fs.readFile(
      resolve(workspaceRoot, "SPEC.mobilyze.md"),
      "utf8",
    );
    return text.slice(0, 6_000);
  } catch {
    return null;
  }
}

function readValue(
  argv: readonly string[],
  index: number,
  flag: string,
): string {
  const value = argv[index];
  if (value === undefined || value.trim() === "") {
    throw new UsageError(`${flag} requires a value`);
  }
  return value;
}

function parseMode(value: string): SpecReviewMode {
  if (value === "observe" || value === "warn" || value === "enforce") {
    return value;
  }
  throw new UsageError("--mode must be observe, warn, or enforce");
}

export function parseDocumentCreateOutput(stdout: string): {
  url: string;
  identifier: string | null;
} {
  const parsed = JSON.parse(stdout) as unknown;
  const candidates = isRecord(parsed)
    ? [
        parsed.results,
        parsed.document,
        isRecord(parsed.data) ? parsed.data.documentCreate : undefined,
        parsed,
      ]
    : [];
  for (const candidate of candidates) {
    if (!isRecord(candidate)) {
      continue;
    }
    const nested =
      isRecord(candidate.document) || isRecord(candidate.entity)
        ? [candidate.document, candidate.entity, candidate]
        : [candidate];
    for (const value of nested) {
      if (!isRecord(value)) {
        continue;
      }
      const url = stringField(value.url);
      if (url === null) {
        continue;
      }
      return {
        url,
        identifier:
          stringField(value.slugId) ??
          stringField(value.identifier) ??
          stringField(value.id),
      };
    }
  }
  throw new Error("Linear document create output did not include a URL.");
}

export function parseDocumentListOutput(
  stdout: string,
): Array<{ title: string | null; url: string; identifier: string | null }> {
  const parsed = JSON.parse(stdout) as unknown;
  const candidates = isRecord(parsed)
    ? [
        isRecord(parsed.results) ? parsed.results.documents : undefined,
        parsed.documents,
        isRecord(parsed.data) ? parsed.data.documents : undefined,
      ]
    : [];
  for (const candidate of candidates) {
    if (!Array.isArray(candidate)) {
      continue;
    }
    return candidate.flatMap((value) => {
      if (!isRecord(value)) {
        return [];
      }
      const url = stringField(value.url);
      if (url === null) {
        return [];
      }
      return [
        {
          title: stringField(value.title),
          url,
          identifier:
            stringField(value.slugId) ??
            stringField(value.identifier) ??
            stringField(value.id),
        },
      ];
    });
  }
  return [];
}

export function buildLinearDocumentPublishRequest(input: {
  title: string;
  markdown: string;
  idempotencyKey: string;
}): { title: string; markdown: string; idempotencyHash: string } {
  const idempotencyHash = createHash("sha256")
    .update(input.idempotencyKey)
    .digest("hex");
  return {
    title: `${input.title} (${idempotencyHash.slice(0, 12)})`,
    markdown: [
      `<!-- symphony-spec-review-doc-idempotency-sha256:${idempotencyHash} -->`,
      "",
      input.markdown.trimEnd(),
      "",
    ].join("\n"),
    idempotencyHash,
  };
}

export function createLinearDocumentPublisher(
  execFileAsync?: ExecFileAsync,
): SpecReviewDocumentPublisher {
  return {
    publish: async ({ issueIdentifier, title, markdown, idempotencyKey }) => {
      const tempDir = await fs.mkdtemp(
        resolve(tmpdir(), "symphony-spec-review-"),
      );
      try {
        const contentFile = resolve(tempDir, "doc.md");
        const prepared = buildLinearDocumentPublishRequest({
          title,
          markdown,
          idempotencyKey,
        });
        await fs.writeFile(contentFile, prepared.markdown, "utf8");
        const run = execFileAsync ?? (await defaultExecFileAsync());
        const listOutput = await run(
          "linear-pp-cli",
          [
            "documents",
            "list",
            "--issue",
            issueIdentifier,
            "--agent",
            "--select",
            "title,url,slugId",
            "--limit",
            "100",
          ],
          LINEAR_DOCUMENT_PUBLISH_EXEC_OPTIONS,
        );
        const existingDocument = parseDocumentListOutput(
          listOutput.stdout,
        ).find((document) => document.title === prepared.title);
        if (
          existingDocument !== undefined &&
          existingDocument.identifier !== null
        ) {
          const editOutput = await run(
            "linear-pp-cli",
            [
              "documents",
              "edit",
              existingDocument.identifier,
              "--title",
              prepared.title,
              "--content-file",
              contentFile,
              "--agent",
              "--select",
              "url,slugId",
            ],
            LINEAR_DOCUMENT_PUBLISH_EXEC_OPTIONS,
          );
          try {
            return parseDocumentCreateOutput(editOutput.stdout);
          } catch {
            return {
              url: existingDocument.url,
              identifier: existingDocument.identifier,
            };
          }
        }
        const output = await run(
          "linear-pp-cli",
          [
            "documents",
            "create",
            "--idempotent",
            "--title",
            prepared.title,
            "--issue",
            issueIdentifier,
            "--content-file",
            contentFile,
            "--agent",
            "--select",
            "url,slugId",
          ],
          LINEAR_DOCUMENT_PUBLISH_EXEC_OPTIONS,
        );
        const parsedOutput = parseDocumentCreateOutput(output.stdout);
        return {
          url: parsedOutput.url,
          identifier: parsedOutput.identifier,
        };
      } finally {
        await fs.rm(tempDir, { recursive: true, force: true });
      }
    },
  };
}

export async function preflightLinearDocumentPublisher(
  execFileAsync?: ExecFileAsync,
): Promise<void> {
  const run = execFileAsync ?? (await defaultExecFileAsync());
  try {
    await run("linear-pp-cli", ["documents", "--help"], {
      maxBuffer: 512 * 1024,
      timeout: 10_000,
    });
  } catch (error) {
    throw new Error(
      `Linear Docs publisher preflight failed: linear-pp-cli is unavailable or not executable for the spec-review watcher. Install or repair linear-pp-cli before running Claude. ${errorMessage(error)}`,
    );
  }
}

async function defaultExecFileAsync(): Promise<ExecFileAsync> {
  const { execFile } = await import("node:child_process");
  const { promisify } = await import("node:util");
  return promisify(execFile) as ExecFileAsync;
}

function redactSelectionDecisions(
  decisions: readonly ReturnType<typeof selectSpecReviewCandidates>[number][],
): ReturnType<typeof selectSpecReviewCandidates> {
  return decisions.map((decision) => {
    if (decision.redactionClass !== "sensitive") {
      return decision;
    }
    return {
      ...decision,
      issue: {
        ...decision.issue,
        title: "[redacted: privacy-sensitive]",
        description: null,
        branchName: null,
      },
      ticketFeature: null,
      backlogFindings: [],
    };
  });
}

function isDirectInvocation(): boolean {
  const entry = process.argv[1];
  if (entry === undefined) {
    return false;
  }
  try {
    return pathToFileURL(realpathSync(entry)).href === import.meta.url;
  } catch {
    return false;
  }
}

if (isDirectInvocation()) {
  runSpecReviewWatchCli(process.argv.slice(2))
    .then((code) => {
      process.exitCode = code;
    })
    .catch((error) => {
      console.error(
        error instanceof Error ? (error.stack ?? error.message) : String(error),
      );
      process.exitCode = 1;
    });
}

function stringField(value: unknown): string | null {
  return typeof value === "string" && value.trim() !== "" ? value : null;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
