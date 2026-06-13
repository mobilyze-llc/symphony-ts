import { describe, expect, it } from "vitest";

import type { Issue, IssueAnchorRecord } from "../../src/domain/model.js";
import {
  computeDispatchOrder,
  sortIssuesForDispatch,
} from "../../src/orchestrator/dispatch-comparator.js";
import type {
  TicketFeature,
  TicketFeatureTrustedEdge,
} from "../../src/tracker/ticket-feature.js";

const NOW = new Date("2026-06-13T12:00:00.000Z");
const TERMINAL_STATES = ["Done", "Canceled"];

describe("dispatch comparator", () => {
  it("matches priority/FIFO order when there are no anchors or hard edges", () => {
    const issues = [
      createIssue({
        id: "3",
        identifier: "ISSUE-3",
        priority: 2,
        createdAt: "2026-06-03T00:00:00.000Z",
      }),
      createIssue({
        id: "2",
        identifier: "ISSUE-2",
        priority: 1,
        createdAt: "2026-06-02T00:00:00.000Z",
      }),
      createIssue({
        id: "1",
        identifier: "ISSUE-1",
        priority: 1,
        createdAt: "2026-06-01T00:00:00.000Z",
      }),
    ];

    const order = computeDispatchOrder({
      issues,
      anchors: {},
      terminalStates: TERMINAL_STATES,
      now: NOW,
    });

    expect(order.status).toBe("linearized");
    expect(order.positions.map((position) => position.issue_id)).toEqual(
      sortIssuesForDispatch(issues).map((issue) => issue.id),
    );
    expect(order.exclusions).toEqual([]);
    expect(order.advisory_warnings).toEqual([]);
  });

  it("refuses linearization when hard edges form a cycle", () => {
    const issues = [
      createIssue({
        id: "1",
        identifier: "ISSUE-1",
        blockedBy: [{ id: "2", identifier: "ISSUE-2", state: "In Progress" }],
      }),
      createIssue({
        id: "2",
        identifier: "ISSUE-2",
        blockedBy: [{ id: "1", identifier: "ISSUE-1", state: "In Progress" }],
      }),
    ];

    const order = computeDispatchOrder({
      issues,
      anchors: {},
      terminalStates: TERMINAL_STATES,
      now: NOW,
    });

    expect(order.status).toBe("hard_cycle");
    expect(order.positions).toEqual([]);
    expect(order.hard_cycle?.issue_identifiers).toEqual(["ISSUE-1", "ISSUE-2"]);
  });

  it("warns for advisory cycles without excluding the subgraph", () => {
    const issue1 = createIssue({ id: "1", identifier: "ISSUE-1" });
    const issue2 = createIssue({ id: "2", identifier: "ISSUE-2" });

    const order = computeDispatchOrder({
      issues: [issue1, issue2],
      anchors: {},
      ticketFeatures: [
        createFeature(issue1, [
          createEdge(issue2, "advisory", "service_account"),
        ]),
        createFeature(issue2, [
          createEdge(issue1, "advisory", "service_account"),
        ]),
      ],
      terminalStates: TERMINAL_STATES,
      now: NOW,
    });

    expect(order.status).toBe("linearized");
    expect(
      order.positions.map((position) => position.issue_identifier),
    ).toEqual(["ISSUE-1", "ISSUE-2"]);
    expect(order.exclusions).toEqual([]);
    expect(order.advisory_warnings).toHaveLength(2);
    expect(order.would_have_been_excluded_by_advisory_edges).toHaveLength(2);
  });

  it("excludes issues blocked by open operator-confirmed hard edges", () => {
    const blocker = createIssue({ id: "1", identifier: "ISSUE-1" });
    const dependent = createIssue({ id: "2", identifier: "ISSUE-2" });

    const order = computeDispatchOrder({
      issues: [dependent, blocker],
      anchors: {},
      ticketFeatures: [
        createFeature(dependent, [
          createEdge(blocker, "operator_confirmed", null),
        ]),
        createFeature(blocker),
      ],
      terminalStates: TERMINAL_STATES,
      now: NOW,
    });

    expect(order.status).toBe("linearized");
    expect(
      order.positions.map((position) => position.issue_identifier),
    ).toEqual(["ISSUE-1"]);
    expect(order.exclusions).toMatchObject([
      {
        issue_identifier: "ISSUE-2",
        blocker_issue_identifier: "ISSUE-1",
        edge_trust: "operator_confirmed",
      },
    ]);
  });

  it("keeps issues eligible when operator-confirmed blockers are terminal", () => {
    const blocker = createIssue({
      id: "1",
      identifier: "ISSUE-1",
      state: "Done",
    });
    const dependent = createIssue({ id: "2", identifier: "ISSUE-2" });

    const order = computeDispatchOrder({
      issues: [dependent, blocker],
      anchors: {},
      ticketFeatures: [
        createFeature(dependent, [
          createEdge(blocker, "operator_confirmed", null),
        ]),
        createFeature(blocker),
      ],
      terminalStates: TERMINAL_STATES,
      now: NOW,
    });

    expect(order.status).toBe("linearized");
    expect(order.exclusions).toEqual([]);
    expect(
      order.positions.map((position) => position.issue_identifier),
    ).toEqual(["ISSUE-1", "ISSUE-2"]);
  });

  it("dedupes TicketFeature blockers against native blockedBy by either id or identifier", () => {
    const blocker = createIssue({ id: "2", identifier: "ISSUE-2" });
    const dependent = createIssue({
      id: "1",
      identifier: "ISSUE-1",
      blockedBy: [
        {
          id: null,
          identifier: "ISSUE-2",
          state: "In Progress",
        },
      ],
    });

    const order = computeDispatchOrder({
      issues: [dependent, blocker],
      anchors: {},
      ticketFeatures: [
        createFeature(dependent, [
          createEdge(blocker, "advisory", "service_account"),
        ]),
        createFeature(blocker),
      ],
      terminalStates: TERMINAL_STATES,
      now: NOW,
    });

    expect(order.exclusions).toEqual([]);
    expect(order.advisory_warnings).toHaveLength(1);
    expect(
      order.positions.map((position) => position.issue_identifier),
    ).toEqual(["ISSUE-1", "ISSUE-2"]);
  });

  it("applies top anchors inside the candidate priority band", () => {
    const issue1 = createIssue({
      id: "1",
      identifier: "ISSUE-1",
      priority: 1,
      createdAt: "2026-06-01T00:00:00.000Z",
    });
    const issue2 = createIssue({
      id: "2",
      identifier: "ISSUE-2",
      priority: 1,
      createdAt: "2026-06-02T00:00:00.000Z",
    });
    const issue3 = createIssue({
      id: "3",
      identifier: "ISSUE-3",
      priority: 2,
      createdAt: "2026-06-03T00:00:00.000Z",
    });

    const order = computeDispatchOrder({
      issues: [issue1, issue2, issue3],
      anchors: {
        "2": createAnchor(issue2),
      },
      terminalStates: TERMINAL_STATES,
      now: NOW,
    });

    expect(
      order.positions.map((position) => position.issue_identifier),
    ).toEqual(["ISSUE-2", "ISSUE-1", "ISSUE-3"]);
    expect(order.positions[0]?.rationale).toContain("operator_anchor top");
  });

  it("applies below anchors after their target issue", () => {
    const issue1 = createIssue({
      id: "1",
      identifier: "ISSUE-1",
      priority: 1,
      createdAt: "2026-06-01T00:00:00.000Z",
    });
    const issue2 = createIssue({
      id: "2",
      identifier: "ISSUE-2",
      priority: 1,
      createdAt: "2026-06-02T00:00:00.000Z",
    });
    const issue3 = createIssue({
      id: "3",
      identifier: "ISSUE-3",
      priority: 1,
      createdAt: "2026-06-03T00:00:00.000Z",
    });

    const order = computeDispatchOrder({
      issues: [issue1, issue2, issue3],
      anchors: {
        "1": createAnchor(issue1, {
          kind: "below",
          issueIdentifier: "ISSUE-2",
        }),
      },
      terminalStates: TERMINAL_STATES,
      now: NOW,
    });

    expect(
      order.positions.map((position) => position.issue_identifier),
    ).toEqual(["ISSUE-2", "ISSUE-1", "ISSUE-3"]);
  });

  it("preserves natural order and warns when a relative anchor target is unavailable", () => {
    const excluded = createIssue({
      id: "1",
      identifier: "ISSUE-1",
      priority: 1,
      createdAt: "2026-06-01T00:00:00.000Z",
      blockedBy: [
        {
          id: "9",
          identifier: "ISSUE-9",
          state: "In Progress",
        },
      ],
    });
    const anchored = createIssue({
      id: "2",
      identifier: "ISSUE-2",
      priority: 1,
      createdAt: "2026-06-02T00:00:00.000Z",
    });
    const later = createIssue({
      id: "3",
      identifier: "ISSUE-3",
      priority: 1,
      createdAt: "2026-06-03T00:00:00.000Z",
    });

    const order = computeDispatchOrder({
      issues: [excluded, anchored, later],
      anchors: {
        "2": createAnchor(anchored, {
          kind: "above",
          issueIdentifier: "ISSUE-1",
        }),
      },
      terminalStates: TERMINAL_STATES,
      now: NOW,
    });

    expect(
      order.positions.map((position) => position.issue_identifier),
    ).toEqual(["ISSUE-2", "ISSUE-3"]);
    expect(order.warnings).toContain(
      "Operator anchor for ISSUE-2 references unavailable target ISSUE-1; preserved natural priority/FIFO position.",
    );
  });

  it("ignores anchors after until-merged expiry", () => {
    const older = createIssue({
      id: "1",
      identifier: "ISSUE-1",
      priority: 1,
      createdAt: "2026-06-01T00:00:00.000Z",
    });
    const completed = createIssue({
      id: "2",
      identifier: "ISSUE-2",
      priority: 1,
      createdAt: "2026-06-02T00:00:00.000Z",
    });

    const order = computeDispatchOrder({
      issues: [older, completed],
      anchors: {
        "2": createAnchor(completed),
      },
      completedIssueIds: new Set(["2"]),
      terminalStates: TERMINAL_STATES,
      now: NOW,
    });

    expect(
      order.positions.map((position) => position.issue_identifier),
    ).toEqual(["ISSUE-1", "ISSUE-2"]);
  });

  it("ignores anchors after until-date expiry", () => {
    const older = createIssue({
      id: "1",
      identifier: "ISSUE-1",
      priority: 1,
      createdAt: "2026-06-01T00:00:00.000Z",
    });
    const expired = createIssue({
      id: "2",
      identifier: "ISSUE-2",
      priority: 1,
      createdAt: "2026-06-02T00:00:00.000Z",
    });

    const order = computeDispatchOrder({
      issues: [older, expired],
      anchors: {
        "2": createAnchor(
          expired,
          { kind: "top" },
          {
            kind: "until_date",
            at: "2026-06-13T11:59:59.000Z",
          },
        ),
      },
      terminalStates: TERMINAL_STATES,
      now: NOW,
    });

    expect(
      order.positions.map((position) => position.issue_identifier),
    ).toEqual(["ISSUE-1", "ISSUE-2"]);
  });
});

