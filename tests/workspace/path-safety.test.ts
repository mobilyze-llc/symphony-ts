import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { ERROR_CODES } from "../../src/errors/codes.js";
import {
  type WorkspacePathError,
  assertWorkspacePathWithinRoot,
  resolveWorkspacePath,
  sanitizeWorkspaceKey,
  toWorkspaceArtifactKey,
  validateWorkspaceCwd,
} from "../../src/workspace/path-safety.js";

describe("workspace path safety", () => {
  it("sanitizes issue ids into deterministic workspace keys", () => {
    expect(sanitizeWorkspaceKey("issue/123:needs review")).toBe(
      "issue_123_needs_review",
    );
    expect(sanitizeWorkspaceKey("你好 world")).toBe("___world");
    expect(sanitizeWorkspaceKey("../unsafe-issue-id")).toBe(
      ".._unsafe-issue-id",
    );
  });

  it("escapes workspace keys into artifact path segments", () => {
    expect(toWorkspaceArtifactKey(".._unsafe-issue-id")).toBe(
      "%2E%2E_unsafe-issue-id",
    );
    expect(toWorkspaceArtifactKey("ISSUE-1")).toBe("ISSUE-1");

    expect(() => toWorkspaceArtifactKey("../unsafe")).toThrowError(
      expect.objectContaining({
        code: ERROR_CODES.workspacePathInvalid,
      }),
    );
  });

  it("builds an absolute workspace path under the configured root", () => {
    const info = resolveWorkspacePath(
      "./tmp/workspaces",
      "issue/123:needs review",
    );

    expect(info.workspaceKey).toBe("issue_123_needs_review");
    expect(info.workspacePath).toBe(
      join(info.workspaceRoot, "issue_123_needs_review"),
    );
  });

  it("rejects empty workspace keys and paths outside the root", () => {
    expect(() => resolveWorkspacePath("/tmp/symphony", "")).toThrowError(
      expect.objectContaining({
        code: ERROR_CODES.workspacePathInvalid,
      }),
    );

    expect(() =>
      assertWorkspacePathWithinRoot("/tmp/symphony", "/tmp/other/ABC-123"),
    ).toThrowError(
      expect.objectContaining({
        code: ERROR_CODES.workspaceRootEscape,
      }),
    );
  });

  it("rejects agent cwd values that do not match the workspace path", () => {
    expect(() =>
      validateWorkspaceCwd({
        workspaceRoot: "/tmp/symphony",
        workspacePath: "/tmp/symphony/ABC-123",
        cwd: "/tmp/symphony/other",
      }),
    ).toThrowError(
      expect.objectContaining<Partial<WorkspacePathError>>({
        code: ERROR_CODES.invalidWorkspaceCwd,
      }),
    );
  });
});
