import type {
  BlockerRef,
  Issue,
  IssueDocumentAttachment,
  IssueRelationRef,
} from "../domain/model.js";
import { ERROR_CODES } from "../errors/codes.js";
import { TrackerError } from "./errors.js";
import type { IssueStateSnapshot } from "./tracker.js";

interface LinearConnection<TNode> {
  nodes?: TNode[];
  pageInfo?: {
    hasNextPage?: unknown;
  } | null;
}

interface LinearIssueNode {
  id?: unknown;
  identifier?: unknown;
  title?: unknown;
  description?: unknown;
  priority?: unknown;
  branchName?: unknown;
  url?: unknown;
  createdAt?: unknown;
  updatedAt?: unknown;
  team?: {
    key?: unknown;
  } | null;
  project?: {
    id?: unknown;
    slugId?: unknown;
    name?: unknown;
  } | null;
  state?: {
    name?: unknown;
  } | null;
  labels?: LinearConnection<{
    name?: unknown;
  }> | null;
  attachments?: LinearConnection<{
    title?: unknown;
    url?: unknown;
  }> | null;
  parent?: LinearIssueRelationNode | null;
  children?: LinearConnection<LinearIssueRelationNode> | null;
  relations?: LinearConnection<LinearIssueRelationPayload> | null;
  inverseRelations?: LinearConnection<LinearIssueRelationPayload> | null;
}

interface LinearIssueRelationNode {
  id?: unknown;
  identifier?: unknown;
  title?: unknown;
  state?: {
    name?: unknown;
  } | null;
}

interface LinearIssueRelationPayload {
  type?: unknown;
  issue?: LinearIssueRelationNode | null;
  relatedIssue?: LinearIssueRelationNode | null;
  sourceIssue?: LinearIssueRelationNode | null;
}

interface LinearIssueStateNode {
  id?: unknown;
  identifier?: unknown;
  state?: {
    name?: unknown;
  } | null;
}

export function normalizeLinearIssue(node: unknown): Issue {
  const issue = asLinearIssueNode(node);
  const id = requireString(issue.id, "issue.id");
  const identifier = requireString(issue.identifier, "issue.identifier");
  const title = requireString(issue.title, "issue.title");
  const state = requireString(issue.state?.name, "issue.state.name");

  const portfolioMetadata =
    issue.team !== undefined || issue.project !== undefined
      ? {
          teamKey: optionalString(issue.team?.key),
          projectId: optionalString(issue.project?.id),
          projectSlug: optionalString(issue.project?.slugId),
          projectName: optionalString(issue.project?.name),
        }
      : {};

  const advisoryRelations = normalizeAdvisoryRelations(
    issue.relations,
    issue.inverseRelations,
  );
  const parent = normalizeIssueRelationRef(issue.parent);
  const children = normalizeIssueRelationRefs(issue.children);

  return {
    id,
    identifier,
    title,
    description: optionalString(issue.description),
    ...portfolioMetadata,
    priority: normalizePriority(issue.priority),
    state,
    branchName: optionalString(issue.branchName),
    url: optionalString(issue.url),
    labels: normalizeLabels(issue.labels),
    documentAttachments: normalizeLinearDocumentAttachments(issue.attachments),
    blockedBy: normalizeBlockedBy(issue.inverseRelations),
    ...(hasNextPage(issue.inverseRelations)
      ? { blockedByRelationTruncated: true }
      : {}),
    ...(advisoryRelations.relatesTo.length > 0
      ? { relatesTo: advisoryRelations.relatesTo }
      : {}),
    ...(advisoryRelations.duplicates.length > 0
      ? { duplicates: advisoryRelations.duplicates }
      : {}),
    ...(advisoryRelations.duplicatedBy.length > 0
      ? { duplicatedBy: advisoryRelations.duplicatedBy }
      : {}),
    ...(advisoryRelations.supersedes.length > 0
      ? { supersedes: advisoryRelations.supersedes }
      : {}),
    ...(advisoryRelations.supersededBy.length > 0
      ? { supersededBy: advisoryRelations.supersededBy }
      : {}),
    ...(hasNextPage(issue.relations)
      ? { advisoryRelationsTruncated: true }
      : {}),
    ...(parent === undefined ? {} : { parent }),
    ...(children.length > 0 ? { children } : {}),
    ...(hasNextPage(issue.children) ? { childrenTruncated: true } : {}),
    createdAt: normalizeTimestamp(issue.createdAt),
    updatedAt: normalizeTimestamp(issue.updatedAt),
  };
}

