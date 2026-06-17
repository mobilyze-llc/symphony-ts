import { createHash } from "node:crypto";
import { lstat, readFile, realpath, rm, stat, unlink } from "node:fs/promises";
import { basename, isAbsolute, relative, resolve } from "node:path";

export type CmuxMirrorFallbackFailureKind =
  | "absent"
  | "invalid"
  | "stale"
  | "symlink_escape"
  | "remote_mismatch"
  | "provenance_mismatch";

export interface CmuxMirrorFallbackStatus {
  attempted: boolean;
  used: boolean;
  remoteArtifactPath: string | null;
  selectedMirrorPath: string | null;
  freshnessPassed: boolean | null;
  failureKind: CmuxMirrorFallbackFailureKind | null;
  validationErrors: string[];
}

export interface CmuxArtifactPathResolution {
  artifactPath: string;
  remoteArtifactPath: string | null;
  validationErrors: string[];
  mirrorFallback: CmuxMirrorFallbackStatus;
}

/**
 * Snapshot of the same-stem mirror taken immediately before a lane launches.
 *
 * Mirror freshness is established by an absent-before -> present-after signal
 * rather than a wall-clock comparison: {@link removeStaleCmuxMirror} clears any
 * pre-existing mirror before launch, so a mirror present afterwards was written
 * during the run. Comparing the prior identity (inode + mtime) to the post-run
 * mirror also catches the edge case where the prior mirror could not be cleared.
 * The former `mtimeMs >= runStartedAtMs` check flaked on CI because filesystem
 * mtime granularity / clock skew could make a freshly written mirror look older
 * than a wall-clock start captured via `Date.now()`.
 */
export interface CmuxMirrorPriorState {
  /** Whether a mirror entry existed at the mirror path immediately before launch. */
  existed: boolean;
  /**
   * Inode of the pre-run mirror, captured before removal. Null when the mirror
   * was absent or its identity could not be captured (e.g. an unlinked symlink),
   * in which case a post-run mirror is treated as freshly written.
   */
  ino: number | null;
  /** mtimeMs of the pre-run mirror, paired with {@link ino}; null when uncapturable. */
  mtimeMs: number | null;
}

const ABSENT_MIRROR_PRIOR_STATE: CmuxMirrorPriorState = {
  existed: false,
  ino: null,
  mtimeMs: null,
};

const VALID_SHA256_HEX = /^[a-f0-9]{64}$/;

export async function removeStaleCmuxMirror(input: {
  artifactDir: string;
  artifactName: string;
}): Promise<CmuxMirrorPriorState> {
  const resolvedArtifactDir = resolve(input.artifactDir);
  const mirrorPath = resolve(resolvedArtifactDir, `${input.artifactName}.md`);
  if (!isInside(resolvedArtifactDir, mirrorPath)) {
    return ABSENT_MIRROR_PRIOR_STATE;
  }

  let priorState: CmuxMirrorPriorState;
  try {
    const mirrorEntry = await lstat(mirrorPath);
    if (mirrorEntry.isSymbolicLink()) {
      await unlink(mirrorPath);
      // The entry existed, but a cleared symlink has no identity to compare a
      // subsequently written regular-file mirror against — treat it as fresh.
      return { existed: true, ino: null, mtimeMs: null };
    }
    priorState = {
      existed: true,
      ino: mirrorEntry.ino,
      mtimeMs: mirrorEntry.mtimeMs,
    };
  } catch {
    return ABSENT_MIRROR_PRIOR_STATE;
  }

  const mirror = await validateArtifactPathWithinDir(
    input.artifactDir,
    mirrorPath,
  );
  if (mirror.validationErrors.length > 0) {
    return priorState;
  }

  // Recursive cleanup is intentional: stale same-stem mirrors may be files or
  // directories, but cleanup stays scoped to runner-managed artifact scratch.
  await rm(mirror.artifactPath, { force: true, recursive: true });
  return priorState;
}

export async function validateArtifactPathWithinDir(
  artifactDir: string,
  candidatePath: string,
): Promise<{ artifactPath: string; validationErrors: string[] }> {
  const resolvedArtifactDir = resolve(artifactDir);
  const artifactPath = resolve(resolvedArtifactDir, candidatePath);
  const canonicalArtifactDir = await realpathOrSelf(resolvedArtifactDir);
  const canonicalArtifactPath = await realpathWithinCanonicalRoot(
    resolvedArtifactDir,
    canonicalArtifactDir,
    artifactPath,
  );
  if (!isInside(canonicalArtifactDir, canonicalArtifactPath)) {
    return {
      artifactPath,
      validationErrors: [
        `artifact_path resolves outside artifact dir: ${candidatePath}`,
      ],
    };
  }
  return { artifactPath, validationErrors: [] };
}

