import { describe, expect, it, vi } from "vitest";

import { OrchestratorRuntimeHost } from "../../src/orchestrator/runtime-host.js";
import type { LinearWebhookAcceptedDelivery } from "../../src/portfolio/linear-webhook-reconciler.js";
import { PORTFOLIO_INTAKE_PROJECT } from "../../src/portfolio/taxonomy.js";
import { LinearTrackerClient } from "../../src/tracker/linear-client.js";

describe("OrchestratorRuntimeHost Linear webhook repair", () => {
  it("refetches the issue, stamps classification, moves the project, and logs the repair", async () => {
    const tracker = new LinearTrackerClient({
      endpoint: "https://api.linear.app/graphql",
      apiKey: "token",
      projectSlug: null,
      activeStates: ["Todo"],
      fetchFn: vi.fn(),
    });
    const fetchIssueReferencesByIds = vi
      .spyOn(tracker, "fetchIssueReferencesByIds")
      .mockResolvedValue([
        {
          id: "issue-1",
          identifier: "MOB-264",
          title: "Webhook should classify ambiguous project writes",
          description: "Webhook payload only carried an issue id.",
          url: "https://linear.app/mob/issue/MOB-264",
          teamId: "team-mob",
          teamKey: "MOB",
          projectId: null,
          projectSlug: null,
          projectName: null,
          labels: ["source:agent"],
          parent: null,
        },
      ]);
    const resolveLabelIdsByNames = vi
      .spyOn(tracker, "resolveLabelIdsByNames")
      .mockResolvedValue([{ id: "label-1", name: "source:agent" }]);
    const updateIssue = vi.spyOn(tracker, "updateIssue").mockResolvedValue({
      id: "issue-1",
      identifier: "MOB-264",
      title: "Webhook should classify ambiguous project writes",
    });
    const logger = { info: vi.fn(async () => undefined) };
    const delivery: LinearWebhookAcceptedDelivery = {
      status: "accepted",
      deliveryId: "delivery-264",
      payload: {
        type: "Issue",
        action: "update",
        webhookTimestamp: Date.parse("2026-06-20T12:00:00.000Z"),
        data: { id: "issue-1" },
      },
    };

    await OrchestratorRuntimeHost.prototype.handleLinearWebhookDelivery.call(
      { tracker, logger } as unknown as OrchestratorRuntimeHost,
      delivery,
    );

    expect(fetchIssueReferencesByIds).toHaveBeenCalledWith(["issue-1"]);
    expect(resolveLabelIdsByNames).toHaveBeenCalledWith(
      ["source:agent"],
      "MOB",
    );
    expect(updateIssue).toHaveBeenCalledWith(
      expect.objectContaining({
        issueId: "issue-1",
        labelIds: ["label-1"],
        projectId: PORTFOLIO_INTAKE_PROJECT.id,
      }),
    );
    expect(updateIssue.mock.calls[0]?.[0].description).toContain(
      "## Portfolio Classification",
    );
    expect(updateIssue.mock.calls[0]?.[0].description).toContain(
      "why_uncertain",
    );
    expect(logger.info).toHaveBeenCalledWith(
      "linear_webhook_portfolio_repair",
      expect.stringContaining("MOB-264"),
      expect.objectContaining({
        delivery_id: "delivery-264",
        target_project_id: PORTFOLIO_INTAKE_PROJECT.id,
      }),
    );
  });
});
