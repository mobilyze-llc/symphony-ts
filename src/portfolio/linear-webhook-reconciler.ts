import { createHmac, timingSafeEqual } from "node:crypto";

import type { Issue } from "../domain/model.js";
import {
  type PortfolioClassificationResult,
  classifyPortfolioIssue,
} from "./classifier.js";

export interface LinearWebhookHeaders {
  get(name: string): string | null;
}

export type LinearWebhookVerificationFailure =
  | "missing_signature"
  | "invalid_signature"
  | "invalid_json"
  | "missing_timestamp"
  | "stale_timestamp";

export interface LinearWebhookPayload {
  action?: unknown;
  type?: unknown;
  data?: unknown;
  webhookTimestamp?: unknown;
  url?: unknown;
}

export interface LinearWebhookAcceptedDelivery {
  status: "accepted";
  deliveryId: string;
  payload: LinearWebhookPayload;
}

export interface LinearWebhookRejectedDelivery {
  status: "rejected";
  reason: LinearWebhookVerificationFailure;
}

export interface LinearWebhookDuplicateDelivery {
  status: "duplicate";
  deliveryId: string;
}

export type LinearWebhookAcceptResult =
  | LinearWebhookAcceptedDelivery
  | LinearWebhookRejectedDelivery
  | LinearWebhookDuplicateDelivery;

export interface PortfolioWebhookRepairPlan {
  action: "noop" | "repair_project" | "route_to_intake";
  issue: Issue;
  classification: PortfolioClassificationResult;
  targetProjectId: string | null;
  reason: string;
}

export interface PortfolioWebhookRepairCallbacks {
  loadIssue(identifierOrId: string): Promise<Issue | null>;
  repairIssueProject(input: {
    issue: Issue;
    projectId: string;
    classification: PortfolioClassificationResult;
    deliveryId: string;
  }): Promise<void>;
}

export class InMemoryLinearWebhookDeduper {
  private readonly seen = new Set<string>();

  has(deliveryId: string): boolean {
    return this.seen.has(deliveryId);
  }

  add(deliveryId: string): void {
    this.seen.add(deliveryId);
  }
}

export function acceptLinearWebhookDelivery(input: {
  headers: LinearWebhookHeaders;
  rawBody: Buffer | string;
  signingSecret: string;
  now?: Date;
  toleranceMs?: number;
  deduper?: InMemoryLinearWebhookDeduper;
}): LinearWebhookAcceptResult {
  const rawBody =
    typeof input.rawBody === "string"
      ? Buffer.from(input.rawBody)
      : input.rawBody;
  const signature = input.headers.get("linear-signature");
  if (signature === null || signature.trim() === "") {
    return { status: "rejected", reason: "missing_signature" };
  }
  if (
    !verifyLinearWebhookSignature({
      rawBody,
      signingSecret: input.signingSecret,
      signature,
    })
  ) {
    return { status: "rejected", reason: "invalid_signature" };
  }

  let payload: LinearWebhookPayload;
  try {
    payload = JSON.parse(rawBody.toString("utf8")) as LinearWebhookPayload;
  } catch {
    return { status: "rejected", reason: "invalid_json" };
  }

  const timestamp = readWebhookTimestamp(payload);
  if (timestamp === null) {
    return { status: "rejected", reason: "missing_timestamp" };
  }
  const now = input.now ?? new Date();
  const toleranceMs = input.toleranceMs ?? 60_000;
  if (Math.abs(now.valueOf() - timestamp) > toleranceMs) {
    return { status: "rejected", reason: "stale_timestamp" };
  }

  const deliveryId = resolveDeliveryId(input.headers, payload);
  if (input.deduper?.has(deliveryId) === true) {
    return { status: "duplicate", deliveryId };
  }
  input.deduper?.add(deliveryId);
  return { status: "accepted", deliveryId, payload };
}

export function verifyLinearWebhookSignature(input: {
  rawBody: Buffer;
  signingSecret: string;
  signature: string;
}): boolean {
  const expected = createHmac("sha256", input.signingSecret)
    .update(input.rawBody)
    .digest("hex");
  const observed = input.signature.trim().toLowerCase();
  if (!/^[a-f0-9]{64}$/.test(observed)) {
    return false;
  }
  return timingSafeEqual(
    Buffer.from(expected, "hex"),
    Buffer.from(observed, "hex"),
  );
}

export async function planPortfolioWebhookRepair(input: {
  delivery: LinearWebhookAcceptedDelivery;
  callbacks: Pick<PortfolioWebhookRepairCallbacks, "loadIssue">;
}): Promise<PortfolioWebhookRepairPlan | null> {
  if (input.delivery.payload.type !== "Issue") {
    return null;
  }
  if (
    input.delivery.payload.action !== "create" &&
    input.delivery.payload.action !== "update"
  ) {
    return null;
  }

  const issueId = readIssueId(input.delivery.payload.data);
  if (issueId === null) {
    return null;
  }
  const issue = await input.callbacks.loadIssue(issueId);
  if (issue === null) {
    return null;
  }
  const classification = classifyPortfolioIssue(issue);
  if (classification.status === "valid") {
    return {
      action: "noop",
      issue,
      classification,
      targetProjectId: classification.targetProject?.id ?? null,
      reason: "Portfolio classification is already valid.",
    };
  }
  const targetProject =
    classification.targetProject ?? classification.intakeProject;
  if (targetProject === null) {
    return {
      action: "noop",
      issue,
      classification,
      targetProjectId: null,
      reason: "Issue is outside portfolio enforcement scope.",
    };
  }
  return {
    action:
      targetProject.kind === "intake" ? "route_to_intake" : "repair_project",
    issue,
    classification,
    targetProjectId: targetProject.id,
    reason: classification.reason,
  };
}

export async function runPortfolioWebhookRepair(input: {
  delivery: LinearWebhookAcceptedDelivery;
  callbacks: PortfolioWebhookRepairCallbacks;
}): Promise<PortfolioWebhookRepairPlan | null> {
  const plan = await planPortfolioWebhookRepair({
    delivery: input.delivery,
    callbacks: input.callbacks,
  });
  if (
    plan === null ||
    plan.targetProjectId === null ||
    plan.action === "noop"
  ) {
    return plan;
  }
  await input.callbacks.repairIssueProject({
    issue: plan.issue,
    projectId: plan.targetProjectId,
    classification: plan.classification,
    deliveryId: input.delivery.deliveryId,
  });
  return plan;
}

function readWebhookTimestamp(payload: LinearWebhookPayload): number | null {
  return typeof payload.webhookTimestamp === "number" &&
    Number.isFinite(payload.webhookTimestamp)
    ? payload.webhookTimestamp
    : null;
}

function resolveDeliveryId(
  headers: LinearWebhookHeaders,
  payload: LinearWebhookPayload,
): string {
  const header = headers.get("linear-delivery");
  if (header !== null && header.trim() !== "") {
    return header.trim();
  }
  const dataId = readIssueId(payload.data) ?? "no-issue";
  return `${payload.type ?? "unknown"}:${payload.action ?? "unknown"}:${dataId}:${payload.webhookTimestamp ?? "no-ts"}`;
}

function readIssueId(data: unknown): string | null {
  if (data === null || typeof data !== "object" || Array.isArray(data)) {
    return null;
  }
  const value = (data as { id?: unknown; identifier?: unknown }).id;
  if (typeof value === "string" && value.trim() !== "") {
    return value;
  }
  const identifier = (data as { identifier?: unknown }).identifier;
  return typeof identifier === "string" && identifier.trim() !== ""
    ? identifier
    : null;
}
