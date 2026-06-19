import {
  DEFAULT_LINEAR_NETWORK_TIMEOUT_MS,
  DEFAULT_LINEAR_PAGE_SIZE,
} from "../config/defaults.js";
import type { Issue } from "../domain/model.js";
import { ERROR_CODES } from "../errors/codes.js";
import { TrackerError, toTrackerRequestError } from "./errors.js";
import {
  normalizeLinearIssue,
  normalizeLinearIssueState,
} from "./linear-normalize.js";
import {
  LINEAR_CANDIDATE_ISSUES_BY_TEAMS_QUERY,
  LINEAR_CANDIDATE_ISSUES_QUERY,
  LINEAR_CREATE_COMMENT_MUTATION,
  LINEAR_CREATE_ISSUE_MUTATION,
  LINEAR_CREATE_ISSUE_WITH_STATE_MUTATION,
  LINEAR_CREATE_TRACK_FINDING_ISSUE_MUTATION,
  LINEAR_ISSUES_BY_LABELS_QUERY,
  LINEAR_ISSUES_BY_STATES_QUERY,
  LINEAR_ISSUE_BY_IDENTIFIER_QUERY,
  LINEAR_ISSUE_COMMENTS_QUERY,
  LINEAR_ISSUE_DETAILS_BY_IDS_QUERY,
  LINEAR_ISSUE_DETAILS_UPDATE_MUTATION,
  LINEAR_ISSUE_LABELS_BY_NAMES_QUERY,
  LINEAR_ISSUE_PARENT_AND_SIBLINGS_QUERY,
  LINEAR_ISSUE_PARENT_DETAIL_QUERY,
  LINEAR_ISSUE_STATES_BY_IDS_QUERY,
  LINEAR_ISSUE_STATE_TRANSITIONS_QUERY,
  LINEAR_ISSUE_UPDATE_MUTATION,
  LINEAR_OPEN_ISSUES_BY_LABELS_QUERY,
  LINEAR_OPEN_ISSUES_BY_TITLE_QUERY,
  LINEAR_SEARCH_ISSUES_BY_TITLE_AND_TEAM_QUERY,
  LINEAR_SEARCH_ISSUES_BY_TITLE_MARKER_AND_TEAM_QUERY,
  LINEAR_TICKET_FEATURE_ISSUES_QUERY,
  LINEAR_UPDATE_ISSUE_DESCRIPTION_MUTATION,
  LINEAR_WORKFLOW_STATES_QUERY,
} from "./linear-queries.js";
import {
  type TicketFeatureActor,
  type TicketFeatureSourceIssue,
  normalizeBotActor,
  normalizeLinearTicketFeatureIssue,
  normalizeUserActor,
} from "./ticket-feature.js";
import type { IssueStateSnapshot, IssueTracker } from "./tracker.js";

interface LinearGraphqlPageInfo {
  hasNextPage?: unknown;
  endCursor?: unknown;
}

interface LinearGraphqlConnection<TNode> {
  nodes?: unknown;
  pageInfo?: LinearGraphqlPageInfo | null;
}

interface LinearGraphqlResponse<TData> {
  data?: TData;
  errors?: unknown;
}

export interface LinearRawGraphqlResponse {
  status: number;
  body: unknown;
}

export interface LinearIssueReference {
  id: string;
  identifier: string;
  title: string;
  description: string | null;
  url: string | null;
  teamId: string | null;
  teamKey: string | null;
  projectId: string | null;
  projectSlug: string | null;
  labels: string[];
  parent: {
    id: string;
    identifier: string;
    title: string;
    url: string | null;
  } | null;
}

interface LinearCandidateData {
  issues?: LinearGraphqlConnection<unknown>;
}

const TICKET_FEATURE_NESTED_CONNECTION_FIRST = 250;

type LinearStatesData = LinearCandidateData;

interface LinearIssueStatesData {
  issues?: {
    nodes?: unknown;
  };
}

interface LinearIssueByIdentifierData {
  issue?: unknown | null;
}

interface LinearIssueUpdateData {
  issueUpdate?: {
    success?: boolean;
    issue?: { id?: string; state?: { name?: string } };
  };
}

interface LinearIssueStateTransitionsData {
  issue?: {
    history?: {
      nodes?: Array<{
        createdAt?: string;
        toState?: { name?: string } | null;
      }>;
    };
  } | null;
}

interface LinearCommentCreateData {
  commentCreate?: {
    success?: boolean;
    comment?: { id?: string };
  };
}

interface LinearIssueCommentsData {
  issue?: {
    id?: string;
    comments?: LinearGraphqlConnection<unknown>;
  } | null;
}

export interface LinearIssueComment {
  id: string;
  body: string;
  createdAt: string;
  updatedAt: string;
  user: TicketFeatureActor | null;
  botActor: TicketFeatureActor | null;
}

interface LinearIssueCreateData {
  issueCreate?: {
    success?: boolean;
    issue?: {
      id?: string;
      identifier?: string;
      title?: string;
      state?: { name?: string };
    };
  };
}

interface LinearTrackFindingCreateData {
  issueCreate?: {
    success?: boolean;
    issue?: {
      id?: string;
      identifier?: string;
      title?: string;
      url?: string | null;
      state?: { name?: string };
    };
  };
}

interface LinearSearchIssuesByTitleMarkerData {
  issues?: {
    nodes?: Array<{
      id?: string;
      identifier?: string;
      title?: string;
      url?: string | null;
      state?: { name?: string; type?: string } | null;
    }>;
  };
}

interface LinearSearchIssuesByTitleData {
  issues?: {
    nodes?: Array<{
      id?: string;
      identifier?: string;
      title?: string;
      description?: string | null;
      state?: { name?: string; type?: string } | null;
    }>;
  };
}

