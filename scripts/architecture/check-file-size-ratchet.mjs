#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { evaluateFileSizeRatchet, unwaived } from "./guard-core.mjs";

const CONFIG_PATH = "config/architecture/file-size-ratchet.json";
const EXPECTED_SCHEMA = "symphony.architecture.file-size-ratchet.v1";

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

function changedPaths(base) {
  const paths = new Set();
  const diff = git([
    "diff",
    "--name-only",
    "--diff-filter=ACMRT",
    base,
    "--",
    "src",
  ]);
  for (const path of diff.split("\n").filter(Boolean)) paths.add(path);
  const untracked = git([
    "ls-files",
    "--others",
    "--exclude-standard",
    "--",
    "src",
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
  for (const key of ["new_file_line_cap", "no_growth_line_threshold"]) {
    if (!Number.isInteger(config[key]) || config[key] < 1)
      throw new Error(`${path}: invalid ${key}`);
  }
  if (
    !Array.isArray(config.exempt_path_globs) ||
    !Array.isArray(config.waivers)
  ) {
    throw new Error(`${path}: exempt_path_globs and waivers must be arrays`);
  }
  return config;
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

function main() {
  const args = process.argv.slice(2);
  if (args.includes("--update-pins")) {
    console.log("file-size ratchet has no generated pins; nothing to update");
    return;
  }
  const configPath = resolve(argValue(args, "--config") || CONFIG_PATH);
  const config = loadConfig(configPath);
  const base = resolveBase(args);
  const verdicts = [];
  for (const path of changedPaths(base)) {
    if (!existsSync(path)) continue;
    verdicts.push(
      ...evaluateFileSizeRatchet({
        path,
        oldContent: contentAt(base, path),
        newContent: readFileSync(path, "utf8"),
        rules: config,
      }),
    );
  }
  if (verdicts.length === 0) {
    console.log(`file-size ratchet passed against ${base}`);
    return;
  }
  print(verdicts);
  if (unwaived(verdicts).length > 0) process.exitCode = 1;
}

main();
