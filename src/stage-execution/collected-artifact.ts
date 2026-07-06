export type CollectedEntry =
  | { name: string; content: string; hash: string }
  | { name: string; hash: string; bytes: number; contentWithheld: true };
export type CollectedArtifact =
  | {
      status: "ready";
      jobId: string;
      primary: { name: string; content: string; hash: string };
      entries: CollectedEntry[];
      producerPath?: string;
    }
  | {
      status: "oversize";
      jobId: string;
      primary: { name: string; hash: string; bytes: number };
      entries: CollectedEntry[];
      reason: string;
    }
  | {
      status: "missing" | "empty";
      jobId: string;
      entries: CollectedEntry[];
      reason: string;
    };
export function readCollectedArtifact(
  collectResult: unknown,
): CollectedArtifact {
  const collect = recordOrNull(collectResult);
  const jobId = stringOr(collect?.job_id, "unknown");
  const materialized = recordOrNull(collect?.materialized);
  if (materialized === null) {
    return malformed(jobId, []);
  }
  const status = stringOr(materialized.status, "missing");
  const entries = readEntries(materialized.entries);
  if (status === "ready") {
    const primary = recordOrNull(materialized.primary);
    const content = stringOrNull(primary?.content);
    const name = stringOrNull(primary?.name);
    const hash = stringOrNull(primary?.hash);
    if (content !== null && name !== null && hash !== null) {
      const producerPath = stringOrNull(materialized.producerPath);
      return {
        status: "ready",
        jobId: stringOr(materialized.jobId ?? materialized.job_id, jobId),
        primary: { name, content, hash },
        entries,
        ...(producerPath === null || producerPath.trim() === ""
          ? {}
          : { producerPath }),
      };
    }
    return malformed(jobId, entries);
  }
  if (status === "oversize") {
    const primary = recordOrNull(materialized.primary);
    const name = stringOrNull(primary?.name);
    const hash = stringOrNull(primary?.hash);
    const bytes = numberOrNull(primary?.bytes);
    if (primary !== null && name !== null && hash !== null && bytes !== null) {
      return {
        status: "oversize",
        jobId: stringOr(materialized.jobId ?? materialized.job_id, jobId),
        primary: { name, hash, bytes },
        entries,
        reason: stringOr(materialized.reason, "primary artifact exceeded cap"),
      };
    }
    return malformed(jobId, entries);
  }
  if (status === "empty" || status === "missing") {
    return {
      status,
      jobId: stringOr(materialized.jobId ?? materialized.job_id, jobId),
      entries,
      reason: stringOr(materialized.reason, status),
    };
  }
  return malformed(jobId, entries);
}
export function artifactRefsFromCollectedArtifact(
  artifact: CollectedArtifact | undefined,
): readonly string[] {
  return artifactValues(artifact, "name");
}
export function artifactHashesFromCollectedArtifact(
  artifact: CollectedArtifact | undefined,
): readonly string[] {
  return artifactValues(artifact, "hash");
}
function readEntries(value: unknown): CollectedEntry[] {
  if (!Array.isArray(value)) return [];
  const entries: CollectedEntry[] = [];
  for (const item of value) {
    const entry = recordOrNull(item);
    const name = stringOrNull(entry?.name);
    const hash = stringOrNull(entry?.hash);
    if (entry === null || name === null || hash === null) {
      continue;
    }
    const content = stringOrNull(entry.content);
    if (content !== null) {
      entries.push({ name, content, hash });
      continue;
    }
    if (entry.contentWithheld === true) {
      const bytes = numberOrNull(entry.bytes) ?? 0;
      entries.push({ name, hash, bytes, contentWithheld: true });
    }
  }
  return entries;
}
function malformed(
  jobId: string,
  entries: CollectedEntry[],
): CollectedArtifact {
  return {
    status: "missing",
    jobId,
    entries,
    reason: "producer_predates_materialization",
  };
}
function artifactValues(
  artifact: CollectedArtifact | undefined,
  key: "name" | "hash",
): readonly string[] {
  if (artifact === undefined) return [];
  const entries = artifact.entries.map((entry) => entry[key]);
  return artifact.status === "ready"
    ? [artifact.primary[key], ...entries]
    : entries;
}
function recordOrNull(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}
function stringOr(value: unknown, fallback: string): string {
  const text = stringOrNull(value);
  return text === null || text.trim() === "" ? fallback : text;
}
function stringOrNull(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}
function numberOrNull(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? value
    : null;
}
