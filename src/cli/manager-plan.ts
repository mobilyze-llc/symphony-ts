#!/usr/bin/env node

import { execFile } from "node:child_process";
import { realpathSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import {
  type PlannerCandidateGroundingEvidence,
  type PlannerContext,
  type PlannerInFlight,
  type PlannerRunResult,
  buildPlannerPrompt,
  createCmuxPlannerRunner,
  runTriagePlanner,
} from "../agent/triage-planner.js";
import {
  DEFAULT_CODE_GROUNDING_BASE_DIR,
  DEFAULT_CODE_GROUNDING_MATERIALIZATION_TIMEOUT_MS,
  DEFAULT_CODE_GROUNDING_MAX_CHECKOUTS_PER_REPO,
  DEFAULT_CODE_GROUNDING_TTL_MS,
  DEFAULT_LINEAR_ENDPOINT,
  DEFAULT_QUEUE_TRIAGE_COMMENT_ENRICHMENT_MAX_CANDIDATES,
  DEFAULT_QUEUE_TRIAGE_COMMENT_ENRICHMENT_MAX_COMMENTS,
  DEFAULT_QUEUE_TRIAGE_COMMENT_ENRICHMENT_MAX_COMMENT_CHARS,
  DEFAULT_QUEUE_TRIAGE_COMMENT_ENRICHMENT_MAX_COMMENT_PAGES,
  DEFAULT_QUEUE_TRIAGE_COMMENT_ENRICHMENT_MAX_TOTAL_CHARS,
} from "../config/defaults.js";
import type { Issue } from "../domain/model.js";
import {
  DEFAULT_ENVELOPE_ALLOWED_MODES,
  type PlanBatchMode,
  type PlanRiskTier,
  computeDependencyWaves,
  resolveStandingPlanEnvelope,
} from "../domain/standing-plan.js";
import type { CodeGroundingTarget } from "../orchestrator/code-grounding.js";
import { followGroundingDocs } from "../orchestrator/doc-follower.js";
import {
  type GroundingExtractionResult,
  extractGroundingEvidence,
} from "../orchestrator/grounding-extractor.js";
import { runPlanPostEmitReview } from "../orchestrator/plan-post-emit-review.js";
import {
  STANDING_PLAN_ID,
  assembleShadowPlannerContext,
  enrichPlannerContextWithComments,
} from "../orchestrator/standing-plan-shadow.js";
import {
  type RecordPlanRevisionResult,
  recordPlanRevision,
} from "../orchestrator/standing-plan-store.js";
import type {
  PlanBody,
  RotateRevisionOptions,
} from "../orchestrator/standing-plan-supersession.js";
import { partitionPortfolioEligibleIssues } from "../portfolio/eligibility.js";
import {
  type LinearIssueComment,
  type LinearProjectReference,
  LinearTrackerClient,
} from "../tracker/linear-client.js";
import { fetchLinearDocumentContent } from "../tracker/linear-documents.js";

// ---------------------------------------------------------------------------
// symphony-manager-plan (SYMPH-837) — run the Queue Triage v2 backlog Manager
// (the planner) ONE-SHOT against a team's eligible backlog and print the
// suggested batch plan. OUTPUT-ONLY: it spends one Opus pass (unless
// --prompt-only) and writes artifacts to its own temp dir, but writes NOTHING
// to Linear, the live standing-plan store, or dispatch. It reuses the exact
// planner core the live shadow tick uses; candidates come from standalone
// Linear reads, while in-flight context can come from the runtime host snapshot
// to match live shadow ticks.
// ---------------------------------------------------------------------------

/** CLI default operating-envelope concurrency ceiling (tunable via --concurrency-ceiling). */
export const DEFAULT_MANAGER_PLAN_CONCURRENCY_CEILING = 3;
export const DEFAULT_MANAGER_PLAN_MODEL = "opus";
/** Default eligible-to-start state when --state is omitted (SYMPH-867). */
export const DEFAULT_MANAGER_PLAN_STATE = "Backlog";
export const DEFAULT_MANAGER_PLAN_IN_FLIGHT_STATES = [
  "In Progress",
  "In Review",
  "Resume",
] as const;
export const MANAGER_PLAN_RUNTIME_STATE_BASE_URL_ENV =
  "SYMPHONY_MANAGER_PLAN_RUNTIME_STATE_BASE_URL";
export const MANAGER_PLAN_GITHUB_REPO_ENV = "GITHUB_REPOSITORY";
export const MANAGER_PLAN_REPO_URL_ENV = "REPO_URL";
export const MANAGER_PLAN_GROUNDING_REPO_URL_ENV =
  "SYMPHONY_MANAGER_PLAN_GROUNDING_REPO_URL";
export const MANAGER_PLAN_GROUNDING_COMMIT_ENV =
  "SYMPHONY_MANAGER_PLAN_GROUNDING_COMMIT";
export const MANAGER_PLAN_GROUNDING_REPO_SCOPE_ENV =
  "SYMPHONY_MANAGER_PLAN_GROUNDING_REPO_SCOPE";
const MANAGER_PLAN_RUNTIME_STATE_FETCH_TIMEOUT_MS = 10_000;
const MANAGER_PLAN_RECENTLY_MERGED_LIMIT = 20;
const execFileAsync = promisify(execFile);

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
  project: string | null;
  initiative: string | null;
  states: string[];
  concurrencyCeiling: number;
  risk: PlanRiskTier;
  modes: PlanBatchMode[] | null;
  model: string;
  pageSize: number | null;
  outDir: string | null;
  runtimeStateBaseUrl: string | null;
  inFlightStates: string[];
  commentEnrichment: boolean;
  ghPrContext: boolean;
  githubRepo: string | null;
  persist: boolean;
  promptOnly: boolean;
  plannerGrounding: boolean;
  plannerGroundingRepoUrl: string | null;
  plannerGroundingCommit: string | null;
  plannerGroundingRepoScope: "symphony" | "non_symphony" | null;
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
  projectSlug: string | null;
  initiative: string | null;
  activeStates: string[];
  pageSize: number | null;
}

