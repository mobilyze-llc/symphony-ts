import { execFile } from "node:child_process";
import { promisify } from "node:util";

import {
  gitIsolationEnv,
  scrubGitPointerEnv,
} from "../workspace/git-isolation.js";
import {
  type CodeGroundingCommandRunner,
  type CodeGroundingConfig,
  type CodeGroundingTarget,
  runManagedCodeGrounding,
} from "./code-grounding.js";

const execFileAsync = promisify(execFile);
const FRESH_ORIGIN_MAIN_REF = "refs/remotes/origin/main";

export type FreshCodeGroundingTarget = Omit<CodeGroundingTarget, "commitSha">;

export interface FreshCodeGroundingCheckout {
  checkoutId: string;
  path: string;
  commitSha: string;
  repoUrl: string;
}

export interface WithFreshCodeGroundingCheckoutInput {
  workspaceRoot: string;
  runId: string;
  config: CodeGroundingConfig;
  target: FreshCodeGroundingTarget;
  commandRunner?: CodeGroundingCommandRunner;
}

/**
 * Fresh-main extension over code-grounding's managed callback seam. The fixed
 * symbolic target gives every repo one reusable locked/leased checkout; the
 * callback fetches and resets it before inspection. The shared dirty-check and
 * lease release still run after the callback.
 */
export async function withFreshCodeGroundingCheckout<T>(
  input: WithFreshCodeGroundingCheckoutInput,
  inspect: (checkout: FreshCodeGroundingCheckout) => Promise<T>,
): Promise<T> {
  let inspected: T | undefined;
  let inspectionCompleted = false;
  const report = await runManagedCodeGrounding({
    workspaceRoot: input.workspaceRoot,
    runId: input.runId,
    config: input.config,
    target: {
      ...input.target,
      // This helper intentionally extends grounding to read-only multi-repo
      // triage. The base engine's v1 scope gate is otherwise Symphony-only.
      repoScope: "symphony",
      commitSha: FRESH_ORIGIN_MAIN_REF,
    },
    findings: [],
    ...(input.commandRunner === undefined
      ? {}
      : { commandRunner: input.commandRunner }),
    afterDeterministicScan: async ({ checkoutPath, checkoutId }) => {
      await runGit(checkoutPath, [
        "fetch",
        "--prune",
        "origin",
        "+refs/heads/main:refs/remotes/origin/main",
      ]);
      const commitSha = (
        await runGit(checkoutPath, ["rev-parse", FRESH_ORIGIN_MAIN_REF])
      ).trim();
      await runGit(checkoutPath, ["checkout", "--detach", commitSha]);
      await runGit(checkoutPath, ["reset", "--hard", commitSha]);
      await runGit(checkoutPath, ["clean", "-fdx"]);
      inspected = await inspect({
        checkoutId,
        path: checkoutPath,
        commitSha,
        repoUrl: input.target.repoUrl,
      });
      inspectionCompleted = true;
    },
  });
  if (!inspectionCompleted) {
    throw new Error(
      report.warnings[0] ?? "fresh managed checkout inspection did not run",
    );
  }
  return inspected as T;
}

async function runGit(cwd: string, args: readonly string[]): Promise<string> {
  const { stdout } = await execFileAsync("git", [...args], {
    cwd,
    env: scrubGitPointerEnv({
      ...process.env,
      ...gitIsolationEnv(cwd),
    }),
    timeout: 600_000,
    maxBuffer: 4 * 1024 * 1024,
  });
  return String(stdout);
}
