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
  if (pid === null) {
    return { pid, sigtermSent: false, sigkillSent: false };
  }

  const kill = options?.kill ?? process.kill;
  const graceMs = options?.graceMs ?? 1_000;
  const sigtermSent = signalPidOrProcessGroup(pid, "SIGTERM", kill);
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
  },
): Promise<ProcessTreeTerminationResult> {
  const kill = options?.kill ?? process.kill;
  const graceMs = options?.graceMs ?? 1_000;

  const sigtermSent = signalPidOrProcessGroup(pid, "SIGTERM", kill);
  await delay(graceMs);
  const sigkillSent = signalPidOrProcessGroup(pid, "SIGKILL", kill);
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

function childHasExited(
  child: Pick<ChildProcessForTermination, "exitCode" | "signalCode">,
): boolean {
  return child.exitCode !== null || child.signalCode !== null;
}

function isNoSuchProcess(error: unknown): boolean {
  return (
    error !== null &&
    typeof error === "object" &&
    "code" in error &&
    (error as ProcessKillError).code === "ESRCH"
  );
}
