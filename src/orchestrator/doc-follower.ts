import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import { extname, resolve, sep } from "node:path";

import type { IssueDocumentAttachment } from "../domain/model.js";
import { extractLinearDocumentIdFromUrl } from "../tracker/linear-normalize.js";
import type { CodeGroundingClaim } from "./code-grounding.js";
import {
  type BuildGroundingClaimsResult,
  type GroundingClaimSource,
  buildGroundingClaimsForSources,
} from "./grounding-claims.js";

export interface DocFollowerRootSource {
  id: string;
  text: string | null | undefined;
}

export interface FollowedGroundingDoc {
  key: string;
  kind: "filesystem" | "linear";
  reference: string;
  title: string | null;
  depth: number;
  contentHash: string;
  content: string;
}

export interface FollowGroundingDocsInput {
  checkoutRoot: string;
  candidateId: string;
  candidateIdentifier?: string | null;
  rootSources: readonly DocFollowerRootSource[];
  attachedDocuments?: readonly IssueDocumentAttachment[];
  maxDepth?: number;
  maxDocuments?: number;
  readLinearDocument?: (documentId: string) => Promise<string | null>;
  readFile?: (absolutePath: string) => Promise<string>;
}

export interface FollowGroundingDocsResult extends BuildGroundingClaimsResult {
  followedDocs: FollowedGroundingDoc[];
  rejectedRefs: string[];
  warnings: string[];
  cacheHits: number;
}

interface QueuedDocRef {
  kind: "filesystem" | "linear";
  reference: string;
  title: string | null;
  depth: number;
}

type CachedDocRef = Omit<QueuedDocRef, "depth">;

interface CachedDocExtraction {
  refs: CachedDocRef[];
}

const DEFAULT_MAX_DEPTH = 2;
const DEFAULT_MAX_DOCUMENTS = 8;
const DOC_EXTRACTION_CACHE = new Map<string, CachedDocExtraction>();
const MARKDOWN_EXTENSIONS = new Set([".md", ".mdx", ".txt"]);

export async function followGroundingDocs(
  input: FollowGroundingDocsInput,
): Promise<FollowGroundingDocsResult> {
  const checkoutRoot = await fs.realpath(resolve(input.checkoutRoot));
  const maxDepth = input.maxDepth ?? DEFAULT_MAX_DEPTH;
  const maxDocuments = input.maxDocuments ?? DEFAULT_MAX_DOCUMENTS;
  const readFile = input.readFile ?? ((path) => fs.readFile(path, "utf8"));
  const queue = seedQueue(input.rootSources, input.attachedDocuments);
  const seen = new Set<string>();
  const followedDocs: FollowedGroundingDoc[] = [];
  const rejectedRefs: string[] = [];
  const warnings: string[] = [];
  const claimSources: GroundingClaimSource[] = [];
  let cacheHits = 0;

  while (queue.length > 0 && followedDocs.length < maxDocuments) {
    const ref = queue.shift();
    if (ref === undefined || ref.depth > maxDepth) {
      continue;
    }
    const resolved = await resolveDocRef({
      ref,
      checkoutRoot,
      readFile,
      ...(input.readLinearDocument === undefined
        ? {}
        : { readLinearDocument: input.readLinearDocument }),
    });
    if (resolved.status === "rejected") {
      rejectedRefs.push(ref.reference);
      warnings.push(resolved.reason);
      continue;
    }
    const seenKey = `${resolved.kind}:${resolved.reference}`;
    if (seen.has(seenKey)) {
      continue;
    }
    seen.add(seenKey);

    const contentHash = hashContent(resolved.content);
    const cached = DOC_EXTRACTION_CACHE.get(contentHash);
    const extraction = cached ?? {
      refs: discoverDocRefs(resolved.content, 0).map(
        ({ depth: _depth, ...child }) => child,
      ),
    };
    if (cached === undefined) {
      DOC_EXTRACTION_CACHE.set(contentHash, extraction);
    } else {
      cacheHits += 1;
    }
    claimSources.push({
      id: seenKey,
      label: `${resolved.kind} doc ${resolved.reference}`,
      text: resolved.content,
    });
    followedDocs.push({
      key: seenKey,
      kind: resolved.kind,
      reference: resolved.reference,
      title: ref.title,
      depth: ref.depth,
      contentHash,
      content: resolved.content,
    });
    for (const child of extraction.refs) {
      if (queue.length + followedDocs.length >= maxDocuments) {
        break;
      }
      queue.push({ ...child, depth: ref.depth + 1 });
    }
  }

  const claimResult =
    claimSources.length === 0
      ? { claims: [] as CodeGroundingClaim[], mappings: [] }
      : buildGroundingClaimsForSources({
          findingId: `planner-docs:${sanitizeId(input.candidateIdentifier ?? input.candidateId)}`,
          candidateId: input.candidateId,
          candidateIdentifier: input.candidateIdentifier ?? null,
          summary: `Doc-derived grounding claims for ${input.candidateIdentifier ?? input.candidateId}`,
          sources: claimSources,
        });

  return {
    ...claimResult,
    followedDocs,
    rejectedRefs,
    warnings,
    cacheHits,
  };
}

