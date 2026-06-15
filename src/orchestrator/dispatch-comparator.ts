import type {
  BlockerRef,
  ComputedDispatchOrderAdvisoryWarning,
  ComputedDispatchOrderCycle,
  ComputedDispatchOrderExclusion,
  ComputedDispatchOrderSnapshot,
  ComputedDispatchOrderSupersededNativeHardBlocker,
  DispatchFenceState,
  Issue,
  IssueAnchorRecord,
} from "../domain/model.js";
import { normalizeIssueState } from "../domain/model.js";
import type { TicketFeature } from "../tracker/ticket-feature.js";
import {
  formatInvalidAnchorPlacementDetail,
  isIssueAnchorExpired,
  normalizeIssueIdentifier,
  validateAnchorPlacementForIssue,
} from "./anchor-policy.js";

export const DISPATCH_COMPARATOR_VERSION = "dispatch-comparator-v1";
const HARD_CYCLE_DIAGNOSTIC_LIMIT = 5;

export interface ComputeDispatchOrderInput {
  issues: readonly Issue[];
  anchors: Readonly<Record<string, IssueAnchorRecord>>;
  ticketFeatures?: readonly TicketFeature[] | undefined;
  ticketFeatureUnavailableReason?: string | null;
  terminalStates: readonly string[];
  completedIssueIds?: ReadonlySet<string> | undefined;
  dispatchFence?: DispatchFenceState | null | undefined;
  now: Date;
}

interface DispatchEdge {
  issue: Issue;
  blocker: BlockerRef;
  trust: "operator_confirmed" | "advisory" | "legacy_hard";
  source: "ticket_feature" | "issue_blocked_by";
  reason: string;
}

interface DependencyEdgeCollection {
  edges: DispatchEdge[];
  supersededNativeHardBlockers: ComputedDispatchOrderSupersededNativeHardBlocker[];
  warnings: string[];
}

interface HardCycleDiagnostics {
  cycles: ComputedDispatchOrderCycle[];
  omittedCount: number;
}

interface IssueIdentifierIndex {
  byIdentifier: ReadonlyMap<string, Issue>;
  ambiguousIdentifiers: ReadonlySet<string>;
}

type HardDispatchEdge = DispatchEdge & {
  trust: Exclude<DispatchEdge["trust"], "advisory">;
};

export function sortIssuesForDispatch(issues: readonly Issue[]): Issue[] {
  return issues.slice().sort(compareIssuesForDispatch);
}

