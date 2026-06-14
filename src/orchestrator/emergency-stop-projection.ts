import type {
  OrchestratorState,
  PipelineEmergencyStopState,
} from "../domain/model.js";
import type { ProcessIdentitySnapshot } from "../shared/process-tree.js";

export type EmergencyStopProcessIdentityStatus =
  | "present"
  | "missing"
  | "mismatch";

export type EmergencyStopCleanupStatus =
  | "confirmed"
  | "unconfirmed"
  | "missing_identity"
  | "identity_mismatch";

export interface PublicEmergencyStopProcessIdentity {
  pid: number;
  process_group_id: number | null;
  session_id: number | null;
  started_at: string;
  command_present: boolean;
  launch_token_present: boolean;
}

export interface PublicEmergencyStopInterruptedIssue {
  issue_id: string;
  issue_identifier: string;
  stage: string | null;
  attempt: number | null;
  codex_app_server_pid: string | null;
  process_identity: PublicEmergencyStopProcessIdentity | null;
  /**
   * Static consistency of the captured identity payload. This is independent
   * from cleanup_status: confirmed cleanup can still report a mismatched
   * historical identity so operators see both signals.
   */
  identity_status: EmergencyStopProcessIdentityStatus;
  cleanup_status: EmergencyStopCleanupStatus;
  cleanup_status_reason: string;
}

type EmergencyStopInterruptedIssue =
  PipelineEmergencyStopState["interruptedIssues"][number];

export function projectEmergencyStopInterruptedIssue(
  issue: EmergencyStopInterruptedIssue,
  state: Pick<OrchestratorState, "resumeRequired" | "resumeRequiredMarks">,
): PublicEmergencyStopInterruptedIssue {
  const identityStatus = getEmergencyStopIdentityStatus(issue);
  const cleanupStatus = getEmergencyStopCleanupStatus(issue, state);
  return {
    issue_id: issue.issueId,
    issue_identifier: issue.issueIdentifier,
    stage: issue.stage,
    attempt: issue.attempt,
    codex_app_server_pid: issue.codexAppServerPid,
    process_identity: redactProcessIdentity(issue.codexAppServerIdentity),
    identity_status: identityStatus,
    cleanup_status: cleanupStatus,
    cleanup_status_reason: getEmergencyStopCleanupStatusReason(
      cleanupStatus,
      identityStatus,
    ),
  };
}

function redactProcessIdentity(
  identity: ProcessIdentitySnapshot | null,
): PublicEmergencyStopProcessIdentity | null {
  if (identity === null) {
    return null;
  }
  return {
    pid: identity.pid,
    process_group_id: identity.processGroupId,
    session_id: identity.sessionId,
    started_at: identity.startedAt,
    command_present: identity.command.trim().length > 0,
    launch_token_present: identity.launchToken !== null,
  };
}

function getEmergencyStopIdentityStatus(
  issue: EmergencyStopInterruptedIssue,
): EmergencyStopProcessIdentityStatus {
  const pid = parsePublicEmergencyStopPid(issue.codexAppServerPid);
  const identity = issue.codexAppServerIdentity;
  if (pid === null || identity === null) {
    return "missing";
  }
  // This public projection is a redacted, static consistency check over the
  // captured metadata. Live PID-reuse safety is enforced earlier during
  // cleanup by process-tree identity verification against a fresh probe.
  return identity.pid === pid && identity.processGroupId === pid
    ? "present"
    : "mismatch";
}

function getEmergencyStopCleanupStatus(
  issue: EmergencyStopInterruptedIssue,
  state: Pick<OrchestratorState, "resumeRequired" | "resumeRequiredMarks">,
): EmergencyStopCleanupStatus {
  const mark = state.resumeRequiredMarks[issue.issueId];
  if (
    mark?.reason === "killed_mid_run" ||
    !state.resumeRequired.has(issue.issueId)
  ) {
    return "confirmed";
  }

  const identityStatus = getEmergencyStopIdentityStatus(issue);
  if (identityStatus === "missing") {
    return "missing_identity";
  }
  if (identityStatus === "mismatch") {
    return "identity_mismatch";
  }
  return "unconfirmed";
}

function getEmergencyStopCleanupStatusReason(
  cleanupStatus: EmergencyStopCleanupStatus,
  identityStatus: EmergencyStopProcessIdentityStatus,
): string {
  switch (cleanupStatus) {
    case "confirmed":
      return identityStatus === "mismatch"
        ? "Cleanup proof is confirmed, but captured process identity does not match the tracked app-server PID; see identity_status."
        : identityStatus === "missing"
          ? "Cleanup proof is confirmed, but no captured process identity was available; see identity_status."
          : "Cleanup proof is confirmed; process identity is redacted for display.";
    case "missing_identity":
      return "Cleanup remains unconfirmed because the interrupted issue lacks a usable captured process identity.";
    case "identity_mismatch":
      return "Cleanup remains unconfirmed because the captured process identity does not match the tracked app-server PID.";
    case "unconfirmed":
      return identityStatus === "present"
        ? "Cleanup is still awaiting confirmation for the captured process identity."
        : "Cleanup is still awaiting confirmation.";
  }
}

function parsePublicEmergencyStopPid(value: string | null): number | null {
  if (value === null || !/^\d+$/.test(value)) {
    return null;
  }
  const pid = Number(value);
  return Number.isSafeInteger(pid) && pid > 1 && pid !== process.pid
    ? pid
    : null;
}