export async function resolveCmuxArtifactPath(input: {
  artifactDir: string;
  artifactName: string;
  candidatePath: string;
  priorMirror?: CmuxMirrorPriorState;
  remoteArtifactSha256?: string | null;
}): Promise<CmuxArtifactPathResolution> {
  const primary = await validateArtifactPathWithinDir(
    input.artifactDir,
    input.candidatePath,
  );
  if (primary.validationErrors.length === 0) {
    return {
      ...primary,
      remoteArtifactPath: null,
      mirrorFallback: emptyMirrorFallback(),
    };
  }

  const remoteArtifactPath = primary.artifactPath;
  const mirrorPath = resolve(input.artifactDir, `${input.artifactName}.md`);
  const mirrorFallbackBase = {
    attempted: true,
    used: false,
    remoteArtifactPath,
    selectedMirrorPath: null,
    freshnessPassed: null,
  };

  if (basename(remoteArtifactPath) !== `${input.artifactName}.md`) {
    return fallbackFailure(
      primary,
      mirrorFallbackBase,
      "remote_mismatch",
      `mirror fallback rejected remote artifact path with unexpected basename: ${input.candidatePath}`,
    );
  }

  const mirror = await validateArtifactPathWithinDir(
    input.artifactDir,
    mirrorPath,
  );
  if (mirror.validationErrors.length > 0) {
    return fallbackFailure(
      primary,
      mirrorFallbackBase,
      "symlink_escape",
      mirror.validationErrors[0] ??
        `mirror fallback path resolves outside artifact dir: ${mirrorPath}`,
    );
  }

  try {
    const mirrorStats = await stat(mirror.artifactPath);
    if (!mirrorStats.isFile()) {
      return fallbackFailure(
        primary,
        { ...mirrorFallbackBase, selectedMirrorPath: mirror.artifactPath },
        "invalid",
        `mirror fallback is not a file: ${mirror.artifactPath}`,
      );
    }

    const freshnessPassed = mirrorFreshnessFromPriorState(
      input.priorMirror,
      mirrorStats,
    );
    if (freshnessPassed === false) {
      return fallbackFailure(
        primary,
        {
          ...mirrorFallbackBase,
          selectedMirrorPath: mirror.artifactPath,
          freshnessPassed,
        },
        "stale",
        `mirror fallback is stale: ${mirror.artifactPath}`,
      );
    }

    const provenanceError = await validateRemoteArtifactSha256(
      mirror.artifactPath,
      input.remoteArtifactSha256,
    );
    if (provenanceError !== null) {
      return fallbackFailure(
        primary,
        {
          ...mirrorFallbackBase,
          selectedMirrorPath: mirror.artifactPath,
          freshnessPassed,
        },
        "provenance_mismatch",
        provenanceError,
      );
    }

    return {
      artifactPath: mirror.artifactPath,
      remoteArtifactPath,
      validationErrors: [],
      mirrorFallback: {
        attempted: true,
        used: true,
        remoteArtifactPath,
        selectedMirrorPath: mirror.artifactPath,
        freshnessPassed,
        failureKind: null,
        validationErrors: [],
      },
    };
  } catch {
    return fallbackFailure(
      primary,
      { ...mirrorFallbackBase, selectedMirrorPath: mirror.artifactPath },
      "absent",
      `mirror fallback local mirror is absent: ${mirror.artifactPath}`,
    );
  }
}

async function validateRemoteArtifactSha256(
  artifactPath: string,
  remoteArtifactSha256: string | null | undefined,
): Promise<string | null> {
  if (remoteArtifactSha256 === null || remoteArtifactSha256 === undefined) {
    return null;
  }
  const normalized = remoteArtifactSha256.toLowerCase();
  if (!VALID_SHA256_HEX.test(normalized)) {
    return `mirror fallback provenance sha256 is malformed: ${remoteArtifactSha256}`;
  }
  const localSha256 = createHash("sha256")
    .update(await readFile(artifactPath))
    .digest("hex");
  if (localSha256 !== normalized) {
    return `mirror fallback provenance sha256 mismatch: expected ${normalized} but found ${localSha256}`;
  }
  return null;
}

/**
 * Decide whether the post-run mirror is fresh from the pre-run snapshot.
 *
 * Returns `null` when the caller did not supply a snapshot (freshness not
 * assessed). Otherwise the mirror is fresh when it was absent before launch, or
 * when its identity (inode/mtime) differs from the pre-run mirror. Only an
 * unchanged identity — a lingering mirror that {@link removeStaleCmuxMirror}
 * could not clear and the lane did not overwrite — reads as stale.
 */
function mirrorFreshnessFromPriorState(
  priorMirror: CmuxMirrorPriorState | undefined,
  mirrorStats: { ino: number; mtimeMs: number },
): boolean | null {
  if (priorMirror === undefined) {
    return null;
  }
  if (!priorMirror.existed) {
    return true;
  }
  if (priorMirror.ino === null || priorMirror.mtimeMs === null) {
    return true;
  }
  return (
    mirrorStats.ino !== priorMirror.ino ||
    mirrorStats.mtimeMs !== priorMirror.mtimeMs
  );
}

function fallbackFailure(
  primary: { artifactPath: string; validationErrors: string[] },
  mirrorFallback: Omit<
    CmuxMirrorFallbackStatus,
    "failureKind" | "validationErrors"
  >,
  failureKind: CmuxMirrorFallbackFailureKind,
  validationError: string,
): CmuxArtifactPathResolution {
  const validationErrors = [...primary.validationErrors, validationError];
  return {
    artifactPath: primary.artifactPath,
    remoteArtifactPath: null,
    validationErrors,
    mirrorFallback: {
      ...mirrorFallback,
      failureKind,
      validationErrors,
    },
  };
}

function emptyMirrorFallback(): CmuxMirrorFallbackStatus {
  return {
    attempted: false,
    used: false,
    remoteArtifactPath: null,
    selectedMirrorPath: null,
    freshnessPassed: null,
    failureKind: null,
    validationErrors: [],
  };
}

export async function realpathOrSelf(path: string): Promise<string> {
  try {
    return await realpath(path);
  } catch {
    return path;
  }
}

async function realpathWithinCanonicalRoot(
  resolvedRoot: string,
  canonicalRoot: string,
  candidate: string,
): Promise<string> {
  try {
    return await realpath(candidate);
  } catch {
    return resolve(canonicalRoot, relative(resolvedRoot, candidate));
  }
}

export function isInside(root: string, candidate: string): boolean {
  const rel = relative(resolve(root), resolve(candidate));
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}
