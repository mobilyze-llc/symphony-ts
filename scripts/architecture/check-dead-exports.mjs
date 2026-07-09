#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

const CONFIG_PATH = "config/architecture/dead-exports-baseline.json";
const EXPECTED_SCHEMA = "symphony.architecture.dead-exports.v1";
const ISSUE_TYPES = ["exports", "nsExports", "types", "nsTypes"];

function argValue(args, name) {
  const index = args.indexOf(name);
  return index === -1 ? null : (args[index + 1] ?? null);
}

export function issueKeys(report) {
  const keys = [];
  for (const issue of report.issues ?? []) {
    for (const type of ISSUE_TYPES) {
      for (const symbol of issue[type] ?? []) {
        keys.push(`${issue.file}:${type}:${symbol.name}`);
      }
    }
  }
  return [...new Set(keys)].sort();
}

function runKnip(inputPath) {
  if (inputPath) return JSON.parse(readFileSync(inputPath, "utf8"));
  const output = execFileSync(
    "pnpm",
    [
      "exec",
      "knip",
      "--include",
      ISSUE_TYPES.join(","),
      "--reporter",
      "json",
      "--no-exit-code",
      "--no-progress",
    ],
    { encoding: "utf8", maxBuffer: 100 * 1024 * 1024 },
  );
  return JSON.parse(output);
}

function loadConfig(path) {
  const config = JSON.parse(readFileSync(path, "utf8"));
  if (config.schema !== EXPECTED_SCHEMA) {
    throw new Error(`${path}: expected schema ${EXPECTED_SCHEMA}`);
  }
  if (!Array.isArray(config.issues))
    throw new Error(`${path}: issues must be an array`);
  return config;
}

function main() {
  const args = process.argv.slice(2);
  const configPath = resolve(argValue(args, "--config") || CONFIG_PATH);
  const keys = issueKeys(runKnip(argValue(args, "--input")));
  const config = loadConfig(configPath);
  if (args.includes("--update-baseline")) {
    writeFileSync(
      configPath,
      `${JSON.stringify({ ...config, issues: keys }, null, 2)}\n`,
    );
    console.log(
      `updated dead-export baseline in ${configPath} (${keys.length} issues)`,
    );
    console.log(`format with: pnpm exec biome format --write ${CONFIG_PATH}`);
    return;
  }
  const baseline = new Set(config.issues);
  const newIssues = keys.filter((key) => !baseline.has(key));
  if (newIssues.length === 0) {
    console.log(`dead-export baseline passed (${keys.length} current issues)`);
    return;
  }
  for (const key of newIssues)
    console.log(`FAIL dead_export.new_issue: ${key}`);
  process.exitCode = 1;
}

if (process.argv[1]?.endsWith("check-dead-exports.mjs")) main();
