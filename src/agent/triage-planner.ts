import { createHash } from "node:crypto";
import { promises as nodeFs } from "node:fs";
import { join } from "node:path";

import { z } from "zod";

import {
  type ClaudeCmuxRunnerInput,
  type ClaudeRunnerResult,
  runClaudeCmux,
} from "../claude-runner/cmux-claude-runner.js";
import {
  PLAN_BATCH_MODES,
  type PlanBatch,
  type PlanBatchMember,
  type PlanBatchMode,
  type PlanCanaryStructure,
  type PlanEnvelope,
  type PlanOptionLine,
} from "../domain/standing-plan.js";
import type { PlanBody } from "../orchestrator/standing-plan-supersession.js";

// ---------------------------------------------------------------------------
// Event-triggered planner (SYMPH-786) — the judgment layer.
//
// On a re-plan trigger, an Opus@max pass reads backlog + open PRs + recently
// merged + in-flight state, within the current envelope, and emits a
// revision-stamped lookahead of mode-tagged batches. This module owns the
// pure, testable core (prompt assembly, output parsing, plan-body construction)
// plus the orchestration over an injected model runner. The actual cmux/Opus
// invocation is the injected dependency (see createCmuxPlannerRunner), so this
// core is unit-testable without spawning a subprocess.
//
// Invariant (zero-LLM-on-dispatch, SYMPH-787): this runs ONLY on a re-plan
// trigger/heartbeat — never on the routine lane-open dispatch path.
// ---------------------------------------------------------------------------

export interface PlannerCandidate {
  issueId: string;
  issueIdentifier: string;
  title: string;
  priority: number | null;
  state: string;
}

export interface PlannerPrInfo {
  issueIdentifier: string;
  prNumber: number;
  title: string;
}

export interface PlannerInFlight {
  issueIdentifier: string;
  stage: string;
}

export interface PlannerContext {
  backlog: PlannerCandidate[];
  openPrs: PlannerPrInfo[];
  recentlyMerged: PlannerPrInfo[];
  inFlight: PlannerInFlight[];
  envelope: PlanEnvelope;
}

export const PLANNER_OUTPUT_SCHEMA = z.object({
  rationale: z.string(),
  batches: z.array(
    z.object({
      mode: z.enum(PLAN_BATCH_MODES),
      issueIdentifiers: z.array(z.string()).min(1),
      rationale: z.string(),
      canary: z
        .object({
          // A canary-chain must have a head to gate on; an empty head is a
          // permanent deadlock for the consumer (council R1, Pi P1).
          headIssueIdentifiers: z.array(z.string()).min(1),
          contingentIssueIdentifiers: z.array(z.string()),
        })
        .nullable()
        .optional(),
    }),
  ),
});

export type RawPlan = z.infer<typeof PLANNER_OUTPUT_SCHEMA>;

export type PlannerRunResult =
  | { status: "ok"; markdown: string }
  | { status: "unavailable"; detail: string };

export interface TriagePlannerDeps {
  /** Inject the model runner (cmux/Opus in prod, a fake in tests). */
  runClaude: (prompt: string) => Promise<PlannerRunResult>;
}

export type PlannerResult =
  | { status: "ok"; body: PlanBody }
  // The model/cmux is down → caller degrades gracefully to the comparator.
  | { status: "unavailable"; detail: string }
  // The model produced output we could not parse/validate.
  | { status: "invalid"; detail: string };

export function buildPlannerPrompt(context: PlannerContext): string {
  const { envelope } = context;
  const lines: string[] = [];
  lines.push(
    "You are Symphony's autonomous backlog Manager. Decide what the pipeline should work on next.",
    "Plan STRICTLY within the operating envelope. Use ONLY issue identifiers listed in the backlog.",
    "",
    "## Operating envelope",
    `- concurrency ceiling: ${envelope.concurrencyCeiling}`,
    `- allowed risk: ${envelope.allowedRisk}`,
    `- allowed modes: ${envelope.allowedModes.join(", ")}`,
    `- target lookahead depth: ~${envelope.concurrencyCeiling + 1} batches (cover every lane that could free during a re-plan).`,
    "",
    "## Backlog (eligible, priority-ordered upstream)",
  );
  if (context.backlog.length === 0) {
    lines.push("- (none)");
  } else {
    for (const candidate of context.backlog) {
      lines.push(
        `- ${candidate.issueIdentifier} [${candidate.state}, priority ${candidate.priority ?? "none"}] ${candidate.title}`,
      );
    }
  }
  lines.push("", "## In flight (immutable — do not re-plan these)");
  lines.push(
    context.inFlight.length === 0
      ? "- (none)"
      : context.inFlight
          .map((entry) => `- ${entry.issueIdentifier} (${entry.stage})`)
          .join("\n"),
  );
  lines.push("", "## Open PRs");
  lines.push(
    context.openPrs.length === 0
      ? "- (none)"
      : context.openPrs
          .map((pr) => `- ${pr.issueIdentifier} #${pr.prNumber} ${pr.title}`)
          .join("\n"),
  );
  lines.push("", "## Recently merged (context)");
  lines.push(
    context.recentlyMerged.length === 0
      ? "- (none)"
      : context.recentlyMerged
          .map((pr) => `- ${pr.issueIdentifier} #${pr.prNumber} ${pr.title}`)
          .join("\n"),
  );
  lines.push(
    "",
    "## Plan",
    "Emit your plan as a single fenced JSON object (```json … ```) with this shape:",
    "```json",
    "{",
    '  "rationale": "one-paragraph portfolio rationale",',
    '  "batches": [',
    '    { "mode": "parallel-isolated", "issueIdentifiers": ["SYMPH-1"], "rationale": "why", "canary": null }',
    "  ]",
    "}",
    "```",
    "- `mode` must be one of the allowed modes above.",
    "- `issueIdentifiers` must all come from the backlog list.",
    "- Order batches head-first (the highest-value batch first).",
    "- For `canary-chain`, set `canary` with head + contingent identifiers.",
  );
  return lines.join("\n");
}

