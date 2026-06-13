import { z } from "zod";

import type { WorkflowOperatorAnchorsConfig } from "../config/types.js";
import type { DispatcherRunJournalEntry } from "../domain/model.js";
import { ERROR_CODES } from "../errors/codes.js";
import { TrackerError } from "./errors.js";

export const TICKET_PROVENANCE_CLASSES = [
  "pipeline_generated",
  "tracked_items",
  "code_review",
  "user_report",
  "unknown",
] as const;

export type TicketProvenanceClass = (typeof TICKET_PROVENANCE_CLASSES)[number];

export type TicketFeatureActorKind = "user" | "bot";
export type TicketFeatureActorClass =
  | "operator"
  | "service_account"
  | "bot"
  | "unknown";
export type TicketFeatureEdgeTrust = "operator_confirmed" | "advisory";
export type TicketFeatureAdvisoryReason =
  | "missing_author"
  | "missing_email"
  | "history_truncated"
  | "service_account"
  | "bot_actor"
  | "not_allowlisted";

export interface TicketFeatureActor {
  kind: TicketFeatureActorKind;
  id: string | null;
  name: string | null;
  displayName: string | null;
  email: string | null;
  botType: string | null;
  botSubType: string | null;
}

export interface TicketFeatureIssueRef {
  id: string | null;
  identifier: string | null;
  title: string | null;
  state: string | null;
}

export interface TicketFeatureSourceEdge {
  kind: "parent" | "blocked_by";
  relationId: string | null;
  relationType: string;
  issue: TicketFeatureIssueRef;
  author: TicketFeatureActor | null;
  authoredAt: string | null;
  attributionSource: "issue_history" | "missing" | "history_truncated";
}

export interface TicketFeatureSourceIssue {
  id: string;
  identifier: string;
  title: string;
  description: string | null;
  priority: number | null;
  state: string;
  branchName: string | null;
  url: string | null;
  labels: string[];
  creator: TicketFeatureActor | null;
  parent: TicketFeatureSourceEdge | null;
  blockedBy: TicketFeatureSourceEdge[];
  sourceVisibility: {
    relationPageTruncated: boolean;
    relationHistoryTruncated: boolean;
  };
  createdAt: string | null;
  updatedAt: string | null;
}

export interface TicketFeatureAttributedActor {
  actor: TicketFeatureActor | null;
  actorClass: TicketFeatureActorClass;
}

export interface TicketFeatureTrustedEdge extends TicketFeatureSourceEdge {
  trust: TicketFeatureEdgeTrust;
  authorClass: TicketFeatureActorClass;
  advisoryReason: TicketFeatureAdvisoryReason | null;
}

export type TicketFeatureAcPostureKind =
  | "author_ac"
  | "frozen_snapshot"
  | "neither";

export interface TicketFeatureAcPosture {
  kind: TicketFeatureAcPostureKind;
  hasAuthorAcceptanceCriteria: boolean;
  frozenSnapshot: {
    sequence: number;
    timestamp: string;
    acceptanceCriteria: string;
  } | null;
}

export interface TicketFeatureIntentSufficiency {
  status: "sufficient" | "thin";
  signals: string[];
  rationale: string;
}

export interface TicketFeature {
  issue: {
    id: string;
    identifier: string;
    title: string;
    state: string;
    priority: number | null;
    url: string | null;
    createdAt: string | null;
    updatedAt: string | null;
  };
  provenance: {
    class: TicketProvenanceClass;
    matchedLabels: string[];
    issueAuthor: TicketFeatureAttributedActor | null;
  };
  specLineage: {
    parent: TicketFeatureTrustedEdge | null;
    blockedBy: TicketFeatureTrustedEdge[];
  };
  relationSummary: {
    totalEdges: number;
    operatorConfirmedEdges: number;
    advisoryEdges: number;
    missingAuthorEdges: number;
    serviceAccountEdges: number;
    historyTruncatedEdges: number;
  };
  sourceVisibility: {
    relationPageTruncated: boolean;
    relationHistoryTruncated: boolean;
  };
  components: {
    labels: string[];
    overlappingIssueIdentifiers: string[];
  };
  acPosture: TicketFeatureAcPosture;
  intentSufficiency: TicketFeatureIntentSufficiency;
}

