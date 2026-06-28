import { execFile } from "node:child_process";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";

import { readHotFileGrowth } from "../../../src/agent/health/hot-file-reader.js";

const execFileAsync = promisify(execFile);

/** Tmpdirs created during a test; torn down in afterEach. */
const tmpDirs: string[] = [];

afterEach(async () => {
  while (tmpDirs.length > 0) {
    const dir = tmpDirs.pop();
    if (dir !== undefined) {
      await fs.rm(dir, { force: true, recursive: true });
    }
  }
});

async function git(args: string[], cwd: string): Promise<void> {
  await execFileAsync("git", args, { cwd });
}

/** Create an isolated tmpdir tracked for cleanup. */
async function makeTmpDir(): Promise<string> {
  const dir = await fs.mkdtemp(join(tmpdir(), "symph939-hotfile-"));
  tmpDirs.push(dir);
  return dir;
}

/**
 * Initialize a hermetic git repo: deterministic identity, signing off, and a
 * fixed initial branch so nothing depends on the host's git config.
 */
async function initRepo(): Promise<string> {
  const dir = await makeTmpDir();
  await git(["init", "--quiet", "--initial-branch=main"], dir);
  await git(["config", "user.email", "test@example.com"], dir);
  await git(["config", "user.name", "Symph Test"], dir);
  await git(["config", "commit.gpgsign", "false"], dir);
  return dir;
}

/** Write a file then stage+commit it under a deterministic message. */
async function commitFile(
  repo: string,
  fileName: string,
  contents: string,
  message: string,
): Promise<void> {
  await fs.writeFile(join(repo, fileName), contents);
  await git(["add", fileName], repo);
  await git(["commit", "--quiet", "-m", message], repo);
}

/** N lines of "<prefix> <i>\n", to drive a controlled line-churn count. */
function lines(prefix: string, count: number): string {
  return `${Array.from({ length: count }, (_, i) => `${prefix} ${i}`).join("\n")}\n`;
}

