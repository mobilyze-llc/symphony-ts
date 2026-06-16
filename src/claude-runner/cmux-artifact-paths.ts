import { createHash } from "node:crypto";
import { readFile, realpath, rm, stat } from "node:fs/promises";
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

const VALID_SHA256_HEX = /^[a-f0-9]{64}$/;

export async function removeStaleCmuxMirror(input: {
  artifactDir: string;
  artifactName: string;
}): Promise<void> {
  const mirrorPath = resolve(input.artifactDir, `${input.artifactName}.md`);
  const mirror = await validateArtifactPathWithinDir(
    input.artifactDir,
    mirrorPath,
  );
  if (mirror.validationErrors.length > 0) {
    return;
  }

  // Recursive cleanup is intentional: stale same-stem mirrors may be files or
  // directories, but cleanup stays scoped to runner-managed artifact scratch.
  await rm(mirror.artifactPath, { force: true, recursive: true });
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
  runStartedAtMs?: number;
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

  if (basename(resolve(input.candidatePath)) !== `${input.artifactName}.md`) {
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

    const freshnessPassed =
      input.runStartedAtMs === undefined ||
      mirrorStats.mtimeMs >= input.runStartedAtMs;
    if (!freshnessPassed) {
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
