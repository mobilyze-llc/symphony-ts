import { createHmac } from "node:crypto";

import { describe, expect, it, vi } from "vitest";

import type { Issue } from "../../src/domain/model.js";
import {
  InMemoryLinearWebhookDeduper,
  acceptLinearWebhookDelivery,
  runPortfolioWebhookRepair,
} from "../../src/portfolio/linear-webhook-reconciler.js";
import {
  PORTFOLIO_INTAKE_PROJECT,
  PORTFOLIO_TAXONOMY_PROJECTS,
} from "../../src/portfolio/taxonomy.js";

describe("linear webhook portfolio reconciler", () => {
  const secret = "linear-webhook-secret";
  const taxonomyProject = PORTFOLIO_TAXONOMY_PROJECTS.find(
    (project) => project.name === "Portfolio Taxonomy & Agent Workflow Tooling",
  )!;

  it("verifies the raw Linear signature, timestamp, and duplicate delivery id", () => {
    const now = new Date("2026-06-20T12:00:00.000Z");
    const rawBody = JSON.stringify({
      type: "Issue",
      action: "update",
      webhookTimestamp: now.valueOf(),
      data: { id: "issue-1" },
    });
    const deduper = new InMemoryLinearWebhookDeduper();
    const headers = headerReader({
      "linear-signature": sign(rawBody, secret),
      "linear-delivery": "delivery-1",
    });

    expect(
      acceptLinearWebhookDelivery({
        headers,
        rawBody,
        signingSecret: secret,
        now,
        deduper,
      }),
    ).toMatchObject({ status: "accepted", deliveryId: "delivery-1" });
    expect(
      acceptLinearWebhookDelivery({
        headers,
        rawBody,
        signingSecret: secret,
        now,
        deduper,
      }),
    ).toEqual({ status: "duplicate", deliveryId: "delivery-1" });
  });

  it("bounds dedupe state with ttl and max-entry eviction", () => {
    let now = 1_000;
    const deduper = new InMemoryLinearWebhookDeduper({
      maxEntries: 2,
      ttlMs: 1_000,
      now: () => now,
    });

    deduper.add("delivery-1");
    deduper.add("delivery-2");
    deduper.add("delivery-3");

    expect(deduper.has("delivery-1")).toBe(false);
    expect(deduper.has("delivery-2")).toBe(true);
    expect(deduper.has("delivery-3")).toBe(true);

    now = 3_001;

    expect(deduper.has("delivery-2")).toBe(false);
    expect(deduper.has("delivery-3")).toBe(false);
  });

  it("rejects invalid signatures before parsing payload semantics", () => {
    const now = new Date("2026-06-20T12:00:00.000Z");
    const rawBody = JSON.stringify({
      webhookTimestamp: now.valueOf(),
      data: { id: "issue-1" },
    });

    expect(
      acceptLinearWebhookDelivery({
        headers: headerReader({ "linear-signature": "0".repeat(64) }),
        rawBody,
        signingSecret: secret,
        now,
      }),
    ).toEqual({ status: "rejected", reason: "invalid_signature" });
  });

  it("allows delayed signed retries within the default freshness window", () => {
    const webhookTime = new Date("2026-06-20T12:00:00.000Z");
    const rawBody = JSON.stringify({
      type: "Issue",
      action: "update",
      webhookTimestamp: webhookTime.valueOf(),
      data: { id: "issue-1" },
    });

    expect(
      acceptLinearWebhookDelivery({
        headers: headerReader({
          "linear-signature": sign(rawBody, secret),
          "linear-delivery": "delivery-delayed",
        }),
        rawBody,
        signingSecret: secret,
        now: new Date("2026-06-20T12:05:00.000Z"),
      }),
    ).toMatchObject({ status: "accepted", deliveryId: "delivery-delayed" });

    expect(
      acceptLinearWebhookDelivery({
        headers: headerReader({
          "linear-signature": sign(rawBody, secret),
          "linear-delivery": "delivery-stale",
        }),
        rawBody,
        signingSecret: secret,
        now: new Date("2026-06-20T12:11:00.000Z"),
      }),
    ).toEqual({ status: "rejected", reason: "stale_timestamp" });
  });

  it("routes ambiguous portfolio issues to intake after refetching the issue", async () => {
    const delivery = {
      status: "accepted" as const,
      deliveryId: "delivery-2",
      payload: {
        type: "Issue",
        action: "create",
        webhookTimestamp: Date.parse("2026-06-20T12:00:00.000Z"),
        data: { id: "issue-2" },
      },
    };
    const repairIssueProject = vi.fn(async () => undefined);

    const plan = await runPortfolioWebhookRepair({
      delivery,
      callbacks: {
        loadIssue: async () =>
          issue({
            id: "issue-2",
            identifier: "MOB-902",
            teamKey: "MOB",
            projectId: null,
            projectSlug: null,
            projectName: null,
          }),
        repairIssueProject,
      },
    });

    expect(plan).toMatchObject({
      action: "route_to_intake",
      targetProjectId: PORTFOLIO_INTAKE_PROJECT.id,
    });
    expect(repairIssueProject).toHaveBeenCalledWith(
      expect.objectContaining({
        projectId: PORTFOLIO_INTAKE_PROJECT.id,
        deliveryId: "delivery-2",
      }),
    );
  });

  it("noops when the refetched issue already has a taxonomy project", async () => {
    const delivery = {
      status: "accepted" as const,
      deliveryId: "delivery-3",
      payload: {
        type: "Issue",
        action: "update",
        webhookTimestamp: Date.parse("2026-06-20T12:00:00.000Z"),
        data: { id: "issue-3" },
      },
    };
    const repairIssueProject = vi.fn(async () => undefined);

    const plan = await runPortfolioWebhookRepair({
      delivery,
      callbacks: {
        loadIssue: async () =>
          issue({
            id: "issue-3",
            identifier: "SYMPH-903",
            teamKey: "SYMPH",
            projectId: taxonomyProject.id,
            projectSlug: taxonomyProject.slugId,
            projectName: taxonomyProject.name,
          }),
        repairIssueProject,
      },
    });

    expect(plan).toMatchObject({ action: "noop" });
    expect(repairIssueProject).not.toHaveBeenCalled();
  });
});

function sign(rawBody: string, secret: string): string {
  return createHmac("sha256", secret).update(rawBody).digest("hex");
}

function headerReader(headers: Record<string, string>) {
  return {
    get: (name: string): string | null => headers[name.toLowerCase()] ?? null,
  };
}

function issue(
  input: Partial<Issue> & Pick<Issue, "id" | "identifier">,
): Issue {
  return {
    title: input.identifier,
    description: null,
    priority: null,
    state: "Todo",
    branchName: null,
    url: null,
    labels: [],
    blockedBy: [],
    createdAt: null,
    updatedAt: null,
    ...input,
  };
}
