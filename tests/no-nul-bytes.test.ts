import { readFileSync, readdirSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

/**
 * Regression guard for SYMPH-920.
 *
 * A literal NUL (`\0`) byte in a tracked TypeScript source makes the file
 * "binary" to grep/ripgrep/biome-adjacent line tooling: they silently match
 * nothing and print no error, so code search and dist-vs-src verification
 * quietly miss the file. `src/agent/triage-planner.ts` once used a `\0`
 * delimiter in a dependency-edge dedup Set key and produced exactly that
 * failure during the SYMPH-918 deploy (code search and a `dist` staleness
 * check both returned false negatives).
 *
 * No tracked source under `src/` may contain a NUL byte. Build composite keys
 * with a printable separator (`JSON.stringify([...])`, or `\x1f`) instead.
 */
const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SRC_ROOT = join(REPO_ROOT, "src");

function collectTsFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...collectTsFiles(full));
    } else if (entry.isFile() && full.endsWith(".ts")) {
      out.push(full);
    }
  }
  return out;
}

describe("no NUL bytes in src (SYMPH-920)", () => {
  it("no tracked src/**/*.ts file contains a NUL byte", () => {
    const files = collectTsFiles(SRC_ROOT);
    // Sanity: the walk actually found sources, so an empty offender list means
    // "scanned and clean", not "scanned nothing".
    expect(files.length).toBeGreaterThan(0);

    const offenders = files
      .filter((file) => readFileSync(file).includes(0))
      .map((file) => relative(REPO_ROOT, file));
    expect(offenders).toEqual([]);
  });
});
