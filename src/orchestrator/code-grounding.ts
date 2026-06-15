import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";

import type { BacklogAuditFinding } from "../audit/backlog-audit.js";
import {
  gitIsolationEnv,
  scrubGitPointerEnv,
} from "../workspace/git-isolation.js";
import {
  assertWorkspacePathWithinRoot,
  resolveWorkspaceRoot,
} from "../workspace/path-safety.js";
import { AsyncMutex } from "../workspace/workspace-manager.js";

export const CODE_GROUNDING_VERIFICATION_STATUSES = [
  "verified",
  "model_suggested_verified",
  "model_argued_unverified",
  "contradicted",
  "not_found",
  "contaminated",
  "not_attempted",
] as const;

export type CodeGroundingVerificationStatus =
  (typeof CODE_GROUNDING_VERIFICATION_STATUSES)[number];

export interface CodeGroundingConfig {
  enabled: boolean;
  baseDir: string;
  ttlMs: number;
  maxCheckoutsPerRepo: number;
}

export interface CodeGroundingTarget {
  repoUrl: string;
  commitSha: string;
  repoScope: "symphony" | "non_symphony";
  sourcePath?: string;
}

export interface EvidenceCitation {
  checkoutId: string;
  commitSha: string;
  path: string;
  lineRange: [number, number];
  contentHash: string;
  matchedSpan: string;
}

export interface CodeGroundingEvidenceEntry {
  findingId: string;
  status: CodeGroundingVerificationStatus;
  summary: string;
  citations: EvidenceCitation[];
  missing: string[];
}

export interface CodeGroundingModelFinding {
  findingId: string;
  status: "verified" | "unverified";
  summary: string;
  citations?: EvidenceCitation[];
}

export interface CodeGroundingReport {
  generatedAt: string;
  status: CodeGroundingVerificationStatus;
  checkout: {
    checkoutId: string | null;
    path: string | null;
    commitSha: string | null;
    repoUrl: string;
  };
  entries: CodeGroundingEvidenceEntry[];
  cleanup: {
    leaseReleased: boolean;
    checkoutPurged: boolean;
    dirtyState: CodeGroundingDirtyState | null;
  };
  warnings: string[];
}

export interface CodeGroundingDirtyState {
  dirty: boolean;
  porcelain: string;
}

export interface RunCodeGroundingInput {
  workspaceRoot: string;
  runId: string;
  config: CodeGroundingConfig;
  target: CodeGroundingTarget;
  findings: readonly BacklogAuditFinding[];
  modelFindings?: readonly CodeGroundingModelFinding[];
  commandRunner?: CodeGroundingCommandRunner;
  afterDeterministicScan?: (input: {
    checkoutPath: string;
    checkoutId: string;
  }) => Promise<void> | void;
}

export type CodeGroundingCommandRunner = (
  command: string,
  args: readonly string[],
  options: {
    cwd: string;
    env: NodeJS.ProcessEnv;
    timeoutMs: number;
  },
) => Promise<CodeGroundingCommandResult>;

export interface CodeGroundingCommandResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

interface CodeGroundingPaths {
  checkoutId: string;
  workspaceRoot: string;
  baseRoot: string;
  checkoutsRoot: string;
  checkoutPath: string;
  artifactsRoot: string;
  runArtifactRoot: string;
  leaseIndexPath: string;
}

interface LeaseIndex {
  version: 1;
  checkouts: Record<string, LeaseRecord>;
}

interface LeaseRecord {
  checkoutId: string;
  repoUrl: string;
  commitSha: string;
  checkoutPath: string;
  artifactRoot: string;
  createdAt: string;
  lastUsedAt: string;
  activeRunIds: string[];
}

const DEFAULT_GIT_TIMEOUT_MS = 60_000;
const MAX_SCAN_FILES = 500;
const MAX_SCAN_FILE_BYTES = 256_000;
const MAX_SCAN_DEPTH = 64;
const FILE_LOCK_TIMEOUT_MS = 120_000;
const FILE_LOCK_POLL_MS = 50;
const FILE_LOCK_STALE_MS = 60 * 60_000;
const FILE_LOCK_OWNER_FILENAME = "owner.json";
const TEXT_FILE_EXTENSIONS = new Set([
  ".js",
  ".jsx",
  ".ts",
  ".tsx",
  ".mjs",
  ".cjs",
  ".json",
  ".md",
  ".yaml",
  ".yml",
  ".txt",
]);
const MODEL_VALIDATED_STATUSES = new Set<CodeGroundingVerificationStatus>([
  "verified",
  "model_suggested_verified",
]);
const leaseMutexes = new Map<string, AsyncMutex>();
const checkoutMutexes = new Map<string, AsyncMutex>();

