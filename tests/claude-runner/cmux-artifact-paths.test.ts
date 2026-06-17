import { mkdtemp, stat, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  type CmuxMirrorPriorState,
  removeStaleCmuxMirror,
  resolveCmuxArtifactPath,
} from "../../src/claude-runner/cmux-artifact-paths.js";

async function makeArtifactDir(): Promise<string> {
  return mkdtemp(join(tmpdir(), "cmux-artifact-paths-"));
}

// A remote candidate path outside the artifact dir forces the same-stem local
// mirror fallback (the only path where freshness is evaluated).
function remoteCandidate(): string {
  return join(tmpdir(), "opus.md");
}

describe("resolveCmuxArtifactPath mirror freshness", () => {
  it("accepts a mirror absent before the run and present after as fresh", async () => {
    const artifactDir = await makeArtifactDir();
    const mirrorPath = join(artifactDir, "opus.md");
    await writeFile(mirrorPath, "## Verdict\nPASS\n");
    const priorMirror: CmuxMirrorPriorState = {
      existed: false,
      ino: null,
      mtimeMs: null,
    };

    const resolution = await resolveCmuxArtifactPath({
      artifactDir,
      artifactName: "opus",
      candidatePath: remoteCandidate(),
      priorMirror,
    });

    expect(resolution.artifactPath).toBe(mirrorPath);
    expect(resolution.validationErrors).toEqual([]);
    expect(resolution.mirrorFallback).toMatchObject({
      attempted: true,
      used: true,
      freshnessPassed: true,
      failureKind: null,
      selectedMirrorPath: mirrorPath,
    });
  });

  it("rejects a mirror whose identity is unchanged from before the run as stale", async () => {
    const artifactDir = await makeArtifactDir();
    const mirrorPath = join(artifactDir, "opus.md");
    await writeFile(mirrorPath, "## Verdict\nPASS\n");
    const current = await stat(mirrorPath);
    // The pre-run snapshot matches the on-disk file exactly: a lingering mirror
    // removeStaleCmuxMirror could not clear and the lane never overwrote.
    const priorMirror: CmuxMirrorPriorState = {
      existed: true,
      ino: current.ino,
      mtimeMs: current.mtimeMs,
    };

    const resolution = await resolveCmuxArtifactPath({
      artifactDir,
      artifactName: "opus",
      candidatePath: remoteCandidate(),
      priorMirror,
    });

    expect(resolution.mirrorFallback).toMatchObject({
      attempted: true,
      used: false,
      freshnessPassed: false,
      failureKind: "stale",
      selectedMirrorPath: mirrorPath,
    });
    expect(resolution.validationErrors).toEqual(
      expect.arrayContaining([
        expect.stringContaining("mirror fallback is stale"),
      ]),
    );
  });

  it("accepts a mirror whose mtime changed during the run as fresh", async () => {
    const artifactDir = await makeArtifactDir();
    const mirrorPath = join(artifactDir, "opus.md");
    await writeFile(mirrorPath, "## Verdict\nPASS\n");
    const before = await stat(mirrorPath);
    const priorMirror: CmuxMirrorPriorState = {
      existed: true,
      ino: before.ino,
      mtimeMs: before.mtimeMs,
    };
    // Simulate an in-place rewrite during the run: same inode, newer mtime.
    const rewritten = new Date(before.mtimeMs + 5_000);
    await utimes(mirrorPath, rewritten, rewritten);

    const resolution = await resolveCmuxArtifactPath({
      artifactDir,
      artifactName: "opus",
      candidatePath: remoteCandidate(),
      priorMirror,
    });

    expect(resolution.mirrorFallback).toMatchObject({
      used: true,
      freshnessPassed: true,
      failureKind: null,
    });
  });

  it("does not assess freshness when no prior snapshot is supplied", async () => {
    const artifactDir = await makeArtifactDir();
    const mirrorPath = join(artifactDir, "opus.md");
    await writeFile(mirrorPath, "## Verdict\nPASS\n");

    const resolution = await resolveCmuxArtifactPath({
      artifactDir,
      artifactName: "opus",
      candidatePath: remoteCandidate(),
    });

    expect(resolution.mirrorFallback).toMatchObject({
      used: true,
      freshnessPassed: null,
      failureKind: null,
    });
  });

  it("clears a pre-existing mirror then accepts the rewritten mirror regardless of mtime", async () => {
    const artifactDir = await makeArtifactDir();
    const mirrorPath = join(artifactDir, "opus.md");
    // A leftover mirror from a previous run, with a skewed (future) mtime.
    await writeFile(mirrorPath, "old\n");
    const future = new Date(Date.now() + 86_400_000);
    await utimes(mirrorPath, future, future);

    const priorMirror = await removeStaleCmuxMirror({
      artifactDir,
      artifactName: "opus",
    });
    expect(priorMirror.existed).toBe(true);

    // The lane writes a fresh mirror after the pre-run cleanup.
    await writeFile(mirrorPath, "## Verdict\nPASS\n");
    const resolution = await resolveCmuxArtifactPath({
      artifactDir,
      artifactName: "opus",
      candidatePath: remoteCandidate(),
      priorMirror,
    });

    expect(resolution.mirrorFallback).toMatchObject({
      used: true,
      freshnessPassed: true,
      failureKind: null,
      selectedMirrorPath: mirrorPath,
    });
  });
});

describe("removeStaleCmuxMirror", () => {
  it("reports an absent mirror and leaves nothing behind", async () => {
    const artifactDir = await makeArtifactDir();

    const prior = await removeStaleCmuxMirror({
      artifactDir,
      artifactName: "opus",
    });

    expect(prior).toEqual({ existed: false, ino: null, mtimeMs: null });
  });

  it("captures the prior identity and removes an existing mirror file", async () => {
    const artifactDir = await makeArtifactDir();
    const mirrorPath = join(artifactDir, "opus.md");
    await writeFile(mirrorPath, "## Verdict\nPASS\n");
    const before = await stat(mirrorPath);

    const prior = await removeStaleCmuxMirror({
      artifactDir,
      artifactName: "opus",
    });

    expect(prior).toEqual({
      existed: true,
      ino: before.ino,
      mtimeMs: before.mtimeMs,
    });
    await expect(stat(mirrorPath)).rejects.toThrow();
  });
});
