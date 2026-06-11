import { execFile } from "node:child_process";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { ERROR_CODES } from "../../src/errors/codes.js";
import {
  type GitProbe,
  gitIsolationEnv,
  scrubGitPointerEnv,
  verifyWorkspaceGitIsolation,
} from "../../src/workspace/git-isolation.js";
import { WorkspacePathError } from "../../src/workspace/path-safety.js";

const execFileAsync = promisify(execFile);

async function git(args: string[], cwd: string): Promise<void> {
  await execFileAsync("git", args, { cwd });
}

describe("gitIsolationEnv", () => {
  it("sets the ceiling to the workspace parent", () => {
    const env = gitIsolationEnv("/some/root/workspace-a", {});
    expect(env.GIT_CEILING_DIRECTORIES).toBe(resolve("/some/root"));
  });

  it("appends to an existing ceiling list", () => {
    const env = gitIsolationEnv("/some/root/workspace-a", {
      GIT_CEILING_DIRECTORIES: "/operator/ceiling",
    });
    expect(env.GIT_CEILING_DIRECTORIES).toBe(
      `/operator/ceiling:${resolve("/some/root")}`,
    );
  });
});

describe("scrubGitPointerEnv", () => {
  it("removes GIT_DIR and GIT_WORK_TREE, preserving everything else", () => {
    const env = scrubGitPointerEnv({
      GIT_DIR: "/operator/repo/.git",
      GIT_WORK_TREE: "/operator/repo",
      GIT_CEILING_DIRECTORIES: "/kept",
      PATH: "/usr/bin",
    });
    expect(env.GIT_DIR).toBeUndefined();
    expect(env.GIT_WORK_TREE).toBeUndefined();
    expect(env.GIT_CEILING_DIRECTORIES).toBe("/kept");
    expect(env.PATH).toBe("/usr/bin");
  });
});

describe("verifyWorkspaceGitIsolation (real git)", () => {
  let enclosingRepo: string;
  let workspaceRoot: string;

  beforeEach(async () => {
    // Mirror the production layout: workspaces nested INSIDE a larger
    // checkout, the exact topology behind the SYMPH-373 incident.
    enclosingRepo = await fs.mkdtemp(join(tmpdir(), "symph373-enclosing-"));
    await git(["init", "--quiet", "--initial-branch=main"], enclosingRepo);
    workspaceRoot = join(enclosingRepo, "workspaces");
    await fs.mkdir(workspaceRoot, { recursive: true });
  });

  afterEach(async () => {
    await fs.rm(enclosingRepo, { force: true, recursive: true });
  });

  it("passes for a git-less workspace because the ceiling blocks the walk-up", async () => {
    const workspace = join(workspaceRoot, "issue-a");
    await fs.mkdir(workspace);

    await expect(verifyWorkspaceGitIsolation(workspace)).resolves.toBe(
      undefined,
    );
  });

  it("detects the incident shape: discovery from a git-less workspace reaches the enclosing repo without the ceiling", async () => {
    const workspace = join(workspaceRoot, "issue-escape");
    await fs.mkdir(workspace);

    // Without the isolation env, git discovery escapes to the enclosing
    // repo — proving the probe (which injects the ceiling) is load-bearing.
    const { stdout } = await execFileAsync(
      "git",
      ["rev-parse", "--show-toplevel"],
      { cwd: workspace },
    );
    expect(await fs.realpath(stdout.trim())).toBe(
      await fs.realpath(enclosingRepo),
    );
  });

  it("passes for a healthy git workspace whose toplevel is itself", async () => {
    const workspace = join(workspaceRoot, "issue-b");
    await fs.mkdir(workspace);
    await git(["init", "--quiet", "--initial-branch=main"], workspace);

    await expect(verifyWorkspaceGitIsolation(workspace)).resolves.toBe(
      undefined,
    );
  });

  it("fails closed for a stale worktree pointer", async () => {
    const workspace = join(workspaceRoot, "issue-c");
    await fs.mkdir(workspace);
    await fs.writeFile(
      join(workspace, ".git"),
      "gitdir: /nonexistent/bare/worktrees/issue-c\n",
    );

    await expect(verifyWorkspaceGitIsolation(workspace)).rejects.toMatchObject(
      {
        name: "WorkspacePathError",
        code: ERROR_CODES.workspaceVerifyFailed,
      },
    );
  });

  it("accepts a worktree of a bare clone under the workspace root", async () => {
    // Mirror after-create: bare clone lives under the workspace root and
    // workspaces are worktrees of it.
    const bare = join(workspaceRoot, ".bare-clones", "repo");
    await fs.mkdir(dirname(bare), { recursive: true });

    const seed = await fs.mkdtemp(join(tmpdir(), "symph373-seed-"));
    try {
      await git(["init", "--quiet", "--initial-branch=main"], seed);
      await fs.writeFile(join(seed, "README.md"), "seed\n");
      await git(["add", "."], seed);
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
        seed,
      );
      await git(["clone", "--quiet", "--bare", seed, bare], tmpdir());

      const workspace = join(workspaceRoot, "issue-d");
      await git(
        ["-C", bare, "worktree", "add", workspace, "-b", "wt/issue-d", "main"],
        workspaceRoot,
      );

      await expect(verifyWorkspaceGitIsolation(workspace)).resolves.toBe(
        undefined,
      );
    } finally {
      await fs.rm(seed, { force: true, recursive: true });
    }
  });
});

