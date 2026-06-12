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
    // Total output (marker included) stays within the bound.
    expect(serialized?.length).toBeLessThanOrEqual(
      TRACKER_ERROR_DETAILS_MAX_LENGTH,
    );
    expect(serialized?.endsWith("…[truncated]")).toBe(true);
  });

  it("respects a custom max length, marker included", () => {
    const serialized = serializeTrackerErrorDetails(
      { key: "a".repeat(100) },
      20,
    );
    expect(serialized?.endsWith("…[truncated]")).toBe(true);
    expect(serialized?.length).toBe(20);
  });

  it("trims leading whitespace so it cannot consume the truncation budget", () => {
    const serialized = serializeTrackerErrorDetails(
      `${" ".repeat(490)}GRAPHQL_VALIDATION_FAILED`,
      500,
    );
    // Without trimming, the leading spaces would fill the slice and drop the
    // useful keyword (SYMPH-413 council finding).
    expect(serialized?.startsWith(" ")).toBe(false);
    expect(serialized).toContain("GRAPHQL_VALIDATION_FAILED");
  });

  it("never exceeds maxLength even when it is smaller than the marker", () => {
    expect(serializeTrackerErrorDetails("abcdef", 1)?.length).toBe(1);
    expect(serializeTrackerErrorDetails("abcdef", 5)?.length).toBe(5);
  });

  it("never emits a split UTF-16 surrogate at the truncation boundary", () => {
    // "😀" (U+1F600) is two UTF-16 code units; place it straddling the bound.
    const serialized = serializeTrackerErrorDetails(`${"a".repeat(18)}😀b`, 20);
    expect(serialized).not.toBeNull();
    const lastChar = serialized?.slice(0, -"…[truncated]".length) ?? "";
    const lastCode = lastChar.charCodeAt(lastChar.length - 1);
    expect(lastCode >= 0xd800 && lastCode <= 0xdbff).toBe(false);
  });

  it("uses an explicit placeholder for circular structures", () => {
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    expect(serializeTrackerErrorDetails(circular)).toBe(
      "[unserializable tracker error details]",
    );
  });
});
