import { afterEach, describe, expect, it, vi } from "vitest";

import { ERROR_CODES } from "../../src/errors/codes.js";
import {
  LINEAR_CANDIDATE_ISSUES_QUERY,
  LINEAR_CREATE_ISSUE_MUTATION,
  LINEAR_ISSUE_BY_IDENTIFIER_QUERY,
  LINEAR_ISSUE_COMMENTS_QUERY,
  LINEAR_ISSUE_DETAILS_UPDATE_MUTATION,
  LINEAR_ISSUE_LABELS_BY_NAMES_QUERY,
  LINEAR_ISSUE_STATES_BY_IDS_QUERY,
  LINEAR_OPEN_ISSUES_BY_TITLE_QUERY,
  LINEAR_TICKET_FEATURE_ISSUES_QUERY,
  LINEAR_UPDATE_ISSUE_DESCRIPTION_MUTATION,
  LinearTrackerClient,
  type TrackerError,
} from "../../src/index.js";
import {
  LINEAR_CANDIDATE_ISSUES_BY_SCOPE_QUERY,
  buildCandidateScopeFilter,
} from "../../src/tracker/linear-queries.js";

afterEach(() => {
  vi.restoreAllMocks();
});

describe("LinearTrackerClient", () => {
  it("fetches candidate issues with the required slugId project filter and pagination", async () => {
    const fetchFn = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        jsonResponse({
          data: {
            issues: {
              nodes: [
                issueNode({
                  id: "1",
                  identifier: "ENG-1",
                  title: "First",
                  createdAt: "2026-03-01T00:00:00.000Z",
                }),
              ],
              pageInfo: {
                hasNextPage: true,
                endCursor: "cursor-1",
              },
            },
          },
        }),
      )
      .mockResolvedValueOnce(
        jsonResponse({
          data: {
            issues: {
              nodes: [
                issueNode({
                  id: "2",
                  identifier: "ENG-2",
                  title: "Second",
                  createdAt: "2026-03-02T00:00:00.000Z",
                }),
              ],
              pageInfo: {
                hasNextPage: false,
                endCursor: null,
              },
            },
          },
        }),
      );

    const client = createClient({ fetchFn });
    const issues = await client.fetchCandidateIssues();

    expect(issues.map((issue) => issue.identifier)).toEqual(["ENG-1", "ENG-2"]);
    expect(fetchFn).toHaveBeenCalledTimes(2);

    const firstCall = fetchFn.mock.calls[0];
    expect(firstCall?.[0]).toBe("https://api.linear.app/graphql");

    const firstRequest = parseRequestBody(firstCall?.[1]);
    expect(firstRequest.query).toContain("slugId");
    expect(firstRequest.query).toBe(LINEAR_CANDIDATE_ISSUES_QUERY);
    expect(firstRequest.query).toMatch(
      /inverseRelations\(first: \$relationFirst\)[\s\S]*pageInfo[\s\S]*hasNextPage/,
    );
    expect(firstRequest.variables).toEqual({
      projectSlug: "ENG",
      activeStates: ["Todo", "In Progress"],
      first: 50,
      relationFirst: 50,
      after: null,
    });

    const secondRequest = parseRequestBody(fetchFn.mock.calls[1]?.[1]);
    expect(secondRequest.variables).toEqual({
      projectSlug: "ENG",
      activeStates: ["Todo", "In Progress"],
      first: 50,
      relationFirst: 50,
      after: "cursor-1",
    });
  });

  it("fetchCandidateIssuesByScope sends the composed additive filter and paginates (SYMPH-858)", async () => {
    const fetchFn = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        jsonResponse({
          data: {
            issues: {
              nodes: [
                issueNode({
                  id: "1",
                  identifier: "MOB-1",
                  title: "First",
                  createdAt: "2026-06-01T00:00:00.000Z",
                }),
              ],
              pageInfo: { hasNextPage: true, endCursor: "cursor-1" },
            },
          },
        }),
      )
      .mockResolvedValueOnce(
        jsonResponse({
          data: {
            issues: {
              nodes: [
                issueNode({
                  id: "2",
                  identifier: "MOB-2",
                  title: "Second",
                  createdAt: "2026-06-02T00:00:00.000Z",
                }),
              ],
              pageInfo: { hasNextPage: false, endCursor: null },
            },
          },
        }),
      );

    const client = createClient({ fetchFn });
    const issues = await client.fetchCandidateIssuesByScope({
      teamKeys: ["MOB"],
      projectSlug: "abc123",
      initiative: "Healthspanners",
    });

    expect(issues.map((issue) => issue.identifier)).toEqual(["MOB-1", "MOB-2"]);
    expect(fetchFn).toHaveBeenCalledTimes(2);

    const firstRequest = parseRequestBody(fetchFn.mock.calls[0]?.[1]);
    // Composed single-$filter query (NOT one of the dispatch-trigger queries).
    expect(firstRequest.query).toBe(LINEAR_CANDIDATE_ISSUES_BY_SCOPE_QUERY);
    expect(firstRequest.variables).toEqual({
      filter: buildCandidateScopeFilter({
        teamKeys: ["MOB"],
        projectSlug: "abc123",
        initiative: "Healthspanners",
        activeStates: ["Todo", "In Progress"],
      }),
      first: 50,
      relationFirst: 50,
      after: null,
    });

    const secondRequest = parseRequestBody(fetchFn.mock.calls[1]?.[1]);
    expect(secondRequest.variables.after).toBe("cursor-1");
  });

  it("fetchCandidateIssuesByScope rejects an empty scope rather than fetching the whole workspace (SYMPH-858)", async () => {
    const fetchFn = vi.fn<typeof fetch>();
    const client = createClient({ fetchFn });
    await expect(client.fetchCandidateIssuesByScope({})).rejects.toThrow(
      /at least one/i,
    );
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it("fetches candidate issues by team key (eligible backlog, no project filter) when team_keys is set (SYMPH-794)", async () => {
    const fetchFn = vi.fn<typeof fetch>().mockResolvedValueOnce(
      jsonResponse({
        data: {
          issues: {
            nodes: [
              issueNode({
                id: "1",
                identifier: "SYMPH-900",
                title: "Backlog ticket",
                createdAt: "2026-06-01T00:00:00.000Z",
              }),
            ],
            pageInfo: { hasNextPage: false, endCursor: null },
          },
        },
      }),
    );

    const client = createClient({ fetchFn, teamKeys: ["SYMPH"] });
    const issues = await client.fetchCandidateIssues();

    expect(issues.map((issue) => issue.identifier)).toEqual(["SYMPH-900"]);
    const request = parseRequestBody(fetchFn.mock.calls[0]?.[1]);
    // The dispatch trigger is the team backlog, NOT project membership: the
    // candidate query must filter by team key and must NOT carry a project
    // filter (setting/clearing `project` can never arm or disarm dispatch).
    expect(request.query).toContain("team: { key: { in: $teamKeys } }");
    expect(request.query).not.toContain("project:");
    expect(request.variables).toEqual({
      teamKeys: ["SYMPH"],
      activeStates: ["Todo", "In Progress"],
      first: 50,
      relationFirst: 50,
      after: null,
    });
  });

  it("supports multiple team keys via the `in` filter (multi-team-ready, SYMPH-819)", async () => {
    const fetchFn = vi.fn<typeof fetch>().mockResolvedValueOnce(
      jsonResponse({
        data: {
          issues: {
            nodes: [],
            pageInfo: { hasNextPage: false, endCursor: null },
          },
        },
      }),
    );

    const client = createClient({ fetchFn, teamKeys: ["SYMPH", "MOB"] });
    await client.fetchCandidateIssues();

    const request = parseRequestBody(fetchFn.mock.calls[0]?.[1]);
    expect(request.variables.teamKeys).toEqual(["SYMPH", "MOB"]);
  });

  it("team-scoped candidate fetch does not require a project slug (SYMPH-794)", async () => {
    const fetchFn = vi.fn<typeof fetch>().mockResolvedValueOnce(
      jsonResponse({
        data: {
          issues: {
            nodes: [],
            pageInfo: { hasNextPage: false, endCursor: null },
          },
        },
      }),
    );

    const client = createClient({
      fetchFn,
      projectSlug: null,
      teamKeys: ["SYMPH"],
    });

    await expect(client.fetchCandidateIssues()).resolves.toEqual([]);
  });

  it("returns empty immediately when fetchIssuesByStates receives no states", async () => {
    const fetchFn = vi.fn<typeof fetch>();
    const client = createClient({ fetchFn });

    await expect(client.fetchIssuesByStates([])).resolves.toEqual([]);
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it("returns empty immediately when fetchTicketFeatureIssuesByStates receives no states", async () => {
    const fetchFn = vi.fn<typeof fetch>();
    const client = createClient({ fetchFn });

    await expect(client.fetchTicketFeatureIssuesByStates([])).resolves.toEqual(
      [],
    );
    expect(fetchFn).not.toHaveBeenCalled();
  });

  // --- SYMPH-824: team-scoped adjacent dispatch-path queries ---
  // The candidate query was team-scoped in SYMPH-794; these three adjacent
  // queries (by-states, ticket-feature provenance, halt-label) now mirror the
  // same `team: { key: { in: $teamKeys } }` pattern so dispatch can run fully
  // project-free in team-scope mode. The project-scoped path must stay intact.

  it("fetches issues by states scoped to team keys (no project filter) when team_keys is set (SYMPH-824)", async () => {
    const fetchFn = vi.fn<typeof fetch>().mockResolvedValueOnce(
      jsonResponse({
        data: {
          issues: {
            nodes: [
              issueNode({
                id: "1",
                identifier: "SYMPH-901",
                title: "Active ticket",
                createdAt: "2026-06-01T00:00:00.000Z",
              }),
            ],
            pageInfo: { hasNextPage: false, endCursor: null },
          },
        },
      }),
    );

    const client = createClient({
      fetchFn,
      projectSlug: null,
      teamKeys: ["SYMPH"],
    });
    const issues = await client.fetchIssuesByStates(["In Progress"]);

    expect(issues.map((issue) => issue.identifier)).toEqual(["SYMPH-901"]);
    const request = parseRequestBody(fetchFn.mock.calls[0]?.[1]);
    expect(request.query).toContain("team: { key: { in: $teamKeys } }");
    expect(request.query).not.toContain("project:");
    expect(request.variables).toEqual({
      teamKeys: ["SYMPH"],
      stateNames: ["In Progress"],
      first: 50,
      relationFirst: 50,
      after: null,
    });
  });

  it("fetchIssuesByStates supports multiple team keys via the `in` filter (SYMPH-824)", async () => {
    const fetchFn = vi.fn<typeof fetch>().mockResolvedValueOnce(
      jsonResponse({
        data: {
          issues: {
            nodes: [],
            pageInfo: { hasNextPage: false, endCursor: null },
          },
        },
      }),
    );
    const client = createClient({
      fetchFn,
      projectSlug: null,
      teamKeys: ["SYMPH", "MOB"],
    });
    await client.fetchIssuesByStates(["In Progress"]);
    const request = parseRequestBody(fetchFn.mock.calls[0]?.[1]);
    expect(request.variables.teamKeys).toEqual(["SYMPH", "MOB"]);
  });

  it("keeps fetchIssuesByStates project-scoped when team_keys is unset (backward compat, SYMPH-824)", async () => {
    const fetchFn = vi.fn<typeof fetch>().mockResolvedValueOnce(
      jsonResponse({
        data: {
          issues: {
            nodes: [],
            pageInfo: { hasNextPage: false, endCursor: null },
          },
        },
      }),
    );
    const client = createClient({ fetchFn });
    await client.fetchIssuesByStates(["In Progress"]);
    const request = parseRequestBody(fetchFn.mock.calls[0]?.[1]);
    expect(request.query).toContain("slugId");
    expect(request.query).not.toContain("team: { key: { in: $teamKeys } }");
    expect(request.variables).toEqual({
      projectSlug: "ENG",
      stateNames: ["In Progress"],
      first: 50,
      relationFirst: 50,
      after: null,
    });
  });

  it("fetches ticket-feature issues scoped to team keys (full provenance, no project) when team_keys is set (SYMPH-824)", async () => {
    const fetchFn = vi.fn<typeof fetch>().mockResolvedValueOnce(
      jsonResponse({
        data: {
          issues: {
            nodes: [
              ticketFeatureIssueNode({
                id: "issue-901",
                identifier: "SYMPH-901",
                title: "Off-project team ticket",
              }),
            ],
            pageInfo: { hasNextPage: false, endCursor: null },
          },
        },
      }),
    );

    const client = createClient({
      fetchFn,
      projectSlug: null,
      teamKeys: ["SYMPH"],
    });
    const issues = await client.fetchTicketFeatureIssuesByStates(["Backlog"]);

    // Off-project team tickets get the SAME full TicketFeature provenance shape
    // (creator, history, relationChanges) as project-scoped products.
    expect(issues.map((issue) => issue.identifier)).toEqual(["SYMPH-901"]);
    const request = parseRequestBody(fetchFn.mock.calls[0]?.[1]);
    expect(request.query).toContain("team: { key: { in: $teamKeys } }");
    expect(request.query).toContain("history(first: $historyFirst)");
    expect(request.query).toContain("relationChanges");
    expect(request.query).toContain("creator");
    expect(request.query).not.toContain("slugId");
    expect(request.query).not.toContain("project: {");
    expect(request.variables).toEqual({
      teamKeys: ["SYMPH"],
      stateNames: ["Backlog"],
      first: 50,
      relationFirst: 250,
      historyFirst: 250,
      after: null,
    });
  });

  it("fetchTicketFeatureIssuesByStates supports multiple team keys via the `in` filter (SYMPH-824)", async () => {
    const fetchFn = vi.fn<typeof fetch>().mockResolvedValueOnce(
      jsonResponse({
        data: {
          issues: {
            nodes: [],
            pageInfo: { hasNextPage: false, endCursor: null },
          },
        },
      }),
    );
    const client = createClient({
      fetchFn,
      projectSlug: null,
      teamKeys: ["SYMPH", "MOB"],
    });
    await client.fetchTicketFeatureIssuesByStates(["Backlog"]);
    const request = parseRequestBody(fetchFn.mock.calls[0]?.[1]);
    expect(request.variables.teamKeys).toEqual(["SYMPH", "MOB"]);
  });

  it("keeps fetchTicketFeatureIssuesByStates project-scoped when team_keys is unset (backward compat, SYMPH-824)", async () => {
    const fetchFn = vi.fn<typeof fetch>().mockResolvedValueOnce(
      jsonResponse({
        data: {
          issues: {
            nodes: [],
            pageInfo: { hasNextPage: false, endCursor: null },
          },
        },
      }),
    );
    const client = createClient({ fetchFn });
    await client.fetchTicketFeatureIssuesByStates(["Backlog"]);
    const request = parseRequestBody(fetchFn.mock.calls[0]?.[1]);
    expect(request.query).toContain("slugId");
    expect(request.query).not.toContain("team: { key: { in: $teamKeys } }");
    expect(request.variables).toEqual({
      projectSlug: "ENG",
      stateNames: ["Backlog"],
      first: 50,
      relationFirst: 250,
      historyFirst: 250,
      after: null,
    });
  });

  it("fetches open halt-label issues scoped to team keys (no project filter) when team_keys is set (SYMPH-824)", async () => {
    const fetchFn = vi.fn<typeof fetch>().mockResolvedValueOnce(
      jsonResponse({
        data: {
          issues: {
            nodes: [
              issueNode({
                id: "halt-1",
                identifier: "SYMPH-999",
                title: "pipeline-halt",
                createdAt: "2026-06-01T00:00:00.000Z",
              }),
            ],
          },
        },
      }),
    );

    const client = createClient({
      fetchFn,
      projectSlug: null,
      teamKeys: ["SYMPH"],
    });
    const issues = await client.fetchOpenIssuesByLabels(
      ["pipeline-halt"],
      ["Done", "Canceled"],
    );

    expect(issues.map((issue) => issue.identifier)).toEqual(["SYMPH-999"]);
    const request = parseRequestBody(fetchFn.mock.calls[0]?.[1]);
    expect(request.query).toContain("team: { key: { in: $teamKeys } }");
    expect(request.query).not.toContain("project:");
    expect(request.variables).toEqual({
      teamKeys: ["SYMPH"],
      labelNames: ["pipeline-halt"],
      excludeStateNames: ["Done", "Canceled"],
      first: 1,
      relationFirst: 50,
    });
  });

  it("fetchOpenIssuesByLabels supports multiple team keys via the `in` filter (SYMPH-824)", async () => {
    const fetchFn = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(jsonResponse({ data: { issues: { nodes: [] } } }));
    const client = createClient({
      fetchFn,
      projectSlug: null,
      teamKeys: ["SYMPH", "MOB"],
    });
    await client.fetchOpenIssuesByLabels(["pipeline-halt"], ["Done"]);
    const request = parseRequestBody(fetchFn.mock.calls[0]?.[1]);
    expect(request.variables.teamKeys).toEqual(["SYMPH", "MOB"]);
  });

  it("keeps fetchOpenIssuesByLabels project-scoped when team_keys is unset (backward compat, SYMPH-824)", async () => {
    const fetchFn = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(jsonResponse({ data: { issues: { nodes: [] } } }));
    const client = createClient({ fetchFn });
    await client.fetchOpenIssuesByLabels(["pipeline-halt"], ["Done"]);
    const request = parseRequestBody(fetchFn.mock.calls[0]?.[1]);
    expect(request.query).toContain("slugId");
    expect(request.query).not.toContain("team: { key: { in: $teamKeys } }");
    expect(request.variables).toEqual({
      projectSlug: "ENG",
      labelNames: ["pipeline-halt"],
      excludeStateNames: ["Done"],
      first: 1,
      relationFirst: 50,
    });
  });

  it("fetches issues by labels scoped to team keys (no project filter) when team_keys is set (SYMPH-824)", async () => {
    const fetchFn = vi.fn<typeof fetch>().mockResolvedValueOnce(
      jsonResponse({
        data: {
          issues: {
            nodes: [
              issueNode({
                id: "halt-1",
                identifier: "SYMPH-999",
                title: "pipeline-halt",
                createdAt: "2026-06-01T00:00:00.000Z",
              }),
            ],
            pageInfo: { hasNextPage: false, endCursor: null },
          },
        },
      }),
    );

    const client = createClient({
      fetchFn,
      projectSlug: null,
      teamKeys: ["SYMPH"],
    });
    const issues = await client.fetchIssuesByLabels(["pipeline-halt"]);

    expect(issues.map((issue) => issue.identifier)).toEqual(["SYMPH-999"]);
    const request = parseRequestBody(fetchFn.mock.calls[0]?.[1]);
    expect(request.query).toContain("team: { key: { in: $teamKeys } }");
    expect(request.query).not.toContain("project:");
    expect(request.variables).toEqual({
      teamKeys: ["SYMPH"],
      labelNames: ["pipeline-halt"],
      first: 50,
      relationFirst: 50,
      after: null,
    });
  });

  it("fetchIssuesByLabels supports multiple team keys via the `in` filter (SYMPH-824)", async () => {
    const fetchFn = vi.fn<typeof fetch>().mockResolvedValueOnce(
      jsonResponse({
        data: {
          issues: {
            nodes: [],
            pageInfo: { hasNextPage: false, endCursor: null },
          },
        },
      }),
    );
    const client = createClient({
      fetchFn,
      projectSlug: null,
      teamKeys: ["SYMPH", "MOB"],
    });
    await client.fetchIssuesByLabels(["pipeline-halt"]);
    const request = parseRequestBody(fetchFn.mock.calls[0]?.[1]);
    expect(request.variables.teamKeys).toEqual(["SYMPH", "MOB"]);
  });

  it("keeps fetchIssuesByLabels project-scoped when team_keys is unset (backward compat, SYMPH-824)", async () => {
    const fetchFn = vi.fn<typeof fetch>().mockResolvedValueOnce(
      jsonResponse({
        data: {
          issues: {
            nodes: [],
            pageInfo: { hasNextPage: false, endCursor: null },
          },
        },
      }),
    );
    const client = createClient({ fetchFn });
    await client.fetchIssuesByLabels(["pipeline-halt"]);
    const request = parseRequestBody(fetchFn.mock.calls[0]?.[1]);
    expect(request.query).toContain("slugId");
    expect(request.query).not.toContain("team: { key: { in: $teamKeys } }");
    expect(request.variables).toEqual({
      projectSlug: "ENG",
      labelNames: ["pipeline-halt"],
      first: 50,
      relationFirst: 50,
      after: null,
    });
  });

  it("fetches a full issue by identifier without constraining to project", async () => {
    const fetchFn = vi.fn<typeof fetch>().mockResolvedValue(
      jsonResponse({
        data: {
          issue: issueNode({
            id: "issue-585",
            identifier: "SYMPH-585",
            title: "Direct review",
            createdAt: "2026-06-14T00:00:00.000Z",
          }),
        },
      }),
    );
    const client = createClient({ fetchFn, projectSlug: "pipeline" });

    const issue = await client.fetchIssueByIdentifier("SYMPH-585");

    expect(issue).toMatchObject({
      id: "issue-585",
      identifier: "SYMPH-585",
      labels: ["backend"],
    });
    const request = parseRequestBody(fetchFn.mock.calls[0]?.[1]);
    expect(request.query).toBe(LINEAR_ISSUE_BY_IDENTIFIER_QUERY);
    expect(request.query).not.toContain("project:");
    expect(request.variables).toEqual({
      identifier: "SYMPH-585",
      relationFirst: 50,
    });
  });

  it("fails closed when direct issue labels are absent", async () => {
    const node = issueNode({
      id: "issue-585",
      identifier: "SYMPH-585",
      title: "Direct review",
      createdAt: "2026-06-14T00:00:00.000Z",
    });
    node.labels = undefined;
    const fetchFn = vi.fn<typeof fetch>().mockResolvedValue(
      jsonResponse({
        data: {
          issue: node,
        },
      }),
    );
    const client = createClient({ fetchFn });

    await expect(client.fetchIssueByIdentifier("SYMPH-585")).rejects.toThrow(
      expect.objectContaining<Partial<TrackerError>>({
        code: ERROR_CODES.linearUnknownPayload,
        message: expect.stringContaining("did not include labels"),
      }),
    );
  });

  it("fetches issue comments with pagination, actor fields, and deterministic ordering", async () => {
    const fetchFn = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        jsonResponse({
          data: {
            issue: {
              id: "issue-604",
              comments: {
                nodes: [
                  commentNode({
                    id: "comment-b",
                    body: "Second by creation time",
                    createdAt: "2026-06-14T00:02:00.000Z",
                    userEmail: "operator@mobilyze.com",
                  }),
                ],
                pageInfo: {
                  hasNextPage: true,
                  endCursor: "cursor-1",
                },
              },
            },
          },
        }),
      )
      .mockResolvedValueOnce(
        jsonResponse({
          data: {
            issue: {
              id: "issue-604",
              comments: {
                nodes: [
                  commentNode({
                    id: "comment-a",
                    body: "First by creation time",
                    createdAt: "2026-06-14T00:01:00.000Z",
                    botActor: true,
                  }),
                ],
                pageInfo: {
                  hasNextPage: false,
                  endCursor: null,
                },
              },
            },
          },
        }),
      );
    const client = createClient({ fetchFn });

    const comments = await client.fetchIssueComments("issue-604", {
      maxPages: 2,
    });

    expect(comments.map((comment) => comment.id)).toEqual([
      "comment-a",
      "comment-b",
    ]);
    expect(comments[0]).toMatchObject({
      botActor: {
        kind: "bot",
        name: "Linear Automation",
      },
      user: null,
    });
    expect(comments[1]).toMatchObject({
      user: {
        kind: "user",
        email: "operator@mobilyze.com",
      },
      botActor: null,
    });
    const firstRequest = parseRequestBody(fetchFn.mock.calls[0]?.[1]);
    expect(firstRequest.query).toBe(LINEAR_ISSUE_COMMENTS_QUERY);
    expect(firstRequest.variables).toEqual({
      issueId: "issue-604",
      first: 50,
      after: null,
    });
    expect(parseRequestBody(fetchFn.mock.calls[1]?.[1]).variables).toEqual({
      issueId: "issue-604",
      first: 50,
      after: "cursor-1",
    });
  });

  it("fails closed when issue comments exceed maxPages", async () => {
    const fetchFn = vi.fn<typeof fetch>().mockResolvedValue(
      jsonResponse({
        data: {
          issue: {
            id: "issue-604",
            comments: {
              nodes: [
                commentNode({
                  id: "comment-a",
                  body: "More pages remain",
                  createdAt: "2026-06-14T00:01:00.000Z",
                }),
              ],
              pageInfo: {
                hasNextPage: true,
                endCursor: "cursor-1",
              },
            },
          },
        },
      }),
    );
    const client = createClient({ fetchFn });

    await expect(
      client.fetchIssueComments("issue-604", { maxPages: 1 }),
    ).rejects.toThrow(
      expect.objectContaining<Partial<TrackerError>>({
        code: ERROR_CODES.linearUnknownPayload,
        message: expect.stringContaining("exceeded maxPages"),
      }),
    );
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });

  it("updates only issue description for durable spec-review reconciliation", async () => {
    const fetchFn = vi.fn<typeof fetch>().mockResolvedValue(
      jsonResponse({
        data: {
          issueUpdate: {
            success: true,
            issue: {
              id: "issue-568",
              identifier: "SYMPH-568",
              title: "Spec review",
            },
          },
        },
      }),
    );
    const client = createClient({ fetchFn });

    await expect(
      client.updateIssueDescription("issue-568", "Reviewed body"),
    ).resolves.toEqual({
      id: "issue-568",
      identifier: "SYMPH-568",
      title: "Spec review",
    });

    const request = parseRequestBody(fetchFn.mock.calls[0]?.[1]);
    expect(request.query).toBe(LINEAR_UPDATE_ISSUE_DESCRIPTION_MUTATION);
    expect(request.query).not.toContain("labelIds");
    expect(request.query).not.toContain("parentId");
    expect(request.variables).toEqual({
      issueId: "issue-568",
      description: "Reviewed body",
    });
  });

  it("fetches ticket feature issues with creator and relation history evidence", async () => {
    const fetchFn = vi.fn<typeof fetch>().mockResolvedValue(
      jsonResponse({
        data: {
          issues: {
            nodes: [
              ticketFeatureIssueNode({
                id: "issue-483",
                identifier: "SYMPH-483",
                title: "TicketFeature extractor",
              }),
            ],
            pageInfo: {
              hasNextPage: false,
              endCursor: null,
            },
          },
        },
      }),
    );
    const client = createClient({ fetchFn });

    const issues = await client.fetchTicketFeatureIssuesByStates(["Backlog"]);

    expect(issues).toHaveLength(1);
    expect(issues[0]).toMatchObject({
      id: "issue-483",
      identifier: "SYMPH-483",
      creator: {
        email: "agent@mobilyze.com",
      },
      blockedBy: [
        {
          relationId: "rel-480",
          relationType: "blocks",
          attributionSource: "issue_history",
          author: {
            email: "operator@mobilyze.com",
          },
          issue: {
            identifier: "SYMPH-480",
          },
        },
      ],
    });

    const request = parseRequestBody(fetchFn.mock.calls[0]?.[1]);
    expect(request.query).toBe(LINEAR_TICKET_FEATURE_ISSUES_QUERY);
    expect(request.query).toContain("history(first: $historyFirst)");
    expect(request.query).toContain("pageInfo");
    expect(request.query).toContain("relationChanges");
    expect(request.query).toContain("creator");
    expect(request.variables).toEqual({
      projectSlug: "ENG",
      stateNames: ["Backlog"],
      first: 50,
      relationFirst: 250,
      historyFirst: 250,
      after: null,
    });
  });

  it("paginates ticket feature issues by states", async () => {
    const fetchFn = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        jsonResponse({
          data: {
            issues: {
              nodes: [
                ticketFeatureIssueNode({
                  id: "issue-483",
                  identifier: "SYMPH-483",
                  title: "TicketFeature extractor",
                }),
              ],
              pageInfo: {
                hasNextPage: true,
                endCursor: "cursor-1",
              },
            },
          },
        }),
      )
      .mockResolvedValueOnce(
        jsonResponse({
          data: {
            issues: {
              nodes: [
                ticketFeatureIssueNode({
                  id: "issue-484",
                  identifier: "SYMPH-484",
                  title: "Next TicketFeature extractor",
                }),
              ],
              pageInfo: {
                hasNextPage: false,
                endCursor: null,
              },
            },
          },
        }),
      );
    const client = createClient({ fetchFn });

    const issues = await client.fetchTicketFeatureIssuesByStates(["Backlog"]);

    expect(issues.map((issue) => issue.identifier)).toEqual([
      "SYMPH-483",
      "SYMPH-484",
    ]);
    expect(fetchFn).toHaveBeenCalledTimes(2);
    expect(
      parseRequestBody(fetchFn.mock.calls[0]?.[1]).variables,
    ).toMatchObject({
      after: null,
    });
    expect(
      parseRequestBody(fetchFn.mock.calls[1]?.[1]).variables,
    ).toMatchObject({
      after: "cursor-1",
    });
  });

  it("fails closed when ticket feature pagination has no end cursor", async () => {
    const fetchFn = vi.fn<typeof fetch>().mockResolvedValue(
      jsonResponse({
        data: {
          issues: {
            nodes: [],
            pageInfo: {
              hasNextPage: true,
              endCursor: "",
            },
          },
        },
      }),
    );
    const client = createClient({ fetchFn });

    await expect(
      client.fetchTicketFeatureIssuesByStates(["Backlog"]),
    ).rejects.toThrow(
      expect.objectContaining<Partial<TrackerError>>({
        code: ERROR_CODES.linearMissingEndCursor,
      }),
    );
  });

  it("fetches minimal issue states by GraphQL ID list", async () => {
    const fetchFn = vi.fn<typeof fetch>().mockResolvedValue(
      jsonResponse({
        data: {
          issues: {
            nodes: [
              {
                id: "1",
                identifier: "ENG-1",
                state: {
                  name: "Done",
                },
              },
            ],
          },
        },
      }),
    );

    const client = createClient({ fetchFn });

    await expect(client.fetchIssueStatesByIds(["1"])).resolves.toEqual([
      {
        id: "1",
        identifier: "ENG-1",
        state: "Done",
      },
    ]);

    const request = parseRequestBody(fetchFn.mock.calls[0]?.[1]);
    expect(request.query).toBe(LINEAR_ISSUE_STATES_BY_IDS_QUERY);
    expect(request.query).toContain("$issueIds: [ID!]!");
    expect(request.variables).toEqual({
      issueIds: ["1"],
    });
  });

  it("maps missing API key and project slug to typed errors", async () => {
    const missingApiKeyClient = createClient({
      apiKey: null,
      fetchFn: vi.fn<typeof fetch>(),
    });
    const missingProjectClient = createClient({
      projectSlug: null,
      fetchFn: vi.fn<typeof fetch>(),
    });

    await expect(
      missingApiKeyClient.fetchIssueStatesByIds(["1"]),
    ).rejects.toThrow(
      expect.objectContaining<Partial<TrackerError>>({
        code: ERROR_CODES.missingTrackerApiKey,
      }),
    );
    await expect(missingProjectClient.fetchCandidateIssues()).rejects.toThrow(
      expect.objectContaining<Partial<TrackerError>>({
        code: ERROR_CODES.missingTrackerProjectSlug,
      }),
    );
  });

  it("maps non-200, GraphQL errors, malformed payloads, and missing cursors", async () => {
    const non200Client = createClient({
      fetchFn: vi
        .fn<typeof fetch>()
        .mockResolvedValue(new Response("boom", { status: 500 })),
    });
    await expect(non200Client.fetchCandidateIssues()).rejects.toThrow(
      expect.objectContaining<Partial<TrackerError>>({
        code: ERROR_CODES.linearApiStatus,
        status: 500,
      }),
    );

    const graphqlErrorClient = createClient({
      fetchFn: vi.fn<typeof fetch>().mockResolvedValue(
        jsonResponse({
          data: null,
          errors: [{ message: "broken" }],
        }),
      ),
    });
    await expect(graphqlErrorClient.fetchCandidateIssues()).rejects.toThrow(
      expect.objectContaining<Partial<TrackerError>>({
        code: ERROR_CODES.linearGraphqlErrors,
      }),
    );

    const malformedClient = createClient({
      fetchFn: vi.fn<typeof fetch>().mockResolvedValue(
        jsonResponse({
          data: {
            issues: {
              pageInfo: {
                hasNextPage: false,
                endCursor: null,
              },
            },
          },
        }),
      ),
    });
    await expect(malformedClient.fetchCandidateIssues()).rejects.toThrow(
      expect.objectContaining<Partial<TrackerError>>({
        code: ERROR_CODES.linearUnknownPayload,
      }),
    );

    const missingCursorClient = createClient({
      fetchFn: vi.fn<typeof fetch>().mockResolvedValue(
        jsonResponse({
          data: {
            issues: {
              nodes: [],
              pageInfo: {
                hasNextPage: true,
                endCursor: null,
              },
            },
          },
        }),
      ),
    });
    await expect(missingCursorClient.fetchCandidateIssues()).rejects.toThrow(
      expect.objectContaining<Partial<TrackerError>>({
        code: ERROR_CODES.linearMissingEndCursor,
      }),
    );
  });

  it("maps transport failures to linear_api_request", async () => {
    const client = createClient({
      fetchFn: vi
        .fn<typeof fetch>()
        .mockRejectedValue(new Error("network down")),
    });

    await expect(client.fetchCandidateIssues()).rejects.toThrow(
      expect.objectContaining<Partial<TrackerError>>({
        code: ERROR_CODES.linearApiRequest,
      }),
    );
  });
});

