import { spawnSync } from "node:child_process";
import { readFileSync, utimesSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

/**
 * SYMPH-919 / SYMPH-921: `ops/symphony-deploy` gates `pnpm build` on a git SHA
 * delta. When the checkout is already at the target SHA but `dist/` is out of
 * sync with HEAD (an external git advance without a build, a partial/failed
 * build, or a deleted `dist/`), the old logic restarted the service on stale
 * compiled code. SYMPH-919 added the `dist_is_stale` guard; SYMPH-921 hardens
 * it with a deploy-owned build-stamp (deterministic, mtime-independent), a
 * fail-safe when `find` is unavailable, and a pure `build_decision` so the gate
 * is behaviorally testable instead of asserted by source string.
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
const SAFE_PATH = "/usr/bin:/bin";

function deploySource(): string {
  return readFileSync(DEPLOY_PATH, "utf8");
}

function extractShellFunction(source: string, name: string): string {
  const lines = source.split("\n");
  const start = lines.findIndex((line) => line === `${name}() {`);
  expect(start, `function ${name}() not found`).toBeGreaterThanOrEqual(0);

  const end = lines.findIndex((line, index) => index > start && line === "}");
  expect(end).toBeGreaterThan(start);

  return lines.slice(start, end + 1).join("\n");
}

function extractShellFunctions(source: string, names: string[]): string {
  return names.map((name) => extractShellFunction(source, name)).join("\n");
}

/** Runs `dist_is_stale ROOT`; exit 0 = stale, 1 = fresh. `path` overrides PATH. */
function runDistIsStale(
  root: string,
  path = SAFE_PATH,
): ReturnType<typeof spawnSync> {
  const fn = extractShellFunction(deploySource(), "dist_is_stale");
  return spawnSync(
    "/bin/bash",
    ["-c", [fn, 'dist_is_stale "$1"'].join("\n"), "bash", root],
    { encoding: "utf8", env: { PATH: path } },
  );
}

/** Runs `build_decision ROOT SHA_CHANGED`; stdout is the decision token. */
function runBuildDecision(root: string, shaChanged: "true" | "false"): string {
  const fns = extractShellFunctions(deploySource(), [
    "dist_is_stale",
    "build_decision",
  ]);
  const result = spawnSync(
    "/bin/bash",
    [
      "-c",
      [fns, 'build_decision "$1" "$2"'].join("\n"),
      "bash",
      root,
      shaChanged,
    ],
    { encoding: "utf8", env: { PATH: SAFE_PATH } },
  );
  expect(result.status, result.stderr).toBe(0);
  return result.stdout.trim();
}

function git(cwd: string, args: string[]): void {
  const result = spawnSync("git", args, {
    cwd,
    encoding: "utf8",
    env: { PATH: SAFE_PATH, HOME: cwd },
  });
  if (result.status !== 0) {
    throw new Error(`git ${args.join(" ")} failed: ${result.stderr}`);
  }
}

function gitHead(cwd: string): string {
  const result = spawnSync("git", ["rev-parse", "HEAD"], {
    cwd,
    encoding: "utf8",
    env: { PATH: SAFE_PATH, HOME: cwd },
  });
  return result.stdout.trim();
}

const BASE = 1_700_000_000; // fixed epoch seconds — no wall-clock flakiness

/**
 * Non-git checkout. `distEntry: false` omits the compiled entrypoint;
 * `srcNewerThanDist` stamps the lone src file newer (stale) or older (fresh)
 * than the entrypoint. Outside a git repo the build-stamp check is skipped, so
 * these exercise the entrypoint + mtime paths.
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

  if (opts.distEntry) {
    await mkdir(join(root, "dist", "src", "cli"), { recursive: true });
    const distEntry = join(root, "dist", "src", "cli", "main.js");
    await writeFile(distEntry, "module.exports = {};\n");
    utimesSync(distEntry, BASE, BASE);
    const srcMtime = opts.srcNewerThanDist ? BASE + 100 : BASE - 100;
    utimesSync(srcFile, srcMtime, srcMtime);
  }
  return root;
}

/**
 * Git checkout with a compiled entrypoint that is mtime-fresh (newer than src),
 * so the build-stamp is the deciding signal. `stamp` writes a matching HEAD
 * stamp, a mismatched stamp, or none.
 */
async function makeGitCheckout(
  stamp: "match" | "mismatch" | "none",
): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "symphony-deploy-git-"));
  tempDirs.push(root);

  await mkdir(join(root, "src", "cli"), { recursive: true });
  const srcFile = join(root, "src", "cli", "main.ts");
  await writeFile(srcFile, "export {};\n");

  git(root, ["init", "-q", "-b", "main"]);
  git(root, ["config", "user.email", "agent@example.com"]);
  git(root, ["config", "user.name", "Agent"]);
  git(root, ["add", "-A"]);
  git(root, ["commit", "-qm", "init"]);

  await mkdir(join(root, "dist", "src", "cli"), { recursive: true });
  const distEntry = join(root, "dist", "src", "cli", "main.js");
  await writeFile(distEntry, "module.exports = {};\n");

  if (stamp !== "none") {
    const value = stamp === "match" ? gitHead(root) : "0".repeat(40);
    await writeFile(join(root, "dist", ".build-sha"), `${value}\n`);
  }

  // Entrypoint (and stamp) newer than src so the mtime check reports fresh and
  // the build-stamp decides.
  utimesSync(srcFile, BASE - 100, BASE - 100);
  utimesSync(distEntry, BASE, BASE);
  return root;
}