function createIssue(overrides: Partial<Issue>): Issue {
  return {
    id: overrides.id ?? "1",
    identifier: overrides.identifier ?? "ISSUE-1",
    title: overrides.title ?? "Example issue",
    description: overrides.description ?? null,
    priority: overrides.priority ?? 1,
    state: overrides.state ?? "In Progress",
    branchName: overrides.branchName ?? null,
    url: overrides.url ?? null,
    labels: overrides.labels ?? [],
    blockedBy: overrides.blockedBy ?? [],
    createdAt: overrides.createdAt ?? "2026-06-01T00:00:00.000Z",
    updatedAt: overrides.updatedAt ?? "2026-06-01T00:00:00.000Z",
  };
}

function createAnchor(
  issue: Issue,
  placement: IssueAnchorRecord["placement"] = { kind: "top" },
  expiry: IssueAnchorRecord["expiry"] = { kind: "until_merged" },
): IssueAnchorRecord {
  return {
    issueId: issue.id,
    issueIdentifier: issue.identifier,
    placement,
    expiry,
    actor: { kind: "operator", host: "local", session: null },
    reason: { class: "operator_order", human: "Prioritize this issue" },
    source: "api",
    fieldName: null,
    editorEmail: "operator@example.com",
    setAt: "2026-06-13T12:00:00.000Z",
    setBySequence: 1,
  };
}