export function clearDocFollowerCache(): void {
  DOC_EXTRACTION_CACHE.clear();
}

function seedQueue(
  rootSources: readonly DocFollowerRootSource[],
  attachedDocuments: readonly IssueDocumentAttachment[] = [],
): QueuedDocRef[] {
  return [
    ...rootSources.flatMap((source) => discoverDocRefs(source.text ?? "", 1)),
    ...attachedDocuments.map((document) => ({
      kind: "linear" as const,
      reference: document.documentId,
      title: document.title,
      depth: 1,
    })),
  ];
}

function discoverDocRefs(text: string, depth: number): QueuedDocRef[] {
  const refs: QueuedDocRef[] = [];
  const seen = new Set<string>();
  const add = (ref: QueuedDocRef): void => {
    const key = `${ref.kind}:${ref.reference}`;
    if (seen.has(key)) {
      return;
    }
    seen.add(key);
    refs.push(ref);
  };

  for (const match of text.matchAll(
    /(?:`([^`]+)`)|(?:\b((?:\.{1,2}\/|[A-Za-z0-9_.@+-]+\/)[^\s),;]+))/g,
  )) {
    const value = (match[1] ?? match[2] ?? "").replace(/[.,;:]+$/, "");
    if (looksLikeDocPath(value)) {
      add({ kind: "filesystem", reference: value, title: null, depth });
    }
  }
  for (const match of text.matchAll(/https?:\/\/[^\s)>,]+/g)) {
    const rawUrl = match[0].replace(/[.,;:]+$/, "");
    const documentId = extractLinearDocumentIdFromUrl(rawUrl);
    if (documentId !== null) {
      add({ kind: "linear", reference: documentId, title: null, depth });
    }
  }
  return refs;
}

async function resolveDocRef(input: {
  ref: QueuedDocRef;
  checkoutRoot: string;
  readLinearDocument?: (documentId: string) => Promise<string | null>;
  readFile: (absolutePath: string) => Promise<string>;
}): Promise<
  | {
      status: "resolved";
      kind: "filesystem" | "linear";
      reference: string;
      content: string;
    }
  | { status: "rejected"; reason: string }
> {
  if (input.ref.kind === "linear") {
    if (input.readLinearDocument === undefined) {
      return {
        status: "rejected",
        reason: `Linear document ${input.ref.reference} could not be read without a document reader.`,
      };
    }
    let content: string | null;
    try {
      content = await input.readLinearDocument(input.ref.reference);
    } catch {
      return {
        status: "rejected",
        reason: `Linear document ${input.ref.reference} could not be read.`,
      };
    }
    if (content === null) {
      return {
        status: "rejected",
        reason: `Linear document ${input.ref.reference} was not found.`,
      };
    }
    return {
      status: "resolved",
      kind: "linear",
      reference: input.ref.reference,
      content,
    };
  }

  const absolutePath = resolve(input.checkoutRoot, input.ref.reference);
  if (!pathInsideRoot(input.checkoutRoot, absolutePath)) {
    return {
      status: "rejected",
      reason: `Rejected filesystem doc reference outside checkout root: ${input.ref.reference}`,
    };
  }
  let realPath: string;
  try {
    realPath = await fs.realpath(absolutePath);
  } catch {
    return {
      status: "rejected",
      reason: `Filesystem doc reference was not readable: ${input.ref.reference}`,
    };
  }
  if (!pathInsideRoot(input.checkoutRoot, realPath)) {
    return {
      status: "rejected",
      reason: `Rejected filesystem doc reference outside checkout root: ${input.ref.reference}`,
    };
  }
  let content: string;
  try {
    content = await input.readFile(realPath);
  } catch {
    return {
      status: "rejected",
      reason: `Filesystem doc reference was not readable: ${input.ref.reference}`,
    };
  }
  return {
    status: "resolved",
    kind: "filesystem",
    reference: normalizeRelativeReference(input.checkoutRoot, realPath),
    content,
  };
}

function looksLikeDocPath(value: string): boolean {
  if (value.includes("\0") || value.trim() === "") {
    return false;
  }
  return MARKDOWN_EXTENSIONS.has(extname(value).toLowerCase());
}

function pathInsideRoot(root: string, candidate: string): boolean {
  const normalizedRoot = root.endsWith(sep) ? root : `${root}${sep}`;
  return candidate === root || candidate.startsWith(normalizedRoot);
}

function normalizeRelativeReference(
  root: string,
  absolutePath: string,
): string {
  return absolutePath.slice(root.length).replace(/^[/\\]+/, "");
}

function hashContent(content: string): string {
  return createHash("sha256").update(content).digest("hex");
}

function sanitizeId(value: string): string {
  const sanitized = value.trim().replace(/[^A-Za-z0-9_.:-]+/g, "-");
  return sanitized === "" ? "candidate" : sanitized.slice(0, 64);
}
