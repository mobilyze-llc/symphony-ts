#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { evaluateGodFile, lineCount, unwaived } from "./guard-core.mjs";

const CONFIG_PATH = "config/architecture/god-files.json";
const EXPECTED_SCHEMA = "symphony.architecture.god-files.v1";

function argValue(args, name) {
  const index = args.indexOf(name);
  return index === -1 ? null : (args[index + 1] ?? null);
}

function git(args, options = {}) {
  return execFileSync("git", args, {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    ...options,
  }).trim();
}

function resolveBase(args) {
  const explicit =
    argValue(args, "--base") ||
    process.env.ARCHITECTURE_CHECK_BASE_REF ||
    process.env.ARCHITECTURE_CHECK_BASE_SHA;
  if (explicit) return explicit;
  try {
    git(["rev-parse", "--verify", "origin/main"]);
    return "origin/main";
  } catch {
    return "HEAD";
  }
}

function changedPaths(base, pinned) {
  const wanted = new Set(pinned.map((entry) => entry.path));
  const paths = new Set();
  const diff = git([
    "diff",
    "--name-only",
    "--diff-filter=ACMRT",
    base,
    "--",
    ...wanted,
  ]);
  for (const path of diff.split("\n").filter(Boolean)) paths.add(path);
  const untracked = git([
    "ls-files",
    "--others",
    "--exclude-standard",
    "--",
    ...wanted,
  ]);
  for (const path of untracked.split("\n").filter(Boolean)) paths.add(path);
  return [...paths].sort();
}

function contentAt(ref, path) {
  try {
    return execFileSync("git", ["show", `${ref}:${path}`], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      maxBuffer: 100 * 1024 * 1024,
    });
  } catch {
    return null;
  }
}

function loadConfig(path) {
  const config = JSON.parse(readFileSync(path, "utf8"));
  if (config.schema !== EXPECTED_SCHEMA)
    throw new Error(`${path}: expected schema ${EXPECTED_SCHEMA}`);
  if (!Array.isArray(config.pinned_files) || !Array.isArray(config.waivers)) {
    throw new Error(`${path}: pinned_files and waivers must be arrays`);
  }
  return config;
}

function updatePins(configPath, config) {
  let changed = false;
  for (const pin of config.pinned_files) {
    const lines = lineCount(readFileSync(pin.path, "utf8"));
    if (lines > pin.max_lines)
      throw new Error(
        `${pin.path}: current ${lines} lines exceeds pin ${pin.max_lines}`,
      );
    if (lines < pin.max_lines) {
      pin.max_lines = lines;
      changed = true;
    }
  }
  if (changed)
    writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`);
  console.log(
    changed
      ? `updated downward pins in ${configPath}`
      : "god-file pins already match current tree",
  );
}

function print(verdicts) {
  for (const item of verdicts) {
    const prefix = item.status === "waived" ? "WAIVED" : "FAIL";
    console.log(`${prefix} ${item.path} ${item.rule}: ${item.message}`);
    console.log(`  remediation: ${item.remediation}`);
    if (item.waiver)
      console.log(
        `  waiver: ${item.waiver.reason} (expires ${item.waiver.expires})`,
      );
  }
}

function fullSetVerdicts(config) {
  const verdicts = [];
  for (const pin of config.pinned_files) {
    const content = readFileSync(pin.path, "utf8");
    verdicts.push(
      ...evaluateGodFile({
        path: pin.path,
        oldContent: content,
        newContent: content,
        rules: config,
        checkStaleHighPin: true,
      }),
    );
  }
  return verdicts;
}

function main() {
  const args = process.argv.slice(2);
  const configPath = resolve(argValue(args, "--config") || CONFIG_PATH);
  const config = loadConfig(configPath);
  if (args.includes("--update-pins")) {
    updatePins(configPath, config);
    return;
  }
  if (args.includes("--full-set")) {
    const verdicts = fullSetVerdicts(config);
    if (verdicts.length === 0) {
      console.log("god-file full-set checks passed");
      return;
    }
    print(verdicts);
    if (unwaived(verdicts).length > 0) process.exitCode = 1;
    return;
  }
  const base = resolveBase(args);
  const verdicts = [];
  for (const path of changedPaths(base, config.pinned_files)) {
    verdicts.push(
      ...evaluateGodFile({
        path,
        oldContent: contentAt(base, path),
        newContent: readFileSync(path, "utf8"),
        rules: config,
      }),
    );
  }
  if (verdicts.length === 0) {
    console.log(`god-file checks passed against ${base}`);
    return;
  }
  print(verdicts);
  if (unwaived(verdicts).length > 0) process.exitCode = 1;
}

main();
