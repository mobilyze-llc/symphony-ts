import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

import {
  type ConvergenceDecisionResult,
  type CouncilTriageResult,
  type CrossExamSelectResult,
  convergenceDecisionResultSchema,
  councilTriageResultSchema,
  crossExamSelectResultSchema,
} from "./schemas.js";

/**
 * Fail-closed TypeScript client for crucible's deterministic crabbox-council spine
 * subcommands. Confines the entrypoint path and argv shape to a single seam
 * (SYMPH-908 / KTD1) so the sanctioned narrow CLI (SYMPH-909) is a one-line swap.
 *
 * Every call validates the subcommand's versioned JSON output against its schema;
 * any spawn failure, non-zero exit, malformed JSON, or schema mismatch throws
 * `SpineUnavailableError` — the gate must treat this as a degraded review, never a
 * silent pass.
 */

const DEFAULT_SPINE_PATH = join(
  homedir(),
  "projects/crucible/skills/session-orchestrator/scripts/production-rollout.mjs",
);
const DEFAULT_TIMEOUT_MS = 60_000;

export class SpineUnavailableError extends Error {
  readonly subcommand: string;
  constructor(
    subcommand: string,
    message: string,
    options?: { cause?: unknown },
  ) {
    super(
      `crabbox review spine [${subcommand}]: ${message}`,
      options?.cause !== undefined ? { cause: options.cause } : undefined,
    );
    this.name = "SpineUnavailableError";
    this.subcommand = subcommand;
  }
}

export interface SpineCommandResult {
  stdout: string;
  stderr: string;
  exitCode: number | null;
}

export type SpineCommandRunner = (
  argv: readonly string[],
  options: { timeoutMs: number; env: NodeJS.ProcessEnv },
) => Promise<SpineCommandResult>;

export interface SpineClientConfig {
  /** Path to the spine entrypoint (crucible production-rollout.mjs or the SYMPH-909 narrow CLI). */
  spinePath?: string;
  timeoutMs?: number;
  env?: NodeJS.ProcessEnv;
  /** Injectable runner for tests; defaults to a real `execFile` spawn. */
  runCommand?: SpineCommandRunner;
}

export interface CouncilTriageInput {
  /** Reviewer lane markdown artifacts, paired with their reviewer label, in order. */
  reviews: ReadonlyArray<{ file: string; reviewer: string }>;
}

export interface CrossExamSelectInput {
  triageFile: string;
  currentDiffHash: string;
  /** Omitted from argv when undefined — the spine rejects the literal string "null". */
  priorDiffHash?: string;
  /** Omitted from argv when undefined — the spine rejects the literal string "null". */
  fixSizeLines?: number;
}

export interface ConvergenceDecisionInput {
  roundsFile: string;
  n?: number;
  k?: number;
  maxRounds?: number;
}

export class CrabboxSpineClient {
  private readonly spinePath: string;
  private readonly timeoutMs: number;
  private readonly env: NodeJS.ProcessEnv;
  private readonly runCommand: SpineCommandRunner;

  constructor(config: SpineClientConfig = {}) {
    const env = config.env ?? process.env;
    this.env = env;
    this.spinePath =
      config.spinePath ?? env.SYMPHONY_REVIEW_SPINE_PATH ?? DEFAULT_SPINE_PATH;
    this.timeoutMs = config.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.runCommand = config.runCommand ?? defaultSpineCommandRunner;
  }

  /**
   * SYMPH-908 — crucible's MOB-348 reviewer-artifact contract is the SINGLE binding
   * source, and this `council-triage` subcommand is the parser of record. The
   * reviewer markdown each `--review-file` points at MUST conform to MOB-348:
   * `## Verdict` ∈ {PASS, CHANGES_REQUESTED, BLOCKED} and `## Findings` bullets
   * `- [P1|P2|P3|Track] <file:line> — <summary>` with optional indented
   * `evidence:`/`failure:`/`test:`. Crucible's `parseReviewerVerdict` recognizes ONLY
   * those three tokens; an unrecognized token (e.g. the retired Symphony-only
   * `FINDINGS`) yields verdict=null → `parse_quality: "partial"` → `fail_open: true`,
   * which silently misleads the operator. Symphony therefore normalizes any inbound
   * legacy `FINDINGS` artifact to `CHANGES_REQUESTED` BEFORE writing the file passed
   * here (see `persistContractArtifact` / `normalizeLegacyFindingsVerdict` in
   * headless-council-gate.ts). Symphony conforms to this contract; it does not fork it.
   */
  async councilTriage(input: CouncilTriageInput): Promise<CouncilTriageResult> {
    if (input.reviews.length === 0) {
      throw new SpineUnavailableError(
        "council-triage",
        "no reviewer artifacts supplied",
      );
    }
    const args: string[] = [];
    for (const review of input.reviews) {
      args.push("--review-file", review.file, "--reviewer", review.reviewer);
    }
    return this.run("council-triage", args, councilTriageResultSchema.parse);
  }