export function computeDispatchOrder(
  input: ComputeDispatchOrderInput,
): ComputedDispatchOrderSnapshot {
  const baseOrder = sortIssuesForDispatch(input.issues);
  const issueById = new Map(baseOrder.map((issue) => [issue.id, issue]));
  const issueByIdentifier = buildIssueIdentifierIndex(baseOrder);
  const terminalStates = new Set(input.terminalStates.map(normalizeIssueState));
  const edgeCollection = collectDependencyEdges(
    input,
    issueById,
    issueByIdentifier,
  );
  const edges = edgeCollection.edges;
  const hardEdges = edges.filter(isHardEdge);
  const hardCycleDiagnostics = findHardCycles(
    baseOrder,
    hardEdges.filter((edge) => isOpenBlocker(edge.blocker, terminalStates)),
    issueById,
    issueByIdentifier,
  );
  const hardCycle = hardCycleDiagnostics.cycles[0] ?? null;
  const hardExclusions = hardEdges
    .filter((edge) => isOpenBlocker(edge.blocker, terminalStates))
    .map(toExclusion);
  const fenceExclusions = buildDispatchFenceExclusions(
    baseOrder,
    input.dispatchFence ?? null,
  );
  const exclusions = [...hardExclusions, ...fenceExclusions];
  const hardExclusionPairs = buildExclusionPairKeys(exclusions);
  const excludedIssueIds = new Set(
    exclusions.map((exclusion) => exclusion.issue_id),
  );
  const advisoryOpenEdges = edges
    .filter(
      (edge) =>
        edge.trust === "advisory" &&
        isOpenBlocker(edge.blocker, terminalStates) &&
        !excludedIssueIds.has(edge.issue.id),
    )
    .map(toAdvisoryWarning);
  const advisoryWouldExclude = dedupeAdvisoryWarnings(advisoryOpenEdges);
  const warnings = [
    ...new Set([
      ...(input.ticketFeatureUnavailableReason === null ||
      input.ticketFeatureUnavailableReason === undefined
        ? []
        : [input.ticketFeatureUnavailableReason]),
      ...edgeCollection.warnings,
      ...buildIssueIdentifierCollisionWarnings(issueByIdentifier),
    ]),
  ];

  const included = baseOrder.filter((issue) => !excludedIssueIds.has(issue.id));
  const hardOrderingEdges = hardEdges.filter((edge) => {
    const blockerIssue = findIssueByRef(
      edge.blocker,
      issueById,
      issueByIdentifier,
    );
    return (
      blockerIssue !== null &&
      !excludedIssueIds.has(edge.issue.id) &&
      !excludedIssueIds.has(blockerIssue.id) &&
      isOpenBlocker(edge.blocker, terminalStates)
    );
  });
  const linearized = topologicallySortIssues(
    included,
    hardOrderingEdges,
    issueById,
    issueByIdentifier,
  );
  const anchored = applyAnchors(
    linearized.ordered,
    input.anchors,
    input.completedIssueIds ?? new Set<string>(),
    input.now,
  );

  return {
    comparator_version: DISPATCH_COMPARATOR_VERSION,
    generated_at: input.now.toISOString(),
    status: "linearized",
    positions: anchored.ordered.map((issue, index) => ({
      position: index + 1,
      issue_id: issue.id,
      issue_identifier: issue.identifier,
      priority: issue.priority,
      created_at: issue.createdAt,
      rationale: buildRationale(issue, baseOrder, input.anchors, hardEdges),
    })),
    exclusions,
    advisory_warnings: buildAdvisoryWarnings(
      edges,
      issueById,
      issueByIdentifier,
      terminalStates,
      hardExclusionPairs,
    ),
    would_have_been_excluded_by_advisory_edges: advisoryWouldExclude,
    hard_cycle: hardCycle,
    hard_cycles: hardCycleDiagnostics.cycles,
    hard_cycle_omitted_count: hardCycleDiagnostics.omittedCount,
    superseded_native_hard_blockers:
      edgeCollection.supersededNativeHardBlockers,
    warnings: [
      ...warnings,
      ...(hardCycle === null
        ? []
        : [
            `${hardCycle.reason} Cyclic issues were hard-excluded while unrelated candidates remained eligible.`,
            "Hard-cycle diagnostics report a bounded disjoint-cycle sample; overlapping cycles that share a reported issue are represented by that reported cycle, and hard_cycle_omitted_count counts only cycles omitted by the diagnostic cap.",
          ]),
      ...(hardCycleDiagnostics.cycles.length > 1 ||
      hardCycleDiagnostics.omittedCount > 0
        ? [
            `Dispatch comparator detected ${hardCycleDiagnostics.cycles.length} hard dependency cycle(s); ${hardCycleDiagnostics.omittedCount} additional cycle(s) omitted by diagnostic cap ${HARD_CYCLE_DIAGNOSTIC_LIMIT}.`,
          ]
        : []),
      ...linearized.warnings,
      ...anchored.warnings,
    ],
  };
}

function buildDispatchFenceExclusions(
  baseOrder: readonly Issue[],
  fence: DispatchFenceState | null,
): ComputedDispatchOrderExclusion[] {
  if (fence === null) {
    return [];
  }
  const allowlist = new Set(
    fence.issueIdentifiers.map(normalizeIssueIdentifier),
  );
  return baseOrder.flatMap((issue) => {
    if (allowlist.has(normalizeIssueIdentifier(issue.identifier))) {
      return [];
    }
    return [
      {
        issue_id: issue.id,
        issue_identifier: issue.identifier,
        blocker_issue_id: null,
        blocker_issue_identifier: null,
        blocker_state: null,
        edge_trust: "operator_confirmed",
        source: "dispatch_fence",
        reason: `Dispatch fence allows only ${fence.issueIdentifiers.join(", ")}; ${issue.identifier} is outside the active operator allowlist.`,
        fence_source: fence.source,
        operator_remedy:
          "Clear or update the dispatch fence to allow this issue to dispatch.",
      },
    ];
  });
}

