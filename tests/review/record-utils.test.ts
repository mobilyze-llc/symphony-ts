import { describe, expect, it } from "vitest";

import { readString, recordOrNull } from "../../src/review/record-utils.js";

describe("review record-utils", () => {
  describe("recordOrNull", () => {
    it("returns the record for a plain object", () => {
      const obj = { a: 1, b: "x" };
      expect(recordOrNull(obj)).toBe(obj);
    });

    it("returns null for an array", () => {
      expect(recordOrNull([])).toBeNull();
      expect(recordOrNull([1, 2, 3])).toBeNull();
    });

    it("returns null for null, undefined, and primitives", () => {
      expect(recordOrNull(null)).toBeNull();
      expect(recordOrNull(undefined)).toBeNull();
      expect(recordOrNull("string")).toBeNull();
      expect(recordOrNull(42)).toBeNull();
      expect(recordOrNull(true)).toBeNull();
    });
  });

  describe("readString", () => {
    it("returns the string for a string value", () => {
      expect(readString("hello")).toBe("hello");
      expect(readString("")).toBe("");
    });

    it("coerces any non-string (including absence) to an empty string", () => {
      expect(readString(undefined)).toBe("");
      expect(readString(null)).toBe("");
      expect(readString(123)).toBe("");
      expect(readString({})).toBe("");
      expect(readString([])).toBe("");
    });
  });
});