export interface ExtractTicketFeaturesInput {
  issues: readonly TicketFeatureSourceIssue[];
  operatorConfig?: Pick<
    WorkflowOperatorAnchorsConfig,
    "operatorAllowlist" | "serviceAccounts"
  >;
  runJournal?: readonly DispatcherRunJournalEntry[];
}

export interface ExtractTicketFeatureInput
  extends Omit<ExtractTicketFeaturesInput, "issues"> {
  issue: TicketFeatureSourceIssue;
}

const nullableString = z.string().nullable().optional();

const linearStateSchema = z
  .object({
    name: z.string().optional(),
  })
  .passthrough();

const linearUserSchema = z
  .object({
    id: z.string().optional(),
    name: z.string().optional(),
    displayName: z.string().optional(),
    email: z.string().optional(),
  })
  .passthrough();

const linearBotActorSchema = z
  .object({
    id: z.string().optional().nullable(),
    type: z.string().optional(),
    subType: z.string().optional().nullable(),
    name: z.string().optional().nullable(),
    userDisplayName: z.string().optional().nullable(),
  })
  .passthrough();

const linearIssueRefSchema = z
  .object({
    id: z.string().optional(),
    identifier: z.string().optional(),
    title: z.string().optional(),
    state: linearStateSchema.nullable().optional(),
  })
  .passthrough();

const linearLabelSchema = z
  .object({
    name: z.string().optional(),
  })
  .passthrough();

const linearRelationSchema = z
  .object({
    id: z.string().optional(),
    type: z.string().optional(),
    createdAt: z.string().optional(),
    issue: linearIssueRefSchema.nullable().optional(),
    relatedIssue: linearIssueRefSchema.nullable().optional(),
  })
  .passthrough();

const linearRelationHistoryPayloadSchema = z
  .object({
    identifier: z.string().optional(),
    type: z.string().optional(),
  })
  .passthrough();

const linearHistorySchema = z
  .object({
    createdAt: z.string().optional(),
    actor: linearUserSchema.nullable().optional(),
    botActor: linearBotActorSchema.nullable().optional(),
    relationChanges: z
      .array(linearRelationHistoryPayloadSchema)
      .nullable()
      .optional(),
    toParent: linearIssueRefSchema.nullable().optional(),
  })
  .passthrough();

const linearConnectionSchema = <T extends z.ZodType>(nodeSchema: T) =>
  z
    .object({
      nodes: z.array(nodeSchema).optional(),
      pageInfo: z
        .object({
          hasNextPage: z.boolean().optional(),
          endCursor: z.string().nullable().optional(),
        })
        .passthrough()
        .optional(),
    })
    .passthrough()
    .nullable()
    .optional();

const linearTicketFeatureIssueSchema = z
  .object({
    id: z.string().min(1),
    identifier: z.string().min(1),
    title: z.string().min(1),
    description: nullableString,
    priority: z.number().int().nullable().optional(),
    branchName: nullableString,
    url: nullableString,
    createdAt: nullableString,
    updatedAt: nullableString,
    state: z.object({ name: z.string().min(1) }).passthrough(),
    labels: linearConnectionSchema(linearLabelSchema),
    creator: linearUserSchema.nullable().optional(),
    parent: linearIssueRefSchema.nullable().optional(),
    inverseRelations: linearConnectionSchema(linearRelationSchema),
    history: linearConnectionSchema(linearHistorySchema),
  })
  .passthrough();