interface LinearIssueDetailsNode {
  id?: string;
  identifier?: string;
  title?: string;
  description?: string | null;
  url?: string | null;
  team?: {
    id?: string;
    key?: string | null;
  } | null;
  project?: {
    id?: string;
    slugId?: string | null;
  } | null;
  labels?: {
    nodes?: Array<{ name?: string | null }>;
  } | null;
  parent?: {
    id?: string;
    identifier?: string;
    title?: string;
    url?: string | null;
  } | null;
}

interface LinearIssueDetailsData {
  issues?: {
    nodes?: unknown;
  };
}

interface LinearIssueLabelData {
  issueLabels?: {
    nodes?: unknown;
  };
}

interface LinearIssueDetailsUpdateData {
  issueUpdate?: {
    success?: boolean;
    issue?: { id?: string; identifier?: string; title?: string };
  };
}

interface LinearIssueParentAndSiblingsData {
  issue?: {
    id?: string;
    identifier?: string;
    parent?: {
      id?: string;
      identifier?: string;
      state?: { name?: string };
      children?: {
        nodes?: Array<{
          id?: string;
          identifier?: string;
          state?: { name?: string };
        }>;
      };
    } | null;
  };
}

interface LinearIssueParentDetailData {
  issue?: {
    id?: string;
    identifier?: string;
    parent?: {
      identifier?: string;
      title?: string;
      url?: string;
    } | null;
  };
}

/** Sentinel value used to cache null parent lookups. */
const NULL_PARENT_SENTINEL = Symbol("null-parent");

interface LinearWorkflowStatesData {
  workflowStates?: {
    nodes?: Array<{ id?: string; name?: string }>;
  };
}

export interface LinearTrackerClientOptions {
  endpoint: string;
  apiKey: string | null;
  projectSlug: string | null;
  activeStates: string[];
  /**
   * Team keys that scope the dispatch candidate source (SYMPH-794 / SYMPH-819).
   * When non-empty, `fetchCandidateIssues` reads the team's eligible backlog
   * instead of `project` membership, so a bare `project` field no longer arms
   * dispatch. A list ⇒ multi-team-ready. Empty ⇒ the legacy project-scoped
   * source (backward-compatible default for every other product).
   */
  teamKeys?: string[];
  pageSize?: number;
  networkTimeoutMs?: number;
  fetchFn?: typeof fetch;
}

export class LinearTrackerClient implements IssueTracker {
  private readonly endpoint: string;
  private readonly apiKey: string | null;
  private readonly projectSlug: string | null;
  private readonly teamKeys: string[];
  private readonly activeStates: string[];
  private readonly pageSize: number;
  private readonly networkTimeoutMs: number;
  private readonly fetchFn: typeof fetch;
  private readonly parentCache = new Map<
    string,
    | { identifier: string; title: string; url: string }
    | typeof NULL_PARENT_SENTINEL
  >();

  constructor(options: LinearTrackerClientOptions) {
    this.endpoint = options.endpoint;
    this.apiKey = options.apiKey;
    this.projectSlug = options.projectSlug;
    this.teamKeys = [...(options.teamKeys ?? [])];
    this.activeStates = [...options.activeStates];
    this.pageSize = options.pageSize ?? DEFAULT_LINEAR_PAGE_SIZE;
    this.networkTimeoutMs =
      options.networkTimeoutMs ?? DEFAULT_LINEAR_NETWORK_TIMEOUT_MS;
    this.fetchFn = options.fetchFn ?? globalThis.fetch;
  }

  async fetchCandidateIssues(): Promise<Issue[]> {
    // Team-scoped backlog is the dispatch trigger when configured (SYMPH-794):
    // a bare `project` field no longer admits, and no project slug is required.
    if (this.teamKeys.length > 0) {
      return this.fetchIssuePages(LINEAR_CANDIDATE_ISSUES_BY_TEAMS_QUERY, {
        teamKeys: this.teamKeys,
        activeStates: this.activeStates,
        first: this.pageSize,
        relationFirst: this.pageSize,
      });
    }
    return this.fetchIssuePages(LINEAR_CANDIDATE_ISSUES_QUERY, {
      projectSlug: this.requireProjectSlug(),
      activeStates: this.activeStates,
      first: this.pageSize,
      relationFirst: this.pageSize,
    });
  }

  async fetchIssuesByStates(stateNames: string[]): Promise<Issue[]> {
    if (stateNames.length === 0) {
      return [];
    }

    return this.fetchIssuePages(LINEAR_ISSUES_BY_STATES_QUERY, {
      projectSlug: this.requireProjectSlug(),
      stateNames,
      first: this.pageSize,
      relationFirst: this.pageSize,
    });
  }

  async fetchIssueByIdentifier(identifier: string): Promise<Issue | null> {
    const response = await this.postGraphql<LinearIssueByIdentifierData>(
      LINEAR_ISSUE_BY_IDENTIFIER_QUERY,
      {
        identifier,
        relationFirst: this.pageSize,
      },
    );

    if (response.issue === null || response.issue === undefined) {
      return null;
    }

    assertIssueLabelsResolved(response.issue, identifier);
    return normalizeLinearIssue(response.issue);
  }

  async fetchTicketFeatureIssuesByStates(
    stateNames: string[],
  ): Promise<TicketFeatureSourceIssue[]> {
    if (stateNames.length === 0) {
      return [];
    }

    return this.fetchTicketFeatureIssuePages(
      LINEAR_TICKET_FEATURE_ISSUES_QUERY,
      {
        projectSlug: this.requireProjectSlug(),
        stateNames,
        first: this.pageSize,
        relationFirst: TICKET_FEATURE_NESTED_CONNECTION_FIRST,
        historyFirst: TICKET_FEATURE_NESTED_CONNECTION_FIRST,
      },
    );
  }

  async fetchIssuesByLabels(labelNames: string[]): Promise<Issue[]> {
    if (labelNames.length === 0) {
      return [];
    }

    return this.fetchIssuePages(LINEAR_ISSUES_BY_LABELS_QUERY, {
      projectSlug: this.requireProjectSlug(),
      labelNames,
      first: this.pageSize,
      relationFirst: this.pageSize,
    });
  }

