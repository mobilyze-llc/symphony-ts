import type {
  ManagerModelCheckReason,
  ManagerRunJournal,
  ManagerRunJournalEntry,
  ManagerRunLaneState,
  ManagerRunState,
  ManagerWorkerLaneStatus,
} from "../domain/model.js";

const MODEL_CHECK_ALLOWED_REASONS: ManagerModelCheckReason[] = [
  "ambiguity",
  "decision_quality_check",
];

export const DEFAULT_MANAGER_RUN_STALE_AFTER_MS = 20 * 60_000;

export function createEmptyManagerRunState(runId: string): ManagerRunState {
  return {
    runId,
    managerThreadId: null,
    title: null,
    startedAt: null,
    lanes: {},
    dependencies: {},
    reviewGates: {},
    validationArtifacts: {},
    followUps: {},
    ownershipLeases: {},
    escalations: [],
    modelCallPolicy: {
      ledgerIsSourceOfTruth: true,
      allowedReasons: [...MODEL_CHECK_ALLOWED_REASONS],
      pendingChecks: [],
    },
    closeout: {
      ready: false,
      missingEvidence: ["manager_run_started"],
    },
    journal: [],
  };
}

export function reduceManagerRunJournal(
  journal: ManagerRunJournal,
  options?: {
    now?: Date;
    staleAfterMs?: number;
  },
): Record<string, ManagerRunState> {
  const states: Record<string, ManagerRunState> = {};
  const seen = new Set<string>();
  const sorted = [...journal].sort(
    (left, right) => left.sequence - right.sequence,
  );

  for (const event of sorted) {
    if (seen.has(event.idempotencyKey)) {
      continue;
    }
    seen.add(event.idempotencyKey);
    const state =
      states[event.runId] ?? createEmptyManagerRunState(event.runId);
    states[event.runId] = reduceManagerRunEvent(state, event);
  }

  for (const state of Object.values(states)) {
    markStaleLanes(state, {
      now: options?.now ?? new Date(),
      staleAfterMs: options?.staleAfterMs ?? DEFAULT_MANAGER_RUN_STALE_AFTER_MS,
    });
    recomputeLaneStatuses(state);
    recomputeCloseout(state);
  }

  return states;
}

