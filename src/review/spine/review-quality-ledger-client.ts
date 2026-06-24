import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

import {
  type RqlRecordResult,
  type RqlSummaryResult,
  recordResultSchema,
  summaryResultSchema,
} from "./review-quality-ledger-schemas.js";

/**
 * Fail-closed TypeScript client for crucible's review-quality-ledger (MOB-384)
 * `record` and `summary` subcommands.
 *
 * SYMPH-924 — SEAM DECISION (consume, don't reimplement): Symphony shells into
 * crucible's `review-quality-ledger.mjs` over an absolute path, exactly as
 * `crabbox-spine-client.ts` shells into `production-rollout.mjs`. The reason is the
 * pre-dedup raiser join: crucible's `council-triage` runs `dedupeFindings` BEFORE it
 * writes the triage JSON, so a co-raised finding survives with only ONE `reviewer`
 * tag — the triage output alone cannot tell you that BOTH codex AND deepseek raised
 * a finding. The ledger's `record` recovers the full raiser set from the per-lane
 * `--review-file`/`--reviewer` pairs (its `laneRaisersFromFiles` /
 * `reviewFileLocationKeys` / `collectFindings`), keyed on the spine `fp`. That
 * fp/raiser-join logic is precisely the drift-prone surface; reimplementing it in TS
 * would fork crucible's parser-of-record and let it silently diverge. Consuming the
 * seam keeps it single-sourced. See the SYMPH-924 PR body for the full evaluation.
 *
 * INVARIANT (no vote in convergence/merge): this client is data-capture only. The
 * `record` path is invoked as a pure side-effect AFTER the review verdict is already
 * computed (see `ReviewAggregator.aggregate`), and its result is never read by the
 * decision path. Capture failures throw `RqlUnavailableError`, which the aggregator
 * SWALLOWS — a missing/broken ledger must never block or alter a merge decision.
 */

const DEFAULT_LEDGER_SCRIPT_PATH = join(
  homedir(),
  "projects/crucible/skills/session-orchestrator/scripts/review-quality-ledger.mjs",
);
/**
 * Crucible's own default ledger location. SYMPH-924: the capture path defaults to
 * crucible's canonical ledger so Symphony's rows land in the same corpus crucible's
 * `summary` reads. Overridable via config / `SYMPHONY_REVIEW_QUALITY_LEDGER`.
 */
const DEFAULT_LEDGER_FILE = join(
  homedir(),
  ".local/share/crucible/session-orchestrator/review-quality-ledger.jsonl",
);
const DEFAULT_TIMEOUT_MS = 60_000;
const DEFAULT_REVIEW_TIER = "crabbox-council";

export class RqlUnavailableError extends Error {
  readonly subcommand: string;
  constructor(
    subcommand: string,
    message: string,
    options?: { cause?: unknown },
  ) {
    super(
      `review-quality-ledger [${subcommand}]: ${message}`,
      options?.cause !== undefined ? { cause: options.cause } : undefined,
    );
    this.name = "RqlUnavailableError";
    this.subcommand = subcommand;
  }
}

export interface RqlCommandResult {
  stdout: string;
  stderr: string;
  exitCode: number | null;
}

export type RqlCommandRunner = (
  argv: readonly string[],
  options: { timeoutMs: number; env: NodeJS.ProcessEnv },
) => Promise<RqlCommandResult>;

export interface RqlClientConfig {
  /** Path to crucible's review-quality-ledger.mjs entrypoint. */
  ledgerScriptPath?: string;
  /** Path to the JSONL ledger the rows are appended to / summarized from. */
  ledgerFile?: string;
  timeoutMs?: number;
  env?: NodeJS.ProcessEnv;
  /** Injectable runner for tests; defaults to a real `execFile` spawn. */
  runCommand?: RqlCommandRunner;
}

/** One reviewer lane's markdown artifact, paired with its reviewer label. */
export interface RqlLaneArtifact {
  reviewer: string;
  /** The reviewer's `## Verdict` / `## Findings` markdown (PRE-triage-dedup). */
  markdown: string;
}