  async fetchOpenIssuesByLabels(
    labelNames: string[],
    excludeStateNames: string[],
  ): Promise<Issue[]> {
    if (labelNames.length === 0) {
      return [];
    }

    // Single GraphQL call — we only need to know if any non-terminal halt issue
    // exists, so fetch at most 1 result. No pagination needed.
    const response = await this.postGraphql<LinearCandidateData>(
      LINEAR_OPEN_ISSUES_BY_LABELS_QUERY,
      {
        projectSlug: this.requireProjectSlug(),
        labelNames,
        excludeStateNames,
        first: 1,
        relationFirst: this.pageSize,
      },
    );

    const nodes = response.issues?.nodes;
    if (!Array.isArray(nodes)) {
      throw new TrackerError(
        ERROR_CODES.linearUnknownPayload,
        "Linear open issues by labels payload was missing issues.nodes.",
        { details: response },
      );
    }

    return nodes.map((node) => normalizeLinearIssue(node));
  }

  async fetchIssueStatesByIds(
    issueIds: string[],
  ): Promise<IssueStateSnapshot[]> {
    if (issueIds.length === 0) {
      return [];
    }

    const response = await this.postGraphql<LinearIssueStatesData>(
      LINEAR_ISSUE_STATES_BY_IDS_QUERY,
      {
        issueIds,
      },
    );

    const nodes = response.issues?.nodes;
    if (!Array.isArray(nodes)) {
      throw new TrackerError(
        ERROR_CODES.linearUnknownPayload,
        "Linear issue states payload was missing issues.nodes.",
        { details: response },
      );
    }

    return nodes.map((node) => normalizeLinearIssueState(node));
  }

  async fetchLatestStateTransitionAt(
    issueId: string,
    stateName: string,
  ): Promise<string | null> {
    const response = await this.postGraphql<LinearIssueStateTransitionsData>(
      LINEAR_ISSUE_STATE_TRANSITIONS_QUERY,
      { issueId },
    );

    const nodes = response.issue?.history?.nodes;
    if (!Array.isArray(nodes)) {
      return null;
    }

    const wanted = stateName.trim().toLowerCase();
    let latest: string | null = null;
    for (const node of nodes) {
      const toState = node?.toState?.name;
      const createdAt = node?.createdAt;
      if (
        typeof toState !== "string" ||
        typeof createdAt !== "string" ||
        toState.trim().toLowerCase() !== wanted ||
        Number.isNaN(Date.parse(createdAt))
      ) {
        continue;
      }
      if (latest === null || Date.parse(createdAt) > Date.parse(latest)) {
        latest = createdAt;
      }
    }
    return latest;
  }

  async postComment(issueId: string, body: string): Promise<void> {
    const response = await this.postGraphql<LinearCommentCreateData>(
      LINEAR_CREATE_COMMENT_MUTATION,
      { issueId, body },
    );

    if (response.commentCreate?.success !== true) {
      throw new TrackerError(
        ERROR_CODES.linearGraphqlErrors,
        "Linear commentCreate mutation did not return success.",
        { details: response },
      );
    }
  }

  async fetchIssueComments(
    issueId: string,
    options: { maxPages?: number } = {},
  ): Promise<LinearIssueComment[]> {
    const maxPages = options.maxPages ?? 10;
    if (!Number.isInteger(maxPages) || maxPages <= 0) {
      throw new TrackerError(
        ERROR_CODES.linearUnknownPayload,
        "Linear issue comments maxPages must be a positive integer.",
        { details: { maxPages } },
      );
    }

    const comments: LinearIssueComment[] = [];
    let after: string | null = null;
    let pageCount = 0;

    while (true) {
      pageCount += 1;
      const response: LinearIssueCommentsData =
        await this.postGraphql<LinearIssueCommentsData>(
          LINEAR_ISSUE_COMMENTS_QUERY,
          {
            issueId,
            first: this.pageSize,
            after,
          },
        );

      const connection: LinearGraphqlConnection<unknown> | undefined =
        response.issue?.comments;
      if (!connection || typeof connection !== "object") {
        throw new TrackerError(
          ERROR_CODES.linearUnknownPayload,
          "Linear issue comments payload was missing issue.comments.",
          { details: response },
        );
      }

      const nodes = connection.nodes;
      if (!Array.isArray(nodes)) {
        throw new TrackerError(
          ERROR_CODES.linearUnknownPayload,
          "Linear issue comments payload was missing comments.nodes.",
          { details: response },
        );
      }

      comments.push(...nodes.map((node) => normalizeLinearIssueComment(node)));

      const pageInfo: LinearGraphqlPageInfo | null | undefined =
        connection.pageInfo;
      if (!pageInfo || typeof pageInfo !== "object") {
        throw new TrackerError(
          ERROR_CODES.linearUnknownPayload,
          "Linear issue comments payload was missing pageInfo.",
          { details: response },
        );
      }

      if (pageInfo.hasNextPage !== true) {
        break;
      }

      if (pageCount >= maxPages) {
        throw new TrackerError(
          ERROR_CODES.linearUnknownPayload,
          "Linear issue comments exceeded maxPages.",
          { details: { issueId, maxPages, pageCount } },
        );
      }

      if (typeof pageInfo.endCursor !== "string" || pageInfo.endCursor === "") {
        throw new TrackerError(
          ERROR_CODES.linearMissingEndCursor,
          "Linear issue comments pagination indicated more pages without an end cursor.",
          { details: response },
        );
      }

      after = pageInfo.endCursor;
    }

    return comments.sort(compareLinearIssueComments);
  }