type LinearTicketFeatureIssue = z.infer<typeof linearTicketFeatureIssueSchema>;
type LinearHistory = z.infer<typeof linearHistorySchema>;
type LinearRelation = z.infer<typeof linearRelationSchema>;
type LinearIssueRef = z.infer<typeof linearIssueRefSchema>;

const PROVENANCE_LABELS: Array<{
  label: string;
  class: TicketProvenanceClass;
}> = [
  { label: "pipeline-generated", class: "pipeline_generated" },
  { label: "source:tracked-items", class: "tracked_items" },
  { label: "source:code-review", class: "code_review" },
  { label: "source:council-review", class: "code_review" },
  { label: "source:user-report", class: "user_report" },
];

const COMPONENT_LABEL_PREFIXES = ["area:", "company:", "component:"];
const AC_HEADING_REGEX = /^(#{1,6})\s*Acceptance Criteria\b[^\n]*$/im;

export function normalizeLinearTicketFeatureIssue(
  node: unknown,
): TicketFeatureSourceIssue {
  const parsed = linearTicketFeatureIssueSchema.safeParse(node);
  if (!parsed.success) {
    throw new TrackerError(
      ERROR_CODES.linearUnknownPayload,
      "Linear ticket feature payload was missing required issue fields.",
      { details: z.treeifyError(parsed.error) },
    );
  }

  const issue = parsed.data;
  const historyNodes = issue.history?.nodes ?? [];
  const relationPageTruncated =
    issue.inverseRelations?.pageInfo?.hasNextPage === true;
  const relationHistoryTruncated =
    issue.history?.pageInfo?.hasNextPage === true;
  const parentRef = normalizeIssueRef(issue.parent);

  return {
    id: issue.id,
    identifier: issue.identifier,
    title: issue.title,
    description:
      typeof issue.description === "string" ? issue.description : null,
    priority:
      typeof issue.priority === "number" && Number.isInteger(issue.priority)
        ? issue.priority
        : null,
    state: issue.state.name,
    branchName: typeof issue.branchName === "string" ? issue.branchName : null,
    url: typeof issue.url === "string" ? issue.url : null,
    labels: normalizeLabels(issue.labels?.nodes ?? []),
    creator: normalizeUserActor(issue.creator),
    parent:
      parentRef === null
        ? null
        : {
            kind: "parent",
            relationId: null,
            relationType: "parent",
            issue: parentRef,
            ...resolveParentAttribution(
              parentRef,
              historyNodes,
              relationHistoryTruncated,
            ),
          },
    blockedBy: normalizeBlockedByEdges(
      issue,
      historyNodes,
      relationHistoryTruncated,
    ),
    sourceVisibility: {
      relationPageTruncated,
      relationHistoryTruncated,
    },
    createdAt: normalizeTimestamp(issue.createdAt),
    updatedAt: normalizeTimestamp(issue.updatedAt),
  };
}

export function extractTicketFeature(
  input: ExtractTicketFeatureInput,
): TicketFeature {
  const [feature] = extractTicketFeatures({
    issues: [input.issue],
    ...(input.operatorConfig === undefined
      ? {}
      : { operatorConfig: input.operatorConfig }),
    ...(input.runJournal === undefined ? {} : { runJournal: input.runJournal }),
  });
  if (feature === undefined) {
    throw new Error(
      "TicketFeature extraction unexpectedly returned no feature.",
    );
  }
  return feature;
}

export function extractTicketFeatures(
  input: ExtractTicketFeaturesInput,
): TicketFeature[] {
  const accountSets = normalizeOperatorConfig(input.operatorConfig);
  const componentIndex = buildComponentIndex(input.issues);
  const runJournal = input.runJournal ?? [];

  return input.issues.map((issue) => {
    const parent =
      issue.parent === null ? null : attributeEdge(issue.parent, accountSets);
    const blockedBy = issue.blockedBy.map((edge) =>
      attributeEdge(edge, accountSets),
    );
    const allEdges = parent === null ? blockedBy : [parent, ...blockedBy];
    const componentLabels = extractComponentLabels(issue.labels);
    const acPosture = buildAcPosture(issue, runJournal);

    return {
      issue: {
        id: issue.id,
        identifier: issue.identifier,
        title: issue.title,
        state: issue.state,
        priority: issue.priority,
        url: issue.url,
        createdAt: issue.createdAt,
        updatedAt: issue.updatedAt,
      },
      provenance: {
        ...classifyProvenance(issue.labels),
        issueAuthor:
          issue.creator === null
            ? null
            : {
                actor: issue.creator,
                actorClass: classifyActor(issue.creator, accountSets),
              },
      },
      specLineage: {
        parent,
        blockedBy,
      },
      relationSummary: summarizeRelations(allEdges),
      sourceVisibility: issue.sourceVisibility,
      components: {
        labels: componentLabels,
        overlappingIssueIdentifiers: [
          ...findComponentOverlaps(issue, componentLabels, componentIndex),
        ].sort(),
      },
      acPosture,
      intentSufficiency: assessIntentSufficiency(
        issue,
        componentLabels,
        allEdges,
        acPosture,
      ),
    };
  });
}

function normalizeBlockedByEdges(
  issue: LinearTicketFeatureIssue,
  historyNodes: LinearHistory[],
  historyTruncated: boolean,
): TicketFeatureSourceEdge[] {
  const relations = issue.inverseRelations?.nodes ?? [];

  return relations.flatMap((relation) => {
    if (relation.type !== "blocks") {
      return [];
    }
    const relatedIssue = normalizeIssueRef(
      relation.issue ?? relation.relatedIssue,
    );
    if (relatedIssue === null) {
      return [];
    }
    const attribution = resolveRelationAttribution(
      relation,
      relatedIssue,
      historyNodes,
      historyTruncated,
    );

    return [
      {
        kind: "blocked_by" as const,
        relationId: typeof relation.id === "string" ? relation.id : null,
        relationType: relation.type,
        issue: relatedIssue,
        ...attribution,
      },
    ];
  });
}

function resolveRelationAttribution(
  relation: LinearRelation,
  relatedIssue: TicketFeatureIssueRef,
  historyNodes: LinearHistory[],
  historyTruncated: boolean,
): Pick<
  TicketFeatureSourceEdge,
  "author" | "authoredAt" | "attributionSource"
> {
  const relatedIdentifier = normalizeIdentifier(relatedIssue.identifier);
  if (relatedIdentifier === null) {
    return missingAttribution();
  }

  const match = latestHistoryMatch(historyNodes, (history) =>
    (history.relationChanges ?? []).some(
      (change) =>
        change.type === relation.type &&
        normalizeIdentifier(change.identifier) === relatedIdentifier,
    ),
  );

  return match === null
    ? missingAttribution(historyTruncated)
    : historyAttribution(match);
}

function resolveParentAttribution(
  parent: TicketFeatureIssueRef,
  historyNodes: LinearHistory[],
  historyTruncated: boolean,
): Pick<
  TicketFeatureSourceEdge,
  "author" | "authoredAt" | "attributionSource"
> {
  const parentId = parent.id;
  const parentIdentifier = normalizeIdentifier(parent.identifier);
  const match = latestHistoryMatch(historyNodes, (history) => {
    const toParent = history.toParent;
    if (toParent === null || toParent === undefined) {
      return false;
    }
    if (parentId !== null && toParent.id === parentId) {
      return true;
    }
    return (
      parentIdentifier !== null &&
      normalizeIdentifier(toParent.identifier) === parentIdentifier
    );
  });

  return match === null
    ? missingAttribution(historyTruncated)
    : historyAttribution(match);
}

function latestHistoryMatch(
  historyNodes: LinearHistory[],
  predicate: (history: LinearHistory) => boolean,
): LinearHistory | null {
  let latest: LinearHistory | null = null;
  let latestMs = Number.NEGATIVE_INFINITY;
  for (const history of historyNodes) {
    const createdAt = normalizeTimestamp(history.createdAt);
    if (createdAt === null || !predicate(history)) {
      continue;
    }
    const ms = Date.parse(createdAt);
    if (ms > latestMs) {
      latest = history;
      latestMs = ms;
    }
  }
  return latest;
}

function historyAttribution(
  history: LinearHistory,
): Pick<
  TicketFeatureSourceEdge,
  "author" | "authoredAt" | "attributionSource"
> {
  return {
    author: normalizeHistoryActor(history),
    authoredAt: normalizeTimestamp(history.createdAt),
    attributionSource: "issue_history",
  };
}

function missingAttribution(
  historyTruncated = false,
): Pick<
  TicketFeatureSourceEdge,
  "author" | "authoredAt" | "attributionSource"
> {
  return {
    author: null,
    authoredAt: null,
    attributionSource: historyTruncated ? "history_truncated" : "missing",
  };
}

function normalizeHistoryActor(
  history: LinearHistory,
): TicketFeatureActor | null {
  return (
    normalizeUserActor(history.actor) ?? normalizeBotActor(history.botActor)
  );
}

function normalizeUserActor(
  actor: z.infer<typeof linearUserSchema> | null | undefined,
): TicketFeatureActor | null {
  if (actor === null || actor === undefined) {
    return null;
  }

  return {
    kind: "user",
    id: typeof actor.id === "string" ? actor.id : null,
    name: typeof actor.name === "string" ? actor.name : null,
    displayName:
      typeof actor.displayName === "string" ? actor.displayName : null,
    email: normalizeEmail(actor.email),
    botType: null,
    botSubType: null,
  };
}

function normalizeBotActor(
  actor: z.infer<typeof linearBotActorSchema> | null | undefined,
): TicketFeatureActor | null {
  if (actor === null || actor === undefined) {
    return null;
  }

  return {
    kind: "bot",
    id: typeof actor.id === "string" ? actor.id : null,
    name: typeof actor.name === "string" ? actor.name : null,
    displayName:
      typeof actor.userDisplayName === "string" ? actor.userDisplayName : null,
    email: null,
    botType: typeof actor.type === "string" ? actor.type : null,
    botSubType: typeof actor.subType === "string" ? actor.subType : null,
  };
}

function normalizeIssueRef(
  issue: LinearIssueRef | null | undefined,
): TicketFeatureIssueRef | null {
  if (
    issue === null ||
    issue === undefined ||
    typeof issue.identifier !== "string"
  ) {
    return null;
  }

  return {
    id: typeof issue.id === "string" ? issue.id : null,
    identifier: issue.identifier,
    title: typeof issue.title === "string" ? issue.title : null,
    state: typeof issue.state?.name === "string" ? issue.state.name : null,
  };
}

function normalizeLabels(
  labels: Array<z.infer<typeof linearLabelSchema>>,
): string[] {
  return labels.flatMap((label) =>
    typeof label.name === "string" ? [label.name.toLowerCase()] : [],
  );
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

function normalizeIdentifier(value: string | null | undefined): string | null {
  if (typeof value !== "string" || value.trim() === "") {
    return null;
  }
  return value.trim().toUpperCase();
}

function normalizeEmail(value: string | null | undefined): string | null {
  if (typeof value !== "string" || value.trim() === "") {
    return null;
  }
  return value.trim().toLowerCase();
}

function normalizeOperatorConfig(
  config:
    | Pick<
        WorkflowOperatorAnchorsConfig,
        "operatorAllowlist" | "serviceAccounts"
      >
    | undefined,
): {
  operatorAllowlist: ReadonlySet<string>;
  serviceAccounts: ReadonlySet<string>;
} {
  return {
    operatorAllowlist: new Set(
      (config?.operatorAllowlist ?? []).flatMap((email) => {
        const normalized = normalizeEmail(email);
        return normalized === null ? [] : [normalized];
      }),
    ),
    serviceAccounts: new Set(
      (config?.serviceAccounts ?? []).flatMap((email) => {
        const normalized = normalizeEmail(email);
        return normalized === null ? [] : [normalized];
      }),
    ),
  };
}

function attributeEdge(
  edge: TicketFeatureSourceEdge,
  accountSets: {
    operatorAllowlist: ReadonlySet<string>;
    serviceAccounts: ReadonlySet<string>;
  },
): TicketFeatureTrustedEdge {
  const authorClass = classifyActor(edge.author, accountSets);
  const advisoryReason = getAdvisoryReason(edge, authorClass);
  return {
    ...edge,
    authorClass,
    trust: authorClass === "operator" ? "operator_confirmed" : "advisory",
    advisoryReason,
  };
}

function classifyActor(
  actor: TicketFeatureActor | null,
  accountSets: {
    operatorAllowlist: ReadonlySet<string>;
    serviceAccounts: ReadonlySet<string>;
  },
): TicketFeatureActorClass {
  if (actor === null) {
    return "unknown";
  }
  if (actor.kind === "bot") {
    return "bot";
  }
  if (actor.email === null) {
    return "unknown";
  }
  if (accountSets.serviceAccounts.has(actor.email)) {
    return "service_account";
  }
  if (accountSets.operatorAllowlist.has(actor.email)) {
    return "operator";
  }
  return "unknown";
}

function getAdvisoryReason(
  edge: TicketFeatureSourceEdge,
  actorClass: TicketFeatureActorClass,
): TicketFeatureAdvisoryReason | null {
  if (actorClass === "operator") {
    return null;
  }
  if (edge.attributionSource === "history_truncated") {
    return "history_truncated";
  }
  const actor = edge.author;
  if (actor === null) {
    return "missing_author";
  }
  if (actorClass === "service_account") {
    return "service_account";
  }
  if (actorClass === "bot") {
    return "bot_actor";
  }
  return actor.email === null ? "missing_email" : "not_allowlisted";
}

function classifyProvenance(labels: readonly string[]): {
  class: TicketProvenanceClass;
  matchedLabels: string[];
} {
  const labelSet = new Set(labels.map((label) => label.toLowerCase()));
  const matches = PROVENANCE_LABELS.filter((entry) =>
    labelSet.has(entry.label),
  );
  return {
    class: matches[0]?.class ?? "unknown",
    matchedLabels: matches.map((match) => match.label),
  };
}

function summarizeRelations(edges: readonly TicketFeatureTrustedEdge[]): {
  totalEdges: number;
  operatorConfirmedEdges: number;
  advisoryEdges: number;
  missingAuthorEdges: number;
  serviceAccountEdges: number;
  historyTruncatedEdges: number;
} {
  return {
    totalEdges: edges.length,
    operatorConfirmedEdges: edges.filter(
      (edge) => edge.trust === "operator_confirmed",
    ).length,
    advisoryEdges: edges.filter((edge) => edge.trust === "advisory").length,
    missingAuthorEdges: edges.filter(
      (edge) => edge.advisoryReason === "missing_author",
    ).length,
    serviceAccountEdges: edges.filter(
      (edge) => edge.authorClass === "service_account",
    ).length,
    historyTruncatedEdges: edges.filter(
      (edge) => edge.attributionSource === "history_truncated",
    ).length,
  };
}

function extractComponentLabels(labels: readonly string[]): string[] {
  return labels
    .filter((label) =>
      COMPONENT_LABEL_PREFIXES.some((prefix) => label.startsWith(prefix)),
    )
    .sort();
}

function buildComponentIndex(
  issues: readonly TicketFeatureSourceIssue[],
): Map<string, Set<string>> {
  const index = new Map<string, Set<string>>();
  for (const issue of issues) {
    for (const component of extractComponentLabels(issue.labels)) {
      const identifiers = index.get(component) ?? new Set<string>();
      identifiers.add(issue.identifier);
      index.set(component, identifiers);
    }
  }
  return index;
}

function findComponentOverlaps(
  issue: TicketFeatureSourceIssue,
  componentLabels: readonly string[],
  componentIndex: Map<string, Set<string>>,
): Set<string> {
  const overlaps = new Set<string>();
  for (const component of componentLabels) {
    for (const identifier of componentIndex.get(component) ?? []) {
      if (identifier !== issue.identifier) {
        overlaps.add(identifier);
      }
    }
  }
  return overlaps;
}

function buildAcPosture(
  issue: TicketFeatureSourceIssue,
  runJournal: readonly DispatcherRunJournalEntry[],
): TicketFeatureAcPosture {
  const hasAuthorAcceptanceCriteria = hasAcceptanceCriteriaSection(
    issue.description,
  );
  const frozenSnapshot = latestAcGateSnapshot(issue, runJournal);
  return {
    kind: hasAuthorAcceptanceCriteria
      ? "author_ac"
      : frozenSnapshot === null
        ? "neither"
        : "frozen_snapshot",
    hasAuthorAcceptanceCriteria,
    frozenSnapshot,
  };
}

function hasAcceptanceCriteriaSection(description: string | null): boolean {
  if (description === null) {
    return false;
  }
  const headingMatch = AC_HEADING_REGEX.exec(description);
  if (headingMatch === null) {
    return false;
  }
  const rest = description.slice(headingMatch.index + headingMatch[0].length);
  return rest.trim().length > 0;
}

function latestAcGateSnapshot(
  issue: TicketFeatureSourceIssue,
  runJournal: readonly DispatcherRunJournalEntry[],
): TicketFeatureAcPosture["frozenSnapshot"] {
  let latest: TicketFeatureAcPosture["frozenSnapshot"] = null;
  for (const entry of runJournal) {
    if (
      entry.kind !== "ac_gate" ||
      (entry.issueId !== issue.id && entry.issueIdentifier !== issue.identifier)
    ) {
      continue;
    }
    const acceptanceCriteria = entry.metadata.acceptanceCriteria;
    if (
      entry.metadata.status !== "completed" ||
      typeof acceptanceCriteria !== "string" ||
      acceptanceCriteria.trim() === ""
    ) {
      continue;
    }
    if (latest === null || entry.sequence > latest.sequence) {
      latest = {
        sequence: entry.sequence,
        timestamp: entry.timestamp,
        acceptanceCriteria,
      };
    }
  }
  return latest;
}

function assessIntentSufficiency(
  issue: TicketFeatureSourceIssue,
  componentLabels: readonly string[],
  edges: readonly TicketFeatureTrustedEdge[],
  acPosture: TicketFeatureAcPosture,
): TicketFeatureIntentSufficiency {
  const signals: string[] = [];
  const descriptionLength = issue.description?.trim().length ?? 0;

  if (descriptionLength >= 120) {
    signals.push("body_detail");
  }
  if (acPosture.kind !== "neither") {
    signals.push("acceptance_criteria");
  }
  if (componentLabels.length > 0) {
    signals.push("component_labels");
  }
  if (edges.length > 0) {
    signals.push("spec_lineage");
  }

  const sufficient =
    acPosture.kind !== "neither" ||
    (descriptionLength >= 120 &&
      (componentLabels.length > 0 || edges.length > 0));

  return {
    status: sufficient ? "sufficient" : "thin",
    signals,
    rationale: sufficient
      ? "Ticket has enough body, lineage, component, or AC evidence for investigate to formalize falsifiable ACs cold."
      : "Ticket lacks author ACs and enough body, lineage, or component evidence for cold AC formalization.",
  };
}
