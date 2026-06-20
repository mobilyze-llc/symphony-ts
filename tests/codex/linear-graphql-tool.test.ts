import { describe, expect, it, vi } from "vitest";

import {
  ERROR_CODES,
  createLinearGraphqlDynamicTool,
} from "../../src/index.js";

describe("createLinearGraphqlDynamicTool", () => {
  it("accepts raw GraphQL string shorthand and returns a successful response", async () => {
    const fetchFn = vi.fn<typeof fetch>().mockResolvedValue(
      jsonResponse({
        data: {
          viewer: {
            id: "viewer-1",
          },
        },
      }),
    );
    const tool = createLinearGraphqlDynamicTool({
      endpoint: "https://api.linear.app/graphql",
      apiKey: "linear-token",
      fetchFn,
    });

    await expect(
      tool.execute("query Viewer { viewer { id } }"),
    ).resolves.toEqual({
      success: true,
      response: {
        status: 200,
        body: {
          data: {
            viewer: {
              id: "viewer-1",
            },
          },
        },
      },
    });
  });

  it("rejects multiple GraphQL operations as invalid input", async () => {
    const tool = createLinearGraphqlDynamicTool({
      endpoint: "https://api.linear.app/graphql",
      apiKey: "linear-token",
      fetchFn: vi.fn<typeof fetch>(),
    });

    await expect(
      tool.execute({
        query:
          "query Viewer { viewer { id } } query Teams { teams { nodes { id } } }",
      }),
    ).resolves.toMatchObject({
      success: false,
      error: {
        code: "invalid_input",
      },
    });
  });

  it("rejects non-object variables", async () => {
    const tool = createLinearGraphqlDynamicTool({
      endpoint: "https://api.linear.app/graphql",
      apiKey: "linear-token",
      fetchFn: vi.fn<typeof fetch>(),
    });

    await expect(
      tool.execute({
        query: "query Viewer { viewer { id } }",
        variables: ["bad"],
      }),
    ).resolves.toMatchObject({
      success: false,
      error: {
        code: "invalid_input",
        message: "linear_graphql.variables must be a JSON object.",
      },
    });
  });

  it("rejects inline Linear content write literals", async () => {
    const fetchFn = vi.fn<typeof fetch>();
    const tool = createLinearGraphqlDynamicTool({
      endpoint: "https://api.linear.app/graphql",
      apiKey: "linear-token",
      fetchFn,
    });

    const unsafeMutations = [
      'mutation CreateComment { commentCreate(input: { issueId: "issue-1", body: "run $(danger)" }) { success } }',
      'mutation UpdateComment { commentUpdate(id: "comment-1", input: { body: "run $(danger)" }) { success } }',
      'mutation CreateIssue { issueCreate(input: { teamId: "team-1", title: "T", description: "echo `$TOKEN`" }) { success } }',
      'mutation UpdateIssue { issueUpdate(id: "issue-1", input: { description: "echo `$TOKEN`" }) { success } }',
      'mutation CreateProject { projectCreate(input: { name: "P", teamIds: ["team-1"], description: "echo `$TOKEN`" }) { success } }',
      'mutation UpdateProject { projectUpdate(id: "project-1", input: { description: "echo `$TOKEN`" }) { success } }',
      'mutation CreateDocument { documentCreate(input: { title: "Doc", content: "echo `$TOKEN`" }) { success } }',
      'mutation UpdateDocument { documentUpdate(id: "doc-1", input: { content: "echo `$TOKEN`" }) { success } }',
      'mutation CreateMilestone { projectMilestoneCreate(input: { projectId: "project-1", name: "M", description: "echo `$TOKEN`" }) { success } }',
      'mutation UpdateMilestone { projectMilestoneUpdate(id: "milestone-1", input: { description: "echo `$TOKEN`" }) { success } }',
      'mutation CreateProjectUpdate { projectUpdateCreate(input: { projectId: "project-1", body: "echo `$TOKEN`" }) { success } }',
      'mutation CreateInitiative { initiativeCreate(input: { name: "I", description: "echo `$TOKEN`" }) { success } }',
      'mutation UpdateRoadmap { roadmapUpdate(id: "roadmap-1", input: { description: "echo `$TOKEN`" }) { success } }',
    ];

    for (const query of unsafeMutations) {
      await expect(tool.execute({ query })).resolves.toMatchObject({
        success: false,
        error: {
          code: "invalid_input",
          message: expect.stringContaining(
            "content fields must use GraphQL variables",
          ),
        },
      });
    }

    expect(fetchFn).not.toHaveBeenCalled();
  });

  it("rejects inline content writes hidden behind fragments", async () => {
    const fetchFn = vi.fn<typeof fetch>();
    const tool = createLinearGraphqlDynamicTool({
      endpoint: "https://api.linear.app/graphql",
      apiKey: "linear-token",
      fetchFn,
    });

    await expect(
      tool.execute({
        query:
          'mutation Wrapped { ... on Mutation { commentUpdate(id: "comment-1", input: { body: "run $(danger)" }) { success } } }',
      }),
    ).resolves.toMatchObject({
      success: false,
      error: {
        code: "invalid_input",
      },
    });

    await expect(
      tool.execute({
        query:
          'mutation Spread { ...InlineWrite } fragment InlineWrite on Mutation { issueUpdate(id: "issue-1", input: { description: "run $(danger)" }) { success } }',
      }),
    ).resolves.toMatchObject({
      success: false,
      error: {
        code: "invalid_input",
      },
    });

    expect(fetchFn).not.toHaveBeenCalled();
  });

  it("allows variable-backed Linear body writes and preserves shell syntax literally", async () => {
    const payload = [
      'echo "$SYMPHONY_INPUT"',
      "printf '%s\\n' \"${EXPANSION_HEAVY_VALUE}\"",
      'run-step "$(linear issue view SYMPH-123 --raw)"',
      "echo `date`",
      "cat <<'SCRIPT'",
      'echo "do not expand me now"',
      "SCRIPT",
    ].join("\n");
    const fetchFn = vi.fn<typeof fetch>().mockResolvedValue(
      jsonResponse({
        data: {
          commentCreate: {
            success: true,
            comment: { id: "comment-1" },
          },
        },
      }),
    );
    const tool = createLinearGraphqlDynamicTool({
      endpoint: "https://api.linear.app/graphql",
      apiKey: "linear-token",
      fetchFn,
    });

    await expect(
      tool.execute({
        query:
          "mutation CreateComment($issueId: String!, $body: String!) { commentCreate(input: { issueId: $issueId, body: $body }) { success comment { id } } }",
        variables: {
          issueId: "issue-1",
          body: payload,
        },
      }),
    ).resolves.toMatchObject({ success: true });

    const request = JSON.parse(fetchFn.mock.calls[0]![1]?.body as string) as {
      variables: { body: string };
    };
    expect(request.variables.body).toBe(payload);
  });

  it("rejects direct issue project writes through raw GraphQL", async () => {
    const fetchFn = vi.fn<typeof fetch>();
    const tool = createLinearGraphqlDynamicTool({
      endpoint: "https://api.linear.app/graphql",
      apiKey: "linear-token",
      fetchFn,
    });

    const unsafeWrites = [
      'mutation CreateIssue($projectId: String!) { issueCreate(input: { teamId: "team-1", title: "T", projectId: $projectId }) { success } }',
      "mutation UpdateIssue($issueId: String!, $projectId: String!) { issueUpdate(id: $issueId, input: { projectId: $projectId }) { success } }",
      'mutation Spread($projectId: String!) { ...IssueWrite } fragment IssueWrite on Mutation { issueCreate(input: { teamId: "team-1", title: "T", projectId: $projectId }) { success } }',
    ];

    for (const query of unsafeWrites) {
      await expect(tool.execute({ query })).resolves.toMatchObject({
        success: false,
        error: {
          code: "invalid_input",
          message: expect.stringContaining("bypass portfolio classification"),
        },
      });
    }

    expect(fetchFn).not.toHaveBeenCalled();
  });

  it("allows content fields in read selections", async () => {
    const fetchFn = vi.fn<typeof fetch>().mockResolvedValue(
      jsonResponse({
        data: {
          issue: {
            description: "run $(later)",
          },
        },
      }),
    );
    const tool = createLinearGraphqlDynamicTool({
      endpoint: "https://api.linear.app/graphql",
      apiKey: "linear-token",
      fetchFn,
    });

    await expect(
      tool.execute({
        query:
          'query ReadIssue { issue(id: "issue-1") { description comments { nodes { body } } } }',
      }),
    ).resolves.toMatchObject({
      success: true,
    });

    expect(fetchFn).toHaveBeenCalledOnce();
  });

  it("allows variable-backed content writes for every guarded field kind", async () => {
    const payload =
      'echo "$SYMPHONY_INPUT"\nrun-step "$(linear issue view SYMPH-123 --raw)"';
    const fetchFn = vi.fn<typeof fetch>().mockImplementation(async () =>
      jsonResponse({
        data: {
          ok: true,
        },
      }),
    );
    const tool = createLinearGraphqlDynamicTool({
      endpoint: "https://api.linear.app/graphql",
      apiKey: "linear-token",
      fetchFn,
    });
    const safeWrites = [
      {
        name: "commentCreate body",
        query:
          "mutation CreateComment($issueId: String!, $body: String!) { commentCreate(input: { issueId: $issueId, body: $body }) { success } }",
        variables: { issueId: "issue-1", body: payload },
        field: "body",
      },
      {
        name: "commentUpdate body",
        query:
          "mutation UpdateComment($commentId: String!, $body: String!) { commentUpdate(id: $commentId, input: { body: $body }) { success } }",
        variables: { commentId: "comment-1", body: payload },
        field: "body",
      },
      {
        name: "issueCreate description",
        query:
          'mutation CreateIssue($teamId: String!, $description: String!) { issueCreate(input: { teamId: $teamId, title: "T", description: $description }) { success } }',
        variables: { teamId: "team-1", description: payload },
        field: "description",
      },
      {
        name: "issueUpdate description",
        query:
          "mutation UpdateIssue($issueId: String!, $description: String!) { issueUpdate(id: $issueId, input: { description: $description }) { success } }",
        variables: { issueId: "issue-1", description: payload },
        field: "description",
      },
      {
        name: "documentUpdate content",
        query:
          "mutation UpdateDocument($documentId: String!, $content: String!) { documentUpdate(id: $documentId, input: { content: $content }) { success } }",
        variables: { documentId: "document-1", content: payload },
        field: "content",
      },
      {
        name: "projectUpdateCreate body",
        query:
          "mutation CreateProjectUpdate($projectId: String!, $body: String!) { projectUpdateCreate(input: { projectId: $projectId, body: $body }) { success } }",
        variables: { projectId: "project-1", body: payload },
        field: "body",
      },
    ];

    for (const safeWrite of safeWrites) {
      const result = await tool.execute({
        query: safeWrite.query,
        variables: safeWrite.variables,
      });
      expect(
        result,
        `${safeWrite.name}: ${JSON.stringify(result)}`,
      ).toMatchObject({
        success: true,
      });
    }

    expect(fetchFn).toHaveBeenCalledTimes(safeWrites.length);
    safeWrites.forEach((safeWrite, index) => {
      const request = JSON.parse(
        fetchFn.mock.calls[index]![1]?.body as string,
      ) as {
        variables: Record<string, string>;
      };
      expect(request.variables[safeWrite.field]).toBe(payload);
    });
  });

  it("preserves top-level GraphQL errors with success=false", async () => {
    const fetchFn = vi.fn<typeof fetch>().mockResolvedValue(
      jsonResponse({
        data: null,
        errors: [{ message: "forbidden" }],
      }),
    );
    const tool = createLinearGraphqlDynamicTool({
      endpoint: "https://api.linear.app/graphql",
      apiKey: "linear-token",
      fetchFn,
    });

    await expect(
      tool.execute({
        query: 'mutation UpdateIssue { issueUpdate(id: "1") { success } }',
      }),
    ).resolves.toEqual({
      success: false,
      response: {
        status: 200,
        body: {
          data: null,
          errors: [{ message: "forbidden" }],
        },
      },
      error: {
        code: ERROR_CODES.linearGraphqlErrors,
        message: "Linear GraphQL returned top-level errors.",
        details: [{ message: "forbidden" }],
        status: 200,
      },
    });
  });

  it("returns structured failures for missing auth and transport errors", async () => {
    const missingAuthTool = createLinearGraphqlDynamicTool({
      endpoint: "https://api.linear.app/graphql",
      apiKey: null,
      fetchFn: vi.fn<typeof fetch>(),
    });
    const transportTool = createLinearGraphqlDynamicTool({
      endpoint: "https://api.linear.app/graphql",
      apiKey: "linear-token",
      fetchFn: vi
        .fn<typeof fetch>()
        .mockRejectedValue(new Error("network down")),
    });

    await expect(
      missingAuthTool.execute({
        query: "query Viewer { viewer { id } }",
      }),
    ).resolves.toMatchObject({
      success: false,
      error: {
        code: ERROR_CODES.missingTrackerApiKey,
      },
    });

    await expect(
      transportTool.execute({
        query: "query Viewer { viewer { id } }",
      }),
    ).resolves.toMatchObject({
      success: false,
      error: {
        code: ERROR_CODES.linearApiRequest,
      },
    });
  });
});

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json",
    },
  });
}
