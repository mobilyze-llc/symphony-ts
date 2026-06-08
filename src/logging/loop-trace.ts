import { promises as fs } from "node:fs";
import { join } from "node:path";

import {
  LOOP_TRACE_EVENT_KINDS,
  type LoopTraceEntry,
  type LoopTraceFileDelta,
  type LoopTraceJournal,
  type LoopTracePromptSummary,
  type LoopTraceStageTransition,
  type LoopTraceToolAction,
  type LoopTraceWorkerExit,
} from "../domain/model.js";

export const LOOP_TRACE_JOURNAL_MAX_ENTRIES = 200;
export const LOOP_TRACE_PREVIEW_MAX_ENTRIES = 5;

const LOOP_TRACE_ARTIFACT_DIR = join(".symphony", "loop-traces");
const LOOP_TRACE_SUMMARY_MAX_LENGTH = 200;

export interface LoopTraceArtifactLocator {
  workspaceKey: string;
  workspaceRoot: string;
}

export interface LoopTraceEntryResponse {
  sequence: number;
  at: string;
  kind: LoopTraceEntry["kind"];
  summary: string;
  stage: string | null;
  attempt: number | null;
  session_id: string | null;
  prompt: LoopTracePromptSummaryResponse | null;
  tool_action: LoopTraceToolActionResponse | null;
  file_delta: LoopTraceFileDeltaResponse | null;
  stage_transition: LoopTraceStageTransitionResponse | null;
  worker_exit: LoopTraceWorkerExitResponse | null;
}

export interface LoopTraceJournalPreviewResponse {
  total_entries: number;
  stored_entries: number;
  truncated: boolean;
  entries: LoopTraceEntryResponse[];
}

export interface LoopTraceJournalResponse
  extends LoopTraceJournalPreviewResponse {
  path: string;
}

interface LoopTracePromptSummaryResponse {
  chars: number;
  estimated_tokens: number | null;
}

interface LoopTraceToolActionResponse {
  tool_name: string;
  context: string | null;
  total_tokens: number | null;
}

interface LoopTraceFileDeltaResponse {
  files: string[];
}

interface LoopTraceStageTransitionResponse {
  from: string | null;
  to: string | null;
  status: string;
}

interface LoopTraceWorkerExitResponse {
  outcome: "normal" | "abnormal";
  reason: string | null;
  duration_ms: number;
  turn_count: number;
  total_tokens: number;
}

export function appendLoopTraceJournalEntry(
  journal: LoopTraceJournal,
  entry: Omit<LoopTraceEntry, "sequence">,
): LoopTraceJournal {
  const nextSequence = (journal.at(-1)?.sequence ?? 0) + 1;
  return trimLoopTraceJournal([
    ...journal,
    { ...entry, sequence: nextSequence },
  ]);
}

export function trimLoopTraceJournal(
  journal: LoopTraceJournal,
  maxEntries = LOOP_TRACE_JOURNAL_MAX_ENTRIES,
): LoopTraceJournal {
  return journal.length <= maxEntries ? journal : journal.slice(-maxEntries);
}

export function buildLoopTraceJournalPreview(
  journal: LoopTraceJournal,
): LoopTraceJournalPreviewResponse {
  return toLoopTraceJournalShape(journal, {
    limit: LOOP_TRACE_PREVIEW_MAX_ENTRIES,
  });
}

export function buildLoopTraceJournalResponse(
  journal: LoopTraceJournal,
  locator: LoopTraceArtifactLocator,
): LoopTraceJournalResponse {
  return buildLoopTraceJournalResponseForPath(
    journal,
    getLoopTraceArtifactPath(locator),
  );
}

export function buildLoopTraceJournalResponseForPath(
  journal: LoopTraceJournal,
  path: string,
): LoopTraceJournalResponse {
  return {
    path,
    ...toLoopTraceJournalShape(journal),
  };
}