/** A captured cross-exam verdict for one fingerprint. */
export interface RqlCrossExamVerdict {
  fp: string;
  /** CONFIRM (judge confirmed real) | REFUTE (judge refuted) | EXTEND | none. */
  verdict: "CONFIRM" | "REFUTE" | "EXTEND" | "none";
}

export interface RqlRecordInput {
  /** The crucible `council-triage` JSON (post-dedup; supplies fp/severity/bucket). */
  triage: unknown;
  /** Per-lane artifacts (PRE-dedup) — the raised_by recovery source. */
  laneArtifacts: readonly RqlLaneArtifact[];
  /** Fingerprints confirmed blocking this round → classified P1/P2 by the ledger. */
  blockingFps: readonly string[];
  /** Cross-exam verdicts captured per fingerprint (optional). */
  crossExamVerdicts?: readonly RqlCrossExamVerdict[];
  runId?: string;
  /** Linear/repo PR identifier, e.g. "owner/repo#123". */
  pr?: string;
  headSha?: string;
  round?: number;
  reviewTier?: string;
}

export interface RqlSummaryFilter {
  /** Relative window, e.g. "30d", "12h". */
  since?: string;
  /** ISO lower bound. */
  from?: string;
  /** ISO upper bound. */
  to?: string;
  /** Comma-joinable PR identifiers to restrict the corpus. */
  pr?: readonly string[];
  /** Comma-joinable run ids to restrict the corpus. */
  run?: readonly string[];
}

export class ReviewQualityLedgerClient {
  private readonly ledgerScriptPath: string;
  private readonly ledgerFile: string;
  private readonly timeoutMs: number;
  private readonly env: NodeJS.ProcessEnv;
  private readonly runCommand: RqlCommandRunner;

  constructor(config: RqlClientConfig = {}) {
    const env = config.env ?? process.env;
    this.env = env;
    this.ledgerScriptPath =
      config.ledgerScriptPath ??
      env.SYMPHONY_REVIEW_QUALITY_LEDGER_PATH ??
      DEFAULT_LEDGER_SCRIPT_PATH;
    this.ledgerFile =
      config.ledgerFile ??
      env.SYMPHONY_REVIEW_QUALITY_LEDGER ??
      DEFAULT_LEDGER_FILE;
    this.timeoutMs = config.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.runCommand = config.runCommand ?? defaultRqlCommandRunner;
  }

  /**
   * Append one durable row per finding for one review round, joining the PRE-dedup
   * raiser set (recovered from `laneArtifacts`) → final disposition (P1/P2/Track/
   * Dismissed) → cross-exam verdict, keyed on the spine `fp`. Throws
   * `RqlUnavailableError` on any failure; callers in the review decision path MUST
   * swallow it (capture must never alter a merge decision).
   */
  async record(input: RqlRecordInput): Promise<RqlRecordResult> {
    let dir: string | null = null;
    try {
      dir = await mkdtemp(join(tmpdir(), "symphony-rql-record-"));
      const triageFile = join(dir, "triage.json");
      await writeFile(triageFile, JSON.stringify(input.triage), "utf8");

      const args = ["--triage-file", triageFile];
      let index = 0;
      for (const lane of input.laneArtifacts) {
        const file = join(dir, `lane-${index}-${sanitize(lane.reviewer)}.md`);
        await writeFile(file, lane.markdown, "utf8");
        args.push("--review-file", file, "--reviewer", lane.reviewer);
        index += 1;
      }

      // blocking-fps is a comma-joined csv → the confirmed-blocking set the ledger
      // classifies to P1/P2. Empty when nothing blocked this round.
      if (input.blockingFps.length > 0) {
        args.push("--blocking-fps", input.blockingFps.join(","));
      }

      if (input.crossExamVerdicts && input.crossExamVerdicts.length > 0) {
        const verdicts: Record<string, string> = {};
        for (const entry of input.crossExamVerdicts) {
          verdicts[entry.fp] = entry.verdict;
        }
        const crossExamFile = join(dir, "cross-exam.json");
        await writeFile(crossExamFile, JSON.stringify({ verdicts }), "utf8");
        args.push("--cross-exam-file", crossExamFile);
      }

      args.push("--ledger", this.ledgerFile);
      args.push("--review-tier", input.reviewTier ?? DEFAULT_REVIEW_TIER);
      if (input.runId !== undefined) {
        args.push("--run-id", input.runId);
      }
      if (input.pr !== undefined) {
        args.push("--pr", input.pr);
      }
      if (input.headSha !== undefined) {
        args.push("--head-sha", input.headSha);
      }
      if (input.round !== undefined) {
        args.push("--round", String(input.round));
      }

      return await this.run("record", args, recordResultSchema.parse);
    } finally {
      if (dir !== null) {
        await rm(dir, { recursive: true, force: true }).catch(() => {});
      }
    }
  }

