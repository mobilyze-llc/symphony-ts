import { execFile as execFileCb } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFileCb);

/** Runs ops/claude-usage --json and returns parsed output. */
export async function fetchClaudeUsageFromCli(): Promise<
  Record<string, unknown>
> {
  const { stdout } = await execFileAsync("ops/claude-usage", ["--json"]);
  return JSON.parse(stdout) as Record<string, unknown>;
}
