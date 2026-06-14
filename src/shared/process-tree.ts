import { execFile as execFileCallback } from "node:child_process";
import { readFile as readFileDefault } from "node:fs/promises";
import { promisify } from "node:util";

export const CODEX_APP_SERVER_LAUNCH_TOKEN_ENV =
  "SYMPHONY_CODEX_APP_SERVER_TOKEN";

export interface ProcessIdentitySnapshot {
  pid: number;
  processGroupId: number | null;
  sessionId: number | null;
  startedAt: string;
  command: string;
  launchToken: string | null;
}

export interface ProcessTreeTerminationResult {
  pid: number | null;
  processGroupId?: number | null;
  sigtermSent: boolean;
  sigkillSent: boolean;
  sigterm?: ProcessSignalDelivery | null;
  sigkill?: ProcessSignalDelivery | null;
  identityStatus?: ProcessTerminationIdentityStatus;
  postGraceIdentityStatus?: ProcessTerminationIdentityStatus | null;
}

export interface ProcessKillError extends Error {
  code?: string;
}

export type ProcessSignalDeliveryStatus = "delivered" | "absent" | "failed";
export type ProcessSignalTarget = "process_group" | "pid";
export type ProcessTerminationIdentityStatus =
  | "not_checked"
  | "matched"
  | "missing_expected_identity"
  | "identity_inconclusive"
  | "identity_mismatch"
  | "absent";

export interface ProcessSignalAttempt {
  target: ProcessSignalTarget;
  pid: number;
  signal: NodeJS.Signals;
  status: ProcessSignalDeliveryStatus;
  errorCode: string | null;
}

export interface ProcessSignalDelivery {
  signal: NodeJS.Signals;
  status: ProcessSignalDeliveryStatus;
  deliveredTo: ProcessSignalTarget | null;
  attempts: ProcessSignalAttempt[];
}

export type ProcessKill = typeof process.kill;
export type ProcessIdentityProbe = (
  pid: number,
) => Promise<ProcessIdentitySnapshot | null>;

type ProcessIdentityExecFile = (
  file: string,
  args: string[],
  options: { timeout: number; maxBuffer: number },
) => Promise<{ stdout: string | Buffer }>;
type ProcessIdentityReadFile = (
  path: string,
) => Promise<string | Buffer<ArrayBufferLike>>;

const execFileAsync = promisify(execFileCallback) as ProcessIdentityExecFile;

export function readProcessIdentityMetadata(
  value: unknown,
): ProcessIdentitySnapshot | null {
  if (!isRecord(value)) {
    return null;
  }
  const pid = value.pid;
  const processGroupId = value.processGroupId;
  const sessionId = value.sessionId;
  const startedAt = value.startedAt;
  const command = value.command;
  const launchToken = value.launchToken;
  if (
    typeof pid !== "number" ||
    !Number.isSafeInteger(pid) ||
    pid <= 0 ||
    typeof processGroupId !== "number" ||
    !Number.isSafeInteger(processGroupId) ||
    processGroupId <= 0 ||
    !(
      sessionId === null ||
      (typeof sessionId === "number" &&
        Number.isSafeInteger(sessionId) &&
        sessionId >= 0)
    ) ||
    typeof startedAt !== "string" ||
    startedAt.trim() === "" ||
    typeof command !== "string" ||
    command.trim() === "" ||
    !(
      launchToken === null ||
      (typeof launchToken === "string" && launchToken.trim() !== "")
    )
  ) {
    return null;
  }
  return {
    pid,
    processGroupId,
    sessionId,
    startedAt,
    command,
    launchToken,
  };
}

export interface ChildProcessForTermination {
  exitCode: number | null;
  signalCode: NodeJS.Signals | null;
  pid?: number | undefined;
  once(event: "exit", listener: () => void): unknown;
}

