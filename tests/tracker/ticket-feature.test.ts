import { describe, expect, it } from "vitest";

import type { DispatcherRunJournalEntry } from "../../src/domain/model.js";
import { ERROR_CODES, type TrackerError } from "../../src/index.js";
import {
  extractTicketFeature,
  extractTicketFeatures,
  normalizeLinearTicketFeatureIssue,
} from "../../src/tracker/ticket-feature.js";

describe("ticket feature extractor", () => {
  it("extracts provenance, lineage trust, AC posture, and component overlap", () => {
    const issue = normalizeLinearTicketFeatureIssue({
      id: "issue-483",
      identifier: "SYMPH-483",
      title: "TicketFeature extractor",
      description:
        "Build the read-side model.\n\n## Acceptance Criteria\n- `test:` focused coverage exists",
      priority: 2,
      url: "https://linear.app/mobilyze/issue/SYMPH-483",
      createdAt: "2026-06-13T00:00:00.000Z",
      updatedAt: "2026-06-13T00:30:00.000Z",
      state: { name: "Backlog" },
      labels: {
        nodes: [
          { name: "pipeline-generated" },
          { name: "source:user-report" },
          { name: "area:review-tooling" },
          { name: "company:mobilyze" },
        ],
      },
      creator: {
        id: "agent-user",
        name: "Mobilyze Agents",
        displayName: "Mobilyze Agents",
        email: "agent@mobilyze.com",
      },
      parent: {
        id: "issue-481",
        identifier: "SYMPH-481",
        title: "Queue triage epic",
        state: { name: "Backlog" },
      },
      inverseRelations: {
        nodes: [
          {
            id: "rel-480",
            type: "blocks",
            issue: {
              id: "issue-480",
              identifier: "SYMPH-480",
              title: "Review provenance gap",
              state: { name: "Done" },
            },
          },
        ],
      },
      history: {
        nodes: [
          {
            createdAt: "2026-06-13T00:20:00.000Z",
            actor: {
              id: "operator-user",
              name: "Operator",
              displayName: "Operator",
              email: "operator@mobilyze.com",
            },
            relationChanges: [{ identifier: "SYMPH-480", type: "blocks" }],
          },
          {
            createdAt: "2026-06-13T00:10:00.000Z",
            actor: {
              id: "operator-user",
              name: "Operator",
              displayName: "Operator",
              email: "operator@mobilyze.com",
            },
            toParent: {
              id: "issue-481",
              identifier: "SYMPH-481",
              title: "Queue triage epic",
            },
          },
        ],
      },
    });
    const sibling = normalizeLinearTicketFeatureIssue({
      id: "issue-484",
      identifier: "SYMPH-484",
      title: "Adjacent queue triage surface",
      state: { name: "Backlog" },
      labels: { nodes: [{ name: "area:review-tooling" }] },
    });

    const [feature] = extractTicketFeatures({
      issues: [issue, sibling],
      operatorConfig: {
        operatorAllowlist: ["operator@mobilyze.com"],
        serviceAccounts: ["agent@mobilyze.com"],
      },
      runJournal: [
        acGateEntry({
          issueId: "issue-483",
          issueIdentifier: "SYMPH-483",
          sequence: 7,
        }),
      ],
    });

    expect(feature).toMatchObject({
      issue: {
        identifier: "SYMPH-483",
        state: "Backlog",
      },
      provenance: {
        class: "pipeline_generated",
        matchedLabels: ["pipeline-generated", "source:user-report"],
        issueAuthor: {
          actorClass: "service_account",
        },
      },
      relationSummary: {
        totalEdges: 2,
        operatorConfirmedEdges: 2,
        advisoryEdges: 0,
        missingAuthorEdges: 0,
        serviceAccountEdges: 0,
        historyTruncatedEdges: 0,
      },
      sourceVisibility: {
        relationPageTruncated: false,
        relationHistoryTruncated: false,
      },
      components: {
        labels: ["area:review-tooling", "company:mobilyze"],
        overlappingIssueIdentifiers: ["SYMPH-484"],
      },
      acPosture: {
        kind: "author_ac",
        hasAuthorAcceptanceCriteria: true,
        frozenSnapshot: {
          sequence: 7,
          acceptanceCriteria: "### Acceptance Criteria\n- `check:` frozen",
        },
      },
      intentSufficiency: {
        status: "sufficient",
      },
    });
    expect(feature?.specLineage.parent).toMatchObject({
      kind: "parent",
      trust: "operator_confirmed",
      authorClass: "operator",
      issue: { identifier: "SYMPH-481" },
    });
    expect(feature?.specLineage.blockedBy[0]).toMatchObject({
      kind: "blocked_by",
      relationId: "rel-480",
      trust: "operator_confirmed",
      authorClass: "operator",
      issue: { identifier: "SYMPH-480" },
      author: { email: "operator@mobilyze.com" },
    });
  });

  it("defaults missing relation authorship to advisory", () => {
    const feature = extractTicketFeature({
      issue: normalizeLinearTicketFeatureIssue({
        id: "issue-483",
        identifier: "SYMPH-483",
        title: "TicketFeature extractor",
        state: { name: "Backlog" },
        inverseRelations: {
          nodes: [
            {
              id: "rel-480",
              type: "blocks",
              issue: {
                id: "issue-480",
                identifier: "SYMPH-480",
                state: { name: "Done" },
              },
            },
          ],
        },
      }),
      operatorConfig: {
        operatorAllowlist: ["operator@mobilyze.com"],
        serviceAccounts: [],
      },
    });

    expect(feature.specLineage.blockedBy).toEqual([
      expect.objectContaining({
        trust: "advisory",
        author: null,
        authorClass: "unknown",
        advisoryReason: "missing_author",
        attributionSource: "missing",
      }),
    ]);
    expect(feature.relationSummary).toMatchObject({
      advisoryEdges: 1,
      missingAuthorEdges: 1,
      operatorConfirmedEdges: 0,
      historyTruncatedEdges: 0,
    });
  });

  it("marks unmatched lineage as history-truncated when visible history is capped", () => {
    const feature = extractTicketFeature({
      issue: normalizeLinearTicketFeatureIssue({
        id: "issue-483",
        identifier: "SYMPH-483",
        title: "TicketFeature extractor",
        state: { name: "Backlog" },
        parent: {
          id: "issue-481",
          identifier: "SYMPH-481",
          title: "Queue triage epic",
        },
        inverseRelations: {
          nodes: [
            {
              id: "rel-480",
              type: "blocks",
              issue: {
                id: "issue-480",
                identifier: "SYMPH-480",
                state: { name: "Done" },
              },
            },
          ],
        },
        history: {
          nodes: [],
          pageInfo: { hasNextPage: true, endCursor: "history-cursor" },
        },
      }),
      operatorConfig: {
        operatorAllowlist: ["operator@mobilyze.com"],
        serviceAccounts: [],
      },
    });

    expect(feature.sourceVisibility).toEqual({
      relationPageTruncated: false,
      relationHistoryTruncated: true,
    });
    expect(feature.specLineage.parent).toMatchObject({
      trust: "advisory",
      advisoryReason: "history_truncated",
      attributionSource: "history_truncated",
    });
    expect(feature.specLineage.blockedBy[0]).toMatchObject({
      trust: "advisory",
      advisoryReason: "history_truncated",
      attributionSource: "history_truncated",
    });
    expect(feature.relationSummary).toMatchObject({
      advisoryEdges: 2,
      missingAuthorEdges: 0,
      historyTruncatedEdges: 2,
    });
  });

  it("never upgrades service-account authored edges to operator trust", () => {
    const feature = extractTicketFeature({
      issue: normalizeLinearTicketFeatureIssue({
        id: "issue-483",
        identifier: "SYMPH-483",
        title: "TicketFeature extractor",
        state: { name: "Backlog" },
        inverseRelations: {
          nodes: [
            {
              id: "rel-480",
              type: "blocks",
              issue: {
                id: "issue-480",
                identifier: "SYMPH-480",
                state: { name: "Done" },
              },
            },
          ],
        },
        history: {
          nodes: [
            {
              createdAt: "2026-06-13T00:20:00.000Z",
              actor: {
                id: "agent-user",
                name: "Mobilyze Agents",
                displayName: "Mobilyze Agents",
                email: "agent@mobilyze.com",
              },
              relationChanges: [{ identifier: "SYMPH-480", type: "blocks" }],
            },
          ],
        },
      }),
      operatorConfig: {
        operatorAllowlist: ["agent@mobilyze.com"],
        serviceAccounts: ["agent@mobilyze.com"],
      },
    });

    expect(feature.specLineage.blockedBy[0]).toMatchObject({
      trust: "advisory",
      authorClass: "service_account",
      advisoryReason: "service_account",
    });
    expect(feature.relationSummary).toMatchObject({
      advisoryEdges: 1,
      serviceAccountEdges: 1,
    });
  });

  it("distinguishes frozen AC snapshots from tickets with no AC evidence", () => {
    const snapshotFeature = extractTicketFeature({
      issue: normalizeLinearTicketFeatureIssue({
        id: "issue-483",
        identifier: "SYMPH-483",
        title: "TicketFeature extractor",
        description: "Investigate the queue model.",
        state: { name: "Backlog" },
      }),
      runJournal: [
        acGateEntry({
          issueId: "issue-483",
          issueIdentifier: "SYMPH-483",
          sequence: 9,
        }),
      ],
    });
    const neitherFeature = extractTicketFeature({
      issue: normalizeLinearTicketFeatureIssue({
        id: "issue-484",
        identifier: "SYMPH-484",
        title: "Thin ticket",
        description: "Do the thing.",
        state: { name: "Backlog" },
      }),
      runJournal: [
        acGateEntry({
          issueId: "issue-483",
          issueIdentifier: "SYMPH-483",
          sequence: 9,
        }),
      ],
    });

    expect(snapshotFeature.acPosture).toMatchObject({
      kind: "frozen_snapshot",
      hasAuthorAcceptanceCriteria: false,
      frozenSnapshot: {
        sequence: 9,
      },
    });
    expect(snapshotFeature.intentSufficiency.status).toBe("sufficient");
    expect(neitherFeature.acPosture).toEqual({
      kind: "neither",
      hasAuthorAcceptanceCriteria: false,
      frozenSnapshot: null,
    });
    expect(neitherFeature.intentSufficiency.status).toBe("thin");
  });

  it("rejects malformed Linear feature payloads at the Zod boundary", () => {
    expect(() =>
      normalizeLinearTicketFeatureIssue({
        identifier: "SYMPH-483",
        title: "Missing id",
        state: { name: "Backlog" },
      }),
    ).toThrowError(
      expect.objectContaining<Partial<TrackerError>>({
        code: ERROR_CODES.linearUnknownPayload,
      }),
    );
  });
});

function acGateEntry(input: {
  issueId: string;
  issueIdentifier: string;
  sequence: number;
}): DispatcherRunJournalEntry {
  return {
    sequence: input.sequence,
    idempotencyKey: `ac_gate:${input.issueId}:${input.sequence}`,
    timestamp: "2026-06-13T00:30:00.000Z",
    kind: "ac_gate",
    issueId: input.issueId,
    issueIdentifier: input.issueIdentifier,
    operation: "dispatcher",
    stage: "investigate",
    attempt: null,
    ownerId: "test-owner",
    lease: null,
    summary: "AC gate verdict for SYMPH-483: pass.",
    metadata: {
      status: "completed",
      verdict: "pass",
      acceptanceCriteria: "### Acceptance Criteria\n- `check:` frozen",
    },
  };
}
