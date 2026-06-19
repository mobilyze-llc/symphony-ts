import { describe, expect, it } from "vitest";

import type {
  PlanEnvelope,
  StandingPlan,
} from "../../src/domain/standing-plan.js";
import {
  ingestControlDocComments,
  publishControlDoc,
} from "../../src/orchestrator/standing-plan-control-surface.js";
import type { LinearDocumentComment } from "../../src/tracker/linear-documents.js";

const ENVELOPE: PlanEnvelope = {
  version: 1,
  concurrencyCeiling: 3,
  allowedRisk: "medium",
  allowedModes: ["parallel-isolated"],
};

function plan(): StandingPlan {
  return {
    planId: "plan-1",
    revision: 2,
    contentHash: "h",
    envelope: ENVELOPE,
    batches: [
      {
        batchId: "b-aaa",
        mode: "parallel-isolated",
        status: "lookahead",
        members: [{ issueId: "u1", issueIdentifier: "SYMPH-1" }],
        rationale: "r",
        canary: null,
      },
    ],
    options: [
      {
        marker: "[opt-1]",
        label: "Release b-aaa",
        intent: { verb: "release_batch", batchId: "b-aaa" },
      },
    ],
    rationale: "r",
    createdAt: "2026-06-18T00:00:00.000Z",
    updatedAt: "2026-06-18T00:05:00.000Z",
  };
}

describe("publishControlDoc (6a)", () => {
  it("creates the doc on first publish and persists the ref + pings Slack", async () => {
    const created: unknown[] = [];
    const saved: unknown[] = [];
    const pings: string[] = [];
    const result = await publishControlDoc({
      plan: plan(),
      context: { recentlyShipped: [], inFlight: [], changelog: [] },
      teamId: "team-1",
      docClient: {
        create: async (input) => {
          created.push(input);
          return { id: "doc-1", slugId: "s1", url: "https://x/doc" };
        },
        update: async () => ({ id: "doc-1" }),
      },
      loadDocRef: async () => null,
      saveDocRef: async (ref) => {
        saved.push(ref);
      },
      notify: (url) => pings.push(url),
      log: () => undefined,
    });
    expect(result.action).toBe("created");
    expect(created).toHaveLength(1);
    expect(saved).toHaveLength(1);
    expect(pings).toEqual(["https://x/doc"]);
  });

  it("updates in place when a doc ref already exists (single living doc)", async () => {
    const updated: unknown[] = [];
    const result = await publishControlDoc({
      plan: plan(),
      context: { recentlyShipped: [], inFlight: [], changelog: [] },
      teamId: "team-1",
      docClient: {
        create: async () => {
          throw new Error("should not create");
        },
        update: async (input) => {
          updated.push(input);
          return { id: "doc-1" };
        },
      },
      loadDocRef: async () => ({
        id: "doc-1",
        slugId: "s1",
        url: "https://x/doc",
      }),
      saveDocRef: async () => undefined,
      notify: () => undefined,
      log: () => undefined,
    });
    expect(result.action).toBe("updated");
    expect(updated).toHaveLength(1);
  });

  it("skips the in-place update and Slack ping when content is unchanged since last publish (SYMPH-820)", async () => {
    const updates: unknown[] = [];
    const pings: string[] = [];
    const base = {
      plan: plan(),
      context: { recentlyShipped: [], inFlight: [], changelog: [] },
      teamId: "team-1",
      docClient: {
        create: async () => {
          throw new Error("should not create");
        },
        update: async (input: { documentId: string; content: string }) => {
          updates.push(input);
          return { id: "doc-1" };
        },
      },
      loadDocRef: async () => ({
        id: "doc-1",
        slugId: "s1",
        url: "https://x/doc",
      }),
      saveDocRef: async () => undefined,
      notify: (url: string) => pings.push(url),
      log: () => undefined,
    };
    const first = await publishControlDoc(base);
    expect(first.action).toBe("updated");
    expect(updates).toHaveLength(1);
    expect(pings).toHaveLength(1);

    // Same plan + same context, replayed with the hash the first publish
    // returned → no Linear write, no Slack ping (the throttle).
    const second = await publishControlDoc({
      ...base,
      lastPublishedContentHash: first.contentHash,
    });
    expect(second.action).toBe("unchanged");
    expect(updates).toHaveLength(1);
    expect(pings).toHaveLength(1);
  });

  it("republishes + pings when content changed since the last publish (SYMPH-820)", async () => {
    const pings: string[] = [];
    const result = await publishControlDoc({
      plan: plan(),
      context: { recentlyShipped: [], inFlight: [], changelog: [] },
      teamId: "team-1",
      docClient: {
        create: async () => {
          throw new Error("should not create");
        },
        update: async () => ({ id: "doc-1" }),
      },
      loadDocRef: async () => ({
        id: "doc-1",
        slugId: "s1",
        url: "https://x/doc",
      }),
      saveDocRef: async () => undefined,
      notify: (url: string) => pings.push(url),
      log: () => undefined,
      lastPublishedContentHash: "stale-hash-does-not-match",
    });
    expect(result.action).toBe("updated");
    expect(pings).toEqual(["https://x/doc"]);
  });
});