export async function terminateChildProcessTree(
  child: ChildProcessForTermination,
  options?: {
    forceKillAfterGrace?: boolean;
    graceMs?: number;
    kill?: ProcessKill;
  },
): Promise<ProcessTreeTerminationResult> {
  const pid = child.pid ?? null;
  if (pid === null) {
    return buildTerminationResult({
      pid,
      sigterm: null,
      sigkill: null,
      identityStatus: "not_checked",
      postGraceIdentityStatus: null,
    });
  }
  if (childHasExited(child)) {
    return buildTerminationResult({
      pid,
      sigterm: null,
      sigkill: null,
      identityStatus: "absent",
      postGraceIdentityStatus: null,
    });
  }

  const kill = options?.kill ?? process.kill;
  const graceMs = options?.graceMs ?? 1_000;
  const sigterm = signalPidOrProcessGroupDetailed(pid, "SIGTERM", kill);
  if (options?.forceKillAfterGrace === false) {
    await waitForChildExit(child);
    return buildTerminationResult({
      pid,
      sigterm,
      sigkill: null,
      identityStatus: "not_checked",
      postGraceIdentityStatus: null,
    });
  }
  await delay(graceMs);

  const sigkill = signalPidOrProcessGroupDetailed(pid, "SIGKILL", kill);
  if (!childHasExited(child)) {
    await Promise.race([waitForChildExit(child), delay(100)]);
  }
  return buildTerminationResult({
    pid,
    sigterm,
    sigkill,
    identityStatus: "not_checked",
    postGraceIdentityStatus: null,
  });
}

export async function terminateDetachedPidTree(
  pid: number,
  options?: {
    graceMs?: number;
    kill?: ProcessKill;
    expectedIdentity?: ProcessIdentitySnapshot | null;
    probeIdentity?: ProcessIdentityProbe;
  },
): Promise<ProcessTreeTerminationResult> {
  const kill = options?.kill ?? process.kill;
  const graceMs = options?.graceMs ?? 1_000;
  let identityStatus: ProcessTerminationIdentityStatus = "not_checked";
  let postGraceIdentityStatus: ProcessTerminationIdentityStatus | null = null;
  if (options !== undefined && "expectedIdentity" in options) {
    const expectedIdentity = options.expectedIdentity ?? null;
    if (expectedIdentity === null) {
      return buildTerminationResult({
        pid,
        sigterm: null,
        sigkill: null,
        identityStatus: "missing_expected_identity",
        postGraceIdentityStatus,
      });
    }
    const probeIdentity = options.probeIdentity ?? readProcessIdentity;
    const observedIdentity = await probeIdentity(pid);
    if (observedIdentity === null) {
      if (!isPidDefinitelyAbsent(pid, kill)) {
        return buildTerminationResult({
          pid,
          sigterm: null,
          sigkill: null,
          identityStatus: "identity_inconclusive",
          postGraceIdentityStatus,
        });
      }
      identityStatus = "absent";
    } else if (!processIdentityMatches(expectedIdentity, observedIdentity)) {
      return buildTerminationResult({
        pid,
        sigterm: null,
        sigkill: null,
        identityStatus: "identity_mismatch",
        postGraceIdentityStatus,
      });
    } else {
      identityStatus = "matched";
    }
  }

  const sigterm = signalPidOrProcessGroupDetailed(pid, "SIGTERM", kill);
  await delay(graceMs);
  if (options !== undefined && "expectedIdentity" in options) {
    const expectedIdentity = options.expectedIdentity ?? null;
    if (expectedIdentity === null) {
      return buildTerminationResult({
        pid,
        sigterm,
        sigkill: null,
        identityStatus,
        postGraceIdentityStatus: "missing_expected_identity",
      });
    }
    const probeIdentity = options.probeIdentity ?? readProcessIdentity;
    const observedIdentity = await probeIdentity(pid);
    if (observedIdentity === null) {
      if (!isPidDefinitelyAbsent(pid, kill)) {
        return buildTerminationResult({
          pid,
          sigterm,
          sigkill: null,
          identityStatus,
          postGraceIdentityStatus: "identity_inconclusive",
        });
      }
      postGraceIdentityStatus = "absent";
    } else if (!processIdentityMatches(expectedIdentity, observedIdentity)) {
      return buildTerminationResult({
        pid,
        sigterm,
        sigkill: null,
        identityStatus,
        postGraceIdentityStatus: "identity_mismatch",
      });
    } else {
      postGraceIdentityStatus = "matched";
    }
  }
  const sigkill = signalPidOrProcessGroupDetailed(pid, "SIGKILL", kill);
  return buildTerminationResult({
    pid,
    sigterm,
    sigkill,
    identityStatus,
    postGraceIdentityStatus,
  });
}