export function parsePlannerOutput(
  markdown: string,
): { ok: true; value: RawPlan } | { ok: false; reason: string } {
  const json = extractFencedJson(markdown);
  if (json === null) {
    return { ok: false, reason: "no fenced ```json plan block found" };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch (error) {
    return {
      ok: false,
      reason: `plan JSON did not parse: ${(error as Error).message}`,
    };
  }
  const validated = PLANNER_OUTPUT_SCHEMA.safeParse(parsed);
  if (!validated.success) {
    return {
      ok: false,
      reason: `plan JSON failed schema validation: ${validated.error.message}`,
    };
  }
  return { ok: true, value: validated.data };
}

export function buildPlanBody(raw: RawPlan, context: PlannerContext): PlanBody {
  const byIdentifier = new Map(
    context.backlog.map((candidate) => [candidate.issueIdentifier, candidate]),
  );
  const allowedModes = new Set(context.envelope.allowedModes);

  const batches: PlanBatch[] = [];
  const options: PlanOptionLine[] = [];

  for (const rawBatch of raw.batches) {
    if (!allowedModes.has(rawBatch.mode)) {
      continue; // out-of-envelope mode — drop, never propose an unexecutable batch
    }
    const members = rawBatch.issueIdentifiers
      .map((identifier) => byIdentifier.get(identifier))
      .filter(
        (candidate): candidate is PlannerCandidate => candidate !== undefined,
      )
      .map((candidate) => ({
        issueId: candidate.issueId,
        issueIdentifier: candidate.issueIdentifier,
      }));
    if (members.length === 0) {
      continue; // every identifier was unknown — drop the empty batch
    }
    // Canary head/contingent must reference this batch's resolved members;
    // drop out-of-backlog refs, and drop the whole canary if no valid head
    // survives (council R1, Codex P2 + Pi P1/P2).
    const canary = normalizeCanary(rawBatch.canary ?? null, members);
    // A canary-chain batch with no valid canary structure can't honor
    // contingent-release; downgrade it to parallel-isolated so its members still
    // dispatch — never persist an unexecutable canary that would bypass the
    // head/tail gate (council R2, Codex P1).
    const mode: PlanBatchMode =
      rawBatch.mode === "canary-chain" && canary === null
        ? "parallel-isolated"
        : rawBatch.mode;
    // Content-derived id: stable for identical content (preserves content-hash
    // idempotency across revisions) and unique for different content (so a new
    // lookahead batch never collides with a committed batch unless it IS the
    // same batch, in which case dedup is correct) — council R1, Codex P1.
    const batchId = contentBatchId(mode, members, canary);
    batches.push({
      batchId,
      mode,
      status: "lookahead",
      members,
      rationale: rawBatch.rationale,
      canary,
    });
    options.push({
      marker: `[opt-${batches.length}]`,
      label: `Release ${batchId} (${mode}): ${members
        .map((member) => member.issueIdentifier)
        .join(", ")}`,
      intent: { verb: "release_batch", batchId },
    });
  }

  return {
    batches,
    options,
    envelope: context.envelope,
    rationale: raw.rationale,
    source: "planner",
  };
}

export async function runTriagePlanner(
  context: PlannerContext,
  deps: TriagePlannerDeps,
): Promise<PlannerResult> {
  const prompt = buildPlannerPrompt(context);
  const run = await deps.runClaude(prompt);
  if (run.status === "unavailable") {
    return { status: "unavailable", detail: run.detail };
  }
  const parsed = parsePlannerOutput(run.markdown);
  if (!parsed.ok) {
    return { status: "invalid", detail: parsed.reason };
  }
  return { status: "ok", body: buildPlanBody(parsed.value, context) };
}

function extractFencedJson(markdown: string): string | null {
  const match = markdown.match(/```json\s*\n([\s\S]*?)\n```/);
  return match?.[1] ?? null;
}

/**
 * Restrict canary head/contingent identifiers to the batch's resolved members.
 * Returns null when no valid head survives — a canary without a head is not a
 * valid chain and must not be persisted.
 */
function normalizeCanary(
  canary: PlanCanaryStructure | null,
  members: readonly PlanBatchMember[],
): PlanCanaryStructure | null {
  if (canary === null) {
    return null;
  }
  const memberIdentifiers = new Set(
    members.map((member) => member.issueIdentifier),
  );
  const headIssueIdentifiers = canary.headIssueIdentifiers.filter((id) =>
    memberIdentifiers.has(id),
  );
  if (headIssueIdentifiers.length === 0) {
    return null;
  }
  const contingentIssueIdentifiers = canary.contingentIssueIdentifiers.filter(
    (id) => memberIdentifiers.has(id),
  );
  return { headIssueIdentifiers, contingentIssueIdentifiers };
}

/**
 * Content-derived, collision-free batch id. Deterministic in the batch's
 * meaningful content (mode + members + canary), so identical proposals hash
 * identically (idempotency) and distinct proposals never collide.
 */
function contentBatchId(
  mode: string,
  members: readonly PlanBatchMember[],
  canary: PlanCanaryStructure | null,
): string {
  const memberKey = members
    .map((member) => member.issueIdentifier)
    .slice()
    .sort()
    .join(",");
  const canaryKey =
    canary === null
      ? ""
      : `${[...canary.headIssueIdentifiers].sort().join(",")}>${[
          ...canary.contingentIssueIdentifiers,
        ]
          .sort()
          .join(",")}`;
  const digest = createHash("sha256")
    .update(`${mode}\n${memberKey}\n${canaryKey}`)
    .digest("hex");
  return `b-${digest.slice(0, 12)}`;
}

// ---------------------------------------------------------------------------
// Production model runner: Opus@max via cmux-spawn (subscription-backed).
//
// This is the same frontier-Claude path the council gate uses — NOT the
// metered Anthropic API and NOT the weak local judge that the v1 backlog-audit
// used. The model alias is version-floating ("opus"); effort rides the cmux
// agent/profile. Anything other than a clean pass degrades to `unavailable`,
// which the caller turns into graceful degradation to the comparator.
// ---------------------------------------------------------------------------

/** Minimal fs surface the planner runner needs (keeps the test fakes simple). */
export interface PlannerFileSystem {
  mkdir(path: string, options: { recursive: boolean }): Promise<unknown>;
  writeFile(path: string, data: string, encoding: "utf8"): Promise<void>;
  readFile(path: string, encoding: "utf8"): Promise<string>;
}

export interface CmuxPlannerRunnerOptions {
  workspace: string;
  artifactDir: string;
  /** Version-floating model alias; do not pin. Defaults to "opus". */
  model?: string;
  profile?: string;
  timeoutSeconds?: number;
  cmuxSpawnBin?: string;
  env?: NodeJS.ProcessEnv;
  artifactName?: string;
  // Injected for tests.
  runCmux?: (input: ClaudeCmuxRunnerInput) => Promise<ClaudeRunnerResult>;
  fs?: PlannerFileSystem;
}

export const DEFAULT_PLANNER_MODEL = "opus";

export function createCmuxPlannerRunner(
  options: CmuxPlannerRunnerOptions,
): (prompt: string) => Promise<PlannerRunResult> {
  const fs: PlannerFileSystem = options.fs ?? {
    mkdir: (path, fsOptions) => nodeFs.mkdir(path, fsOptions),
    writeFile: (path, data, encoding) => nodeFs.writeFile(path, data, encoding),
    readFile: (path, encoding) => nodeFs.readFile(path, encoding),
  };
  const runCmux = options.runCmux ?? runClaudeCmux;
  const artifactName = options.artifactName ?? "triage-plan";
  const model = options.model ?? DEFAULT_PLANNER_MODEL;

  return async (prompt: string): Promise<PlannerRunResult> => {
    await fs.mkdir(options.artifactDir, { recursive: true });
    const promptFile = join(options.artifactDir, `${artifactName}.prompt.md`);
    await fs.writeFile(promptFile, prompt, "utf8");

    let result: ClaudeRunnerResult;
    try {
      result = await runCmux({
        purpose: "research",
        workspace: options.workspace,
        promptFile,
        artifactDir: options.artifactDir,
        artifactName,
        model,
        ...(options.profile === undefined ? {} : { profile: options.profile }),
        ...(options.timeoutSeconds === undefined
          ? {}
          : { timeoutSeconds: options.timeoutSeconds }),
        ...(options.cmuxSpawnBin === undefined
          ? {}
          : { cmuxSpawnBin: options.cmuxSpawnBin }),
        ...(options.env === undefined ? {} : { env: options.env }),
      });
    } catch (error) {
      return {
        status: "unavailable",
        detail: `cmux planner threw: ${(error as Error).message}`,
      };
    }

    if (result.status !== "passed" || result.artifactPath === null) {
      return {
        status: "unavailable",
        detail: `cmux planner ${result.status}: ${result.message}`,
      };
    }

    const markdown = await fs.readFile(result.artifactPath, "utf8");
    return { status: "ok", markdown };
  };
}
