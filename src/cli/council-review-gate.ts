#!/usr/bin/env node

import { realpathSync } from "node:fs";
import { pathToFileURL } from "node:url";

import { getDispatcherRunJournalPath } from "../logging/run-journal.js";
import {
  COUNCIL_ROUTING_MODES,
  type CouncilReviewMode,
  type CouncilRoutingMode,
  assertFreshCouncilReview as assertFreshCouncilReviewImpl,
  runHeadlessCouncilGate as runHeadlessCouncilGateImpl,
} from "../review/headless-council-gate.js";
import {
  type ReviewJournalSource,
  appendReviewJournalEventsToDispatcherJournal as appendReviewJournalEventsToDispatcherJournalImpl,
} from "../review/review-journal-events.js";

interface ParsedArgs {
  issueId: string;
  workspace: string;
  artifactDir: string;
  repo?: string;
  prNumber?: number;
  baseRef?: string;
  headRef?: string;
  diffPath?: string;
  cmuxSpawnBin?: string;
  timeoutSeconds?: number;
  codexLead?: boolean;
  codexExcavation?: boolean;
  codexExcavationSweep?: "standard" | "high-risk";
  codexExcavationTimeoutSeconds?: number;
  codexExcavationToolOutputTokenLimit?: number;
  codexExcavationModelAutoCompactTokenLimit?: number;
  round?: number;
  mode?: CouncilReviewMode;
  routingMode?: CouncilRoutingMode;
  operatorOverrideReason?: string;
  previousReviewedHeadSha?: string;
  riskContractArtifactPaths: string[];
  assertFreshReview?: string;
  allowedChangePatterns: string[];
  journalWorkspaceRoot?: string;
  journalSource?: ReviewJournalSource;
  journalStage?: string;
  journalAttempt?: number;
  journalOwnerId?: string;
  journalIssueIdentifier?: string;
}

interface CouncilReviewGateCliDependencies {
  runHeadlessCouncilGate?: typeof runHeadlessCouncilGateImpl;
  assertFreshCouncilReview?: typeof assertFreshCouncilReviewImpl;
  appendReviewJournalEventsToDispatcherJournal?: typeof appendReviewJournalEventsToDispatcherJournalImpl;
}

class UsageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UsageError";
  }
}