export async function runManagedCodeGrounding(
  input: RunCodeGroundingInput,
): Promise<CodeGroundingReport> {
  if (!input.config.enabled) {
    return buildNotAttemptedReport(input, "code grounding disabled");
  }
  if (input.target.repoScope !== "symphony") {
    return buildNotAttemptedReport(
      input,
      "repository is outside the v1 Symphony grounding scope",
    );
  }

  const paths = resolveCodeGroundingPaths(input);
  const releaseCheckout = await getCheckoutMutex(
    paths.workspaceRoot,
    paths.checkoutId,
  ).acquire();
  let releaseCheckoutFileLock: (() => Promise<void>) | null = null;
  try {
    releaseCheckoutFileLock = await acquireCodeGroundingFileLock(
      paths.workspaceRoot,
      checkoutFileLockPath(paths),
    );
    await fs.mkdir(paths.runArtifactRoot, { recursive: true });
    await sweepCodeGroundingCheckouts({
      workspaceRoot: input.workspaceRoot,
      config: input.config,
    });

    const release = await acquireCheckoutLease(paths, input);
    let report: CodeGroundingReport | null = null;
    try {
      await prepareManagedCheckout(paths, input);
      const entries = await verifyFindingsAgainstCheckout(paths, input);
      await input.afterDeterministicScan?.({
        checkoutPath: paths.checkoutPath,
        checkoutId: paths.checkoutId,
      });
      const dirtyState = await getCheckoutDirtyState(paths, input);
      if (dirtyState.dirty) {
        await fs.rm(paths.checkoutPath, { recursive: true, force: true });
        report = {
          generatedAt: new Date().toISOString(),
          status: "contaminated",
          checkout: checkoutMetadata(paths, input),
          entries: entries.map((entry) => ({
            ...entry,
            status: "contaminated",
            summary:
              "Code-grounding checkout became dirty during read-only scan; evidence discarded.",
            citations: [],
          })),
          cleanup: {
            leaseReleased: false,
            checkoutPurged: true,
            dirtyState,
          },
          warnings: [
            "code-grounding checkout mutated during scan and was purged",
          ],
        };
        return report;
      }

      report = {
        generatedAt: new Date().toISOString(),
        status: summarizeEntries(entries),
        checkout: checkoutMetadata(paths, input),
        entries,
        cleanup: {
          leaseReleased: false,
          checkoutPurged: false,
          dirtyState,
        },
        warnings: [],
      };
      return report;
    } finally {
      await release();
      if (report !== null) {
        report.cleanup.leaseReleased = true;
      }
    }
  } finally {
    try {
      await releaseCheckoutFileLock?.();
    } finally {
      releaseCheckout();
    }
  }
}

export async function sweepCodeGroundingCheckouts(input: {
  workspaceRoot: string;
  config: CodeGroundingConfig;
  now?: Date;
}): Promise<void> {
  const workspaceRoot = resolveWorkspaceRoot(input.workspaceRoot);
  const baseRoot = resolveGroundingBaseRoot(
    workspaceRoot,
    input.config.baseDir,
  );
  const leaseIndexPath = join(baseRoot, "leases.json");
  await withLeaseIndexLock(workspaceRoot, baseRoot, async () => {
    const index = await readLeaseIndex(leaseIndexPath);
    const now = input.now ?? new Date();
    const byRepo = new Map<string, LeaseRecord[]>();
    for (const record of Object.values(index.checkouts)) {
      const bucket = byRepo.get(record.repoUrl) ?? [];
      bucket.push(record);
      byRepo.set(record.repoUrl, bucket);
    }

    for (const records of byRepo.values()) {
      records.sort(
        (left, right) =>
          Date.parse(right.lastUsedAt) - Date.parse(left.lastUsedAt),
      );
      for (const [indexWithinRepo, record] of records.entries()) {
        const expired =
          now.getTime() - Date.parse(record.lastUsedAt) > input.config.ttlMs;
        const overCap = indexWithinRepo >= input.config.maxCheckoutsPerRepo;
        if (record.activeRunIds.length > 0 || (!expired && !overCap)) {
          continue;
        }
        assertWorkspacePathWithinRoot(baseRoot, record.checkoutPath);
        await fs.rm(record.checkoutPath, { recursive: true, force: true });
        const checkoutLockPath = `${record.checkoutPath}.lock`;
        assertWorkspacePathWithinRoot(baseRoot, checkoutLockPath);
        await fs.rm(checkoutLockPath, { recursive: true, force: true });
        delete index.checkouts[record.checkoutId];
      }
    }
    await writeLeaseIndex(leaseIndexPath, index);
  });
}