  async updateIssueDescription(
    issueId: string,
    description: string,
  ): Promise<{ id: string; identifier: string; title: string }> {
    const response = await this.postGraphql<LinearIssueDetailsUpdateData>(
      LINEAR_UPDATE_ISSUE_DESCRIPTION_MUTATION,
      { issueId, description },
    );

    if (response.issueUpdate?.success !== true) {
      throw new TrackerError(
        ERROR_CODES.linearGraphqlErrors,
        "Linear issueUpdate(description) mutation did not return success.",
        { details: response },
      );
    }

    const issue = response.issueUpdate.issue;
    if (
      typeof issue?.id !== "string" ||
      typeof issue.identifier !== "string" ||
      typeof issue.title !== "string"
    ) {
      throw new TrackerError(
        ERROR_CODES.linearUnknownPayload,
        "Linear issueUpdate(description) returned incomplete issue data.",
        { details: response },
      );
    }

    return {
      id: issue.id,
      identifier: issue.identifier,
      title: issue.title,
    };
  }

  async createIssue(input: {
    teamId: string;
    title: string;
    projectId: string;
    labelIds: string[];
    description?: string;
    parentId?: string;
  }): Promise<{ id: string; identifier: string; title: string }> {
    const response = await this.postGraphql<LinearIssueCreateData>(
      LINEAR_CREATE_ISSUE_MUTATION,
      {
        teamId: input.teamId,
        title: input.title,
        projectId: input.projectId,
        labelIds: input.labelIds,
        ...(input.description !== undefined
          ? { description: input.description }
          : {}),
        ...(input.parentId !== undefined ? { parentId: input.parentId } : {}),
      },
    );

    if (response.issueCreate?.success !== true) {
      throw new TrackerError(
        ERROR_CODES.linearGraphqlErrors,
        "Linear issueCreate mutation did not return success.",
        { details: response },
      );
    }

    const issue = response.issueCreate.issue;
    if (
      typeof issue?.id !== "string" ||
      typeof issue.identifier !== "string" ||
      typeof issue.title !== "string"
    ) {
      throw new TrackerError(
        ERROR_CODES.linearUnknownPayload,
        "Linear issueCreate returned incomplete issue data.",
        { details: response },
      );
    }

    return {
      id: issue.id,
      identifier: issue.identifier,
      title: issue.title,
    };
  }

  async fetchIssueReferencesByIds(
    issueIds: string[],
  ): Promise<LinearIssueReference[]> {
    if (issueIds.length === 0) {
      return [];
    }

    const response = await this.postGraphql<LinearIssueDetailsData>(
      LINEAR_ISSUE_DETAILS_BY_IDS_QUERY,
      { issueIds },
    );
    const nodes = response.issues?.nodes;
    if (!Array.isArray(nodes)) {
      throw new TrackerError(
        ERROR_CODES.linearUnknownPayload,
        "Linear issue details payload was missing issues.nodes.",
        { details: response },
      );
    }

    return nodes.map((node) => normalizeLinearIssueReference(node));
  }

  async findOpenIssuesByTitle(input: {
    projectId: string;
    title: string;
    excludeStateNames: string[];
  }): Promise<LinearIssueReference[]> {
    const response = await this.postGraphql<LinearIssueDetailsData>(
      LINEAR_OPEN_ISSUES_BY_TITLE_QUERY,
      {
        projectId: input.projectId,
        title: input.title,
        excludeStateNames: input.excludeStateNames,
        first: this.pageSize,
      },
    );
    const nodes = response.issues?.nodes;
    if (!Array.isArray(nodes)) {
      throw new TrackerError(
        ERROR_CODES.linearUnknownPayload,
        "Linear open issues by title payload was missing issues.nodes.",
        { details: response },
      );
    }

    return nodes.map((node) => normalizeLinearIssueReference(node));
  }

  async resolveLabelIdsByNames(
    labelNames: string[],
    teamKey: string,
  ): Promise<Array<{ id: string; name: string }>> {
    if (labelNames.length === 0) {
      return [];
    }

    const response = await this.postGraphql<LinearIssueLabelData>(
      LINEAR_ISSUE_LABELS_BY_NAMES_QUERY,
      {
        teamKey,
        labelNames,
      },
    );
    const nodes = response.issueLabels?.nodes;
    if (!Array.isArray(nodes)) {
      throw new TrackerError(
        ERROR_CODES.linearUnknownPayload,
        "Linear issue labels payload was missing issueLabels.nodes.",
        { details: response },
      );
    }

    return nodes.flatMap((node) => {
      if (!node || typeof node !== "object" || Array.isArray(node)) {
        return [];
      }
      const id = "id" in node ? node.id : undefined;
      const name = "name" in node ? node.name : undefined;
      if (typeof id !== "string" || typeof name !== "string") {
        return [];
      }
      return [{ id, name }];
    });
  }

  async updateIssue(input: {
    issueId: string;
    description: string;
    labelIds: string[];
    parentId?: string;
  }): Promise<{ id: string; identifier: string; title: string }> {
    const response = await this.postGraphql<LinearIssueDetailsUpdateData>(
      LINEAR_ISSUE_DETAILS_UPDATE_MUTATION,
      {
        issueId: input.issueId,
        description: input.description,
        labelIds: input.labelIds,
        ...(input.parentId !== undefined ? { parentId: input.parentId } : {}),
      },
    );

    if (response.issueUpdate?.success !== true) {
      throw new TrackerError(
        ERROR_CODES.linearGraphqlErrors,
        "Linear issueUpdate mutation did not return success.",
        { details: response },
      );
    }

    const issue = response.issueUpdate.issue;
    if (
      typeof issue?.id !== "string" ||
      typeof issue.identifier !== "string" ||
      typeof issue.title !== "string"
    ) {
      throw new TrackerError(
        ERROR_CODES.linearUnknownPayload,
        "Linear issueUpdate returned incomplete issue data.",
        { details: response },
      );
    }

    return {
      id: issue.id,
      identifier: issue.identifier,
      title: issue.title,
    };
  }