export function parseCouncilReviewGateArgs(
  argv: readonly string[],
  cwd = process.cwd(),
): ParsedArgs {
  const parsed: Partial<ParsedArgs> = {
    workspace: cwd,
    allowedChangePatterns: [],
    riskContractArtifactPaths: [],
  };

  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === undefined) {
      continue;
    }

    if (token === "--help" || token === "-h") {
      throw new UsageError(renderUsage());
    }

    if (token === "--issue-id") {
      parsed.issueId = readValue(argv, ++index, token);
      continue;
    }
    if (token === "--workspace") {
      parsed.workspace = readValue(argv, ++index, token);
      continue;
    }
    if (token === "--artifact-dir") {
      parsed.artifactDir = readValue(argv, ++index, token);
      continue;
    }
    if (token === "--repo") {
      parsed.repo = readValue(argv, ++index, token);
      continue;
    }
    if (token === "--pr") {
      parsed.prNumber = readPositiveInteger(
        readValue(argv, ++index, token),
        token,
      );
      continue;
    }
    if (token === "--base") {
      parsed.baseRef = readValue(argv, ++index, token);
      continue;
    }
    if (token === "--head") {
      parsed.headRef = readValue(argv, ++index, token);
      continue;
    }
    if (token === "--diff") {
      parsed.diffPath = readValue(argv, ++index, token);
      continue;
    }
    if (token === "--cmux-spawn-bin") {
      parsed.cmuxSpawnBin = readValue(argv, ++index, token);
      continue;
    }
    if (token === "--timeout-seconds") {
      parsed.timeoutSeconds = readPositiveInteger(
        readValue(argv, ++index, token),
        token,
      );
      continue;
    }
    if (token === "--round") {
      parsed.round = readPositiveInteger(
        readValue(argv, ++index, token),
        token,
      );
      continue;
    }
    if (token === "--mode") {
      parsed.mode = readMode(readValue(argv, ++index, token), token);
      continue;
    }
    if (token === "--routing-mode") {
      parsed.routingMode = readRoutingMode(
        readValue(argv, ++index, token),
        token,
      );
      continue;
    }
    if (token === "--operator-override-reason") {
      parsed.operatorOverrideReason = readValue(argv, ++index, token);
      continue;
    }
    if (token === "--previous-reviewed-head") {
      parsed.previousReviewedHeadSha = readGitSha(
        readValue(argv, ++index, token),
        token,
      );
      continue;
    }
    if (token === "--risk-contract-artifact") {
      parsed.riskContractArtifactPaths = [
        ...(parsed.riskContractArtifactPaths ?? []),
        readValue(argv, ++index, token),
      ];
      continue;
    }
    if (token === "--no-codex-lead") {
      parsed.codexLead = false;
      continue;
    }
    if (token === "--no-codex-excavation") {
      parsed.codexExcavation = false;
      continue;
    }
    if (token === "--codex-excavation-sweep") {
      parsed.codexExcavationSweep = readCodexExcavationSweep(
        readValue(argv, ++index, token),
        token,
      );
      continue;
    }
    if (token === "--codex-excavation-timeout-seconds") {
      parsed.codexExcavationTimeoutSeconds = readPositiveInteger(
        readValue(argv, ++index, token),
        token,
      );
      continue;
    }
    if (token === "--codex-excavation-tool-output-token-limit") {
      parsed.codexExcavationToolOutputTokenLimit = readPositiveInteger(
        readValue(argv, ++index, token),
        token,
      );
      continue;
    }
    if (token === "--codex-excavation-model-auto-compact-token-limit") {
      parsed.codexExcavationModelAutoCompactTokenLimit = readPositiveInteger(
        readValue(argv, ++index, token),
        token,
      );
      continue;
    }
    if (token === "--assert-fresh-review") {
      parsed.assertFreshReview = readValue(argv, ++index, token);
      continue;
    }
    if (token === "--allow-stale-path") {
      parsed.allowedChangePatterns = [
        ...(parsed.allowedChangePatterns ?? []),
        readValue(argv, ++index, token),
      ];
      continue;
    }
    if (token === "--journal-workspace-root") {
      parsed.journalWorkspaceRoot = readValue(argv, ++index, token);
      continue;
    }
    if (token === "--journal-source") {
      parsed.journalSource = readReviewJournalSource(
        readValue(argv, ++index, token),
        token,
      );
      continue;
    }
    if (token === "--journal-stage") {
      parsed.journalStage = readValue(argv, ++index, token);
      continue;
    }
    if (token === "--journal-attempt") {
      parsed.journalAttempt = readPositiveInteger(
        readValue(argv, ++index, token),
        token,
      );
      continue;
    }
    if (token === "--journal-owner-id") {
      parsed.journalOwnerId = readValue(argv, ++index, token);
      continue;
    }
    if (token === "--journal-issue-identifier") {
      parsed.journalIssueIdentifier = readValue(argv, ++index, token);
      continue;
    }

    throw new UsageError(`Unknown argument: ${token}`);
  }

  if (parsed.issueId === undefined || parsed.issueId.trim() === "") {
    throw new UsageError("--issue-id is required.");
  }
  if (parsed.artifactDir === undefined || parsed.artifactDir.trim() === "") {
    throw new UsageError("--artifact-dir is required.");
  }
  if (parsed.repo !== undefined && !isValidRepoSlug(parsed.repo)) {
    throw new UsageError("--repo must use OWNER/REPO format.");
  }
  if (parsed.prNumber !== undefined && parsed.repo === undefined) {
    throw new UsageError("--repo is required when --pr is provided.");
  }
  if (
    parsed.assertFreshReview !== undefined &&
    (parsed.mode !== undefined ||
      parsed.round !== undefined ||
      parsed.previousReviewedHeadSha !== undefined)
  ) {
    throw new UsageError(
      "--mode, --round, and --previous-reviewed-head are only valid when running a council review, not with --assert-fresh-review.",
    );
  }
  if (
    parsed.assertFreshReview !== undefined &&
    (parsed.riskContractArtifactPaths ?? []).length > 0
  ) {
    throw new UsageError(
      "--risk-contract-artifact is only valid when running a council review, not with --assert-fresh-review.",
    );
  }
  if (
    parsed.assertFreshReview !== undefined &&
    (parsed.codexLead !== undefined ||
      parsed.codexExcavation !== undefined ||
      parsed.codexExcavationSweep !== undefined ||
      parsed.codexExcavationTimeoutSeconds !== undefined ||
      parsed.codexExcavationToolOutputTokenLimit !== undefined ||
      parsed.codexExcavationModelAutoCompactTokenLimit !== undefined ||
      parsed.routingMode !== undefined ||
      parsed.operatorOverrideReason !== undefined)
  ) {
    throw new UsageError(
      "Codex lane and routing flags are only valid when running a council review, not with --assert-fresh-review.",
    );
  }
  if (
    parsed.assertFreshReview !== undefined &&
    parsed.journalWorkspaceRoot !== undefined
  ) {
    throw new UsageError(
      "--journal-workspace-root is only valid when running a council review, not with --assert-fresh-review.",
    );
  }
  if (
    parsed.journalWorkspaceRoot === undefined &&
    (parsed.journalSource !== undefined ||
      parsed.journalStage !== undefined ||
      parsed.journalAttempt !== undefined ||
      parsed.journalOwnerId !== undefined ||
      parsed.journalIssueIdentifier !== undefined)
  ) {
    throw new UsageError(
      "--journal-source, --journal-stage, --journal-attempt, --journal-owner-id, and --journal-issue-identifier require --journal-workspace-root.",
    );
  }

  return parsed as ParsedArgs;
}