function collectDependencyEdges(
  input: ComputeDispatchOrderInput,
  issueById: ReadonlyMap<string, Issue>,
  issueByIdentifier: IssueIdentifierIndex,
): DependencyEdgeCollection {
  const featureByIssueId = new Map<string, TicketFeature>();
  const featureByIdentifier = new Map<string, TicketFeature>();
  const ambiguousFeatureIdentifiers = new Set<string>();
  for (const feature of input.ticketFeatures ?? []) {
    featureByIssueId.set(feature.issue.id, feature);
    const existing = featureByIdentifier.get(feature.issue.identifier);
    if (existing !== undefined && existing.issue.id !== feature.issue.id) {
      featureByIdentifier.delete(feature.issue.identifier);
      ambiguousFeatureIdentifiers.add(feature.issue.identifier);
    } else if (!ambiguousFeatureIdentifiers.has(feature.issue.identifier)) {
      featureByIdentifier.set(feature.issue.identifier, feature);
    }
  }

  const edges: DispatchEdge[] = [];
  const supersededNativeHardBlockers: ComputedDispatchOrderSupersededNativeHardBlocker[] =
    [];
  const warnings: string[] = [];
  for (const issue of input.issues) {
    const feature =
      featureByIssueId.get(issue.id) ??
      (ambiguousFeatureIdentifiers.has(issue.identifier)
        ? undefined
        : featureByIdentifier.get(issue.identifier));
    if (feature === undefined) {
      if (issue.blockedByRelationTruncated === true) {
        const reason =
          input.ticketFeatures === undefined
            ? "Native blockedBy relation window was truncated before TicketFeature hard-blocker trust was available; treating candidate as possibly blocked."
            : "Native blockedBy relation window was truncated and this candidate was missing from TicketFeature extraction; treating candidate as possibly blocked.";
        edges.push({
          issue,
          blocker: {
            id: null,
            identifier: null,
            state: null,
          },
          trust: "legacy_hard",
          source: "issue_blocked_by",
          reason,
        });
        warnings.push(
          `Dispatch comparator detected truncated native blockedBy relation window for ${issue.identifier}; held candidate as possibly blocked.`,
        );
      }
      for (const blocker of issue.blockedBy) {
        edges.push({
          issue,
          blocker,
          trust: "legacy_hard",
          source: "issue_blocked_by",
          reason:
            input.ticketFeatures === undefined
              ? "TicketFeature trust unavailable; preserving current blockedBy eligibility semantics."
              : "Candidate missing from TicketFeature extraction; preserving current blockedBy eligibility semantics.",
        });
      }
      continue;
    }

    if (feature.sourceVisibility.relationPageTruncated === true) {
      edges.push({
        issue,
        blocker: {
          id: null,
          identifier: null,
          state: null,
        },
        trust: "legacy_hard",
        source: "ticket_feature",
        reason:
          "TicketFeature blockedBy relation page was truncated; treating candidate as possibly blocked.",
      });
      warnings.push(
        `Dispatch comparator detected truncated TicketFeature blockedBy relation page for ${issue.identifier}; held candidate as possibly blocked.`,
      );
    }

    for (const edge of feature.specLineage.blockedBy) {
      edges.push({
        issue,
        blocker: {
          id: edge.issue.id,
          identifier: edge.issue.identifier,
          state: edge.issue.state,
        },
        trust: edge.trust,
        source: "ticket_feature",
        reason:
          edge.trust === "operator_confirmed"
            ? "Operator-confirmed blocked-by edge."
            : `Advisory blocked-by edge (${edge.advisoryReason ?? "untrusted_author"}).`,
      });
    }

    for (const blocker of issue.blockedBy) {
      const supersedingEdge = feature.specLineage.blockedBy.find(
        (edge) =>
          ticketFeatureEdgeSupersedesNativeBlocker(edge) &&
          refsMatch(edge.issue, blocker),
      );
      if (supersedingEdge === undefined) {
        edges.push({
          issue,
          blocker,
          trust: "legacy_hard",
          source: "issue_blocked_by",
          reason:
            "Candidate blockedBy edge missing from TicketFeature extraction; preserving legacy hard-block behavior.",
        });
      } else if (supersedingEdge.trust === "advisory") {
        const blockerIssue = findIssueByRef(
          blocker,
          issueById,
          issueByIdentifier,
        );
        if (blockerIssue?.id !== issue.id) {
          supersededNativeHardBlockers.push({
            issue_id: issue.id,
            issue_identifier: issue.identifier,
            blocker_issue_id: blocker.id,
            blocker_issue_identifier: blocker.identifier,
            blocker_state: blocker.state,
            superseding_edge_trust: supersedingEdge.trust,
            advisory_reason: supersedingEdge.advisoryReason,
            reason: `Native blockedBy hard edge superseded by trusted automation advisory edge (${supersedingEdge.advisoryReason ?? "unknown"}).`,
          });
        }
      }
    }
  }

  return {
    edges: edges.filter(
      (edge) =>
        edge.issue.id !==
        findIssueByRef(edge.blocker, issueById, issueByIdentifier)?.id,
    ),
    supersededNativeHardBlockers,
    warnings,
  };
}