  async updateIssueState(
    issueId: string,
    stateName: string,
    teamKey: string,
  ): Promise<void> {
    const statesResponse = await this.postGraphql<LinearWorkflowStatesData>(
      LINEAR_WORKFLOW_STATES_QUERY,
      { teamKey },
    );

    const states = statesResponse.workflowStates?.nodes;
    if (!Array.isArray(states)) {
      throw new TrackerError(
        ERROR_CODES.linearUnknownPayload,
        "Linear workflowStates payload was missing nodes.",
        { details: statesResponse },
      );
    }

    const targetState = states.find(
      (s) =>
        typeof s.name === "string" &&
        s.name.toLowerCase() === stateName.toLowerCase(),
    );
    if (!targetState || typeof targetState.id !== "string") {
      throw new TrackerError(
        ERROR_CODES.linearUnknownPayload,
        `Linear workflow state "${stateName}" not found for team "${teamKey}".`,
        { details: { states, targetStateName: stateName } },
      );
    }

    const updateResponse = await this.postGraphql<LinearIssueUpdateData>(
      LINEAR_ISSUE_UPDATE_MUTATION,
      { issueId, stateId: targetState.id },
    );

    if (updateResponse.issueUpdate?.success !== true) {
      throw new TrackerError(
        ERROR_CODES.linearGraphqlErrors,
        "Linear issueUpdate mutation did not return success.",
        { details: updateResponse },
      );
    }
  }

  async checkAndCloseParent(
    issueId: string,
    terminalStates: string[],
    teamKey: string,
  ): Promise<void> {
    const terminalSet = new Set(terminalStates.map((s) => s.toLowerCase()));

    const response = await this.postGraphql<LinearIssueParentAndSiblingsData>(
      LINEAR_ISSUE_PARENT_AND_SIBLINGS_QUERY,
      { issueId },
    );

    const parent = response.issue?.parent;
    if (!parent || !parent.id || !parent.identifier) {
      // No parent — nothing to do
      return;
    }

    const siblings = parent.children?.nodes;
    if (!Array.isArray(siblings) || siblings.length === 0) {
      return;
    }

    const allTerminal = siblings.every((sibling) => {
      const stateName = sibling.state?.name;
      return (
        typeof stateName === "string" &&
        terminalSet.has(stateName.toLowerCase())
      );
    });

    if (!allTerminal) {
      return;
    }

    console.log(
      `[orchestrator] Auto-closing parent ${parent.identifier} — all sub-issues complete`,
    );

    await this.updateIssueState(parent.id, "Done", teamKey);
  }

  async fetchParent(
    issueId: string,
  ): Promise<{ identifier: string; title: string; url: string } | null> {
    const cached = this.parentCache.get(issueId);
    if (cached !== undefined) {
      return cached === NULL_PARENT_SENTINEL ? null : cached;
    }

    const response = await this.postGraphql<LinearIssueParentDetailData>(
      LINEAR_ISSUE_PARENT_DETAIL_QUERY,
      { issueId },
    );

    const parentData = response.issue?.parent;
    if (
      !parentData ||
      typeof parentData.identifier !== "string" ||
      typeof parentData.title !== "string" ||
      typeof parentData.url !== "string"
    ) {
      this.parentCache.set(issueId, NULL_PARENT_SENTINEL);
      return null;
    }

    const result = {
      identifier: parentData.identifier,
      title: parentData.title,
      url: parentData.url,
    };
    this.parentCache.set(issueId, result);
    return result;
  }

  /**
   * File a watchdog ticket (SYMPH-398). Resolves the Triage state ID for the
   * team; falls back to Backlog if Triage is not present. Deduplicates by
   * exact title match within the team — if an open issue with the same title
   * exists, returns it without creating a new one.
   *
   * Never auto-releases: state resolution intentionally targets Triage/Backlog
   * so the ticket stays visible until an operator acts.
   */
  async createWatchdogIssue(input: {
    teamId: string;
    teamKey: string;
    title: string;
    description: string;
  }): Promise<{
    id: string;
    identifier: string;
    title: string;
    created: boolean;
  }> {
    // 1. Dedup by title — look for an existing non-terminal open issue
    const existingResponse =
      await this.postGraphql<LinearSearchIssuesByTitleData>(
        LINEAR_SEARCH_ISSUES_BY_TITLE_AND_TEAM_QUERY,
        { teamKey: input.teamKey, title: input.title, first: 5 },
      );
    const existingNodes = existingResponse.issues?.nodes ?? [];
    for (const node of existingNodes) {
      if (
        typeof node?.id === "string" &&
        typeof node.identifier === "string" &&
        typeof node.title === "string"
      ) {
        const stateType = node.state?.type;
        // Skip completed/cancelled issues so we always file fresh for new
        // cluster generations.
        if (stateType !== "completed" && stateType !== "cancelled") {
          return {
            id: node.id,
            identifier: node.identifier,
            title: node.title,
            created: false,
          };
        }
      }
    }

    // 2. Resolve target state: Triage first, then Backlog
    const statesResponse = await this.postGraphql<LinearWorkflowStatesData>(
      LINEAR_WORKFLOW_STATES_QUERY,
      { teamKey: input.teamKey },
    );
    const states = statesResponse.workflowStates?.nodes ?? [];
    let targetStateId: string | null = null;
    for (const preferred of ["Triage", "Backlog"]) {
      const found = states.find(
        (s) =>
          typeof s.name === "string" &&
          s.name.toLowerCase() === preferred.toLowerCase(),
      );
      if (found !== undefined && typeof found.id === "string") {
        targetStateId = found.id;
        break;
      }
    }

    if (targetStateId === null) {
      throw new TrackerError(
        ERROR_CODES.linearUnknownPayload,
        `Could not find Triage or Backlog state for team "${input.teamKey}".`,
        { details: { teamKey: input.teamKey, stateCount: states.length } },
      );
    }

    // 3. Create the issue
    const response = await this.postGraphql<LinearIssueCreateData>(
      LINEAR_CREATE_ISSUE_WITH_STATE_MUTATION,
      {
        teamId: input.teamId,
        title: input.title,
        stateId: targetStateId,
        description: input.description,
      },
    );

    if (response.issueCreate?.success !== true) {
      throw new TrackerError(
        ERROR_CODES.linearGraphqlErrors,
        "Linear issueCreate (watchdog) mutation did not return success.",
        { details: response },
      );
    }

    const issue = response.issueCreate.issue;
    if (
      typeof issue?.id !== "string" ||
      typeof issue.identifier !== "string" ||
      typeof issue.title !== "string"
    ) {
      throw new TrackerError(
        ERROR_CODES.linearUnknownPayload,
        "Linear issueCreate (watchdog) returned incomplete issue data.",
        { details: response },
      );
    }

    return {
      id: issue.id,
      identifier: issue.identifier,
      title: issue.title,
      created: true,
    };
  }

