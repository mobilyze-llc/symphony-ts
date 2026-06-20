#!/usr/bin/env node

import { realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  type PlannerContext,
  type PlannerRunResult,
  buildPlannerPrompt,
  createCmuxPlannerRunner,
  runTriagePlanner,
} from "../agent/triage-planner.js";
import { DEFAULT_LINEAR_ENDPOINT } from "../config/defaults.js";
import type { Issue } from "../domain/model.js";
import {
  DEFAULT_ENVELOPE_ALLOWED_MODES,
  type PlanBatchMode,
  type PlanRiskTier,
  computeDependencyWaves,
  resolveStandingPlanEnvelope,
} from "../domain/standing-plan.js";
import { assembleShadowPlannerContext } from "../orchestrator/standing-plan-shadow.js";
import type { PlanBody } from "../orchestrator/standing-plan-supersession.js";
import { LinearTrackerClient } from "../tracker/linear-client.js";

// ---------------------------------------------------------------------------
// symphony-manager-plan (SYMPH-837) — run the Queue Triage v2 backlog Manager
// (the planner) ONE-SHOT against a team's eligible backlog and print the
// suggested batch plan. OUTPUT-ONLY: it spends one Opus pass (unless
// --prompt-only) and writes artifacts to its own temp dir, but writes NOTHING
// to Linear, the live standing-plan store, or dispatch. It reuses the exact
// planner core the live shadow tick uses; only the candidate SOURCE is a
// standalone LinearTrackerClient instead of the orchestrator's.
// ---------------------------------------------------------------------------

/** CLI default operating-envelope concurrency ceiling (tunable via --concurrency-ceiling). */
export const DEFAULT_MANAGER_PLAN_CONCURRENCY_CEILING = 3;
export const DEFAULT_MANAGER_PLAN_MODEL = "opus";

export const MANAGER_PLAN_EXIT = {
  ok: 0,
  usage: 1,
  unavailable: 3,
  invalid: 4,
  // Candidate load (network / Linear) failure — distinct from a usage error so
  // scripted callers can tell "your args were wrong" from "Linear is down".
  loadFailed: 5,
} as const;

export interface ManagerPlanCliOptions {
  team: string | null;
  states: string[];
  concurrencyCeiling: number;
  risk: PlanRiskTier;
  modes: PlanBatchMode[] | null;
  model: string;
  pageSize: number | null;
  promptOnly: boolean;
  json: boolean;
  noCanary: boolean;
  help: boolean;
}

export interface ManagerPlanCliIo {
  stdout(message: string): void;
  stderr(message: string): void;
}

/** Candidate-source query (the injectable seam keeps tests hermetic — no network). */
export interface ManagerPlanCandidateQuery {
  endpoint: string;
  apiKey: string | null;
  teamKeys: string[];
  activeStates: string[];
  pageSize: number | null;
}

export interface ManagerPlanPlannerRunnerInput {
  model: string;
  artifactDir: string;
}

export type CreateManagerPlanPlannerRunner = (
  input: ManagerPlanPlannerRunnerInput,
) => (prompt: string) => Promise<PlannerRunResult>;

export interface ManagerPlanCliDependencies {
  env?: NodeJS.ProcessEnv;
  io?: ManagerPlanCliIo;
  /** Defaults to a standalone LinearTrackerClient; injected in tests. */
  loadCandidates?: (query: ManagerPlanCandidateQuery) => Promise<Issue[]>;
  /** Defaults to the production cmux/Opus runner; injected in tests. */
  createPlannerRunner?: CreateManagerPlanPlannerRunner;
  now?: () => Date;
}

export class ManagerPlanCliUsageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ManagerPlanCliUsageError";
  }
}