  async crossExamSelect(
    input: CrossExamSelectInput,
  ): Promise<CrossExamSelectResult> {
    const args = ["--triage-file", input.triageFile];
    args.push("--current-diff-hash", input.currentDiffHash);
    // The spine CLI rejects the literal string "null"; unknown optionals must be
    // OMITTED, not passed as null (verified 2026-06-23).
    if (input.priorDiffHash !== undefined) {
      args.push("--prior-diff-hash", input.priorDiffHash);
    }
    if (input.fixSizeLines !== undefined) {
      args.push("--fix-size-lines", String(input.fixSizeLines));
    }
    return this.run(
      "cross-exam-select",
      args,
      crossExamSelectResultSchema.parse,
    );
  }

  async convergenceDecision(
    input: ConvergenceDecisionInput,
  ): Promise<ConvergenceDecisionResult> {
    const args = ["--rounds-file", input.roundsFile];
    if (input.n !== undefined) {
      args.push("--n", String(input.n));
    }
    if (input.k !== undefined) {
      args.push("--k", String(input.k));
    }
    if (input.maxRounds !== undefined) {
      args.push("--max-rounds", String(input.maxRounds));
    }
    return this.run(
      "convergence-decision",
      args,
      convergenceDecisionResultSchema.parse,
    );
  }

  /**
   * Fail-closed reachability check: pipe a canned PASS artifact through
   * `council-triage` and confirm the schema parses. Call at gate start so a missing
   * or broken spine fails before any reviewer lane is dispatched.
   */
  async preflight(): Promise<void> {
    let dir: string | null = null;
    try {
      dir = await mkdtemp(join(tmpdir(), "symphony-spine-preflight-"));
      const file = join(dir, "preflight.md");
      await writeFile(file, "## Verdict\nPASS\n\n## Findings\nNone\n", "utf8");
      const result = await this.councilTriage({
        reviews: [{ file, reviewer: "preflight" }],
      });
      if (result.lanes.length !== 1) {
        throw new SpineUnavailableError(
          "preflight",
          `expected one triaged lane, got ${result.lanes.length}`,
        );
      }
    } finally {
      if (dir !== null) {
        await rm(dir, { recursive: true, force: true }).catch(() => {});
      }
    }
  }

  private async run<T>(
    subcommand: string,
    args: readonly string[],
    parse: (value: unknown) => T,
  ): Promise<T> {
    const argv = [this.spinePath, subcommand, ...args];
    let result: SpineCommandResult;
    try {
      result = await this.runCommand(argv, {
        timeoutMs: this.timeoutMs,
        env: this.env,
      });
    } catch (error) {
      throw new SpineUnavailableError(
        subcommand,
        `spawn failed: ${errorMessage(error)}`,
        { cause: error },
      );
    }
    if (result.exitCode !== 0) {
      throw new SpineUnavailableError(
        subcommand,
        `exited ${result.exitCode}: ${truncate(result.stderr || result.stdout)}`,
      );
    }
    let json: unknown;
    try {
      json = JSON.parse(result.stdout);
    } catch (error) {
      throw new SpineUnavailableError(
        subcommand,
        `output was not valid JSON: ${errorMessage(error)}`,
        { cause: error },
      );
    }
    try {
      return parse(json);
    } catch (error) {
      throw new SpineUnavailableError(
        subcommand,
        `output did not match the expected schema (contract drift?): ${errorMessage(error)}`,
        { cause: error },
      );
    }
  }
}

function defaultSpineCommandRunner(
  argv: readonly string[],
  options: { timeoutMs: number; env: NodeJS.ProcessEnv },
): Promise<SpineCommandResult> {
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

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function truncate(text: string, max = 500): string {
  const trimmed = text.trim();
  return trimmed.length > max ? `${trimmed.slice(0, max)}…` : trimmed;
}