  /**
   * File an autonomous Track-finding issue (SYMPH-763). Deduplicates by the
   * `[track:<fingerprint>]` marker carried in the title: if an open
   * (non-terminal) issue with that marker exists, returns it without creating a
   * duplicate. Otherwise resolves a Backlog (then Triage) state and creates the
   * issue — Track findings are non-blocking follow-up work, so they land in the
   * backlog rather than demanding triage attention.
   *
   * The caller passes the marker-bearing title and full body (built by the
   * shared track-finding-filing helpers); this method owns only the dedup,
   * state resolution, and create.
   */
  async createTrackFindingIssue(input: {
    teamId: string;
    teamKey: string;
    fingerprint: string;
    title: string;
    description: string;
  }): Promise<{
    id: string;
    identifier: string;
    title: string;
    url: string | null;
    created: boolean;
  }> {
    const marker = `[track:${input.fingerprint}]`;

    // 1. Dedup by the fingerprint marker — find an existing non-terminal issue.
    const existingResponse =
      await this.postGraphql<LinearSearchIssuesByTitleMarkerData>(
        LINEAR_SEARCH_ISSUES_BY_TITLE_MARKER_AND_TEAM_QUERY,
        { teamKey: input.teamKey, marker, first: 10 },
      );
    for (const node of existingResponse.issues?.nodes ?? []) {
      if (
        typeof node?.id !== "string" ||
        typeof node.identifier !== "string" ||
        typeof node.title !== "string"
      ) {
        continue;
      }
      // `containsIgnoreCase` is a loose substring match: it can surface an issue
      // whose title merely embeds this marker somewhere in its human tail (e.g.
      // a finding that references another finding's marker). We always prefix the
      // marker, so anchor the dedup to the start of the title — that uniquely
      // identifies the issue filed for THIS fingerprint and cannot alias on an
      // embedded mention (council R1 P3-1).
      if (!node.title.startsWith(marker)) {
        continue;
      }
      const stateType = node.state?.type;
      if (stateType !== "completed" && stateType !== "cancelled") {
        return {
          id: node.id,
          identifier: node.identifier,
          title: node.title,
          url: typeof node.url === "string" ? node.url : null,
          created: false,
        };
      }
    }

    // 2. Resolve target state: Backlog first, then Triage.
    const statesResponse = await this.postGraphql<LinearWorkflowStatesData>(
      LINEAR_WORKFLOW_STATES_QUERY,
      { teamKey: input.teamKey },
    );
    const states = statesResponse.workflowStates?.nodes ?? [];
    let targetStateId: string | null = null;
    for (const preferred of ["Backlog", "Triage"]) {
      const found = states.find(
        (s) =>
          typeof s.name === "string" &&
          s.name.toLowerCase() === preferred.toLowerCase(),
      );
      if (found !== undefined && typeof found.id === "string") {
        targetStateId = found.id;
        break;
      }
    }
    if (targetStateId === null) {
      throw new TrackerError(
        ERROR_CODES.linearUnknownPayload,
        `Could not find Backlog or Triage state for team "${input.teamKey}".`,
        { details: { teamKey: input.teamKey, stateCount: states.length } },
      );
    }

    // 3. Create the issue.
    const response = await this.postGraphql<LinearTrackFindingCreateData>(
      LINEAR_CREATE_TRACK_FINDING_ISSUE_MUTATION,
      {
        teamId: input.teamId,
        title: input.title,
        stateId: targetStateId,
        description: input.description,
      },
    );
    if (response.issueCreate?.success !== true) {
      throw new TrackerError(
        ERROR_CODES.linearGraphqlErrors,
        "Linear issueCreate (track finding) mutation did not return success.",
        { details: response },
      );
    }
    const issue = response.issueCreate.issue;
    if (
      typeof issue?.id !== "string" ||
      typeof issue.identifier !== "string" ||
      typeof issue.title !== "string"
    ) {
      throw new TrackerError(
        ERROR_CODES.linearUnknownPayload,
        "Linear issueCreate (track finding) returned incomplete issue data.",
        { details: response },
      );
    }
    return {
      id: issue.id,
      identifier: issue.identifier,
      title: issue.title,
      url: typeof issue.url === "string" ? issue.url : null,
      created: true,
    };
  }

  async executeRawGraphql(
    query: string,
    variables: Record<string, unknown> = {},
  ): Promise<LinearRawGraphqlResponse> {
    const apiKey = this.requireApiKey();
    const response = await this.fetchWithTimeout(query, variables, apiKey);
    const body = await parseGraphqlResponseBody(response);

    return {
      status: response.status,
      body,
    };
  }

  private async fetchIssuePages(
    query: string,
    variables: Record<string, unknown>,
  ): Promise<Issue[]> {
    const issues: Issue[] = [];
    let after: string | null = null;

    while (true) {
      const response: LinearCandidateData = await this.postGraphql(query, {
        ...variables,
        after,
      });

      const connection: LinearGraphqlConnection<unknown> | undefined =
        response.issues;
      if (!connection || typeof connection !== "object") {
        throw new TrackerError(
          ERROR_CODES.linearUnknownPayload,
          "Linear issues payload was missing the issues connection.",
          { details: response },
        );
      }

      const nodes = connection.nodes;
      if (!Array.isArray(nodes)) {
        throw new TrackerError(
          ERROR_CODES.linearUnknownPayload,
          "Linear issues payload was missing issues.nodes.",
          { details: response },
        );
      }

      issues.push(...nodes.map((node) => normalizeLinearIssue(node)));

      const pageInfo: LinearGraphqlPageInfo | null | undefined =
        connection.pageInfo;
      if (!pageInfo || typeof pageInfo !== "object") {
        throw new TrackerError(
          ERROR_CODES.linearUnknownPayload,
          "Linear issues payload was missing pageInfo.",
          { details: response },
        );
      }

      if (pageInfo.hasNextPage !== true) {
        break;
      }

      if (typeof pageInfo.endCursor !== "string" || pageInfo.endCursor === "") {
        throw new TrackerError(
          ERROR_CODES.linearMissingEndCursor,
          "Linear pagination indicated more pages without an end cursor.",
          { details: response },
        );
      }

      after = pageInfo.endCursor;
    }

    return issues;
  }

