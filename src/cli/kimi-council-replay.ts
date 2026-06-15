#!/usr/bin/env node

import { access, readFile, readdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";

import {
  type HeadlessCouncilGateResult,
  type HeadlessReviewerLaneConfig,
  type StructuredReviewerArtifact,
  runHeadlessCouncilGate,
} from "../review/headless-council-gate.js";
import { isDirectRun } from "./council-review-gate.js";

interface ParsedArgs {
  sourceCouncilDir: string;
  replayArtifactDir: string;
  workspace: string;
  issueId: string;
  repo?: string;
  prNumber?: number;
  baseRef?: string;
  headRef?: string;
  cmuxSpawnBin?: string;
  kimiBin?: string;
  kimiModel?: string;
}

interface SourceLaneSummary {
  laneId: string;
  agent: string;
  modelFamily: string;
  verdict: string;
  parseStatus: string;
  blockingFingerprints: string[];
  trackFingerprints: string[];
  artifactPath: string;
}

interface KimiReplayComparisonReport {
  schemaVersion: 1;
  kind: "symphony-kimi-council-replay-comparison";
  issueId: string;
  sourceCouncilDir: string;
  replayArtifactDir: string;
  sourceLanes: SourceLaneSummary[];
  kimiLane: SourceLaneSummary | null;
  scoring: {
    blockerRecallAgainstUnion: number | null;
    kimiBlockingFingerprints: string[];
    sourceBlockingFingerprints: string[];
    matchedBlockingFingerprints: string[];
    kimiOnlyBlockingFingerprints: string[];
    missingSourceBlockingFingerprints: string[];
    artifactContract: "complete" | "missing" | "malformed";
  };
  gateResultPath: string;
  markdownReportPath: string;
}

class UsageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UsageError";
  }
}

export function parseKimiCouncilReplayArgs(
  argv: readonly string[],
  cwd = process.cwd(),
): ParsedArgs {
  const parsed: Partial<ParsedArgs> = {
    workspace: cwd,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === undefined) {
      continue;
    }
    if (token === "--help" || token === "-h") {
      throw new UsageError(renderUsage());
    }
    if (token === "--source-council-dir") {
      parsed.sourceCouncilDir = readValue(argv, ++index, token);
      continue;
    }
    if (token === "--artifact-dir") {
      parsed.replayArtifactDir = readValue(argv, ++index, token);
      continue;
    }
    if (token === "--workspace") {
      parsed.workspace = readValue(argv, ++index, token);
      continue;
    }
    if (token === "--issue-id") {
      parsed.issueId = readValue(argv, ++index, token);
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
    if (token === "--cmux-spawn-bin") {
      parsed.cmuxSpawnBin = readValue(argv, ++index, token);
      continue;
    }
    if (token === "--kimi-bin") {
      parsed.kimiBin = readValue(argv, ++index, token);
      continue;
    }
    if (token === "--kimi-model") {
      parsed.kimiModel = readValue(argv, ++index, token);
      continue;
    }
    throw new UsageError(`Unknown argument: ${token}`);
  }

  if (parsed.sourceCouncilDir === undefined) {
    throw new UsageError("--source-council-dir is required.");
  }
  if (parsed.replayArtifactDir === undefined) {
    throw new UsageError("--artifact-dir is required.");
  }
  if (parsed.issueId === undefined) {
    throw new UsageError("--issue-id is required.");
  }
  return parsed as ParsedArgs;
}