export function resolveCodeGroundingPaths(
  input: Pick<
    RunCodeGroundingInput,
    "workspaceRoot" | "config" | "target" | "runId"
  >,
): CodeGroundingPaths {
  const workspaceRoot = resolveWorkspaceRoot(input.workspaceRoot);
  const baseRoot = resolveGroundingBaseRoot(
    workspaceRoot,
    input.config.baseDir,
  );
  const checkoutsRoot = join(baseRoot, "checkouts");
  const artifactsRoot = join(baseRoot, "artifacts");
  const checkoutId = buildCheckoutId(input.target);
  const checkoutPath = join(checkoutsRoot, checkoutId);
  const runArtifactRoot = join(artifactsRoot, safePathSegment(input.runId));
  const leaseIndexPath = join(baseRoot, "leases.json");
  for (const path of [
    baseRoot,
    checkoutsRoot,
    artifactsRoot,
    checkoutPath,
    runArtifactRoot,
    leaseIndexPath,
  ]) {
    assertWorkspacePathWithinRoot(workspaceRoot, path);
  }
  return {
    checkoutId,
    workspaceRoot,
    baseRoot,
    checkoutsRoot,
    checkoutPath,
    artifactsRoot,
    runArtifactRoot,
    leaseIndexPath,
  };
}

export function validateModelFindingAgainstEvidence(input: {
  deterministic: CodeGroundingEvidenceEntry;
  modelFinding: CodeGroundingModelFinding;
}): CodeGroundingEvidenceEntry {
  if (input.modelFinding.status !== "verified") {
    return {
      ...input.deterministic,
      status: "model_argued_unverified",
      summary: input.modelFinding.summary,
    };
  }
  if (input.deterministic.status === "verified") {
    return {
      ...input.deterministic,
      status: "model_suggested_verified",
      summary: input.modelFinding.summary,
    };
  }
  return {
    ...input.deterministic,
    status: "model_argued_unverified",
    summary:
      "Model claimed verification without matching deterministic citation; downgraded to unverified.",
  };
}

async function prepareManagedCheckout(
  paths: CodeGroundingPaths,
  input: RunCodeGroundingInput,
): Promise<void> {
  await fs.mkdir(paths.checkoutsRoot, { recursive: true });
  if (
    (await directoryExists(paths.checkoutPath)) &&
    !(await isUsableCheckout(paths, input))
  ) {
    await fs.rm(paths.checkoutPath, { recursive: true, force: true });
  }
  if (!(await directoryExists(paths.checkoutPath))) {
    await cloneManagedCheckout(paths, input);
  }
  try {
    await runGit(paths, input, [
      "checkout",
      "--detach",
      input.target.commitSha,
    ]);
    await runGit(paths, input, ["reset", "--hard", input.target.commitSha]);
    await runGit(paths, input, ["clean", "-fdx"]);
  } catch (error) {
    await fs.rm(paths.checkoutPath, { recursive: true, force: true });
    throw error;
  }
  const toplevel = (
    await runGit(paths, input, ["rev-parse", "--show-toplevel"])
  ).stdout.trim();
  if (
    (await realpathOrResolve(toplevel)) !==
    (await realpathOrResolve(paths.checkoutPath))
  ) {
    throw new Error(
      `code-grounding checkout toplevel escaped checkout path: ${toplevel}`,
    );
  }
}

async function cloneManagedCheckout(
  paths: CodeGroundingPaths,
  input: RunCodeGroundingInput,
): Promise<void> {
  const source = input.target.sourcePath ?? input.target.repoUrl;
  try {
    await runGit(
      paths,
      input,
      ["clone", "--no-checkout", source, paths.checkoutPath],
      {
        cwd: paths.checkoutsRoot,
      },
    );
  } catch (error) {
    await fs.rm(paths.checkoutPath, { recursive: true, force: true });
    throw error;
  }
}