export function getLoopTraceArtifactPath(
  locator: LoopTraceArtifactLocator,
): string {
  return join(
    locator.workspaceRoot,
    LOOP_TRACE_ARTIFACT_DIR,
    `${locator.workspaceKey}.jsonl`,
  );
}

export async function readLoopTraceJournal(
  locator: LoopTraceArtifactLocator,
): Promise<LoopTraceJournal> {
  const artifactPath = getLoopTraceArtifactPath(locator);
  let raw: string;
  try {
    raw = await fs.readFile(artifactPath, "utf8");
  } catch (error) {
    if (isMissingPathError(error)) {
      return [];
    }
    throw error;
  }

  const entries: LoopTraceJournal = [];
  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (trimmed.length === 0) {
      continue;
    }
    try {
      const parsed = JSON.parse(trimmed) as unknown;
      if (isLoopTraceEntry(parsed)) {
        entries.push(parsed);
      }
    } catch {
      // Ignore malformed lines to keep the debug surface readable.
    }
  }

  return trimLoopTraceJournal(entries);
}

export async function writeLoopTraceJournal(
  locator: LoopTraceArtifactLocator,
  journal: LoopTraceJournal,
): Promise<void> {
  const artifactPath = getLoopTraceArtifactPath(locator);
  await fs.mkdir(join(locator.workspaceRoot, LOOP_TRACE_ARTIFACT_DIR), {
    recursive: true,
  });
  const body = `${trimLoopTraceJournal(journal)
    .map((entry) => JSON.stringify(entry))
    .join("\n")}\n`;
  await fs.writeFile(artifactPath, body, "utf8");
}

export async function findLoopTraceJournalByIssueIdentifier(
  workspaceRoot: string,
  issueIdentifier: string,
): Promise<{
  artifactPath: string;
  journal: LoopTraceJournal;
} | null> {
  const traceDirectory = join(workspaceRoot, LOOP_TRACE_ARTIFACT_DIR);
  let files: string[];
  try {
    files = await fs.readdir(traceDirectory);
  } catch (error) {
    if (isMissingPathError(error)) {
      return null;
    }
    throw error;
  }

  for (const filename of files.sort()) {
    if (!filename.endsWith(".jsonl")) {
      continue;
    }
    const artifactPath = join(traceDirectory, filename);
    const journal = await readLoopTraceJournal({
      workspaceRoot,
      workspaceKey: filename.slice(0, -".jsonl".length),
    });
    if (journal.some((entry) => entry.issueIdentifier === issueIdentifier)) {
      return {
        artifactPath,
        journal,
      };
    }
  }

  return null;
}

function toLoopTraceJournalShape(
  journal: LoopTraceJournal,
  options?: {
    limit?: number;
  },
): LoopTraceJournalPreviewResponse {
  const trimmed = trimLoopTraceJournal(journal);
  const totalEntries = trimmed.at(-1)?.sequence ?? 0;
  const entries =
    options?.limit === undefined
      ? trimmed
      : options.limit <= 0
        ? []
        : trimmed.slice(-options.limit);

  return {
    total_entries: totalEntries,
    stored_entries: trimmed.length,
    truncated: (trimmed[0]?.sequence ?? 1) > 1,
    entries: entries.map(toLoopTraceEntryResponse),
  };
}