export async function runCouncilReviewGateCli(
  argv: readonly string[],
  io = {
    stdout: (message: string) => process.stdout.write(message),
    stderr: (message: string) => process.stderr.write(message),
  },
  dependencies: CouncilReviewGateCliDependencies = {},
): Promise<number> {
  let parsed: ParsedArgs;
  try {
    parsed = parseCouncilReviewGateArgs(argv);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (message.startsWith("Usage:")) {
      io.stdout(message);
      return 0;
    }
    io.stderr(`${message}\n\n${renderUsage()}`);
    return 2;
  }

  const runHeadlessCouncilGate =
    dependencies.runHeadlessCouncilGate ?? runHeadlessCouncilGateImpl;
  const assertFreshCouncilReview =
    dependencies.assertFreshCouncilReview ?? assertFreshCouncilReviewImpl;
  const appendReviewJournalEventsToDispatcherJournal =
    dependencies.appendReviewJournalEventsToDispatcherJournal ??
    appendReviewJournalEventsToDispatcherJournalImpl;

  if (parsed.assertFreshReview === undefined) {
    const result = await runHeadlessCouncilGate(parsed);
    if (parsed.journalWorkspaceRoot !== undefined) {
      try {
        await appendReviewJournalEventsToDispatcherJournal({
          workspaceRoot: parsed.journalWorkspaceRoot,
          result,
          options: {
            issueIdentifier: parsed.journalIssueIdentifier ?? parsed.issueId,
            ownerId: parsed.journalOwnerId ?? null,
            stage: parsed.journalStage ?? "review",
            attempt: parsed.journalAttempt ?? null,
            source: parsed.journalSource ?? "pipeline",
          },
        });
      } catch (error) {
        io.stderr(
          formatJournalAppendFailure({
            error,
            workspaceRoot: parsed.journalWorkspaceRoot,
            source: parsed.journalSource ?? "pipeline",
          }),
        );
        return 1;
      }
    }
    io.stdout(`${JSON.stringify(result, null, 2)}\n`);
    return result.verdict === "pass" ? 0 : 1;
  }

  const result = await assertFreshCouncilReview({
    issueId: parsed.issueId,
    workspace: parsed.workspace,
    artifactDir: parsed.artifactDir,
    reviewResultPath: parsed.assertFreshReview,
    allowedChangePatterns: parsed.allowedChangePatterns,
    ...(parsed.repo === undefined ? {} : { repo: parsed.repo }),
    ...(parsed.prNumber === undefined ? {} : { prNumber: parsed.prNumber }),
    ...(parsed.baseRef === undefined ? {} : { baseRef: parsed.baseRef }),
    ...(parsed.headRef === undefined ? {} : { headRef: parsed.headRef }),
  });
  io.stdout(`${JSON.stringify(result, null, 2)}\n`);
  if (result.verdict === "pass") {
    return 0;
  }
  return result.code === "stale_review" ? 1 : 2;
}

function readValue(
  argv: readonly string[],
  index: number,
  flag: string,
): string {
  const value = argv[index];
  if (value === undefined || value.startsWith("-")) {
    throw new UsageError(`${flag} requires a value.`);
  }
  return value;
}

function readPositiveInteger(value: string, flag: string): number {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isInteger(parsed) || parsed <= 0 || String(parsed) !== value) {
    throw new UsageError(`${flag} must be a positive integer.`);
  }
  return parsed;
}

function readMode(value: string, flag: string): CouncilReviewMode {
  if (value === "full" || value === "convergence") {
    return value;
  }
  throw new UsageError(`${flag} must be "full" or "convergence".`);
}

function readRoutingMode(value: string, flag: string): CouncilRoutingMode {
  if (COUNCIL_ROUTING_MODES.includes(value as CouncilRoutingMode)) {
    return value as CouncilRoutingMode;
  }
  throw new UsageError(
    `${flag} must be one of: ${COUNCIL_ROUTING_MODES.join(", ")}.`,
  );
}

function readReviewJournalSource(
  value: string,
  flag: string,
): ReviewJournalSource {
  if (value === "pipeline" || value === "interactive" || value === "replay") {
    return value;
  }
  throw new UsageError(
    `${flag} must be "pipeline", "interactive", or "replay".`,
  );
}

