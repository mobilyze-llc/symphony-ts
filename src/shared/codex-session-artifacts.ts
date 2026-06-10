import { join } from "node:path";

export function getDefaultCodexSessionArtifactDirectory(
  workspacePath: string,
): string {
  return join(workspacePath, ".symphony", "codex-sessions");
}
