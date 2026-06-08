import { promises as fs } from "node:fs";
import { join } from "node:path";

import {
  MANAGER_RUN_EVENT_TYPES,
  type ManagerRunJournal,
  type ManagerRunJournalEntry,
} from "../domain/model.js";

const MANAGER_RUN_JOURNAL_DIR = join(".symphony", "run-journals");
const MANAGER_RUN_JOURNAL_FILENAME = "manager-runs.jsonl";

export function getManagerRunJournalPath(workspaceRoot: string): string {
  return join(
    workspaceRoot,
    MANAGER_RUN_JOURNAL_DIR,
    MANAGER_RUN_JOURNAL_FILENAME,
  );
}

export function appendManagerRunJournalEntry(
  journal: ManagerRunJournal,
  entry: Omit<ManagerRunJournalEntry, "sequence">,
): {
  journal: ManagerRunJournal;
  entry: ManagerRunJournalEntry;
  appended: boolean;
} {
  const existing = journal.find(
    (candidate) => candidate.idempotencyKey === entry.idempotencyKey,
  );
  if (existing !== undefined) {
    return { journal, entry: existing, appended: false };
  }

  const nextEntry = {
    ...entry,
    sequence: (journal.at(-1)?.sequence ?? 0) + 1,
  } as ManagerRunJournalEntry;
  return {
    journal: [...journal, nextEntry],
    entry: nextEntry,
    appended: true,
  };
}

export async function readManagerRunJournal(
  workspaceRoot: string,
): Promise<ManagerRunJournal> {
  const artifactPath = getManagerRunJournalPath(workspaceRoot);
  let raw: string;
  try {
    raw = await fs.readFile(artifactPath, "utf8");
  } catch (error) {
    if (isMissingPathError(error)) {
      return [];
    }
    throw error;
  }

  const entries: ManagerRunJournal = [];
  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (trimmed.length === 0) {
      continue;
    }
    try {
      const parsed = JSON.parse(trimmed) as unknown;
      if (isManagerRunJournalEntry(parsed)) {
        entries.push(parsed);
      }
    } catch {
      // Ignore malformed rows so one bad line does not block recovery.
    }
  }

  return entries.sort((left, right) => left.sequence - right.sequence);
}

export async function appendManagerRunJournalEntryToDisk(
  workspaceRoot: string,
  entry: ManagerRunJournalEntry,
): Promise<void> {
  const artifactPath = getManagerRunJournalPath(workspaceRoot);
  await fs.mkdir(join(workspaceRoot, MANAGER_RUN_JOURNAL_DIR), {
    recursive: true,
  });
  await fs.appendFile(artifactPath, `${JSON.stringify(entry)}\n`, "utf8");
}

export function isManagerRunJournalEntry(
  value: unknown,
): value is ManagerRunJournalEntry {
  if (!isRecord(value)) {
    return false;
  }
  return (
    typeof value.sequence === "number" &&
    typeof value.idempotencyKey === "string" &&
    typeof value.timestamp === "string" &&
    typeof value.runId === "string" &&
    (value.sourceSessionId === null ||
      typeof value.sourceSessionId === "string") &&
    typeof value.summary === "string" &&
    typeof value.type === "string" &&
    MANAGER_RUN_EVENT_TYPES.includes(
      value.type as ManagerRunJournalEntry["type"],
    ) &&
    hasTypeSpecificFields(value)
  );
}

