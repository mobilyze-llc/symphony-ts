import { readProcessIdentityMetadata } from "../shared/process-tree.js";
import type { ProcessIdentitySnapshot } from "../shared/process-tree.js";

export interface EmergencyStopInterruptedIssue {
  issueId: string;
  issueIdentifier: string;
  codexAppServerPid: string | null;
  codexAppServerIdentity: ProcessIdentitySnapshot | null;
  laneJobId: string | null;
}

export function readEmergencyStopInterruptedIssues(
  metadata: Record<string, unknown>,
): EmergencyStopInterruptedIssue[] {
  const value = metadata.interruptedIssues;
  if (!Array.isArray(value)) {
    return [];
  }
  return value.flatMap((item) => {
    if (!isRecord(item)) {
      return [];
    }
    const issueId = item.issueId;
    const issueIdentifier = item.issueIdentifier;
    if (typeof issueId !== "string" || typeof issueIdentifier !== "string") {
      return [];
    }
    const codexAppServerPid = item.codexAppServerPid;
    return [
      {
        issueId,
        issueIdentifier,
        codexAppServerPid:
          typeof codexAppServerPid === "string" &&
          codexAppServerPid.trim() !== ""
            ? codexAppServerPid
            : null,
        codexAppServerIdentity: readProcessIdentityMetadata(
          item.codexAppServerIdentity,
        ),
        laneJobId: nonBlankString(item.laneJobId),
      },
    ];
  });
}

function nonBlankString(value: unknown): string | null {
  return typeof value === "string" && value.trim() !== "" ? value : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
