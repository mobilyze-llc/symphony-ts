import { describe, expect, it } from "vitest";

import {
  TRACKER_ERROR_DETAILS_MAX_LENGTH,
  serializeTrackerErrorDetails,
} from "../../src/tracker/errors.js";

describe("serializeTrackerErrorDetails", () => {
  it("returns null for null and undefined", () => {
    expect(serializeTrackerErrorDetails(null)).toBeNull();
    expect(serializeTrackerErrorDetails(undefined)).toBeNull();
  });

  it("returns null for empty and whitespace-only strings", () => {
    expect(serializeTrackerErrorDetails("")).toBeNull();
    expect(serializeTrackerErrorDetails("   ")).toBeNull();
  });

  it("passes through plain strings", () => {
    expect(serializeTrackerErrorDetails("bad request")).toBe("bad request");
  });

  it("JSON-stringifies objects instead of producing [object Object]", () => {
    const details = {
      operationName: "SymphonyOpenIssuesByTitle",
      responseBody: {
        errors: [
          {
            message:
              'Variable "$projectId" of type "String!" used in position expecting type "ID".',
            extensions: { code: "GRAPHQL_VALIDATION_FAILED" },
          },
        ],
      },
    };
    const serialized = serializeTrackerErrorDetails(details);
    expect(serialized).toBe(JSON.stringify(details));
    expect(serialized).not.toContain("[object Object]");
    expect(serialized).toContain("GRAPHQL_VALIDATION_FAILED");
  });

  it("truncates serialized output beyond the bound with a marker", () => {
    const details = { blob: "x".repeat(TRACKER_ERROR_DETAILS_MAX_LENGTH * 2) };
    const serialized = serializeTrackerErrorDetails(details);
    expect(serialized).not.toBeNull();
    expect(serialized?.length).toBeLessThanOrEqual(
      TRACKER_ERROR_DETAILS_MAX_LENGTH + "…[truncated]".length,
    );
    expect(serialized?.endsWith("…[truncated]")).toBe(true);
  });

  it("respects a custom max length", () => {
    const serialized = serializeTrackerErrorDetails(
      { key: "a".repeat(100) },
      20,
    );
    expect(serialized?.endsWith("…[truncated]")).toBe(true);
    expect(serialized?.length).toBe(20 + "…[truncated]".length);
  });

  it("uses an explicit placeholder for circular structures", () => {
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    expect(serializeTrackerErrorDetails(circular)).toBe(
      "[unserializable tracker error details]",
    );
  });
});
