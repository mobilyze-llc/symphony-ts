import { ERROR_CODES } from "../errors/codes.js";
import { sanitizeForLinear } from "../shared/egress.js";
import { TrackerError } from "./errors.js";
import {
  type TrackFindingIssueRef as IssueRef,
  fetchTrackFindingCommentBodies,
  fetchTrackFindingInverseRelations,
} from "./track-finding-provenance.js";
import {
  LINEAR_CREATE_TRACK_FINDING_ISSUE_MUTATION,
  LINEAR_SEARCH_ISSUES_BY_TITLE_MARKER_AND_TEAM_QUERY,
} from "./track-finding-queries.js";

const SUPPRESSING_DISPOSITIONS = [
  "absorb-into",
  "supersede-by-root-fix",
  "cancel-stale",
] as const;

interface SearchData {
  issues?: { nodes?: IssueRef[] };
}

interface WorkflowStatesData {
  workflowStates?: { nodes?: Array<{ id?: string; name?: string }> };
}

interface CreateData {
  issueCreate?: { success?: boolean; issue?: IssueRef };
}

type PostGraphql = <T>(
  query: string,
  variables: Record<string, unknown>,
) => Promise<T>;

export interface TrackFindingIssueInput {
  teamId: string;
  teamKey: string;
  fingerprint: string;
  title: string;
  description: string;
  refilingSource?: { identifier: string; url: string | null };
}

export interface TrackFindingIssueResult {
  id: string;
  identifier: string;
  title: string;
  url: string | null;
  created: boolean;
  suppressedTwinIdentifier?: string;
}

export interface TrackFindingIntakeDeps {
  pageSize: number;
  workflowStatesQuery: string;
  postGraphql: PostGraphql;
  postComment(issueId: string, body: string): Promise<void>;
}

export function triageDispositionMarker(
  disposition: (typeof SUPPRESSING_DISPOSITIONS)[number] | "cancel-fixed",
  fingerprint: string,
): string {
  return `<!-- triage-disposition:${disposition}:${fingerprint} -->`;
}

export function trackRefilingSuppressionMarker(fingerprint: string): string {
  return `<!-- track-refile-suppressed:${fingerprint} -->`;
}

export function findPreferredIntakeStateId(
  states: Array<{ id?: string; name?: string }>,
): string | null {
  for (const preferred of ["Triage", "Backlog"]) {
    const found = states.find(
      (state) => state.name?.toLowerCase() === preferred.toLowerCase(),
    );
    if (typeof found?.id === "string") return found.id;
  }
  return null;
}

export async function createTrackFindingIssue(
  input: TrackFindingIssueInput,
  deps: TrackFindingIntakeDeps,
): Promise<TrackFindingIssueResult> {
  const marker = `[track:${input.fingerprint}]`;
  const search = await deps.postGraphql<SearchData>(
    LINEAR_SEARCH_ISSUES_BY_TITLE_MARKER_AND_TEAM_QUERY,
    { teamKey: input.teamKey, marker, first: 10 },
  );

  for (const twin of search.issues?.nodes ?? []) {
    if (!isCompleteIssue(twin) || !twin.title.startsWith(marker)) continue;
    const stateType = twin.state?.type;
    if (stateType !== "completed" && stateType !== "cancelled") {
      return resultFromIssue(twin, false);
    }
    if (stateType !== "cancelled") continue;

    const suppressed = await trySuppressCancelledTwin(input, twin, deps);
    if (suppressed !== null) return suppressed;
  }

  const states = await deps.postGraphql<WorkflowStatesData>(
    deps.workflowStatesQuery,
    { teamKey: input.teamKey },
  );
  const targetStateId = findPreferredIntakeStateId(
    states.workflowStates?.nodes ?? [],
  );
  if (targetStateId === null) {
    throw new TrackerError(
      ERROR_CODES.linearUnknownPayload,
      `Could not find Backlog or Triage state for team "${input.teamKey}".`,
      {
        details: {
          teamKey: input.teamKey,
          stateCount: states.workflowStates?.nodes?.length ?? 0,
        },
      },
    );
  }

  const created = await deps.postGraphql<CreateData>(
    LINEAR_CREATE_TRACK_FINDING_ISSUE_MUTATION,
    {
      teamId: input.teamId,
      title: input.title,
      stateId: targetStateId,
      description: input.description,
    },
  );
  if (created.issueCreate?.success !== true) {
    throw new TrackerError(
      ERROR_CODES.linearGraphqlErrors,
      "Linear issueCreate (track finding) mutation did not return success.",
      { details: created },
    );
  }
  const issue = created.issueCreate.issue;
  if (!isCompleteIssue(issue)) {
    throw new TrackerError(
      ERROR_CODES.linearUnknownPayload,
      "Linear issueCreate (track finding) returned incomplete issue data.",
      { details: created },
    );
  }
  return resultFromIssue(issue, true);
}

