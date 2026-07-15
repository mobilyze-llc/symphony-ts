import { execFile } from "node:child_process";
import type { Dirent } from "node:fs";
import { promises as fs } from "node:fs";
import { join, relative, resolve, sep } from "node:path";
import { promisify } from "node:util";

import { withFreshCodeGroundingCheckout } from "./code-grounding-fresh-checkout.js";
import { wordBoundedLiteralIndices } from "./triage-prep-literal.js";
import type {
  ExtractedTriageAnchor,
  TriageFailureClass,
  TriagePrepAnchorEvidence,
  TriagePrepCommit,
  TriagePrepRepositoryInspector,
} from "./triage-prep-types.js";

const execFileAsync = promisify(execFile);

export const inspectTriagePrepRepository: TriagePrepRepositoryInspector =
  async (input) =>
    withFreshCodeGroundingCheckout(
      {
        workspaceRoot: input.workspaceRoot,
        runId: input.runId,
        config: input.config,
        target: input.repository.target,
      },
      async (checkout) => ({
        repository: input.repository.key,
        originMainSha: checkout.commitSha,
        anchors: await Promise.all(
          input.anchors.map((anchor) =>
            inspectAnchor({
              checkoutPath: checkout.path,
              originMainSha: checkout.commitSha,
              repository: input.repository.key,
              anchor,
              filedAt: input.filedAtByAnchor.get(anchor.key) ?? null,
            }),
          ),
        ),
        classEmissions: await inspectClassEmissions(
          checkout.path,
          checkout.commitSha,
          input.repository.key,
          input.failureClasses,
        ),
        error: null,
      }),
    );

async function inspectAnchor(input: {
  checkoutPath: string;
  originMainSha: string;
  repository: string;
  anchor: ExtractedTriageAnchor;
  filedAt: string | null;
}): Promise<TriagePrepAnchorEvidence> {
  const exists = await safeFileExists(input.checkoutPath, input.anchor.path);
  const commits = await commitsSinceFiling(input);
  let currentPath: string | null = exists ? input.anchor.path : null;
  let status: TriagePrepAnchorEvidence["status"] = exists ? "exists" : "gone";
  let reason = exists
    ? "cited path exists on fresh origin/main"
    : "cited path is absent on fresh origin/main";
  if (exists && input.anchor.lineRange !== null && commits.length > 0) {
    status = "moved";
    reason =
      "cited lines were touched after filing; re-anchor before relying on the location";
  } else if (!exists) {
    const movedPath = await findRenamedPath(
      input.checkoutPath,
      input.anchor.path,
    );
    if (
      movedPath !== null &&
      (await safeFileExists(input.checkoutPath, movedPath))
    ) {
      status = "moved";
      currentPath = movedPath;
      reason =
        "git rename history maps the cited path to a live path on fresh origin/main";
    }
  }
  return {
    anchorKey: input.anchor.key,
    repository: input.repository,
    originMainSha: input.originMainSha,
    status,
    currentPath,
    commitsSinceFiling: commits,
    historyPrecision:
      input.anchor.lineRange === null ? "cited_file" : "cited_lines",
    reason,
  };
}

async function commitsSinceFiling(input: {
  checkoutPath: string;
  anchor: ExtractedTriageAnchor;
  filedAt: string | null;
}): Promise<TriagePrepCommit[]> {
  if (input.filedAt === null || Number.isNaN(Date.parse(input.filedAt))) {
    return [];
  }
  const common = ["log", `--since=${input.filedAt}`, "--format=%H%x09%s"];
  const args =
    input.anchor.lineRange === null
      ? [...common, "--", input.anchor.path]
      : [
          ...common,
          "-L",
          `${input.anchor.lineRange[0]},${input.anchor.lineRange[1]}:${input.anchor.path}`,
        ];
  const result = await runGitRead(input.checkoutPath, args);
  if (result.exitCode !== 0) return [];
  const commits = new Map<string, TriagePrepCommit>();
  for (const line of result.stdout.split("\n")) {
    const [sha, ...title] = line.split("\t");
    if (sha !== undefined && /^[0-9a-f]{7,40}$/i.test(sha)) {
      commits.set(sha, { sha, title: title.join("\t") });
    }
  }
  return [...commits.values()];
}

async function findRenamedPath(
  checkoutPath: string,
  citedPath: string,
): Promise<string | null> {
  const result = await runGitRead(checkoutPath, [
    "log",
    "--format=",
    "--name-status",
    "--diff-filter=R",
    "--follow",
    "--",
    citedPath,
  ]);
  if (result.exitCode !== 0) return null;
  for (const line of result.stdout.split("\n")) {
    const [, from, to] = line.split("\t");
    if (from === citedPath && to !== undefined) return to;
  }
  return null;
}

async function inspectClassEmissions(
  checkoutPath: string,
  originMainSha: string,
  repository: string,
  failureClasses: readonly TriageFailureClass[],
) {
  const sites = new Map<
    TriageFailureClass,
    Array<{ path: string; line: number }>
  >(failureClasses.map((failureClass) => [failureClass, []]));
  for (const rootName of ["src", "scripts", "skills", "apps"]) {
    for await (const path of walkProductionFiles(
      join(checkoutPath, rootName),
    )) {
      const content = await fs.readFile(path, "utf8");
      for (const failureClass of failureClasses) {
        const bucket = sites.get(failureClass);
        if (bucket === undefined || bucket.length >= 25) continue;
        for (const index of wordBoundedLiteralIndices(content, failureClass)) {
          bucket.push({
            path: relative(checkoutPath, path).split(sep).join("/"),
            line: content.slice(0, index).split("\n").length,
          });
          if (bucket.length >= 25) break;
        }
      }
    }
  }
  return failureClasses.map((failureClass) => ({
    failureClass,
    repository,
    originMainSha,
    emittedInProduction: (sites.get(failureClass)?.length ?? 0) > 0,
    sites: sites.get(failureClass) ?? [],
  }));
}

async function* walkProductionFiles(root: string): AsyncGenerator<string> {
  let entries: Dirent<string>[];
  try {
    entries = await fs.readdir(root, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (
      entry.isSymbolicLink() ||
      entry.name === "node_modules" ||
      entry.name === "dist"
    ) {
      continue;
    }
    const path = join(root, entry.name);
    if (entry.isDirectory()) yield* walkProductionFiles(path);
    else if (
      entry.isFile() &&
      /\.(?:[cm]?[jt]sx?|py|sh|json|ya?ml)$/.test(entry.name)
    ) {
      yield path;
    }
  }
}

async function safeFileExists(
  root: string,
  repoPath: string,
): Promise<boolean> {
  const path = resolve(root, repoPath);
  if (path !== root && !path.startsWith(`${root}${sep}`)) return false;
  try {
    const stat = await fs.lstat(path);
    return stat.isFile() && !stat.isSymbolicLink();
  } catch {
    return false;
  }
}

async function runGitRead(cwd: string, args: readonly string[]) {
  try {
    const { stdout, stderr } = await execFileAsync("git", [...args], {
      cwd,
      timeout: 60_000,
      maxBuffer: 4 * 1024 * 1024,
    });
    return { exitCode: 0, stdout: String(stdout), stderr: String(stderr) };
  } catch (error) {
    const failure = error as Error & {
      code?: number;
      stdout?: string;
      stderr?: string;
    };
    return {
      exitCode: typeof failure.code === "number" ? failure.code : 1,
      stdout: failure.stdout ?? "",
      stderr: failure.stderr ?? failure.message,
    };
  }
}