export function parseManagerPlanCliArgs(
  argv: readonly string[],
): ManagerPlanCliOptions {
  let team: string | null = null;
  const states: string[] = [];
  let concurrencyCeiling = DEFAULT_MANAGER_PLAN_CONCURRENCY_CEILING;
  let risk: PlanRiskTier = "medium";
  let modes: PlanBatchMode[] | null = null;
  let model = DEFAULT_MANAGER_PLAN_MODEL;
  let pageSize: number | null = null;
  let promptOnly = false;
  let json = false;
  let noCanary = false;
  let help = false;

  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === undefined) {
      continue;
    }

    if (token === "--help" || token === "-h") {
      help = true;
      continue;
    }
    if (token === "--prompt-only") {
      promptOnly = true;
      continue;
    }
    if (token === "--json") {
      json = true;
      continue;
    }
    if (token === "--no-canary") {
      noCanary = true;
      continue;
    }

    const inline = splitInlineValue(token);
    const readValue = (flag: string): string =>
      inline !== null ? inline.value : readValueFlag(argv, ++index, flag);
    const name = inline !== null ? inline.name : token;

    switch (name) {
      case "--team":
        team = readValue("--team");
        break;
      case "--state":
        states.push(readValue("--state"));
        break;
      case "--concurrency-ceiling":
        concurrencyCeiling = parsePositiveInt(
          readValue("--concurrency-ceiling"),
          "--concurrency-ceiling",
        );
        break;
      case "--risk":
        risk = readValue("--risk") as PlanRiskTier;
        break;
      case "--modes":
        modes = readValue("--modes")
          .split(",")
          .map((mode) => mode.trim())
          .filter((mode) => mode.length > 0) as PlanBatchMode[];
        break;
      case "--model":
        model = readValue("--model");
        break;
      case "--page-size":
        pageSize = parsePositiveInt(readValue("--page-size"), "--page-size");
        break;
      default:
        throw new ManagerPlanCliUsageError(`Unknown CLI argument: ${token}`);
    }
  }

  return {
    team,
    states,
    concurrencyCeiling,
    risk,
    modes,
    model,
    pageSize,
    promptOnly,
    json,
    noCanary,
    help,
  };
}

export async function runManagerPlanCli(
  argv: readonly string[],
  dependencies: ManagerPlanCliDependencies = {},
): Promise<number> {
  const env = dependencies.env ?? process.env;
  const io = dependencies.io ?? {
    stdout: (message: string) => process.stdout.write(message),
    stderr: (message: string) => process.stderr.write(message),
  };
  const now = dependencies.now ?? (() => new Date());

  let options: ManagerPlanCliOptions;
  try {
    options = parseManagerPlanCliArgs(argv);
  } catch (error) {
    io.stderr(`${formatError(error)}\n${renderUsage()}`);
    return MANAGER_PLAN_EXIT.usage;
  }

  if (options.help) {
    io.stdout(renderUsage());
    return MANAGER_PLAN_EXIT.ok;
  }

  if (options.team === null || options.team.trim() === "") {
    io.stderr(`Missing required --team <KEY>.\n${renderUsage()}`);
    return MANAGER_PLAN_EXIT.usage;
  }
  if (options.states.length === 0) {
    io.stderr(
      `Missing required --state <name> (the eligible-to-start state, e.g. "Backlog" or "Todo"). Repeatable.\n${renderUsage()}`,
    );
    return MANAGER_PLAN_EXIT.usage;
  }
  if (options.states.some((state) => state.trim() === "")) {
    io.stderr(`--state values must be non-empty.\n${renderUsage()}`);
    return MANAGER_PLAN_EXIT.usage;
  }

  let envelope: PlannerContext["envelope"];
  try {
    // --no-canary drops canary-chain from the resolved modes (composes with
    // --modes; stays correct if shared-surface ever turns on). An empty result
    // (e.g. --modes canary-chain --no-canary) fails envelope resolution below.
    const allowedModes = options.noCanary
      ? (options.modes ?? [...DEFAULT_ENVELOPE_ALLOWED_MODES]).filter(
          (mode) => mode !== "canary-chain",
        )
      : options.modes;
    envelope = resolveStandingPlanEnvelope({
      concurrencyCeiling: options.concurrencyCeiling,
      allowedRisk: options.risk,
      ...(allowedModes === null ? {} : { allowedModes }),
    });
  } catch (error) {
    io.stderr(`Invalid envelope: ${formatError(error)}\n`);
    return MANAGER_PLAN_EXIT.usage;
  }

  const endpoint = env.LINEAR_ENDPOINT ?? DEFAULT_LINEAR_ENDPOINT;
  const apiKey = env.LINEAR_API_KEY ?? null;
  if (
    dependencies.loadCandidates === undefined &&
    (apiKey === null || apiKey.trim() === "")
  ) {
    io.stderr(
      "Missing LINEAR_API_KEY in the environment (required to read the backlog).\n",
    );
    return MANAGER_PLAN_EXIT.usage;
  }

  const loadCandidates = dependencies.loadCandidates ?? defaultLoadCandidates;
  let candidates: Issue[];
  try {
    candidates = await loadCandidates({
      endpoint,
      apiKey,
      teamKeys: [options.team],
      activeStates: options.states,
      pageSize: options.pageSize,
    });
  } catch (error) {
    io.stderr(`Failed to load candidates: ${formatError(error)}\n`);
    return MANAGER_PLAN_EXIT.loadFailed;
  }

  const context = assembleShadowPlannerContext({
    candidates,
    inFlight: [],
    envelope,
  });

  if (options.promptOnly) {
    io.stdout(`${buildPlannerPrompt(context)}\n`);
    return MANAGER_PLAN_EXIT.ok;
  }

  if (context.backlog.length === 0) {
    io.stdout(
      `No eligible candidates for team ${options.team} in state(s) [${options.states.join(", ")}].\nNothing to plan (the model was not invoked). Check --state against the team's workflow state names.\n`,
    );
    return MANAGER_PLAN_EXIT.ok;
  }

  const createPlannerRunner =
    dependencies.createPlannerRunner ?? defaultCreatePlannerRunner(now);
  const runClaude = createPlannerRunner({
    model: options.model,
    artifactDir: defaultArtifactDir(now),
  });

  const result = await runTriagePlanner(context, { runClaude });

  if (result.status === "unavailable") {
    io.stderr(
      `Planner unavailable (degraded — the live pipeline would fall back to the comparator): ${result.detail}\n`,
    );
    return MANAGER_PLAN_EXIT.unavailable;
  }
  if (result.status === "invalid") {
    io.stderr(`Planner produced an invalid plan: ${result.detail}\n`);
    return MANAGER_PLAN_EXIT.invalid;
  }

  io.stdout(
    options.json
      ? `${renderPlanJson(options, candidates.length, result.body)}\n`
      : `${renderPlanHuman(options, candidates.length, result.body)}\n`,
  );
  return MANAGER_PLAN_EXIT.ok;
}