async function isUsableCheckout(
  paths: CodeGroundingPaths,
  input: RunCodeGroundingInput,
): Promise<boolean> {
  try {
    const toplevel = (
      await runGit(paths, input, ["rev-parse", "--show-toplevel"])
    ).stdout.trim();
    return (
      (await realpathOrResolve(toplevel)) ===
      (await realpathOrResolve(paths.checkoutPath))
    );
  } catch {
    return false;
  }
}

async function verifyFindingsAgainstCheckout(
  paths: CodeGroundingPaths,
  input: RunCodeGroundingInput,
): Promise<CodeGroundingEvidenceEntry[]> {
  const scanIndex = await buildScanIndex(paths.checkoutPath);
  const modelByFinding = new Map(
    (input.modelFindings ?? []).map((finding) => [finding.findingId, finding]),
  );
  return Promise.all(
    input.findings.map(async (finding) => {
      const deterministic = await verifyFinding(
        paths,
        input,
        scanIndex,
        finding,
      );
      const modelFinding = modelByFinding.get(finding.findingId);
      return modelFinding === undefined
        ? deterministic
        : validateModelFindingAgainstEvidence({
            deterministic,
            modelFinding,
          });
    }),
  );
}

async function verifyFinding(
  paths: CodeGroundingPaths,
  input: RunCodeGroundingInput,
  scanIndex: ScanIndex,
  finding: BacklogAuditFinding,
): Promise<CodeGroundingEvidenceEntry> {
  const candidates = extractEvidenceCandidates(
    `${finding.summary}\n${finding.evidence}`,
  );
  const citations: EvidenceCitation[] = [];
  const missing: string[] = [];
  for (const pathCandidate of candidates.paths) {
    const citation =
      (await readPathCandidateCitation(paths, pathCandidate)) ??
      scanIndex.pathCitations.get(pathCandidate);
    if (citation === undefined) {
      missing.push(pathCandidate);
    } else {
      citations.push(toCitation(paths, input, citation));
    }
  }
  for (const symbol of candidates.symbols) {
    const citation = scanIndex.symbolCitations.get(symbol);
    if (citation === undefined) {
      missing.push(symbol);
    } else {
      citations.push(toCitation(paths, input, citation));
    }
  }

  let status: CodeGroundingVerificationStatus;
  if (citations.length > 0 && missing.length === 0) {
    status = "verified";
  } else if (citations.length > 0) {
    status = "contradicted";
  } else if (missing.length > 0) {
    status = "not_found";
  } else {
    status = "model_argued_unverified";
  }

  return {
    findingId: finding.findingId,
    status,
    summary:
      status === "verified"
        ? "All extracted path and symbol claims were found in the grounded checkout."
        : "Grounding could not verify every extracted path or symbol claim.",
    citations: dedupeCitations(citations),
    missing,
  };
}

async function readPathCandidateCitation(
  paths: CodeGroundingPaths,
  pathCandidate: string,
): Promise<ScanCitation | undefined> {
  const absolutePath = resolve(paths.checkoutPath, pathCandidate);
  assertWorkspacePathWithinRoot(paths.checkoutPath, absolutePath);
  try {
    const linkStat = await fs.lstat(absolutePath);
    if (linkStat.isSymbolicLink()) {
      return undefined;
    }
    const stat = await fs.stat(absolutePath);
    if (!stat.isFile() || stat.size > MAX_SCAN_FILE_BYTES) {
      return undefined;
    }
    const content = await fs.readFile(absolutePath, "utf8");
    return {
      path: pathCandidate,
      startLine: 1,
      endLine: Math.max(1, content.split("\n").length),
      matchedSpan: pathCandidate,
      contentHash: hashContent(content),
    };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return undefined;
    }
    throw error;
  }
}

interface EvidenceCandidates {
  paths: string[];
  symbols: string[];
}

