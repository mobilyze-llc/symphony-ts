import { describe, expect, it } from "vitest";

import { normalizeErrorSignature } from "../../src/errors/signature.js";

describe("normalizeErrorSignature", () => {
  describe("normalization", () => {
    it("strips absolute paths and keeps basename", () => {
      const result = normalizeErrorSignature(
        "EPERM: operation not permitted, open '/var/folders/abc123/def456/T/tmpXYZ/foo.ts'",
      );
      expect(result.normalizedText).not.toContain("/var/folders");
      expect(result.normalizedText).toContain("foo.ts");
    });

    it("produces the same signature for EPERM errors with differing /var/folders paths (SYMPH-332 fixture)", () => {
      // The real-world SYMPH-332 incident: same EPERM but different random
      // /var/folders paths across attempts
      const attempt1 = normalizeErrorSignature(
        "EPERM: operation not permitted, open '/var/folders/xk/3q8vz5cd2r1/T/tmp-12345/workspace/src/foo.ts'",
      );
      const attempt2 = normalizeErrorSignature(
        "EPERM: operation not permitted, open '/var/folders/zp/9mhd1b7xyq0/T/tmp-67890/workspace/src/foo.ts'",
      );
      expect(attempt1.signature).toBe(attempt2.signature);
    });

    it("normalizes lock-slot digits so claude.0.lock ≡ claude.1.lock (SYMPH-396)", () => {
      // Codex lock files vary by slot number across runs; they must hash identically.
      const slot0 = normalizeErrorSignature(
        "EPERM: operation not permitted, open '/Users/user/.cmux-spawn/locks/claude.0.lock'",
      );
      const slot1 = normalizeErrorSignature(
        "EPERM: operation not permitted, open '/Users/user/.cmux-spawn/locks/claude.1.lock'",
      );
      expect(slot0.signature).toBe(slot1.signature);
    });

    it("normalizes SYMPH-332-shaped fixture with lock slot and /var/folders artifact path (cross-run stability)", () => {
      // Realistic shape: PermissionError on a cmux lock file + /var/folders artifact
      const run1 = normalizeErrorSignature(
        "PermissionError: [Errno 1] Operation not permitted: '/Users/alice/.cmux-spawn/locks/claude.0.lock'\n  also: /var/folders/q2/8h3k_abc1/T/workspace/src/index.ts",
      );
      const run2 = normalizeErrorSignature(
        "PermissionError: [Errno 1] Operation not permitted: '/Users/bob/.cmux-spawn/locks/claude.3.lock'\n  also: /var/folders/zz/9p1m_xyz2/T/workspace/src/index.ts",
      );
      expect(run1.signature).toBe(run2.signature);
    });

    it("trims trailing quote from basename captured by path regex", () => {
      const result = normalizeErrorSignature(
        "EPERM: operation not permitted, open '/some/path/foo.ts'",
      );
      // The trailing quote after the basename should be stripped from <path:...>
      expect(result.normalizedText).not.toMatch(/<path:[^>]*'>/);
      expect(result.normalizedText).toContain("foo.ts");
    });

    it("strips UUIDs", () => {
      const result = normalizeErrorSignature(
        "workspace 550e8400-e29b-41d4-a716-446655440000 failed",
      );
      expect(result.normalizedText).not.toContain(
        "550e8400-e29b-41d4-a716-446655440000",
      );
      expect(result.normalizedText).toContain("<uuid>");
    });

    it("strips long hex ids", () => {
      const result = normalizeErrorSignature(
        "commit deadbeefcafe1234 could not be applied",
      );
      expect(result.normalizedText).not.toContain("deadbeefcafe1234");
    });

    it("strips timestamps", () => {
      const result = normalizeErrorSignature(
        "error at 2026-06-11T14:23:01.000Z: connection refused",
      );
      expect(result.normalizedText).not.toContain("2026-06-11");
    });

    it("strips multi-digit numbers but keeps single digits", () => {
      const result = normalizeErrorSignature(
        "retry 42 of 100 failed after 30 seconds",
      );
      expect(result.normalizedText).not.toContain("42");
      expect(result.normalizedText).not.toContain("100");
      expect(result.normalizedText).not.toContain("30");
    });

    it("collapses whitespace", () => {
      const result = normalizeErrorSignature("error:   too   many   spaces");
      expect(result.normalizedText).toBe("error: too many spaces");
    });

    it("produces stable 7-char hex signature", () => {
      const result = normalizeErrorSignature("EPERM: operation not permitted");
      expect(result.signature).toMatch(/^[0-9a-f]{7}$/);
    });

    it("same input always yields same signature (deterministic)", () => {
      const raw = "EPERM: operation not permitted, open '/some/path/file.ts'";
      const a = normalizeErrorSignature(raw);
      const b = normalizeErrorSignature(raw);
      expect(a.signature).toBe(b.signature);
    });

    it("different error messages produce different signatures", () => {
      const a = normalizeErrorSignature("EPERM: operation not permitted");
      const b = normalizeErrorSignature("ENOENT: no such file or directory");
      expect(a.signature).not.toBe(b.signature);
    });
  });

  describe("classification", () => {
    it("classifies EPERM as permanent", () => {
      const result = normalizeErrorSignature("EPERM: operation not permitted");
      expect(result.class).toBe("permanent");
    });

    it("classifies EACCES as permanent", () => {
      const result = normalizeErrorSignature(
        "EACCES: permission denied, access '/root/secret'",
      );
      expect(result.class).toBe("permanent");
    });

    it("classifies ENOENT as permanent", () => {
      const result = normalizeErrorSignature(
        "ENOENT: no such file or directory",
      );
      expect(result.class).toBe("permanent");
    });

    it("classifies 'command not found' as permanent", () => {
      const result = normalizeErrorSignature("sh: git: command not found");
      expect(result.class).toBe("permanent");
    });

    it("classifies 'unknown flag' as permanent", () => {
      const result = normalizeErrorSignature("Error: unknown flag --foo");
      expect(result.class).toBe("permanent");
    });

    it("classifies auth errors as permanent", () => {
      const result = normalizeErrorSignature(
        "GraphQL error: authentication failed",
      );
      expect(result.class).toBe("permanent");
    });

    it("classifies timeout as transient", () => {
      const result = normalizeErrorSignature(
        "Error: request timeout after 30s",
      );
      expect(result.class).toBe("transient");
    });

    it("classifies ECONNRESET as transient", () => {
      const result = normalizeErrorSignature(
        "ECONNRESET: read ECONNRESET socket closed",
      );
      expect(result.class).toBe("transient");
    });

    it("classifies 5xx HTTP errors as transient", () => {
      const result = normalizeErrorSignature(
        "HTTP request failed with status 503",
      );
      expect(result.class).toBe("transient");
    });

    it("classifies 'status code 503 Service Unavailable' as transient (HTTP context)", () => {
      const result = normalizeErrorSignature("HTTP 503 Service Unavailable");
      expect(result.class).toBe("transient");
    });

    it("does NOT classify bare pid/port '503' in 'process 503 exited' as transient (no HTTP context)", () => {
      // A bare 5xx process id must not get a transient exemption that suppresses
      // the park short-circuit.
      const result = normalizeErrorSignature("process 503 exited");
      expect(result.class).not.toBe("transient");
    });

    it("does NOT classify 'Command failed: kill -9 503' as transient (bare 5xx pid)", () => {
      const result = normalizeErrorSignature("Command failed: kill -9 503");
      expect(result.class).not.toBe("transient");
    });

    it("classifies axios 'Request failed with status code 503' as transient", () => {
      // Axios's canonical error shape — must match the widened 5xx pattern.
      const result = normalizeErrorSignature(
        "Request failed with status code 503",
      );
      expect(result.class).toBe("transient");
    });

    it("classifies axios 'Request failed with status code 500' as transient", () => {
      const result = normalizeErrorSignature(
        "Request failed with status code 500",
      );
      expect(result.class).toBe("transient");
    });

    it("does NOT classify 'process 503 exited' as transient (PID exclusion still holds)", () => {
      // The PID/exit-code exclusion property must survive the regex widening.
      const result = normalizeErrorSignature("process 503 exited");
      expect(result.class).not.toBe("transient");
    });

    it("classifies rate limit as transient", () => {
      const result = normalizeErrorSignature(
        "API error: rate limit exceeded, retry after 60s",
      );
      expect(result.class).toBe("transient");
    });

    it("classifies 'Forbidden: too many requests, retry later' as transient (rate-limit before auth)", () => {
      // The rate-limit rules must win over the 'forbidden' permanent rule.
      const result = normalizeErrorSignature(
        "Forbidden: too many requests, retry later",
      );
      expect(result.class).toBe("transient");
    });

    it("classifies '429 too many requests' as transient (rate-limit before auth)", () => {
      const result = normalizeErrorSignature("HTTP 429 too many requests");
      expect(result.class).toBe("transient");
    });

    it("classifies 'Access denied: rate limit exceeded' as transient (rate-limit before auth)", () => {
      const result = normalizeErrorSignature(
        "Access denied: rate limit exceeded",
      );
      expect(result.class).toBe("transient");
    });

    it("classifies plain 'forbidden' (no rate-limit context) as permanent", () => {
      const result = normalizeErrorSignature(
        "403 Forbidden: insufficient permissions",
      );
      expect(result.class).toBe("permanent");
    });

    it("classifies unknown errors as unknown", () => {
      const result = normalizeErrorSignature(
        "something went wrong in the pipeline",
      );
      expect(result.class).toBe("unknown");
    });
  });
});