async function trySuppressCancelledTwin(
  input: TrackFindingIssueInput,
  twin: IssueRef & { id: string; identifier: string; title: string },
  deps: TrackFindingIntakeDeps,
): Promise<TrackFindingIssueResult | null> {
  try {
    const comments = await fetchTrackFindingCommentBodies(twin.id, deps);
    const hasMarker = SUPPRESSING_DISPOSITIONS.some((disposition) =>
      comments.some((body) =>
        body.includes(triageDispositionMarker(disposition, input.fingerprint)),
      ),
    );
    if (!hasMarker) return null;

    const relations = await fetchTrackFindingInverseRelations(twin.id, deps);
    const root = relations
      .filter((relation) => relation.type?.toLowerCase().includes("supersede"))
      .map((relation) => relation.issue)
      .find(isOpenCompleteIssue);
    if (root === undefined) return null;

    const rootComments = await fetchTrackFindingCommentBodies(root.id, deps);
    const suppressionMarker = trackRefilingSuppressionMarker(input.fingerprint);
    if (!rootComments.some((body) => body.includes(suppressionMarker))) {
      await deps.postComment(
        root.id,
        renderSuppressionComment(input, twin, suppressionMarker),
      );
    }
    return {
      ...resultFromIssue(root, false),
      suppressedTwinIdentifier: twin.identifier,
    };
  } catch {
    // Incomplete, malformed, unavailable, or over-bound provenance is no proof.
    return null;
  }
}

function renderSuppressionComment(
  input: TrackFindingIssueInput,
  twin: IssueRef & { identifier: string },
  marker: string,
): string {
  const source = renderLinkedRef(
    input.refilingSource?.identifier ?? "unknown source",
    input.refilingSource?.url,
  );
  return [
    "## Track finding refile suppressed",
    "",
    `- Fingerprint: \`${sanitizeForLinear(input.fingerprint)}\``,
    `- Refiling source: ${source}`,
    `- Suppressed twin: ${renderLinkedRef(twin.identifier, twin.url)}`,
    "",
    "The prior finding remains covered by this open intake-triage root.",
    "",
    marker,
  ].join("\n");
}

function renderLinkedRef(identifier: string, url: string | null | undefined) {
  const safeIdentifier = sanitizeForLinear(identifier);
  return url == null
    ? safeIdentifier
    : `${safeIdentifier} (${sanitizeForLinear(url)})`;
}

function isCompleteIssue(
  issue: IssueRef | null | undefined,
): issue is IssueRef & { id: string; identifier: string; title: string } {
  return (
    typeof issue?.id === "string" &&
    typeof issue.identifier === "string" &&
    typeof issue.title === "string"
  );
}

function isOpenCompleteIssue(
  issue: IssueRef | null | undefined,
): issue is IssueRef & { id: string; identifier: string; title: string } {
  return (
    isCompleteIssue(issue) &&
    typeof issue.state?.type === "string" &&
    issue.state.type !== "completed" &&
    issue.state.type !== "cancelled"
  );
}

function resultFromIssue(
  issue: IssueRef & { id: string; identifier: string; title: string },
  created: boolean,
): TrackFindingIssueResult {
  return {
    id: issue.id,
    identifier: issue.identifier,
    title: issue.title,
    url: typeof issue.url === "string" ? issue.url : null,
    created,
  };
}
