#!/usr/bin/env node
/**
 * Session-orchestrator skill source-of-truth gate.
 *
 * Canonical source: repo-local skills/session-orchestrator/SKILL.md.
 * Codex discovery: .agents/skills/session-orchestrator must be a symlink to
 * the repo canonical directory.
 * Global copies: ~/.codex/skills/session-orchestrator is intentionally empty;
 * any active copy there is treated as drift. This check is machine-scoped and
 * only catches forbidden global copies on the machine where it runs.
 */

import { lstatSync, readFileSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { resolve } from "node:path";
import process from "node:process";

const repoRoot = resolve(import.meta.dirname, "..");
const canonicalDir = resolve(repoRoot, "skills/session-orchestrator");
const canonicalSkill = resolve(canonicalDir, "SKILL.md");
const discoveryDir = resolve(repoRoot, ".agents/skills/session-orchestrator");
const globalSkill = resolve(
  homedir(),
  ".codex/skills/session-orchestrator/SKILL.md",
);

const failures = [];

try {
  const discoveryStat = lstatSync(discoveryDir);
  if (!discoveryStat.isSymbolicLink()) {
    failures.push(`${discoveryDir} must be a symlink to ${canonicalDir}`);
  } else if (realpathSync(discoveryDir) !== realpathSync(canonicalDir)) {
    failures.push(
      `${discoveryDir} resolves to ${realpathSync(discoveryDir)}, not ${realpathSync(canonicalDir)}`,
    );
  }
} catch (error) {
  failures.push(`${discoveryDir} is missing or unreadable: ${message(error)}`);
}

let canonicalContent = "";
try {
  canonicalContent = readFileSync(canonicalSkill, "utf8");
} catch (error) {
  failures.push(
    `${canonicalSkill} is missing or unreadable: ${message(error)}`,
  );
}

try {
  readFileSync(globalSkill, "utf8");
  failures.push(
    `${globalSkill} exists as an active global copy. Remove or archive the global copy so the repo-local session-orchestrator is the single discovered source of truth.`,
  );
} catch (error) {
  if (!isNodeErrorCode(error, "ENOENT")) {
    failures.push(`${globalSkill} is unreadable: ${message(error)}`);
  }
}

if (failures.length > 0) {
  console.error(
    JSON.stringify(
      {
        ok: false,
        canonicalSkill,
        discoveryDir,
        globalSkill,
        failures,
      },
      null,
      2,
    ),
  );
  process.exit(1);
}

console.log(
  JSON.stringify(
    {
      ok: true,
      canonicalSkill,
      discoveryDir,
      globalSkill,
    },
    null,
    2,
  ),
);

function message(error) {
  return error instanceof Error ? error.message : String(error);
}

function isNodeErrorCode(error, code) {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === code
  );
}