function extractEvidenceCandidates(text: string): EvidenceCandidates {
  const paths = new Set<string>();
  const symbols = new Set<string>();
  for (const match of text.matchAll(/`([^`]+)`/g)) {
    const value = match[1]?.trim();
    if (!value) {
      continue;
    }
    if (looksLikePath(value)) {
      paths.add(stripLineSuffix(value));
    } else if (/^[A-Za-z_$][A-Za-z0-9_$]{2,}$/.test(value)) {
      symbols.add(value);
    }
  }
  for (const match of text.matchAll(
    /\b((?:src|tests|docs|skills|scripts|apps)\/[A-Za-z0-9._/@+-]+(?:\/[A-Za-z0-9._/@+-]+)*)/g,
  )) {
    paths.add(stripLineSuffix(match[1] ?? ""));
  }
  return {
    paths: [...paths],
    symbols: [...symbols],
  };
}

function looksLikePath(value: string): boolean {
  return /^(src|tests|docs|skills|scripts|apps)\//.test(value);
}

function stripLineSuffix(value: string): string {
  return value.replace(/:\d+(?::\d+)?$/, "");
}

interface ScanCitation {
  path: string;
  startLine: number;
  endLine: number;
  matchedSpan: string;
  contentHash: string;
}

interface ScanIndex {
  pathCitations: Map<string, ScanCitation>;
  symbolCitations: Map<string, ScanCitation>;
}

async function buildScanIndex(checkoutPath: string): Promise<ScanIndex> {
  const pathCitations = new Map<string, ScanCitation>();
  const symbolCitations = new Map<string, ScanCitation>();
  let scannedFiles = 0;
  for await (const absolutePath of walkTextFiles(checkoutPath)) {
    if (scannedFiles >= MAX_SCAN_FILES) {
      break;
    }
    scannedFiles++;
    const relativePath = toRepoRelativePath(checkoutPath, absolutePath);
    const content = await readTextFileBounded(absolutePath);
    if (content === null) {
      continue;
    }
    const contentHash = hashContent(content);
    pathCitations.set(relativePath, {
      path: relativePath,
      startLine: 1,
      endLine: Math.max(1, content.split("\n").length),
      matchedSpan: relativePath,
      contentHash,
    });
    for (const [symbol, line] of extractSymbols(content)) {
      if (symbolCitations.has(symbol)) {
        continue;
      }
      symbolCitations.set(symbol, {
        path: relativePath,
        startLine: line,
        endLine: line,
        matchedSpan: symbol,
        contentHash,
      });
    }
  }
  return { pathCitations, symbolCitations };
}

async function* walkTextFiles(root: string): AsyncGenerator<string> {
  const stack: Array<{ path: string; depth: number }> = [
    { path: root, depth: 0 },
  ];
  while (stack.length > 0) {
    const current = stack.pop();
    if (current === undefined || current.depth > MAX_SCAN_DEPTH) {
      continue;
    }
    const entries = await fs.readdir(current.path, { withFileTypes: true });
    for (const entry of entries) {
      if (
        entry.name === ".git" ||
        entry.name === "node_modules" ||
        entry.name === "dist"
      ) {
        continue;
      }
      const absolutePath = join(current.path, entry.name);
      if (entry.isDirectory()) {
        stack.push({ path: absolutePath, depth: current.depth + 1 });
        continue;
      }
      if (entry.isFile() && isTextFile(entry.name)) {
        yield absolutePath;
      }
    }
  }
}

function isTextFile(name: string): boolean {
  const extension = name.slice(name.lastIndexOf("."));
  return TEXT_FILE_EXTENSIONS.has(extension);
}

async function readTextFileBounded(path: string): Promise<string | null> {
  const stat = await fs.stat(path);
  if (stat.size > MAX_SCAN_FILE_BYTES) {
    return null;
  }
  return fs.readFile(path, "utf8");
}

const SYMBOL_DECLARATION_PATTERNS = [
  /\b(?:export\s+)?(?:default\s+)?(?:async\s+)?function\s+([A-Za-z_$][A-Za-z0-9_$]{2,})/g,
  /\b(?:export\s+)?(?:default\s+)?(?:class|interface|type|enum)\s+([A-Za-z_$][A-Za-z0-9_$]{2,})/g,
  /\b(?:export\s+)?(?:const|let|var)\s+([A-Za-z_$][A-Za-z0-9_$]{2,})\s*=/g,
] as const;

function extractSymbols(content: string): Map<string, number> {
  const symbols = new Map<string, number>();
  for (const pattern of SYMBOL_DECLARATION_PATTERNS) {
    for (const match of content.matchAll(pattern)) {
      const symbol = match[1];
      if (symbol !== undefined && !symbols.has(symbol)) {
        symbols.set(symbol, lineForMatchIndex(content, match.index ?? 0));
      }
    }
  }
  return symbols;
}

function lineForMatchIndex(content: string, index: number): number {
  return content.slice(0, index).split("\n").length;
}

function toCitation(
  paths: CodeGroundingPaths,
  input: RunCodeGroundingInput,
  citation: ScanCitation,
): EvidenceCitation {
  return {
    checkoutId: paths.checkoutId,
    commitSha: input.target.commitSha,
    path: citation.path,
    lineRange: [citation.startLine, citation.endLine],
    contentHash: citation.contentHash,
    matchedSpan: citation.matchedSpan,
  };
}

function dedupeCitations(citations: EvidenceCitation[]): EvidenceCitation[] {
  const seen = new Set<string>();
  return citations.filter((citation) => {
    const key = `${citation.path}:${citation.lineRange[0]}:${citation.matchedSpan}`;
    if (seen.has(key)) {
      return false;
    }
    seen.add(key);
    return true;
  });
}

async function getCheckoutDirtyState(
  paths: CodeGroundingPaths,
  input: RunCodeGroundingInput,
): Promise<CodeGroundingDirtyState> {
  const result = await runGit(paths, input, ["status", "--porcelain"]);
  return {
    dirty: result.stdout.trim().length > 0,
    porcelain: result.stdout,
  };
}

async function acquireCheckoutLease(
  paths: CodeGroundingPaths,
  input: RunCodeGroundingInput,
): Promise<() => Promise<void>> {
  await withLeaseIndexLock(paths.workspaceRoot, paths.baseRoot, async () => {
    const index = await readLeaseIndex(paths.leaseIndexPath);
    const now = new Date().toISOString();
    const existing = index.checkouts[paths.checkoutId];
    index.checkouts[paths.checkoutId] = {
      checkoutId: paths.checkoutId,
      repoUrl: input.target.repoUrl,
      commitSha: input.target.commitSha,
      checkoutPath: paths.checkoutPath,
      artifactRoot: paths.runArtifactRoot,
      createdAt: existing?.createdAt ?? now,
      lastUsedAt: now,
      activeRunIds: addUnique(existing?.activeRunIds ?? [], input.runId),
    };
    await writeLeaseIndex(paths.leaseIndexPath, index);
  });

  return async () => {
    await withLeaseIndexLock(paths.workspaceRoot, paths.baseRoot, async () => {
      const index = await readLeaseIndex(paths.leaseIndexPath);
      const existing = index.checkouts[paths.checkoutId];
      if (existing !== undefined) {
        existing.activeRunIds = existing.activeRunIds.filter(
          (runId) => runId !== input.runId,
        );
        existing.lastUsedAt = new Date().toISOString();
        await writeLeaseIndex(paths.leaseIndexPath, index);
      }
    });
  };
}

async function readLeaseIndex(path: string): Promise<LeaseIndex> {
  try {
    const raw = await fs.readFile(path, "utf8");
    const parsed = JSON.parse(raw) as LeaseIndex;
    if (parsed.version === 1 && typeof parsed.checkouts === "object") {
      return parsed;
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      throw error;
    }
  }
  return { version: 1, checkouts: {} };
}

async function writeLeaseIndex(path: string, index: LeaseIndex): Promise<void> {
  await fs.mkdir(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.tmp`;
  await fs.writeFile(tmp, `${JSON.stringify(index, null, 2)}\n`);
  await fs.rename(tmp, path);
}

