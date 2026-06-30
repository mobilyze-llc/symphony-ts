#!/usr/bin/env node

import { isDirectRun } from "./direct-run.js";

// Internal historical parser only. SYMPH-985 retires fresh Kimi replay because
// the only available execution path was the removed local review lane launcher.
type StructuredReviewParseStatus = "synthesized_from_markdown" | "malformed";

interface ParsedArgs {
  sourceCouncilDir: string;
  replayArtifactDir: string;
  workspace: string;
  issueId: string;
  repo?: string;
  prNumber?: number;
  baseRef?: string;
  headRef?: string;
  kimiBin?: string;
  kimiModel?: string;
}

interface SourceLaneSummary {
  laneId: string;
  agent: string;
  role: string | null;
  modelFamily: string;
  verdict: string;
  parseStatus: StructuredReviewParseStatus;
  sourceRecallEligible: boolean;
  sourceRecallExclusionReason:
    | "lead_artifact"
    | "prior_shadow_artifact"
    | "non_ok_parse_status"
    | null;
  blockingFingerprints: string[];
  trackFingerprints: string[];
  artifactPath: string;
  reviewBundleCanonicalHash: string | null;
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
    artifactContractReason: string;
  };
  frozenReviewBundle: {
    canonicalHash: string | null;
    sourceHashStatus: "absent" | "consistent" | "divergent" | "partial";
    sourceHashes: string[];
    kimiReplayBundleHash: string | null;
    sourceInputsPinnedByKimiReplay: boolean;
    kimiReplayBundleHashMatchesSource: boolean | null;
    usedByKimiReplay: boolean;
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
  void args;
  throw new UsageError(
    "symphony-kimi-council-replay has been retired; fresh Kimi replay depended on the removed local review lane launcher.",
  );
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
    input.sourceLanes
      .filter((lane) => lane.sourceRecallEligible)
      .flatMap((lane) => lane.blockingFingerprints),
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
  const artifactContract = classifyArtifactContract(input.kimiLane);
  const frozenReviewBundle = summarizeFrozenReviewBundleUse(
    input.sourceLanes,
    input.kimiLane,
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
      artifactContract: artifactContract.state,
      artifactContractReason: artifactContract.reason,
    },
    frozenReviewBundle,
    gateResultPath: input.gateResultPath,
    markdownReportPath: input.markdownReportPath,
  };
}

function classifyArtifactContract(lane: SourceLaneSummary | null): {
  state: KimiReplayComparisonReport["scoring"]["artifactContract"];
  reason: string;
} {
  if (lane === null) {
    return {
      state: "missing",
      reason: "No structured Kimi artifact was produced.",
    };
  }
  if (!isOkParseStatus(lane.parseStatus)) {
    return {
      state: "malformed",
      reason: `Kimi structured artifact parse status is ${lane.parseStatus}.`,
    };
  }
  return {
    state: "complete",
    reason: `Kimi structured artifact parse status is ${lane.parseStatus}.`,
  };
}

function isOkParseStatus(
  parseStatus: StructuredReviewParseStatus,
): parseStatus is "synthesized_from_markdown" {
  return parseStatus === "synthesized_from_markdown";
}

function summarizeFrozenReviewBundleUse(
  sourceLanes: readonly SourceLaneSummary[],
  kimiLane: SourceLaneSummary | null,
): KimiReplayComparisonReport["frozenReviewBundle"] {
  const sourceHashCount = sourceLanes.filter(
    (lane) => lane.reviewBundleCanonicalHash !== null,
  ).length;
  const sourceHashes = uniqueSorted(
    sourceLanes.flatMap((lane) =>
      lane.reviewBundleCanonicalHash === null
        ? []
        : [lane.reviewBundleCanonicalHash],
    ),
  );
  const canonicalHash =
    sourceHashCount === sourceLanes.length && sourceHashes.length === 1
      ? (sourceHashes[0] ?? null)
      : null;
  const sourceHashStatus =
    sourceHashes.length === 0
      ? "absent"
      : sourceHashCount !== sourceLanes.length
        ? "partial"
        : sourceHashes.length === 1
          ? "consistent"
          : "divergent";
  const kimiReplayBundleHash = kimiLane?.reviewBundleCanonicalHash ?? null;
  const kimiReplayBundleHashMatchesSource =
    canonicalHash === null || kimiReplayBundleHash === null
      ? null
      : kimiReplayBundleHash === canonicalHash;
  return {
    canonicalHash,
    sourceHashStatus,
    sourceHashes,
    kimiReplayBundleHash,
    sourceInputsPinnedByKimiReplay: false,
    kimiReplayBundleHashMatchesSource,
    usedByKimiReplay: kimiReplayBundleHashMatchesSource === true,
  };
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
    "  --kimi-bin PATH          explicit Kimi CLI path",
    "  --kimi-model MODEL       Kimi model alias (default: Kimi CLI config)",
    "",
    "This diagnostic no longer executes fresh replay runs because the local review lane launcher was removed.",
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
  try {
    const report = await runKimiCouncilReplay(parsed);
    io.stdout(`${JSON.stringify(report, null, 2)}\n`);
    return report.scoring.artifactContract === "complete" ? 0 : 1;
  } catch (error) {
    io.stderr(
      `symphony-kimi-council-replay failed: ${error instanceof Error ? error.message : String(error)}\n`,
    );
    return 1;
  }
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