export function reduceManagerRunEvent(
  state: ManagerRunState,
  event: ManagerRunJournalEntry,
): ManagerRunState {
  state.journal = appendEvent(state.journal, event);

  switch (event.type) {
    case "manager_run_started":
      state.managerThreadId = event.managerThreadId;
      state.title = event.title;
      state.startedAt = event.timestamp;
      break;
    case "worker_lane_admitted":
      state.lanes[event.laneId] = {
        laneId: event.laneId,
        workerThreadId: event.workerThreadId,
        issueIdentifier: event.issueIdentifier,
        title: event.title,
        status: "active",
        blockedBy: [],
        degradedReasons: [],
        lastHeartbeatAt: null,
        prUrl: null,
        prStatus: null,
        validationArtifactIds: [],
        reviewGateIds: [],
        followUpIssueIdentifiers: [],
      };
      break;
    case "issue_linked":
      ensureLane(state, event.laneId, event.issueIdentifier).issueIdentifier =
        event.issueIdentifier;
      break;
    case "pr_linked": {
      const lane = ensureLane(state, event.laneId, event.laneId);
      lane.prUrl = event.url;
      lane.prStatus = event.status;
      break;
    }
    case "dependency_declared": {
      state.dependencies[event.dependencyId] = {
        dependencyId: event.dependencyId,
        laneId: event.laneId,
        dependsOnLaneId: event.dependsOnLaneId,
        dependsOnIssueIdentifier: event.dependsOnIssueIdentifier,
        reason: event.reason,
        unblocked: false,
      };
      const lane = ensureLane(state, event.laneId, event.laneId);
      if (!lane.blockedBy.includes(event.dependencyId)) {
        lane.blockedBy.push(event.dependencyId);
      }
      break;
    }
    case "dependency_unblocked": {
      const dependency = state.dependencies[event.dependencyId];
      if (dependency !== undefined) {
        dependency.unblocked = true;
        const lane = state.lanes[dependency.laneId];
        if (lane !== undefined) {
          lane.blockedBy = lane.blockedBy.filter(
            (id) => id !== event.dependencyId,
          );
        }
      }
      break;
    }
    case "review_gate_started": {
      state.reviewGates[event.gateId] = {
        gateId: event.gateId,
        laneId: event.laneId,
        reviewer: event.reviewer,
        status: "started",
        evidenceArtifactId: null,
        compensationRequired: false,
        compensated: false,
      };
      const lane = ensureLane(state, event.laneId, event.laneId);
      if (!lane.reviewGateIds.includes(event.gateId)) {
        lane.reviewGateIds.push(event.gateId);
      }
      break;
    }
    case "review_gate_result": {
      const gate = state.reviewGates[event.gateId] ?? {
        gateId: event.gateId,
        laneId: event.laneId,
        reviewer: null,
        status: event.status,
        evidenceArtifactId: null,
        compensationRequired: false,
        compensated: false,
      };
      gate.status = event.status;
      gate.evidenceArtifactId = event.evidenceArtifactId;
      gate.compensationRequired =
        event.compensationRequired || event.status === "degraded";
      state.reviewGates[event.gateId] = gate;
      const lane = ensureLane(state, event.laneId, event.laneId);
      if (!lane.reviewGateIds.includes(event.gateId)) {
        lane.reviewGateIds.push(event.gateId);
      }
      if (event.status === "degraded") {
        addDegradedReason(lane, `review_gate_degraded:${event.gateId}`);
        state.modelCallPolicy.pendingChecks.push({
          reason: "decision_quality_check",
          laneId: event.laneId,
          question: `Review gate ${event.gateId} degraded; verify compensation quality.`,
          requestedAt: event.timestamp,
        });
      }
      if (event.status === "failed") {
        addDegradedReason(lane, `review_gate_failed:${event.gateId}`);
      }
      break;
    }
    case "validation_artifact_added": {
      state.validationArtifacts[event.artifactId] = {
        artifactId: event.artifactId,
        laneId: event.laneId,
        kind: event.kind,
        label: event.label,
        url: event.url,
      };
      if (event.laneId !== null) {
        const lane = ensureLane(state, event.laneId, event.laneId);
        if (!lane.validationArtifactIds.includes(event.artifactId)) {
          lane.validationArtifactIds.push(event.artifactId);
        }
        if (event.kind === "review_compensation") {
          markReviewGateCompensated(state, event.laneId);
          lane.degradedReasons = lane.degradedReasons.filter(
            (reason) => !reason.startsWith("review_gate_degraded:"),
          );
        }
      }
      break;
    }
    case "follow_up_spawned": {
      state.followUps[event.issueIdentifier] = {
        issueIdentifier: event.issueIdentifier,
        title: event.title,
        parentIssueIdentifier: event.parentIssueIdentifier,
        laneId: event.laneId,
        url: event.url,
      };
      if (event.laneId !== null) {
        const lane = ensureLane(state, event.laneId, event.laneId);
        if (!lane.followUpIssueIdentifiers.includes(event.issueIdentifier)) {
          lane.followUpIssueIdentifiers.push(event.issueIdentifier);
        }
      }
      break;
    }
    case "ownership_lease_acquired":
      state.ownershipLeases[event.leaseId] = {
        leaseId: event.leaseId,
        laneId: event.laneId,
        ownerThreadId: event.ownerThreadId,
        status: "active",
        expiresAt: event.expiresAt,
      };
      break;
    case "ownership_lease_released": {
      const lease = state.ownershipLeases[event.leaseId];
      if (lease !== undefined) {
        lease.status = event.outcome;
      }
      break;
    }
    case "heartbeat_recorded": {
      const lane = ensureLane(state, event.laneId, event.laneId);
      lane.workerThreadId = event.workerThreadId;
      lane.lastHeartbeatAt = event.timestamp;
      if (event.status === "closing") {
        lane.status = "closed";
      } else if (event.status === "degraded") {
        addDegradedReason(lane, "heartbeat_degraded");
      }
      break;
    }
    case "escalation_raised":
      state.escalations.push({
        laneId: event.laneId,
        kind: event.kind,
        severity: event.severity,
        message: event.message,
        raisedAt: event.timestamp,
      });
      if (event.laneId !== null) {
        const lane = ensureLane(state, event.laneId, event.laneId);
        addDegradedReason(lane, event.kind);
      }
      break;
    case "terminal_condition_reported":
      if (event.laneId !== null) {
        const lane = ensureLane(state, event.laneId, event.laneId);
        lane.status = "closed";
      }
      state.closeout.missingEvidence = sortedDifference(
        event.requiredEvidence,
        event.providedEvidence,
      );
      state.closeout.ready = state.closeout.missingEvidence.length === 0;
      break;
    case "model_check_requested":
      if (!MODEL_CHECK_ALLOWED_REASONS.includes(event.reason)) {
        break;
      }
      state.modelCallPolicy.pendingChecks.push({
        reason: event.reason,
        laneId: event.laneId,
        question: event.question,
        requestedAt: event.timestamp,
      });
      break;
  }

  recomputeLaneStatuses(state);
  recomputeCloseout(state);
  return state;
}

function appendEvent(
  journal: ManagerRunJournal,
  event: ManagerRunJournalEntry,
): ManagerRunJournal {
  if (journal.some((entry) => entry.idempotencyKey === event.idempotencyKey)) {
    return journal;
  }
  return [...journal, event];
}