function ticketFeatureEdgeSupersedesNativeBlocker(
  edge: TicketFeature["specLineage"]["blockedBy"][number],
): boolean {
  return (
    edge.trust === "operator_confirmed" ||
    edge.advisoryReason === "service_account" ||
    edge.advisoryReason === "bot_actor"
  );
}

function isHardEdge(edge: DispatchEdge): edge is HardDispatchEdge {
  return edge.trust !== "advisory";
}

function toExclusion(edge: HardDispatchEdge): ComputedDispatchOrderExclusion {
  return {
    issue_id: edge.issue.id,
    issue_identifier: edge.issue.identifier,
    blocker_issue_id: edge.blocker.id,
    blocker_issue_identifier: edge.blocker.identifier,
    blocker_state: edge.blocker.state,
    edge_trust: edge.trust,
    source: edge.source,
    reason: edge.reason,
  };
}

function toAdvisoryWarning(
  edge: DispatchEdge,
): ComputedDispatchOrderAdvisoryWarning {
  return {
    issue_id: edge.issue.id,
    issue_identifier: edge.issue.identifier,
    blocker_issue_id: edge.blocker.id,
    blocker_issue_identifier: edge.blocker.identifier,
    blocker_state: edge.blocker.state,
    reason: edge.reason,
  };
}

function buildAdvisoryWarnings(
  edges: readonly DispatchEdge[],
  issueById: ReadonlyMap<string, Issue>,
  issueByIdentifier: IssueIdentifierIndex,
  terminalStates: ReadonlySet<string>,
  hardExclusionPairs: ReadonlySet<string>,
): ComputedDispatchOrderAdvisoryWarning[] {
  const warnings = edges
    .filter(
      (edge) =>
        edge.trust === "advisory" &&
        isOpenBlocker(edge.blocker, terminalStates) &&
        !hasDependencyPairKey(hardExclusionPairs, edge.issue, edge.blocker),
    )
    .map((edge) => {
      const blockerIssue = findIssueByRef(
        edge.blocker,
        issueById,
        issueByIdentifier,
      );
      return {
        ...toAdvisoryWarning(edge),
        reason:
          blockerIssue === null
            ? edge.reason
            : `${edge.reason} Advisory edge observed inside the candidate frontier.`,
      };
    });
  return dedupeAdvisoryWarnings(warnings);
}

