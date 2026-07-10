import { cp, mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";

interface EvaluationWorkspace {
  path: string;
  cleanup(): Promise<void>;
}

const EVALUATION_ROOT_DIRECTORIES = ["src", "pipeline-config"] as const;
const EVALUATION_ROOT_FILES = [
  "README.md",
  "AGENTS.md",
  "CLAUDE.md",
  "LICENSE",
  "package.json",
  "pnpm-lock.yaml",
  "tsconfig.json",
  "tsconfig.build.json",
] as const;
const EVALUATION_SOURCE_EXCLUSIONS = new Set([
  join("src", "audit", "altitude-reliability.ts"),
  join("src", "cli", "capability-retest.ts"),
  join("src", "cli", "capability-retest-runner.ts"),
  join("src", "cli", "capability-retest-workspace.ts"),
]);

/**
 * Build a source-isolated, history-free workspace for model evaluation.
 *
 * Only production source/configuration is copied. Tests, plans, operations
 * docs, the answer-key module, the scoring CLI, runtime state, and `.git` are
 * absent, so a runner cannot recover expected verdicts from the evaluation
 * checkout. Linear remains available through the runner's normal agent tools.
 */
export async function createCapabilityRetestEvaluationWorkspace(
  sourceRoot: string,
): Promise<EvaluationWorkspace> {
  const root = await mkdtemp(join(tmpdir(), "symphony-capability-eval-"));
  try {
    for (const directory of EVALUATION_ROOT_DIRECTORIES) {
      const source = join(sourceRoot, directory);
      if (!(await pathExists(source))) continue;
      await cp(source, join(root, directory), {
        recursive: true,
        filter: (candidate) => {
          const path = relative(sourceRoot, candidate);
          return !EVALUATION_SOURCE_EXCLUSIONS.has(path);
        },
      });
    }
    for (const filename of EVALUATION_ROOT_FILES) {
      const source = join(sourceRoot, filename);
      if (!(await pathExists(source))) continue;
      await cp(source, join(root, filename));
    }
  } catch (error) {
    await rm(root, { recursive: true, force: true });
    throw error;
  }
  return {
    path: root,
    cleanup: () => rm(root, { recursive: true, force: true }),
  };
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch (error) {
    if (isMissingPathError(error)) return false;
    throw error;
  }
}

function isMissingPathError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: unknown }).code === "ENOENT"
  );
}