describe("symphony-deploy dist_is_stale (SYMPH-919/921)", () => {
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

  it("reports fresh when the dist entrypoint is newer than all src (no git)", async () => {
    const root = await makeCheckout({
      distEntry: true,
      srcNewerThanDist: false,
    });
    expect(runDistIsStale(root).status).toBe(1);
  });

  it("reports stale in a git checkout with no build-stamp (SYMPH-921)", async () => {
    const root = await makeGitCheckout("none");
    expect(runDistIsStale(root).status).toBe(0);
  });

  it("reports stale when the build-stamp does not match HEAD — external SHA advance (SYMPH-921)", async () => {
    const root = await makeGitCheckout("mismatch");
    expect(runDistIsStale(root).status).toBe(0);
  });

  it("reports fresh when the build-stamp matches HEAD and dist is mtime-fresh (SYMPH-921)", async () => {
    const root = await makeGitCheckout("match");
    expect(runDistIsStale(root).status).toBe(1);
  });

  it("fails safe to stale when `find` is unavailable on PATH (SYMPH-921)", async () => {
    // Fresh, non-git dist that would otherwise read fresh; with no `find` the
    // guard must not silently skip — it returns stale rather than risk serving
    // stale compiled code.
    const root = await makeCheckout({
      distEntry: true,
      srcNewerThanDist: false,
    });
    expect(runDistIsStale(root, "").status).toBe(0);
  });
});

describe("symphony-deploy build_decision gate (SYMPH-921)", () => {
  it("decides code-changed when the SHA moved, regardless of dist freshness", async () => {
    const fresh = await makeCheckout({
      distEntry: true,
      srcNewerThanDist: false,
    });
    expect(runBuildDecision(fresh, "true")).toBe("code-changed");

    // A SHA move short-circuits before dist_is_stale, so a stale dist still
    // decides "code-changed" — exercise that path too, not just the fresh one.
    const stale = await makeCheckout({
      distEntry: true,
      srcNewerThanDist: true,
    });
    expect(runBuildDecision(stale, "true")).toBe("code-changed");
  });

  it("decides stale-dist when the SHA is unchanged but dist is stale", async () => {
    const stale = await makeCheckout({
      distEntry: true,
      srcNewerThanDist: true,
    });
    expect(runBuildDecision(stale, "false")).toBe("stale-dist");
  });

  it("decides current when the SHA is unchanged and dist is fresh", async () => {
    const fresh = await makeCheckout({
      distEntry: true,
      srcNewerThanDist: false,
    });
    expect(runBuildDecision(fresh, "false")).toBe("current");
  });
});

describe("symphony-deploy build gate wiring (SYMPH-921)", () => {
  it("drives the gate off build_decision and stamps dist after each build", () => {
    const source = deploySource();

    // The gate dispatches on the pure decision function, not an inline if-chain.
    expect(source).toContain(
      'case "$(build_decision "$SYMPHONY_ROOT" "$SYMPH_SHA_CHANGED")" in',
    );

    // Both build arms refresh the build-stamp immediately after building, so a
    // later same-SHA deploy can trust dist/.build-sha.
    const buildStampPair =
      'run_or_dry pnpm run --dir "$SYMPHONY_ROOT" build\n      run_or_dry write_build_stamp "$SYMPHONY_ROOT"';
    expect(source.split(buildStampPair).length - 1).toBe(2);

    // The fresh same-SHA case still logs an explicit skip (no silent "up to date").
    expect(source).toContain('ok "dist/ current at');
  });
});
