import type {
  TrackFindingIssueInput,
  TrackFindingIssueResult,
} from "../tracker/track-finding-intake.js";
import type {
  TrackFindingFilingRef,
  TrackFindingIssueContext,
  TrackFindingToFile,
} from "./track-finding-filing.js";
import {
  buildTrackFindingIssueBody,
  buildTrackFindingIssueTitle,
} from "./track-finding-filing.js";

export function buildTrackFindingIntakeRequest(input: {
  teamId: string;
  teamKey: string;
  finding: TrackFindingToFile;
  context: TrackFindingIssueContext;
}): TrackFindingIssueInput {
  return {
    teamId: input.teamId,
    teamKey: input.teamKey,
    fingerprint: input.finding.fingerprint,
    title: buildTrackFindingIssueTitle(input.finding),
    description: buildTrackFindingIssueBody(input.finding, input.context),
    refilingSource: {
      identifier: input.context.sourceIssueIdentifier,
      url: input.context.sourceIssueUrl,
    },
  };
}

export function buildTrackFindingIssueContext(input: {
  issueIdentifier: string;
  issueUrl: string | null;
  repo: string | null;
  prNumber: number | null;
  reviewedHeadSha: string | null;
}): TrackFindingIssueContext {
  return {
    sourceIssueIdentifier: input.issueIdentifier,
    sourceIssueUrl: input.issueUrl,
    repo: input.repo,
    prNumber: input.prNumber,
    reviewedHeadSha: input.reviewedHeadSha,
  };
}

export function toTrackFindingFilingRef(
  fingerprint: string,
  result: TrackFindingIssueResult,
): TrackFindingFilingRef {
  return {
    fingerprint,
    issueId: result.id,
    identifier: result.identifier,
    url: result.url,
  };
}

export function describeTrackFindingFiling(input: {
  sourceIssueId: string;
  fingerprint: string;
  result: TrackFindingIssueResult;
}): { message: string; fields: Record<string, unknown> } {
  const classification = input.result.created
    ? "filed"
    : input.result.suppressedTwinIdentifier === undefined
      ? "deduped"
      : "suppressed";
  return {
    message: `Track finding ${classification === "suppressed" ? "refile suppressed" : classification}: ${input.result.identifier}`,
    fields: {
      outcome: classification === "filed" ? "created" : classification,
      issue_id: input.sourceIssueId,
      identifier: input.result.identifier,
      fingerprint: input.fingerprint,
      ...(input.result.suppressedTwinIdentifier === undefined
        ? {}
        : {
            suppressed_twin_identifier: input.result.suppressedTwinIdentifier,
          }),
    },
  };
}