describe("readHotFileGrowth", () => {
  it("flags a single dominant hot file as high concentration", async () => {
    const repo = await initRepo();
    // hot.ts churns heavily across several commits; the others barely move.
    await commitFile(repo, "hot.ts", lines("hot", 100), "seed hot");
    await commitFile(repo, "tiny-a.ts", lines("a", 2), "seed tiny-a");
    await commitFile(repo, "tiny-b.ts", lines("b", 2), "seed tiny-b");
    await commitFile(repo, "hot.ts", lines("HOT", 200), "rewrite hot once");
    await commitFile(
      repo,
      "hot.ts",
      lines("hot-again", 200),
      "rewrite hot twice",
    );

    const result = await readHotFileGrowth({ repoPath: repo });

    expect(result).not.toBeNull();
    expect(result?.godFileConcentration).toBe("high");
    expect(result?.topFileChurnFraction).toBeGreaterThanOrEqual(0.5);
    expect(result?.topFileChurnFraction).toBeLessThanOrEqual(1);
  });

  it("reports low concentration for an even churn spread", async () => {
    const repo = await initRepo();
    // Four files, each committed once with the same line count → each holds
    // ~1/4 of total churn, so the hottest fraction is ~0.25 from below.
    // Use 4 evenly-churned files so max share sits just under the medium
    // threshold (0.25) → "low".
    await commitFile(repo, "a.ts", lines("a", 10), "seed a");
    await commitFile(repo, "b.ts", lines("b", 10), "seed b");
    await commitFile(repo, "c.ts", lines("c", 10), "seed c");
    await commitFile(repo, "d.ts", lines("d", 10), "seed d");
    await commitFile(repo, "e.ts", lines("e", 10), "seed e");

    const result = await readHotFileGrowth({ repoPath: repo });

    expect(result).not.toBeNull();
    // 5 files each with identical churn → each is exactly 1/5 = 0.2 < 0.25.
    expect(result?.topFileChurnFraction).toBeCloseTo(0.2, 5);
    expect(result?.godFileConcentration).toBe("low");
  });

  it("returns null for an empty (zero-commit) repo", async () => {
    const repo = await initRepo();

    const result = await readHotFileGrowth({ repoPath: repo });

    expect(result).toBeNull();
  });

  it("returns null for a non-git directory", async () => {
    const dir = await makeTmpDir();
    await fs.writeFile(join(dir, "loose.txt"), "not a repo\n");

    const result = await readHotFileGrowth({ repoPath: dir });

    expect(result).toBeNull();
  });

  it("returns null when the subprocess times out / errors (degradation)", async () => {
    const repo = await initRepo();
    await commitFile(repo, "hot.ts", lines("hot", 100), "seed hot");

    // Inject a runner that rejects with a timeout/kill-shaped error. This makes
    // the degradation path deterministic — a real 1ms timeout races the git
    // spawn and is flaky (sometimes git flushes output before the kill lands).
    const timeoutError = Object.assign(
      new Error("Command failed: git log ... ETIMEDOUT"),
      {
        killed: true,
        signal: "SIGTERM",
        code: null,
      },
    );
    const result = await readHotFileGrowth({
      repoPath: repo,
      timeoutMs: 1,
      // The runner only ever throws here, so its declared return type is moot.
      // `as never` satisfies the `typeof execFileAsync` seam (whose real return
      // is a PromiseWithChild) without fabricating a ChildProcess.
      execFileImpl: (async () => {
        throw timeoutError;
      }) as never,
    });

    expect(result).toBeNull();
  });

  it("returns null for a non-existent repo path", async () => {
    const result = await readHotFileGrowth({
      repoPath: join(tmpdir(), "symph939-does-not-exist-xyz"),
    });

    expect(result).toBeNull();
  });

  it("treats binary files as zero churn (no NaN, no leak)", async () => {
    const repo = await initRepo();
    // A real binary blob → numstat renders "-\t-\tblob.bin" (added/deleted "-").
    await fs.writeFile(
      join(repo, "blob.bin"),
      Buffer.from([0, 1, 2, 0, 255, 254, 0, 3]),
    );
    await git(["add", "blob.bin"], repo);
    await git(["commit", "--quiet", "-m", "add binary"], repo);
    // Plus one text file so there is real churn to measure.
    await commitFile(repo, "code.ts", lines("code", 40), "seed code");

    const result = await readHotFileGrowth({ repoPath: repo });

    expect(result).not.toBeNull();
    // Only code.ts contributes churn → it is 100% of total.
    expect(result?.topFileChurnFraction).toBe(1);
    expect(Number.isNaN(result?.topFileChurnFraction ?? Number.NaN)).toBe(
      false,
    );
    expect(result?.godFileConcentration).toBe("high");
  });

  it("never leaks file paths in the result (R7)", async () => {
    const repo = await initRepo();
    const committedNames = [
      "secret-service.ts",
      "another-module.ts",
      "third-thing.ts",
    ];
    await commitFile(repo, committedNames[0]!, lines("svc", 80), "seed svc");
    await commitFile(repo, committedNames[1]!, lines("mod", 4), "seed mod");
    await commitFile(repo, committedNames[2]!, lines("thr", 4), "seed thr");

    const result = await readHotFileGrowth({ repoPath: repo });
    expect(result).not.toBeNull();

    // Exactly the two contract keys, nothing else.
    expect(Object.keys(result ?? {}).sort()).toEqual([
      "godFileConcentration",
      "topFileChurnFraction",
    ]);

    // Serialized result carries no path separators and none of the file names.
    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain("/");
    for (const name of committedNames) {
      expect(serialized).not.toContain(name);
    }
  });

  it("honors maxCommits to bound the window", async () => {
    const repo = await initRepo();
    // Older, dominant churn on big.ts, then a newer small commit on small.ts.
    await commitFile(repo, "big.ts", lines("big", 100), "old big churn");
    await commitFile(repo, "small.ts", lines("small", 2), "new small churn");

    // max-count=1 sees only the most recent commit (small.ts) → small is 100%.
    const result = await readHotFileGrowth({ repoPath: repo, maxCommits: 1 });

    expect(result).not.toBeNull();
    expect(result?.topFileChurnFraction).toBe(1);
    expect(result?.godFileConcentration).toBe("high");
  });
});