async function withLeaseIndexLock<T>(
  workspaceRoot: string,
  baseRoot: string,
  action: () => Promise<T>,
): Promise<T> {
  const releaseMutex = await getLeaseMutex(workspaceRoot).acquire();
  let releaseFileLock: (() => Promise<void>) | null = null;
  try {
    releaseFileLock = await acquireCodeGroundingFileLock(
      workspaceRoot,
      leaseIndexLockPath(baseRoot),
    );
    return await action();
  } finally {
    try {
      await releaseFileLock?.();
    } finally {
      releaseMutex();
    }
  }
}

async function acquireCodeGroundingFileLock(
  workspaceRoot: string,
  lockPath: string,
): Promise<() => Promise<void>> {
  assertWorkspacePathWithinRoot(workspaceRoot, lockPath);
  await fs.mkdir(dirname(lockPath), { recursive: true });
  const ownerToken = randomUUID();
  const startedAt = Date.now();
  while (true) {
    try {
      await fs.mkdir(lockPath);
      await writeCodeGroundingLockOwner(lockPath, ownerToken);
      return () => releaseCodeGroundingFileLock(lockPath, ownerToken);
    } catch (error) {
      if (!isAlreadyExistsPathError(error)) {
        throw error;
      }
      if (await removeAbandonedCodeGroundingFileLock(lockPath)) {
        continue;
      }
      if (Date.now() - startedAt >= FILE_LOCK_TIMEOUT_MS) {
        throw new Error(
          `Timed out waiting for code-grounding lock at ${lockPath}`,
        );
      }
      await sleep(FILE_LOCK_POLL_MS);
    }
  }
}

