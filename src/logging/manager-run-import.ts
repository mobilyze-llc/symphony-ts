import type {
  ManagerRunJournal,
  ManagerRunJournalEntry,
} from "../domain/model.js";

type DistributiveOmit<T, K extends PropertyKey> = T extends unknown
  ? Omit<T, K>
  : never;

type ManagerRunJournalEventInput = DistributiveOmit<
  ManagerRunJournalEntry,
  "sequence"
>;

export interface ManagerRunImportLedger {
  sourceSessionId: string | null;
  run: ManagerRunImportRun;
  lanes: ManagerRunImportLane[];
  runEvents: ManagerRunImportEvent[];
}

export interface ManagerRunImportRun {
  runId: string;
  managerThreadId: string;
  title: string;
  startedAt: string;
  idempotencyKey: string;
  summary: string;
}

export interface ManagerRunImportLane {
  laneId: string;
  workerThreadId: string;
  issueIdentifier: string;
  title: string;
  admittedAt: string;
  idempotencyKey: string;
  summary: string;
  events: ManagerRunImportEvent[];
}

export interface ManagerRunImportEvent {
  type: string;
  timestamp: string;
  idempotencyKey: string;
  summary: string;
  laneId?: string | null;
  [key: string]: unknown;
}

interface MaterializeEventContext {
  sourceSessionId: string | null;
  runId: string;
  defaultLaneId: string | null;
  defaultWorkerThreadId: string | null;
  defaultIssueIdentifier: string | null;
  location: string;
}

interface PendingJournalEntry {
  entry: ManagerRunJournalEventInput;
  order: number;
}

export function parseManagerRunImportLedger(
  raw: string,
): ManagerRunImportLedger {
  const parsed = JSON.parse(raw) as unknown;
  return normalizeLedger(parsed, "ledger");
}

export function importManagerRunLedger(
  ledger: ManagerRunImportLedger,
): ManagerRunJournal {
  const pending: PendingJournalEntry[] = [];
  let order = 0;

  pending.push({
    order: order++,
    entry: {
      type: "manager_run_started",
      runId: ledger.run.runId,
      sourceSessionId: ledger.sourceSessionId,
      timestamp: ledger.run.startedAt,
      idempotencyKey: ledger.run.idempotencyKey,
      summary: ledger.run.summary,
      managerThreadId: ledger.run.managerThreadId,
      title: ledger.run.title,
    },
  });

  for (const [laneIndex, lane] of ledger.lanes.entries()) {
    pending.push({
      order: order++,
      entry: {
        type: "worker_lane_admitted",
        runId: ledger.run.runId,
        sourceSessionId: ledger.sourceSessionId,
        timestamp: lane.admittedAt,
        idempotencyKey: lane.idempotencyKey,
        summary: lane.summary,
        laneId: lane.laneId,
        workerThreadId: lane.workerThreadId,
        issueIdentifier: lane.issueIdentifier,
        title: lane.title,
      },
    });

    for (const [eventIndex, event] of lane.events.entries()) {
      pending.push({
        order: order++,
        entry: materializeImportEvent(event, {
          sourceSessionId: ledger.sourceSessionId,
          runId: ledger.run.runId,
          defaultLaneId: lane.laneId,
          defaultWorkerThreadId: lane.workerThreadId,
          defaultIssueIdentifier: lane.issueIdentifier,
          location: `ledger.lanes[${laneIndex}].events[${eventIndex}]`,
        }),
      });
    }
  }

  for (const [eventIndex, event] of ledger.runEvents.entries()) {
    pending.push({
      order: order++,
      entry: materializeImportEvent(event, {
        sourceSessionId: ledger.sourceSessionId,
        runId: ledger.run.runId,
        defaultLaneId: null,
        defaultWorkerThreadId: null,
        defaultIssueIdentifier: null,
        location: `ledger.runEvents[${eventIndex}]`,
      }),
    });
  }

  return pending.sort(comparePendingEntries).map(({ entry }, index) => ({
    ...entry,
    sequence: index + 1,
  }));
}

export function renderManagerRunJournalJsonl(
  journal: ManagerRunJournal,
): string {
  if (journal.length === 0) {
    return "";
  }
  return `${journal.map((entry) => JSON.stringify(entry)).join("\n")}\n`;
}

