import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  type RenderPromptInput,
  renderPrompt as defaultRenderPrompt,
} from "../agent/prompt-builder.js";
import {
  resolvePromptTemplate as resolveDispatchPromptTemplate,
  resolveWorkpadRetryContext,
} from "../agent/runner.js";
import type { StageExecutionBackend as StageExecutionBackendKind } from "../config/types.js";
import type {
  StageExecutionBackendInput,
  StageExecutionBackendRunner,
} from "./backend.js";
import {
  CRABRUNNER_TEMP_PROMPT_DIR_PREFIX,
  CrabrunnerStageExecutionBackend,
} from "./crabrunner-backend.js";
import {
  type CrabrunnerCli,
  CrabrunnerCliSchedulerClient,
} from "./crabrunner-scheduler-client.js";

/**
 * The minimal slice of {@link ResolvedWorkflowConfig} the default prompt
 * resolver needs to render a stage prompt at dispatch time (SYMPH-856).
 *
 * `AgentRunInput` carries the per-dispatch `stage` (whose `prompt` overrides the
 * workflow default) but NOT the workflow config — the global `promptTemplate`
 * and `workflowPath` live on the runtime host / config, so they are injected
 * here. This mirrors `AgentRunner.run()`, which selects
 * `stage?.prompt ?? this.config.promptTemplate` and resolves partials from
 * `this.config.workflowPath`.
 */
export interface CrabrunnerPromptRenderingConfig {
  /** Workflow-global prompt template (fallback when a stage has no prompt). */
  promptTemplate: string;
  /**
   * Path to the WORKFLOW.md; drives LiquidJS partial-root resolution and bare
   * prompt-file path resolution exactly as `AgentRunner.run()` does.
   */
  workflowPath: string;
}

/**
 * Injectable prompt renderer (defaults to {@link renderPrompt}). Tests inject a
 * fake so they stay deterministic without rendering a real template; production
 * uses the real LiquidJS renderer.
 */
export type CrabrunnerPromptRenderer = (
  input: RenderPromptInput,
) => Promise<string>;

export interface CreateCrabrunnerStageExecutionBackendOptions {
  /** Crucible repo root. `bin/crabrunner` runs with cwd set here (MOB-193). */
  crucibleRoot: string;
  /** Target repo, written to manifest `workspace` (the lane operates on it). */
  targetRepoRoot: string;
  /** Crabrunner state root (defaults to `~/.crucible/crabrunner`). */
  stateRoot?: string;
  /** Host label written into the manifest (default "local"). */
  host?: string;
  /** Manifest provider; defaults by host ("local" -> "local", else "ssh"). */
  provider?: string;
  /** Marks job specs as dry-run on the backend. */
  dryRun?: boolean;
  /**
   * Workflow config slice for the DEFAULT prompt resolver (SYMPH-856). When
   * provided (and no explicit `resolvePromptFile` override is set), the backend
   * renders the stage prompt at dispatch and threads it into the lane as a temp
   * `prompt_file`. When absent (and no override), `spec.promptFile` stays absent
   * and the scheduler client fails closed at submit — the SYMPH-853 behavior.
   */
  promptRendering?: CrabrunnerPromptRenderingConfig;
  /**
   * Injected prompt renderer (tests). Defaults to the real LiquidJS
   * {@link renderPrompt}. Only consulted by the default resolver (i.e. when
   * `promptRendering` is set and `resolvePromptFile` is not).
   */
  renderPrompt?: CrabrunnerPromptRenderer;
  /**
   * Explicit override for prompt-path resolution (SYMPH-856). Takes precedence
   * over the default renderer; pass undefined to use the default (rendering)
   * resolver when `promptRendering` is set, or to leave the lane fail-closed
   * when neither is supplied.
   */
  resolvePromptFile?: (
    input: StageExecutionBackendInput,
  ) => Promise<string | null | undefined> | string | null | undefined;
  now?: () => Date;
  /** Injected subprocess executor (tests only); defaults to a real execFile. */
  cli?: CrabrunnerCli;
  /** Status poll interval in ms (default 1000). */
  pollIntervalMs?: number;
  /** Maximum number of status polls before failing closed (default 1800). */
  maxPolls?: number;
  /** Pass `--no-stage` to submit. */
  noStage?: boolean;
}

/**
 * Construct a {@link CrabrunnerStageExecutionBackend} backed by a production
 * {@link CrabrunnerCliSchedulerClient} driving `bin/crabrunner`.
 */
export function createCrabrunnerStageExecutionBackend(
  options: CreateCrabrunnerStageExecutionBackendOptions,
): CrabrunnerStageExecutionBackend {
  const client = new CrabrunnerCliSchedulerClient({
    crucibleRoot: options.crucibleRoot,
    targetRepoRoot: options.targetRepoRoot,
    ...(options.stateRoot === undefined
      ? {}
      : { stateRoot: options.stateRoot }),
    ...(options.host === undefined ? {} : { host: options.host }),
    ...(options.provider === undefined ? {} : { provider: options.provider }),
    ...(options.now === undefined ? {} : { now: options.now }),
    ...(options.cli === undefined ? {} : { cli: options.cli }),
    ...(options.pollIntervalMs === undefined
      ? {}
      : { pollIntervalMs: options.pollIntervalMs }),
    ...(options.maxPolls === undefined ? {} : { maxPolls: options.maxPolls }),
    ...(options.noStage === undefined ? {} : { noStage: options.noStage }),
  });

  const resolvePromptFile = resolveResolvePromptFile(options);

  return new CrabrunnerStageExecutionBackend({
    client,
    ...(options.dryRun === undefined ? {} : { dryRun: options.dryRun }),
    ...(resolvePromptFile === undefined ? {} : { resolvePromptFile }),
    ...(options.now === undefined ? {} : { now: options.now }),
  });
}