function createFeature(
  issue: Issue,
  blockedBy: TicketFeatureTrustedEdge[] = [],
): TicketFeature {
  return {
    issue: {
      id: issue.id,
      identifier: issue.identifier,
      title: issue.title,
      state: issue.state,
      priority: issue.priority,
      url: issue.url,
      createdAt: issue.createdAt,
      updatedAt: issue.updatedAt,
    },
    provenance: {
      class: "pipeline_generated",
      matchedLabels: [],
      issueAuthor: null,
    },
    specLineage: {
      parent: null,
      blockedBy,
    },
    relationSummary: {
      totalEdges: blockedBy.length,
      operatorConfirmedEdges: blockedBy.filter(
        (edge) => edge.trust === "operator_confirmed",
      ).length,
      advisoryEdges: blockedBy.filter((edge) => edge.trust === "advisory")
        .length,
      missingAuthorEdges: 0,
      serviceAccountEdges: 0,
      historyTruncatedEdges: 0,
    },
    sourceVisibility: {
      relationPageTruncated: false,
      relationHistoryTruncated: false,
    },
    components: {
      labels: [],
      overlappingIssueIdentifiers: [],
    },
    acPosture: {
      kind: "neither",
      hasAuthorAcceptanceCriteria: false,
      frozenSnapshot: null,
    },
    intentSufficiency: {
      status: "sufficient",
      signals: [],
      rationale: "fixture",
    },
  };
}

function createEdge(
  issue: Issue,
  trust: TicketFeatureTrustedEdge["trust"],
  advisoryReason: TicketFeatureTrustedEdge["advisoryReason"],
): TicketFeatureTrustedEdge {
  return {
    kind: "blocked_by",
    relationId: null,
    relationType: "blocks",
    issue: {
      id: issue.id,
      identifier: issue.identifier,
      title: issue.title,
      state: issue.state,
    },
    author: null,
    authoredAt: null,
    attributionSource: "missing",
    trust,
    authorClass:
      trust === "operator_confirmed" ? "operator" : "service_account",
    advisoryReason,
  };
}