async function writeCodeGroundingLockOwner(
  lockPath: string,
  ownerToken: string,
): Promise<void> {
  try {
    await fs.writeFile(
      join(lockPath, FILE_LOCK_OWNER_FILENAME),
      `${JSON.stringify({
        pid: process.pid,
        ownerToken,
        acquiredAt: new Date().toISOString(),
      })}\n`,
      "utf8",
    );
  } catch (error) {
    await fs.rm(lockPath, { recursive: true, force: true });
    throw error;
  }
}

async function releaseCodeGroundingFileLock(
  lockPath: string,
  ownerToken: string,
): Promise<void> {
  try {
    const raw = await fs.readFile(
      join(lockPath, FILE_LOCK_OWNER_FILENAME),
      "utf8",
    );
    const parsed = JSON.parse(raw) as { ownerToken?: unknown };
    if (parsed.ownerToken !== ownerToken) {
      throw new Error(
        `Refusing to release code-grounding lock owned by another process at ${lockPath}`,
      );
    }
    await fs.rm(lockPath, { recursive: true, force: true });
  } catch (error) {
    if (isMissingPathError(error)) {
      return;
    }
    throw error;
  }
}

async function removeAbandonedCodeGroundingFileLock(
  lockPath: string,
): Promise<boolean> {
  try {
    const stat = await fs.stat(lockPath);
    if (Date.now() - stat.mtimeMs < FILE_LOCK_STALE_MS) {
      return false;
    }
    await fs.rm(lockPath, { recursive: true, force: true });
    return true;
  } catch (error) {
    if (isMissingPathError(error)) {
      return true;
    }
    throw error;
  }
}

function checkoutFileLockPath(paths: CodeGroundingPaths): string {
  return join(paths.checkoutsRoot, `${paths.checkoutId}.lock`);
}

function leaseIndexLockPath(baseRoot: string): string {
  return join(baseRoot, "leases.lock");
}

function getLeaseMutex(workspaceRoot: string): AsyncMutex {
  let mutex = leaseMutexes.get(workspaceRoot);
  if (mutex === undefined) {
    mutex = new AsyncMutex();
    leaseMutexes.set(workspaceRoot, mutex);
  }
  return mutex;
}

function getCheckoutMutex(
  workspaceRoot: string,
  checkoutId: string,
): AsyncMutex {
  const key = `${workspaceRoot}:${checkoutId}`;
  let mutex = checkoutMutexes.get(key);
  if (mutex === undefined) {
    mutex = new AsyncMutex();
    checkoutMutexes.set(key, mutex);
  }
  return mutex;
}

function runGit(
  paths: CodeGroundingPaths,
  input: RunCodeGroundingInput,
  args: readonly string[],
  options?: { cwd?: string },
): Promise<CodeGroundingCommandResult> {
  return runAllowedCommand(input, "git", args, {
    cwd: options?.cwd ?? paths.checkoutPath,
    env: scrubGitPointerEnv({
      ...process.env,
      ...gitIsolationEnv(paths.checkoutPath),
    }),
    timeoutMs: DEFAULT_GIT_TIMEOUT_MS,
  });
}

async function runAllowedCommand(
  input: RunCodeGroundingInput,
  command: string,
  args: readonly string[],
  options: {
    cwd: string;
    env: NodeJS.ProcessEnv;
    timeoutMs: number;
  },
): Promise<CodeGroundingCommandResult> {
  if (command !== "git" || !isAllowedGitCommand(args)) {
    throw new Error(
      `code-grounding command is not allowed: ${command} ${args.join(" ")}`,
    );
  }
  const result = await (input.commandRunner ?? execFileCommandRunner)(
    command,
    args,
    options,
  );
  if (result.exitCode !== 0) {
    throw new Error(
      `code-grounding command failed: ${command} ${args.join(" ")}\n${result.stderr}`,
    );
  }
  return result;
}

