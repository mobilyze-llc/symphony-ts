#!/usr/bin/env node
// docs-sync (SYMPH-870): regenerate AUTOGEN blocks in operations docs from their
// generated sources so the docs can never silently drift from the code.
//
// Today it syncs the `symphony-manager-plan` usage block in
// docs/operations/02-symphony-manager-plan.md from the built CLI's `--help`
// output (which is exactly `renderUsage()`).
//
//   pnpm docs:sync     rewrite the block in place (after `pnpm build`)
//   pnpm docs:check    exit non-zero if the block is stale (CI / gate helper)
//
// Enforcement is the vitest gate in tests/docs/operations-doc-sync.test.ts, which
// runs under `pnpm test` against `renderUsage()` directly (no dist needed). This
// script is the regenerator and a standalone CLI check. It deliberately does NOT
// run during `pnpm build`: writing a tracked file on build would dirty the pro14
// host worktree and break `git merge --ff-only` deploys.
import { execFileSync } from "node:child_process";
import { readFileSync, realpathSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/** AUTOGEN markers delimiting the managed usage block. Edit `renderUsage()`, not the block. */
export const AUTOGEN = {
  start:
    "<!-- AUTOGEN:help START — managed by scripts/docs-sync.mjs; edit src/cli/manager-plan.ts renderUsage() -->",
  end: "<!-- AUTOGEN:help END -->",
};

/**
 * Replace the body between `start` and `end` markers (markers themselves are
 * preserved). Throws if either marker is missing or out of order so a malformed
 * doc fails loudly instead of silently no-op'ing.
 */
export function replaceAutogenRegion(content, start, end, body) {
  const s = content.indexOf(start);
  if (s === -1) {
    throw new Error(`docs-sync: start marker not found: ${start}`);
  }
  const e = content.indexOf(end, s + start.length);
  if (e === -1) {
    throw new Error(`docs-sync: end marker not found after start: ${end}`);
  }
  return `${content.slice(0, s + start.length)}\n${body}\n${content.slice(e)}`;
}

/** Wrap generated help text in a fenced `text` code block, trimming trailing whitespace. */
export function helpBlock(helpText) {
  return ["```text", helpText.replace(/\s+$/, ""), "```"].join("\n");
}

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const DOC = join(ROOT, "docs/operations/02-symphony-manager-plan.md");
const CLI = join(ROOT, "dist/src/cli/manager-plan.js");

function currentHelp() {
  return execFileSync(process.execPath, [CLI, "--help"], { encoding: "utf8" });
}

function run() {
  const check = process.argv.includes("--check");
  const original = readFileSync(DOC, "utf8");
  const updated = replaceAutogenRegion(
    original,
    AUTOGEN.start,
    AUTOGEN.end,
    helpBlock(currentHelp()),
  );
  if (updated === original) {
    process.stdout.write(
      "docs-sync: docs/operations/02-symphony-manager-plan.md is up to date\n",
    );
    return 0;
  }
  if (check) {
    process.stderr.write(
      "docs-sync --check: docs/operations/02-symphony-manager-plan.md usage block is STALE.\nRun: pnpm build && pnpm docs:sync\n",
    );
    return 1;
  }
  writeFileSync(DOC, updated);
  process.stdout.write(
    "docs-sync: updated docs/operations/02-symphony-manager-plan.md\n",
  );
  return 0;
}

// Run only when invoked directly (not when imported by the vitest gate).
const invokedDirectly =
  process.argv[1] !== undefined &&
  realpathSync(process.argv[1]) ===
    realpathSync(fileURLToPath(import.meta.url));
if (invokedDirectly) {
  process.exit(run());
}
