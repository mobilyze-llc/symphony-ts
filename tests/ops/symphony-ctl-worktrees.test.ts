import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { afterEach, expect, it } from "vitest";

const tempDirs: string[] = [];
const ctl = resolve("ops/symphony-ctl");

afterEach(async () => {
  await Promise.allSettled(
    tempDirs
      .splice(0)
      .map((path) => rm(path, { recursive: true, force: true })),
  );
});

it("lists safe stale project-local worktrees in dry-run without removing them", async () => {
  const fixture = await createFixture("SYMPH-990-dry-run");

  const result = runCtl(fixture.stable, [
    "prune-worktrees",
    "--dry-run",
    "--older-than",
    "0",
  ]);

  expect(result.status).toBe(0);
  expect(result.stdout).toContain("symphony-ctl prune-worktrees [DRY RUN]");
  expect(result.stdout).toContain("would remove");
  expect(result.stdout).toContain(fixture.worktree);
  expect(result.stdout).toContain("branch=codex/SYMPH-990-dry-run");
  expect(result.stdout).toContain("upstream=gone");
  expect(result.stdout).toContain("context=linear:SYMPH-990");
  expect(await pathExists(fixture.worktree)).toBe(true);
  expect(
    git(["branch", "--list", fixture.branch], fixture.stable).stdout,
  ).toContain(fixture.branch);
});

it("removes a safe stale project-local worktree and then prunes the unpinned branch", async () => {
  const fixture = await createFixture("SYMPH-991-execute");

  const result = runCtl(fixture.stable, [
    "prune-worktrees",
    "--execute",
    "--older-than",
    "0",
  ]);

  expect(result.status).toBe(0);
  expect(result.stdout).toContain("symphony-ctl prune-worktrees [EXECUTING]");
  expect(result.stdout).toContain("removed branch=codex/SYMPH-991-execute");
  expect(result.stdout).toContain(
    "Running branch pruning after worktree removal",
  );
  expect(await pathExists(fixture.worktree)).toBe(false);
  expect(git(["branch", "--list", fixture.branch], fixture.stable).stdout).toBe(
    "",
  );
});

it("detects issue-key context case-insensitively", async () => {
  const fixture = await createFixture("symph-994-lowercase");

  const result = runCtl(fixture.stable, [
    "prune-worktrees",
    "--dry-run",
    "--older-than",
    "0",
  ]);

  expect(result.status).toBe(0);
  expect(result.stdout).toContain("would remove");
  expect(result.stdout).toContain("context=linear:SYMPH-994");
  expect(await pathExists(fixture.worktree)).toBe(true);
});

it("refuses a dirty stale project-local worktree", async () => {
  const fixture = await createFixture("SYMPH-992-dirty");
  await writeFile(join(fixture.worktree, "scratch.txt"), "do not delete\n");

  const result = runCtl(fixture.stable, [
    "prune-worktrees",
    "--execute",
    "--older-than",
    "0",
  ]);

  expect(result.status).toBe(0);
  expect(result.stderr).toContain(
    "SKIPPED (dirty: tracked or untracked changes)",
  );
  expect(await pathExists(fixture.worktree)).toBe(true);
  expect(
    git(["branch", "--list", fixture.branch], fixture.stable).stdout,
  ).toContain(fixture.branch);
});

it("ignores registered worktrees outside the stable project-local cleanup roots", async () => {
  const fixture = await createFixture("SYMPH-993-outside", {
    worktreeParent: "external-worktrees",
  });

  const result = runCtl(fixture.stable, [
    "prune-worktrees",
    "--execute",
    "--older-than",
    "0",
  ]);

  expect(result.status).toBe(0);
  expect(result.stdout).not.toContain(fixture.worktree);
  expect(await pathExists(fixture.worktree)).toBe(true);
  expect(
    git(["branch", "--list", fixture.branch], fixture.stable).stdout,
  ).toContain(fixture.branch);
});

