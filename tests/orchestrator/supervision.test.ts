import { describe, expect, it } from "vitest";

import {
  type WorkerSupervisionSnapshot,
  detectIgnoredSetupInstructionCollisions,
  detectSupervisionFindings,
  extractDeclaredFileScope,
  extractEvalFileScope,
  formatSupervisionFindingsComment,
  hasBlockingSupervisionFindings,
} from "../../src/orchestrator/supervision.js";

const SETUP_INSTRUCTION_FILES = [
  "CLAUDE.md",
  "AGENTS.md",
  "AGENTS.override.md",
] as const;

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

  it.each(SETUP_INSTRUCTION_FILES)(
    "ignores setup-only root %s overlaps when implementation writes are disjoint",
    (instructionFile) => {
      const workers = [
        createWorker({
          issueIdentifier: "SYMPH-320",
          declaredFileScope: ["src/orchestrator/runtime-host.ts"],
          changedFiles: [instructionFile, "src/orchestrator/runtime-host.ts"],
        }),
        createWorker({
          issueIdentifier: "SYMPH-326",
          declaredFileScope: ["src/observability/dashboard-render.ts"],
          changedFiles: [
            `./${instructionFile}`,
            "src/observability/dashboard-render.ts",
          ],
        }),
      ];

      expect(detectSupervisionFindings(workers)).toEqual([]);
      expect(hasBlockingSupervisionFindings(workers)).toBe(false);
      expect(detectIgnoredSetupInstructionCollisions(workers)).toEqual([
        {
          workerIds: ["worker-SYMPH-320", "worker-SYMPH-326"],
          issueIdentifiers: ["SYMPH-320", "SYMPH-326"],
          files: [instructionFile],
          message:
            "SYMPH-320 and SYMPH-326 share setup-only instruction-file changes that were ignored for write-collision supervision.",
        },
      ]);
    },
  );

  it("keeps root instruction-file overlaps blocking when a worker declares the file in scope", () => {
    const workers = [
      createWorker({
        issueIdentifier: "SYMPH-1",
        declaredFileScope: ["CLAUDE.md"],
        changedFiles: ["CLAUDE.md"],
      }),
      createWorker({
        issueIdentifier: "SYMPH-2",
        declaredFileScope: ["src/features/beta.ts"],
        changedFiles: ["CLAUDE.md", "src/features/beta.ts"],
      }),
    ];
    const findings = detectSupervisionFindings(workers);

    expect(findings).toEqual([
      {
        kind: "actual_write_collision",
        action: "pause",
        workerIds: ["worker-SYMPH-1", "worker-SYMPH-2"],
        issueIdentifiers: ["SYMPH-1", "SYMPH-2"],
        files: ["CLAUDE.md"],
        message: "SYMPH-1 and SYMPH-2 changed the same file set.",
      },
    ]);
    expect(detectIgnoredSetupInstructionCollisions(workers)).toEqual([]);
  });

  it("keeps root instruction-file overlaps blocking when a worker evaluates the file in scope", () => {
    const workers = [
      createWorker({
        issueIdentifier: "SYMPH-1",
        changedFiles: ["AGENTS.override.md"],
        evalFileScope: ["AGENTS.override.md"],
      }),
      createWorker({
        issueIdentifier: "SYMPH-2",
        declaredFileScope: ["src/features/beta.ts"],
        changedFiles: ["AGENTS.override.md", "src/features/beta.ts"],
      }),
    ];
    const findings = detectSupervisionFindings(workers);

    expect(findings).toEqual([
      {
        kind: "actual_write_collision",
        action: "pause",
        workerIds: ["worker-SYMPH-1", "worker-SYMPH-2"],
        issueIdentifiers: ["SYMPH-1", "SYMPH-2"],
        files: ["AGENTS.override.md"],
        message: "SYMPH-1 and SYMPH-2 changed the same file set.",
      },
    ]);
    expect(detectIgnoredSetupInstructionCollisions(workers)).toEqual([]);
  });

  it("reports ignored setup-only files on mixed actual-write collisions", () => {
    const findings = detectSupervisionFindings([
      createWorker({
        issueIdentifier: "SYMPH-10",
        declaredFileScope: ["src/features/alpha.ts"],
        changedFiles: [
          "CLAUDE.md",
          "src/features/alpha.ts",
          "src/shared/config.ts",
        ],
      }),
      createWorker({
        issueIdentifier: "SYMPH-11",
        declaredFileScope: ["src/features/beta.ts"],
        changedFiles: [
          "CLAUDE.md",
          "src/features/beta.ts",
          "src/shared/config.ts",
        ],
      }),
    ]);

    expect(findings).toEqual([
      {
        kind: "actual_write_collision",
        action: "pause",
        workerIds: ["worker-SYMPH-10", "worker-SYMPH-11"],
        issueIdentifiers: ["SYMPH-10", "SYMPH-11"],
        files: ["src/shared/config.ts"],
        ignoredFiles: ["CLAUDE.md"],
        message: "SYMPH-10 and SYMPH-11 changed the same file set.",
      },
    ]);
    expect(
      formatSupervisionFindingsComment({
        phase: "running",
        findings,
      }),
    ).toContain("Ignored setup-only files: `CLAUDE.md`.");
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

  it("extracts declared and eval file scopes from markdown issue sections", () => {
    const description = [
      "Issue context.",
      "",
      "## Declared file scope",
      "- `src/orchestrator/core.ts`",
      "- ./src/orchestrator/runtime-host.ts - runtime snapshot wiring",
      "- README.md",
      "",
      "## Eval file scope",
      "1. `tests/orchestrator/core.test.ts`",
      "2. tests/orchestrator/runtime-host.test.ts",
      "",
      "## Acceptance criteria",
      "- This section should not be parsed as scope.",
    ].join("\n");

    expect(extractDeclaredFileScope(description)).toEqual([
      "README.md",
      "src/orchestrator/core.ts",
      "src/orchestrator/runtime-host.ts",
    ]);
    expect(extractEvalFileScope(description)).toEqual([
      "tests/orchestrator/core.test.ts",
      "tests/orchestrator/runtime-host.test.ts",
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
