#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { resolve } from "node:path";

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

let stdout = "";
let stderr = "";
let exitCode = 0;
try {
  stdout = execFileSync(args.watcherBin, watcherArgs, {
    cwd: args.workspace,
    encoding: "utf8",
    maxBuffer: 16 * 1024 * 1024,
    stdio: ["ignore", "pipe", "pipe"],
  });
} catch (error) {
  exitCode = typeof error.status === "number" ? error.status : 1;
  stdout = typeof error.stdout === "string" ? error.stdout : "";
  stderr = typeof error.stderr === "string" ? error.stderr : "";
}

if (stderr.trim() !== "") {
  process.stderr.write(stderr);
}

const summary = buildOperatorSummary({
  issue: args.issue,
  mode: args.mode,
  dryRun: args.dryRun,
  watcherBin: args.watcherBin,
  watcherArgs,
  stdout,
  exitCode,
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
    watcherBin:
      process.env.SYMPHONY_SPEC_REVIEW_WATCH_BIN ??
      "symphony-spec-review-watch",
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
    throw new Error(`Unknown option: ${token}`);
  }
  return parsed;
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
      watcherBin: input.watcherBin,
      watcherArgs: redactArgs(input.watcherArgs),
    };
  }
  const results = Array.isArray(parsed.results) ? parsed.results : [];
  const decisions = Array.isArray(parsed.decisions) ? parsed.decisions : [];
  const compactResults = results.map((result) => ({
    issueIdentifier: stringOrNull(result.issueIdentifier),
    readinessState: stringOrNull(result.readinessState),
    verdict: stringOrNull(result.verdict),
    artifactPath: existingPathOrNull(result.artifactPath),
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
    selectedCount:
      typeof parsed.selectedCount === "number" ? parsed.selectedCount : null,
    selectionArtifactPath: existingPathOrNull(parsed.selectionArtifactPath),
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

function existingPathOrNull(value) {
  const path = stringOrNull(value);
  return path !== null && existsSync(path) ? path : null;
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
    "--symphony-spec-review-watch-bin",
  ]);
  return args.map((arg, index) => {
    const previous = args[index - 1];
    return index === 0 || pathFlags.has(previous) ? "[path]" : arg;
  });
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
    "  --symphony-spec-review-watch-bin <path>   Watcher binary override",
    "  --dry-run                                 Selection only",
  ].join("\n");
}
