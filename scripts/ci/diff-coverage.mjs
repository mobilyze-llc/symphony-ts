#!/usr/bin/env node
/**
 * Diff coverage gate (SYMPH-356).
 *
 * Compares the lines added/modified by a PR (git diff merge-base..HEAD,
 * src/ only) against vitest's v8 coverage report (coverage-final.json,
 * istanbul format) and fails when the share of covered changed lines
 * falls below the threshold.
 *
 * Line semantics follow istanbul's line coverage: a line is "executable"
 * when at least one statement *starts* on it; it is "covered" when any such
 * statement has a hit count > 0. Changed lines that no statement starts on
 * (types, comments, blank lines, continuation lines) are excluded from the
 * denominator.
 *
 * Usage:
 *   node scripts/ci/diff-coverage.mjs \
 *     [--base origin/main] \
 *     [--coverage coverage/coverage-final.json] \
 *     [--threshold 70]
 *
 * Exit codes: 0 = pass (or nothing to measure), 1 = below threshold,
 * 2 = usage/environment error.
 *
 * Plain node, no dependencies. Run `vitest run --coverage` first.
 */

import { execFileSync } from "node:child_process";
import { appendFileSync, existsSync, readFileSync } from "node:fs";
import path from "node:path";

function parseArgs(argv) {
  const opts = {
    base: "origin/main",
    coverage: "coverage/coverage-final.json",
    threshold: 70,
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const next = () => {
      i += 1;
      const value = argv[i];
      if (value === undefined) {
        console.error(`Missing value for ${arg}`);
        process.exit(2);
      }
      return value;
    };
    if (arg === "--base") opts.base = next();
    else if (arg === "--coverage") opts.coverage = next();
    else if (arg === "--threshold") opts.threshold = Number(next());
    else {
      console.error(`Unknown argument: ${arg}`);
      process.exit(2);
    }
  }
  if (
    !Number.isFinite(opts.threshold) ||
    opts.threshold < 0 ||
    opts.threshold > 100
  ) {
    console.error(`Invalid threshold: ${opts.threshold}`);
    process.exit(2);
  }
  return opts;
}

function git(...args) {
  return execFileSync("git", args, {
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });
}

