export type SupervisionFindingKind =
  | "declared_scope_overlap"
  | "actual_write_collision"
  | "branch_divergence"
  | "eval_drift";

export type SupervisionAction = "redirect" | "pause" | "merge" | "escalate";

export interface WorkerSupervisionSnapshot {
  workerId: string;
  issueIdentifier: string;
  branchName: string | null;
  declaredFileScope?: readonly string[];
  changedFiles?: readonly string[];
  evalFileScope?: readonly string[];
  expectedBaseRevision?: string | null;
  currentBaseRevision?: string | null;
}

export interface SupervisionFinding {
  kind: SupervisionFindingKind;
  action: SupervisionAction;
  workerIds: string[];
  issueIdentifiers: string[];
  files: string[];
  message: string;
}

const FINDING_ORDER: Record<SupervisionFindingKind, number> = {
  declared_scope_overlap: 0,
  actual_write_collision: 1,
  branch_divergence: 2,
  eval_drift: 3,
};

export function detectSupervisionFindings(
  workers: readonly WorkerSupervisionSnapshot[],
): SupervisionFinding[] {
  const normalizedWorkers = workers.map(normalizeWorker).sort(compareWorkers);
  const findings: SupervisionFinding[] = [];

  for (
    let leftIndex = 0;
    leftIndex < normalizedWorkers.length;
    leftIndex += 1
  ) {
    const left = normalizedWorkers[leftIndex];
    if (left === undefined) {
      continue;
    }

    findings.push(...detectWorkerLocalFindings(left));

    for (
      let rightIndex = leftIndex + 1;
      rightIndex < normalizedWorkers.length;
      rightIndex += 1
    ) {
      const right = normalizedWorkers[rightIndex];
      if (right === undefined) {
        continue;
      }
      findings.push(...detectPairFindings(left, right));
    }
  }

  return findings.sort(compareFindings);
}

export function hasBlockingSupervisionFindings(
  workers: readonly WorkerSupervisionSnapshot[],
): boolean {
  return detectSupervisionFindings(workers).length > 0;
}

interface NormalizedWorker {
  workerId: string;
  issueIdentifier: string;
  branchName: string | null;
  declaredFileScope: string[];
  changedFiles: string[];
  evalFileScope: string[] | null;
  expectedBaseRevision: string | null;
  currentBaseRevision: string | null;
}

function detectWorkerLocalFindings(
  worker: NormalizedWorker,
): SupervisionFinding[] {
  const findings: SupervisionFinding[] = [];
  if (
    worker.expectedBaseRevision !== null &&
    worker.currentBaseRevision !== null &&
    worker.expectedBaseRevision !== worker.currentBaseRevision
  ) {
    findings.push({
      kind: "branch_divergence",
      action: "escalate",
      workerIds: [worker.workerId],
      issueIdentifiers: [worker.issueIdentifier],
      files: [],
      message: `${worker.issueIdentifier} is based on ${worker.currentBaseRevision}, expected ${worker.expectedBaseRevision}.`,
    });
  }

  if (worker.evalFileScope !== null) {
    const driftedFiles = sortedDifference(
      worker.changedFiles,
      worker.evalFileScope,
    );
    if (driftedFiles.length > 0) {
      findings.push({
        kind: "eval_drift",
        action: "redirect",
        workerIds: [worker.workerId],
        issueIdentifiers: [worker.issueIdentifier],
        files: driftedFiles,
        message: `${worker.issueIdentifier} changed files outside its eval scope.`,
      });
    }
  }

  return findings;
}

