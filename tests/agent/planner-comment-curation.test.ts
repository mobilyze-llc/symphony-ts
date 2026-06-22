import { describe, expect, it } from "vitest";

import {
  type PlannerCommentInput,
  curatePlannerComments,
  measurePlannerCommentEnrichment,
} from "../../src/agent/planner-comment-curation.js";
import type { TicketFeatureActor } from "../../src/tracker/ticket-feature.js";

function actor(over: Partial<TicketFeatureActor> = {}): TicketFeatureActor {
  return {
    kind: "user",
    id: "user-1",
    name: "Human",
    displayName: "Human",
    email: "human@example.com",
    botType: null,
    botSubType: null,
    ...over,
  };
}

function comment(over: Partial<PlannerCommentInput> = {}): PlannerCommentInput {
  return {
    id: "c1",
    body: "Body",
    createdAt: "2026-06-20T00:00:00.000Z",
    actor: actor(),
    ...over,
  };
}

describe("curatePlannerComments (SYMPH-896)", () => {
  it("drops bot/service-account/automation/blank comments and keeps human signal", () => {
    const result = curatePlannerComments(
      [
        comment({
          id: "human",
          body: "Overlaps with src/agent/triage-planner.ts",
          actor: actor({ email: "dev@example.com" }),
        }),
        comment({
          id: "bot",
          body: "Linear automation",
          actor: actor({ kind: "bot" }),
        }),
        comment({
          id: "svc",
          body: "service note",
          actor: actor({ email: "svc@bot.com" }),
        }),
        comment({
          id: "council",
          body: "## Council review\nP1: something",
          actor: actor({ email: "dev@example.com" }),
        }),
        comment({
          id: "blank",
          body: "   ",
          actor: actor({ email: "dev@example.com" }),
        }),
      ],
      {
        operatorConfig: {
          operatorAllowlist: [],
          serviceAccounts: ["svc@bot.com"],
        },
      },
    );
    expect(result.comments.map((entry) => entry.id)).toEqual(["human"]);
    expect(result.droppedNoiseCount).toBe(4);
    expect(result.consideredCount).toBe(5);
  });

  it("keeps the newest comments up to maxComments (newest-first)", () => {
    const result = curatePlannerComments(
      [
        comment({
          id: "old",
          body: "old",
          createdAt: "2026-06-18T00:00:00.000Z",
        }),
        comment({
          id: "mid",
          body: "mid",
          createdAt: "2026-06-19T00:00:00.000Z",
        }),
        comment({
          id: "new",
          body: "new",
          createdAt: "2026-06-20T00:00:00.000Z",
        }),
      ],
      { config: { maxComments: 2, maxCommentChars: 400, maxTotalChars: 1200 } },
    );
    expect(result.comments.map((entry) => entry.id)).toEqual(["new", "mid"]);
    expect(result.droppedForBudgetCount).toBe(1);
  });

  it("truncates an over-long comment body to maxCommentChars", () => {
    const result = curatePlannerComments(
      [comment({ id: "long", body: `HEAD ${"x".repeat(5000)} TAIL` })],
      { config: { maxComments: 6, maxCommentChars: 20, maxTotalChars: 1200 } },
    );
    const kept = result.comments[0];
    expect(kept?.body.startsWith("HEAD ")).toBe(true);
    expect(kept?.body.endsWith("…")).toBe(true);
    expect(kept?.body.length).toBe(21); // 20 chars + ellipsis
  });

  it("enforces the per-issue total-char budget by dropping the oldest kept", () => {
    const result = curatePlannerComments(
      [
        comment({
          id: "old",
          body: "AAAAA",
          createdAt: "2026-06-18T00:00:00.000Z",
        }),
        comment({
          id: "new",
          body: "BBBBB",
          createdAt: "2026-06-20T00:00:00.000Z",
        }),
      ],
      { config: { maxComments: 6, maxCommentChars: 400, maxTotalChars: 5 } },
    );
    expect(result.comments.map((entry) => entry.id)).toEqual(["new"]);
    expect(result.droppedForBudgetCount).toBe(1);
  });

  it("classifies a null-actor comment as unknown and keeps it (council P2)", () => {
    const result = curatePlannerComments([
      comment({ id: "anon", body: "no author here", actor: null }),
    ]);
    expect(result.comments.map((entry) => entry.id)).toEqual(["anon"]);
    expect(result.comments[0]?.authorClass).toBe("unknown");
    expect(result.droppedNoiseCount).toBe(0);
  });
});

describe("measurePlannerCommentEnrichment (SYMPH-896)", () => {
  it("rolls up a report-only enrichment measurement", () => {
    const a = curatePlannerComments([comment({ id: "a", body: "hello" })]);
    const b = curatePlannerComments([
      comment({ id: "b", body: "world!!" }),
      comment({ id: "bot", actor: actor({ kind: "bot" }) }),
    ]);
    const measurement = measurePlannerCommentEnrichment({
      candidatesConsidered: 5,
      candidatesTruncated: 2,
      candidatesFailed: 1,
      results: [a, b],
    });
    expect(measurement.candidatesConsidered).toBe(5);
    expect(measurement.candidatesFetched).toBe(2);
    expect(measurement.candidatesTruncated).toBe(2);
    expect(measurement.candidatesFailed).toBe(1);
    // honesty invariant: considered = fetched + failed + truncated.
    expect(
      measurement.candidatesFetched +
        measurement.candidatesFailed +
        measurement.candidatesTruncated,
    ).toBe(measurement.candidatesConsidered);
    expect(measurement.totalCommentsFetched).toBe(3); // 1 + 2
    expect(measurement.totalCommentsKept).toBe(2); // a:hello, b:world!!
    expect(measurement.totalDroppedNoise).toBe(1); // bot in b
    expect(measurement.totalCuratedChars).toBe(12); // hello(5)+world!!(7)
    expect(measurement.estimatedAddedTokens).toBe(3); // ceil(12/4)
  });
});
