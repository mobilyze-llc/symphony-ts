import { describe, expect, it } from "vitest";

import { ERROR_CODES } from "../../src/errors/codes.js";
import {
  type TrackerError,
  normalizeLinearIssue,
  normalizeLinearIssueState,
} from "../../src/index.js";

describe("linear-normalize", () => {
  it("normalizes labels, blockers, relations, parent/children, integer priority, and timestamps", () => {
    const issue = normalizeLinearIssue({
      id: "issue-1",
      identifier: "ENG-123",
      title: "Implement adapter",
      description: "Tracker integration",
      priority: 2,
      branchName: "eng-123",
      url: "https://linear.app/eng/issue/ENG-123",
      createdAt: "2026-03-01T00:00:00.000Z",
      updatedAt: "2026-03-02T12:34:56.789Z",
      state: {
        name: "Todo",
      },
      labels: {
        nodes: [{ name: "Backend" }, { name: "TRACKER" }],
      },
      relations: {
        nodes: [
          {
            type: "supersedes",
            relatedIssue: {
              id: "issue-old",
              identifier: "ENG-99",
              title: "Old ticket",
              state: {
                name: "Todo",
              },
            },
          },
        ],
      },
      inverseRelations: {
        nodes: [
          {
            type: "blocks",
            issue: {
              id: "issue-0",
              identifier: "ENG-100",
              state: {
                name: "In Progress",
              },
            },
          },
          {
            type: "relatesTo",
            issue: {
              id: "issue-x",
              identifier: "ENG-X",
              title: "Related work",
              state: {
                name: "Todo",
              },
            },
          },
          {
            type: "duplicate",
            issue: {
              id: "issue-dupe",
              identifier: "ENG-101",
              title: "Older duplicate",
              state: {
                name: "Backlog",
              },
            },
          },
          {
            type: "supersedes",
            issue: {
              id: "issue-newer",
              identifier: "ENG-124",
              title: "Replacement ticket",
              state: {
                name: "Backlog",
              },
            },
          },
        ],
      },
      parent: {
        id: "issue-parent",
        identifier: "ENG-1",
        title: "Parent epic",
        state: {
          name: "Backlog",
        },
      },
      children: {
        nodes: [
          {
            id: "issue-child",
            identifier: "ENG-124",
            title: "Child task",
            state: {
              name: "Todo",
            },
          },
        ],
      },
    });

    expect(issue).toEqual({
      id: "issue-1",
      identifier: "ENG-123",
      title: "Implement adapter",
      description: "Tracker integration",
      priority: 2,
      state: "Todo",
      branchName: "eng-123",
      url: "https://linear.app/eng/issue/ENG-123",
      labels: ["backend", "tracker"],
      documentAttachments: [],
      blockedBy: [
        {
          id: "issue-0",
          identifier: "ENG-100",
          state: "In Progress",
        },
      ],
      relatesTo: [
        {
          id: "issue-x",
          identifier: "ENG-X",
          title: "Related work",
          state: "Todo",
        },
      ],
      duplicates: [
        {
          id: "issue-dupe",
          identifier: "ENG-101",
          title: "Older duplicate",
          state: "Backlog",
        },
      ],
      supersededBy: [
        {
          id: "issue-newer",
          identifier: "ENG-124",
          title: "Replacement ticket",
          state: "Backlog",
        },
      ],
      supersedes: [
        {
          id: "issue-old",
          identifier: "ENG-99",
          title: "Old ticket",
          state: "Todo",
        },
      ],
      parent: {
        id: "issue-parent",
        identifier: "ENG-1",
        title: "Parent epic",
        state: "Backlog",
      },
      children: [
        {
          id: "issue-child",
          identifier: "ENG-124",
          title: "Child task",
          state: "Todo",
        },
      ],
      createdAt: "2026-03-01T00:00:00.000Z",
      updatedAt: "2026-03-02T12:34:56.789Z",
    });
  });

  it("preserves inverse supersede relation direction as superseded-by", () => {
    const issue = normalizeLinearIssue({
      id: "issue-1",
      identifier: "ENG-123",
      title: "Implement adapter",
      state: {
        name: "Todo",
      },
      inverseRelations: {
        nodes: [
          {
            type: "supersedes",
            issue: {
              id: "issue-newer",
              identifier: "ENG-124",
              title: "Replacement ticket",
              state: {
                name: "Backlog",
              },
            },
          },
        ],
      },
    });

    expect(issue.supersedes).toBeUndefined();
    expect(issue.supersededBy).toEqual([
      {
        id: "issue-newer",
        identifier: "ENG-124",
        title: "Replacement ticket",
        state: "Backlog",
      },
    ]);
  });

  it("preserves forward supersede relation direction as supersedes", () => {
    const issue = normalizeLinearIssue({
      id: "issue-1",
      identifier: "ENG-123",
      title: "Implement adapter",
      state: {
        name: "Todo",
      },
      relations: {
        nodes: [
          {
            type: "supersedes",
            relatedIssue: {
              id: "issue-old",
              identifier: "ENG-122",
              title: "Old ticket",
              state: {
                name: "Backlog",
              },
            },
          },
        ],
      },
    });

    expect(issue.supersededBy).toBeUndefined();
    expect(issue.supersedes).toEqual([
      {
        id: "issue-old",
        identifier: "ENG-122",
        title: "Old ticket",
        state: "Backlog",
      },
    ]);
  });

  it("accepts legacy blocker payloads that still use sourceIssue", () => {
    const issue = normalizeLinearIssue({
      id: "issue-1",
      identifier: "ENG-123",
      title: "Implement adapter",
      state: {
        name: "Todo",
      },
      inverseRelations: {
        nodes: [
          {
            type: "blocks",
            sourceIssue: {
              id: "issue-0",
              identifier: "ENG-100",
              state: {
                name: "In Progress",
              },
            },
          },
        ],
      },
    });

    expect(issue.blockedBy).toEqual([
      {
        id: "issue-0",
        identifier: "ENG-100",
        state: "In Progress",
      },
    ]);
  });

  it("marks native blockedBy relations as truncated when Linear reports another relation page", () => {
    const issue = normalizeLinearIssue({
      id: "issue-1",
      identifier: "ENG-123",
      title: "Implement adapter",
      state: {
        name: "Todo",
      },
      inverseRelations: {
        nodes: [
          {
            type: "relatesTo",
            issue: {
              id: "issue-x",
              identifier: "ENG-X",
              state: {
                name: "Todo",
              },
            },
          },
        ],
        pageInfo: {
          hasNextPage: true,
        },
      },
    });

    expect(issue.blockedBy).toEqual([]);
    expect(issue.blockedByRelationTruncated).toBe(true);
  });

  it("returns null for non-integer priority and invalid timestamps", () => {
    const issue = normalizeLinearIssue({
      id: "issue-1",
      identifier: "ENG-123",
      title: "Implement adapter",
      priority: 1.5,
      createdAt: "not-a-date",
      updatedAt: null,
      state: {
        name: "Todo",
      },
    });

    expect(issue.priority).toBeNull();
    expect(issue.createdAt).toBeNull();
    expect(issue.updatedAt).toBeNull();
  });

  it("normalizes issue state snapshots for reconciliation", () => {
    expect(
      normalizeLinearIssueState({
        id: "issue-1",
        identifier: "ENG-123",
        state: {
          name: "Done",
        },
      }),
    ).toEqual({
      id: "issue-1",
      identifier: "ENG-123",
      state: "Done",
    });
  });

  it("rejects malformed issue payloads with a typed tracker error", () => {
    expect(() => normalizeLinearIssue(null)).toThrowError(
      expect.objectContaining<Partial<TrackerError>>({
        code: ERROR_CODES.linearUnknownPayload,
      }),
    );
  });
});