function comparePendingEntries(
  left: PendingJournalEntry,
  right: PendingJournalEntry,
): number {
  const timestampComparison = left.entry.timestamp.localeCompare(
    right.entry.timestamp,
  );
  if (timestampComparison !== 0) {
    return timestampComparison;
  }
  return left.order - right.order;
}

function materializeImportEvent(
  event: ManagerRunImportEvent,
  context: MaterializeEventContext,
): ManagerRunJournalEventInput {
  if (
    event.type === "manager_run_started" ||
    event.type === "worker_lane_admitted"
  ) {
    throw new Error(
      `${context.location} must be expressed via run/lane headers, not ${event.type} events.`,
    );
  }

  const base = {
    type: event.type,
    runId: context.runId,
    sourceSessionId: context.sourceSessionId,
    timestamp: event.timestamp,
    idempotencyKey: event.idempotencyKey,
    summary: event.summary,
  } as const;

  switch (event.type) {
    case "issue_linked":
      return {
        ...base,
        type: "issue_linked",
        laneId: requireLaneId(event, context),
        issueId: optionalString(event.issueId),
        issueIdentifier:
          optionalString(event.issueIdentifier) ??
          requireDefaultIssueIdentifier(context),
        url: optionalString(event.url),
      };
    case "pr_linked":
      return {
        ...base,
        type: "pr_linked",
        laneId: requireLaneId(event, context),
        prNumber: optionalNumber(event.prNumber),
        url: expectString(event.url, `${context.location}.url`),
        status: expectOneOf(
          event.status,
          ["draft", "open", "merged", "closed"],
          `${context.location}.status`,
        ),
      };
    case "dependency_declared":
      return {
        ...base,
        type: "dependency_declared",
        laneId: requireLaneId(event, context),
        dependencyId: expectString(
          event.dependencyId,
          `${context.location}.dependencyId`,
        ),
        dependsOnLaneId: optionalString(event.dependsOnLaneId),
        dependsOnIssueIdentifier: optionalString(
          event.dependsOnIssueIdentifier,
        ),
        reason: expectString(event.reason, `${context.location}.reason`),
      };
    case "dependency_unblocked":
      return {
        ...base,
        type: "dependency_unblocked",
        dependencyId: expectString(
          event.dependencyId,
          `${context.location}.dependencyId`,
        ),
      };
    case "review_gate_started":
      return {
        ...base,
        type: "review_gate_started",
        laneId: requireLaneId(event, context),
        gateId: expectString(event.gateId, `${context.location}.gateId`),
        reviewer: expectString(event.reviewer, `${context.location}.reviewer`),
      };
    case "review_gate_result":
      return {
        ...base,
        type: "review_gate_result",
        laneId: requireLaneId(event, context),
        gateId: expectString(event.gateId, `${context.location}.gateId`),
        status: expectOneOf(
          event.status,
          ["passed", "failed", "degraded"],
          `${context.location}.status`,
        ),
        evidenceArtifactId: optionalString(event.evidenceArtifactId),
        compensationRequired: expectBoolean(
          event.compensationRequired,
          `${context.location}.compensationRequired`,
        ),
      };
    case "validation_artifact_added":
      return {
        ...base,
        type: "validation_artifact_added",
        laneId: optionalLaneId(event, context),
        artifactId: expectString(
          event.artifactId,
          `${context.location}.artifactId`,
        ),
        kind: expectOneOf(
          event.kind,
          [
            "test",
            "build",
            "lint",
            "typecheck",
            "review_compensation",
            "report",
            "other",
          ],
          `${context.location}.kind`,
        ),
        label: expectString(event.label, `${context.location}.label`),
        url: optionalString(event.url),
      };
    case "follow_up_spawned":
      return {
        ...base,
        type: "follow_up_spawned",
        laneId: optionalLaneId(event, context),
        issueIdentifier: expectString(
          event.issueIdentifier,
          `${context.location}.issueIdentifier`,
        ),
        title: expectString(event.title, `${context.location}.title`),
        parentIssueIdentifier: optionalString(event.parentIssueIdentifier),
        url: optionalString(event.url),
      };
    case "ownership_lease_acquired":
      return {
        ...base,
        type: "ownership_lease_acquired",
        leaseId: expectString(event.leaseId, `${context.location}.leaseId`),
        laneId: requireLaneId(event, context),
        ownerThreadId:
          optionalString(event.ownerThreadId) ??
          requireDefaultWorkerThreadId(context),
        expiresAt: expectString(
          event.expiresAt,
          `${context.location}.expiresAt`,
        ),
      };
    case "ownership_lease_released":
      return {
        ...base,
        type: "ownership_lease_released",
        leaseId: expectString(event.leaseId, `${context.location}.leaseId`),
        outcome: expectOneOf(
          event.outcome,
          ["completed", "expired", "transferred"],
          `${context.location}.outcome`,
        ),
      };
    case "heartbeat_recorded":
      return {
        ...base,
        type: "heartbeat_recorded",
        laneId: requireLaneId(event, context),
        workerThreadId:
          optionalString(event.workerThreadId) ??
          requireDefaultWorkerThreadId(context),
        status: expectOneOf(
          event.status,
          ["active", "blocked", "degraded", "closing"],
          `${context.location}.status`,
        ),
        note: optionalString(event.note),
      };
    case "escalation_raised":
      return {
        ...base,
        type: "escalation_raised",
        laneId: optionalLaneId(event, context),
        kind: expectOneOf(
          event.kind,
          [
            "stale_worker",
            "missing_evidence",
            "review_gate_degraded",
            "dependency_blocked",
            "ownership_conflict",
          ],
          `${context.location}.kind`,
        ),
        severity: expectOneOf(
          event.severity,
          ["warning", "critical"],
          `${context.location}.severity`,
        ),
        message: expectString(event.message, `${context.location}.message`),
      };
    case "terminal_condition_reported":
      return {
        ...base,
        type: "terminal_condition_reported",
        laneId: optionalLaneId(event, context),
        condition: expectOneOf(
          event.condition,
          ["lane_closed", "manager_closeout"],
          `${context.location}.condition`,
        ),
        requiredEvidence: expectStringArray(
          event.requiredEvidence,
          `${context.location}.requiredEvidence`,
        ),
        providedEvidence: expectStringArray(
          event.providedEvidence,
          `${context.location}.providedEvidence`,
        ),
      };
    case "model_check_requested":
      return {
        ...base,
        type: "model_check_requested",
        reason: expectOneOf(
          event.reason,
          ["ambiguity", "decision_quality_check"],
          `${context.location}.reason`,
        ),
        laneId: optionalLaneId(event, context),
        question: expectString(event.question, `${context.location}.question`),
      };
    default:
      throw new Error(
        `${context.location}.type is not supported: ${event.type}`,
      );
  }
}