describe("ingestControlDocComments (6b)", () => {
  function deps(comments: Array<Record<string, unknown>>) {
    const decisions: unknown[] = [];
    let replans = 0;
    const logs: string[] = [];
    return {
      decisions,
      logs,
      getReplans: () => replans,
      run: () =>
        ingestControlDocComments({
          documentId: "doc-1",
          plan: plan(),
          operatorAllowlist: new Set(["eric@litman.org"]),
          docClient: {
            fetchComments: async () =>
              comments as unknown as LinearDocumentComment[],
          },
          fence: (t) => t,
          recordDecision: async (input) => {
            decisions.push(input);
            return { recorded: true };
          },
          requestReplan: () => {
            replans += 1;
          },
          log: (event) => {
            logs.push(event);
          },
          seen: new Set<string>(),
        }),
    };
  }

  it("records an operator marker comment as a typed decision", async () => {
    const d = deps([
      {
        id: "c1",
        body: "go",
        quotedText: "[opt-1] Release b-aaa",
        createdAt: "2026-06-18T00:10:00.000Z",
        authorEmail: "eric@litman.org",
        botActorId: null,
      },
    ]);
    await d.run();
    expect(d.decisions).toHaveLength(1);
    expect(d.decisions[0]).toMatchObject({
      kind: "approve",
      batchId: "b-aaa",
      revision: 2,
    });
  });

  it("ignores a non-operator comment (agent cannot self-approve)", async () => {
    const d = deps([
      {
        id: "c1",
        body: "[opt-1]",
        quotedText: null,
        createdAt: "2026-06-18T00:10:00.000Z",
        authorEmail: "agents@mobilyze.com",
        botActorId: null,
      },
    ]);
    await d.run();
    expect(d.decisions).toHaveLength(0);
  });

  it("requests a re-plan for a modify_plan free-text comment is logged, not executed", async () => {
    const d = deps([
      {
        id: "c1",
        body: "please rethink the ordering",
        quotedText: null,
        createdAt: "2026-06-18T00:10:00.000Z",
        authorEmail: "eric@litman.org",
        botActorId: null,
      },
    ]);
    await d.run();
    // free text → no decision recorded; logged for guarded-confirm follow-up
    expect(d.decisions).toHaveLength(0);
    expect(d.logs).toContain("queue_triage_doc_comment_unresolved");
  });

  it("does not re-plan when a modify_plan decision is not recorded (council R1, Pi P1)", async () => {
    const modifyPlan: StandingPlan = {
      ...plan(),
      options: [
        {
          marker: "[opt-1]",
          label: "Re-plan",
          intent: { verb: "modify_plan", batchId: null },
        },
      ],
    };
    let replans = 0;
    await ingestControlDocComments({
      documentId: "doc-1",
      plan: modifyPlan,
      operatorAllowlist: new Set(["eric@litman.org"]),
      docClient: {
        fetchComments: async () =>
          [
            {
              id: "c1",
              body: "go",
              quotedText: "[opt-1:r2] Re-plan",
              createdAt: "2026-06-18T00:10:00.000Z",
              authorEmail: "eric@litman.org",
              botActorId: null,
            },
          ] as unknown as LinearDocumentComment[],
      },
      fence: (t) => t,
      recordDecision: async () => ({
        recorded: false,
        reason: "stale_revision",
      }),
      requestReplan: () => {
        replans += 1;
      },
      log: () => undefined,
      seen: new Set<string>(),
    });
    expect(replans).toBe(0); // recordDecision said not recorded → no spin
  });

  it("ignores an option carrying an unrecognized verb (council R1, Pi P1)", async () => {
    const weird: StandingPlan = {
      ...plan(),
      options: [
        {
          marker: "[opt-1]",
          label: "Weird",
          intent: { verb: "obliterate", batchId: "b-aaa" },
        },
      ],
    };
    const decisions: unknown[] = [];
    const logs: string[] = [];
    await ingestControlDocComments({
      documentId: "doc-1",
      plan: weird,
      operatorAllowlist: new Set(["eric@litman.org"]),
      docClient: {
        fetchComments: async () =>
          [
            {
              id: "c1",
              body: "",
              quotedText: "[opt-1:r2] Weird",
              createdAt: "2026-06-18T00:10:00.000Z",
              authorEmail: "eric@litman.org",
              botActorId: null,
            },
          ] as unknown as LinearDocumentComment[],
      },
      fence: (t) => t,
      recordDecision: async (input) => {
        decisions.push(input);
        return { recorded: true };
      },
      requestReplan: () => undefined,
      log: (event) => {
        logs.push(event);
      },
      seen: new Set<string>(),
    });
    expect(decisions).toHaveLength(0); // unknown verb → no decision
    expect(logs).toContain("queue_triage_doc_comment_unexpected_verb");
  });
});
