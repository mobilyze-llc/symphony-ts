#!/usr/bin/env node
/**
 * Symphony skill source-of-truth gate.
 *
 * Canonical source: repo-local skills/<name>/SKILL.md.
 * Repo discovery: .agents/skills/<name> must be a symlink to the repo
 * canonical directory.
 * Cross-repo discovery: user-level ~/.agents/skills/<name> should be a symlink
 * to the stable checkout source directory. Pass --user-installs to require
 * these machine-scoped installs; without it, missing user-level installs are
 * reported as warnings so CI and clean machines remain portable.
 * Global copies: ~/.codex/skills/<name> is intentionally empty; any active copy
 * there is treated as drift. This check is machine-scoped and only catches
 * forbidden global copies on the machine where it runs.
 */

import { execFileSync } from "node:child_process";
import { lstatSync, readFileSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { resolve } from "node:path";
import process from "node:process";

const args = new Set(process.argv.slice(2));
const requireUserInstalls = args.delete("--user-installs");

if (args.size > 0) {
  console.error(`Unknown argument(s): ${Array.from(args).join(", ")}`);
  process.exit(2);
}

const repoRoot = resolve(
  process.env.SYMPHONY_SKILL_REPO_ROOT ?? resolve(import.meta.dirname, ".."),
);
const stableRoot = resolve(
  process.env.SYMPHONY_STABLE_ROOT ?? discoverStableRoot(repoRoot),
);
const repoDiscoveryRoot = resolve(repoRoot, ".agents/skills");
const userSkillsRoot = resolve(
  process.env.SYMPHONY_USER_SKILLS_DIR ?? resolve(homedir(), ".agents/skills"),
);
const codexSkillsRoot = resolve(
  process.env.SYMPHONY_CODEX_SKILLS_DIR ?? resolve(homedir(), ".codex/skills"),
);

const skillNames = [
  "session-orchestrator",
  "spec-review-lane",
  "claude-runner",
];
const staleSkillNames = ["symphony-claude-runner"];
const failures = [];
const warnings = [];

for (const skillName of skillNames) {
  const canonicalDir = resolve(repoRoot, "skills", skillName);
  const canonicalSkill = resolve(canonicalDir, "SKILL.md");
  const repoDiscoveryDir = resolve(repoDiscoveryRoot, skillName);
  const userInstallDir = resolve(userSkillsRoot, skillName);
  const stableCanonicalDir = resolve(stableRoot, "skills", skillName);
  const forbiddenCodexSkill = resolve(codexSkillsRoot, skillName, "SKILL.md");

  assertReadableFile(canonicalSkill, failures);
  assertSymlinkTarget(repoDiscoveryDir, canonicalDir, failures);

  const userInstallFailure = symlinkTargetFailure(
    userInstallDir,
    stableCanonicalDir,
  );
  if (userInstallFailure) {
    const message = `${userInstallDir} should be a user-level symlink to ${stableCanonicalDir}: ${userInstallFailure}`;
    if (requireUserInstalls) {
      failures.push(message);
    } else {
      warnings.push(message);
    }
  }

  assertMissingFile(
    forbiddenCodexSkill,
    `${forbiddenCodexSkill} exists as an active global copy. Remove or archive the global copy so the repo-local ${skillName} source and user-level symlink are the single discovered source of truth.`,
    failures,
  );
}

for (const staleSkillName of staleSkillNames) {
  for (const stalePath of [
    resolve(repoRoot, "skills", staleSkillName),
    resolve(repoDiscoveryRoot, staleSkillName),
    resolve(userSkillsRoot, staleSkillName),
    resolve(codexSkillsRoot, staleSkillName),
  ]) {
    if (pathExistsEvenIfDanglingSymlink(stalePath)) {
      failures.push(
        `${stalePath} exists, but ${staleSkillName} is a stale skill name. Use claude-runner instead.`,
      );
    }
  }
}

if (failures.length > 0) {
  console.error(
    JSON.stringify(
      {
        ok: false,
        repoRoot,
        stableRoot,
        repoDiscoveryRoot,
        userSkillsRoot,
        codexSkillsRoot,
        requireUserInstalls,
        warnings,
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
      repoRoot,
      stableRoot,
      repoDiscoveryRoot,
      userSkillsRoot,
      codexSkillsRoot,
      requireUserInstalls,
      warnings,
    },
    null,
    2,
  ),
);

function assertReadableFile(path, targetFailures) {
  try {
    readFileSync(path, "utf8");
  } catch (error) {
    targetFailures.push(`${path} is missing or unreadable: ${message(error)}`);
  }
}

function assertMissingFile(path, failureMessage, targetFailures) {
  try {
    readFileSync(path, "utf8");
    targetFailures.push(failureMessage);
  } catch (error) {
    if (!isNodeErrorCode(error, "ENOENT")) {
      targetFailures.push(`${path} is unreadable: ${message(error)}`);
    }
  }
}

function assertSymlinkTarget(linkPath, targetPath, targetFailures) {
  const failure = symlinkTargetFailure(linkPath, targetPath);
  if (failure) {
    targetFailures.push(
      `${linkPath} must be a symlink to ${targetPath}: ${failure}`,
    );
  }
}

function symlinkTargetFailure(linkPath, targetPath) {
  try {
    const linkStat = lstatSync(linkPath);
    if (!linkStat.isSymbolicLink()) {
      return "not a symlink";
    }

    const actual = realpathSync(linkPath);
    const expected = realpathSync(targetPath);
    if (actual !== expected) {
      return `resolves to ${actual}, not ${expected}`;
    }

    return null;
  } catch (error) {
    return `missing or unreadable: ${message(error)}`;
  }
}

function pathExistsEvenIfDanglingSymlink(path) {
  try {
    lstatSync(path);
    return true;
  } catch (error) {
    if (isNodeErrorCode(error, "ENOENT")) {
      return false;
    }
    return true;
  }
}

function discoverStableRoot(fallbackRoot) {
  try {
    const output = execFileSync("git", ["worktree", "list", "--porcelain"], {
      cwd: fallbackRoot,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
    const entries = parseWorktreeList(output);
    const stableEntry =
      entries.find((entry) => entry.branch === "refs/heads/main") ??
      entries.find((entry) => entry.branch === "refs/heads/master");
    return stableEntry?.worktree ?? fallbackRoot;
  } catch {
    return fallbackRoot;
  }
}

function parseWorktreeList(output) {
  const entries = [];
  let current = null;
  for (const line of output.split("\n")) {
    if (line.startsWith("worktree ")) {
      current = { worktree: line.slice("worktree ".length).trim() };
      entries.push(current);
    } else if (current && line.startsWith("branch ")) {
      current.branch = line.slice("branch ".length).trim();
    }
  }
  return entries;
}

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