export interface ManagerPlanProjectResolutionQuery {
  endpoint: string;
  apiKey: string | null;
  project: string;
  pageSize: number | null;
}

export interface ManagerPlanPrContextQuery {
  repo: string;
  recentlyMergedLimit: number;
}

export interface ManagerPlanPrContext {
  openPrs: PlannerContext["openPrs"];
  recentlyMerged: PlannerContext["recentlyMerged"];
}

interface ManagerPlanPersistenceSummary {
  workspaceRoot: string;
  recorded: boolean;
  revision: number;
}

export interface ManagerPlanPlannerRunnerInput {
  model: string;
  artifactDir: string;
}

export type CreateManagerPlanPlannerRunner = (
  input: ManagerPlanPlannerRunnerInput,
) => (prompt: string) => Promise<PlannerRunResult>;

export interface ManagerPlanGroundingInput {
  context: PlannerContext;
  candidates: readonly Issue[];
  env: NodeJS.ProcessEnv;
  now: () => Date;
  repoUrl: string | null;
  commitSha: string | null;
  repoScope: "symphony" | "non_symphony" | null;
}

export interface ManagerPlanGroundingResult {
  context: PlannerContext;
}

export interface ManagerPlanCliDependencies {
  env?: NodeJS.ProcessEnv;
  io?: ManagerPlanCliIo;
  /** Defaults to a standalone LinearTrackerClient; injected in tests. */
  resolveProjectSlug?: (
    query: ManagerPlanProjectResolutionQuery,
  ) => Promise<LinearProjectReference>;
  /** Defaults to GitHub CLI when --gh-pr-context is set; injected in tests. */
  loadPrContext?: (
    query: ManagerPlanPrContextQuery,
  ) => Promise<ManagerPlanPrContext>;
  /** Defaults to the standing-plan journal under the isolated artifact store. */
  persistPlanRevision?: (
    workspaceRoot: string,
    body: PlanBody,
    options: RotateRevisionOptions,
  ) => Promise<RecordPlanRevisionResult>;
  /** Defaults to a standalone LinearTrackerClient; injected in tests. */
  loadCandidates?: (query: ManagerPlanCandidateQuery) => Promise<Issue[]>;
  /** Defaults to a standalone LinearTrackerClient; injected in tests. */
  loadInFlight?: (query: ManagerPlanCandidateQuery) => Promise<Issue[]>;
  /** Defaults to GET /api/v1/state when --runtime-state-base-url / env is set. */
  loadRuntimeInFlight?: (baseUrl: string) => Promise<PlannerInFlight[]>;
  /** Defaults on the production Linear path; injected tests opt in explicitly. */
  fetchIssueComments?: (
    issueId: string,
    options: { maxPages?: number },
  ) => Promise<LinearIssueComment[]>;
  /** Defaults to the production cmux/Opus runner; injected in tests. */
  createPlannerRunner?: CreateManagerPlanPlannerRunner;
  /** Defaults to local report-only code grounding when --planner-grounding is set. */
  groundPlannerContext?: (
    input: ManagerPlanGroundingInput,
  ) => Promise<ManagerPlanGroundingResult>;
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
  let project: string | null = null;
  let initiative: string | null = null;
  const states: string[] = [];
  let concurrencyCeiling = DEFAULT_MANAGER_PLAN_CONCURRENCY_CEILING;
  let risk: PlanRiskTier = "medium";
  let modes: PlanBatchMode[] | null = null;
  let model = DEFAULT_MANAGER_PLAN_MODEL;
  let pageSize: number | null = null;
  let outDir: string | null = null;
  let runtimeStateBaseUrl: string | null = null;
  const inFlightStates: string[] = [];
  let commentEnrichment = true;
  let ghPrContext = false;
  let githubRepo: string | null = null;
  let persist = false;
  let promptOnly = false;
  let plannerGrounding = false;
  let plannerGroundingRepoUrl: string | null = null;
  let plannerGroundingCommit: string | null = null;
  let plannerGroundingRepoScope: "symphony" | "non_symphony" | null = null;
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
    if (token === "--planner-grounding") {
      plannerGrounding = true;
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
    if (token === "--no-comment-enrichment") {
      commentEnrichment = false;
      continue;
    }
    if (token === "--gh-pr-context") {
      ghPrContext = true;
      continue;
    }
    if (token === "--persist") {
      persist = true;
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
      case "--project":
        project = readValue("--project");
        break;
      case "--initiative":
        initiative = readValue("--initiative");
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
      case "--out-dir":
        outDir = readValue("--out-dir");
        break;
      case "--runtime-state-base-url":
        runtimeStateBaseUrl = readValue("--runtime-state-base-url");
        break;
      case "--github-repo":
        githubRepo = readValue("--github-repo");
        break;
      case "--planner-grounding-repo-url":
        plannerGroundingRepoUrl = readValue("--planner-grounding-repo-url");
        break;
      case "--planner-grounding-commit":
        plannerGroundingCommit = readValue("--planner-grounding-commit");
        break;
      case "--planner-grounding-repo-scope": {
        const value = readValue("--planner-grounding-repo-scope");
        if (value !== "symphony" && value !== "non_symphony") {
          throw new ManagerPlanCliUsageError(
            "--planner-grounding-repo-scope must be symphony or non_symphony",
          );
        }
        plannerGroundingRepoScope = value;
        break;
      }
      case "--in-flight-state":
        inFlightStates.push(readValue("--in-flight-state"));
        break;
      default:
        throw new ManagerPlanCliUsageError(`Unknown CLI argument: ${token}`);
    }
  }