  private async fetchTicketFeatureIssuePages(
    query: string,
    variables: Record<string, unknown>,
  ): Promise<TicketFeatureSourceIssue[]> {
    const issues: TicketFeatureSourceIssue[] = [];
    let after: string | null = null;

    while (true) {
      const response: LinearCandidateData = await this.postGraphql(query, {
        ...variables,
        after,
      });

      const connection: LinearGraphqlConnection<unknown> | undefined =
        response.issues;
      if (!connection || typeof connection !== "object") {
        throw new TrackerError(
          ERROR_CODES.linearUnknownPayload,
          "Linear ticket feature payload was missing the issues connection.",
          { details: response },
        );
      }

      const nodes = connection.nodes;
      if (!Array.isArray(nodes)) {
        throw new TrackerError(
          ERROR_CODES.linearUnknownPayload,
          "Linear ticket feature payload was missing issues.nodes.",
          { details: response },
        );
      }

      issues.push(
        ...nodes.map((node) => normalizeLinearTicketFeatureIssue(node)),
      );

      const pageInfo: LinearGraphqlPageInfo | null | undefined =
        connection.pageInfo;
      if (!pageInfo || typeof pageInfo !== "object") {
        throw new TrackerError(
          ERROR_CODES.linearUnknownPayload,
          "Linear ticket feature payload was missing pageInfo.",
          { details: response },
        );
      }

      if (pageInfo.hasNextPage !== true) {
        break;
      }

      if (typeof pageInfo.endCursor !== "string" || pageInfo.endCursor === "") {
        throw new TrackerError(
          ERROR_CODES.linearMissingEndCursor,
          "Linear pagination indicated more pages without an end cursor.",
          { details: response },
        );
      }

      after = pageInfo.endCursor;
    }

    return issues;
  }

  private async postGraphql<TData>(
    query: string,
    variables: Record<string, unknown>,
  ): Promise<TData> {
    const apiKey = this.requireApiKey();
    const response = await this.fetchWithTimeout(query, variables, apiKey);

    if (!response.ok) {
      // Capture the error body — Linear returns GraphQL validation errors
      // (e.g. GRAPHQL_VALIDATION_FAILED) as HTTP 400 with a JSON body, and
      // dropping it made the SYMPH-413 regression undiagnosable from logs.
      let responseBody: unknown = null;
      try {
        responseBody = await parseGraphqlResponseBody(response);
      } catch {
        responseBody = null;
      }
      throw new TrackerError(
        ERROR_CODES.linearApiStatus,
        `Linear API request failed with HTTP ${response.status}.`,
        {
          details: {
            ...buildGraphqlDiagnosticContext(query, variables),
            responseBody,
          },
          status: response.status,
        },
      );
    }

    let body: LinearGraphqlResponse<TData>;
    try {
      body = (await response.json()) as LinearGraphqlResponse<TData>;
    } catch (error) {
      throw new TrackerError(
        ERROR_CODES.linearUnknownPayload,
        "Linear API returned a non-JSON payload.",
        { cause: error },
      );
    }

    if (Array.isArray(body.errors) && body.errors.length > 0) {
      throw new TrackerError(
        ERROR_CODES.linearGraphqlErrors,
        "Linear GraphQL returned top-level errors.",
        {
          details: {
            ...buildGraphqlDiagnosticContext(query, variables),
            errors: body.errors,
          },
        },
      );
    }

    if (!("data" in body) || body.data === undefined || body.data === null) {
      throw new TrackerError(
        ERROR_CODES.linearUnknownPayload,
        "Linear GraphQL response was missing the data field.",
        { details: body },
      );
    }

    return body.data;
  }

  private async fetchWithTimeout(
    query: string,
    variables: Record<string, unknown>,
    apiKey: string,
  ): Promise<Response> {
    const controller = new AbortController();
    const timeout = setTimeout(() => {
      controller.abort();
    }, this.networkTimeoutMs);

    try {
      return await this.fetchFn(this.endpoint, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: apiKey,
        },
        body: JSON.stringify({ query, variables }),
        signal: controller.signal,
      });
    } catch (error) {
      throw toTrackerRequestError(error);
    } finally {
      clearTimeout(timeout);
    }
  }

  private requireApiKey(): string {
    if (!this.apiKey || this.apiKey.trim() === "") {
      throw new TrackerError(
        ERROR_CODES.missingTrackerApiKey,
        "Linear tracker API key is required.",
      );
    }

    return this.apiKey;
  }

  private requireProjectSlug(): string {
    if (!this.projectSlug || this.projectSlug.trim() === "") {
      throw new TrackerError(
        ERROR_CODES.missingTrackerProjectSlug,
        "Linear tracker project slug is required.",
      );
    }

    return this.projectSlug;
  }
}

function assertIssueLabelsResolved(node: unknown, identifier: string): void {
  if (!node || typeof node !== "object" || Array.isArray(node)) {
    throw new TrackerError(
      ERROR_CODES.linearUnknownPayload,
      `Linear issue-by-identifier payload for "${identifier}" was not an object.`,
      { details: node },
    );
  }
  const labels = "labels" in node ? node.labels : undefined;
  if (!labels || typeof labels !== "object" || Array.isArray(labels)) {
    throw new TrackerError(
      ERROR_CODES.linearUnknownPayload,
      `Linear issue-by-identifier payload for "${identifier}" did not include labels.`,
      { details: node },
    );
  }
  const nodes = "nodes" in labels ? labels.nodes : undefined;
  if (!Array.isArray(nodes)) {
    throw new TrackerError(
      ERROR_CODES.linearUnknownPayload,
      `Linear issue-by-identifier payload for "${identifier}" did not include labels.nodes.`,
      { details: node },
    );
  }
}