function detectPairFindings(
  left: NormalizedWorker,
  right: NormalizedWorker,
): SupervisionFinding[] {
  const findings: SupervisionFinding[] = [];
  const declaredOverlap = sortedIntersection(
    left.declaredFileScope,
    right.declaredFileScope,
  );
  if (declaredOverlap.length > 0) {
    findings.push({
      kind: "declared_scope_overlap",
      action: "pause",
      workerIds: [left.workerId, right.workerId],
      issueIdentifiers: [left.issueIdentifier, right.issueIdentifier],
      files: declaredOverlap,
      message: `${left.issueIdentifier} and ${right.issueIdentifier} declared overlapping file scope.`,
    });
  }

  const changedOverlap = sortedIntersection(
    left.changedFiles,
    right.changedFiles,
  );
  if (changedOverlap.length > 0) {
    findings.push({
      kind: "actual_write_collision",
      action: "pause",
      workerIds: [left.workerId, right.workerId],
      issueIdentifiers: [left.issueIdentifier, right.issueIdentifier],
      files: changedOverlap,
      message: `${left.issueIdentifier} and ${right.issueIdentifier} changed the same file set.`,
    });
  }

  if (
    left.branchName !== null &&
    right.branchName !== null &&
    left.branchName === right.branchName
  ) {
    findings.push({
      kind: "branch_divergence",
      action: "pause",
      workerIds: [left.workerId, right.workerId],
      issueIdentifiers: [left.issueIdentifier, right.issueIdentifier],
      files: [],
      message: `${left.issueIdentifier} and ${right.issueIdentifier} are using the same branch ${left.branchName}.`,
    });
  }

  return findings;
}

function normalizeWorker(worker: WorkerSupervisionSnapshot): NormalizedWorker {
  return {
    workerId: worker.workerId.trim(),
    issueIdentifier: worker.issueIdentifier.trim(),
    branchName: normalizeNullableString(worker.branchName),
    declaredFileScope: normalizeFileSet(worker.declaredFileScope ?? []),
    changedFiles: normalizeFileSet(worker.changedFiles ?? []),
    evalFileScope:
      worker.evalFileScope === undefined
        ? null
        : normalizeFileSet(worker.evalFileScope),
    expectedBaseRevision: normalizeNullableString(
      worker.expectedBaseRevision ?? null,
    ),
    currentBaseRevision: normalizeNullableString(
      worker.currentBaseRevision ?? null,
    ),
  };
}

function normalizeFileSet(files: readonly string[]): string[] {
  return [
    ...new Set(files.map(normalizeFilePath).filter(isNonEmptyString)),
  ].sort(compareStrings);
}

function normalizeFilePath(file: string): string {
  return file
    .trim()
    .replaceAll("\\", "/")
    .replace(/^\.\/+/, "")
    .replaceAll(/\/{2,}/g, "/");
}

function normalizeNullableString(value: string | null): string | null {
  const normalized = value?.trim() ?? "";
  return normalized.length > 0 ? normalized : null;
}

function sortedIntersection(left: readonly string[], right: readonly string[]) {
  const rightSet = new Set(right);
  return left.filter((item) => rightSet.has(item)).sort(compareStrings);
}

function sortedDifference(left: readonly string[], right: readonly string[]) {
  const rightSet = new Set(right);
  return left.filter((item) => !rightSet.has(item)).sort(compareStrings);
}

function isNonEmptyString(value: string): boolean {
  return value.length > 0;
}

function compareWorkers(
  left: NormalizedWorker,
  right: NormalizedWorker,
): number {
  return (
    compareStrings(left.issueIdentifier, right.issueIdentifier) ||
    compareStrings(left.workerId, right.workerId)
  );
}

function compareFindings(
  left: SupervisionFinding,
  right: SupervisionFinding,
): number {
  return (
    FINDING_ORDER[left.kind] - FINDING_ORDER[right.kind] ||
    compareStrings(
      left.issueIdentifiers.join("\0"),
      right.issueIdentifiers.join("\0"),
    ) ||
    compareStrings(left.workerIds.join("\0"), right.workerIds.join("\0")) ||
    compareStrings(left.files.join("\0"), right.files.join("\0"))
  );
}

function compareStrings(left: string, right: string): number {
  return left.localeCompare(right);
}