function readCodexExcavationSweep(
  value: string,
  flag: string,
): "standard" | "high-risk" {
  if (value === "standard" || value === "high-risk") {
    return value;
  }
  throw new UsageError(`${flag} must be "standard" or "high-risk".`);
}

function readGitSha(value: string, flag: string): string {
  if (/^[a-f0-9]{7,40}$/i.test(value)) {
    return value;
  }
  throw new UsageError(`${flag} must be a 7-40 character git SHA.`);
}

function isValidRepoSlug(value: string): boolean {
  return /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(value);
}

function renderUsage(): string {
  return [
    "Usage: symphony-council-review-gate --issue-id ISSUE --artifact-dir DIR [options]",
    "",
    "Options:",
    "  --issue-id ISSUE              Required Linear/source issue identifier",
    "  --artifact-dir DIR            Required directory for review artifacts",
    "  --repo OWNER/REPO              GitHub repository for PR review",
    "  --pr NUMBER                   GitHub PR number; requires --repo",
    "  --workspace DIR               Workspace path (default: current directory)",
    "  --base REF                    Base ref for local diff mode",
    "  --head REF                    Head ref for local diff mode",
    "  --diff PATH                   Review an explicit diff file",
    "  --cmux-spawn-bin PATH         cmux-spawn executable path",
    "  --timeout-seconds N           Per-lane timeout in seconds",
    "  --no-codex-lead               Skip Codex lead triage and mark degraded",
    "  --no-codex-excavation         Skip the default Codex edge-case excavation reviewer lane",
    "  --codex-excavation-sweep standard|high-risk  Codex excavation preset (default: standard; high-risk uses a longer bounded sweep)",
    "  --codex-excavation-timeout-seconds N          Override Codex excavation lane timeout",
    "  --codex-excavation-tool-output-token-limit N  Override Codex excavation per-tool output cap",
    "  --codex-excavation-model-auto-compact-token-limit N  Override Codex excavation auto-compact cap",
    "  --round N                     Council loop round number (default: 1)",
    "  --mode full|convergence       Council loop mode (default: full)",
    "  --routing-mode fast|standard|high-risk|disagreement|legacy  Force Council v2 routing mode for this run",
    "  --operator-override-reason TEXT  Record the operator reason for force/override routing",
    "  --previous-reviewed-head SHA  Previous reviewed head SHA for convergence metadata",
    "  --risk-contract-artifact PATH Bounded risk-predicate state contract artifact path; repeatable",
    "  --assert-fresh-review PATH    Assert an existing clean review-result.json covers current HEAD",
    "  --allow-stale-path GLOB       Explicit freshness allowlist; repeatable; ** crosses /, * and ? do not",
    "  --journal-workspace-root DIR  Append sanitized review events to DIR/.symphony/run-journals/dispatcher.jsonl under the standalone journal lock; fail closed on append errors",
    "  --journal-source SOURCE       Journal source: pipeline, interactive, or replay (default: pipeline)",
    "  --journal-stage STAGE         Journal stage label (default: review)",
    "  --journal-attempt N           Journal pipeline attempt",
    "  --journal-owner-id ID         Journal owner/actor id",
    "  --journal-issue-identifier ID Journal issue identifier (default: --issue-id)",
    "",
  ].join("\n");
}

export function isDirectRun(
  importMetaUrl: string,
  argvPath: string | undefined,
) {
  if (argvPath === undefined) {
    return false;
  }
  try {
    return importMetaUrl === pathToFileURL(realpathSync(argvPath)).href;
  } catch {
    return false;
  }
}

if (isDirectRun(import.meta.url, process.argv[1])) {
  runCouncilReviewGateCli(process.argv.slice(2))
    .then((code) => {
      process.exitCode = code;
    })
    .catch((error) => {
      process.stderr.write(
        `symphony-council-review-gate failed: ${formatError(error)}\n`,
      );
      process.exitCode = 1;
    });
}

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function formatJournalAppendFailure(input: {
  error: unknown;
  workspaceRoot: string;
  source: ReviewJournalSource;
}): string {
  return [
    `Failed to append council review result to the dispatcher journal: ${formatError(input.error)}`,
    `Journal: ${getDispatcherRunJournalPath(input.workspaceRoot)}`,
    `Source: ${input.source}`,
    "Policy: --journal-workspace-root is fail-closed because SPEC.mobilyze.md's Dispatcher Resume Contract makes the dispatcher journal the source of truth for gate replay.",
    "Pipeline expectation: do not consume a gate result until the journal append succeeds; fix the workspace journal path and rerun.",
    "Interactive expectation: runs that pass --journal-workspace-root use the same fail-closed contract; omit the flag only for local dry runs outside dispatcher resume.",
    "",
  ].join("\n");
}
