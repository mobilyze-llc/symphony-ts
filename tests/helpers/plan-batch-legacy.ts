import {
  PLAN_BATCH_MODES,
  PLAN_BATCH_STATUSES,
  type PlanBatch,
  type PlanBatchMember,
  type PlanBatchMode,
  type PlanBatchStatus,
  type PlanCanaryStructure,
} from "../../src/domain/standing-plan.js";

export function legacyIsPlanBatch(value: unknown): value is PlanBatch {
  if (
    !isRecord(value) ||
    typeof value.batchId !== "string" ||
    !PLAN_BATCH_MODES.includes(value.mode as PlanBatchMode) ||
    !PLAN_BATCH_STATUSES.includes(value.status as PlanBatchStatus) ||
    typeof value.rationale !== "string" ||
    !Array.isArray(value.members) ||
    !value.members.every(isPlanBatchMember)
  ) {
    return false;
  }
  if (value.canary === null) {
    return value.mode !== "canary-chain";
  }
  if (!isPlanCanaryStructure(value.canary)) {
    return false;
  }
  const memberIdentifiers = new Set(
    (value.members as PlanBatchMember[]).map(
      (member) => member.issueIdentifier,
    ),
  );
  return (
    value.canary.headIssueIdentifiers.length > 0 &&
    value.canary.headIssueIdentifiers.every((id) =>
      memberIdentifiers.has(id),
    ) &&
    value.canary.contingentIssueIdentifiers.every((id) =>
      memberIdentifiers.has(id),
    )
  );
}

function isPlanBatchMember(value: unknown): value is PlanBatchMember {
  return (
    isRecord(value) &&
    typeof value.issueId === "string" &&
    typeof value.issueIdentifier === "string"
  );
}

function isPlanCanaryStructure(value: unknown): value is PlanCanaryStructure {
  return (
    isRecord(value) &&
    Array.isArray(value.headIssueIdentifiers) &&
    value.headIssueIdentifiers.every((id) => typeof id === "string") &&
    Array.isArray(value.contingentIssueIdentifiers) &&
    value.contingentIssueIdentifiers.every((id) => typeof id === "string")
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