function normalizeLedger(
  value: unknown,
  location: string,
): ManagerRunImportLedger {
  const record = expectRecord(value, location);
  return {
    sourceSessionId: nullableString(
      record.sourceSessionId,
      `${location}.sourceSessionId`,
    ),
    run: normalizeRun(record.run, `${location}.run`),
    lanes: expectArray(record.lanes, `${location}.lanes`).map((lane, index) =>
      normalizeLane(lane, `${location}.lanes[${index}]`),
    ),
    runEvents: expectArray(record.runEvents ?? [], `${location}.runEvents`).map(
      (event, index) =>
        normalizeEventRecord(event, `${location}.runEvents[${index}]`),
    ),
  };
}

function normalizeRun(value: unknown, location: string): ManagerRunImportRun {
  const record = expectRecord(value, location);
  return {
    runId: expectString(record.runId, `${location}.runId`),
    managerThreadId: expectString(
      record.managerThreadId,
      `${location}.managerThreadId`,
    ),
    title: expectString(record.title, `${location}.title`),
    startedAt: expectString(record.startedAt, `${location}.startedAt`),
    idempotencyKey: expectString(
      record.idempotencyKey,
      `${location}.idempotencyKey`,
    ),
    summary: expectString(record.summary, `${location}.summary`),
  };
}