describe("verifyWorkspaceGitIsolation (injected probe)", () => {
  let workspace: string;

  beforeEach(async () => {
    workspace = await fs.mkdtemp(join(tmpdir(), "symph373-probe-"));
  });

  afterEach(async () => {
    await fs.rm(workspace, { force: true, recursive: true });
  });

  it("fails when a git-less workspace still resolves a repository", async () => {
    const probe: GitProbe = async () => ({
      exitCode: 0,
      stdout: "/somewhere/else/.git\n",
      stderr: "",
    });

    await expect(
      verifyWorkspaceGitIsolation(workspace, { probe }),
    ).rejects.toMatchObject({
      code: ERROR_CODES.workspaceVerifyFailed,
    });
  });

  it("fails when the toplevel resolves outside the workspace", async () => {
    await fs.mkdir(join(workspace, ".git"));
    const probe: GitProbe = async () => ({
      exitCode: 0,
      stdout: "/somewhere/else\n",
      stderr: "",
    });

    await expect(
      verifyWorkspaceGitIsolation(workspace, { probe }),
    ).rejects.toThrow(WorkspacePathError);
  });

  it("passes a git-less workspace only when git itself is absent (spawn ENOENT)", async () => {
    const probe: GitProbe = async () => {
      const error = new Error("spawn git ENOENT") as NodeJS.ErrnoException;
      error.code = "ENOENT";
      throw error;
    };

    await expect(
      verifyWorkspaceGitIsolation(workspace, { probe }),
    ).resolves.toBe(undefined);
  });

  it("fails closed when the probe fails for any non-ENOENT reason (timeout, EACCES)", async () => {
    const probe: GitProbe = async () => {
      const error = new Error(
        "execFile timed out after 10000ms",
      ) as NodeJS.ErrnoException & { killed?: boolean };
      error.killed = true;
      throw error;
    };

    await expect(
      verifyWorkspaceGitIsolation(workspace, { probe }),
    ).rejects.toMatchObject({
      code: ERROR_CODES.workspaceVerifyFailed,
    });
  });

  it("fails closed when git metadata exists but the probe cannot run", async () => {
    await fs.mkdir(join(workspace, ".git"));
    const probe: GitProbe = async () => {
      const error = new Error("spawn git ENOENT") as NodeJS.ErrnoException;
      error.code = "ENOENT";
      throw error;
    };

    await expect(
      verifyWorkspaceGitIsolation(workspace, { probe }),
    ).rejects.toMatchObject({
      code: ERROR_CODES.workspaceVerifyFailed,
    });
  });

  it("passes the isolation env to the probe", async () => {
    const seen: NodeJS.ProcessEnv[] = [];
    const probe: GitProbe = async (_args, options) => {
      seen.push(options.env);
      return { exitCode: 128, stdout: "", stderr: "not a repo" };
    };

    await verifyWorkspaceGitIsolation(workspace, { probe });

    expect(seen).toHaveLength(1);
    expect(seen[0]?.GIT_CEILING_DIRECTORIES).toContain(
      dirname(resolve(workspace)),
    );
    expect(seen[0]?.GIT_DIR).toBeUndefined();
    expect(seen[0]?.GIT_WORK_TREE).toBeUndefined();
  });
});