describe("fetchParent", () => {
  it("returns parent data on cache miss", async () => {
    const mockFetch = vi.fn<typeof fetch>().mockResolvedValue(
      jsonResponse({
        data: {
          issue: {
            id: "issue-1",
            identifier: "SYMPH-100",
            parent: {
              identifier: "SYMPH-50",
              title: "Parent Epic",
              url: "https://linear.app/team/issue/SYMPH-50",
            },
          },
        },
      }),
    );
    const client = createClient({ fetchFn: mockFetch });

    const result = await client.fetchParent("issue-1");

    expect(result).toEqual({
      identifier: "SYMPH-50",
      title: "Parent Epic",
      url: "https://linear.app/team/issue/SYMPH-50",
    });
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it("returns the newest transition into the requested state from issue history", async () => {
    const mockFetch = vi.fn<typeof fetch>().mockResolvedValue(
      jsonResponse({
        data: {
          issue: {
            history: {
              nodes: [
                {
                  createdAt: "2026-06-10T22:00:00.000Z",
                  toState: { name: "Blocked" },
                },
                {
                  createdAt: "2026-06-10T22:05:00.000Z",
                  toState: { name: "resume" },
                },
                {
                  createdAt: "2026-06-10T22:30:00.000Z",
                  toState: { name: "Resume" },
                },
                { createdAt: "not-a-date", toState: { name: "Resume" } },
                { createdAt: "2026-06-10T23:00:00.000Z", toState: null },
                { createdAt: "2026-06-10T21:00:00.000Z" },
              ],
            },
          },
        },
      }),
    );
    const client = createClient({ fetchFn: mockFetch });

    const result = await client.fetchLatestStateTransitionAt(
      "issue-1",
      "Resume",
    );

    // Case-insensitive state match; malformed nodes skipped; newest wins.
    expect(result).toBe("2026-06-10T22:30:00.000Z");
  });

  it("returns null when the issue has no visible transitions into the state", async () => {
    const mockFetch = vi.fn<typeof fetch>().mockResolvedValue(
      jsonResponse({
        data: {
          issue: {
            history: {
              nodes: [
                {
                  createdAt: "2026-06-10T22:00:00.000Z",
                  toState: { name: "Blocked" },
                },
              ],
            },
          },
        },
      }),
    );
    const client = createClient({ fetchFn: mockFetch });
    expect(
      await client.fetchLatestStateTransitionAt("issue-1", "Resume"),
    ).toBeNull();

    const emptyFetch = vi
      .fn<typeof fetch>()
      .mockResolvedValue(jsonResponse({ data: { issue: null } }));
    const emptyClient = createClient({ fetchFn: emptyFetch });
    expect(
      await emptyClient.fetchLatestStateTransitionAt("issue-1", "Resume"),
    ).toBeNull();
  });

  it("returns cached data on cache hit without making a GraphQL call", async () => {
    const mockFetch = vi.fn<typeof fetch>().mockResolvedValue(
      jsonResponse({
        data: {
          issue: {
            id: "issue-1",
            identifier: "SYMPH-100",
            parent: {
              identifier: "SYMPH-50",
              title: "Parent Epic",
              url: "https://linear.app/team/issue/SYMPH-50",
            },
          },
        },
      }),
    );
    const client = createClient({ fetchFn: mockFetch });

    await client.fetchParent("issue-1");
    const result = await client.fetchParent("issue-1");

    expect(result).toEqual({
      identifier: "SYMPH-50",
      title: "Parent Epic",
      url: "https://linear.app/team/issue/SYMPH-50",
    });
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it("returns null when issue has no parent", async () => {
    const mockFetch = vi.fn<typeof fetch>().mockResolvedValue(
      jsonResponse({
        data: {
          issue: {
            id: "issue-2",
            identifier: "SYMPH-101",
            parent: null,
          },
        },
      }),
    );
    const client = createClient({ fetchFn: mockFetch });

    const result = await client.fetchParent("issue-2");

    expect(result).toBeNull();
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it("caches null results to avoid re-fetching for orphan issues (fetchParent)", async () => {
    const mockFetch = vi.fn<typeof fetch>().mockResolvedValue(
      jsonResponse({
        data: {
          issue: {
            id: "issue-2",
            identifier: "SYMPH-101",
            parent: null,
          },
        },
      }),
    );
    const client = createClient({ fetchFn: mockFetch });

    await client.fetchParent("issue-2");
    const result = await client.fetchParent("issue-2");

    expect(result).toBeNull();
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });
});

describe("createIssue", () => {
  it("creates an issue and returns id, identifier, and title", async () => {
    const fetchFn = vi.fn<typeof fetch>().mockResolvedValue(
      jsonResponse({
        data: {
          issueCreate: {
            success: true,
            issue: {
              id: "issue-abc",
              identifier: "ENG-99",
              title: "Pipeline Halt",
              state: { name: "Todo" },
            },
          },
        },
      }),
    );

    const client = createClient({ fetchFn });
    const result = await client.createIssue({
      teamId: "team-1",
      title: "Pipeline Halt",
      projectId: "proj-1",
      labelIds: ["label-halt"],
    });

    expect(result).toEqual({
      id: "issue-abc",
      identifier: "ENG-99",
      title: "Pipeline Halt",
    });
    expect(fetchFn).toHaveBeenCalledTimes(1);

    const request = parseRequestBody(fetchFn.mock.calls[0]?.[1]);
    expect(request.query).toBe(LINEAR_CREATE_ISSUE_MUTATION);
    expect(request.variables).toEqual({
      teamId: "team-1",
      title: "Pipeline Halt",
      projectId: "proj-1",
      labelIds: ["label-halt"],
    });
  });

  it("throws when issueCreate returns success false", async () => {
    const fetchFn = vi.fn<typeof fetch>().mockResolvedValue(
      jsonResponse({
        data: {
          issueCreate: {
            success: false,
          },
        },
      }),
    );

    const client = createClient({ fetchFn });
    await expect(
      client.createIssue({
        teamId: "team-1",
        title: "Pipeline Halt",
        projectId: "proj-1",
        labelIds: ["label-halt"],
      }),
    ).rejects.toThrow(
      expect.objectContaining<Partial<TrackerError>>({
        code: ERROR_CODES.linearGraphqlErrors,
      }),
    );
  });

  it("throws when issueCreate returns incomplete issue data", async () => {
    const fetchFn = vi.fn<typeof fetch>().mockResolvedValue(
      jsonResponse({
        data: {
          issueCreate: {
            success: true,
            issue: { id: "issue-abc" },
          },
        },
      }),
    );

    const client = createClient({ fetchFn });
    await expect(
      client.createIssue({
        teamId: "team-1",
        title: "Pipeline Halt",
        projectId: "proj-1",
        labelIds: ["label-halt"],
      }),
    ).rejects.toThrow(
      expect.objectContaining<Partial<TrackerError>>({
        code: ERROR_CODES.linearUnknownPayload,
      }),
    );
  });
});

describe("updateIssue", () => {
  it("omits labelIds from the Linear update input when labels are not provided", async () => {
    const fetchFn = vi.fn<typeof fetch>().mockResolvedValue(
      jsonResponse({
        data: {
          issueUpdate: {
            success: true,
            issue: {
              id: "issue-abc",
              identifier: "ENG-99",
              title: "Pipeline Halt",
            },
          },
        },
      }),
    );
    const client = createClient({ fetchFn });

    await expect(
      client.updateIssue({
        issueId: "issue-abc",
        description: "Updated body",
        projectId: "proj-1",
      }),
    ).resolves.toEqual({
      id: "issue-abc",
      identifier: "ENG-99",
      title: "Pipeline Halt",
    });

    const request = parseRequestBody(fetchFn.mock.calls[0]?.[1]);
    expect(request.query).toBe(LINEAR_ISSUE_DETAILS_UPDATE_MUTATION);
    expect(request.variables).toEqual({
      issueId: "issue-abc",
      input: {
        description: "Updated body",
        projectId: "proj-1",
      },
    });
  });
});

describe("resolveLabelIdsByNames", () => {
  it("resolves global and team-owned labels with the Linear team key filter", async () => {
    const fetchFn = vi.fn<typeof fetch>().mockResolvedValue(
      jsonResponse({
        data: {
          issueLabels: {
            nodes: [
              { id: "label-supervision", name: "supervision" },
              { id: "label-risk-high", name: "risk:high" },
            ],
          },
        },
      }),
    );
    const client = createClient({ fetchFn });

    await expect(
      client.resolveLabelIdsByNames(["supervision", "risk:high"], "SYMPH"),
    ).resolves.toEqual([
      { id: "label-supervision", name: "supervision" },
      { id: "label-risk-high", name: "risk:high" },
    ]);

    const request = parseRequestBody(fetchFn.mock.calls[0]?.[1]);
    expect(request.query).toBe(LINEAR_ISSUE_LABELS_BY_NAMES_QUERY);
    expect(request.query).toContain("team: { null: true }");
    expect(request.query).toContain("team: { key: { eq: $teamKey } }");
    expect(request.variables).toEqual({
      teamKey: "SYMPH",
      labelNames: ["supervision", "risk:high"],
    });
  });

  it("includes sanitized operation context on Linear HTTP failures", async () => {
    const fetchFn = vi
      .fn<typeof fetch>()
      .mockResolvedValue(new Response("bad request", { status: 400 }));
    const client = createClient({ fetchFn });

    await expect(
      client.resolveLabelIdsByNames(["supervision"], "SYMPH"),
    ).rejects.toThrow(
      expect.objectContaining<Partial<TrackerError>>({
        code: ERROR_CODES.linearApiStatus,
        status: 400,
        details: {
          operationName: "SymphonyIssueLabelsByNames",
          variables: {
            teamKey: "SYMPH",
            labelNames: ["supervision"],
          },
          responseBody: { raw: "bad request" },
        },
      }),
    );
  });

  it("captures the Linear GraphQL validation error body on HTTP 400 (SYMPH-413)", async () => {
    const validationErrorBody = {
      errors: [
        {
          message:
            'Variable "$projectId" of type "String!" used in position expecting type "ID".',
          extensions: { code: "GRAPHQL_VALIDATION_FAILED", userError: true },
        },
      ],
    };
    const fetchFn = vi
      .fn<typeof fetch>()
      .mockResolvedValue(jsonResponse(validationErrorBody, 400));
    const client = createClient({ fetchFn });

    await expect(
      client.findOpenIssuesByTitle({
        projectId: "2d819863-4180-4361-bfa0-3cae38f1bea6",
        title: "Dispatcher follow-up: branch_divergence for SYMPH-332",
        excludeStateNames: ["Done", "Cancelled"],
      }),
    ).rejects.toThrow(
      expect.objectContaining<Partial<TrackerError>>({
        code: ERROR_CODES.linearApiStatus,
        status: 400,
        details: expect.objectContaining({
          operationName: "SymphonyOpenIssuesByTitle",
          responseBody: validationErrorBody,
        }),
      }),
    );
  });

  it("declares $projectId as ID in the open-issues-by-title query (SYMPH-413 regression guard)", async () => {
    // Linear rejects String! variables in ID comparator positions with
    // HTTP 400 GRAPHQL_VALIDATION_FAILED. This guards the variable type.
    expect(LINEAR_OPEN_ISSUES_BY_TITLE_QUERY).toContain("$projectId: ID!");
    expect(LINEAR_OPEN_ISSUES_BY_TITLE_QUERY).not.toContain(
      "$projectId: String!",
    );

    const fetchFn = vi
      .fn<typeof fetch>()
      .mockResolvedValue(jsonResponse({ data: { issues: { nodes: [] } } }));
    const client = createClient({ fetchFn });
    await client.findOpenIssuesByTitle({
      projectId: "project-uuid",
      title: "Dispatcher follow-up: branch_divergence for SYMPH-332",
      excludeStateNames: ["Done", "Cancelled"],
    });

    const { query, variables } = parseRequestBody(fetchFn.mock.calls[0]?.[1]);
    expect(query).toBe(LINEAR_OPEN_ISSUES_BY_TITLE_QUERY);
    expect(variables).toMatchObject({
      projectId: "project-uuid",
      title: "Dispatcher follow-up: branch_divergence for SYMPH-332",
      excludeStateNames: ["Done", "Cancelled"],
    });
  });

  it("includes sanitized operation context and returned errors on GraphQL top-level errors", async () => {
    const graphqlErrors = [
      {
        message: "Argument Validation Error",
        extensions: { code: "INVALID_INPUT" },
      },
    ];
    const fetchFn = vi
      .fn<typeof fetch>()
      .mockResolvedValue(jsonResponse({ errors: graphqlErrors }));
    const client = createClient({ fetchFn });

    await expect(
      client.resolveLabelIdsByNames(["supervision"], "SYMPH"),
    ).rejects.toThrow(
      expect.objectContaining<Partial<TrackerError>>({
        code: ERROR_CODES.linearGraphqlErrors,
        details: {
          operationName: "SymphonyIssueLabelsByNames",
          variables: {
            teamKey: "SYMPH",
            labelNames: ["supervision"],
          },
          errors: graphqlErrors,
        },
      }),
    );
  });
});

describe("createTrackFindingIssue", () => {
  it("dedups by the fingerprint marker without resolving state or creating", async () => {
    const fetchFn = vi.fn<typeof fetch>().mockResolvedValueOnce(
      jsonResponse({
        data: {
          issues: {
            nodes: [
              {
                id: "ex-1",
                identifier: "SYMPH-500",
                title: "[track:fp-1] Existing track finding",
                url: "https://linear.app/x/issue/SYMPH-500",
                state: { name: "Backlog", type: "backlog" },
              },
            ],
          },
        },
      }),
    );
    const client = createClient({ fetchFn });

    const result = await client.createTrackFindingIssue({
      teamId: "team-1",
      teamKey: "SYMPH",
      fingerprint: "fp-1",
      title: "[track:fp-1] Existing track finding",
      description: "body",
    });

    expect(result).toEqual({
      id: "ex-1",
      identifier: "SYMPH-500",
      title: "[track:fp-1] Existing track finding",
      url: "https://linear.app/x/issue/SYMPH-500",
      created: false,
    });
    // Only the dedup search ran — no state resolution, no create mutation.
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });

  it("creates a Track-finding issue in the Backlog state when none exists", async () => {
    const fetchFn = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(jsonResponse({ data: { issues: { nodes: [] } } }))
      .mockResolvedValueOnce(
        jsonResponse({
          data: {
            workflowStates: {
              nodes: [
                { id: "state-triage", name: "Triage" },
                { id: "state-backlog", name: "Backlog" },
              ],
            },
          },
        }),
      )
      .mockResolvedValueOnce(
        jsonResponse({
          data: {
            issueCreate: {
              success: true,
              issue: {
                id: "new-1",
                identifier: "SYMPH-600",
                title: "[track:fp-1] New track finding",
                url: "https://linear.app/x/issue/SYMPH-600",
                state: { name: "Backlog" },
              },
            },
          },
        }),
      );
    const client = createClient({ fetchFn });

    const result = await client.createTrackFindingIssue({
      teamId: "team-1",
      teamKey: "SYMPH",
      fingerprint: "fp-1",
      title: "[track:fp-1] New track finding",
      description: "body",
    });

    expect(result).toEqual({
      id: "new-1",
      identifier: "SYMPH-600",
      title: "[track:fp-1] New track finding",
      url: "https://linear.app/x/issue/SYMPH-600",
      created: true,
    });
    expect(fetchFn).toHaveBeenCalledTimes(3);
    // Backlog is preferred over Triage for non-blocking follow-up work.
    const createCall = parseRequestBody(fetchFn.mock.calls[2]?.[1]);
    expect(createCall.variables.stateId).toBe("state-backlog");
  });

  it("files a fresh issue when the only marker match is completed/cancelled", async () => {
    const fetchFn = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        jsonResponse({
          data: {
            issues: {
              nodes: [
                {
                  id: "old-1",
                  identifier: "SYMPH-400",
                  title: "[track:fp-1] Old (done)",
                  url: "https://linear.app/x/issue/SYMPH-400",
                  state: { name: "Done", type: "completed" },
                },
              ],
            },
          },
        }),
      )
      .mockResolvedValueOnce(
        jsonResponse({
          data: {
            workflowStates: {
              nodes: [{ id: "state-backlog", name: "Backlog" }],
            },
          },
        }),
      )
      .mockResolvedValueOnce(
        jsonResponse({
          data: {
            issueCreate: {
              success: true,
              issue: {
                id: "new-2",
                identifier: "SYMPH-601",
                title: "[track:fp-1] Fresh track finding",
                url: "https://linear.app/x/issue/SYMPH-601",
                state: { name: "Backlog" },
              },
            },
          },
        }),
      );
    const client = createClient({ fetchFn });

    const result = await client.createTrackFindingIssue({
      teamId: "team-1",
      teamKey: "SYMPH",
      fingerprint: "fp-1",
      title: "[track:fp-1] Fresh track finding",
      description: "body",
    });

    expect(result.created).toBe(true);
    expect(result.identifier).toBe("SYMPH-601");
    expect(fetchFn).toHaveBeenCalledTimes(3);
  });

  it("does not dedup against an issue that only embeds the marker mid-title", async () => {
    const fetchFn = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        jsonResponse({
          data: {
            issues: {
              nodes: [
                {
                  id: "other-1",
                  identifier: "SYMPH-410",
                  // Marker appears in the human tail, not as the title prefix —
                  // must NOT be treated as this fingerprint's issue.
                  title: "[track:other] see also [track:fp-1] for context",
                  url: "https://linear.app/x/issue/SYMPH-410",
                  state: { name: "Backlog", type: "backlog" },
                },
              ],
            },
          },
        }),
      )
      .mockResolvedValueOnce(
        jsonResponse({
          data: {
            workflowStates: {
              nodes: [{ id: "state-backlog", name: "Backlog" }],
            },
          },
        }),
      )
      .mockResolvedValueOnce(
        jsonResponse({
          data: {
            issueCreate: {
              success: true,
              issue: {
                id: "new-3",
                identifier: "SYMPH-602",
                title: "[track:fp-1] Fresh",
                url: "https://linear.app/x/issue/SYMPH-602",
                state: { name: "Backlog" },
              },
            },
          },
        }),
      );
    const client = createClient({ fetchFn });

    const result = await client.createTrackFindingIssue({
      teamId: "team-1",
      teamKey: "SYMPH",
      fingerprint: "fp-1",
      title: "[track:fp-1] Fresh",
      description: "body",
    });

    expect(result.created).toBe(true);
    expect(result.identifier).toBe("SYMPH-602");
    expect(fetchFn).toHaveBeenCalledTimes(3);
  });
});

function createClient(
  overrides: Partial<ConstructorParameters<typeof LinearTrackerClient>[0]> = {},
): LinearTrackerClient {
  return new LinearTrackerClient({
    endpoint: "https://api.linear.app/graphql",
    apiKey: "linear-token",
    projectSlug: "ENG",
    activeStates: ["Todo", "In Progress"],
    fetchFn: overrides.fetchFn ?? vi.fn<typeof fetch>(),
    ...overrides,
  });
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json",
    },
  });
}

function parseRequestBody(init: RequestInit | undefined): {
  query: string;
  variables: Record<string, unknown>;
} {
  if (typeof init?.body !== "string") {
    throw new Error("Expected string request body.");
  }

  return JSON.parse(init.body) as {
    query: string;
    variables: Record<string, unknown>;
  };
}

function issueNode(input: {
  id: string;
  identifier: string;
  title: string;
  createdAt: string;
}): Record<string, unknown> {
  return {
    id: input.id,
    identifier: input.identifier,
    title: input.title,
    description: null,
    priority: 2,
    branchName: null,
    url: null,
    assignee: null,
    createdAt: input.createdAt,
    updatedAt: input.createdAt,
    state: {
      name: "Todo",
    },
    labels: {
      nodes: [{ name: "Backend" }],
    },
    inverseRelations: {
      nodes: [],
    },
  };
}

function commentNode(input: {
  id: string;
  body: string;
  createdAt: string;
  userEmail?: string;
  botActor?: boolean;
}): Record<string, unknown> {
  return {
    id: input.id,
    body: input.body,
    createdAt: input.createdAt,
    updatedAt: input.createdAt,
    user:
      input.userEmail === undefined
        ? null
        : {
            id: "user-1",
            name: "Operator",
            displayName: "Operator",
            email: input.userEmail,
          },
    botActor:
      input.botActor === true
        ? {
            id: "bot-1",
            type: "app",
            subType: "automation",
            name: "Linear Automation",
            userDisplayName: "Linear Automation",
          }
        : null,
  };
}

function ticketFeatureIssueNode(input: {
  id: string;
  identifier: string;
  title: string;
}): Record<string, unknown> {
  return {
    id: input.id,
    identifier: input.identifier,
    title: input.title,
    description: "Feature issue body.",
    priority: 2,
    branchName: null,
    url: null,
    createdAt: "2026-06-13T00:00:00.000Z",
    updatedAt: "2026-06-13T00:10:00.000Z",
    state: {
      name: "Backlog",
    },
    labels: {
      nodes: [{ name: "source:user-report" }, { name: "area:scheduling" }],
    },
    creator: {
      id: "agent-user",
      name: "Mobilyze Agents",
      displayName: "Mobilyze Agents",
      email: "agent@mobilyze.com",
    },
    parent: null,
    inverseRelations: {
      nodes: [
        {
          id: "rel-480",
          type: "blocks",
          issue: {
            id: "issue-480",
            identifier: "SYMPH-480",
            title: "Provenance gap",
            state: { name: "Done" },
          },
        },
      ],
    },
    history: {
      nodes: [
        {
          createdAt: "2026-06-13T00:05:00.000Z",
          actor: {
            id: "operator-user",
            name: "Operator",
            displayName: "Operator",
            email: "operator@mobilyze.com",
          },
          relationChanges: [{ identifier: "SYMPH-480", type: "blocks" }],
        },
      ],
    },
  };
}
