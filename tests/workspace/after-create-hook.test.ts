import { execFile } from "node:child_process";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { parse } from "yaml";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { WorkspaceHookRunner } from "../../src/workspace/hooks.js";

const execFileAsync = promisify(execFile);

const TEMPLATE_PATH = fileURLToPath(
  new URL(
    "../../pipeline-config/templates/WORKFLOW-template.md",
    import.meta.url,
  ),
);

async function loadAfterCreateHook(): Promise<string> {
  const raw = await fs.readFile(TEMPLATE_PATH, "utf8");
  const match = raw.match(/^---\n([\s\S]*?)\n---/);
  if (!match?.[1]) throw new Error("template frontmatter not found");
  const frontmatter = parse(match[1]) as {
    hooks?: { after_create?: string };
  };
  const script = frontmatter.hooks?.after_create;
  if (!script) throw new Error("after_create hook not found in template");
  return script;
}

async function git(args: string[], cwd: string): Promise<string> {
  const { stdout } = await execFileAsync("git", args, { cwd });
  return stdout.trim();
}

/**
 * Exercises the REAL after_create hook from WORKFLOW-template.md through
 * the real WorkspaceHookRunner/executeShellHook path against a local
 * scratch remote — the "test against actual workspace creation flow"
 * contract for hook changes (SYMPH-372).
 */
