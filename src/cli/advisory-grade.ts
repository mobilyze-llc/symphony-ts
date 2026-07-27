#!/usr/bin/env node

import { realpathSync } from "node:fs";
import { hostname } from "node:os";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import type { StructuralAdvisory } from "../domain/structural-advisory.js";
import {
  type JournalCliStructuralAdvisoryGradeInput,
  type JournalCliStructuralAdvisoryGradeResult,
  journalCliStructuralAdvisoryGrade,
} from "../logging/structural-advisory-cli-journal.js";
import type { StructuralAdvisoryGradeDecision } from "../orchestrator/structural-advisory-journal.js";

// symphony-advisory-grade (SYMPH-1140) — the PRIMARY grade path: an interactive
// session agent records its structural-advisory decision at decision time,
// straight through the existing dispatcher run-journal writer, tagged
// source=cli-session with actor attribution. `symphonyctl grade-advisory`
// remains the manual escape hatch, not this channel.

export const ADVISORY_GRADE_EXIT = {
  ok: 0,
  usage: 1,
  conflict: 2,
  failed: 5,
} as const;

const GRADE_DECISIONS: readonly StructuralAdvisoryGradeDecision[] = [
  "accept",
  "partial",
  "reject",
];

interface AdvisoryGradeCliOptions {
  members: string[];
  root: string | null;
  decision: StructuralAdvisoryGradeDecision | null;
  acceptedIdentifiers: string[];
  reason: string | null;
  actorHost: string | null;
  actorSession: string | null;
  journalRoot: string | null;
  help: boolean;
}

export interface AdvisoryGradeCliDependencies {
  io?: { stdout(message: string): void; stderr(message: string): void };
  /** Defaults to writing the dispatcher run journal; injected in tests. */
  journalGrade?: (
    input: JournalCliStructuralAdvisoryGradeInput,
  ) => Promise<JournalCliStructuralAdvisoryGradeResult>;
  cwd?: string;
  hostname?: string;
  now?: () => Date;
}

class AdvisoryGradeCliUsageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AdvisoryGradeCliUsageError";
  }
}

function splitCsv(value: string): string[] {
  return value
    .split(",")
    .map((item) => item.trim())
    .filter((item) => item.length > 0);
}

function parseAdvisoryGradeCliArgs(
  argv: readonly string[],
): AdvisoryGradeCliOptions {
  const members: string[] = [];
  let root: string | null = null;
  let decision: StructuralAdvisoryGradeDecision | null = null;
  const acceptedIdentifiers: string[] = [];
  let reason: string | null = null;
  let actorHost: string | null = null;
  let actorSession: string | null = null;
  let journalRoot: string | null = null;
  let help = false;

  const readValue = (argv2: readonly string[], index: number, flag: string) => {
    const value = argv2[index];
    if (value === undefined || value.startsWith("--")) {
      throw new AdvisoryGradeCliUsageError(`Missing value for ${flag}.`);
    }
    return value;
  };

  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === undefined) continue;
    if (token === "--help" || token === "-h") {
      help = true;
      continue;
    }
    switch (token) {
      case "--members":
        members.push(...splitCsv(readValue(argv, ++index, "--members")));
        break;
      case "--root":
        root = readValue(argv, ++index, "--root");
        break;
      case "--decision": {
        const value = readValue(argv, ++index, "--decision");
        if (!(GRADE_DECISIONS as readonly string[]).includes(value)) {
          throw new AdvisoryGradeCliUsageError(
            `--decision must be one of ${GRADE_DECISIONS.join(", ")}.`,
          );
        }
        decision = value as StructuralAdvisoryGradeDecision;
        break;
      }
      case "--accepted":
        acceptedIdentifiers.push(
          ...splitCsv(readValue(argv, ++index, "--accepted")),
        );
        break;
      case "--reason":
        reason = readValue(argv, ++index, "--reason");
        break;
      case "--actor-host":
        actorHost = readValue(argv, ++index, "--actor-host");
        break;
      case "--actor-session":
        actorSession = readValue(argv, ++index, "--actor-session");
        break;
      case "--journal-root":
        journalRoot = readValue(argv, ++index, "--journal-root");
        break;
      default:
        throw new AdvisoryGradeCliUsageError(`Unknown CLI argument: ${token}`);
    }
  }

  return {
    members,
    root,
    decision,
    acceptedIdentifiers,
    reason,
    actorHost,
    actorSession,
    journalRoot,
    help,
  };
}

function renderAdvisoryGradeUsage(): string {
  return [
    "Usage: symphony-advisory-grade --members <id,id,...> --root <hypothesis> --decision <accept|partial|reject> [options]",
    "",
    "Record an interactive session agent's structural-advisory grade at decision",
    "time, straight through the existing dispatcher run-journal writer (source",
    "cli-session). This is the PRIMARY grade path; symphonyctl grade-advisory is",
    "the manual escape hatch. The member set + root hypothesis reproduce the",
    "existing structural-advisory fingerprint identity — pass the same values the",
    "advisory was journaled with.",
    "",
    "Required:",
    "  --members <id,id,...>        Advisory member issue identifiers",
    "  --root <hypothesis>          Root-cause hypothesis text (fingerprint input)",
    "  --decision <decision>        accept, partial, or reject",
    "",
    "Options:",
    "  --accepted <id,id,...>       Accepted subset (required for a partial grade)",
    "  --reason <text>              Human rationale recorded with the grade",
    "  --actor-host <host>          Actor host (defaults to this machine's hostname)",
    "  --actor-session <id>         Session discriminator for the interactive actor",
    "  --journal-root <path>        Run-journal root (defaults to the working directory)",
    "  --help                       Show this help text",
  ].join("\n");
}

