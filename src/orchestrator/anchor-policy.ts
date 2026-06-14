import type {
  IssueAnchorPlacement,
  IssueAnchorRecord,
} from "../domain/model.js";
import { isPipelineSentinelValue } from "./intent.js";

export interface AnchorExpiryContext {
  completedIssueIds: ReadonlySet<string>;
  now: Date;
}

export type AnchorPlacementInvalidReason =
  | "pipeline_sentinel_reference"
  | "self_reference";

export type RelativeIssueAnchorPlacement = Exclude<
  IssueAnchorPlacement,
  { kind: "top" }
>;

export type AnchorPlacementValidation =
  | { valid: true }
  | {
      valid: false;
      placement: RelativeIssueAnchorPlacement;
      reason: AnchorPlacementInvalidReason;
    };

export function isIssueAnchorExpired(
  anchor: IssueAnchorRecord,
  context: AnchorExpiryContext,
): boolean {
  switch (anchor.expiry.kind) {
    case "until_merged":
      return context.completedIssueIds.has(anchor.issueId);
    case "until_date": {
      const expiresAtMs = Date.parse(anchor.expiry.at);
      return (
        !Number.isFinite(expiresAtMs) || expiresAtMs <= context.now.getTime()
      );
    }
  }
}

export function validateAnchorPlacementForIssue(
  placement: IssueAnchorPlacement,
  issueIdentifier: string,
): AnchorPlacementValidation {
  if (placement.kind === "top") {
    return { valid: true };
  }
  if (isPipelineSentinelValue(placement.issueIdentifier)) {
    return {
      valid: false,
      placement,
      reason: "pipeline_sentinel_reference",
    };
  }
  if (
    normalizeIssueIdentifier(placement.issueIdentifier) ===
    normalizeIssueIdentifier(issueIdentifier)
  ) {
    return { valid: false, placement, reason: "self_reference" };
  }
  return { valid: true };
}

export function formatInvalidAnchorPlacementDetail(
  placement: RelativeIssueAnchorPlacement,
  issueIdentifier: string,
  reason: AnchorPlacementInvalidReason,
): string {
  switch (reason) {
    case "pipeline_sentinel_reference":
      return `anchor target ${placement.issueIdentifier} is the pipeline sentinel, not an issue`;
    case "self_reference":
      return `anchor target ${placement.issueIdentifier} references ${issueIdentifier} itself`;
  }
}

export function normalizeIssueIdentifier(value: string): string {
  return value.trim().toUpperCase();
}
