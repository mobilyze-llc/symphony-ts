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

  it("linearizes an empty candidate set", () => {
    const order = computeDispatchOrder({
      issues: [],
      anchors: {},
      terminalStates: TERMINAL_STATES,
      now: NOW,
    });

    expect(order).toMatchObject({
      status: "linearized",
      positions: [],
      exclusions: [],
      advisory_warnings: [],
      would_have_been_excluded_by_advisory_edges: [],
      hard_cycle: null,
    });
  });

  it("surfaces hard cycles while linearizing unrelated candidates", () => {
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
      createIssue({
        id: "3",
        identifier: "ISSUE-3",
        priority: 1,
        createdAt: "2026-06-03T00:00:00.000Z",
      }),
    ];

    const order = computeDispatchOrder({
      issues,
      anchors: {},
      terminalStates: TERMINAL_STATES,
      now: NOW,
    });

    expect(order.status).toBe("linearized");
    expect(
      order.positions.map((position) => position.issue_identifier),
    ).toEqual(["ISSUE-3"]);
    expect(
      order.exclusions.map((exclusion) => exclusion.issue_identifier),
    ).toEqual(["ISSUE-1", "ISSUE-2"]);
    expect(order.hard_cycle?.issue_identifiers).toEqual(["ISSUE-1", "ISSUE-2"]);
  });

  it("surfaces multiple disjoint hard cycles with bounded diagnostics", () => {
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
      createIssue({
        id: "3",
        identifier: "ISSUE-3",
        blockedBy: [{ id: "4", identifier: "ISSUE-4", state: "In Progress" }],
      }),
      createIssue({
        id: "4",
        identifier: "ISSUE-4",
        blockedBy: [{ id: "3", identifier: "ISSUE-3", state: "In Progress" }],
      }),
      createIssue({ id: "5", identifier: "ISSUE-5" }),
    ];

    const order = computeDispatchOrder({
      issues,
      anchors: {},
      terminalStates: TERMINAL_STATES,
      now: NOW,
    });

    expect(
      order.positions.map((position) => position.issue_identifier),
    ).toEqual(["ISSUE-5"]);
    expect(order.hard_cycles).toHaveLength(2);
    expect(order.hard_cycle_omitted_count).toBe(0);
    expect(
      order.hard_cycles.map((cycle) => [...cycle.issue_identifiers].sort()),
    ).toEqual([
      ["ISSUE-1", "ISSUE-2"],
      ["ISSUE-3", "ISSUE-4"],
    ]);
    expect(order.hard_cycle?.issue_identifiers).toEqual(["ISSUE-1", "ISSUE-2"]);
    expect(order.warnings).toContain(
      "Dispatch comparator detected 2 hard dependency cycle(s); 0 additional cycle(s) omitted by diagnostic cap 5.",
    );
    expect(order.warnings).toContain(
      "Hard-cycle diagnostics report a bounded disjoint-cycle sample; overlapping cycles that share a reported issue are represented by that reported cycle, and hard_cycle_omitted_count counts only cycles omitted by the diagnostic cap.",
    );
  });

  it("counts hard cycles omitted by the diagnostic cap", () => {
    const cycleIssues = Array.from({ length: 6 }, (_, index) => {
      const leftId = String(index * 2 + 1);
      const rightId = String(index * 2 + 2);
      return [
        createIssue({
          id: leftId,
          identifier: `ISSUE-${leftId}`,
          blockedBy: [
            {
              id: rightId,
              identifier: `ISSUE-${rightId}`,
              state: "In Progress",
            },
          ],
        }),
        createIssue({
          id: rightId,
          identifier: `ISSUE-${rightId}`,
          blockedBy: [
            { id: leftId, identifier: `ISSUE-${leftId}`, state: "In Progress" },
          ],
        }),
      ];
    }).flat();
    const unrelated = createIssue({ id: "99", identifier: "ISSUE-99" });

    const order = computeDispatchOrder({
      issues: [...cycleIssues, unrelated],
      anchors: {},
      terminalStates: TERMINAL_STATES,
      now: NOW,
    });

    expect(
      order.positions.map((position) => position.issue_identifier),
    ).toEqual(["ISSUE-99"]);
    expect(order.hard_cycles).toHaveLength(5);
    expect(order.hard_cycle_omitted_count).toBe(1);
    expect(order.warnings).toContain(
      "Dispatch comparator detected 5 hard dependency cycle(s); 1 additional cycle(s) omitted by diagnostic cap 5.",
    );
  });

  it("documents overlapping hard cycles as a disjoint diagnostic sample", () => {
    const issues = [
      createIssue({
        id: "1",
        identifier: "ISSUE-1",
        blockedBy: [{ id: "2", identifier: "ISSUE-2", state: "In Progress" }],
      }),
      createIssue({
        id: "2",
        identifier: "ISSUE-2",
        blockedBy: [
          { id: "1", identifier: "ISSUE-1", state: "In Progress" },
          { id: "3", identifier: "ISSUE-3", state: "In Progress" },
        ],
      }),
      createIssue({
        id: "3",
        identifier: "ISSUE-3",
        blockedBy: [{ id: "2", identifier: "ISSUE-2", state: "In Progress" }],
      }),
      createIssue({ id: "4", identifier: "ISSUE-4" }),
    ];

    const order = computeDispatchOrder({
      issues,
      anchors: {},
      terminalStates: TERMINAL_STATES,
      now: NOW,
    });

    expect(
      order.positions.map((position) => position.issue_identifier),
    ).toEqual(["ISSUE-4"]);
    expect(order.hard_cycles).toHaveLength(1);
    expect(order.hard_cycle_omitted_count).toBe(0);
    expect([...(order.hard_cycles[0]?.issue_identifiers ?? [])].sort()).toEqual(
      ["ISSUE-1", "ISSUE-2"],
    );
    expect(
      order.exclusions.map((exclusion) => exclusion.issue_identifier),
    ).toEqual(["ISSUE-1", "ISSUE-2", "ISSUE-2", "ISSUE-3"]);
    expect(order.warnings).toContain(
      "Hard-cycle diagnostics report a bounded disjoint-cycle sample; overlapping cycles that share a reported issue are represented by that reported cycle, and hard_cycle_omitted_count counts only cycles omitted by the diagnostic cap.",
    );
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

  it("dedupes would-have-been advisory exclusions", () => {
    const blocker = createIssue({ id: "1", identifier: "ISSUE-1" });
    const dependent = createIssue({ id: "2", identifier: "ISSUE-2" });

    const order = computeDispatchOrder({
      issues: [dependent, blocker],
      anchors: {},
      ticketFeatures: [
        createFeature(dependent, [
          createEdge(blocker, "advisory", "service_account"),
          createEdge(blocker, "advisory", "service_account"),
        ]),
        createFeature(blocker),
      ],
      terminalStates: TERMINAL_STATES,
      now: NOW,
    });

    expect(order.advisory_warnings).toHaveLength(1);
    expect(order.would_have_been_excluded_by_advisory_edges).toHaveLength(1);
  });

  it("does not count advisory would-have exclusions for already hard-excluded issues", () => {
    const hardBlocker = createIssue({ id: "1", identifier: "ISSUE-1" });
    const advisoryBlocker = createIssue({ id: "2", identifier: "ISSUE-2" });
    const dependent = createIssue({ id: "3", identifier: "ISSUE-3" });

    const order = computeDispatchOrder({
      issues: [dependent, hardBlocker, advisoryBlocker],
      anchors: {},
      ticketFeatures: [
        createFeature(dependent, [
          createEdge(hardBlocker, "operator_confirmed", null),
          createEdge(advisoryBlocker, "advisory", "service_account"),
        ]),
        createFeature(hardBlocker),
        createFeature(advisoryBlocker),
      ],
      terminalStates: TERMINAL_STATES,
      now: NOW,
    });

    expect(order.exclusions).toHaveLength(1);
    expect(order.advisory_warnings).toHaveLength(1);
    expect(order.would_have_been_excluded_by_advisory_edges).toEqual([]);
  });

  it("suppresses advisory warnings for the same pair as a preserved native hard blocker", () => {
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
          createEdge(blocker, "advisory", "not_allowlisted"),
        ]),
        createFeature(blocker),
      ],
      terminalStates: TERMINAL_STATES,
      now: NOW,
    });

    expect(order.exclusions).toMatchObject([
      {
        issue_identifier: "ISSUE-1",
        blocker_issue_identifier: "ISSUE-2",
        edge_trust: "legacy_hard",
      },
    ]);
    expect(order.advisory_warnings).toEqual([]);
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

  it("ignores terminal hard blockers when computing ordering constraints", () => {
    const dependent = createIssue({
      id: "1",
      identifier: "ISSUE-1",
      priority: 1,
    });
    const terminalBlocker = createIssue({
      id: "2",
      identifier: "ISSUE-2",
      priority: 3,
      state: "Done",
    });

    const order = computeDispatchOrder({
      issues: [dependent, terminalBlocker],
      anchors: {},
      ticketFeatures: [
        createFeature(dependent, [
          createEdge(terminalBlocker, "operator_confirmed", null),
        ]),
        createFeature(terminalBlocker),
      ],
      terminalStates: TERMINAL_STATES,
      now: NOW,
    });

    expect(order.exclusions).toEqual([]);
    expect(
      order.positions.map((position) => position.issue_identifier),
    ).toEqual(["ISSUE-1", "ISSUE-2"]);
  });

  it("does not warn for advisory blockers that are terminal", () => {
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
          createEdge(blocker, "advisory", "service_account"),
        ]),
        createFeature(blocker),
      ],
      terminalStates: TERMINAL_STATES,
      now: NOW,
    });

    expect(order.exclusions).toEqual([]);
    expect(order.advisory_warnings).toEqual([]);
    expect(order.would_have_been_excluded_by_advisory_edges).toEqual([]);
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
    expect(order.superseded_native_hard_blockers).toMatchObject([
      {
        issue_identifier: "ISSUE-1",
        blocker_issue_identifier: "ISSUE-2",
        advisory_reason: "service_account",
      },
    ]);
    expect(
      order.positions.map((position) => position.issue_identifier),
    ).toEqual(["ISSUE-1", "ISSUE-2"]);
  });

  it("preserves native hard blockers when TicketFeature trust is not allowlisted", () => {
    const blocker = createIssue({ id: "2", identifier: "ISSUE-2" });
    const dependent = createIssue({
      id: "1",
      identifier: "ISSUE-1",
      blockedBy: [
        {
          id: "2",
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
          createEdge(blocker, "advisory", "not_allowlisted"),
        ]),
        createFeature(blocker),
      ],
      terminalStates: TERMINAL_STATES,
      now: NOW,
    });

    expect(order.exclusions).toMatchObject([
      {
        issue_identifier: "ISSUE-1",
        blocker_issue_identifier: "ISSUE-2",
        edge_trust: "legacy_hard",
      },
    ]);
    expect(
      order.positions.map((position) => position.issue_identifier),
    ).toEqual(["ISSUE-2"]);
  });

  it("fails closed when native blockedBy relations are truncated without TicketFeature trust", () => {
    const candidate = createIssue({
      id: "1",
      identifier: "ISSUE-1",
      blockedByRelationTruncated: true,
    });
    const other = createIssue({
      id: "2",
      identifier: "ISSUE-2",
    });

    const order = computeDispatchOrder({
      issues: [candidate, other],
      anchors: {},
      terminalStates: TERMINAL_STATES,
      now: NOW,
    });

    expect(order.exclusions).toMatchObject([
      {
        issue_identifier: "ISSUE-1",
        blocker_issue_id: null,
        blocker_issue_identifier: null,
        edge_trust: "legacy_hard",
        source: "issue_blocked_by",
        reason:
          "Native blockedBy relation window was truncated before TicketFeature hard-blocker trust was available; treating candidate as possibly blocked.",
      },
    ]);
    expect(order.warnings).toContain(
      "Dispatch comparator detected truncated native blockedBy relation window for ISSUE-1; held candidate as possibly blocked.",
    );
    expect(
      order.positions.map((position) => position.issue_identifier),
    ).toEqual(["ISSUE-2"]);
  });

  it("preserves TicketFeature-supported hard-blocker discovery when native relations are truncated", () => {
    const candidate = createIssue({
      id: "1",
      identifier: "ISSUE-1",
      blockedByRelationTruncated: true,
    });
    const other = createIssue({
      id: "2",
      identifier: "ISSUE-2",
    });

    const order = computeDispatchOrder({
      issues: [candidate, other],
      anchors: {},
      ticketFeatures: [createFeature(candidate), createFeature(other)],
      terminalStates: TERMINAL_STATES,
      now: NOW,
    });

    expect(order.exclusions).toEqual([]);
    expect(order.warnings).not.toContain(
      "Dispatch comparator detected truncated native blockedBy relation window for ISSUE-1; held candidate as possibly blocked.",
    );
    expect(
      order.positions.map((position) => position.issue_identifier),
    ).toEqual(["ISSUE-1", "ISSUE-2"]);
  });

  it("warns and skips identifier-only ordering refs when candidate identifiers collide", () => {
    const duplicateA = createIssue({
      id: "a",
      identifier: "ISSUE-DUP",
      priority: 2,
      createdAt: "2026-06-03T00:00:00.000Z",
    });
    const dependent = createIssue({
      id: "c",
      identifier: "ISSUE-DEPENDENT",
      priority: 1,
      createdAt: "2026-06-01T00:00:00.000Z",
      blockedBy: [
        {
          id: null,
          identifier: "ISSUE-DUP",
          state: "Done",
        },
      ],
    });
    const duplicateB = createIssue({
      id: "b",
      identifier: "ISSUE-DUP",
      priority: 1,
      createdAt: "2026-06-02T00:00:00.000Z",
    });

    const order = computeDispatchOrder({
      issues: [duplicateA, dependent, duplicateB],
      anchors: {},
      terminalStates: TERMINAL_STATES,
      now: NOW,
    });

    expect(order.exclusions).toEqual([]);
    expect(order.warnings).toContain(
      "Dispatch comparator observed duplicate candidate identifier ISSUE-DUP; identifier-only dependency refs for that identifier are ignored to avoid nondeterministic ordering.",
    );
    expect(order.positions.map((position) => position.issue_id)).toEqual([
      "c",
      "b",
      "a",
    ]);
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

  it("keeps top anchors in natural order when their priority band has no peers", () => {
    const urgent = createIssue({
      id: "1",
      identifier: "ISSUE-1",
      priority: 1,
      createdAt: "2026-06-01T00:00:00.000Z",
    });
    const anchored = createIssue({
      id: "2",
      identifier: "ISSUE-2",
      priority: 5,
      createdAt: "2026-06-02T00:00:00.000Z",
    });
    const later = createIssue({
      id: "3",
      identifier: "ISSUE-3",
      priority: null,
      createdAt: "2026-06-03T00:00:00.000Z",
    });

    const order = computeDispatchOrder({
      issues: [urgent, anchored, later],
      anchors: {
        "2": createAnchor(anchored),
      },
      terminalStates: TERMINAL_STATES,
      now: NOW,
    });

    expect(
      order.positions.map((position) => position.issue_identifier),
    ).toEqual(["ISSUE-1", "ISSUE-2", "ISSUE-3"]);
    expect(order.positions[1]?.rationale).toContain("operator_anchor top");
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

  it("applies above anchors before their target issue", () => {
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
        "3": createAnchor(issue3, {
          kind: "above",
          issueIdentifier: "ISSUE-2",
        }),
      },
      terminalStates: TERMINAL_STATES,
      now: NOW,
    });

    expect(
      order.positions.map((position) => position.issue_identifier),
    ).toEqual(["ISSUE-1", "ISSUE-3", "ISSUE-2"]);
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

  it("preserves natural order and warns when a below anchor target is unavailable", () => {
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
          kind: "below",
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

  it("preserves natural order and warns when a relative anchor targets itself", () => {
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

    const order = computeDispatchOrder({
      issues: [issue1, issue2],
      anchors: {
        "2": createAnchor(issue2, {
          kind: "above",
          issueIdentifier: "issue-2",
        }),
      },
      terminalStates: TERMINAL_STATES,
      now: NOW,
    });

    expect(
      order.positions.map((position) => position.issue_identifier),
    ).toEqual(["ISSUE-1", "ISSUE-2"]);
    expect(order.warnings).toContain(
      "Operator anchor for ISSUE-2 references invalid target issue-2: anchor target issue-2 references ISSUE-2 itself; preserved natural priority/FIFO position.",
    );
  });

  it("preserves natural order and warns when a relative anchor targets the pipeline sentinel", () => {
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

    const order = computeDispatchOrder({
      issues: [issue1, issue2],
      anchors: {
        "2": createAnchor(issue2, {
          kind: "below",
          issueIdentifier: "PIPELINE",
        }),
      },
      terminalStates: TERMINAL_STATES,
      now: NOW,
    });

    expect(
      order.positions.map((position) => position.issue_identifier),
    ).toEqual(["ISSUE-1", "ISSUE-2"]);
    expect(order.warnings).toContain(
      "Operator anchor for ISSUE-2 references invalid target PIPELINE: anchor target PIPELINE is the pipeline sentinel, not an issue; preserved natural priority/FIFO position.",
    );
  });

  it("resolves relative anchor targets case-insensitively", () => {
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

    const order = computeDispatchOrder({
      issues: [issue1, issue2],
      anchors: {
        "1": createAnchor(issue1, {
          kind: "below",
          issueIdentifier: "issue-2",
        }),
      },
      terminalStates: TERMINAL_STATES,
      now: NOW,
    });

    expect(
      order.positions.map((position) => position.issue_identifier),
    ).toEqual(["ISSUE-2", "ISSUE-1"]);
    expect(order.warnings).toEqual([]);
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
    priority: overrides.priority === undefined ? 1 : overrides.priority,
    state: overrides.state ?? "In Progress",
    branchName: overrides.branchName ?? null,
    url: overrides.url ?? null,
    labels: overrides.labels ?? [],
    blockedBy: overrides.blockedBy ?? [],
    ...(overrides.blockedByRelationTruncated === undefined
      ? {}
      : { blockedByRelationTruncated: overrides.blockedByRelationTruncated }),
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