function normalizeLinearIssueReference(node: unknown): LinearIssueReference {
  if (!node || typeof node !== "object" || Array.isArray(node)) {
    throw new TrackerError(
      ERROR_CODES.linearUnknownPayload,
      "Linear issue reference payload was not an object.",
      { details: node },
    );
  }

  const raw = node as LinearIssueDetailsNode;
  if (
    typeof raw.id !== "string" ||
    typeof raw.identifier !== "string" ||
    typeof raw.title !== "string"
  ) {
    throw new TrackerError(
      ERROR_CODES.linearUnknownPayload,
      "Linear issue reference payload was missing id, identifier, or title.",
      { details: node },
    );
  }

  return {
    id: raw.id,
    identifier: raw.identifier,
    title: raw.title,
    description: typeof raw.description === "string" ? raw.description : null,
    url: typeof raw.url === "string" ? raw.url : null,
    teamId: typeof raw.team?.id === "string" ? raw.team.id : null,
    teamKey: typeof raw.team?.key === "string" ? raw.team.key : null,
    projectId: typeof raw.project?.id === "string" ? raw.project.id : null,
    projectSlug:
      typeof raw.project?.slugId === "string" ? raw.project.slugId : null,
    labels:
      raw.labels?.nodes
        ?.flatMap((label) =>
          typeof label?.name === "string" ? [label.name.toLowerCase()] : [],
        )
        .sort() ?? [],
    parent:
      typeof raw.parent?.id === "string" &&
      typeof raw.parent.identifier === "string" &&
      typeof raw.parent.title === "string"
        ? {
            id: raw.parent.id,
            identifier: raw.parent.identifier,
            title: raw.parent.title,
            url: typeof raw.parent.url === "string" ? raw.parent.url : null,
          }
        : null,
  };
}

function normalizeLinearIssueComment(node: unknown): LinearIssueComment {
  if (!node || typeof node !== "object" || Array.isArray(node)) {
    throw new TrackerError(
      ERROR_CODES.linearUnknownPayload,
      "Linear issue comment payload was not an object.",
      { details: node },
    );
  }

  const raw = node as Record<string, unknown>;
  const id = raw.id;
  const body = raw.body;
  if (typeof id !== "string" || id.trim() === "") {
    throw new TrackerError(
      ERROR_CODES.linearUnknownPayload,
      "Linear issue comment payload was missing id.",
      { details: node },
    );
  }
  if (typeof body !== "string") {
    throw new TrackerError(
      ERROR_CODES.linearUnknownPayload,
      "Linear issue comment payload was missing body.",
      { details: node },
    );
  }

  return {
    id,
    body,
    createdAt: normalizeCommentTimestamp(raw.createdAt, "createdAt", node),
    updatedAt: normalizeCommentTimestamp(raw.updatedAt, "updatedAt", node),
    user: normalizeUserActor(raw.user as never),
    botActor: normalizeBotActor(raw.botActor as never),
  };
}

function normalizeCommentTimestamp(
  value: unknown,
  field: string,
  details: unknown,
): string {
  if (typeof value !== "string" || Number.isNaN(Date.parse(value))) {
    throw new TrackerError(
      ERROR_CODES.linearUnknownPayload,
      `Linear issue comment payload had invalid ${field}.`,
      { details },
    );
  }
  return new Date(value).toISOString();
}

function compareLinearIssueComments(
  left: LinearIssueComment,
  right: LinearIssueComment,
): number {
  return `${left.createdAt}\0${left.id}`.localeCompare(
    `${right.createdAt}\0${right.id}`,
    "en",
  );
}

function buildGraphqlDiagnosticContext(
  query: string,
  variables: Record<string, unknown>,
): { operationName: string | null; variables: Record<string, unknown> } {
  return {
    operationName: extractGraphqlOperationName(query),
    variables: sanitizeGraphqlVariables(variables),
  };
}

function extractGraphqlOperationName(query: string): string | null {
  const match = /\b(?:query|mutation)\s+([_A-Za-z][_0-9A-Za-z]*)/.exec(query);
  return match?.[1] ?? null;
}

function sanitizeGraphqlVariables(
  variables: Record<string, unknown>,
): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(variables).map(([key, value]) => [
      key,
      isSensitiveGraphqlVariable(key) ? "[redacted]" : value,
    ]),
  );
}

function isSensitiveGraphqlVariable(key: string): boolean {
  return (
    /(?:api|auth|secret|token|key|password)/i.test(key) && key !== "teamKey"
  );
}

/**
 * Cap on the raw error-response body we retain. A misconfigured endpoint or
 * proxy can return a large HTML error page on a non-OK status; without a bound
 * the full body would be parsed, stored in `TrackerError.details`, and
 * re-serialized for logs/Slack (SYMPH-413 council finding).
 */
const GRAPHQL_RESPONSE_BODY_MAX_CHARS = 16_000;

async function parseGraphqlResponseBody(response: Response): Promise<unknown> {
  const rawText = await response.text();
  if (rawText.trim().length === 0) {
    return null;
  }

  const truncated = rawText.length > GRAPHQL_RESPONSE_BODY_MAX_CHARS;
  const text = truncated
    ? rawText.slice(0, GRAPHQL_RESPONSE_BODY_MAX_CHARS)
    : rawText;

  if (!truncated) {
    try {
      return JSON.parse(text) as unknown;
    } catch {
      return { raw: text };
    }
  }

  // A truncated body is no longer valid JSON; preserve the readable prefix.
  return { raw: text, responseBodyTruncated: true };
}