function buildExclusionPairKeys(
  exclusions: readonly ComputedDispatchOrderExclusion[],
): Set<string> {
  const keys = new Set<string>();
  for (const exclusion of exclusions) {
    addDependencyPairKeys(keys, {
      issue: {
        id: exclusion.issue_id,
        identifier: exclusion.issue_identifier,
      },
      blocker: {
        id: exclusion.blocker_issue_id,
        identifier: exclusion.blocker_issue_identifier,
      },
    });
  }
  return keys;
}

function hasDependencyPairKey(
  keys: ReadonlySet<string>,
  issue: Pick<Issue, "id" | "identifier">,
  blocker: Pick<BlockerRef, "id" | "identifier">,
): boolean {
  return dependencyPairKeys({ issue, blocker }).some((key) => keys.has(key));
}

function addDependencyPairKeys(
  keys: Set<string>,
  input: {
    issue: Pick<Issue, "id" | "identifier">;
    blocker: Pick<BlockerRef, "id" | "identifier">;
  },
): void {
  for (const key of dependencyPairKeys(input)) {
    keys.add(key);
  }
}

function dependencyPairKeys(input: {
  issue: Pick<Issue, "id" | "identifier">;
  blocker: Pick<BlockerRef, "id" | "identifier">;
}): string[] {
  const issueKeys = refIdentityKeys(input.issue);
  const blockerKeys = refIdentityKeys(input.blocker);
  return issueKeys.flatMap((issueKey) =>
    blockerKeys.map((blockerKey) => `${issueKey}->${blockerKey}`),
  );
}

function refIdentityKeys(ref: {
  id: string | null;
  identifier: string | null;
}): string[] {
  return [
    ...(ref.id === null ? [] : [`id:${ref.id}`]),
    ...(ref.identifier === null
      ? []
      : [`identifier:${normalizeIssueIdentifier(ref.identifier)}`]),
  ];
}

function dedupeAdvisoryWarnings(
  warnings: readonly ComputedDispatchOrderAdvisoryWarning[],
): ComputedDispatchOrderAdvisoryWarning[] {
  const seen = new Set<string>();
  const deduped: ComputedDispatchOrderAdvisoryWarning[] = [];
  for (const warning of warnings) {
    const key = [
      warning.issue_id,
      warning.blocker_issue_id,
      warning.blocker_issue_identifier,
      warning.reason,
    ].join(":");
    if (!seen.has(key)) {
      seen.add(key);
      deduped.push(warning);
    }
  }
  return deduped;
}

function topologicallySortIssues(
  issues: readonly Issue[],
  hardOrderingEdges: readonly HardDispatchEdge[],
  issueById: ReadonlyMap<string, Issue>,
  issueByIdentifier: IssueIdentifierIndex,
): { ordered: Issue[]; warnings: string[] } {
  const orderedIds = new Set(issues.map((issue) => issue.id));
  const indegree = new Map(issues.map((issue) => [issue.id, 0]));
  const outgoing = new Map<string, string[]>();
  for (const edge of hardOrderingEdges) {
    const blockerIssue = findIssueByRef(
      edge.blocker,
      issueById,
      issueByIdentifier,
    );
    if (blockerIssue === null || !orderedIds.has(blockerIssue.id)) {
      continue;
    }
    outgoing.set(blockerIssue.id, [
      ...(outgoing.get(blockerIssue.id) ?? []),
      edge.issue.id,
    ]);
    indegree.set(edge.issue.id, (indegree.get(edge.issue.id) ?? 0) + 1);
  }

  const issueByIdInOrder = new Map(issues.map((issue) => [issue.id, issue]));
  const ready = issues.filter((issue) => (indegree.get(issue.id) ?? 0) === 0);
  const result: Issue[] = [];
  while (ready.length > 0) {
    ready.sort(compareIssuesForDispatch);
    const issue = ready.shift();
    if (issue === undefined) {
      break;
    }
    result.push(issue);
    for (const dependentId of outgoing.get(issue.id) ?? []) {
      const nextIndegree = (indegree.get(dependentId) ?? 0) - 1;
      indegree.set(dependentId, nextIndegree);
      if (nextIndegree === 0) {
        const dependent = issueByIdInOrder.get(dependentId);
        if (dependent !== undefined) {
          ready.push(dependent);
        }
      }
    }
  }
  if (result.length === issues.length) {
    return { ordered: result, warnings: [] };
  }
  return {
    ordered: [...issues],
    warnings: [
      `Dispatch comparator could not linearize ${issues.length - result.length} candidate(s) after hard-cycle detection; preserved natural priority/FIFO order.`,
    ],
  };
}

