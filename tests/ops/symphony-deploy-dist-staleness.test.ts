import { spawnSync } from "node:child_process";
import { readFileSync, utimesSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

/**
 * SYMPH-919: `ops/symphony-deploy` gates `pnpm build` on a git SHA delta. When
 * the checkout is already at the target SHA but `dist/` is out of sync with
 * HEAD (an external git advance without a build, a partial/failed build, or a
 * manually-deleted `dist/`), the old logic logged "Already up to date", skipped
 * the rebuild, and restarted the service on stale compiled code. The
 * `dist_is_stale` guard mirrors run-pipeline.sh's src->dist check so the deploy
 * rebuilds in that anomalous same-SHA case instead of silently skipping.
 */
const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.allSettled(
    tempDirs
      .splice(0)
      .map((path) => rm(path, { recursive: true, force: true })),
  );
});

const DEPLOY_PATH = resolve("ops/symphony-deploy");

function deploySource(): string {
  return readFileSync(DEPLOY_PATH, "utf8");
}

function extractShellFunction(source: string, name: string): string {
  const lines = source.split("\n");
  const start = lines.findIndex((line) => line === `${name}() {`);
  expect(start).toBeGreaterThanOrEqual(0);

  const end = lines.findIndex((line, index) => index > start && line === "}");
  expect(end).toBeGreaterThan(start);

  return lines.slice(start, end + 1).join("\n");
}

/** Runs the extracted `dist_is_stale` against `root`; exit 0 = stale, 1 = fresh. */
function runDistIsStale(root: string): ReturnType<typeof spawnSync> {
  const fn = extractShellFunction(deploySource(), "dist_is_stale");
  return spawnSync(
    "bash",
    ["-c", [fn, 'dist_is_stale "$1"'].join("\n"), "bash", root],
    { encoding: "utf8", env: { PATH: "/usr/bin:/bin" } },
  );
}

/**
 * Builds a fake checkout. `distEntry: false` deletes the compiled entrypoint.
 * `srcNewerThanDist` controls whether the lone src file is stamped newer (stale)
 * or older (fresh) than the dist entrypoint, deterministically via utimes.
 */
async function makeCheckout(opts: {
  distEntry: boolean;
  srcNewerThanDist?: boolean;
}): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "symphony-deploy-dist-"));
  tempDirs.push(root);

  await mkdir(join(root, "src", "cli"), { recursive: true });
  const srcFile = join(root, "src", "cli", "main.ts");
  await writeFile(srcFile, "export {};\n");

  const base = 1_700_000_000; // fixed epoch seconds — no wall-clock flakiness
  if (opts.distEntry) {
    await mkdir(join(root, "dist", "src", "cli"), { recursive: true });
    const distEntry = join(root, "dist", "src", "cli", "main.js");
    await writeFile(distEntry, "module.exports = {};\n");
    utimesSync(distEntry, base, base);
    const srcMtime = opts.srcNewerThanDist ? base + 100 : base - 100;
    utimesSync(srcFile, srcMtime, srcMtime);
  }
  return root;
}

describe("symphony-deploy dist_is_stale (SYMPH-919)", () => {
  it("reports stale when the compiled dist entrypoint is missing", async () => {
    const root = await makeCheckout({ distEntry: false });
    expect(runDistIsStale(root).status).toBe(0);
  });

  it("reports stale when a src file is newer than the dist entrypoint", async () => {
    const root = await makeCheckout({
      distEntry: true,
      srcNewerThanDist: true,
    });
    expect(runDistIsStale(root).status).toBe(0);
  });

  it("reports fresh when the dist entrypoint is newer than all src files", async () => {
    const root = await makeCheckout({
      distEntry: true,
      srcNewerThanDist: false,
    });
    expect(runDistIsStale(root).status).toBe(1);
  });

  it("wires dist_is_stale into the build gate: stale same-SHA rebuilds, fresh skips", () => {
    const source = deploySource();

    // The same-SHA branch consults dist_is_stale before deciding to skip.
    const elifIdx = source.indexOf('elif dist_is_stale "$SYMPHONY_ROOT"; then');
    expect(elifIdx).toBeGreaterThan(-1);

    // The stale branch actually rebuilds (and does not silently fall through).
    const skipIdx = source.indexOf("skipping rebuild", elifIdx);
    expect(skipIdx).toBeGreaterThan(elifIdx);
    const staleBranch = source.slice(elifIdx, skipIdx);
    expect(staleBranch).toContain(
      'run_or_dry pnpm run --dir "$SYMPHONY_ROOT" build',
    );

    // The fresh same-SHA case logs an explicit skip — no silent "up to date".
    expect(source).toContain('ok "dist/ current at');
  });
});
