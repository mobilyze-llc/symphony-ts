import { z } from "zod";

const CRABRUNNER_STATUS_SCHEMA = "crucible.crabrunner.status.v1";
const CRABRUNNER_COLLECT_SCHEMA = "crucible.crabrunner.collect.v1";
const CRABRUNNER_RUN_RESULT_SCHEMA = "crucible.crabrunner.run-result.v1";

export interface CrabrunnerCliResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

const crabrunnerStatusSchema = z
  .object({
    schema: z.string(),
    job_id: z.string(),
    state: z.string(),
    message: z.string().nullish(),
    host: z.string().nullish(),
    worker_pid: z.number().nullish(),
    worker_pgid: z.number().nullish(),
    started_at: z.string().nullish(),
    updated_at: z.string().nullish(),
    artifact_path: z.string().nullish(),
    usage_path: z.string().nullish(),
    collect_archive: z.string().nullish(),
    workspace: z.string().nullish(),
    collectible: z.boolean().nullish(),
    error_code: z.string().nullish(),
    heartbeat_seq: z.number().nullish(),
  })
  .passthrough();

export type CrabrunnerStatus = z.infer<typeof crabrunnerStatusSchema>;

const crabrunnerCollectSchema = z
  .object({
    schema: z.string(),
    job_id: z.string(),
    state: z.string(),
    status: crabrunnerStatusSchema,
    archive_path: z.string().nullish(),
    materialized: z.unknown().nullish(),
  })
  .passthrough();

export type CrabrunnerCollect = z.infer<typeof crabrunnerCollectSchema>;

const crabrunnerWorkspaceSyncArtifactRefSchema = z
  .object({
    schema: z.string(),
    path: z.string(),
    sha256: z.string().nullish(),
  })
  .passthrough();

const crabrunnerRunResultSchema = z
  .object({
    schema: z.string(),
    job_id: z.string(),
    state: z.string(),
    status: crabrunnerStatusSchema,
    collect: crabrunnerCollectSchema.nullish(),
    workspace_sync_artifact: crabrunnerWorkspaceSyncArtifactRefSchema.nullish(),
  })
  .passthrough();

export type CrabrunnerRunResult = z.infer<typeof crabrunnerRunResultSchema>;

const crabrunnerErrorPayloadSchema = z
  .object({
    schema: z.literal("crucible.crabrunner.error.v1"),
    error_code: z.string(),
    message: z.string(),
  })
  .passthrough();

type CrabrunnerErrorPayload = z.infer<typeof crabrunnerErrorPayloadSchema>;

export function parseCrabrunnerStatus(
  result: CrabrunnerCliResult,
  command: string,
  expectedJobId?: string,
): CrabrunnerStatus {
  if (result.exitCode !== 0) {
    throw commandFailure(command, result);
  }
  const parsed = parseJson(result.stdout, command);
  const status = crabrunnerStatusSchema.safeParse(parsed);
  if (!status.success) {
    throw new Error(
      `crabrunner ${command} returned an invalid status payload: ${status.error.message}`,
    );
  }
  assertStatusContract(command, status.data, expectedJobId);
  return status.data;
}

export function parseCrabrunnerCollect(
  result: CrabrunnerCliResult,
  expectedJobId?: string,
): CrabrunnerCollect {
  if (result.exitCode !== 0) {
    throw commandFailure("collect", result);
  }
  const parsed = parseJson(result.stdout, "collect");
  const collect = crabrunnerCollectSchema.safeParse(parsed);
  if (!collect.success) {
    throw new Error(
      `crabrunner collect returned an invalid payload: ${collect.error.message}`,
    );
  }
  assertCollectContract("collect", collect.data, expectedJobId);
  return collect.data;
}

