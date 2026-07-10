import { ERROR_CODES } from "../errors/codes.js";
import { TrackerError } from "./errors.js";
import {
  LINEAR_TRACK_FINDING_DISPOSITION_DETAIL_QUERY,
  LINEAR_TRACK_FINDING_INVERSE_RELATIONS_QUERY,
} from "./track-finding-queries.js";

const MAX_PAGES = 10;

interface Connection<T> {
  nodes?: T[];
  pageInfo?: { hasNextPage?: unknown; endCursor?: unknown } | null;
}

interface CommentData {
  issue?: { comments?: Connection<{ body?: string }> | null } | null;
}

interface RelationData {
  issue?: {
    inverseRelations?: Connection<{
      type?: string;
      issue?: TrackFindingIssueRef | null;
    }> | null;
  } | null;
}

export interface TrackFindingIssueRef {
  id?: string;
  identifier?: string;
  title?: string;
  url?: string | null;
  state?: { name?: string; type?: string } | null;
}

export interface TrackFindingProvenanceDeps {
  pageSize: number;
  postGraphql<T>(query: string, variables: Record<string, unknown>): Promise<T>;
}

export async function fetchTrackFindingCommentBodies(
  issueId: string,
  deps: TrackFindingProvenanceDeps,
): Promise<string[]> {
  const nodes = await fetchPages<CommentData, { body?: string }>({
    issueId,
    deps,
    query: LINEAR_TRACK_FINDING_DISPOSITION_DETAIL_QUERY,
    label: "comments",
    read: (response) => response.issue?.comments,
  });
  return nodes.flatMap((node) =>
    typeof node.body === "string" ? [node.body] : [],
  );
}

export function fetchTrackFindingInverseRelations(
  issueId: string,
  deps: TrackFindingProvenanceDeps,
) {
  return fetchPages<
    RelationData,
    { type?: string; issue?: TrackFindingIssueRef | null }
  >({
    issueId,
    deps,
    query: LINEAR_TRACK_FINDING_INVERSE_RELATIONS_QUERY,
    label: "inverse relations",
    read: (response) => response.issue?.inverseRelations,
  });
}

async function fetchPages<TResponse, TNode>(input: {
  issueId: string;
  deps: TrackFindingProvenanceDeps;
  query: string;
  label: string;
  read(response: TResponse): Connection<TNode> | null | undefined;
}): Promise<TNode[]> {
  const nodes: TNode[] = [];
  let after: string | null = null;
  for (let page = 1; page <= MAX_PAGES; page += 1) {
    const response = await input.deps.postGraphql<TResponse>(input.query, {
      issueId: input.issueId,
      first: input.deps.pageSize,
      after,
    });
    const connection = input.read(response);
    if (!connection || !Array.isArray(connection.nodes)) {
      throw payloadError(input.label, "payload was incomplete", response);
    }
    nodes.push(...connection.nodes);
    if (!connection.pageInfo || typeof connection.pageInfo !== "object") {
      throw payloadError(input.label, "payload was missing pageInfo", response);
    }
    if (connection.pageInfo.hasNextPage !== true) return nodes;
    if (page === MAX_PAGES) {
      throw payloadError(
        input.label,
        "exceeded the bounded provenance window",
        { issueId: input.issueId, maxPages: MAX_PAGES },
      );
    }
    const cursor = connection.pageInfo.endCursor;
    if (typeof cursor !== "string" || cursor === "") {
      throw new TrackerError(
        ERROR_CODES.linearMissingEndCursor,
        `Linear Track-finding ${input.label} pagination indicated more pages without an end cursor.`,
        { details: response },
      );
    }
    after = cursor;
  }
  return nodes;
}

function payloadError(label: string, detail: string, response: unknown) {
  return new TrackerError(
    ERROR_CODES.linearUnknownPayload,
    `Linear Track-finding ${label} ${detail}.`,
    { details: response },
  );
}
