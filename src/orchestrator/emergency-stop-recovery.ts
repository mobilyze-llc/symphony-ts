import type { DispatcherRunJournal } from "../domain/model.js";
import type { StructuredLogger } from "../logging/structured-logger.js";
import { readProcessIdentityMetadata } from "../shared/process-tree.js";
import type { ProcessIdentitySnapshot } from "../shared/process-tree.js";
import type { StageExecutionBackendRunner } from "../stage-execution/backend.js";
import type { CrabrunnerCancellationRequest } from "../stage-execution/crabrunner-backend.js";
import type { StopRequest } from "./core.js";
import {
  isCancellableCrabrunnerBackend,
  laneCancellationToStopSignalDelivery,
  normalizeLaneCancellation,
} from "./lane-cancellation.js";
import { isEmergencyStopTerminationConfirmed } from "./stop-signal-delivery.js";

interface EmergencyStopInterruptedIssue {
  issueId: string;
  issueIdentifier: string;
  codexAppServerPid: string | null;
  codexAppServerIdentity: ProcessIdentitySnapshot | null;
  laneJobId: string | null;
  laneCancellationSupported: boolean;
}

export interface EmergencyStopRecoveryCleanupPlan {
  issueId: string;
  issueIdentifier: string;
  codexAppServerPid: string | null;
  codexAppServerIdentity: ProcessIdentitySnapshot | null;
  laneJobId: string | null;
  laneCancellationSupported: boolean;
  setBySequence: number;
  since: string;
}

export function collectUnconfirmedEmergencyStopCleanupPlans(
  journal: DispatcherRunJournal,
): EmergencyStopRecoveryCleanupPlan[] {
  const pendingPlansByIssue = new Map<
    string,
    EmergencyStopRecoveryCleanupPlan[]
  >();
  const plansByKey = new Map<string, EmergencyStopRecoveryCleanupPlan>();
  const provenPlanKeys = new Set<string>();

  for (const entry of [...journal].sort((a, b) => a.sequence - b.sequence)) {
    if (
      entry.kind === "intent" &&
      entry.metadata.status === "applied" &&
      entry.metadata.verb === "pipeline_stop"
    ) {
      for (const issue of readEmergencyStopInterruptedIssues(entry.metadata)) {
        const plan: EmergencyStopRecoveryCleanupPlan = {
          issueId: issue.issueId,
          issueIdentifier: issue.issueIdentifier,
          codexAppServerPid: issue.codexAppServerPid,
          codexAppServerIdentity: issue.codexAppServerIdentity,
          laneJobId: issue.laneJobId ?? null,
          laneCancellationSupported: issue.laneCancellationSupported,
          setBySequence: entry.sequence,
          since: entry.timestamp,
        };
        const plans = pendingPlansByIssue.get(issue.issueId) ?? [];
        plans.push(plan);
        pendingPlansByIssue.set(issue.issueId, plans);
        plansByKey.set(
          emergencyStopCleanupPlanKey(issue.issueId, entry.sequence),
          plan,
        );
      }
      continue;
    }

    if (
      entry.kind !== "hard_stop_trigger" ||
      entry.metadata.status !== "completed" ||
      entry.metadata.reason !== "emergency_stop"
    ) {
      continue;
    }

    const sourceSequence = readEmergencyStopSourceSequence(entry.metadata);
    if (sourceSequence !== null) {
      provenPlanKeys.add(
        emergencyStopCleanupPlanKey(entry.issueId, sourceSequence),
      );
      continue;
    }

    const pendingPlans = pendingPlansByIssue.get(entry.issueId) ?? [];
    for (let index = pendingPlans.length - 1; index >= 0; index -= 1) {
      const plan = pendingPlans[index];
      if (plan === undefined) {
        continue;
      }
      const key = emergencyStopCleanupPlanKey(plan.issueId, plan.setBySequence);
      if (!provenPlanKeys.has(key)) {
        provenPlanKeys.add(key);
        break;
      }
    }
  }

  return [...plansByKey.entries()].flatMap(([key, plan]) =>
    provenPlanKeys.has(key) ? [] : [plan],
  );
}

export function parseProcessPid(value: string | null): number | null {
  if (value === null || !/^\d+$/.test(value)) {
    return null;
  }
  const pid = Number(value);
  return Number.isSafeInteger(pid) && pid > 0 ? pid : null;
}

function emergencyStopCleanupPlanKey(
  issueId: string,
  sourceSequence: number,
): string {
  return `${issueId}:${sourceSequence}`;
}

function readEmergencyStopSourceSequence(
  metadata: Record<string, unknown>,
): number | null {
  const value = metadata.sourceSequence;
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0
    ? value
    : null;
}

export async function recoverEmergencyStopLaneCancellation(input: {
  backend: StageExecutionBackendRunner | undefined;
  laneJobId: string;
  issueId: string;
  issueIdentifier: string;
  sourceSequence: number;
  now: () => Date;
  logger: StructuredLogger | null;
}): Promise<boolean | null> {
  if (
    input.backend === undefined ||
    !isCancellableCrabrunnerBackend(input.backend)
  ) {
    await input.logger?.warn(
      "emergency_stop_recovery_lane_unavailable",
      "Emergency-stop recovery could not access a cancellable crabrunner backend for the persisted lane job.",
      {
        outcome: "degraded",
        issue_id: input.issueId,
        issue_identifier: input.issueIdentifier,
        lane_job_id: input.laneJobId,
        source_sequence: input.sourceSequence,
      },
    );
    return null;
  }
  const backend = input.backend;

  const request: CrabrunnerCancellationRequest = {
    reason: "operator_stop",
    signal: "SIGTERM",
    processGroup: true,
    killGraceMs: 1_000,
  };
  const evidence = await normalizeLaneCancellation(
    (jobId, cancellationRequest) => backend.cancel(jobId, cancellationRequest),
    input.laneJobId,
    request,
  );
  const delivery = laneCancellationToStopSignalDelivery(
    input.laneJobId,
    {
      issueId: input.issueId,
      issueIdentifier: input.issueIdentifier,
      cleanupWorkspace: false,
      reason: "emergency_stop",
    } satisfies StopRequest,
    evidence,
    input.now(),
  );
  const confirmed = isEmergencyStopTerminationConfirmed(delivery);
  if (confirmed) {
    await input.logger?.log(
      "info",
      "emergency_stop_recovery_lane_cancelled",
      `Confirmed recovered emergency-stop lane cancellation for ${input.issueIdentifier}.`,
      {
        issue_id: input.issueId,
        issue_identifier: input.issueIdentifier,
        lane_job_id: input.laneJobId,
        source_sequence: input.sourceSequence,
        signal_delivery_status: delivery.status,
      },
    );
  } else {
    await input.logger?.warn(
      "emergency_stop_recovery_lane_unconfirmed",
      "Emergency-stop recovery could not confirm persisted crabrunner lane cancellation.",
      {
        outcome: "degraded",
        issue_id: input.issueId,
        issue_identifier: input.issueIdentifier,
        lane_job_id: input.laneJobId,
        source_sequence: input.sourceSequence,
        signal_delivery_status: delivery.status,
        warning: delivery.warning,
      },
    );
  }
  return confirmed;
}

function readEmergencyStopInterruptedIssues(
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
        laneCancellationSupported: item.laneCancellationSupported === true,
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