it("refuses worktrees whose upstream branch is still present", async () => {
  const fixture = await createFixture("SYMPH-995-upstream", {
    deleteRemoteBranch: false,
  });

  const result = runCtl(fixture.stable, [
    "prune-worktrees",
    "--execute",
    "--older-than",
    "0",
  ]);

  expect(result.status).toBe(0);
  expect(result.stderr).toContain("SKIPPED (upstream: present:origin/");
  expect(await pathExists(fixture.worktree)).toBe(true);
});

it("refuses recent worktrees newer than the configured age threshold", async () => {
  const fixture = await createFixture("SYMPH-996-recent");

  const result = runCtl(fixture.stable, [
    "prune-worktrees",
    "--execute",
    "--older-than",
    "99999",
  ]);

  expect(result.status).toBe(0);
  expect(result.stderr).toContain("SKIPPED (recent:");
  expect(await pathExists(fixture.worktree)).toBe(true);
});

it("refuses worktrees without a recognized Linear issue key or matching handoff", async () => {
  const fixture = await createFixture("TODO-997-no-context");

  const result = runCtl(fixture.stable, [
    "prune-worktrees",
    "--execute",
    "--older-than",
    "0",
  ]);

  expect(result.status).toBe(0);
  expect(result.stderr).toContain(
    "SKIPPED (context: no issue key or stable-root handoff evidence)",
  );
  expect(await pathExists(fixture.worktree)).toBe(true);
});

it("accepts matching stable-root handoff context without substring collisions", async () => {
  const fixture = await createFixture("handoff-context");
  await mkdir(join(fixture.stable, "handoffs"), { recursive: true });
  await writeFile(
    join(fixture.stable, "handoffs", "2026-06-22-handoff-context-handoff.md"),
    "handoff\n",
  );
  await writeFile(
    join(fixture.stable, "handoffs", "2026-06-22-handoffcontextual-extra.md"),
    "should not match\n",
  );

  const result = runCtl(fixture.stable, [
    "prune-worktrees",
    "--dry-run",
    "--older-than",
    "0",
  ]);

  expect(result.status).toBe(0);
  expect(result.stdout).toContain("would remove");
  expect(result.stdout).toContain(
    "context=handoff:2026-06-22-handoff-context-handoff.md",
  );
  expect(await pathExists(fixture.worktree)).toBe(true);
});

it("does not treat ancestor path issue keys as durable worktree context", async () => {
  const fixture = await createFixture("no-context-child", {
    worktreeParent: ".worktrees/SYMPH-123-parent",
  });

  const result = runCtl(fixture.stable, [
    "prune-worktrees",
    "--execute",
    "--older-than",
    "0",
  ]);

  expect(result.status).toBe(0);
  expect(result.stderr).toContain(
    "SKIPPED (context: no issue key or stable-root handoff evidence)",
  );
  expect(await pathExists(fixture.worktree)).toBe(true);
});

it("includes stale .claude/worktrees entries in the cleanup scope", async () => {
  const fixture = await createFixture("SYMPH-998-claude-scope", {
    worktreeParent: ".claude/worktrees",
  });

  const result = runCtl(fixture.stable, [
    "prune-worktrees",
    "--dry-run",
    "--older-than",
    "0",
  ]);

  expect(result.status).toBe(0);
  expect(result.stdout).toContain("would remove");
  expect(result.stdout).toContain(fixture.worktree);
  expect(result.stdout).toContain("context=linear:SYMPH-998");
  expect(await pathExists(fixture.worktree)).toBe(true);
});

it("protects the runtime checkout even when it otherwise looks prunable", async () => {
  const fixture = await createFixture("SYMPH-999-protected");

  const result = runCtl(
    fixture.stable,
    ["prune-worktrees", "--execute", "--older-than", "0"],
    { SYMPHONY_RUNTIME_CHECKOUT: fixture.worktree },
  );

  expect(result.status).toBe(0);
  expect(result.stderr).toContain(
    "SKIPPED (protected: current or runtime checkout)",
  );
  expect(await pathExists(fixture.worktree)).toBe(true);
});

