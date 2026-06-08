import { describe, expect, it } from "vitest";

import {
  type WorkerSupervisionSnapshot,
  detectSupervisionFindings,
  hasBlockingSupervisionFindings,
} from "../../src/orchestrator/supervision.js";

describe("deterministic supervision", () => {
  it("passes workers with disjoint declared scope, writes, branches, and eval coverage", () => {
    const workers = [
      createWorker({
        workerId: "worker-a",
        issueIdentifier: "SYMPH-1",
        branchName: "codex/SYMPH-1",
        declaredFileScope: ["src/a.ts"],
        changedFiles: ["src/a.ts"],
        evalFileScope: ["src/a.ts"],
      }),
      createWorker({
        workerId: "worker-b",
        issueIdentifier: "SYMPH-2",
        branchName: "codex/SYMPH-2",
        declaredFileScope: ["src/b.ts"],
        changedFiles: ["src/b.ts"],
        evalFileScope: ["src/b.ts"],
      }),
    ];

    expect(detectSupervisionFindings(workers)).toEqual([]);
    expect(hasBlockingSupervisionFindings(workers)).toBe(false);
  });

  it("catches declared file-scope overlap before co-running workers", () => {
    const findings = detectSupervisionFindings([
      createWorker({
        issueIdentifier: "SYMPH-1",
        declaredFileScope: ["src/shared/config.ts", "src/a.ts"],
      }),
      createWorker({
        issueIdentifier: "SYMPH-2",
        declaredFileScope: ["./src/shared/config.ts", "src/b.ts"],
      }),
    ]);

    expect(findings).toContainEqual({
      kind: "declared_scope_overlap",
      action: "pause",
      workerIds: ["worker-SYMPH-1", "worker-SYMPH-2"],
      issueIdentifiers: ["SYMPH-1", "SYMPH-2"],
      files: ["src/shared/config.ts"],
      message: "SYMPH-1 and SYMPH-2 declared overlapping file scope.",
    });
  });

  it("catches a planted collision when actual writes overlap despite disjoint declared scopes", () => {
    const findings = detectSupervisionFindings([
      createWorker({
        issueIdentifier: "SYMPH-10",
        declaredFileScope: ["src/features/alpha.ts"],
        changedFiles: ["src/features/alpha.ts", "src/shared/config.ts"],
      }),
      createWorker({
        issueIdentifier: "SYMPH-11",
        declaredFileScope: ["src/features/beta.ts"],
        changedFiles: ["src/features/beta.ts", "src/shared/config.ts"],
      }),
    ]);

    expect(findings).toEqual([
      {
        kind: "actual_write_collision",
        action: "pause",
        workerIds: ["worker-SYMPH-10", "worker-SYMPH-11"],
        issueIdentifiers: ["SYMPH-10", "SYMPH-11"],
        files: ["src/shared/config.ts"],
        message: "SYMPH-10 and SYMPH-11 changed the same file set.",
      },
    ]);
  });

  it("catches branch divergence and branch reuse deterministically", () => {
    const findings = detectSupervisionFindings([
      createWorker({
        issueIdentifier: "SYMPH-1",
        branchName: "codex/shared",
        expectedBaseRevision: "base-a",
        currentBaseRevision: "base-b",
      }),
      createWorker({
        issueIdentifier: "SYMPH-2",
        branchName: "codex/shared",
      }),
    ]);

    expect(findings).toEqual([
      {
        kind: "branch_divergence",
        action: "escalate",
        workerIds: ["worker-SYMPH-1"],
        issueIdentifiers: ["SYMPH-1"],
        files: [],
        message: "SYMPH-1 is based on base-b, expected base-a.",
      },
      {
        kind: "branch_divergence",
        action: "pause",
        workerIds: ["worker-SYMPH-1", "worker-SYMPH-2"],
        issueIdentifiers: ["SYMPH-1", "SYMPH-2"],
        files: [],
        message: "SYMPH-1 and SYMPH-2 are using the same branch codex/shared.",
      },
    ]);
  });

  it("redirects a worker when its diff drifts outside the eval file scope", () => {
    const findings = detectSupervisionFindings([
      createWorker({
        issueIdentifier: "SYMPH-3",
        changedFiles: ["src/expected.ts", "src/uncovered.ts"],
        evalFileScope: ["src/expected.ts"],
      }),
    ]);

    expect(findings).toEqual([
      {
        kind: "eval_drift",
        action: "redirect",
        workerIds: ["worker-SYMPH-3"],
        issueIdentifiers: ["SYMPH-3"],
        files: ["src/uncovered.ts"],
        message: "SYMPH-3 changed files outside its eval scope.",
      },
    ]);
  });
});

function createWorker(
  overrides: Partial<WorkerSupervisionSnapshot>,
): WorkerSupervisionSnapshot {
  const issueIdentifier = overrides.issueIdentifier ?? "SYMPH-1";
  const worker: WorkerSupervisionSnapshot = {
    workerId: overrides.workerId ?? `worker-${issueIdentifier}`,
    issueIdentifier,
    branchName: overrides.branchName ?? `codex/${issueIdentifier}`,
    declaredFileScope: overrides.declaredFileScope ?? [],
    changedFiles: overrides.changedFiles ?? [],
  };
  if (overrides.evalFileScope !== undefined) {
    worker.evalFileScope = overrides.evalFileScope;
  }
  if (overrides.expectedBaseRevision !== undefined) {
    worker.expectedBaseRevision = overrides.expectedBaseRevision;
  }
  if (overrides.currentBaseRevision !== undefined) {
    worker.currentBaseRevision = overrides.currentBaseRevision;
  }
  return worker;
}