export function normalizeLinearDocumentAttachments(
  attachments: unknown,
): IssueDocumentAttachment[] {
  const nodes =
    attachments !== null &&
    typeof attachments === "object" &&
    !Array.isArray(attachments)
      ? (attachments as LinearConnection<{ title?: unknown; url?: unknown }>)
          .nodes
      : undefined;
  if (!Array.isArray(nodes)) {
    return [];
  }
  return nodes.flatMap((attachment) => {
    const url = optionalString(attachment?.url);
    if (url === null) {
      return [];
    }
    const documentId = extractLinearDocumentIdFromUrl(url);
    if (documentId === null) {
      return [];
    }
    return [
      {
        title: optionalString(attachment?.title),
        url,
        documentId,
      },
    ];
  });
}

export function extractLinearDocumentIdFromUrl(url: string): string | null {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  if (!/(^|\.)linear\.app$/i.test(parsed.hostname)) {
    return null;
  }
  const segments = parsed.pathname
    .split("/")
    .filter((segment) => segment !== "");
  const documentIndex = segments.indexOf("document");
  const documentId = segments[documentIndex + 1];
  if (
    documentIndex < 0 ||
    documentId === undefined ||
    documentId.trim() === ""
  ) {
    return null;
  }
  return decodeURIComponent(documentId);
}

export function normalizeLinearIssueState(node: unknown): IssueStateSnapshot {
  const issue = asLinearIssueStateNode(node);

  return {
    id: requireString(issue.id, "issue.id"),
    identifier: requireString(issue.identifier, "issue.identifier"),
    state: requireString(issue.state?.name, "issue.state.name"),
  };
}

function asLinearIssueNode(node: unknown): LinearIssueNode {
  if (!node || typeof node !== "object" || Array.isArray(node)) {
    throw new TrackerError(
      ERROR_CODES.linearUnknownPayload,
      "Linear issue payload was not an object.",
      { details: node },
    );
  }

  return node as LinearIssueNode;
}

function asLinearIssueStateNode(node: unknown): LinearIssueStateNode {
  if (!node || typeof node !== "object" || Array.isArray(node)) {
    throw new TrackerError(
      ERROR_CODES.linearUnknownPayload,
      "Linear issue state payload was not an object.",
      { details: node },
    );
  }

  return node as LinearIssueStateNode;
}

function requireString(value: unknown, field: string): string {
  if (typeof value === "string" && value.trim() !== "") {
    return value;
  }

  throw new TrackerError(
    ERROR_CODES.linearUnknownPayload,
    `Linear payload field '${field}' was missing or invalid.`,
    { details: value },
  );
}