export async function terminateDetachedProcessGroupTree(
  processGroupId: number,
  options?: {
    graceMs?: number;
    kill?: ProcessKill;
  },
): Promise<ProcessTreeTerminationResult> {
  const kill = options?.kill ?? process.kill;
  const graceMs = options?.graceMs ?? 1_000;
  const sigterm = signalProcessGroupDetailed(processGroupId, "SIGTERM", kill);
  await delay(graceMs);
  const sigkill = signalProcessGroupDetailed(processGroupId, "SIGKILL", kill);
  return buildTerminationResult({
    pid: null,
    processGroupId,
    sigterm,
    sigkill,
    identityStatus: "not_checked",
    postGraceIdentityStatus: null,
  });
}

export async function readProcessIdentity(
  pid: number,
  options?: {
    execFile?: ProcessIdentityExecFile;
    readFile?: ProcessIdentityReadFile;
  },
): Promise<ProcessIdentitySnapshot | null> {
  if (!Number.isSafeInteger(pid) || pid <= 0) {
    return null;
  }
  const readFile = options?.readFile ?? readFileDefault;
  const linuxIdentity = await readLinuxProcessIdentity(pid, readFile);
  if (linuxIdentity !== null) {
    return linuxIdentity;
  }
  try {
    const execFile = options?.execFile ?? execFileAsync;
    const { stdout } = await execFile(
      "ps",
      [
        "-ww",
        "-p",
        String(pid),
        "-o",
        "pgid=",
        "-o",
        "sess=",
        "-o",
        "lstart=",
        "-o",
        "command=",
      ],
      { timeout: 1_000, maxBuffer: 64 * 1024 },
    );
    const identity = parseProcessIdentityLine(pid, String(stdout));
    if (identity === null) {
      return null;
    }
    const launchToken = await readLaunchTokenFromPsEnvironment(pid, execFile);
    return { ...identity, launchToken };
  } catch {
    return null;
  }
}

export function processIdentityMatches(
  expected: ProcessIdentitySnapshot | null,
  observed: ProcessIdentitySnapshot | null,
): boolean {
  return (
    expected !== null &&
    observed !== null &&
    expected.pid === observed.pid &&
    expected.processGroupId === expected.pid &&
    observed.processGroupId === expected.pid &&
    // Null means the platform probe could not capture a stable session id.
    (expected.sessionId === null ||
      observed.sessionId === expected.sessionId) &&
    expected.startedAt === observed.startedAt &&
    (expected.launchToken !== null
      ? observed.launchToken === expected.launchToken
      : expected.command === observed.command)
  );
}

export function signalPidOrProcessGroup(
  pid: number,
  signal: NodeJS.Signals,
  kill: ProcessKill = process.kill,
): boolean {
  return signalPidOrProcessGroupDetailed(pid, signal, kill).status !== "failed";
}

export function signalPidOrProcessGroupDetailed(
  pid: number,
  signal: NodeJS.Signals,
  kill: ProcessKill = process.kill,
): ProcessSignalDelivery {
  const attempts: ProcessSignalAttempt[] = [];
  try {
    kill(-pid, signal);
    attempts.push({
      target: "process_group",
      pid: -pid,
      signal,
      status: "delivered",
      errorCode: null,
    });
    return {
      signal,
      status: "delivered",
      deliveredTo: "process_group",
      attempts,
    };
  } catch (groupError) {
    attempts.push({
      target: "process_group",
      pid: -pid,
      signal,
      status: isNoSuchProcess(groupError) ? "absent" : "failed",
      errorCode: processKillErrorCode(groupError),
    });
    try {
      kill(pid, signal);
      attempts.push({
        target: "pid",
        pid,
        signal,
        status: "delivered",
        errorCode: null,
      });
      return { signal, status: "delivered", deliveredTo: "pid", attempts };
    } catch (pidError) {
      attempts.push({
        target: "pid",
        pid,
        signal,
        status: isNoSuchProcess(pidError) ? "absent" : "failed",
        errorCode: processKillErrorCode(pidError),
      });
      const status =
        isNoSuchProcess(groupError) && isNoSuchProcess(pidError)
          ? "absent"
          : "failed";
      return { signal, status, deliveredTo: null, attempts };
    }
  }
}