function findHardCycles(
  issues: readonly Issue[],
  hardOrderingEdges: readonly HardDispatchEdge[],
  issueById: ReadonlyMap<string, Issue>,
  issueByIdentifier: IssueIdentifierIndex,
): HardCycleDiagnostics {
  const issueIds = new Set(issues.map((issue) => issue.id));
  const outgoing = new Map<string, string[]>();
  for (const edge of hardOrderingEdges) {
    const blockerIssue = findIssueByRef(
      edge.blocker,
      issueById,
      issueByIdentifier,
    );
    if (blockerIssue !== null && issueIds.has(blockerIssue.id)) {
      outgoing.set(blockerIssue.id, [
        ...(outgoing.get(blockerIssue.id) ?? []),
        edge.issue.id,
      ]);
    }
  }

  const issueByIdLocal = new Map(issues.map((issue) => [issue.id, issue]));
  // Report a bounded disjoint-cycle sample: once a cycle is represented, any
  // overlapping cycle that shares one of its issues is covered by that sample.
  const reportedCycleIssueIds = new Set<string>();
  const cycles: ComputedDispatchOrderCycle[] = [];
  let omittedCount = 0;

  const findCycle = (startIssueId: string): string[] | null => {
    const visiting = new Set<string>();
    const visited = new Set<string>();
    const stack: string[] = [];

    const visit = (issueId: string): string[] | null => {
      if (reportedCycleIssueIds.has(issueId)) {
        return null;
      }
      if (visiting.has(issueId)) {
        const start = stack.indexOf(issueId);
        return start === -1 ? [issueId] : stack.slice(start);
      }
      if (visited.has(issueId)) {
        return null;
      }
      visiting.add(issueId);
      stack.push(issueId);
      for (const nextId of outgoing.get(issueId) ?? []) {
        if (reportedCycleIssueIds.has(nextId)) {
          continue;
        }
        const cycle = visit(nextId);
        if (cycle !== null) {
          return cycle;
        }
      }
      stack.pop();
      visiting.delete(issueId);
      visited.add(issueId);
      return null;
    };

    return visit(startIssueId);
  };

  for (const issue of issues) {
    if (reportedCycleIssueIds.has(issue.id)) {
      continue;
    }
    const cycle = findCycle(issue.id);
    if (cycle === null) {
      continue;
    }
    for (const cycleIssueId of cycle) {
      reportedCycleIssueIds.add(cycleIssueId);
    }
    if (cycles.length >= HARD_CYCLE_DIAGNOSTIC_LIMIT) {
      omittedCount += 1;
      continue;
    }
    const cycleSet = new Set(cycle);
    const cycleEdges = hardOrderingEdges.filter((edge) => {
      const blockerIssue = findIssueByRef(
        edge.blocker,
        issueById,
        issueByIdentifier,
      );
      return (
        cycleSet.has(edge.issue.id) &&
        blockerIssue !== null &&
        cycleSet.has(blockerIssue.id)
      );
    });
    const edgeTrust = cycleEdges.some(
      (edge) => edge.trust === "operator_confirmed",
    )
      ? "operator_confirmed"
      : "legacy_hard";
    cycles.push({
      issue_ids: cycle,
      issue_identifiers: cycle.map(
        (issueId) => issueByIdLocal.get(issueId)?.identifier ?? issueId,
      ),
      edge_trust: edgeTrust,
      reason:
        edgeTrust === "operator_confirmed"
          ? "Operator-confirmed hard blocked-by edges form a cycle; dispatch comparator refused linearization."
          : "Legacy hard blocked-by edges form a cycle; dispatch comparator refused linearization.",
    });
  }

  return { cycles, omittedCount };
}

