import type { BacklogAuditCullClassification } from "../audit/backlog-audit.js";

const IDENTIFIER_CHAR_LIMIT = 25_000;
const IDENTIFIER_LIST_CHAR_LIMIT = 25_000;

export interface PlannerCandidateAuditAnnotation {
  classification: BacklogAuditCullClassification;
  rootIssueIdentifier: string | null;
}

export interface PlannerCandidateAdvisoryRelations {
  relatesTo?: string[];
  duplicates?: string[];
  duplicatedBy?: string[];
  supersedes?: string[];
  supersededBy?: string[];
  relationsTruncated?: boolean;
  parent?: string | null;
  children?: string[];
  childrenTruncated?: boolean;
}

export function renderPlannerIdentifierList(
  identifiers: readonly string[] | undefined,
): string | null {
  if (identifiers === undefined || identifiers.length === 0) {
    return null;
  }
  const cleaned = [...new Set(identifiers.map(normalizeIdentifier))].filter(
    (identifier): identifier is string => identifier !== null,
  );
  return cleaned.length === 0 ? null : joinBounded(cleaned);
}

export function renderPlannerAdvisoryRelations(
  relations: PlannerCandidateAdvisoryRelations | undefined,
): string | null {
  if (relations === undefined) {
    return null;
  }
  const parts: string[] = [];
  const relationGroups: Array<[string, readonly string[] | undefined]> = [
    ["relates", relations.relatesTo],
    ["duplicates", relations.duplicates],
    ["duplicated by", relations.duplicatedBy],
    ["supersedes", relations.supersedes],
    ["superseded by", relations.supersededBy],
  ];
  for (const [label, identifiers] of relationGroups) {
    const rendered = renderPlannerIdentifierList(identifiers);
    if (rendered !== null) {
      parts.push(`${label}: ${rendered}`);
    }
  }
  if (relations.relationsTruncated === true) {
    parts.push("relations truncated");
  }
  const parent = normalizeIdentifier(relations.parent);
  if (parent !== null) {
    parts.push(`parent: ${parent}`);
  }
  const children = renderPlannerIdentifierList(relations.children);
  if (children !== null) {
    parts.push(`children: ${children}`);
  }
  if (relations.childrenTruncated === true) {
    parts.push("children truncated");
  }
  return parts.length === 0 ? null : joinBounded(parts);
}

function normalizeIdentifier(value: string | null | undefined): string | null {
  if (value === null || value === undefined) {
    return null;
  }
  const normalized = value.replace(/\s+/g, " ").trim();
  if (normalized === "") {
    return null;
  }
  return normalized.length > IDENTIFIER_CHAR_LIMIT
    ? `${normalized.slice(0, IDENTIFIER_CHAR_LIMIT)}…`
    : normalized;
}

function joinBounded(parts: readonly string[]): string {
  const kept: string[] = [];
  let length = 0;
  for (const part of parts) {
    const addition = kept.length === 0 ? part.length : part.length + 2;
    if (length + addition > IDENTIFIER_LIST_CHAR_LIMIT) {
      break;
    }
    kept.push(part);
    length += addition;
  }
  if (kept.length === 0) {
    return `${(parts[0] ?? "").slice(0, IDENTIFIER_LIST_CHAR_LIMIT)}…`;
  }
  return kept.length < parts.length ? `${kept.join(", ")}…` : kept.join(", ");
}