export async function runKimiCouncilReplay(
  args: ParsedArgs,
): Promise<KimiReplayComparisonReport> {
  const sourceCouncilDir = resolve(args.sourceCouncilDir);
  const replayArtifactDir = resolve(args.replayArtifactDir);
  const diffPath = join(sourceCouncilDir, "diff.patch");
  await assertReadableSourceDiff(diffPath);
  const sourceLanes = await readStructuredLaneSummaries(sourceCouncilDir);
  const kimiLane: HeadlessReviewerLaneConfig = {
    laneId: "kimi-k27-shadow",
    agent: "kimi",
    role: "kimi-k27-shadow-reviewer",
    ...(args.kimiModel === undefined ? {} : { model: args.kimiModel }),
    ...(args.kimiBin === undefined ? {} : { binary: args.kimiBin }),
    independentReviewer: false,
    mergeAuthoritative: false,
  };
  const gateResult = await runHeadlessCouncilGate({
    issueId: args.issueId,
    workspace: args.workspace,
    artifactDir: replayArtifactDir,
    diffPath,
    reviewerLanes: [kimiLane],
    codexLead: false,
    ...(args.repo === undefined ? {} : { repo: args.repo }),
    ...(args.prNumber === undefined ? {} : { prNumber: args.prNumber }),
    ...(args.baseRef === undefined ? {} : { baseRef: args.baseRef }),
    ...(args.headRef === undefined ? {} : { headRef: args.headRef }),
    ...(args.cmuxSpawnBin === undefined
      ? {}
      : { cmuxSpawnBin: args.cmuxSpawnBin }),
  });
  const kimiSummary = summarizeKimiGate(gateResult);
  const reportPath = join(replayArtifactDir, "kimi-replay-comparison.json");
  const markdownReportPath = join(
    replayArtifactDir,
    "kimi-replay-comparison.md",
  );
  const report = buildComparisonReport({
    issueId: args.issueId,
    sourceCouncilDir,
    replayArtifactDir,
    sourceLanes,
    kimiLane: kimiSummary,
    gateResultPath: gateResult.artifactPaths.resultJson,
    markdownReportPath,
  });
  await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`);
  await writeFile(markdownReportPath, formatMarkdownReport(report));
  return report;
}

async function assertReadableSourceDiff(diffPath: string): Promise<void> {
  try {
    await access(diffPath);
  } catch {
    throw new UsageError(
      `Source council diff not found: ${diffPath}. Expected --source-council-dir to contain diff.patch.`,
    );
  }
}

async function readStructuredLaneSummaries(
  sourceCouncilDir: string,
): Promise<SourceLaneSummary[]> {
  const entries = await readdir(sourceCouncilDir);
  const structuredPaths = entries
    .filter((entry) => entry.endsWith(".structured.json"))
    .map((entry) => join(sourceCouncilDir, entry))
    .sort();
  const summaries: SourceLaneSummary[] = [];
  for (const artifactPath of structuredPaths) {
    const artifact = JSON.parse(
      await readFile(artifactPath, "utf-8"),
    ) as StructuredReviewerArtifact;
    summaries.push(summarizeStructuredArtifact(artifact, artifactPath));
  }
  return summaries;
}

function summarizeKimiGate(
  result: HeadlessCouncilGateResult,
): SourceLaneSummary | null {
  const lane = result.lanes.find((candidate) => candidate.agent === "kimi");
  if (
    lane?.structuredArtifact === null ||
    lane?.structuredArtifact === undefined
  ) {
    return null;
  }
  return summarizeStructuredArtifact(
    lane.structuredArtifact,
    lane.structuredArtifactPath ?? lane.artifactPath ?? "unknown",
  );
}

function summarizeStructuredArtifact(
  artifact: StructuredReviewerArtifact,
  artifactPath: string,
): SourceLaneSummary {
  return {
    laneId: artifact.lane.laneId,
    agent: artifact.lane.agent,
    modelFamily: artifact.lane.modelFamily,
    verdict: artifact.verdict,
    parseStatus: artifact.parseStatus,
    blockingFingerprints: artifact.findings
      .filter(
        (finding) => finding.severity === "P1" || finding.severity === "P2",
      )
      .map((finding) => finding.fingerprint)
      .sort(),
    trackFingerprints: artifact.findings
      .filter((finding) => finding.severity === "Track")
      .map((finding) => finding.fingerprint)
      .sort(),
    artifactPath,
  };
}

export function buildComparisonReport(input: {
  issueId: string;
  sourceCouncilDir: string;
  replayArtifactDir: string;
  sourceLanes: SourceLaneSummary[];
  kimiLane: SourceLaneSummary | null;
  gateResultPath: string;
  markdownReportPath: string;
}): KimiReplayComparisonReport {
  const sourceBlocking = uniqueSorted(
    input.sourceLanes.flatMap((lane) => lane.blockingFingerprints),
  );
  const kimiBlocking = input.kimiLane?.blockingFingerprints ?? [];
  const matched = sourceBlocking.filter((fingerprint) =>
    kimiBlocking.includes(fingerprint),
  );
  const kimiOnly = kimiBlocking.filter(
    (fingerprint) => !sourceBlocking.includes(fingerprint),
  );
  const missing = sourceBlocking.filter(
    (fingerprint) => !kimiBlocking.includes(fingerprint),
  );
  return {
    schemaVersion: 1,
    kind: "symphony-kimi-council-replay-comparison",
    issueId: input.issueId,
    sourceCouncilDir: input.sourceCouncilDir,
    replayArtifactDir: input.replayArtifactDir,
    sourceLanes: input.sourceLanes,
    kimiLane: input.kimiLane,
    scoring: {
      blockerRecallAgainstUnion:
        sourceBlocking.length === 0
          ? null
          : matched.length / sourceBlocking.length,
      kimiBlockingFingerprints: kimiBlocking,
      sourceBlockingFingerprints: sourceBlocking,
      matchedBlockingFingerprints: matched,
      kimiOnlyBlockingFingerprints: kimiOnly,
      missingSourceBlockingFingerprints: missing,
      artifactContract:
        input.kimiLane === null
          ? "missing"
          : input.kimiLane.parseStatus === "malformed"
            ? "malformed"
            : "complete",
    },
    gateResultPath: input.gateResultPath,
    markdownReportPath: input.markdownReportPath,
  };
}

function formatMarkdownReport(report: KimiReplayComparisonReport): string {
  const recall =
    report.scoring.blockerRecallAgainstUnion === null
      ? "n/a"
      : report.scoring.blockerRecallAgainstUnion.toFixed(2);
  return [
    "# Kimi Council Replay Comparison",
    "",
    `Issue: ${report.issueId}`,
    `Source council dir: ${report.sourceCouncilDir}`,
    `Replay artifact dir: ${report.replayArtifactDir}`,
    `Kimi artifact contract: ${report.scoring.artifactContract}`,
    `Blocker recall against source union: ${recall}`,
    "",
    "## Source Lanes",
    "",
    ...report.sourceLanes.map(
      (lane) =>
        `- ${lane.laneId} (${lane.agent}/${lane.modelFamily}): ${lane.blockingFingerprints.length} blocking, ${lane.trackFingerprints.length} track`,
    ),
    "",
    "## Kimi",
    "",
    report.kimiLane === null
      ? "- No structured Kimi artifact was produced."
      : `- ${report.kimiLane.laneId}: ${report.kimiLane.blockingFingerprints.length} blocking, ${report.kimiLane.trackFingerprints.length} track, parse status ${report.kimiLane.parseStatus}`,
    "",
    "## Delta",
    "",
    `- Matched source blockers: ${report.scoring.matchedBlockingFingerprints.join(", ") || "none"}`,
    `- Missing source blockers: ${report.scoring.missingSourceBlockingFingerprints.join(", ") || "none"}`,
    `- Kimi-only blockers: ${report.scoring.kimiOnlyBlockingFingerprints.join(", ") || "none"}`,
    "",
  ].join("\n");
}

function uniqueSorted(values: readonly string[]): string[] {
  return [...new Set(values)].sort();
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

function renderUsage(): string {
  return [
    "Usage: symphony-kimi-council-replay --source-council-dir DIR --artifact-dir DIR --issue-id ISSUE [options]",
    "",
    "Options:",
    "  --workspace DIR          Workspace path (default: current directory)",
    "  --repo OWNER/REPO        Optional GitHub repo metadata",
    "  --pr NUMBER              Optional PR number metadata",
    "  --base REF               Optional base ref metadata",
    "  --head REF               Optional head ref metadata",
    "  --cmux-spawn-bin PATH    cmux-spawn executable path",
    "  --kimi-bin PATH          explicit Kimi CLI path",
    "  --kimi-model MODEL       Kimi model alias (default: Kimi CLI config)",
    "",
  ].join("\n");
}

export async function runKimiCouncilReplayCli(
  argv: readonly string[],
  io = {
    stdout: (message: string) => process.stdout.write(message),
    stderr: (message: string) => process.stderr.write(message),
  },
): Promise<number> {
  let parsed: ParsedArgs;
  try {
    parsed = parseKimiCouncilReplayArgs(argv);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (message.startsWith("Usage:")) {
      io.stdout(message);
      return 0;
    }
    io.stderr(`${message}\n\n${renderUsage()}`);
    return 2;
  }
  const report = await runKimiCouncilReplay(parsed);
  io.stdout(`${JSON.stringify(report, null, 2)}\n`);
  return report.scoring.artifactContract === "complete" ? 0 : 1;
}

if (isDirectRun(import.meta.url, process.argv[1])) {
  runKimiCouncilReplayCli(process.argv.slice(2))
    .then((code) => {
      process.exitCode = code;
    })
    .catch((error) => {
      process.stderr.write(
        `symphony-kimi-council-replay failed: ${error instanceof Error ? error.message : String(error)}\n`,
      );
      process.exitCode = 1;
    });
}
