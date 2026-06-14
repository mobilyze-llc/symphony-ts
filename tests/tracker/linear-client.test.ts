import { afterEach, describe, expect, it, vi } from "vitest";

import { ERROR_CODES } from "../../src/errors/codes.js";
import {
  LINEAR_CANDIDATE_ISSUES_QUERY,
  LINEAR_CREATE_ISSUE_MUTATION,
  LINEAR_ISSUE_BY_IDENTIFIER_QUERY,
  LINEAR_ISSUE_LABELS_BY_NAMES_QUERY,
  LINEAR_ISSUE_STATES_BY_IDS_QUERY,
  LINEAR_OPEN_ISSUES_BY_TITLE_QUERY,
  LINEAR_TICKET_FEATURE_ISSUES_QUERY,
  LINEAR_UPDATE_ISSUE_DESCRIPTION_MUTATION,
  LinearTrackerClient,
  type TrackerError,
} from "../../src/index.js";

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