/** Parse a unified diff (-U0) into { [newPath]: Set<changedLineNumbers> }. */
function changedLinesByFile(diffText) {
  const files = new Map();
  let currentFile = null;
  for (const line of diffText.split("\n")) {
    if (line.startsWith("+++ ")) {
      const target = line.slice(4).trim();
      currentFile = target === "/dev/null" ? null : target.replace(/^b\//, "");
      continue;
    }
    if (currentFile === null || !line.startsWith("@@")) continue;
    const match = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/.exec(line);
    if (!match) continue;
    const start = Number(match[1]);
    const count = match[2] === undefined ? 1 : Number(match[2]);
    if (count === 0) continue; // pure deletion
    let set = files.get(currentFile);
    if (!set) {
      set = new Set();
      files.set(currentFile, set);
    }
    for (let lineNo = start; lineNo < start + count; lineNo++) set.add(lineNo);
  }
  return files;
}

const MEASURED_FILE = /^src\/.*\.ts$/;
const DECLARATION_FILE = /\.d\.ts$/;

/** Build { line -> hit count (max across statements starting there) } for one coverage entry. */
function lineHits(entry) {
  const hits = new Map();
  const statementMap = entry.statementMap ?? {};
  const counts = entry.s ?? {};
  for (const [id, loc] of Object.entries(statementMap)) {
    const line = loc?.start?.line;
    if (typeof line !== "number") continue;
    const count = Number(counts[id] ?? 0);
    const previous = hits.get(line);
    if (previous === undefined || count > previous) hits.set(line, count);
  }
  return hits;
}

function formatLineList(lines, limit = 15) {
  const sorted = [...lines].sort((a, b) => a - b);
  const shown = sorted.slice(0, limit).join(", ");
  return sorted.length > limit
    ? `${shown}, … (+${sorted.length - limit} more)`
    : shown;
}

function main() {
  const opts = parseArgs(process.argv.slice(2));

  let mergeBase;
  try {
    mergeBase = git("merge-base", opts.base, "HEAD").trim();
  } catch (error) {
    console.error(
      `Failed to resolve merge-base of ${opts.base} and HEAD: ${error.message}`,
    );
    process.exit(2);
  }

  const diffText = git(
    "diff",
    "--unified=0",
    "--no-color",
    mergeBase,
    "HEAD",
    "--",
    "src",
  );
  const changedFiles = new Map(
    [...changedLinesByFile(diffText)].filter(
      ([file]) => MEASURED_FILE.test(file) && !DECLARATION_FILE.test(file),
    ),
  );

  const summaryLines = [];
  const emit = (line) => {
    console.log(line);
    summaryLines.push(line);
  };

  emit("## Diff coverage (changed lines in src/)");
  emit("");
  emit(
    `Base: \`${opts.base}\` (merge-base \`${mergeBase.slice(0, 12)}\`), threshold: ${opts.threshold}%`,
  );
  emit("");

  if (changedFiles.size === 0) {
    emit("No measurable changes under src/ — nothing to check. PASS.");
    flushSummary(summaryLines);
    process.exit(0);
  }

  if (!existsSync(opts.coverage)) {
    console.error(
      `Coverage report not found: ${opts.coverage} (run vitest with --coverage first)`,
    );
    process.exit(2);
  }
  const coverage = JSON.parse(readFileSync(opts.coverage, "utf8"));

  // Coverage keys are absolute paths; index them relative to the repo root.
  const repoRoot = git("rev-parse", "--show-toplevel").trim();
  const coverageByRelPath = new Map();
  for (const [absPath, entry] of Object.entries(coverage)) {
    coverageByRelPath.set(
      path.relative(repoRoot, absPath).split(path.sep).join("/"),
      entry,
    );
  }

  let totalExecutable = 0;
  let totalCovered = 0;
  const rows = [];
  const warnings = [];

  for (const [file, changedLines] of [...changedFiles].sort(([a], [b]) =>
    a.localeCompare(b),
  )) {
    const entry = coverageByRelPath.get(file);
    if (!entry) {
      warnings.push(
        `\`${file}\`: not present in the coverage report (type-only file, or excluded from coverage.include) — skipped.`,
      );
      continue;
    }
    const hits = lineHits(entry);
    const missed = [];
    let executable = 0;
    let covered = 0;
    for (const line of changedLines) {
      const count = hits.get(line);
      if (count === undefined) continue; // non-executable line
      executable += 1;
      if (count > 0) covered += 1;
      else missed.push(line);
    }
    totalExecutable += executable;
    totalCovered += covered;
    if (executable > 0) {
      const pct = ((covered / executable) * 100).toFixed(1);
      rows.push({ file, executable, covered, pct, missed });
    }
  }

  if (rows.length > 0) {
    emit("| File | Changed executable lines | Covered | % | Missed lines |");
    emit("| --- | ---: | ---: | ---: | --- |");
    for (const row of rows) {
      const missed = row.missed.length > 0 ? formatLineList(row.missed) : "—";
      emit(
        `| \`${row.file}\` | ${row.executable} | ${row.covered} | ${row.pct}% | ${missed} |`,
      );
    }
    emit("");
  }
  for (const warning of warnings) emit(`> ${warning}`);
  if (warnings.length > 0) emit("");

  if (totalExecutable === 0) {
    emit(
      "Changed lines contain no executable statements — nothing to check. PASS.",
    );
    flushSummary(summaryLines);
    process.exit(0);
  }

  const pct = (totalCovered / totalExecutable) * 100;
  const verdict = pct >= opts.threshold ? "PASS" : "FAIL";
  emit(
    `**Total: ${totalCovered}/${totalExecutable} changed executable lines covered (${pct.toFixed(1)}%) — ${verdict}** (threshold ${opts.threshold}%)`,
  );
  flushSummary(summaryLines);
  process.exit(pct >= opts.threshold ? 0 : 1);
}

function flushSummary(lines) {
  const summaryPath = process.env.GITHUB_STEP_SUMMARY;
  if (!summaryPath) return;
  appendFileSync(summaryPath, `${lines.join("\n")}\n`);
}

main();
