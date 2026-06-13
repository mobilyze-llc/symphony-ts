export interface ProcessTreeTerminationResult {
  pid: number | null;
  sigtermSent: boolean;
  sigkillSent: boolean;
}

export interface ProcessKillError extends Error {
  code?: string;
}

export type ProcessKill = typeof process.kill;

export interface ChildProcessForTermination {
  exitCode: number | null;
  signalCode: NodeJS.Signals | null;
  pid?: number | undefined;
  once(event: "exit", listener: () => void): unknown;
}

export async function terminateChildProcessTree(
  child: ChildProcessForTermination,
  options?: {
    graceMs?: number;
    kill?: ProcessKill;
  },
): Promise<ProcessTreeTerminationResult> {
  const pid = child.pid ?? null;
  if (pid === null || childHasExited(child)) {
    return { pid, sigtermSent: false, sigkillSent: false };
  }

  const kill = options?.kill ?? process.kill;
  const graceMs = options?.graceMs ?? 1_000;
  const sigtermSent = signalPidOrProcessGroup(pid, "SIGTERM", kill);
  await Promise.race([waitForChildExit(child), delay(graceMs)]);

  if (childHasExited(child)) {
    return { pid, sigtermSent, sigkillSent: false };
  }

  const sigkillSent = signalPidOrProcessGroup(pid, "SIGKILL", kill);
  await Promise.race([waitForChildExit(child), delay(100)]);
  return { pid, sigtermSent, sigkillSent };
}

export async function terminateDetachedPidTree(
  pid: number,
  options?: {
    graceMs?: number;
    kill?: ProcessKill;
    isAlive?: (pid: number) => boolean;
  },
): Promise<ProcessTreeTerminationResult> {
  const kill = options?.kill ?? process.kill;
  const isAlive = options?.isAlive ?? defaultIsAlive;
  const graceMs = options?.graceMs ?? 1_000;

  const sigtermSent = signalPidOrProcessGroup(pid, "SIGTERM", kill);
  await delay(graceMs);
  const sigkillSent =
    isAlive(pid) && signalPidOrProcessGroup(pid, "SIGKILL", kill);
  return { pid, sigtermSent, sigkillSent };
}

export function signalPidOrProcessGroup(
  pid: number,
  signal: NodeJS.Signals,
  kill: ProcessKill = process.kill,
): boolean {
  try {
    kill(-pid, signal);
    return true;
  } catch (error) {
    if (isNoSuchProcess(error)) {
      try {
        kill(pid, signal);
        return true;
      } catch (innerError) {
        return isNoSuchProcess(innerError);
      }
    }
    return false;
  }
}

function childHasExited(
  child: Pick<ChildProcessForTermination, "exitCode" | "signalCode">,
): boolean {
  return child.exitCode !== null || child.signalCode !== null;
}

function defaultIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
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

function isNoSuchProcess(error: unknown): boolean {
  return (
    error !== null &&
    typeof error === "object" &&
    "code" in error &&
    (error as ProcessKillError).code === "ESRCH"
  );
}