function optionalString(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function normalizePriority(value: unknown): number | null {
  return typeof value === "number" && Number.isInteger(value) ? value : null;
}

function normalizeLabels(labels: LinearIssueNode["labels"]): string[] {
  const nodes = labels?.nodes;
  if (!Array.isArray(nodes)) {
    return [];
  }

  return nodes
    .map((entry) => (typeof entry?.name === "string" ? entry.name : null))
    .filter((entry): entry is string => entry !== null)
    .map((entry) => entry.toLowerCase());
}

function hasNextPage(
  connection: LinearConnection<unknown> | null | undefined,
): boolean {
  return connection?.pageInfo?.hasNextPage === true;
}

function normalizeBlockedBy(
  inverseRelations: LinearIssueNode["inverseRelations"],
): BlockerRef[] {
  const nodes = inverseRelations?.nodes;
  if (!Array.isArray(nodes)) {
    return [];
  }

  return nodes.flatMap((relation) => {
    if (relation?.type !== "blocks") {
      return [];
    }

    return [normalizeBlocker(relation.issue ?? relation.sourceIssue)];
  });
}

function normalizeBlocker(
  sourceIssue: LinearIssueRelationNode | null | undefined,
): BlockerRef {
  return {
    id: typeof sourceIssue?.id === "string" ? sourceIssue.id : null,
    identifier:
      typeof sourceIssue?.identifier === "string"
        ? sourceIssue.identifier
        : null,
    state:
      typeof sourceIssue?.state?.name === "string"
        ? sourceIssue.state.name
        : null,
  };
}

function normalizeAdvisoryRelations(
  relations: LinearIssueNode["relations"],
  inverseRelations: LinearIssueNode["inverseRelations"],
): {
  relatesTo: IssueRelationRef[];
  duplicates: IssueRelationRef[];
  duplicatedBy: IssueRelationRef[];
  supersedes: IssueRelationRef[];
  supersededBy: IssueRelationRef[];
} {
  const output: {
    relatesTo: IssueRelationRef[];
    duplicates: IssueRelationRef[];
    duplicatedBy: IssueRelationRef[];
    supersedes: IssueRelationRef[];
    supersededBy: IssueRelationRef[];
  } = {
    relatesTo: [],
    duplicates: [],
    duplicatedBy: [],
    supersedes: [],
    supersededBy: [],
  };
  for (const relation of relationNodes(relations)) {
    const type =
      typeof relation?.type === "string" ? relation.type.toLowerCase() : "";
    if (type === "blocks") {
      continue;
    }
    const ref = normalizeIssueRelationRef(
      relation?.relatedIssue ?? relation?.issue ?? relation?.sourceIssue,
    );
    if (ref == null) {
      continue;
    }
    if (type.includes("duplicate")) {
      output.duplicates.push(ref);
    } else if (type.includes("supersede")) {
      output.supersedes.push(ref);
    } else if (type.includes("relate")) {
      output.relatesTo.push(ref);
    }
  }

  for (const relation of relationNodes(inverseRelations)) {
    const type =
      typeof relation?.type === "string" ? relation.type.toLowerCase() : "";
    if (type === "blocks") {
      continue;
    }
    const ref = normalizeIssueRelationRef(
      relation?.issue ?? relation?.sourceIssue,
    );
    if (ref == null) {
      continue;
    }
    if (type.includes("duplicate")) {
      output.duplicatedBy.push(ref);
    } else if (type.includes("supersede")) {
      output.supersededBy.push(ref);
    } else if (type.includes("relate")) {
      output.relatesTo.push(ref);
    }
  }

  return {
    relatesTo: dedupeIssueRelationRefs(output.relatesTo),
    duplicates: dedupeIssueRelationRefs(output.duplicates),
    duplicatedBy: dedupeIssueRelationRefs(output.duplicatedBy),
    supersedes: dedupeIssueRelationRefs(output.supersedes),
    supersededBy: dedupeIssueRelationRefs(output.supersededBy),
  };
}

function relationNodes(
  connection: LinearConnection<LinearIssueRelationPayload> | null | undefined,
) {
  const nodes = connection?.nodes;
  return Array.isArray(nodes) ? nodes : [];
}

function normalizeIssueRelationRefs(
  connection: LinearConnection<LinearIssueRelationNode> | null | undefined,
): IssueRelationRef[] {
  const nodes = connection?.nodes;
  if (!Array.isArray(nodes)) {
    return [];
  }
  return dedupeIssueRelationRefs(
    nodes
      .map((node) => normalizeIssueRelationRef(node))
      .filter((ref): ref is IssueRelationRef => ref != null),
  );
}

function normalizeIssueRelationRef(
  sourceIssue: LinearIssueRelationNode | null | undefined,
): IssueRelationRef | null | undefined {
  if (sourceIssue === undefined) {
    return undefined;
  }
  if (sourceIssue === null) {
    return null;
  }
  return {
    id: typeof sourceIssue.id === "string" ? sourceIssue.id : null,
    identifier:
      typeof sourceIssue.identifier === "string"
        ? sourceIssue.identifier
        : null,
    title: typeof sourceIssue.title === "string" ? sourceIssue.title : null,
    state:
      typeof sourceIssue.state?.name === "string"
        ? sourceIssue.state.name
        : null,
  };
}

function dedupeIssueRelationRefs(
  refs: readonly IssueRelationRef[],
): IssueRelationRef[] {
  const seen = new Set<string>();
  const output: IssueRelationRef[] = [];
  for (const ref of refs) {
    const key = ref.identifier ?? ref.id;
    if (key === null || seen.has(key)) {
      continue;
    }
    seen.add(key);
    output.push(ref);
  }
  return output;
}

function normalizeTimestamp(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }

  const parsed = new Date(value);
  if (Number.isNaN(parsed.valueOf())) {
    return null;
  }

  return parsed.toISOString();
}
