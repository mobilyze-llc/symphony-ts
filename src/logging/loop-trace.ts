import { promises as fs } from "node:fs";
import { basename, join } from "node:path";

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
export const LOOP_TRACE_ARTIFACT_RETENTION_MAX_FILES = 500;

const LOOP_TRACE_ARTIFACT_DIR = join(".symphony", "loop-traces");
const LOOP_TRACE_INDEX_FILENAME = "issue-index.json";
const LOOP_TRACE_SUMMARY_MAX_LENGTH = 200;
const loopTraceIssueIndexTasks = new Map<string, Promise<void>>();

interface LoopTraceIssueIndex {
  version: 1;
  entries: Record<string, LoopTraceIssueIndexEntry>;
}

interface LoopTraceIssueIndexEntry {
  issueId: string;
  artifact: string;
  updatedAt: string;
}

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

export function getLoopTraceIssueIndexPath(workspaceRoot: string): string {
  return join(
    workspaceRoot,
    LOOP_TRACE_ARTIFACT_DIR,
    LOOP_TRACE_INDEX_FILENAME,
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
  const traceDirectory = join(locator.workspaceRoot, LOOP_TRACE_ARTIFACT_DIR);
  await fs.mkdir(traceDirectory, { recursive: true });
  const body = `${trimLoopTraceJournal(journal)
    .map((entry) => JSON.stringify(entry))
    .join("\n")}\n`;
  await fs.writeFile(artifactPath, body, "utf8");
  await withLoopTraceIssueIndexLock(locator.workspaceRoot, async () => {
    await updateLoopTraceIssueIndex(
      locator.workspaceRoot,
      artifactPath,
      journal,
    );
    await pruneLoopTraceArtifacts(locator.workspaceRoot, {
      keepArtifactPath: artifactPath,
    });
  });
}

export async function findLoopTraceJournalByIssueIdentifier(
  workspaceRoot: string,
  issueIdentifier: string,
): Promise<{
  artifactPath: string;
  journal: LoopTraceJournal;
} | null> {
  const index = await readLoopTraceIssueIndex(workspaceRoot);
  const indexed = index.entries[issueIdentifier];
  if (indexed === undefined || !isSafeLoopTraceArtifactName(indexed.artifact)) {
    return null;
  }

  const artifactPath = join(
    workspaceRoot,
    LOOP_TRACE_ARTIFACT_DIR,
    indexed.artifact,
  );
  const journal = await readLoopTraceJournal({
    workspaceRoot,
    workspaceKey: indexed.artifact.slice(0, -".jsonl".length),
  });
  if (journal.some((entry) => entry.issueIdentifier === issueIdentifier)) {
    return {
      artifactPath,
      journal,
    };
  }

  return null;
}

async function updateLoopTraceIssueIndex(
  workspaceRoot: string,
  artifactPath: string,
  journal: LoopTraceJournal,
): Promise<void> {
  const identifiers = [
    ...new Set(
      journal
        .map((entry) => entry.issueIdentifier)
        .filter((identifier) => identifier.length > 0),
    ),
  ];
  if (identifiers.length === 0) {
    return;
  }

  const index = await readLoopTraceIssueIndex(workspaceRoot);
  const updatedAt = journal.at(-1)?.timestamp ?? new Date().toISOString();
  const artifact = basename(artifactPath);
  if (!isSafeLoopTraceArtifactName(artifact)) {
    return;
  }

  for (const issueIdentifier of identifiers) {
    const latestEntry = findLatestEntryForIssueIdentifier(
      journal,
      issueIdentifier,
    );
    if (latestEntry === null) {
      continue;
    }
    index.entries[issueIdentifier] = {
      issueId: latestEntry.issueId,
      artifact,
      updatedAt,
    };
  }

  await writeLoopTraceIssueIndex(workspaceRoot, index);
}

async function pruneLoopTraceArtifacts(
  workspaceRoot: string,
  options: { keepArtifactPath: string },
): Promise<void> {
  const traceDirectory = join(workspaceRoot, LOOP_TRACE_ARTIFACT_DIR);
  const keepArtifact = basename(options.keepArtifactPath);
  const files = await fs.readdir(traceDirectory, { withFileTypes: true });
  const artifacts = await Promise.all(
    files
      .filter(
        (file) =>
          file.isFile() &&
          isSafeLoopTraceArtifactName(file.name) &&
          file.name !== keepArtifact,
      )
      .map(async (file) => {
        const path = join(traceDirectory, file.name);
        const stats = await fs.stat(path);
        return { name: file.name, path, mtimeMs: stats.mtimeMs };
      }),
  );

  const removableCount =
    artifacts.length + 1 - LOOP_TRACE_ARTIFACT_RETENTION_MAX_FILES;
  if (removableCount <= 0) {
    return;
  }

  const removed = new Set<string>();
  for (const artifact of artifacts
    .sort((left, right) => left.mtimeMs - right.mtimeMs)
    .slice(0, removableCount)) {
    await fs.rm(artifact.path, { force: true });
    removed.add(artifact.name);
  }

  if (removed.size === 0) {
    return;
  }

  const index = await readLoopTraceIssueIndex(workspaceRoot);
  for (const [issueIdentifier, entry] of Object.entries(index.entries)) {
    if (removed.has(entry.artifact)) {
      delete index.entries[issueIdentifier];
    }
  }
  await writeLoopTraceIssueIndex(workspaceRoot, index);
}

async function readLoopTraceIssueIndex(
  workspaceRoot: string,
): Promise<LoopTraceIssueIndex> {
  let raw: string;
  try {
    raw = await fs.readFile(getLoopTraceIssueIndexPath(workspaceRoot), "utf8");
  } catch (error) {
    if (isMissingPathError(error)) {
      return emptyLoopTraceIssueIndex();
    }
    throw error;
  }

  try {
    const parsed = JSON.parse(raw) as unknown;
    return sanitizeLoopTraceIssueIndex(parsed);
  } catch {
    // Treat a corrupt index as empty; artifact lookup remains best-effort.
  }
  return emptyLoopTraceIssueIndex();
}

async function writeLoopTraceIssueIndex(
  workspaceRoot: string,
  index: LoopTraceIssueIndex,
): Promise<void> {
  await fs.writeFile(
    getLoopTraceIssueIndexPath(workspaceRoot),
    `${JSON.stringify({
      version: 1,
      entries: Object.fromEntries(
        Object.entries(index.entries).sort(([left], [right]) =>
          left.localeCompare(right),
        ),
      ),
    })}\n`,
    "utf8",
  );
}

async function withLoopTraceIssueIndexLock<T>(
  workspaceRoot: string,
  action: () => Promise<T>,
): Promise<T> {
  const previous =
    loopTraceIssueIndexTasks.get(workspaceRoot) ?? Promise.resolve();
  const run = previous.catch(() => undefined).then(action);
  const current = run.then(
    () => undefined,
    () => undefined,
  );
  loopTraceIssueIndexTasks.set(workspaceRoot, current);
  void current.finally(() => {
    if (loopTraceIssueIndexTasks.get(workspaceRoot) === current) {
      loopTraceIssueIndexTasks.delete(workspaceRoot);
    }
  });
  return await run;
}

function findLatestEntryForIssueIdentifier(
  journal: LoopTraceJournal,
  issueIdentifier: string,
): LoopTraceEntry | null {
  for (let index = journal.length - 1; index >= 0; index -= 1) {
    const entry = journal[index];
    if (entry?.issueIdentifier === issueIdentifier) {
      return entry;
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

function emptyLoopTraceIssueIndex(): LoopTraceIssueIndex {
  return { version: 1, entries: {} };
}

function sanitizeLoopTraceIssueIndex(value: unknown): LoopTraceIssueIndex {
  if (!isRecord(value) || value.version !== 1 || !isRecord(value.entries)) {
    return emptyLoopTraceIssueIndex();
  }

  const entries: Record<string, LoopTraceIssueIndexEntry> = {};
  for (const [issueIdentifier, entry] of Object.entries(value.entries)) {
    if (isLoopTraceIssueIndexEntry(entry)) {
      entries[issueIdentifier] = entry;
    }
  }

  return { version: 1, entries };
}

function isLoopTraceIssueIndexEntry(
  value: unknown,
): value is LoopTraceIssueIndexEntry {
  return (
    isRecord(value) &&
    typeof value.issueId === "string" &&
    typeof value.artifact === "string" &&
    isSafeLoopTraceArtifactName(value.artifact) &&
    typeof value.updatedAt === "string"
  );
}

function isSafeLoopTraceArtifactName(filename: string): boolean {
  return (
    filename.endsWith(".jsonl") &&
    basename(filename) === filename &&
    !filename.includes("..") &&
    filename !== LOOP_TRACE_INDEX_FILENAME
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
