import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";

const require = createRequire(import.meta.url);

/**
 * Regression guard for SYMPH-771.
 *
 * Biome 1.9.x does NOT honor `.gitignore`, so any git-ignored agent worktree
 * or nested generated dependency tree is scanned by `biome check .` unless it
 * is listed explicitly in `files.ignore`. When the stable checkout has a local
 * worktree on disk (e.g. `.worktrees/SYMPH-xyz/`), a lint failure inside that
 * untracked tree makes `pnpm lint` report a source-health problem that does not
 * exist on tracked source — deploy/preflight verification then lies.
 *
 * These globs MUST stay in `biome.json` so the stable-checkout lint only
 * reflects tracked source. Removing one re-opens the failure mode.
 */
const REQUIRED_IGNORE_GLOBS = [
  // Symphony per-issue git worktrees (git-ignored as `.worktrees/`).
  ".worktrees/**",
  // Claude Code agent worktrees (git-ignored as `/.claude/worktrees/`).
  ".claude/worktrees/**",
  // Nested dependency installs anywhere (e.g. ops/token-report-ui/node_modules).
  // Root-anchored `node_modules/**` does not match nested packages.
  "**/node_modules/**",
  // Nested build output anywhere (e.g. the dashboard's ops/token-report-ui/dist).
  "**/dist/**",
];

describe("biome.json ignore (SYMPH-771)", () => {
  const biome = require("../biome.json") as {
    files?: { ignore?: string[] };
  };
  const ignore = biome.files?.ignore ?? [];

  it.each(REQUIRED_IGNORE_GLOBS)(
    "ignores agent worktree / generated tree glob %s",
    (glob) => {
      expect(ignore).toContain(glob);
    },
  );
});