function isAllowedGitCommand(args: readonly string[]): boolean {
  return [
    "clone",
    "checkout",
    "reset",
    "clean",
    "rev-parse",
    "status",
    "log",
    "show",
    "cat-file",
    "ls-tree",
  ].includes(args[0] ?? "");
}

const execFileCommandRunner: CodeGroundingCommandRunner = (
  command,
  args,
  options,
) =>
  new Promise((resolvePromise, rejectPromise) => {
    execFile(
      command,
      [...args],
      {
        cwd: options.cwd,
        env: options.env,
        timeout: options.timeoutMs,
      },
      (error, stdout, stderr) => {
        if (error && typeof error.code !== "number") {
          rejectPromise(error);
          return;
        }
        resolvePromise({
          exitCode: error && typeof error.code === "number" ? error.code : 0,
          stdout: stdout.toString(),
          stderr: stderr.toString(),
        });
      },
    );
  });

function buildCheckoutId(target: CodeGroundingTarget): string {
  const digest = createHash("sha256")
    .update(target.repoUrl)
    .update("\0")
    .update(target.commitSha)
    .digest("hex")
    .slice(0, 32);
  return `cg-${digest}`;
}

function resolveGroundingBaseRoot(
  workspaceRoot: string,
  baseDir: string,
): string {
  const resolved = resolve(workspaceRoot, baseDir);
  assertWorkspacePathWithinRoot(workspaceRoot, resolved);
  return resolved;
}

function safePathSegment(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 24);
}

function checkoutMetadata(
  paths: CodeGroundingPaths,
  input: RunCodeGroundingInput,
): CodeGroundingReport["checkout"] {
  return {
    checkoutId: paths.checkoutId,
    path: paths.checkoutPath,
    commitSha: input.target.commitSha,
    repoUrl: input.target.repoUrl,
  };
}

function buildNotAttemptedReport(
  input: RunCodeGroundingInput,
  reason: string,
): CodeGroundingReport {
  return {
    generatedAt: new Date().toISOString(),
    status: "not_attempted",
    checkout: {
      checkoutId: null,
      path: null,
      commitSha: null,
      repoUrl: input.target.repoUrl,
    },
    entries: input.findings.map((finding) => ({
      findingId: finding.findingId,
      status: "not_attempted",
      summary: reason,
      citations: [],
      missing: [],
    })),
    cleanup: {
      leaseReleased: true,
      checkoutPurged: false,
      dirtyState: null,
    },
    warnings: [reason],
  };
}

function summarizeEntries(
  entries: readonly CodeGroundingEvidenceEntry[],
): CodeGroundingVerificationStatus {
  if (entries.length === 0) {
    return "not_attempted";
  }
  if (entries.some((entry) => entry.status === "contaminated")) {
    return "contaminated";
  }
  if (entries.every((entry) => MODEL_VALIDATED_STATUSES.has(entry.status))) {
    return "verified";
  }
  if (entries.some((entry) => entry.status === "contradicted")) {
    return "contradicted";
  }
  if (entries.some((entry) => entry.status === "not_found")) {
    return "not_found";
  }
  return "model_argued_unverified";
}

function addUnique(values: readonly string[], value: string): string[] {
  return values.includes(value) ? [...values] : [...values, value];
}

async function directoryExists(path: string): Promise<boolean> {
  try {
    return (await fs.stat(path)).isDirectory();
  } catch {
    return false;
  }
}

async function realpathOrResolve(path: string): Promise<string> {
  try {
    return await fs.realpath(path);
  } catch {
    return resolve(path);
  }
}

function toRepoRelativePath(root: string, path: string): string {
  return relative(root, path).split(sep).join("/");
}

function hashContent(content: string): string {
  return createHash("sha256").update(content).digest("hex");
}

function isAlreadyExistsPathError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: unknown }).code === "EEXIST"
  );
}

function isMissingPathError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: unknown }).code === "ENOENT"
  );
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolveSleep) => setTimeout(resolveSleep, ms));
}
