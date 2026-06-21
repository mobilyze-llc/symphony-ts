import type { StageExecutionBackend as StageExecutionBackendKind } from "../config/types.js";
import type { StageExecutionBackendRunner } from "./backend.js";
import { CrabrunnerStageExecutionBackend } from "./crabrunner-backend.js";
import {
  type CrabrunnerCli,
  CrabrunnerCliSchedulerClient,
} from "./crabrunner-scheduler-client.js";

export interface CreateCrabrunnerStageExecutionBackendOptions {
  /** Crucible repo root. `bin/crabrunner` runs with cwd set here (MOB-193). */
  crucibleRoot: string;
  /** Target repo to clone/operate on, passed via `--repo-root`. */
  targetRepoRoot: string;
  /** Crabrunner state root (defaults to `~/.crucible/crabrunner`). */
  stateRoot?: string;
  /** Host label written into the manifest (default "local"). */
  host?: string;
  /** Manifest provider; defaults by host ("local" -> "local", else "ssh"). */
  provider?: string;
  /** Marks job specs as dry-run on the backend. */
  dryRun?: boolean;
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

  return new CrabrunnerStageExecutionBackend({
    client,
    ...(options.dryRun === undefined ? {} : { dryRun: options.dryRun }),
    ...(options.now === undefined ? {} : { now: options.now }),
  });
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
