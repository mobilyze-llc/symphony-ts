#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { existsSync, realpathSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";

const WATCHER_PREFLIGHT_TIMEOUT_MS = 10_000;

const args = parseArgs(process.argv.slice(2));
if (args.help) {
  console.log(usage());
  process.exit(0);
}
if (args.issue === null || args.workspace === null) {
  console.error("--issue and --workspace are required\n");
  console.error(usage());
  process.exit(2);
}

const workflow = args.workflow ?? resolve(args.workspace, "WORKFLOW.md");
const watcherArgs = [
  workflow,
  "--workspace",
  args.workspace,
  "--mode",
  args.mode,
  "--issue-direct",
  args.issue,
];
if (args.force) {
  watcherArgs.push("--force");
}
if (args.dryRun) {
  watcherArgs.push("--dry-run");
}
for (const sourceRef of args.sourceRefs) {
  watcherArgs.push("--source-ref", sourceRef);
}
if (args.artifactRoot !== null) {
  watcherArgs.push("--artifact-root", args.artifactRoot);
}
if (args.cmuxSpawnBin !== null) {
  watcherArgs.push("--cmux-spawn-bin", args.cmuxSpawnBin);
}

const resolvedWatcher = resolveWatcherInvocation(args);
let stdout = "";
let stderr = "";
let exitCode = 0;
let diagnostic = null;
const preflightFailure = preflightWatcher(resolvedWatcher, args.workspace);
if (preflightFailure !== null) {
  diagnostic = preflightFailure;
  exitCode = preflightFailure.exitCode;
  stderr = `${preflightFailure.message}\n`;
} else {
  try {
    stdout = execFileSync(
      resolvedWatcher.file,
      [...resolvedWatcher.prefixArgs, ...watcherArgs],
      {
        cwd: args.workspace,
        encoding: "utf8",
        maxBuffer: 16 * 1024 * 1024,
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
  } catch (error) {
    exitCode = typeof error.status === "number" ? error.status : 1;
    stdout = typeof error.stdout === "string" ? error.stdout : "";
    stderr = typeof error.stderr === "string" ? error.stderr : "";
  }
}

if (stderr.trim() !== "") {
  process.stderr.write(stderr);
}

const summary = buildOperatorSummary({
  issue: args.issue,
  workspace: args.workspace,
  mode: args.mode,
  dryRun: args.dryRun,
  watcherBin: resolvedWatcher.displayName,
  watcherSource: resolvedWatcher.source,
  watcherArgs,
  stdout,
  exitCode,
  diagnostic,
});
console.log(JSON.stringify(summary, null, 2));
process.exitCode = exitCode;

function parseArgs(argv) {
  const parsed = {
    issue: null,
    workspace: null,
    workflow: null,
    mode: "observe",
    force: false,
    dryRun: false,
    sourceRefs: [],
    artifactRoot: null,
    cmuxSpawnBin: null,
    watcherBin: stringOrNull(process.env.SYMPHONY_SPEC_REVIEW_WATCH_BIN),
    watcherRuntimeRoot: stringOrNull(
      process.env.SYMPHONY_SPEC_REVIEW_RUNTIME_ROOT,
    ),
    help: false,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === "--help" || token === "-h") {
      parsed.help = true;
      continue;
    }
    if (token === "--force" || token === "--review-now") {
      parsed.force = true;
      continue;
    }
    if (token === "--dry-run") {
      parsed.dryRun = true;
      continue;
    }
    if (token === "--issue") {
      parsed.issue = readValue(argv, ++index, token);
      continue;
    }
    if (token === "--workspace") {
      parsed.workspace = resolve(readValue(argv, ++index, token));
      continue;
    }
    if (token === "--workflow") {
      parsed.workflow = resolve(readValue(argv, ++index, token));
      continue;
    }
    if (token === "--mode") {
      parsed.mode = parseMode(readValue(argv, ++index, token));
      continue;
    }
    if (token === "--source-ref") {
      parsed.sourceRefs.push(readValue(argv, ++index, token));
      continue;
    }
    if (token === "--artifact-root") {
      parsed.artifactRoot = resolve(readValue(argv, ++index, token));
      continue;
    }
    if (token === "--cmux-spawn-bin") {
      parsed.cmuxSpawnBin = readValue(argv, ++index, token);
      continue;
    }
    if (token === "--symphony-spec-review-watch-bin") {
      parsed.watcherBin = readValue(argv, ++index, token);
      continue;
    }
    if (token === "--watcher-runtime-root") {
      parsed.watcherRuntimeRoot = readValue(argv, ++index, token);
      continue;
    }
    throw new Error(`Unknown option: ${token}`);
  }
  return parsed;
}

function resolveWatcherInvocation(args) {
  if (args.watcherBin !== null) {
    const watcherBin = resolvePathLikeOverride(args.watcherBin, args.workspace);
    return {
      file: watcherBin,
      prefixArgs: [],
      displayName: watcherBin,
      source: "override",
    };
  }
  if (args.watcherRuntimeRoot !== null) {
    return resolveBuiltWatcherAtRoot(
      resolvePathLikeOverride(args.watcherRuntimeRoot, args.workspace),
      "runtime_root_dist",
    );
  }
  const workspaceBuiltWatcher = resolve(
    args.workspace,
    "dist/src/cli/spec-review-watch.js",
  );
  if (existsSync(workspaceBuiltWatcher)) {
    return {
      file: process.execPath,
      prefixArgs: [workspaceBuiltWatcher],
      displayName: workspaceBuiltWatcher,
      source: "workspace_dist",
    };
  }
  const linkedMainWorktree = discoverLinkedMainWorktree(args.workspace);
  if (linkedMainWorktree !== null) {
    const linkedMainWatcher = resolveBuiltWatcherAtRoot(
      linkedMainWorktree,
      "linked_main_dist",
    );
    if (existsSync(linkedMainWatcher.displayName)) {
      return linkedMainWatcher;
    }
  }
  return {
    file: "symphony-spec-review-watch",
    prefixArgs: [],
    displayName: "symphony-spec-review-watch",
    source: "path",
  };
}

function resolveBuiltWatcherAtRoot(root, source) {
  const watcherPath = resolve(root, "dist/src/cli/spec-review-watch.js");
  if (!existsSync(watcherPath)) {
    return {
      file: watcherPath,
      prefixArgs: [],
      displayName: watcherPath,
      source,
    };
  }
  return {
    file: process.execPath,
    prefixArgs: [watcherPath],
    displayName: watcherPath,
    source,
  };
}

function discoverLinkedMainWorktree(workspace) {
  try {
    const workspaceRealpath = realpathOrResolve(workspace);
    const output = execFileSync("git", ["worktree", "list", "--porcelain"], {
      cwd: workspace,
      encoding: "utf8",
      maxBuffer: 1024 * 1024,
      timeout: WATCHER_PREFLIGHT_TIMEOUT_MS,
      stdio: ["ignore", "pipe", "ignore"],
    });
    for (const line of output.split(/\r?\n/)) {
      if (line.startsWith("worktree ")) {
        const worktree = resolve(line.slice("worktree ".length));
        if (realpathOrResolve(worktree) !== workspaceRealpath) {
          return worktree;
        }
      }
    }
  } catch {
    return null;
  }
  return null;
}

function realpathOrResolve(path) {
  try {
    return realpathSync(path);
  } catch {
    return resolve(path);
  }
}

function resolvePathLikeOverride(value, workspace) {
  return isPathLike(value) ? resolve(workspace, value) : value;
}

function preflightWatcher(watcher, cwd) {
  let help = "";
  try {
    help = execFileSync(watcher.file, [...watcher.prefixArgs, "--help"], {
      cwd,
      encoding: "utf8",
      maxBuffer: 1024 * 1024,
      timeout: WATCHER_PREFLIGHT_TIMEOUT_MS,
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch (error) {
    const missing = isMissingExecutableError(error);
    return {
      kind: missing ? "missing_executable" : "preflight_failed",
      exitCode: missing
        ? 1
        : typeof error.status === "number"
          ? error.status
          : 1,
      message: missing
        ? missingWatcherMessage(watcher)
        : `Spec review watcher help preflight failed before review launch. ${errorMessage(error)}`,
    };
  }
  if (
    !helpIncludesFlag(help, "--issue-direct") ||
    !helpIncludesFlag(help, "--ticket")
  ) {
    return {
      kind: "stale_watcher",
      exitCode: 1,
      message:
        "Spec review watcher appears stale: --help does not list --issue-direct and --ticket. Run `pnpm build` from this checkout or pass a current watcher with --symphony-spec-review-watch-bin.",
    };
  }
  return null;
}

function helpIncludesFlag(help, flag) {
  let index = help.indexOf(flag);
  while (index !== -1) {
    const before = help[index - 1];
    const after = help[index + flag.length];
    if (isFlagBoundary(before) && isFlagBoundary(after)) {
      return true;
    }
    index = help.indexOf(flag, index + flag.length);
  }
  return false;
}

function isFlagBoundary(char) {
  return char === undefined || !isFlagNameChar(char);
}

function isFlagNameChar(char) {
  if (char === "-" || char === "_") {
    return true;
  }
  const code = char.charCodeAt(0);
  return (
    (code >= 48 && code <= 57) ||
    (code >= 65 && code <= 90) ||
    (code >= 97 && code <= 122)
  );
}

function isMissingExecutableError(error) {
  return (
    error?.code === "ENOENT" ||
    (typeof error?.message === "string" && error.message.includes("ENOENT"))
  );
}

function missingWatcherMessage(watcher) {
  if (watcher.source === "runtime_root_dist") {
    return `Spec review runtime root is not built: expected ${watcher.displayName}. Run \`pnpm build\` once in the configured runtime checkout, then rerun.`;
  }
  if (watcher.source === "override") {
    return "Spec review watcher override could not be launched. Point --symphony-spec-review-watch-bin or SYMPHONY_SPEC_REVIEW_WATCH_BIN at an executable watcher command, then rerun.";
  }
  return "Spec review watcher is not available. Build the durable runtime once and set SYMPHONY_SPEC_REVIEW_RUNTIME_ROOT to that checkout before rerunning.";
}

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}

function readValue(argv, index, option) {
  const value = argv[index];
  if (value === undefined || value.startsWith("--")) {
    throw new Error(`${option} requires a value`);
  }
  return value;
}

function parseMode(value) {
  if (value === "observe" || value === "warn" || value === "enforce") {
    return value;
  }
  throw new Error("--mode must be observe, warn, or enforce");
}

function buildOperatorSummary(input) {
  const parsed = parseJsonObject(input.stdout);
  if (parsed === null) {
    return {
      schemaVersion: 1,
      source: "spec-review-lane",
      issue: input.issue,
      mode: input.mode,
      reconciliation: "durable_watcher",
      status: input.exitCode === 0 ? "unknown" : "failed",
      exitCode: input.exitCode,
      nextAction: input.exitCode === 0 ? "inspect_output" : "inspect_failure",
      rawOutputBytes: Buffer.byteLength(input.stdout),
      watcherBin: redactPathLike(input.watcherBin),
      watcherSource: input.watcherSource,
      watcherArgs: redactArgs(input.watcherArgs),
      diagnostic: input.diagnostic,
    };
  }
  const results = Array.isArray(parsed.results) ? parsed.results : [];
  const decisions = Array.isArray(parsed.decisions) ? parsed.decisions : [];
  const compactResults = results.map((result) => ({
    issueIdentifier: stringOrNull(result.issueIdentifier),
    readinessState: stringOrNull(result.readinessState),
    verdict: stringOrNull(result.verdict),
    artifactPath: existingPathOrNull(result.artifactPath, input.workspace),
    linearDocUrl: stringOrNull(result.linearDocUrl),
    nextAction: nextActionForReadiness(stringOrNull(result.readinessState)),
  }));
  return {
    schemaVersion: 1,
    source: "spec-review-lane",
    issue: input.issue,
    mode: input.mode,
    reconciliation: input.dryRun ? "selection_only" : "durable_watcher",
    status: input.exitCode === 0 ? "completed" : "failed",
    exitCode: input.exitCode,
    watcherSource: input.watcherSource,
    diagnostic: input.diagnostic,
    selectedCount:
      typeof parsed.selectedCount === "number" ? parsed.selectedCount : null,
    selectionArtifactPath: existingPathOrNull(
      parsed.selectionArtifactPath,
      input.workspace,
    ),
    summary: parsed.summary ?? null,
    decisions: decisions.map((decision) => ({
      issueIdentifier: decision?.issue?.identifier ?? null,
      status: stringOrNull(decision.status),
      reasons: Array.isArray(decision.reasons) ? decision.reasons : [],
    })),
    results: compactResults,
    nextAction:
      compactResults[0]?.nextAction ??
      (input.dryRun ? "inspect_selection" : "inspect_output"),
  };
}

function parseJsonObject(text) {
  try {
    const parsed = JSON.parse(text);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed
      : null;
  } catch {
    return null;
  }
}

function stringOrNull(value) {
  return typeof value === "string" && value.trim() !== "" ? value : null;
}

function existingPathOrNull(value, workspace) {
  const path = stringOrNull(value);
  if (path === null) {
    return null;
  }
  const resolvedPath = isAbsolute(path) ? path : resolve(workspace, path);
  return existsSync(resolvedPath) ? resolvedPath : null;
}

function nextActionForReadiness(readinessState) {
  switch (readinessState) {
    case "valid":
      return "none";
    case "needs_operator_context":
      return "supply_operator_context";
    case "failed":
    case "runner_failed":
    case "invalid_artifact":
      return "rerun_or_inspect_artifact";
    case "privacy_blocked":
      return "handle_out_of_band";
    default:
      return "inspect_selection";
  }
}

function redactArgs(args) {
  const pathFlags = new Set([
    "--workspace",
    "--workflow",
    "--source-ref",
    "--artifact-root",
    "--cmux-spawn-bin",
  ]);
  return args.map((arg, index) => {
    const previous = args[index - 1];
    return index === 0 || pathFlags.has(previous) ? "[path]" : arg;
  });
}

function redactPathLike(value) {
  return isPathLike(value) ? "[path]" : value;
}

function isPathLike(value) {
  return value.includes("/") || value.includes("\\");
}

function usage() {
  return [
    "Usage: run-spec-review-lane.mjs --workspace <repo> --issue <id> [options]",
    "",
    "Options:",
    "  --workflow <file>                         Workflow file (default: <workspace>/WORKFLOW.md)",
    "  --mode observe|warn|enforce               Review mode (default: observe)",
    "  --force, --review-now                     Override skip heuristics for the targeted issue",
    "  --source-ref <path>                       Source-of-truth file (repeatable)",
    "  --artifact-root <dir>                     Artifact root",
    "  --cmux-spawn-bin <path>                   cmux-spawn override",
    "  --symphony-spec-review-watch-bin <path>   Watcher command override",
    "  --watcher-runtime-root <dir>              Built Symphony checkout to use when <workspace> has no dist",
    "  --dry-run                                 Selection only",
  ].join("\n");
}