  // Default the eligible-to-start state to Backlog when none is given (SYMPH-867).
  // An explicit --state (one or more) overrides this entirely; an explicit empty
  // value is still rejected downstream.
  if (states.length === 0) {
    states.push(DEFAULT_MANAGER_PLAN_STATE);
  }
  if (inFlightStates.length === 0) {
    inFlightStates.push(...DEFAULT_MANAGER_PLAN_IN_FLIGHT_STATES);
  }

  return {
    team,
    project,
    initiative,
    states,
    concurrencyCeiling,
    risk,
    modes,
    model,
    pageSize,
    outDir,
    runtimeStateBaseUrl,
    inFlightStates,
    commentEnrichment,
    ghPrContext,
    githubRepo,
    persist,
    promptOnly,
    plannerGrounding,
    plannerGroundingRepoUrl,
    plannerGroundingCommit,
    plannerGroundingRepoScope,
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

  // Additive scope (SYMPH-858): --team / --project / --initiative AND together;
  // at least one is required. --team-only stays exactly as before.
  const teamKeys =
    options.team !== null && options.team.trim() !== "" ? [options.team] : [];
  let projectSlug =
    options.project !== null && options.project.trim() !== ""
      ? options.project
      : null;
  const initiative =
    options.initiative !== null && options.initiative.trim() !== ""
      ? options.initiative
      : null;
  if (teamKeys.length === 0 && projectSlug === null && initiative === null) {
    io.stderr(
      `Provide at least one scope: --team <KEY>, --project <name-or-slugId>, or --initiative <name|uuid>.\n${renderUsage()}`,
    );
    return MANAGER_PLAN_EXIT.usage;
  }
  if (options.states.some((state) => state.trim() === "")) {
    io.stderr(`--state values must be non-empty.\n${renderUsage()}`);
    return MANAGER_PLAN_EXIT.usage;
  }
  if (options.outDir !== null && options.outDir.trim() === "") {
    io.stderr(`--out-dir must be non-empty.\n${renderUsage()}`);
    return MANAGER_PLAN_EXIT.usage;
  }
  if (options.githubRepo !== null && options.githubRepo.trim() === "") {
    io.stderr(`--github-repo must be non-empty.\n${renderUsage()}`);
    return MANAGER_PLAN_EXIT.usage;
  }
  if (
    options.plannerGroundingRepoUrl !== null &&
    options.plannerGroundingRepoUrl.trim() === ""
  ) {
    io.stderr(
      `--planner-grounding-repo-url must be non-empty.\n${renderUsage()}`,
    );
    return MANAGER_PLAN_EXIT.usage;
  }
  if (
    options.plannerGroundingCommit !== null &&
    options.plannerGroundingCommit.trim() === ""
  ) {
    io.stderr(
      `--planner-grounding-commit must be non-empty.\n${renderUsage()}`,
    );
    return MANAGER_PLAN_EXIT.usage;
  }
  if (options.persist && options.promptOnly) {
    io.stderr(
      `--persist cannot be combined with --prompt-only.\n${renderUsage()}`,
    );
    return MANAGER_PLAN_EXIT.usage;
  }
  const rawRuntimeStateBaseUrl =
    options.runtimeStateBaseUrl ??
    env[MANAGER_PLAN_RUNTIME_STATE_BASE_URL_ENV] ??
    null;
  const runtimeStateBaseUrl =
    rawRuntimeStateBaseUrl === null ? null : rawRuntimeStateBaseUrl.trim();
  if (runtimeStateBaseUrl !== null && runtimeStateBaseUrl === "") {
    io.stderr(`--runtime-state-base-url must be non-empty.\n${renderUsage()}`);
    return MANAGER_PLAN_EXIT.usage;
  }
  const githubRepo = options.ghPrContext
    ? resolveManagerPlanRepoSlug(options.githubRepo, env)
    : null;
  if (options.ghPrContext && githubRepo === null) {
    io.stderr(
      `--gh-pr-context requires --github-repo <OWNER/REPO> or ${MANAGER_PLAN_GITHUB_REPO_ENV}/${MANAGER_PLAN_REPO_URL_ENV}.\n${renderUsage()}`,
    );
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

  if (projectSlug !== null) {
    const resolveProjectSlug =
      dependencies.resolveProjectSlug ??
      (dependencies.loadCandidates === undefined
        ? defaultResolveProjectSlug
        : null);
    if (resolveProjectSlug !== null) {
      try {
        projectSlug = (
          await resolveProjectSlug({
            endpoint,
            apiKey,
            project: projectSlug,
            pageSize: options.pageSize,
          })
        ).slugId;
      } catch (error) {
        io.stderr(`Failed to resolve project: ${formatError(error)}\n`);
        return MANAGER_PLAN_EXIT.loadFailed;
      }
    }
  }

  const loadCandidates = dependencies.loadCandidates ?? defaultLoadCandidates;
  let candidates: Issue[];
  try {
    candidates = await loadCandidates({
      endpoint,
      apiKey,
      teamKeys,
      projectSlug,
      initiative,
      activeStates: options.states,
      pageSize: options.pageSize,
    });
  } catch (error) {
    io.stderr(`Failed to load candidates: ${formatError(error)}\n`);
    return MANAGER_PLAN_EXIT.loadFailed;
  }

  let inFlight: PlannerInFlight[] = [];
  if (runtimeStateBaseUrl !== null) {
    const loadRuntimeInFlight =
      dependencies.loadRuntimeInFlight ?? defaultLoadRuntimeInFlight;
    try {
      inFlight = await loadRuntimeInFlight(runtimeStateBaseUrl);
    } catch (error) {
      io.stderr(
        `Failed to load runtime in-flight issues: ${formatError(error)}\n`,
      );
      return MANAGER_PLAN_EXIT.loadFailed;
    }
  } else {
    const loadInFlight =
      dependencies.loadInFlight ??
      (dependencies.loadCandidates === undefined
        ? defaultLoadCandidates
        : null);
    let inFlightIssues: Issue[] = [];
    if (loadInFlight !== null) {
      try {
        inFlightIssues = await loadInFlight({
          endpoint,
          apiKey,
          teamKeys,
          projectSlug,
          initiative,
          activeStates: options.inFlightStates,
          pageSize: options.pageSize,
        });
      } catch (error) {
        io.stderr(`Failed to load in-flight issues: ${formatError(error)}\n`);
        return MANAGER_PLAN_EXIT.loadFailed;
      }
    }
    inFlight = inFlightIssues.map((issue) => ({
      issueIdentifier: issue.identifier,
      stage: issue.state,
    }));
  }

  const portfolioPartition = partitionPortfolioEligibleIssues(candidates);
  let context = assembleShadowPlannerContext({
    candidates: portfolioPartition.eligible,
    inFlight,
    envelope,
  });

  if (options.ghPrContext) {
    const repo = githubRepo;
    if (repo === null) {
      io.stderr(
        `--gh-pr-context requires --github-repo <OWNER/REPO> or ${MANAGER_PLAN_GITHUB_REPO_ENV}/${MANAGER_PLAN_REPO_URL_ENV}.\n${renderUsage()}`,
      );
      return MANAGER_PLAN_EXIT.usage;
    }
    const loadPrContext = dependencies.loadPrContext ?? defaultLoadPrContext;
    try {
      const prContext = await loadPrContext({
        repo,
        recentlyMergedLimit: MANAGER_PLAN_RECENTLY_MERGED_LIMIT,
      });
      context = {
        ...context,
        openPrs: prContext.openPrs,
        recentlyMerged: prContext.recentlyMerged,
      };
    } catch (error) {
      io.stderr(`Failed to load GitHub PR context: ${formatError(error)}\n`);
      return MANAGER_PLAN_EXIT.loadFailed;
    }
  }

  const fetchIssueComments =
    dependencies.fetchIssueComments ??
    (dependencies.loadCandidates === undefined
      ? defaultFetchIssueComments({
          endpoint,
          apiKey,
          pageSize: options.pageSize,
        })
      : null);
  if (
    options.commentEnrichment &&
    fetchIssueComments !== null &&
    context.backlog.length > 0
  ) {
    const enriched = await enrichPlannerContextWithComments({
      context,
      config: {
        enabled: true,
        maxCandidates: DEFAULT_QUEUE_TRIAGE_COMMENT_ENRICHMENT_MAX_CANDIDATES,
        maxCommentPages:
          DEFAULT_QUEUE_TRIAGE_COMMENT_ENRICHMENT_MAX_COMMENT_PAGES,
        maxComments: DEFAULT_QUEUE_TRIAGE_COMMENT_ENRICHMENT_MAX_COMMENTS,
        maxCommentChars:
          DEFAULT_QUEUE_TRIAGE_COMMENT_ENRICHMENT_MAX_COMMENT_CHARS,
        maxTotalChars: DEFAULT_QUEUE_TRIAGE_COMMENT_ENRICHMENT_MAX_TOTAL_CHARS,
      },
      fetchIssueComments,
    });
    context = enriched.context;
  }

  if (options.plannerGrounding && context.backlog.length > 0) {
    const groundPlannerContext =
      dependencies.groundPlannerContext ?? defaultGroundPlannerContext;
    try {
      const grounded = await groundPlannerContext({
        context,
        candidates: portfolioPartition.eligible,
        env,
        now,
        repoUrl:
          options.plannerGroundingRepoUrl ??
          env[MANAGER_PLAN_GROUNDING_REPO_URL_ENV] ??
          env[MANAGER_PLAN_REPO_URL_ENV] ??
          null,
        commitSha:
          options.plannerGroundingCommit ??
          env[MANAGER_PLAN_GROUNDING_COMMIT_ENV] ??
          null,
        repoScope:
          options.plannerGroundingRepoScope ??
          readManagerPlanGroundingRepoScope(env) ??
          null,
      });
      context = grounded.context;
    } catch (error) {
      io.stderr(`Failed to ground planner candidates: ${formatError(error)}\n`);
      return MANAGER_PLAN_EXIT.loadFailed;
    }
  }

  if (options.promptOnly) {
    const prompt = buildPlannerPrompt(context);
    if (options.outDir !== null) {
      try {
        await writeManagerPlanPromptArtifact(options.outDir, prompt);
      } catch (error) {
        io.stderr(`Failed to write prompt artifact: ${formatError(error)}\n`);
        return MANAGER_PLAN_EXIT.loadFailed;
      }
    }
    io.stdout(`${prompt}\n`);
    return MANAGER_PLAN_EXIT.ok;
  }

  if (context.backlog.length === 0) {
    io.stdout(
      `No eligible candidates for ${describeScope(options)} in state(s) [${options.states.join(", ")}].\nNothing to plan (the model was not invoked). Check --state against the scope's workflow state names.\n`,
    );
    return MANAGER_PLAN_EXIT.ok;
  }

  const createPlannerRunner =
    dependencies.createPlannerRunner ?? defaultCreatePlannerRunner(now);
  const artifactDir = options.outDir ?? defaultArtifactDir(now);
  const runClaude = createPlannerRunner({
    model: options.model,
    artifactDir,
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

  let persistence: ManagerPlanPersistenceSummary | null = null;
  if (options.persist) {
    const review = await runPlanPostEmitReview({
      context,
      body: result.body,
      runClaude,
    });
    const persistPlanRevision =
      dependencies.persistPlanRevision ?? recordPlanRevision;
    const persistRoot = join(artifactDir, "manager-plan-store");
    try {
      const record = await persistPlanRevision(persistRoot, result.body, {
        createdAt: now().toISOString(),
        planId: STANDING_PLAN_ID,
        findings: review.findings,
      });
      persistence = {
        workspaceRoot: persistRoot,
        recorded: record.recorded,
        revision: record.plan.revision,
      };
    } catch (error) {
      io.stderr(`Failed to persist plan revision: ${formatError(error)}\n`);
      return MANAGER_PLAN_EXIT.loadFailed;
    }
  }

  io.stdout(
    options.json
      ? `${renderPlanJson(options, portfolioPartition.eligible.length, result.body, portfolioPartition.held.length, persistence)}\n`
      : `${renderPlanHuman(options, portfolioPartition.eligible.length, result.body, portfolioPartition.held.length, persistence)}\n`,
  );
  return MANAGER_PLAN_EXIT.ok;
}

/** Human-readable descriptor of the active additive scope (SYMPH-858). */
function describeScope(options: ManagerPlanCliOptions): string {
  const parts: string[] = [];
  if (options.team !== null && options.team.trim() !== "") {
    parts.push(`team ${options.team}`);
  }
  if (options.project !== null && options.project.trim() !== "") {
    parts.push(`project ${options.project}`);
  }
  if (options.initiative !== null && options.initiative.trim() !== "") {
    parts.push(`initiative ${options.initiative}`);
  }
  return parts.join(" + ");
}

function renderPlanJson(
  options: ManagerPlanCliOptions,
  candidateCount: number,
  body: PlanBody,
  portfolioHeldCount = 0,
  persistence: ManagerPlanPersistenceSummary | null = null,
): string {
  return JSON.stringify(
    {
      team: options.team,
      project: options.project,
      initiative: options.initiative,
      states: options.states,
      candidateCount,
      portfolioHeldCount,
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
      persistence,
    },
    null,
    2,
  );
}

function renderPlanHuman(
  options: ManagerPlanCliOptions,
  candidateCount: number,
  body: PlanBody,
  portfolioHeldCount = 0,
  persistence: ManagerPlanPersistenceSummary | null = null,
): string {
  const lines: string[] = [];
  lines.push(
    `Manager plan — ${describeScope(options)}, state(s) [${options.states.join(", ")}], ${candidateCount} candidate(s)`,
  );
  if (portfolioHeldCount > 0) {
    lines.push(
      `Portfolio classification held ${portfolioHeldCount} candidate(s) before planning.`,
    );
  }
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
  if (persistence !== null) {
    lines.push("");
    lines.push(
      `Persisted revision ${persistence.revision} (${persistence.recorded ? "recorded" : "unchanged"}) to ${persistence.workspaceRoot}.`,
    );
  }
  return lines.join("\n");
}

async function defaultResolveProjectSlug(
  query: ManagerPlanProjectResolutionQuery,
): Promise<LinearProjectReference> {
  const client = new LinearTrackerClient({
    endpoint: query.endpoint,
    apiKey: query.apiKey,
    projectSlug: null,
    teamKeys: [],
    activeStates: [],
    ...(query.pageSize === null ? {} : { pageSize: query.pageSize }),
  });
  return client.resolveProjectSlug(query.project);
}

async function defaultLoadCandidates(
  query: ManagerPlanCandidateQuery,
): Promise<Issue[]> {
  const client = new LinearTrackerClient({
    endpoint: query.endpoint,
    apiKey: query.apiKey,
    projectSlug: query.projectSlug,
    teamKeys: query.teamKeys,
    activeStates: query.activeStates,
    ...(query.pageSize === null ? {} : { pageSize: query.pageSize }),
  });
  // fetchCandidateIssuesByScope composes its own filter from this scope arg; the
  // constructor's projectSlug/teamKeys are inert for this path (only activeStates
  // and pageSize are read from the client), so the scope is the single source of
  // truth for what gets queried.
  return client.fetchCandidateIssuesByScope({
    teamKeys: query.teamKeys,
    projectSlug: query.projectSlug,
    initiative: query.initiative,
  });
}

async function defaultLoadRuntimeInFlight(
  baseUrl: string,
): Promise<PlannerInFlight[]> {
  const response = await fetch(`${trimTrailingSlash(baseUrl)}/api/v1/state`, {
    headers: { accept: "application/json" },
    signal: AbortSignal.timeout(MANAGER_PLAN_RUNTIME_STATE_FETCH_TIMEOUT_MS),
  });
  if (!response.ok) {
    throw new Error(`GET /api/v1/state failed with HTTP ${response.status}`);
  }
  const payload = (await response.json()) as unknown;
  return parseRuntimeInFlight(payload);
}

async function defaultLoadPrContext(
  query: ManagerPlanPrContextQuery,
): Promise<ManagerPlanPrContext> {
  const { stdout } = await execFileAsync(
    "gh",
    [
      "pr",
      "list",
      "--repo",
      query.repo,
      "--json",
      "number,title,state,mergedAt,headRefName",
      "--limit",
      "100",
      "--state",
      "all",
    ],
    {
      encoding: "utf8",
      maxBuffer: 2 * 1024 * 1024,
      timeout: 15_000,
    },
  );
  return parseGhPrContext(String(stdout), query.recentlyMergedLimit);
}

interface GhPrListItem {
  number?: unknown;
  title?: unknown;
  state?: unknown;
  mergedAt?: unknown;
  headRefName?: unknown;
}

function parseGhPrContext(
  stdout: string,
  recentlyMergedLimit: number,
): ManagerPlanPrContext {
  const parsed = JSON.parse(stdout) as unknown;
  if (!Array.isArray(parsed)) {
    throw new Error("gh pr list returned a non-array JSON payload.");
  }

  const openPrs: PlannerContext["openPrs"] = [];
  const merged: Array<
    PlannerContext["recentlyMerged"][number] & { mergedAt: string }
  > = [];
  for (const item of parsed) {
    const pr = item as GhPrListItem;
    if (typeof pr.number !== "number" || !Number.isInteger(pr.number)) {
      continue;
    }
    const title = typeof pr.title === "string" ? pr.title : "";
    const headRefName =
      typeof pr.headRefName === "string" ? pr.headRefName : "";
    const issueIdentifier =
      extractIssueIdentifier(`${title} ${headRefName}`) ?? `PR-${pr.number}`;
    const info = {
      issueIdentifier,
      prNumber: pr.number,
      title,
    };
    if (pr.state === "MERGED" && typeof pr.mergedAt === "string") {
      merged.push({ ...info, mergedAt: pr.mergedAt });
    } else if (pr.state === "OPEN") {
      openPrs.push(info);
    }
  }

  merged.sort((left, right) => right.mergedAt.localeCompare(left.mergedAt));
  return {
    openPrs,
    recentlyMerged: merged.slice(0, recentlyMergedLimit).map((pr) => ({
      issueIdentifier: pr.issueIdentifier,
      prNumber: pr.prNumber,
      title: pr.title,
    })),
  };
}

function extractIssueIdentifier(value: string): string | null {
  return /\b[A-Z][A-Z0-9]+-\d+\b/.exec(value)?.[0] ?? null;
}

function parseRuntimeInFlight(payload: unknown): PlannerInFlight[] {
  const record = recordOrNull(payload);
  const running = record?.running;
  if (!Array.isArray(running)) {
    throw new Error("runtime state response missing running[]");
  }
  const inFlight: PlannerInFlight[] = [];
  for (const entry of running) {
    const row = recordOrNull(entry);
    if (row === null) {
      continue;
    }
    const issueIdentifier = readRuntimeString(row.issue_identifier);
    if (issueIdentifier === null) {
      continue;
    }
    inFlight.push({
      issueIdentifier,
      stage: readRuntimeString(row.state) ?? "",
    });
  }
  return inFlight;
}

function recordOrNull(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function readRuntimeString(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const trimmed = value.trim();
  return trimmed === "" ? null : trimmed;
}

function trimTrailingSlash(value: string): string {
  return value.replace(/\/+$/, "");
}

function resolveManagerPlanRepoSlug(
  explicit: string | null,
  env: NodeJS.ProcessEnv,
): string | null {
  const raw =
    explicit !== null && explicit.trim() !== ""
      ? explicit
      : (env[MANAGER_PLAN_GITHUB_REPO_ENV] ?? env[MANAGER_PLAN_REPO_URL_ENV]);
  if (raw === undefined || raw.trim() === "") {
    return null;
  }
  const trimmed = raw.trim();
  return trimmed
    .replace(/^https?:\/\/github\.com\//, "")
    .replace(/^git@github\.com:/, "")
    .replace(/\.git$/, "")
    .replace(/\/+$/, "");
}

async function writeManagerPlanPromptArtifact(
  outDir: string,
  prompt: string,
): Promise<void> {
  await mkdir(outDir, { recursive: true });
  await writeFile(join(outDir, "manager-plan-prompt.txt"), prompt, "utf8");
}

function defaultFetchIssueComments(input: {
  endpoint: string;
  apiKey: string | null;
  pageSize: number | null;
}): (
  issueId: string,
  options: { maxPages?: number },
) => Promise<LinearIssueComment[]> {
  const client = new LinearTrackerClient({
    endpoint: input.endpoint,
    apiKey: input.apiKey,
    projectSlug: null,
    teamKeys: [],
    activeStates: [],
    ...(input.pageSize === null ? {} : { pageSize: input.pageSize }),
  });
  return (issueId, options) => client.fetchIssueComments(issueId, options);
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

async function defaultGroundPlannerContext(
  input: ManagerPlanGroundingInput,
): Promise<ManagerPlanGroundingResult> {
  const target = await resolveManagerPlanGroundingTarget(input);
  const candidatesById = new Map(
    input.candidates.map((issue) => [issue.id, issue]),
  );
  const evidenceByIssueId = new Map<
    string,
    PlannerCandidateGroundingEvidence
  >();

  for (const candidate of input.context.backlog) {
    const issue = candidatesById.get(candidate.issueId);
    if (issue === undefined) {
      continue;
    }
    const startedAt = input.now().getTime();
    const rootSources = [
      {
        id: "title",
        text: candidate.title,
      },
      {
        id: "body",
        text: candidate.description,
      },
      ...(candidate.comments ?? []).map((comment) => ({
        id: `comment:${comment.id}`,
        text: comment.body,
      })),
    ];
    const followedDocs = await followGroundingDocs({
      checkoutRoot: process.cwd(),
      candidateId: candidate.issueId,
      candidateIdentifier: candidate.issueIdentifier,
      rootSources,
      attachedDocuments: issue.documentAttachments ?? [],
      ...(input.env.LINEAR_API_KEY === undefined ||
      input.env.LINEAR_API_KEY.trim() === ""
        ? {}
        : {
            readLinearDocument: async (documentId: string) =>
              (
                await fetchLinearDocumentContent(
                  {
                    endpoint:
                      input.env.LINEAR_ENDPOINT ?? DEFAULT_LINEAR_ENDPOINT,
                    apiKey: input.env.LINEAR_API_KEY ?? "",
                    fetchFn: fetch,
                  },
                  { documentId },
                )
              )?.content ?? null,
          }),
    });
    const result = await extractGroundingEvidence({
      candidateId: candidate.issueId,
      candidateIdentifier: candidate.issueIdentifier,
      sources: [
        {
          id: "title",
          kind: "ticket_title",
          label: "ticket title",
          text: candidate.title,
        },
        {
          id: "body",
          kind: "ticket_body",
          label: "ticket body",
          text: candidate.description,
        },
        ...(candidate.comments ?? []).map((comment) => ({
          id: `comment:${comment.id}`,
          kind: "comment" as const,
          label: `comment ${comment.id}`,
          text: comment.body,
        })),
        ...followedDocs.followedDocs.map((document) => ({
          id: `document:${document.key}`,
          kind: "document" as const,
          label:
            document.title ?? `${document.kind} document ${document.reference}`,
          text: document.content,
        })),
      ],
      grounding: {
        workspaceRoot: process.cwd(),
        runId: `manager-plan-${input.now().toISOString()}`,
        config: {
          enabled: true,
          baseDir: DEFAULT_CODE_GROUNDING_BASE_DIR,
          ttlMs: DEFAULT_CODE_GROUNDING_TTL_MS,
          maxCheckoutsPerRepo: DEFAULT_CODE_GROUNDING_MAX_CHECKOUTS_PER_REPO,
          materializationTimeoutMs:
            DEFAULT_CODE_GROUNDING_MATERIALIZATION_TIMEOUT_MS,
        },
        target,
      },
    });
    evidenceByIssueId.set(
      candidate.issueId,
      toPlannerCandidateGroundingEvidence(
        result,
        Math.max(0, input.now().getTime() - startedAt),
        followedDocs.warnings,
      ),
    );
  }

  return {
    context: {
      ...input.context,
      backlog: input.context.backlog.map((candidate) => {
        const groundingEvidence = evidenceByIssueId.get(candidate.issueId);
        return {
          ...candidate,
          ...(groundingEvidence === undefined ? {} : { groundingEvidence }),
        };
      }),
    },
  };
}

async function resolveManagerPlanGroundingTarget(
  input: ManagerPlanGroundingInput,
): Promise<CodeGroundingTarget> {
  const repoUrl =
    input.repoUrl?.trim() ||
    (await readGitValue(["config", "--get", "remote.origin.url"]));
  if (repoUrl === null || repoUrl.trim() === "") {
    throw new Error(
      "planner grounding requires --planner-grounding-repo-url, SYMPHONY_MANAGER_PLAN_GROUNDING_REPO_URL, REPO_URL, or git remote.origin.url",
    );
  }
  const commitSha =
    input.commitSha?.trim() || (await readGitValue(["rev-parse", "HEAD"]));
  if (commitSha === null || commitSha.trim() === "") {
    throw new Error(
      "planner grounding requires --planner-grounding-commit, SYMPHONY_MANAGER_PLAN_GROUNDING_COMMIT, or git rev-parse HEAD",
    );
  }
  const repoScope =
    input.repoScope ?? inferManagerPlanGroundingRepoScope(repoUrl);
  return {
    repoUrl,
    commitSha,
    repoScope,
  };
}

export function toPlannerCandidateGroundingEvidence(
  result: GroundingExtractionResult,
  wallClockMs: number,
  docWarnings: readonly string[] = [],
): PlannerCandidateGroundingEvidence {
  const reportStatus = result.groundingReport?.status;
  const ungrounded = reportStatus === "ungrounded";
  return {
    status: ungrounded ? "ungrounded" : "grounded",
    reason: ungrounded
      ? "Grounding skipped because the repository is outside the v1 Symphony grounding scope."
      : null,
    digest: result.digest,
    claims: result.claims.map((claim) => ({
      id: claim.id,
      kind: claim.kind,
      text: claim.text,
      summary: claim.summary,
      status: claim.status,
      citations: claim.citations.map((citation) => ({
        path: citation.path,
        lineRange: citation.lineRange,
        matchedSpan: citation.matchedSpan,
      })),
      missing: claim.missing,
    })),
    units: result.units.map((unit) => ({
      unitId: unit.unitId,
      title: unit.title,
      wave: unit.wave,
      completionState: unit.completionState,
      rationale: unit.rationale,
    })),
    warnings: [
      ...docWarnings,
      ...result.warnings,
      ...(result.groundingReport?.warnings ?? []),
    ],
    extractorCallCount: result.extractorCallCount,
    wallClockMs,
  };
}

async function readGitValue(args: readonly string[]): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync("git", [...args], {
      cwd: process.cwd(),
    });
    const value = stdout.trim();
    return value === "" ? null : value;
  } catch {
    return null;
  }
}

function readManagerPlanGroundingRepoScope(
  env: NodeJS.ProcessEnv,
): "symphony" | "non_symphony" | null {
  const value = env[MANAGER_PLAN_GROUNDING_REPO_SCOPE_ENV];
  if (value === "symphony" || value === "non_symphony") {
    return value;
  }
  return null;
}

export function inferManagerPlanGroundingRepoScope(
  repoUrl: string,
): "symphony" | "non_symphony" {
  const normalizedRepoUrl = repoUrl.trim().replace(/\/+$/u, "");
  return /(?:^|[/:])symphony(?:-ts)?(?:\.git)?$/i.test(normalizedRepoUrl)
    ? "symphony"
    : "non_symphony";
}

function defaultArtifactDir(now: () => Date): string {
  return join(tmpdir(), `symphony-manager-plan-${stamp(now)}`);
}

function stamp(now: () => Date): string {
  return now().toISOString().replace(/[:.]/g, "-");
}

export function renderUsage(): string {
  return [
    "Usage: symphony-manager-plan (--team <KEY> | --project <name-or-slugId> | --initiative <name|uuid>)... [--state <name>...] [options]",
    "",
    "Run the Queue Triage v2 backlog Manager (planner) ONE-SHOT against the scoped",
    "eligible backlog and print the suggested batch plan. Output-only: it spends one",
    "Opus planner pass unless --prompt-only, and writes NOTHING to Linear,",
    "the live standing-plan store, or dispatch. --persist writes only to an isolated",
    "manager-plan store under this run's artifact directory.",
    "",
    "Scope (provide at least one; additive — combine them to narrow):",
    "  --team <KEY>                 Linear team key whose backlog to plan (e.g. MOB)",
    "  --project <name-or-slugId>   Linear project name or slugId to scope candidates to",
    "  --initiative <name|uuid>     Linear initiative (UUID matches by id, else by name)",
    "",
    "Options:",
    `  --state <name>               Eligible-to-start state (repeatable; default ${DEFAULT_MANAGER_PLAN_STATE})`,
    `  --concurrency-ceiling <n>    Operating-envelope ceiling (default ${DEFAULT_MANAGER_PLAN_CONCURRENCY_CEILING})`,
    "  --risk <low|medium|high>     Allowed risk tier (default medium)",
    "  --modes <csv>                Allowed batch modes (default parallel-isolated,canary-chain)",
    "  --no-canary                  Drop canary-chain from the allowed modes (no canary runners)",
    `  --model <name>               Planner model alias (default ${DEFAULT_MANAGER_PLAN_MODEL})`,
    "  --page-size <n>              Linear candidate page size",
    "  --out-dir <path>             Directory for planner artifacts and prompt-only prompt output",
    "  --runtime-state-base-url <url>",
    "                               Runtime host base URL for live in-flight issues (GET /api/v1/state)",
    "  --in-flight-state <name>     Linear fallback in-flight state (repeatable; defaults In Progress, In Review, Resume)",
    "  --no-comment-enrichment      Disable curated comment enrichment in the planner prompt",
    "  --gh-pr-context              Source open/recently merged PR context from gh",
    "  --github-repo <OWNER/REPO>   GitHub repo for --gh-pr-context",
    "  --planner-grounding          Add report-only code grounding evidence to the planner prompt",
    "  --planner-grounding-repo-url <url>",
    "                               Repository URL for planner grounding (defaults env/git remote)",
    "  --planner-grounding-commit <sha>",
    "                               Commit SHA for planner grounding (defaults env/git HEAD)",
    "  --planner-grounding-repo-scope <symphony|non_symphony>",
    "                               Explicit grounding repo scope (defaults inferred from repo URL)",
    "  --persist                    Persist the plan revision to an isolated artifact store",
    "  --prompt-only                Print the assembled planner prompt and exit (no Opus pass)",
    "  --json                       Emit the plan as JSON",
    "  --help                       Show this help text",
    "",
    "Environment:",
    "  LINEAR_API_KEY               Required (reads the backlog)",
    "  LINEAR_ENDPOINT              Optional override of the Linear GraphQL endpoint",
    `  ${MANAGER_PLAN_GITHUB_REPO_ENV}          Optional OWNER/REPO fallback for --gh-pr-context`,
    `  ${MANAGER_PLAN_REPO_URL_ENV}                  Optional Git remote URL fallback for --gh-pr-context`,
    `  ${MANAGER_PLAN_GROUNDING_REPO_URL_ENV}`,
    "                               Optional repo URL fallback for --planner-grounding",
    `  ${MANAGER_PLAN_GROUNDING_COMMIT_ENV}`,
    "                               Optional commit SHA fallback for --planner-grounding",
    `  ${MANAGER_PLAN_GROUNDING_REPO_SCOPE_ENV}`,
    "                               Optional symphony/non_symphony scope for --planner-grounding",
    `  ${MANAGER_PLAN_RUNTIME_STATE_BASE_URL_ENV}`,
    "                               Optional runtime host base URL for live in-flight issues",
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
