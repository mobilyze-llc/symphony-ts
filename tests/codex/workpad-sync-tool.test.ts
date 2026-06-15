import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createWorkpadSyncDynamicTool } from "../../src/index.js";

describe("createWorkpadSyncDynamicTool", () => {
  let tempDir: string;
  let workpadPath: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "workpad-sync-test-"));
    workpadPath = join(tempDir, "workpad.md");
    await writeFile(workpadPath, "# Workpad\n\n## Status\nIn progress.");
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  it("creates a new comment and returns the comment_id", async () => {
    const fetchFn = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(emptyWorkpadSearchResponse())
      .mockResolvedValueOnce(
        jsonResponse({
          data: {
            commentCreate: {
              success: true,
              comment: { id: "comment-abc-123" },
            },
          },
        }),
      );
    const tool = createWorkpadSyncDynamicTool({
      apiKey: "linear-token",
      fetchFn,
    });

    const result = await tool.execute({
      issue_id: "issue-1",
      file_path: workpadPath,
    });

    expect(result).toEqual({
      success: true,
      comment_id: "comment-abc-123",
      operation: "created",
    });

    expect(fetchFn).toHaveBeenCalledTimes(2);
    const [url, init] = fetchFn.mock.calls[1]!;
    expect(url).toBe("https://api.linear.app/graphql");
    expect(init?.method).toBe("POST");
    const body = JSON.parse(init?.body as string);
    expect(body.variables.issueId).toBe("issue-1");
    expect(body.variables.body).toBe("# Workpad\n\n## Status\nIn progress.");
    expect(body.query).toContain("commentCreate");
  });

  it("updates the most recent runtime-authored Workpad comment when comment_id is omitted", async () => {
    const fetchFn = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        jsonResponse({
          data: {
            viewer: { id: "viewer-1" },
            issue: {
              comments: {
                nodes: [
                  {
                    id: "old-workpad",
                    body: "## Workpad\n\nOld plan",
                    createdAt: "2026-03-06T00:00:00.000Z",
                    updatedAt: "2026-03-06T00:00:00.000Z",
                    user: { id: "viewer-1" },
                  },
                  {
                    id: "operator-workpad",
                    body: "## Workpad\n\nOperator note",
                    createdAt: "2026-03-06T00:30:00.000Z",
                    updatedAt: "2026-03-06T00:30:00.000Z",
                    user: { id: "operator-1" },
                  },
                  {
                    id: "new-workpad",
                    body: "  ## Workpad\n\nCurrent plan",
                    createdAt: "2026-03-06T01:00:00.000Z",
                    updatedAt: "2026-03-06T01:05:00.000Z",
                    user: { id: "viewer-1" },
                  },
                ],
              },
            },
          },
        }),
      )
      .mockResolvedValueOnce(
        jsonResponse({
          data: {
            commentUpdate: {
              success: true,
            },
          },
        }),
      );
    const tool = createWorkpadSyncDynamicTool({
      apiKey: "linear-token",
      fetchFn,
    });

    const result = await tool.execute({
      issue_id: "issue-1",
      file_path: workpadPath,
    });

    expect(result).toEqual({
      success: true,
      comment_id: "new-workpad",
      operation: "updated",
    });
    expect(fetchFn).toHaveBeenCalledTimes(2);
    const searchBody = JSON.parse(fetchFn.mock.calls[0]![1]?.body as string);
    expect(searchBody.query).toContain("WorkpadComments");
    expect(searchBody.query).toContain(
      "comments(first: 50, orderBy: updatedAt)",
    );
    expect(searchBody.variables.issueId).toBe("issue-1");
    const updateBody = JSON.parse(fetchFn.mock.calls[1]![1]?.body as string);
    expect(updateBody.query).toContain("commentUpdate");
    expect(updateBody.query).not.toContain("commentCreate");
    expect(updateBody.variables.commentId).toBe("new-workpad");
  });

  it("updates an existing comment when comment_id is provided", async () => {
    const fetchFn = vi.fn<typeof fetch>().mockResolvedValue(
      jsonResponse({
        data: {
          commentUpdate: {
            success: true,
          },
        },
      }),
    );
    const tool = createWorkpadSyncDynamicTool({
      apiKey: "linear-token",
      fetchFn,
    });

    const result = await tool.execute({
      issue_id: "issue-1",
      file_path: workpadPath,
      comment_id: "comment-existing-456",
    });

    expect(result).toEqual({
      success: true,
      comment_id: "comment-existing-456",
      operation: "updated",
    });

    expect(fetchFn).toHaveBeenCalledOnce();
    const body = JSON.parse(fetchFn.mock.calls[0]![1]?.body as string);
    expect(body.variables.commentId).toBe("comment-existing-456");
    expect(body.query).toContain("commentUpdate");
  });

  it("preserves expansion-heavy markdown literally from the workpad file", async () => {
    const expansionHeavyBody = [
      "## Workpad",
      "",
      "```bash",
      'echo "$SYMPHONY_INPUT"',
      "printf '%s\\n' \"${EXPANSION_HEAVY_VALUE}\"",
      'run-step "$(linear issue view SYMPH-123 --raw)"',
      "echo `date`",
      "cat <<'SCRIPT'",
      'echo "do not expand me now"',
      "SCRIPT",
      "```",
    ].join("\n");
    await writeFile(workpadPath, expansionHeavyBody);
    const fetchFn = vi.fn<typeof fetch>().mockResolvedValue(
      jsonResponse({
        data: {
          commentUpdate: {
            success: true,
          },
        },
      }),
    );
    const tool = createWorkpadSyncDynamicTool({
      apiKey: "linear-token",
      fetchFn,
    });

    const result = await tool.execute({
      issue_id: "issue-1",
      file_path: workpadPath,
      comment_id: "comment-existing-456",
    });

    expect(result).toEqual({
      success: true,
      comment_id: "comment-existing-456",
      operation: "updated",
    });
    const body = JSON.parse(fetchFn.mock.calls[0]![1]?.body as string);
    expect(body.variables.body).toBe(expansionHeavyBody);
  });

  it("returns file_read_error when file does not exist", async () => {
    const tool = createWorkpadSyncDynamicTool({
      apiKey: "linear-token",
      fetchFn: vi.fn<typeof fetch>(),
    });

    const result = await tool.execute({
      issue_id: "issue-1",
      file_path: "/nonexistent/workpad.md",
    });

    expect(result).toMatchObject({
      success: false,
      error: {
        code: "file_read_error",
      },
    });
  });

  it("rejects missing issue_id", async () => {
    const tool = createWorkpadSyncDynamicTool({
      apiKey: "linear-token",
      fetchFn: vi.fn<typeof fetch>(),
    });

    const result = await tool.execute({
      file_path: workpadPath,
    });

    expect(result).toMatchObject({
      success: false,
      error: {
        code: "invalid_input",
        message: "sync_workpad.issue_id must be a non-empty string.",
      },
    });
  });

  it("rejects missing file_path", async () => {
    const tool = createWorkpadSyncDynamicTool({
      apiKey: "linear-token",
      fetchFn: vi.fn<typeof fetch>(),
    });

    const result = await tool.execute({
      issue_id: "issue-1",
    });

    expect(result).toMatchObject({
      success: false,
      error: {
        code: "invalid_input",
        message: "sync_workpad.file_path must be a non-empty string.",
      },
    });
  });

  it("rejects non-object input", async () => {
    const tool = createWorkpadSyncDynamicTool({
      apiKey: "linear-token",
      fetchFn: vi.fn<typeof fetch>(),
    });

    const result = await tool.execute("just a string");

    expect(result).toMatchObject({
      success: false,
      error: {
        code: "invalid_input",
        message: "sync_workpad expects an object with issue_id and file_path.",
      },
    });
  });

  it("rejects non-string comment_id", async () => {
    const tool = createWorkpadSyncDynamicTool({
      apiKey: "linear-token",
      fetchFn: vi.fn<typeof fetch>(),
    });

    const result = await tool.execute({
      issue_id: "issue-1",
      file_path: workpadPath,
      comment_id: 123,
    });

    expect(result).toMatchObject({
      success: false,
      error: {
        code: "invalid_input",
        message: "sync_workpad.comment_id must be a string if provided.",
      },
    });
  });

  it("returns error when Linear API returns HTTP error", async () => {
    const fetchFn = vi
      .fn<typeof fetch>()
      .mockResolvedValue(
        new Response("Internal Server Error", { status: 500 }),
      );
    const tool = createWorkpadSyncDynamicTool({
      apiKey: "linear-token",
      fetchFn,
    });

    const result = await tool.execute({
      issue_id: "issue-1",
      file_path: workpadPath,
    });

    expect(result).toMatchObject({
      success: false,
      error: {
        code: "linear_api_request",
        message: "Linear API returned HTTP 500.",
      },
    });
  });

  it("returns error when Linear API returns GraphQL errors", async () => {
    const fetchFn = vi.fn<typeof fetch>().mockResolvedValue(
      jsonResponse({
        data: null,
        errors: [{ message: "forbidden" }],
      }),
    );
    const tool = createWorkpadSyncDynamicTool({
      apiKey: "linear-token",
      fetchFn,
    });

    const result = await tool.execute({
      issue_id: "issue-1",
      file_path: workpadPath,
    });

    expect(result).toMatchObject({
      success: false,
      error: {
        code: "linear_api_request",
      },
    });
  });

  it("returns error when commentCreate returns no comment id", async () => {
    const fetchFn = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(emptyWorkpadSearchResponse())
      .mockResolvedValueOnce(
        jsonResponse({
          data: {
            commentCreate: {
              success: false,
            },
          },
        }),
      );
    const tool = createWorkpadSyncDynamicTool({
      apiKey: "linear-token",
      fetchFn,
    });

    const result = await tool.execute({
      issue_id: "issue-1",
      file_path: workpadPath,
    });

    expect(result).toMatchObject({
      success: false,
      error: {
        code: "linear_response_malformed",
      },
    });
  });

  it("returns error when fetch itself throws (network failure)", async () => {
    const fetchFn = vi
      .fn<typeof fetch>()
      .mockRejectedValue(new Error("network down"));
    const tool = createWorkpadSyncDynamicTool({
      apiKey: "linear-token",
      fetchFn,
    });

    const result = await tool.execute({
      issue_id: "issue-1",
      file_path: workpadPath,
    });

    expect(result).toMatchObject({
      success: false,
      error: {
        code: "linear_api_request",
        message: "network down",
      },
    });
  });

  it("uses custom endpoint when provided", async () => {
    const fetchFn = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(emptyWorkpadSearchResponse())
      .mockResolvedValueOnce(
        jsonResponse({
          data: {
            commentCreate: {
              success: true,
              comment: { id: "comment-999" },
            },
          },
        }),
      );
    const tool = createWorkpadSyncDynamicTool({
      apiKey: "linear-token",
      endpoint: "https://custom.linear.dev/graphql",
      fetchFn,
    });

    await tool.execute({
      issue_id: "issue-1",
      file_path: workpadPath,
    });

    expect(fetchFn.mock.calls[0]![0]).toBe("https://custom.linear.dev/graphql");
    expect(fetchFn.mock.calls[1]![0]).toBe("https://custom.linear.dev/graphql");
  });

  it("returns error when commentCreate has no comment field", async () => {
    const fetchFn = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(emptyWorkpadSearchResponse())
      .mockResolvedValueOnce(
        jsonResponse({
          data: {
            commentCreate: {
              success: true,
              // no comment field
            },
          },
        }),
      );
    const tool = createWorkpadSyncDynamicTool({
      apiKey: "linear-token",
      fetchFn,
    });
    const result = await tool.execute({
      issue_id: "issue-1",
      file_path: workpadPath,
    });
    expect(result).toMatchObject({
      success: false,
      error: { code: "linear_response_malformed" },
    });
  });

  it("returns error when commentCreate returns empty comment id", async () => {
    const fetchFn = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(emptyWorkpadSearchResponse())
      .mockResolvedValueOnce(
        jsonResponse({
          data: {
            commentCreate: {
              success: true,
              comment: { id: "" },
            },
          },
        }),
      );
    const tool = createWorkpadSyncDynamicTool({
      apiKey: "linear-token",
      fetchFn,
    });
    const result = await tool.execute({
      issue_id: "issue-1",
      file_path: workpadPath,
    });
    expect(result).toMatchObject({
      success: false,
      error: { code: "linear_response_malformed" },
    });
  });

  it("returns error when commentUpdate returns success false", async () => {
    const fetchFn = vi.fn<typeof fetch>().mockResolvedValue(
      jsonResponse({
        data: {
          commentUpdate: {
            success: false,
          },
        },
      }),
    );
    const tool = createWorkpadSyncDynamicTool({
      apiKey: "linear-token",
      fetchFn,
    });
    const result = await tool.execute({
      issue_id: "issue-1",
      file_path: workpadPath,
      comment_id: "existing-comment-id",
    });
    expect(result).toMatchObject({
      success: false,
      error: { code: "linear_response_malformed" },
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

function emptyWorkpadSearchResponse(): Response {
  return jsonResponse({
    data: {
      viewer: { id: "viewer-1" },
      issue: {
        comments: {
          nodes: [],
        },
      },
    },
  });
}