export function signalProcessGroupDetailed(
  processGroupId: number,
  signal: NodeJS.Signals,
  kill: ProcessKill = process.kill,
): ProcessSignalDelivery {
  const targetPid = -processGroupId;
  if (isUnsafeProcessGroupId(processGroupId)) {
    return {
      signal,
      status: "failed",
      deliveredTo: null,
      attempts: [
        {
          target: "process_group",
          pid: targetPid,
          signal,
          status: "failed",
          errorCode: "unsafe_process_group",
        },
      ],
    };
  }

  try {
    kill(targetPid, signal);
    return {
      signal,
      status: "delivered",
      deliveredTo: "process_group",
      attempts: [
        {
          target: "process_group",
          pid: targetPid,
          signal,
          status: "delivered",
          errorCode: null,
        },
      ],
    };
  } catch (error) {
    return {
      signal,
      status: isNoSuchProcess(error) ? "absent" : "failed",
      deliveredTo: null,
      attempts: [
        {
          target: "process_group",
          pid: targetPid,
          signal,
          status: isNoSuchProcess(error) ? "absent" : "failed",
          errorCode: processKillErrorCode(error),
        },
      ],
    };
  }
}

export function processTreeTerminationConfirmed(
  result: ProcessTreeTerminationResult,
): boolean {
  if (result.sigkill === undefined && result.identityStatus === undefined) {
    return result.sigkillSent;
  }

  return (
    result.sigkill?.status === "delivered" ||
    result.sigkill?.status === "absent" ||
    (result.sigkill === null && result.identityStatus === "absent")
  );
}

function buildTerminationResult(input: {
  pid: number | null;
  processGroupId?: number | null;
  sigterm: ProcessSignalDelivery | null;
  sigkill: ProcessSignalDelivery | null;
  identityStatus: ProcessTerminationIdentityStatus;
  postGraceIdentityStatus: ProcessTerminationIdentityStatus | null;
}): ProcessTreeTerminationResult {
  const result = {
    pid: input.pid,
    sigtermSent: input.sigterm !== null && input.sigterm.status !== "failed",
    sigkillSent: input.sigkill !== null && input.sigkill.status !== "failed",
  } as ProcessTreeTerminationResult;
  Object.defineProperties(result, {
    processGroupId: {
      value: input.processGroupId ?? null,
      enumerable: false,
    },
    sigterm: { value: input.sigterm, enumerable: false },
    sigkill: { value: input.sigkill, enumerable: false },
    identityStatus: { value: input.identityStatus, enumerable: false },
    postGraceIdentityStatus: {
      value: input.postGraceIdentityStatus,
      enumerable: false,
    },
  });
  return result;
}

