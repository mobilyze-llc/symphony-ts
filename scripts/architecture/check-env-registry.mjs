#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

const CONFIG_PATH = "config/architecture/env-registry.json";
const EXPECTED_SCHEMA = "symphony.architecture.env-registry.v1";
const ROOTS = ["src", "scripts", "ops"];
const SOURCE_RE = /\.(?:[cm]?[jt]s|tsx)$/;
const DOT_READ_RE = /\bprocess\.env\.([A-Z][A-Z0-9_]*)\b/g;
const BRACKET_READ_RE = /\bprocess\.env\[['\"]([A-Z][A-Z0-9_]*)['\"]\]/g;
const PASSED_ENV_DOT_READ_RE = /\benv(?:\?\.|\.)([A-Z][A-Z0-9_]*)\b/g;
const PASSED_ENV_BRACKET_READ_RE = /\benv\[['\"]([A-Z][A-Z0-9_]*)['\"]\]/g;

function argValue(args, name) {
  const index = args.indexOf(name);
  return index === -1 ? null : (args[index + 1] ?? null);
}

function sourcePaths() {
  const output = execFileSync(
    "git",
    ["ls-files", "--cached", "--others", "--exclude-standard", "--", ...ROOTS],
    { encoding: "utf8" },
  );
  return [...new Set(output.split("\n").filter((path) => SOURCE_RE.test(path)))]
    .filter((path) => !path.includes("/node_modules/"))
    .sort();
}

export function scanNamedEnvReads(paths = sourcePaths()) {
  const reads = new Map();
  for (const path of paths) {
    if (path.endsWith(".test.ts") || path.endsWith(".test.mjs")) continue;
    const content = readFileSync(path, "utf8");
    for (const pattern of [
      DOT_READ_RE,
      BRACKET_READ_RE,
      PASSED_ENV_DOT_READ_RE,
      PASSED_ENV_BRACKET_READ_RE,
    ]) {
      pattern.lastIndex = 0;
      for (const match of content.matchAll(pattern)) {
        const name = match[1];
        if (!name) continue;
        const sites = reads.get(name) ?? new Set();
        sites.add(path);
        reads.set(name, sites);
      }
    }
  }
  return [...reads]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([name, sites]) => ({ name, read_sites: [...sites].sort() }));
}

function loadConfig(path) {
  const config = JSON.parse(readFileSync(path, "utf8"));
  if (config.schema !== EXPECTED_SCHEMA) {
    throw new Error(`${path}: expected schema ${EXPECTED_SCHEMA}`);
  }
  if (!Array.isArray(config.reads))
    throw new Error(`${path}: reads must be an array`);
  return config;
}

export function findUnregisteredReads(actual, registered) {
  const allowed = new Set(
    registered.flatMap((entry) =>
      entry.read_sites.map((path) => `${entry.name}\u0000${path}`),
    ),
  );
  return actual.flatMap((entry) =>
    entry.read_sites
      .filter((path) => !allowed.has(`${entry.name}\u0000${path}`))
      .map((path) => ({ name: entry.name, path })),
  );
}

function main() {
  const args = process.argv.slice(2);
  const configPath = resolve(argValue(args, "--config") || CONFIG_PATH);
  const actual = scanNamedEnvReads();
  if (args.includes("--update-baseline")) {
    const existing = loadConfig(configPath);
    writeFileSync(
      configPath,
      `${JSON.stringify({ ...existing, reads: actual }, null, 2)}\n`,
    );
    console.log(`updated env-read baseline in ${configPath}`);
    console.log(`format with: pnpm exec biome format --write ${CONFIG_PATH}`);
    return;
  }
  const config = loadConfig(configPath);
  const unregistered = findUnregisteredReads(actual, config.reads);
  if (unregistered.length === 0) {
    console.log(`env registry passed (${actual.length} names)`);
    return;
  }
  for (const read of unregistered) {
    console.log(
      `FAIL ${read.path} env_registry.unregistered_read: ${read.name}`,
    );
    console.log(
      "  remediation: register the named read site with --update-baseline and review the config diff, or remove the environment dependency.",
    );
  }
  process.exitCode = 1;
}

if (process.argv[1]?.endsWith("check-env-registry.mjs")) main();
