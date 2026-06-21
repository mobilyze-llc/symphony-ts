import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

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
   * Injected temp-file writer (tests only); defaults to a real `writeFile`.
   * Lets a test force a write failure after the temp dir is created to prove
   * the dir is cleaned up before the error rethrows (recheck-2 T1). Only
   * consulted by the default resolver.
   */
  writePromptFile?: (path: string, contents: string) => Promise<void>;
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

  const prompt = resolvePromptFileHandling(options);

  return new CrabrunnerStageExecutionBackend({
    client,
    ...(options.dryRun === undefined ? {} : { dryRun: options.dryRun }),
    ...(prompt.resolvePromptFile === undefined
      ? {}
      : { resolvePromptFile: prompt.resolvePromptFile }),
    ...(prompt.cleanupPromptFile === undefined
      ? {}
      : { cleanupPromptFile: prompt.cleanupPromptFile }),
    ...(options.now === undefined ? {} : { now: options.now }),
  });
}

interface ResolvedPromptFileHandling {
  resolvePromptFile?: (
    input: StageExecutionBackendInput,
  ) => Promise<string | null | undefined> | string | null | undefined;
  cleanupPromptFile?: (resolvedPath: string) => Promise<void>;
}

/**
 * Decide the backend's prompt resolver AND its paired cleanup:
 *   1. an explicit `resolvePromptFile` override (highest precedence) — NO paired
 *      cleanup, so an override-supplied path is never removed (recheck-2 P2-1);
 *   2. the default renderer when `promptRendering` is provided — paired with a
 *      cleanup that removes ONLY the temp dirs THIS resolver created (tracked
 *      explicitly in a closed-over Set, never inferred from the pathname);
 *   3. neither — fail-closed (SYMPH-853), no resolver and no cleanup.
 */
function resolvePromptFileHandling(
  options: CreateCrabrunnerStageExecutionBackendOptions,
): ResolvedPromptFileHandling {
  if (options.resolvePromptFile !== undefined) {
    // An override owns its own path lifecycle; the backend must never delete it.
    return { resolvePromptFile: options.resolvePromptFile };
  }
  if (options.promptRendering !== undefined) {
    const promptRendering = options.promptRendering;
    const render = options.renderPrompt ?? defaultRenderPrompt;
    const writePromptFile = options.writePromptFile ?? defaultWritePromptFile;
    // Explicit ownership ledger: the resolver records every temp dir it creates;
    // cleanup removes a path ONLY if its dir is in this set. A colliding
    // pathname from an override can never land here, so it is never deleted.
    const ownedDirs = new Set<string>();
    return {
      resolvePromptFile: (input) =>
        renderStagePromptToFile({
          input,
          promptRendering,
          render,
          writePromptFile,
          ownedDirs,
        }),
      cleanupPromptFile: async (resolvedPath) => {
        const dir = dirname(resolve(resolvedPath));
        if (!ownedDirs.has(dir)) {
          return;
        }
        ownedDirs.delete(dir);
        await rm(dir, { recursive: true, force: true });
      },
    };
  }
  return {};
}

async function defaultWritePromptFile(
  path: string,
  contents: string,
): Promise<void> {
  await writeFile(path, contents, "utf8");
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
 *   - A GENUINELY ABSENT template SOURCE (no `stage.prompt` and a blank
 *     `promptTemplate` config string) returns undefined so the scheduler client
 *     fails closed at submit (`crabrunner_prompt_required_symph_856`).
 *
 * The empty-render-vs-absent-template distinction matters (Codex P2-1 / recheck-2
 * P2-2): only a genuinely absent SOURCE is "no prompt configured". A PRESENT
 * source — including a prompt-file path whose file is blank — is rendered, and a
 * resulting empty/whitespace prompt is an operator-visible template bug that must
 * surface as a render failure, never the absent-template rejection.
 *
 * Every temp dir this resolver creates is recorded in `ownedDirs` so the factory's
 * paired cleanup removes ONLY dirs this resolver created (explicit ownership, not
 * pathname inference — recheck-2 P2-1). If the write fails after the dir is
 * created, the dir is removed before the error rethrows (recheck-2 T1).
 */
async function renderStagePromptToFile(args: {
  input: StageExecutionBackendInput;
  promptRendering: CrabrunnerPromptRenderingConfig;
  render: CrabrunnerPromptRenderer;
  writePromptFile: (path: string, contents: string) => Promise<void>;
  ownedDirs: Set<string>;
}): Promise<string | undefined> {
  const { input, promptRendering, render, writePromptFile, ownedDirs } = args;
  const runnerInput = input.runnerInput;

  // stage?.prompt ?? config.promptTemplate — identical to AgentRunner.run().
  const templateSource =
    runnerInput.stage?.prompt ?? promptRendering.promptTemplate;
  if (templateSource === null || templateSource.trim().length === 0) {
    // Genuinely ABSENT source: fail closed at submit (required), not a render
    // failure. (A present-but-empty template, by contrast, throws below.)
    return undefined;
  }

  // Turn-1 resolution: a bare prompt-file path is read from disk; an inline
  // template is returned verbatim — exactly the runner's turn===1 branch.
  const resolvedTemplate = await resolveDispatchPromptTemplate({
    promptTemplate: templateSource,
    workflowPath: promptRendering.workflowPath,
  });

  // recheck-2 P2-2: a PRESENT source (the source was non-blank above) whose
  // resolved content is blank — e.g. a prompt-FILE path pointing at an empty
  // file — is a template bug, NOT an absent template. Throw here, BEFORE
  // renderPrompt: getEffectivePromptTemplate() would otherwise substitute the
  // DEFAULT_WORKFLOW_PROMPT for a blank template and silently mask the bug as a
  // generic-prompt success. (The genuinely-absent SOURCE case returned undefined
  // above → required.)
  if (resolvedTemplate.trim().length === 0) {
    throw new Error("rendered stage prompt is empty");
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

  // A present template that renders to empty/whitespace (including a blank
  // prompt file) is a template bug, NOT an absent template. Throw so execute()
  // surfaces it as crabrunner_prompt_render_failed — never launch a lane with no
  // instructions.
  if (rendered.trim().length === 0) {
    throw new Error("rendered stage prompt is empty");
  }

  const dir = await mkdtemp(join(tmpdir(), CRABRUNNER_TEMP_PROMPT_DIR_PREFIX));
  ownedDirs.add(resolve(dir));
  const promptPath = join(dir, "prompt.md");
  try {
    await writePromptFile(promptPath, rendered);
  } catch (error) {
    // recheck-2 T1: a write failure must not leak the just-created temp dir.
    ownedDirs.delete(resolve(dir));
    await rm(dir, { recursive: true, force: true });
    throw error;
  }
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
