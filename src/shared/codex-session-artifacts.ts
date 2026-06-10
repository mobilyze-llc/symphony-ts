import { join } from "node:path";

export function getDefaultCodexSessionArtifactDirectory(
  workspacePath: string,
): string {
  return join(workspacePath, ".symphony", "codex-sessions");
}

export function getDurableCodexSessionArtifactDirectory(
  workspaceRoot: string,
  workspaceKey: string,
): string {
  return join(workspaceRoot, ".symphony", "codex-sessions", workspaceKey);
}