function renderPlanJson(
  options: ManagerPlanCliOptions,
  candidateCount: number,
  body: PlanBody,
): string {
  return JSON.stringify(
    {
      team: options.team,
      states: options.states,
      candidateCount,
      envelope: body.envelope,
      rationale: body.rationale,
      batches: body.batches,
      dependencyEdges: body.dependencyEdges,
      waves: computeDependencyWaves(
        body.batches.flatMap((batch) =>
          batch.members.map((member) => member.issueIdentifier),
        ),
        body.dependencyEdges,
      ),
      options: body.options,
    },
    null,
    2,
  );
}

function renderPlanHuman(
  options: ManagerPlanCliOptions,
  candidateCount: number,
  body: PlanBody,
): string {
  const lines: string[] = [];
  lines.push(
    `Manager plan — team ${options.team}, state(s) [${options.states.join(", ")}], ${candidateCount} candidate(s)`,
  );
  lines.push(
    `Envelope: ceiling=${body.envelope.concurrencyCeiling} risk=${body.envelope.allowedRisk} modes=[${body.envelope.allowedModes.join(", ")}]`,
  );
  lines.push("");
  lines.push(`Rationale: ${body.rationale}`);
  lines.push("");
  lines.push(`Suggested batches (${body.batches.length}):`);
  body.batches.forEach((batch, index) => {
    lines.push(
      `  [${index + 1}] ${batch.batchId}  mode=${batch.mode}  status=${batch.status}`,
    );
    lines.push(
      `      members: ${batch.members.map((member) => member.issueIdentifier).join(", ")}`,
    );
    if (batch.canary !== null) {
      lines.push(
        `      canary head: ${batch.canary.headIssueIdentifiers.join(", ")}  contingent: ${
          batch.canary.contingentIssueIdentifiers.join(", ") || "(none)"
        }`,
      );
    }
    lines.push(`      rationale: ${batch.rationale}`);
  });
  const memberIdentifiers = body.batches.flatMap((batch) =>
    batch.members.map((member) => member.issueIdentifier),
  );
  const waves = computeDependencyWaves(memberIdentifiers, body.dependencyEdges);
  if (waves.length > 0) {
    lines.push("");
    lines.push(
      "Execution waves (run a wave's issues in parallel; later waves wait on earlier):",
    );
    const prerequisitesOf = (issueIdentifier: string): string[] =>
      body.dependencyEdges
        .filter((edge) => edge.issueIdentifier === issueIdentifier)
        .map((edge) => edge.dependsOn);
    waves.forEach((wave, index) => {
      const rendered = wave
        .map((issueIdentifier) => {
          const prerequisites = prerequisitesOf(issueIdentifier);
          return prerequisites.length > 0
            ? `${issueIdentifier} (waits on ${prerequisites.join(", ")})`
            : issueIdentifier;
        })
        .join(", ");
      lines.push(`  Wave ${index + 1}: ${rendered}`);
    });
  }
  if (body.options.length > 0) {
    lines.push("");
    lines.push("Release options:");
    for (const option of body.options) {
      lines.push(`  ${option.marker} ${option.label}`);
    }
  }
  return lines.join("\n");
}