function hasTypeSpecificFields(value: Record<string, unknown>): boolean {
  switch (value.type) {
    case "manager_run_started":
      return (
        typeof value.managerThreadId === "string" &&
        typeof value.title === "string"
      );
    case "worker_lane_admitted":
      return (
        typeof value.laneId === "string" &&
        typeof value.workerThreadId === "string" &&
        typeof value.issueIdentifier === "string" &&
        typeof value.title === "string"
      );
    case "issue_linked":
      return (
        typeof value.laneId === "string" &&
        (value.issueId === null || typeof value.issueId === "string") &&
        typeof value.issueIdentifier === "string" &&
        (value.url === null || typeof value.url === "string")
      );
    case "pr_linked":
      return (
        typeof value.laneId === "string" &&
        (value.prNumber === null || typeof value.prNumber === "number") &&
        typeof value.url === "string" &&
        isStringIn(value.status, ["draft", "open", "merged", "closed"])
      );
    case "dependency_declared":
      return (
        typeof value.laneId === "string" &&
        typeof value.dependencyId === "string" &&
        (value.dependsOnLaneId === null ||
          typeof value.dependsOnLaneId === "string") &&
        (value.dependsOnIssueIdentifier === null ||
          typeof value.dependsOnIssueIdentifier === "string") &&
        typeof value.reason === "string"
      );
    case "dependency_unblocked":
      return typeof value.dependencyId === "string";
    case "review_gate_started":
      return (
        typeof value.laneId === "string" &&
        typeof value.gateId === "string" &&
        typeof value.reviewer === "string"
      );
    case "review_gate_result":
      return (
        typeof value.laneId === "string" &&
        typeof value.gateId === "string" &&
        isStringIn(value.status, ["passed", "failed", "degraded"]) &&
        (value.evidenceArtifactId === null ||
          typeof value.evidenceArtifactId === "string") &&
        typeof value.compensationRequired === "boolean"
      );
    case "validation_artifact_added":
      return (
        (value.laneId === null || typeof value.laneId === "string") &&
        typeof value.artifactId === "string" &&
        isStringIn(value.kind, [
          "test",
          "build",
          "lint",
          "typecheck",
          "review_compensation",
          "report",
          "other",
        ]) &&
        typeof value.label === "string" &&
        (value.url === null || typeof value.url === "string")
      );
    case "follow_up_spawned":
      return (
        (value.laneId === null || typeof value.laneId === "string") &&
        typeof value.issueIdentifier === "string" &&
        typeof value.title === "string" &&
        (value.parentIssueIdentifier === null ||
          typeof value.parentIssueIdentifier === "string") &&
        (value.url === null || typeof value.url === "string")
      );
    case "ownership_lease_acquired":
      return (
        typeof value.leaseId === "string" &&
        typeof value.laneId === "string" &&
        typeof value.ownerThreadId === "string" &&
        typeof value.expiresAt === "string"
      );
    case "ownership_lease_released":
      return (
        typeof value.leaseId === "string" &&
        isStringIn(value.outcome, ["completed", "expired", "transferred"])
      );
    case "heartbeat_recorded":
      return (
        typeof value.laneId === "string" &&
        typeof value.workerThreadId === "string" &&
        isStringIn(value.status, [
          "active",
          "blocked",
          "degraded",
          "closing",
        ]) &&
        (value.note === null || typeof value.note === "string")
      );
    case "escalation_raised":
      return (
        (value.laneId === null || typeof value.laneId === "string") &&
        isStringIn(value.kind, [
          "stale_worker",
          "missing_evidence",
          "review_gate_degraded",
          "dependency_blocked",
          "ownership_conflict",
        ]) &&
        isStringIn(value.severity, ["warning", "critical"]) &&
        typeof value.message === "string"
      );
    case "terminal_condition_reported":
      return (
        (value.laneId === null || typeof value.laneId === "string") &&
        isStringIn(value.condition, ["lane_closed", "manager_closeout"]) &&
        isStringArray(value.requiredEvidence) &&
        isStringArray(value.providedEvidence)
      );
    case "model_check_requested":
      return (
        isStringIn(value.reason, ["ambiguity", "decision_quality_check"]) &&
        (value.laneId === null || typeof value.laneId === "string") &&
        typeof value.question === "string"
      );
  }
  return false;
}

function isStringArray(value: unknown): value is string[] {
  return (
    Array.isArray(value) && value.every((entry) => typeof entry === "string")
  );
}

function isStringIn(
  value: unknown,
  allowed: readonly string[],
): value is string {
  return typeof value === "string" && allowed.includes(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isMissingPathError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: unknown }).code === "ENOENT"
  );
}
