#!/usr/bin/env node
// docs-sync (SYMPH-870): regenerate AUTOGEN blocks in operations docs from their
// generated sources so the docs can never silently drift from the code.
//
// It syncs every registered package CLI usage block from the built binary's
// `--help` output. Add new package bins to HELP_TARGETS with their doc marker.
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

/** Legacy manager-plan markers retained for the direct Vitest sync gate. */
export const AUTOGEN = {
  start:
    "<!-- AUTOGEN:help START — managed by scripts/docs-sync.mjs; edit src/cli/manager-plan.ts renderUsage() -->",
  end: "<!-- AUTOGEN:help END -->",
};

export const CAPABILITY_RETEST_AUTOGEN = {
  start:
    "<!-- AUTOGEN:help START — managed by scripts/docs-sync.mjs; edit src/cli/capability-retest.ts renderUsage() -->",
};

const CLI_REFERENCE_DOC = "docs/operations/06-cli-reference.md";

export const HELP_TARGETS = [
  {
    name: "symphony-manager-plan",
    doc: "docs/operations/02-symphony-manager-plan.md",
    cli: "dist/src/cli/manager-plan.js",
    start: AUTOGEN.start,
    end: AUTOGEN.end,
  },
  {
    name: "symphony-capability-retest",
    doc: "docs/operations/07-symphony-capability-retest.md",
    cli: "dist/src/cli/capability-retest.js",
    start: CAPABILITY_RETEST_AUTOGEN.start,
    end: AUTOGEN.end,
  },
  ...[
    ["symphony", "dist/src/cli/main.js"],
    ["symphony-backlog-audit", "dist/src/audit/backlog-audit-cli.js"],
    ["symphony-calibration-digest", "dist/src/calibration/cli.js"],
    ["claude-runner", "dist/src/cli/claude-runner.js"],
    ["symphony-linear-portfolio", "dist/src/cli/linear-portfolio-write.js"],
    [
      "symphony-investigate-productivity-report",
      "dist/src/cli/investigate-productivity-report.js",
    ],
    ["symphony-spec-review-watch", "dist/src/cli/spec-review-watch.js"],
    ["symphonyctl", "dist/src/cli/symphonyctl.js"],
  ].map(([name, cli]) => ({
    name,
    doc: CLI_REFERENCE_DOC,
    cli,
    start: `<!-- AUTOGEN:help:${name} START — managed by scripts/docs-sync.mjs -->`,
    end: `<!-- AUTOGEN:help:${name} END -->`,
  })),
];

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
function currentHelp(target) {
  return execFileSync(process.execPath, [join(ROOT, target.cli), "--help"], {
    encoding: "utf8",
  });
}

function run() {
  const check = process.argv.includes("--check");
  const documents = new Map();
  for (const target of HELP_TARGETS) {
    const path = join(ROOT, target.doc);
    const original = documents.get(path) ?? readFileSync(path, "utf8");
    documents.set(
      path,
      replaceAutogenRegion(
        original,
        target.start,
        target.end,
        helpBlock(currentHelp(target)),
      ),
    );
  }
  const stale = [];
  for (const [path, updated] of documents) {
    const original = readFileSync(path, "utf8");
    if (updated === original) continue;
    stale.push(path.slice(ROOT.length + 1));
    if (!check) writeFileSync(path, updated);
  }
  if (stale.length === 0) {
    process.stdout.write(
      `docs-sync: ${HELP_TARGETS.length} registered help blocks are up to date\n`,
    );
    return 0;
  }
  if (check) {
    process.stderr.write(
      `docs-sync --check: stale help blocks in ${stale.join(", ")}\nRun: pnpm build && pnpm docs:sync\n`,
    );
    return 1;
  }
  process.stdout.write(`docs-sync: updated ${stale.join(", ")}\n`);
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