async function defaultLoadCandidates(
  query: ManagerPlanCandidateQuery,
): Promise<Issue[]> {
  const client = new LinearTrackerClient({
    endpoint: query.endpoint,
    apiKey: query.apiKey,
    projectSlug: null,
    teamKeys: query.teamKeys,
    activeStates: query.activeStates,
    ...(query.pageSize === null ? {} : { pageSize: query.pageSize }),
  });
  return client.fetchCandidateIssues();
}

function defaultCreatePlannerRunner(
  now: () => Date,
): CreateManagerPlanPlannerRunner {
  return ({ model, artifactDir }) =>
    createCmuxPlannerRunner({
      workspace: artifactDir,
      artifactDir,
      model,
      // Unique artifact name keeps a manual run from clobbering a live
      // pipeline's standing-plan artifacts.
      artifactName: `manager-plan-${stamp(now)}`,
    });
}

function defaultArtifactDir(now: () => Date): string {
  return join(tmpdir(), `symphony-manager-plan-${stamp(now)}`);
}

function stamp(now: () => Date): string {
  return now().toISOString().replace(/[:.]/g, "-");
}

export function renderUsage(): string {
  return [
    "Usage: symphony-manager-plan --team <KEY> --state <name> [--state <name>...] [options]",
    "",
    "Run the Queue Triage v2 backlog Manager (planner) ONE-SHOT against a team's",
    "eligible backlog and print the suggested batch plan. Output-only: it spends one",
    "Opus pass (via cmux-spawn) unless --prompt-only, and writes NOTHING to Linear,",
    "the live standing-plan store, or dispatch.",
    "",
    "Required:",
    "  --team <KEY>                 Linear team key whose backlog to plan (e.g. MOB)",
    "  --state <name>               Eligible-to-start state name (repeatable, e.g. Backlog)",
    "",
    "Options:",
    `  --concurrency-ceiling <n>    Operating-envelope ceiling (default ${DEFAULT_MANAGER_PLAN_CONCURRENCY_CEILING})`,
    "  --risk <low|medium|high>     Allowed risk tier (default medium)",
    "  --modes <csv>                Allowed batch modes (default parallel-isolated,canary-chain)",
    "  --no-canary                  Drop canary-chain from the allowed modes (no canary runners)",
    `  --model <name>               Planner model alias (default ${DEFAULT_MANAGER_PLAN_MODEL})`,
    "  --page-size <n>              Linear candidate page size",
    "  --prompt-only                Print the assembled planner prompt and exit (no Opus pass)",
    "  --json                       Emit the plan as JSON",
    "  --help                       Show this help text",
    "",
    "Environment:",
    "  LINEAR_API_KEY               Required (reads the backlog)",
    "  LINEAR_ENDPOINT              Optional override of the Linear GraphQL endpoint",
    "",
  ].join("\n");
}

export function shouldRunAsCli(moduleUrl: string, argv1?: string): boolean {
  if (argv1 === undefined) {
    return false;
  }
  try {
    return realpathSync(argv1) === realpathSync(fileURLToPath(moduleUrl));
  } catch {
    return false;
  }
}

function splitInlineValue(
  token: string,
): { name: string; value: string } | null {
  if (!token.startsWith("--")) {
    return null;
  }
  const equals = token.indexOf("=");
  if (equals === -1) {
    return null;
  }
  return { name: token.slice(0, equals), value: token.slice(equals + 1) };
}

function readValueFlag(
  argv: readonly string[],
  index: number,
  flag: string,
): string {
  const value = argv[index];
  if (value === undefined || value.startsWith("--")) {
    throw new ManagerPlanCliUsageError(`Missing value for ${flag}.`);
  }
  return value;
}

function parsePositiveInt(raw: string, flag: string): number {
  // Strictly positive: reject 0 (and 0-padded forms) so the "positive integer"
  // contract holds — a --page-size of 0 would issue a Linear `first: 0` query
  // (council R1, Codex P2).
  if (!/^[1-9]\d*$/.test(raw.trim())) {
    throw new ManagerPlanCliUsageError(
      `${flag} must be a positive integer (got ${raw}).`,
    );
  }
  return Number.parseInt(raw, 10);
}

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

if (shouldRunAsCli(import.meta.url, process.argv[1])) {
  const exitCode = await runManagerPlanCli(process.argv.slice(2));
  process.exitCode = exitCode;
}