function normalizeLane(value: unknown, location: string): ManagerRunImportLane {
  const record = expectRecord(value, location);
  return {
    laneId: expectString(record.laneId, `${location}.laneId`),
    workerThreadId: expectString(
      record.workerThreadId,
      `${location}.workerThreadId`,
    ),
    issueIdentifier: expectString(
      record.issueIdentifier,
      `${location}.issueIdentifier`,
    ),
    title: expectString(record.title, `${location}.title`),
    admittedAt: expectString(record.admittedAt, `${location}.admittedAt`),
    idempotencyKey: expectString(
      record.idempotencyKey,
      `${location}.idempotencyKey`,
    ),
    summary: expectString(record.summary, `${location}.summary`),
    events: expectArray(record.events ?? [], `${location}.events`).map(
      (event, index) =>
        normalizeEventRecord(event, `${location}.events[${index}]`),
    ),
  };
}

function normalizeEventRecord(
  value: unknown,
  location: string,
): ManagerRunImportEvent {
  const record = expectRecord(value, location);
  const normalizedBase = {
    ...record,
    type: expectString(record.type, `${location}.type`),
    timestamp: expectString(record.timestamp, `${location}.timestamp`),
    idempotencyKey: expectString(
      record.idempotencyKey,
      `${location}.idempotencyKey`,
    ),
    summary: expectString(record.summary, `${location}.summary`),
  };
  if (record.laneId !== undefined) {
    return {
      ...normalizedBase,
      laneId: nullableString(record.laneId, `${location}.laneId`),
    };
  }
  return normalizedBase;
}

function requireLaneId(
  event: ManagerRunImportEvent,
  context: MaterializeEventContext,
): string {
  if (event.laneId !== undefined && event.laneId !== context.defaultLaneId) {
    if (context.defaultLaneId === null) {
      return expectString(event.laneId, `${context.location}.laneId`);
    }
    throw new Error(
      `${context.location}.laneId must match ${context.defaultLaneId}.`,
    );
  }
  if (context.defaultLaneId !== null) {
    return context.defaultLaneId;
  }
  return expectString(event.laneId, `${context.location}.laneId`);
}

function optionalLaneId(
  event: ManagerRunImportEvent,
  context: MaterializeEventContext,
): string | null {
  if (event.laneId === undefined) {
    return context.defaultLaneId;
  }
  if (
    event.laneId !== context.defaultLaneId &&
    context.defaultLaneId !== null
  ) {
    throw new Error(
      `${context.location}.laneId must match ${context.defaultLaneId}.`,
    );
  }
  return event.laneId;
}

function requireDefaultWorkerThreadId(
  context: MaterializeEventContext,
): string {
  if (context.defaultWorkerThreadId === null) {
    throw new Error(`${context.location} requires workerThreadId.`);
  }
  return context.defaultWorkerThreadId;
}

function requireDefaultIssueIdentifier(
  context: MaterializeEventContext,
): string {
  if (context.defaultIssueIdentifier === null) {
    throw new Error(`${context.location} requires issueIdentifier.`);
  }
  return context.defaultIssueIdentifier;
}

function expectRecord(
  value: unknown,
  location: string,
): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${location} must be an object.`);
  }
  return value as Record<string, unknown>;
}

function expectArray(value: unknown, location: string): unknown[] {
  if (!Array.isArray(value)) {
    throw new Error(`${location} must be an array.`);
  }
  return value;
}

function expectString(value: unknown, location: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`${location} must be a non-empty string.`);
  }
  return value;
}

function nullableString(value: unknown, location: string): string | null {
  if (value === null) {
    return null;
  }
  return expectString(value, location);
}

function optionalString(value: unknown): string | null {
  if (value === undefined || value === null) {
    return null;
  }
  if (typeof value !== "string") {
    throw new Error("Expected string or null.");
  }
  return value;
}

function optionalNumber(value: unknown): number | null {
  if (value === undefined || value === null) {
    return null;
  }
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error("Expected number or null.");
  }
  return value;
}

function expectBoolean(value: unknown, location: string): boolean {
  if (typeof value !== "boolean") {
    throw new Error(`${location} must be a boolean.`);
  }
  return value;
}

function expectStringArray(value: unknown, location: string): string[] {
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
    throw new Error(`${location} must be an array of strings.`);
  }
  return [...value];
}

function expectOneOf<const T extends readonly string[]>(
  value: unknown,
  allowed: T,
  location: string,
): T[number] {
  if (typeof value !== "string" || !allowed.includes(value)) {
    throw new Error(`${location} must be one of: ${allowed.join(", ")}.`);
  }
  return value as T[number];
}
