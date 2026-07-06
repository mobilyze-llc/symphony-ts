import { createHash } from "node:crypto";
import type { CollectedEntry } from "../../src/stage-execution/collected-artifact.js";
import type { CrabrunnerTerminalEvidence } from "../../src/stage-execution/crabrunner-backend.js";
type ReadyArtifact = NonNullable<CrabrunnerTerminalEvidence["artifact"]>;
export function readyCollectedArtifact(
  name: string,
  content: string,
  jobId = "job-1",
  entries: readonly CollectedEntry[] = [],
): ReadyArtifact {
  return {
    status: "ready",
    jobId,
    primary: { name, content, hash: sha256(content) },
    entries: [...entries],
  };
}
export function materializedReady(
  jobId: string,
  name = "artifact/result.md",
  content = '{"ok":true}\n',
  entries: readonly CollectedEntry[] = [],
): ReadyArtifact {
  return readyCollectedArtifact(name, content, jobId, entries);
}
export function artifactEntry(name: string, content: string): CollectedEntry {
  return { name, content, hash: sha256(content) };
}

export function usageEntry(name: string, payload: unknown): CollectedEntry {
  return artifactEntry(name, JSON.stringify(payload));
}

function sha256(content: string | Buffer): string {
  return createHash("sha256").update(content).digest("hex");
}