function toLoopTraceEntryResponse(
  entry: LoopTraceEntry,
): LoopTraceEntryResponse {
  return {
    sequence: entry.sequence,
    at: entry.timestamp,
    kind: entry.kind,
    summary: truncateSummary(entry.summary),
    stage: entry.stage,
    attempt: entry.attempt,
    session_id: entry.sessionId,
    prompt:
      entry.prompt === undefined
        ? null
        : {
            chars: entry.prompt.chars,
            estimated_tokens: entry.prompt.estimatedTokens,
          },
    tool_action:
      entry.toolAction === undefined
        ? null
        : {
            tool_name: entry.toolAction.toolName,
            context: entry.toolAction.context,
            total_tokens: entry.toolAction.totalTokens,
          },
    file_delta:
      entry.fileDelta === undefined
        ? null
        : {
            files: entry.fileDelta.files,
          },
    stage_transition:
      entry.stageTransition === undefined
        ? null
        : {
            from: entry.stageTransition.from,
            to: entry.stageTransition.to,
            status: entry.stageTransition.status,
          },
    worker_exit:
      entry.workerExit === undefined
        ? null
        : {
            outcome: entry.workerExit.outcome,
            reason: entry.workerExit.reason,
            duration_ms: entry.workerExit.durationMs,
            turn_count: entry.workerExit.turnCount,
            total_tokens: entry.workerExit.totalTokens,
          },
  };
}

function truncateSummary(summary: string): string {
  if (summary.length <= LOOP_TRACE_SUMMARY_MAX_LENGTH) {
    return summary;
  }
  return `${summary.slice(0, LOOP_TRACE_SUMMARY_MAX_LENGTH)}...`;
}

function isLoopTraceEntry(value: unknown): value is LoopTraceEntry {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const candidate = value as Partial<LoopTraceEntry>;
  return (
    typeof candidate.sequence === "number" &&
    typeof candidate.timestamp === "string" &&
    LOOP_TRACE_EVENT_KINDS.includes(candidate.kind as LoopTraceEntry["kind"]) &&
    typeof candidate.issueId === "string" &&
    typeof candidate.issueIdentifier === "string" &&
    (candidate.stage === null || typeof candidate.stage === "string") &&
    (candidate.attempt === null || typeof candidate.attempt === "number") &&
    (candidate.sessionId === null || typeof candidate.sessionId === "string") &&
    typeof candidate.summary === "string" &&
    isOptional(candidate.prompt, isLoopTracePromptSummary) &&
    isOptional(candidate.toolAction, isLoopTraceToolAction) &&
    isOptional(candidate.fileDelta, isLoopTraceFileDelta) &&
    isOptional(candidate.stageTransition, isLoopTraceStageTransition) &&
    isOptional(candidate.workerExit, isLoopTraceWorkerExit)
  );
}

function isOptional<T>(
  value: unknown,
  predicate: (value: unknown) => value is T,
): value is T | undefined {
  return value === undefined || predicate(value);
}

function isLoopTracePromptSummary(
  value: unknown,
): value is LoopTracePromptSummary {
  if (!isRecord(value)) {
    return false;
  }
  return (
    typeof value.chars === "number" &&
    (value.estimatedTokens === null ||
      typeof value.estimatedTokens === "number")
  );
}

function isLoopTraceToolAction(value: unknown): value is LoopTraceToolAction {
  if (!isRecord(value)) {
    return false;
  }
  return (
    typeof value.toolName === "string" &&
    (value.context === null || typeof value.context === "string") &&
    (value.totalTokens === null || typeof value.totalTokens === "number")
  );
}

function isLoopTraceFileDelta(value: unknown): value is LoopTraceFileDelta {
  return (
    isRecord(value) &&
    Array.isArray(value.files) &&
    value.files.every((file) => typeof file === "string")
  );
}

function isLoopTraceStageTransition(
  value: unknown,
): value is LoopTraceStageTransition {
  if (!isRecord(value)) {
    return false;
  }
  return (
    (value.from === null || typeof value.from === "string") &&
    (value.to === null || typeof value.to === "string") &&
    typeof value.status === "string"
  );
}

function isLoopTraceWorkerExit(value: unknown): value is LoopTraceWorkerExit {
  if (!isRecord(value)) {
    return false;
  }
  return (
    (value.outcome === "normal" || value.outcome === "abnormal") &&
    (value.reason === null || typeof value.reason === "string") &&
    typeof value.durationMs === "number" &&
    typeof value.turnCount === "number" &&
    typeof value.totalTokens === "number"
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isMissingPathError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: unknown }).code === "ENOENT"
  );
}