function ensureLane(
  state: ManagerRunState,
  laneId: string,
  issueIdentifier: string,
): ManagerRunLaneState {
  const existing = state.lanes[laneId];
  if (existing !== undefined) {
    return existing;
  }
  const lane: ManagerRunLaneState = {
    laneId,
    workerThreadId: laneId,
    issueIdentifier,
    title: issueIdentifier,
    status: "active",
    blockedBy: [],
    degradedReasons: [],
    lastHeartbeatAt: null,
    prUrl: null,
    prStatus: null,
    validationArtifactIds: [],
    reviewGateIds: [],
    followUpIssueIdentifiers: [],
  };
  state.lanes[laneId] = lane;
  return lane;
}

function recomputeLaneStatuses(state: ManagerRunState): void {
  for (const lane of Object.values(state.lanes)) {
    if (lane.status === "closed") {
      continue;
    }
    lane.status = deriveLaneStatus(lane);
  }
}

function deriveLaneStatus(lane: ManagerRunLaneState): ManagerWorkerLaneStatus {
  if (lane.blockedBy.length > 0) {
    return "blocked";
  }
  if (lane.degradedReasons.length > 0) {
    return "degraded";
  }
  return "active";
}

function recomputeCloseout(state: ManagerRunState): void {
  const missing = new Set(state.closeout.missingEvidence);
  if (state.managerThreadId === null) {
    missing.add("manager_run_started");
  } else {
    missing.delete("manager_run_started");
  }

  for (const lane of Object.values(state.lanes)) {
    const lanePrefix = `lane:${lane.laneId}`;
    if (lane.prUrl === null) {
      missing.add(`${lanePrefix}:pr`);
    } else {
      missing.delete(`${lanePrefix}:pr`);
    }
    if (lane.validationArtifactIds.length === 0) {
      missing.add(`${lanePrefix}:validation`);
    } else {
      missing.delete(`${lanePrefix}:validation`);
    }
    if (lane.reviewGateIds.length === 0) {
      missing.add(`${lanePrefix}:review_gate`);
    } else {
      missing.delete(`${lanePrefix}:review_gate`);
    }
    if (lane.status === "blocked") {
      missing.add(`${lanePrefix}:dependency`);
    } else {
      missing.delete(`${lanePrefix}:dependency`);
    }
    if (lane.status === "degraded") {
      missing.add(`${lanePrefix}:degraded_compensation`);
    } else {
      missing.delete(`${lanePrefix}:degraded_compensation`);
    }
  }

  for (const gate of Object.values(state.reviewGates)) {
    const key = `gate:${gate.gateId}:compensation`;
    if (gate.compensationRequired && !gate.compensated) {
      missing.add(key);
    } else {
      missing.delete(key);
    }
  }

  for (const lease of Object.values(state.ownershipLeases)) {
    const key = `lease:${lease.leaseId}:released`;
    if (lease.status === "active") {
      missing.add(key);
    } else {
      missing.delete(key);
    }
  }

  state.closeout.missingEvidence = [...missing].sort(compareStrings);
  state.closeout.ready = state.closeout.missingEvidence.length === 0;
}

function markStaleLanes(
  state: ManagerRunState,
  input: { now: Date; staleAfterMs: number },
): void {
  for (const lane of Object.values(state.lanes)) {
    if (lane.status === "closed" || lane.lastHeartbeatAt === null) {
      continue;
    }
    const lastHeartbeatMs = Date.parse(lane.lastHeartbeatAt);
    if (!Number.isFinite(lastHeartbeatMs)) {
      continue;
    }
    if (input.now.getTime() - lastHeartbeatMs <= input.staleAfterMs) {
      continue;
    }
    addDegradedReason(lane, "stale_heartbeat");
    const alreadyEscalated = state.escalations.some(
      (escalation) =>
        escalation.laneId === lane.laneId && escalation.kind === "stale_worker",
    );
    if (!alreadyEscalated) {
      state.escalations.push({
        laneId: lane.laneId,
        kind: "stale_worker",
        severity: "warning",
        message: `${lane.issueIdentifier} has not produced a heartbeat within the stale threshold.`,
        raisedAt: input.now.toISOString(),
      });
    }
  }
}

function markReviewGateCompensated(
  state: ManagerRunState,
  laneId: string,
): void {
  for (const gate of Object.values(state.reviewGates)) {
    if (gate.laneId === laneId && gate.compensationRequired) {
      gate.compensated = true;
    }
  }
}

function addDegradedReason(lane: ManagerRunLaneState, reason: string): void {
  if (!lane.degradedReasons.includes(reason)) {
    lane.degradedReasons.push(reason);
    lane.degradedReasons.sort(compareStrings);
  }
}

function sortedDifference(left: readonly string[], right: readonly string[]) {
  const rightSet = new Set(right);
  return [...new Set(left)]
    .filter((value) => !rightSet.has(value))
    .sort(compareStrings);
}

function compareStrings(left: string, right: string): number {
  return left.localeCompare(right, "en");
}