  /**
   * Per-lane precision (confirmed/raised) + unique-recall over the captured corpus.
   * This is the operator-facing query (AC3); it is NOT on the review decision path,
   * so — unlike `record` — a caller may surface a thrown `RqlUnavailableError`.
   */
  async summary(filter: RqlSummaryFilter = {}): Promise<RqlSummaryResult> {
    const args = ["--ledger", this.ledgerFile, "--format", "json"];
    if (filter.since !== undefined) {
      args.push("--since", filter.since);
    }
    if (filter.from !== undefined) {
      args.push("--from", filter.from);
    }
    if (filter.to !== undefined) {
      args.push("--to", filter.to);
    }
    if (filter.pr !== undefined && filter.pr.length > 0) {
      args.push("--pr", filter.pr.join(","));
    }
    if (filter.run !== undefined && filter.run.length > 0) {
      args.push("--run", filter.run.join(","));
    }
    return this.run("summary", args, summaryResultSchema.parse);
  }

  private async run<T>(
    subcommand: string,
    args: readonly string[],
    parse: (value: unknown) => T,
  ): Promise<T> {
    const argv = [this.ledgerScriptPath, subcommand, ...args];
    let result: RqlCommandResult;
    try {
      result = await this.runCommand(argv, {
        timeoutMs: this.timeoutMs,
        env: this.env,
      });
    } catch (error) {
      throw new RqlUnavailableError(
        subcommand,
        `spawn failed: ${errorMessage(error)}`,
        { cause: error },
      );
    }
    if (result.exitCode !== 0) {
      throw new RqlUnavailableError(
        subcommand,
        `exited ${result.exitCode}: ${truncate(result.stderr || result.stdout)}`,
      );
    }
    let json: unknown;
    try {
      json = JSON.parse(result.stdout);
    } catch (error) {
      throw new RqlUnavailableError(
        subcommand,
        `output was not valid JSON: ${errorMessage(error)}`,
        { cause: error },
      );
    }
    try {
      return parse(json);
    } catch (error) {
      throw new RqlUnavailableError(
        subcommand,
        `output did not match the expected schema (contract drift?): ${errorMessage(error)}`,
        { cause: error },
      );
    }
  }
}

function defaultRqlCommandRunner(
  argv: readonly string[],
  options: { timeoutMs: number; env: NodeJS.ProcessEnv },
): Promise<RqlCommandResult> {
  return new Promise((resolve, reject) => {
    execFile(
      process.execPath,
      [...argv],
      {
        timeout: options.timeoutMs,
        env: options.env,
        maxBuffer: 64 * 1024 * 1024,
      },
      (error, stdout, stderr) => {
        if (error) {
          // execFile sets a numeric `code` only on a genuine non-zero process
          // exit. Spawn failures (ENOENT/EACCES/… → errno string code) and
          // timeout/signal kills (code null) reject so the client surfaces
          // "spawn failed: <message>" with the original error preserved as
          // `cause`, rather than a diagnostic-less "exited null".
          const code = (error as NodeJS.ErrnoException).code;
          if (typeof code === "number") {
            resolve({ stdout, stderr, exitCode: code });
            return;
          }
          reject(error);
          return;
        }
        resolve({ stdout, stderr, exitCode: 0 });
      },
    );
  });
}

function sanitize(reviewer: string): string {
  return reviewer.replace(/[^a-zA-Z0-9_-]/g, "_") || "lane";
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function truncate(text: string, max = 500): string {
  const trimmed = text.trim();
  return trimmed.length > max ? `${trimmed.slice(0, max)}…` : trimmed;
}