export async function runAdvisoryGradeCli(
  argv: readonly string[],
  dependencies: AdvisoryGradeCliDependencies = {},
): Promise<number> {
  const io = dependencies.io ?? {
    stdout: (message: string) => process.stdout.write(message),
    stderr: (message: string) => process.stderr.write(message),
  };

  let options: AdvisoryGradeCliOptions;
  try {
    options = parseAdvisoryGradeCliArgs(argv);
  } catch (error) {
    io.stderr(`${formatError(error)}\n${renderAdvisoryGradeUsage()}`);
    return ADVISORY_GRADE_EXIT.usage;
  }

  if (options.help) {
    io.stdout(`${renderAdvisoryGradeUsage()}\n`);
    return ADVISORY_GRADE_EXIT.ok;
  }

  if (options.members.length === 0) {
    io.stderr(`--members is required.\n${renderAdvisoryGradeUsage()}`);
    return ADVISORY_GRADE_EXIT.usage;
  }
  if (options.root === null || options.root.trim() === "") {
    io.stderr(`--root is required.\n${renderAdvisoryGradeUsage()}`);
    return ADVISORY_GRADE_EXIT.usage;
  }
  if (options.decision === null) {
    io.stderr(`--decision is required.\n${renderAdvisoryGradeUsage()}`);
    return ADVISORY_GRADE_EXIT.usage;
  }
  if (
    options.decision === "partial" &&
    options.acceptedIdentifiers.length === 0
  ) {
    io.stderr(
      `A partial grade requires --accepted <id,id>.\n${renderAdvisoryGradeUsage()}`,
    );
    return ADVISORY_GRADE_EXIT.usage;
  }
  const memberIdentifiers = new Set(options.members);
  const acceptedIdentifiers = new Set(options.acceptedIdentifiers);
  if (
    options.decision === "partial" &&
    [...acceptedIdentifiers].some(
      (identifier) => !memberIdentifiers.has(identifier),
    )
  ) {
    io.stderr(
      `Every --accepted identifier must belong to --members.\n${renderAdvisoryGradeUsage()}`,
    );
    return ADVISORY_GRADE_EXIT.usage;
  }
  if (
    options.decision === "partial" &&
    acceptedIdentifiers.size >= memberIdentifiers.size
  ) {
    io.stderr(
      `A partial grade requires --accepted to be a proper subset of --members.\n${renderAdvisoryGradeUsage()}`,
    );
    return ADVISORY_GRADE_EXIT.usage;
  }
  if (
    options.decision !== "partial" &&
    options.acceptedIdentifiers.length > 0
  ) {
    io.stderr(
      `--accepted is valid only for a partial grade.\n${renderAdvisoryGradeUsage()}`,
    );
    return ADVISORY_GRADE_EXIT.usage;
  }

  const journalRoot = resolve(
    dependencies.cwd ?? process.cwd(),
    options.journalRoot === null || options.journalRoot.trim() === ""
      ? "."
      : options.journalRoot.trim(),
  );
  const advisory: StructuralAdvisory = {
    memberIssueIdentifiers: options.members,
    rootCauseHypothesis: options.root,
    // Only the fingerprint identity (members + root) is read for grading; the
    // remaining advisory fields are inert placeholders here.
    structuralFix: "(graded via symphony-advisory-grade)",
    confidenceNote: "(graded via symphony-advisory-grade)",
  };
  const actorHost = options.actorHost ?? dependencies.hostname ?? hostname();

  const journalGrade =
    dependencies.journalGrade ?? journalCliStructuralAdvisoryGrade;
  try {
    const result = await journalGrade({
      root: journalRoot,
      advisory,
      decision: options.decision,
      acceptedIdentifiers: options.acceptedIdentifiers,
      actor: {
        kind: "interactive-agent",
        host: actorHost,
        ...(options.actorSession === null
          ? {}
          : { session: options.actorSession }),
      },
      reason: options.reason ?? "structural advisory grade via session agent",
      source: "cli-session",
      ...(dependencies.now === undefined ? {} : { now: dependencies.now }),
    });
    if (result.status === "conflict") {
      io.stdout(
        `Advisory ${result.entry.metadata.advisory_id} already graded (seq ${result.entry.sequence}); first decision is immutable.\n`,
      );
      return ADVISORY_GRADE_EXIT.conflict;
    }
    io.stdout(
      `Journaled ${options.decision} grade for advisory ${result.entry.metadata.advisory_id} as cli-session evidence (seq ${result.entry.sequence}) to ${journalRoot}.\n`,
    );
    return ADVISORY_GRADE_EXIT.ok;
  } catch (error) {
    io.stderr(`Failed to journal advisory grade: ${formatError(error)}\n`);
    return ADVISORY_GRADE_EXIT.failed;
  }
}

function shouldRunAsCli(moduleUrl: string, argv1?: string): boolean {
  if (argv1 === undefined) {
    return false;
  }
  try {
    return realpathSync(argv1) === realpathSync(fileURLToPath(moduleUrl));
  } catch {
    return false;
  }
}

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

if (shouldRunAsCli(import.meta.url, process.argv[1])) {
  const exitCode = await runAdvisoryGradeCli(process.argv.slice(2));
  process.exitCode = exitCode;
}