describe("after_create hook (WORKFLOW-template.md, real execution)", () => {
  let root: string;
  let seedRemote: string;
  let workspaceRoot: string;
  let runner: WorkspaceHookRunner;
  let hookLogs: Array<{ stdout?: string; stderr?: string }>;

  async function runHook(issueKey: string): Promise<string> {
    const workspace = join(workspaceRoot, issueKey);
    await fs.mkdir(workspace, { recursive: true });
    await runner.run({
      name: "afterCreate",
      workspacePath: workspace,
      env: { REPO_URL: seedRemote },
    });
    return workspace;
  }

  beforeEach(async () => {
    root = await fs.mkdtemp(join(tmpdir(), "symph372-hook-"));
    seedRemote = join(root, "seed.git-source");
    workspaceRoot = join(root, "workspaces");
    await fs.mkdir(seedRemote, { recursive: true });
    await fs.mkdir(workspaceRoot, { recursive: true });

    await git(["init", "--quiet", "--initial-branch=main"], seedRemote);
    await fs.writeFile(join(seedRemote, "README.md"), "seed\n");
    await git(["add", "."], seedRemote);
    await git(
      [
        "-c",
        "user.email=t@example.com",
        "-c",
        "user.name=t",
        "commit",
        "--quiet",
        "-m",
        "seed",
      ],
      seedRemote,
    );

    hookLogs = [];
    runner = new WorkspaceHookRunner({
      config: {
        afterCreate: await loadAfterCreateHook(),
        beforeRun: null,
        afterRun: null,
        beforeRemove: null,
        timeoutMs: 60_000,
      },
      log: (entry) => hookLogs.push(entry),
      outputLimit: 100_000,
    });
  });

  afterEach(async () => {
    await fs.rm(root, { force: true, recursive: true });
  });

  it("creates a worktree based on the remote main tip", async () => {
    const workspace = await runHook("issue-aaaa");

    const workspaceHead = await git(["rev-parse", "HEAD"], workspace);
    const seedHead = await git(["rev-parse", "main"], seedRemote);
    expect(workspaceHead).toBe(seedHead);
    expect(await git(["rev-parse", "--abbrev-ref", "HEAD"], workspace)).toBe(
      "worktree/issue-aaaa",
    );
  });

  it("self-heals a poisoned refs/heads/origin/* ref and still bases on the true remote tip", async () => {
    // First run materializes the shared bare clone.
    await runHook("issue-bbbb");
    const bare = join(workspaceRoot, ".bare-clones", "seed.git-source");

    // Reproduce the incident: a stray local branch literally named
    // "origin/main", pointing at a STALE commit.
    const staleSha = await git(["rev-parse", "main"], seedRemote);
    await fs.writeFile(join(seedRemote, "newer.md"), "advance main\n");
    await git(["add", "."], seedRemote);
    await git(
      [
        "-c",
        "user.email=t@example.com",
        "-c",
        "user.name=t",
        "commit",
        "--quiet",
        "-m",
        "advance",
      ],
      seedRemote,
    );
    await git(["update-ref", "refs/heads/origin/main", staleSha], bare);
    // Nested poisoned refs must heal too — the for-each-ref prefix form
    // ("refs/heads/origin/") matches across path segments, unlike a "*"
    // glob, which stops at "/".
    await git(["update-ref", "refs/heads/origin/feature/xyz", staleSha], bare);

    // Second workspace must succeed (the incident made this fatal), the
    // poisoned refs must be gone, and HEAD must be the CURRENT remote tip,
    // not the stale commit the ambiguous short name used to resolve to.
    const workspace = await runHook("issue-cccc");

    await expect(
      git(["show-ref", "--verify", "refs/heads/origin/main"], bare),
    ).rejects.toThrow();
    await expect(
      git(["show-ref", "--verify", "refs/heads/origin/feature/xyz"], bare),
    ).rejects.toThrow();
    const newSeedHead = await git(["rev-parse", "main"], seedRemote);
    expect(await git(["rev-parse", "HEAD"], workspace)).toBe(newSeedHead);
    expect(newSeedHead).not.toBe(staleSha);

    const stderr = hookLogs.map((l) => l.stderr ?? "").join("\n");
    expect(stderr).toContain("removed poisoned local ref");
  });

  it("skips (and warns about) a poisoned ref that a live worktree has checked out", async () => {
    await runHook("issue-gggg");
    const bare = join(workspaceRoot, ".bare-clones", "seed.git-source");

    // The incident vector itself: an agent worktree sitting ON a branch
    // literally named origin/main. Deleting that ref would orphan the
    // worktree's next commit, so the self-heal must skip it loudly.
    const rogue = join(root, "rogue-worktree");
    await git(["worktree", "add", rogue, "-b", "origin/main", "main"], bare);

    const workspace = await runHook("issue-hhhh");

    // Hook succeeded, the checked-out poisoned ref survived, and the new
    // workspace is still based on the true remote tip (full refnames make
    // the hook immune to the remaining ambiguity).
    expect(
      await git(["show-ref", "--verify", "refs/heads/origin/main"], bare),
    ).toBeTruthy();
    const seedHead = await git(["rev-parse", "main"], seedRemote);
    expect(await git(["rev-parse", "HEAD"], workspace)).toBe(seedHead);

    const stderr = hookLogs.map((l) => l.stderr ?? "").join("\n");
    expect(stderr).toContain("checked out in a live worktree");
  });

  it("prunes remote-tracking refs for branches deleted on the remote", async () => {
    await git(["branch", "junk-branch"], seedRemote);
    await runHook("issue-dddd");
    const bare = join(workspaceRoot, ".bare-clones", "seed.git-source");
    expect(
      await git(
        ["show-ref", "--verify", "refs/remotes/origin/junk-branch"],
        bare,
      ),
    ).toBeTruthy();

    await git(["branch", "-D", "junk-branch"], seedRemote);
    await runHook("issue-eeee");

    await expect(
      git(["show-ref", "--verify", "refs/remotes/origin/junk-branch"], bare),
    ).rejects.toThrow();
  });

  it("is idempotent for a retried issue (stale branch cleanup path)", async () => {
    const workspace = await runHook("issue-ffff");
    // Simulate a failed attempt's leftovers: workspace removed, branch kept.
    await fs.rm(workspace, { force: true, recursive: true });

    const retried = await runHook("issue-ffff");
    expect(await git(["rev-parse", "--abbrev-ref", "HEAD"], retried)).toBe(
      "worktree/issue-ffff",
    );
  });
});