it("warns about stale git worktree registrations in dry-run", async () => {
  const fixture = await createFixture("SYMPH-1000-stale-registration");
  await rm(fixture.worktree, { recursive: true, force: true });

  const result = runCtl(fixture.stable, ["prune-worktrees", "--dry-run"]);

  expect(result.status).toBe(0);
  expect(result.stderr).toContain("Stale git worktree registrations detected");
  expect(result.stderr).toContain("worktrees/SYMPH-1000-stale-registration");
});

it("refuses detached worktrees", async () => {
  const fixture = await createFixture("SYMPH-1001-detached", {
    detached: true,
  });

  const result = runCtl(fixture.stable, [
    "prune-worktrees",
    "--execute",
    "--older-than",
    "0",
  ]);

  expect(result.status).toBe(0);
  expect(result.stderr).toContain("SKIPPED (detached: not branch-backed)");
  expect(await pathExists(fixture.worktree)).toBe(true);
});

it("rejects invalid age threshold arguments", async () => {
  const fixture = await createFixture("SYMPH-1002-invalid-older-than");

  const result = runCtl(fixture.stable, [
    "prune-worktrees",
    "--older-than",
    "not-days",
  ]);

  expect(result.status).toBe(1);
  expect(result.stderr).toContain("--older-than requires a day count");
});

async function createFixture(
  slug: string,
  options: {
    deleteRemoteBranch?: boolean;
    detached?: boolean;
    worktreeParent?: string;
  } = {},
): Promise<{
  root: string;
  origin: string;
  stable: string;
  branch: string;
  worktree: string;
}> {
  const root = await createTempDir("symphony-ctl-worktrees-");
  const origin = join(root, "origin.git");
  const stable = join(root, "stable");
  const branch = `codex/${slug}`;
  const worktreeRoot = join(stable, options.worktreeParent ?? ".worktrees");
  const worktree = join(worktreeRoot, slug);

  git(["init", "--bare", origin], root);
  git(["clone", origin, stable], root);
  git(["config", "user.email", "test@example.com"], stable);
  git(["config", "user.name", "Test User"], stable);
  await writeFile(join(stable, "README.md"), "test\n");
  git(["add", "README.md"], stable);
  git(["commit", "-m", "Initial commit"], stable);
  git(["branch", "-M", "main"], stable);
  git(["push", "-u", "origin", "main"], stable);

  git(["checkout", "-b", branch], stable);
  git(["push", "-u", "origin", branch], stable);
  git(["checkout", "main"], stable);

  await mkdir(worktreeRoot, { recursive: true });
  if (options.detached) {
    git(["worktree", "add", "--detach", worktree, branch], stable);
  } else {
    git(["worktree", "add", worktree, branch], stable);
  }
  if (options.deleteRemoteBranch !== false) {
    git(["push", "origin", `:${branch}`], stable);
  }
  git(["fetch", "--prune"], stable);

  return { root, origin, stable, branch, worktree };
}

async function createTempDir(prefix: string): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), prefix));
  tempDirs.push(path);
  return path;
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== "ENOENT";
  }
}

function runCtl(
  root: string,
  args: string[],
  env: Record<string, string> = {},
): ReturnType<typeof spawnSync> {
  return spawnSync("bash", [ctl, ...args], {
    encoding: "utf8",
    env: {
      ...process.env,
      PATH: process.env.PATH ?? "/usr/bin:/bin",
      SYMPHONY_ROOT: root,
      ...env,
    },
  });
}

function git(args: string[], cwd: string): ReturnType<typeof spawnSync> {
  const result = spawnSync("git", args, { cwd, encoding: "utf8" });
  expect(result.status, `${cwd}: git ${args.join(" ")}\n${result.stderr}`).toBe(
    0,
  );
  return result;
}