/**
 * Decide which `resolvePromptFile` the backend gets:
 *   1. an explicit `resolvePromptFile` override (highest precedence), else
 *   2. the default renderer when `promptRendering` is provided, else
 *   3. undefined — leaving the lane fail-closed (SYMPH-853 behavior).
 */
function resolveResolvePromptFile(
  options: CreateCrabrunnerStageExecutionBackendOptions,
):
  | ((
      input: StageExecutionBackendInput,
    ) => Promise<string | null | undefined> | string | null | undefined)
  | undefined {
  if (options.resolvePromptFile !== undefined) {
    return options.resolvePromptFile;
  }
  if (options.promptRendering !== undefined) {
    const promptRendering = options.promptRendering;
    const render = options.renderPrompt ?? defaultRenderPrompt;
    return (input) =>
      renderStagePromptToFile({ input, promptRendering, render });
  }
  return undefined;
}

/**
 * Default SYMPH-856 resolver: render the stage prompt and write it to a temp
 * file, returning the absolute path. Mirrors a turn-1 `AgentRunner.run()`:
 *
 *   - Template source: `runnerInput.stage?.prompt ?? promptRendering.promptTemplate`.
 *   - The source is resolved through {@link resolveDispatchPromptTemplate} so a
 *     bare prompt-file path (e.g. `./prompts/implement.liquid`) is read from
 *     disk exactly as the runner does on turn 1.
 *   - The render context is built field-for-field from `runnerInput`.
 *
 * Fail-closed contract:
 *   - A RENDER FAILURE (strictVariables miss, parse error, unreadable file, or a
 *     present template that renders to empty/whitespace) is allowed to THROW.
 *     The backend's `execute()` catches it and yields a failed result carrying
 *     the real error — never an empty/placeholder prompt.
 *   - A GENUINELY ABSENT template (empty/blank source) returns undefined so the
 *     scheduler client fails closed at submit
 *     (`crabrunner_prompt_required_symph_856`).
 *
 * The empty-render-vs-absent-template distinction matters (Codex P2-1): a
 * non-empty Liquid template that resolves to nothing is an operator-visible
 * template bug, not a "no prompt configured" case, so it must surface as a
 * render failure rather than the absent-template rejection.
 */
async function renderStagePromptToFile(args: {
  input: StageExecutionBackendInput;
  promptRendering: CrabrunnerPromptRenderingConfig;
  render: CrabrunnerPromptRenderer;
}): Promise<string | undefined> {
  const { input, promptRendering, render } = args;
  const runnerInput = input.runnerInput;

  // stage?.prompt ?? config.promptTemplate — identical to AgentRunner.run().
  const templateSource =
    runnerInput.stage?.prompt ?? promptRendering.promptTemplate;
  if (templateSource === null || templateSource.trim().length === 0) {
    // No template to render: fail closed at submit rather than emit an empty
    // prompt. (A render failure, by contrast, throws.)
    return undefined;
  }

  // Turn-1 resolution: a bare prompt-file path is read from disk; an inline
  // template is returned verbatim — exactly the runner's turn===1 branch.
  const resolvedTemplate = await resolveDispatchPromptTemplate({
    promptTemplate: templateSource,
    workflowPath: promptRendering.workflowPath,
  });
  if (resolvedTemplate.trim().length === 0) {
    return undefined;
  }

  // Render context built field-for-field from runnerInput, matching the
  // buildTurnPrompt call in AgentRunner.run() (turn 1 -> renderPrompt).
  const rendered = await render({
    workflow: {
      promptTemplate: resolvedTemplate,
      workflowPath: promptRendering.workflowPath,
    },
    issue: runnerInput.issue,
    attempt: runnerInput.attempt,
    stageName: runnerInput.stageName ?? null,
    reworkCount: runnerInput.reworkCount ?? 0,
    acceptanceCriteria: runnerInput.acceptanceCriteria ?? null,
    implementationCommentDeltas:
      runnerInput.implementationCommentDeltas ?? null,
    workpadContext: resolveWorkpadRetryContext(runnerInput),
    modePolicy: runnerInput.modePolicy ?? null,
  });

  // P2-1: a present template that renders to empty/whitespace is a template bug,
  // NOT an absent template. Throw so execute() surfaces it as a failed result
  // (crabrunner_prompt_render_failed) — never launch a lane with no instructions.
  if (rendered.trim().length === 0) {
    throw new Error("rendered stage prompt is empty");
  }

  const dir = await mkdtemp(join(tmpdir(), CRABRUNNER_TEMP_PROMPT_DIR_PREFIX));
  const promptPath = join(dir, "prompt.md");
  await writeFile(promptPath, rendered, "utf8");
  return promptPath;
}

/**
 * Build the stage-execution backend map for
 * {@link RuntimeHostOptions.stageExecutionBackends}, registering only the
 * crabrunner backend. The host always keeps its own default current-runner
 * backend; this map adds (does not replace) the crabrunner entry.
 */
export function createCrabrunnerStageExecutionBackends(
  options: CreateCrabrunnerStageExecutionBackendOptions,
): ReadonlyMap<StageExecutionBackendKind, StageExecutionBackendRunner> {
  return new Map<StageExecutionBackendKind, StageExecutionBackendRunner>([
    ["crabrunner", createCrabrunnerStageExecutionBackend(options)],
  ]);
}
