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
