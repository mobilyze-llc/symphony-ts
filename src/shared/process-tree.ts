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
  sigtermSent: boolean;
  sigkillSent: boolean;
}

export interface ProcessKillError extends Error {
  code?: string;
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
    return { pid, sigtermSent: false, sigkillSent: false };
  }
  if (childHasExited(child)) {
    return { pid, sigtermSent: false, sigkillSent: false };
  }

  const kill = options?.kill ?? process.kill;
  const graceMs = options?.graceMs ?? 1_000;
  const sigtermSent = signalPidOrProcessGroup(pid, "SIGTERM", kill);
  if (options?.forceKillAfterGrace === false) {
    await waitForChildExit(child);
    return { pid, sigtermSent, sigkillSent: false };
  }
  await delay(graceMs);

  const sigkillSent = signalPidOrProcessGroup(pid, "SIGKILL", kill);
  if (!childHasExited(child)) {
    await Promise.race([waitForChildExit(child), delay(100)]);
  }
  return { pid, sigtermSent, sigkillSent };
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
  if (options !== undefined && "expectedIdentity" in options) {
    const expectedIdentity = options.expectedIdentity ?? null;
    if (expectedIdentity === null) {
      return { pid, sigtermSent: false, sigkillSent: false };
    }
    const probeIdentity = options.probeIdentity ?? readProcessIdentity;
    const observedIdentity = await probeIdentity(pid);
    if (observedIdentity === null) {
      if (!isPidDefinitelyAbsent(pid, kill)) {
        return { pid, sigtermSent: false, sigkillSent: false };
      }
    } else if (!processIdentityMatches(expectedIdentity, observedIdentity)) {
      return { pid, sigtermSent: false, sigkillSent: false };
    }
  }

  const sigtermSent = signalPidOrProcessGroup(pid, "SIGTERM", kill);
  await delay(graceMs);
  if (options !== undefined && "expectedIdentity" in options) {
    const expectedIdentity = options.expectedIdentity ?? null;
    if (expectedIdentity === null) {
      return { pid, sigtermSent, sigkillSent: false };
    }
    const probeIdentity = options.probeIdentity ?? readProcessIdentity;
    const observedIdentity = await probeIdentity(pid);
    if (observedIdentity === null) {
      if (!isPidDefinitelyAbsent(pid, kill)) {
        return { pid, sigtermSent, sigkillSent: false };
      }
    } else if (!processIdentityMatches(expectedIdentity, observedIdentity)) {
      return { pid, sigtermSent, sigkillSent: false };
    }
  }
  const sigkillSent = signalPidOrProcessGroup(pid, "SIGKILL", kill);
  return { pid, sigtermSent, sigkillSent };
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
  try {
    kill(-pid, signal);
    return true;
  } catch (groupError) {
    try {
      kill(pid, signal);
      return true;
    } catch (pidError) {
      return isNoSuchProcess(groupError) && isNoSuchProcess(pidError);
    }
  }
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

function isNoSuchProcess(error: unknown): boolean {
  return (
    error !== null &&
    typeof error === "object" &&
    "code" in error &&
    (error as ProcessKillError).code === "ESRCH"
  );
}
