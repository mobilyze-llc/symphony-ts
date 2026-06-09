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

  it("rejects inline Linear body and description write literals", async () => {
    const fetchFn = vi.fn<typeof fetch>();
    const tool = createLinearGraphqlDynamicTool({
      endpoint: "https://api.linear.app/graphql",
      apiKey: "linear-token",
      fetchFn,
    });

    await expect(
      tool.execute({
        query:
          'mutation CreateComment { commentCreate(input: { issueId: "issue-1", body: "run $(danger)" }) { success } }',
      }),
    ).resolves.toMatchObject({
      success: false,
      error: {
        code: "invalid_input",
        message: expect.stringContaining(
          "linear_graphql.body must use a GraphQL variable",
        ),
      },
    });

    await expect(
      tool.execute({
        query:
          'mutation UpdateIssue { issueUpdate(id: "issue-1", input: { description: "echo `$TOKEN`" }) { success } }',
      }),
    ).resolves.toMatchObject({
      success: false,
      error: {
        code: "invalid_input",
        message: expect.stringContaining(
          "linear_graphql.description must use a GraphQL variable",
        ),
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