export function parseCrabrunnerRunResult(
  result: CrabrunnerCliResult,
  expectedJobId: string,
): CrabrunnerRunResult {
  if (result.exitCode !== 0) {
    throw commandFailure("run", result);
  }
  const parsed = parseJson(result.stdout, "run");
  const runResult = crabrunnerRunResultSchema.safeParse(parsed);
  if (!runResult.success) {
    throw new Error(
      `crabrunner run returned an invalid payload: ${runResult.error.message}`,
    );
  }
  if (runResult.data.schema !== CRABRUNNER_RUN_RESULT_SCHEMA) {
    throw new Error(
      `crabrunner run returned unexpected schema "${runResult.data.schema}" (expected ${CRABRUNNER_RUN_RESULT_SCHEMA})`,
    );
  }
  if (runResult.data.job_id.trim().length === 0) {
    throw new Error("crabrunner run result is missing a job_id");
  }
  assertJobIdMatches("run", expectedJobId, runResult.data.job_id);
  assertStatusContract("run", runResult.data.status, expectedJobId);
  if (runResult.data.collect !== null && runResult.data.collect !== undefined) {
    assertCollectContract("run collect", runResult.data.collect, expectedJobId);
  }
  return runResult.data;
}

function assertCollectContract(
  command: string,
  collect: CrabrunnerCollect,
  expectedJobId: string | undefined,
): void {
  if (collect.schema !== CRABRUNNER_COLLECT_SCHEMA) {
    throw new Error(
      `crabrunner ${command} returned unexpected schema "${collect.schema}" (expected ${CRABRUNNER_COLLECT_SCHEMA})`,
    );
  }
  assertJobIdMatches(command, expectedJobId, collect.job_id);
  assertStatusContract(command, collect.status, expectedJobId);
}

function assertStatusContract(
  command: string,
  status: CrabrunnerStatus,
  expectedJobId: string | undefined,
): void {
  if (status.schema !== CRABRUNNER_STATUS_SCHEMA) {
    throw new Error(
      `crabrunner ${command} returned unexpected status schema "${status.schema}" (expected ${CRABRUNNER_STATUS_SCHEMA})`,
    );
  }
  if (status.job_id.trim().length === 0) {
    throw new Error(`crabrunner ${command} status is missing a job_id`);
  }
  assertJobIdMatches(command, expectedJobId, status.job_id);
}

function assertJobIdMatches(
  command: string,
  expectedJobId: string | undefined,
  actualJobId: string,
): void {
  if (expectedJobId === undefined) {
    return;
  }
  if (actualJobId !== expectedJobId) {
    throw new Error(
      `crabrunner ${command} returned job_id "${actualJobId}" but expected "${expectedJobId}"`,
    );
  }
}

function parseJson(stdout: string, command: string): unknown {
  const trimmed = stdout.trim();
  if (trimmed.length === 0) {
    throw new Error(`crabrunner ${command} produced empty stdout`);
  }
  try {
    return JSON.parse(trimmed);
  } catch (error) {
    throw new Error(
      `crabrunner ${command} produced unparseable stdout: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
}

function commandFailure(command: string, result: CrabrunnerCliResult): Error {
  const payload = parseCrabrunnerErrorPayload(result.stdout);
  const stderr = result.stderr.trim();
  if (payload === null) {
    return new Error(
      `crabrunner ${command} exited with code ${result.exitCode}: ${stderr || "no stderr"}`,
    );
  }
  const error = new Error(
    [
      `crabrunner ${command} exited with code ${result.exitCode}`,
      `${payload.error_code}: ${payload.message}`,
      `payload=${JSON.stringify(payload)}`,
      ...(stderr.length === 0 ? [] : [`stderr=${stderr}`]),
    ].join("; "),
  );
  error.name = "CrabrunnerCommandError";
  return error;
}

function parseCrabrunnerErrorPayload(
  stdout: string,
): CrabrunnerErrorPayload | null {
  const trimmed = stdout.trim();
  if (trimmed.length === 0) {
    return null;
  }
  const candidates = [trimmed, ...trimmed.split(/\r?\n/).reverse()];
  for (const candidate of candidates) {
    try {
      const parsed = crabrunnerErrorPayloadSchema.safeParse(
        JSON.parse(candidate),
      );
      if (parsed.success) {
        return parsed.data;
      }
    } catch {
      // Some remote commands print human progress before the final JSON line.
    }
  }
  return null;
}