function waitForChildExit(
  child: Pick<ChildProcessForTermination, "once">,
): Promise<void> {
  return new Promise<void>((resolve) => {
    child.once("exit", () => {
      resolve();
    });
  });
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function parseProcessIdentityLine(
  pid: number,
  stdout: string,
): ProcessIdentitySnapshot | null {
  const line = stdout
    .split("\n")
    .map((value) => value.trimEnd())
    .find((value) => value.trim().length > 0);
  if (line === undefined) {
    return null;
  }
  const match = line.trimStart().match(/^(\d+)\s+(\d+)\s+(.{24})\s+(.+)$/);
  if (match === null) {
    return null;
  }
  const processGroupText = match[1];
  const sessionText = match[2];
  const startedAtText = match[3];
  const commandText = match[4];
  if (
    processGroupText === undefined ||
    sessionText === undefined ||
    startedAtText === undefined ||
    commandText === undefined
  ) {
    return null;
  }
  const processGroupId = Number(processGroupText);
  const sessionId = Number(sessionText);
  const startedAt = startedAtText.trim().replaceAll(/\s+/g, " ");
  const command = commandText.trim();
  if (
    !Number.isSafeInteger(processGroupId) ||
    processGroupId <= 0 ||
    !Number.isSafeInteger(sessionId) ||
    sessionId < 0 ||
    startedAt.length === 0 ||
    command.length === 0
  ) {
    return null;
  }
  return {
    pid,
    processGroupId,
    sessionId,
    startedAt,
    command,
    launchToken: null,
  };
}

async function readLinuxProcessIdentity(
  pid: number,
  readFile: ProcessIdentityReadFile,
): Promise<ProcessIdentitySnapshot | null> {
  try {
    const [stat, cmdline, environ] = await Promise.all([
      readFile(`/proc/${pid}/stat`),
      readFile(`/proc/${pid}/cmdline`),
      readFile(`/proc/${pid}/environ`),
    ]);
    const statIdentity = parseLinuxStatIdentity(pid, String(stat));
    if (statIdentity === null) {
      return null;
    }
    const command = String(cmdline)
      .split("\0")
      .filter((part) => part.length > 0)
      .join(" ")
      .trim();
    if (command.length === 0) {
      return null;
    }
    return {
      ...statIdentity,
      command,
      launchToken: extractLaunchToken(String(environ)),
    };
  } catch {
    return null;
  }
}

function parseLinuxStatIdentity(
  pid: number,
  stat: string,
): Omit<ProcessIdentitySnapshot, "command" | "launchToken"> | null {
  const closeParen = stat.lastIndexOf(")");
  if (closeParen === -1) {
    return null;
  }
  const fields = stat
    .slice(closeParen + 2)
    .trim()
    .split(/\s+/);
  const processGroupId = Number(fields[2]);
  const sessionId = Number(fields[3]);
  const startTime = fields[19];
  if (
    !Number.isSafeInteger(processGroupId) ||
    processGroupId <= 0 ||
    !Number.isSafeInteger(sessionId) ||
    sessionId < 0 ||
    startTime === undefined ||
    !/^\d+$/.test(startTime)
  ) {
    return null;
  }
  return {
    pid,
    processGroupId,
    sessionId,
    startedAt: `linux-starttime:${startTime}`,
  };
}

async function readLaunchTokenFromPsEnvironment(
  pid: number,
  execFile: ProcessIdentityExecFile,
): Promise<string | null> {
  try {
    const { stdout } = await execFile(
      "ps",
      ["eww", "-p", String(pid), "-o", "command="],
      { timeout: 1_000, maxBuffer: 128 * 1024 },
    );
    return extractLaunchToken(String(stdout));
  } catch {
    return null;
  }
}

function extractLaunchToken(value: string): string | null {
  const nulMatch = value
    .split("\0")
    .find((part) => part.startsWith(`${CODEX_APP_SERVER_LAUNCH_TOKEN_ENV}=`));
  if (nulMatch !== undefined) {
    return nulMatch.slice(CODEX_APP_SERVER_LAUNCH_TOKEN_ENV.length + 1) || null;
  }
  const whitespaceMatch = value.match(
    new RegExp(`${CODEX_APP_SERVER_LAUNCH_TOKEN_ENV}=([^\\s]+)`),
  );
  return whitespaceMatch?.[1] ?? null;
}

function childHasExited(
  child: Pick<ChildProcessForTermination, "exitCode" | "signalCode">,
): boolean {
  return child.exitCode !== null || child.signalCode !== null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isPidDefinitelyAbsent(pid: number, kill: ProcessKill): boolean {
  try {
    kill(pid, 0);
    return false;
  } catch (error) {
    return isNoSuchProcess(error);
  }
}

function isUnsafeProcessGroupId(processGroupId: number): boolean {
  return (
    !Number.isSafeInteger(processGroupId) ||
    processGroupId <= 1 ||
    processGroupId === process.pid
  );
}

function isNoSuchProcess(error: unknown): boolean {
  return (
    error !== null &&
    typeof error === "object" &&
    "code" in error &&
    (error as ProcessKillError).code === "ESRCH"
  );
}

function processKillErrorCode(error: unknown): string | null {
  return error !== null &&
    typeof error === "object" &&
    "code" in error &&
    typeof (error as ProcessKillError).code === "string"
    ? ((error as ProcessKillError).code ?? null)
    : null;
}
