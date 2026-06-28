import { createHash } from "node:crypto";

import { z } from "zod";

import {
  PLAN_BATCH_MODES,
  PLAN_BATCH_STATUSES,
  type PlanBatch,
  type PlanBatchMember,
  type PlanBatchMode,
  type PlanCanaryStructure,
} from "./standing-plan.js";

export const PlanBatchSchema = z
  .object({
    batchId: z.string(),
    mode: z.enum(PLAN_BATCH_MODES),
    status: z.enum(PLAN_BATCH_STATUSES),
    members: z.array(
      z.object({
        issueId: z.string(),
        issueIdentifier: z.string(),
      }),
    ),
    rationale: z.string(),
    canary: z
      .object({
        headIssueIdentifiers: z.array(z.string()),
        contingentIssueIdentifiers: z.array(z.string()),
      })
      .nullable(),
  })
  .superRefine((batch, ctx) => {
    if (batch.canary === null) {
      if (batch.mode === "canary-chain") {
        ctx.addIssue({
          code: "custom",
          path: ["canary"],
          message: "canary-chain batches require a canary structure",
        });
      }
      return;
    }

    const memberIdentifiers = new Set(
      batch.members.map((member) => member.issueIdentifier),
    );
    if (batch.canary.headIssueIdentifiers.length === 0) {
      ctx.addIssue({
        code: "custom",
        path: ["canary", "headIssueIdentifiers"],
        message: "canary head must not be empty",
      });
    }
    const headIssueIdentifiers = batch.canary.headIssueIdentifiers;
    for (const [index, identifier] of headIssueIdentifiers.entries()) {
      if (!memberIdentifiers.has(identifier)) {
        ctx.addIssue({
          code: "custom",
          path: ["canary", "headIssueIdentifiers", index],
          message: "canary head identifier must reference a batch member",
        });
      }
    }
    const contingentIssueIdentifiers = batch.canary.contingentIssueIdentifiers;
    for (const [index, identifier] of contingentIssueIdentifiers.entries()) {
      if (!memberIdentifiers.has(identifier)) {
        ctx.addIssue({
          code: "custom",
          path: ["canary", "contingentIssueIdentifiers", index],
          message: "canary contingent identifier must reference a batch member",
        });
      }
    }
  });

export function isValidPlanBatch(value: unknown): value is PlanBatch {
  return PlanBatchSchema.safeParse(value).success;
}

export interface RawPlanBatchForNormalization {
  mode: PlanBatchMode;
  rationale: string;
  canary?: PlanCanaryStructure | null;
}

export type NormalizePlanBatchResult =
  | { ok: true; batch: PlanBatch }
  | { ok: false; rejection: string };

export function normalizePlanBatch(
  rawBatch: RawPlanBatchForNormalization,
  members: readonly PlanBatchMember[],
): NormalizePlanBatchResult {
  if (typeof rawBatch.rationale !== "string") {
    return { ok: false, rejection: "invalid batch rationale" };
  }
  if (!PLAN_BATCH_MODES.includes(rawBatch.mode)) {
    return { ok: false, rejection: "invalid batch mode" };
  }
  if (!members.every(isPlanBatchMember)) {
    return { ok: false, rejection: "invalid batch member" };
  }

  const canary = normalizeCanary(rawBatch.canary ?? null, members);
  const mode: PlanBatchMode =
    rawBatch.mode === "canary-chain" && canary === null
      ? "parallel-isolated"
      : rawBatch.mode;
  const batch: PlanBatch = {
    batchId: contentBatchId(mode, members, canary),
    mode,
    status: "lookahead",
    members: [...members],
    rationale: rawBatch.rationale,
    canary,
  };

  assertValidNormalizedBatch(batch);
  return { ok: true, batch };
}

function normalizeCanary(
  canary: PlanCanaryStructure | null,
  members: readonly PlanBatchMember[],
): PlanCanaryStructure | null {
  if (canary === null) {
    return null;
  }
  const memberIdentifiers = new Set(
    members.map((member) => member.issueIdentifier),
  );
  const headIssueIdentifiers = canary.headIssueIdentifiers.filter((id) =>
    memberIdentifiers.has(id),
  );
  if (headIssueIdentifiers.length === 0) {
    return null;
  }
  const contingentIssueIdentifiers = canary.contingentIssueIdentifiers.filter(
    (id) => memberIdentifiers.has(id),
  );
  return { headIssueIdentifiers, contingentIssueIdentifiers };
}

function contentBatchId(
  mode: string,
  members: readonly PlanBatchMember[],
  canary: PlanCanaryStructure | null,
): string {
  const memberKey = members
    .map((member) => member.issueIdentifier)
    .slice()
    .sort()
    .join(",");
  const canaryKey =
    canary === null
      ? ""
      : `${[...canary.headIssueIdentifiers].sort().join(",")}>${[
          ...canary.contingentIssueIdentifiers,
        ]
          .sort()
          .join(",")}`;
  const digest = createHash("sha256")
    .update(`${mode}\n${memberKey}\n${canaryKey}`)
    .digest("hex");
  return `b-${digest.slice(0, 12)}`;
}

function assertValidNormalizedBatch(batch: PlanBatch): void {
  if (process.env.NODE_ENV === "production") {
    return;
  }
  if (!isValidPlanBatch(batch)) {
    throw new Error("normalizePlanBatch produced an invalid PlanBatch");
  }
}

function isPlanBatchMember(value: unknown): value is PlanBatchMember {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    typeof (value as Partial<PlanBatchMember>).issueId === "string" &&
    typeof (value as Partial<PlanBatchMember>).issueIdentifier === "string"
  );
}
