import {
  chmod,
  mkdir,
  mkdtemp,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  type CmuxMirrorPriorState,
  removeStaleCmuxMirror,
  resolveCmuxArtifactPath,
} from "../../src/claude-runner/cmux-artifact-paths.js";

const isRoot = typeof process.getuid === "function" && process.getuid() === 0;

async function makeArtifactDir(): Promise<string> {
  return mkdtemp(join(tmpdir(), "cmux-artifact-paths-"));
}

// A remote candidate path outside the artifact dir forces the same-stem local
// mirror fallback (the only path where freshness is evaluated).
function remoteCandidate(): string {
  return join(tmpdir(), "opus.md");
}

const CLEARED: CmuxMirrorPriorState = { cleared: true };
const UNCLEARED: CmuxMirrorPriorState = { cleared: false };

describe("resolveCmuxArtifactPath mirror freshness", () => {
  it("accepts a mirror as fresh when the path was cleared before the run", async () => {
    const artifactDir = await makeArtifactDir();
    const mirrorPath = join(artifactDir, "opus.md");
    await writeFile(mirrorPath, "## Verdict\nPASS\n");

    const resolution = await resolveCmuxArtifactPath({
      artifactDir,
      artifactName: "opus",
      candidatePath: remoteCandidate(),
      priorMirror: CLEARED,
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

  it("rejects a mirror that survived pre-run cleanup as stale", async () => {
    const artifactDir = await makeArtifactDir();
    const mirrorPath = join(artifactDir, "opus.md");
    await writeFile(mirrorPath, "## Verdict\nPASS\n");

    const resolution = await resolveCmuxArtifactPath({
      artifactDir,
      artifactName: "opus",
      candidatePath: remoteCandidate(),
      priorMirror: UNCLEARED,
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

  // Regression for the council Alpha-1 finding: after a successful pre-run
  // removal the path is cleared, so a replacement is fresh unconditionally —
  // identity (inode/mtime) is never compared, so inode reuse + mtime coarsening
  // cannot produce a false "stale".
  it("accepts a replacement mirror after a successful cleanup regardless of identity", async () => {
    const artifactDir = await makeArtifactDir();
    const mirrorPath = join(artifactDir, "opus.md");
    await writeFile(mirrorPath, "old\n");

    const priorMirror = await removeStaleCmuxMirror({
      artifactDir,
      artifactName: "opus",
    });
    expect(priorMirror).toEqual({ cleared: true });

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

  // Council Beta-3 EXTEND: a pre-existing directory at the mirror path is cleared,
  // then a real file written during the run is accepted as fresh.
  it("accepts a file replacement after clearing a pre-existing directory mirror", async () => {
    const artifactDir = await makeArtifactDir();
    const mirrorPath = join(artifactDir, "opus.md");
    await mkdir(mirrorPath);

    const priorMirror = await removeStaleCmuxMirror({
      artifactDir,
      artifactName: "opus",
    });
    expect(priorMirror).toEqual({ cleared: true });

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
    });
  });
});

describe("removeStaleCmuxMirror", () => {
  it("reports a cleared path when no mirror exists", async () => {
    const artifactDir = await makeArtifactDir();

    const prior = await removeStaleCmuxMirror({
      artifactDir,
      artifactName: "opus",
    });

    expect(prior).toEqual({ cleared: true });
  });

  it("removes an existing mirror file and reports cleared", async () => {
    const artifactDir = await makeArtifactDir();
    const mirrorPath = join(artifactDir, "opus.md");
    await writeFile(mirrorPath, "## Verdict\nPASS\n");

    const prior = await removeStaleCmuxMirror({
      artifactDir,
      artifactName: "opus",
    });

    expect(prior).toEqual({ cleared: true });
    await expect(stat(mirrorPath)).rejects.toThrow();
  });

  it("unlinks a stale mirror symlink and reports cleared", async () => {
    const artifactDir = await makeArtifactDir();
    const mirrorPath = join(artifactDir, "opus.md");
    const target = join(artifactDir, "target.md");
    await writeFile(target, "stale\n");
    await symlink(target, mirrorPath);

    const prior = await removeStaleCmuxMirror({
      artifactDir,
      artifactName: "opus",
    });

    expect(prior).toEqual({ cleared: true });
    await expect(stat(mirrorPath)).rejects.toThrow();
  });

  // Regression for the council Beta-1 finding: a symlink whose unlink fails must
  // be reported as uncleared (not as an absent mirror), so resolveCmuxArtifactPath
  // treats a surviving stale symlink as stale rather than fresh. Skipped as root,
  // where directory permissions do not block unlink.
  it.skipIf(isRoot)(
    "reports uncleared when a stale mirror symlink survives cleanup",
    async () => {
      const artifactDir = await makeArtifactDir();
      const mirrorPath = join(artifactDir, "opus.md");
      const target = join(artifactDir, "target.md");
      await writeFile(target, "stale\n");
      await symlink(target, mirrorPath);
      // Make the parent dir non-writable so unlink(mirrorPath) fails (EACCES).
      await chmod(artifactDir, 0o500);

      let prior: CmuxMirrorPriorState;
      try {
        prior = await removeStaleCmuxMirror({
          artifactDir,
          artifactName: "opus",
        });
      } finally {
        await chmod(artifactDir, 0o700);
      }

      expect(prior).toEqual({ cleared: false });
    },
  );
});