function applyAnchors(
  issues: readonly Issue[],
  anchors: Readonly<Record<string, IssueAnchorRecord>>,
  completedIssueIds: ReadonlySet<string>,
  now: Date,
): { ordered: Issue[]; warnings: string[] } {
  const ordered = [...issues];
  const warnings: string[] = [];
  const issueIds = new Set(ordered.map((issue) => issue.id));
  const activeAnchors = Object.values(anchors)
    .filter(
      (anchor) =>
        issueIds.has(anchor.issueId) &&
        !isIssueAnchorExpired(anchor, { completedIssueIds, now }),
    )
    .sort((left, right) => {
      const priorityDelta =
        (left.setBySequence ?? Number.MAX_SAFE_INTEGER) -
        (right.setBySequence ?? Number.MAX_SAFE_INTEGER);
      if (priorityDelta !== 0) {
        return priorityDelta;
      }
      return left.issueIdentifier.localeCompare(right.issueIdentifier, "en");
    });

  for (const anchor of activeAnchors) {
    const currentIndex = ordered.findIndex(
      (issue) => issue.id === anchor.issueId,
    );
    if (currentIndex === -1) {
      continue;
    }
    const [anchored] = ordered.splice(currentIndex, 1);
    if (anchored === undefined) {
      continue;
    }
    const placement = anchor.placement;
    const placementValidation = validateAnchorPlacementForIssue(
      placement,
      anchored.identifier,
    );
    if (!placementValidation.valid) {
      ordered.splice(Math.min(currentIndex, ordered.length), 0, anchored);
      const invalidTarget = placementValidation.placement.issueIdentifier;
      warnings.push(
        `Operator anchor for ${anchor.issueIdentifier} references invalid target ${invalidTarget}: ${formatInvalidAnchorPlacementDetail(placementValidation.placement, anchored.identifier, placementValidation.reason)}; preserved natural priority/FIFO position.`,
      );
      continue;
    }
    if (placement.kind === "top") {
      const firstSamePriority = ordered.findIndex(
        (issue) => issue.priority === anchored.priority,
      );
      const firstWorsePriority = ordered.findIndex(
        (issue) =>
          toSortablePriority(issue.priority) >
          toSortablePriority(anchored.priority),
      );
      const priorityBandStart =
        firstWorsePriority === -1 ? ordered.length : firstWorsePriority;
      ordered.splice(
        firstSamePriority === -1 ? priorityBandStart : firstSamePriority,
        0,
        anchored,
      );
      continue;
    }
    const targetIndex = ordered.findIndex(
      (issue) =>
        normalizeIssueIdentifier(issue.identifier) ===
        normalizeIssueIdentifier(placement.issueIdentifier),
    );
    if (targetIndex === -1) {
      ordered.splice(Math.min(currentIndex, ordered.length), 0, anchored);
      warnings.push(
        `Operator anchor for ${anchor.issueIdentifier} references unavailable target ${placement.issueIdentifier}; preserved natural priority/FIFO position.`,
      );
      continue;
    }
    ordered.splice(
      placement.kind === "above" ? targetIndex : targetIndex + 1,
      0,
      anchored,
    );
  }

  return { ordered, warnings };
}

function buildRationale(
  issue: Issue,
  baseOrder: readonly Issue[],
  anchors: Readonly<Record<string, IssueAnchorRecord>>,
  hardEdges: readonly HardDispatchEdge[],
): string[] {
  const rationale = [
    `priority ${issue.priority ?? "none"}`,
    `fifo ${issue.createdAt ?? "unknown"}`,
  ];
  const baseIndex = baseOrder.findIndex(
    (candidate) => candidate.id === issue.id,
  );
  if (baseIndex !== -1) {
    rationale.push(`base_order ${baseIndex + 1}`);
  }
  const anchor = anchors[issue.id];
  if (anchor !== undefined) {
    rationale.push(
      anchor.placement.kind === "top"
        ? "operator_anchor top"
        : `operator_anchor ${anchor.placement.kind} ${anchor.placement.issueIdentifier}`,
    );
  }
  const blockerEdges = hardEdges.filter((edge) => edge.issue.id === issue.id);
  if (blockerEdges.length > 0) {
    rationale.push(
      `hard_edges ${blockerEdges
        .map((edge) => edge.blocker.identifier ?? edge.blocker.id ?? "unknown")
        .join(",")}`,
    );
  }
  return rationale;
}

function isOpenBlocker(
  blocker: BlockerRef,
  terminalStates: ReadonlySet<string>,
): boolean {
  const state =
    blocker.state === null ? null : normalizeIssueState(blocker.state);
  return state === null || !terminalStates.has(state);
}

function findIssueByRef(
  ref: BlockerRef,
  issueById: ReadonlyMap<string, Issue>,
  issueByIdentifier: IssueIdentifierIndex,
): Issue | null {
  if (ref.id !== null) {
    const byId = issueById.get(ref.id);
    if (byId !== undefined) {
      return byId;
    }
  }
  if (ref.identifier !== null) {
    if (issueByIdentifier.ambiguousIdentifiers.has(ref.identifier)) {
      return null;
    }
    const byIdentifier = issueByIdentifier.byIdentifier.get(ref.identifier);
    if (byIdentifier !== undefined) {
      return byIdentifier;
    }
  }
  return null;
}

function buildIssueIdentifierIndex(
  issues: readonly Issue[],
): IssueIdentifierIndex {
  const byIdentifier = new Map<string, Issue>();
  const ambiguousIdentifiers = new Set<string>();
  for (const issue of issues) {
    const existing = byIdentifier.get(issue.identifier);
    if (existing === undefined) {
      if (!ambiguousIdentifiers.has(issue.identifier)) {
        byIdentifier.set(issue.identifier, issue);
      }
      continue;
    }
    if (existing.id !== issue.id) {
      byIdentifier.delete(issue.identifier);
      ambiguousIdentifiers.add(issue.identifier);
    }
  }
  return { byIdentifier, ambiguousIdentifiers };
}

function buildIssueIdentifierCollisionWarnings(
  issueByIdentifier: IssueIdentifierIndex,
): string[] {
  return [...issueByIdentifier.ambiguousIdentifiers]
    .sort((left, right) => left.localeCompare(right, "en"))
    .map(
      (identifier) =>
        `Dispatch comparator observed duplicate candidate identifier ${identifier}; identifier-only dependency refs for that identifier are ignored to avoid nondeterministic ordering.`,
    );
}

function refsMatch(
  left: { id?: string | null; identifier?: string | null },
  right: { id?: string | null; identifier?: string | null },
): boolean {
  return (
    refValueMatches(left.id, right.id) ||
    refValueMatches(left.identifier, right.identifier)
  );
}

function refValueMatches(
  left: string | null | undefined,
  right: string | null | undefined,
): boolean {
  return (
    typeof left === "string" &&
    left.trim() !== "" &&
    typeof right === "string" &&
    right.trim() !== "" &&
    left === right
  );
}

function compareIssuesForDispatch(left: Issue, right: Issue): number {
  const priorityDelta =
    toSortablePriority(left.priority) - toSortablePriority(right.priority);
  if (priorityDelta !== 0) {
    return priorityDelta;
  }

  const createdAtDelta =
    toSortableDate(left.createdAt) - toSortableDate(right.createdAt);
  if (createdAtDelta !== 0) {
    return createdAtDelta;
  }

  return left.identifier.localeCompare(right.identifier, "en");
}

function toSortablePriority(priority: number | null): number {
  return priority === null ? Number.POSITIVE_INFINITY : priority;
}

function toSortableDate(timestamp: string | null): number {
  if (timestamp === null) {
    return Number.POSITIVE_INFINITY;
  }

  const parsed = Date.parse(timestamp);
  return Number.isFinite(parsed) ? parsed : Number.POSITIVE_INFINITY;
}
