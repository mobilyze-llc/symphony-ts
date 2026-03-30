/**
 * Tests for ops/claude-usage — SYMPH-236
 *
 * Tests spawn the bash script as a subprocess with a shimmed PATH
 * pointing to fake `security` and `curl` binaries in a temp directory.
 */

import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const __dirname = dirname(fileURLToPath(import.meta.url));
const SCRIPT_PATH = join(__dirname, "../../ops/claude-usage");

const SAMPLE_API_RESPONSE = JSON.stringify({
  five_hour: {
    utilization: 3.0,
    resets_at: "2026-03-31T03:00:00.663100+00:00",
  },
  seven_day: {
    utilization: 48.0,
    resets_at: "2026-04-04T09:59:59.663126+00:00",
  },
  seven_day_oauth_apps: null,
  seven_day_opus: null,
  seven_day_sonnet: {
    utilization: 2.0,
    resets_at: "2026-04-04T09:59:59.663135+00:00",
  },
  seven_day_cowork: null,
  iguana_necktie: null,
  extra_usage: {
    is_enabled: false,
    monthly_limit: null,
    used_credits: null,
    utilization: null,
  },
});

const SAMPLE_KEYCHAIN_JSON = JSON.stringify({
  claudeAiOauth: {
    accessToken: "test-token-123",
    refreshToken: "test-refresh-456",
  },
});

const SAMPLE_SEQUENCE = {
  activeAccountNumber: 2,
  accounts: {
    "1": { email: "alice@example.com", organizationName: "Alice Org" },
    "2": {
      email: "bob@example.com",
      organizationName: "Bob's Organization",
    },
  },
};

function tmpDir(prefix = "claude-usage-test") {
  const dir = join(tmpdir(), `${prefix}-${randomBytes(6).toString("hex")}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

/**
 * Create fake `security` and `curl` binaries in a temp bin dir.
 * Returns the bin dir path (to prepend to PATH).
 */
function createShims(
  binDir: string,
  opts: {
    securityOutput?: string;
    securityExitCode?: number;
    curlOutput?: string;
    curlExitCode?: number;
    curlHttpCode?: string;
  } = {},
) {
  const {
    securityOutput = SAMPLE_KEYCHAIN_JSON,
    securityExitCode = 0,
    curlOutput = SAMPLE_API_RESPONSE,
    curlExitCode = 0,
    curlHttpCode = "200",
  } = opts;

  mkdirSync(binDir, { recursive: true });

  // Fake security binary
  const securityScript = `#!/usr/bin/env bash
if [[ ${securityExitCode} -ne 0 ]]; then
  exit ${securityExitCode}
fi
echo '${securityOutput.replace(/'/g, "'\\''")}'
`;
  writeFileSync(join(binDir, "security"), securityScript);
  chmodSync(join(binDir, "security"), 0o755);

  // Fake curl binary — must handle -w format for HTTP code
  // The real script uses: curl -s -w "\n%{http_code}" ...
  // So we output the body, then a newline, then the HTTP code
  const curlScript = `#!/usr/bin/env bash
if [[ ${curlExitCode} -ne 0 ]]; then
  exit ${curlExitCode}
fi
echo '${curlOutput.replace(/'/g, "'\\''")}'
echo '${curlHttpCode}'
`;
  writeFileSync(join(binDir, "curl"), curlScript);
  chmodSync(join(binDir, "curl"), 0o755);

  return binDir;
}

function runCLI(
  args: string[] = [],
  opts: {
    binDir?: string;
    homeDir?: string;
    sequenceFile?: string;
    cacheDir?: string;
    env?: Record<string, string>;
  } = {},
) {
  const env: Record<string, string> = {
    PATH: opts.binDir
      ? `${opts.binDir}:${process.env.PATH}`
      : process.env.PATH || "",
    HOME: opts.homeDir || tmpDir("home"),
    CLAUDE_USAGE_CACHE_DIR:
      opts.cacheDir || join(opts.homeDir || tmpDir("cache"), ".symphony"),
    ...(opts.sequenceFile !== undefined
      ? { CLAUDE_USAGE_SEQUENCE_FILE: opts.sequenceFile }
      : {}),
    ...(opts.env || {}),
  };

  const result = spawnSync("bash", [SCRIPT_PATH, ...args], {
    env,
    encoding: "utf-8",
    timeout: 15000,
  });

  return {
    stdout: result.stdout || "",
    stderr: result.stderr || "",
    exitCode: result.status ?? 1,
  };
}

describe("ops/claude-usage", () => {
  let tmpDirs: string[] = [];

  function makeTmpDir(prefix?: string) {
    const dir = tmpDir(prefix);
    tmpDirs.push(dir);
    return dir;
  }

  afterEach(() => {
    for (const dir of tmpDirs) {
      rmSync(dir, { recursive: true, force: true });
    }
    tmpDirs = [];
  });

  describe("outputs valid JSON", () => {
    it("outputs valid JSON with five_hour and seven_day utilization fields", () => {
      const binDir = makeTmpDir("bin");
      const homeDir = makeTmpDir("home");
      const cacheDir = makeTmpDir("cache");
      createShims(binDir);

      // Create sequence.json
      const seqDir = join(homeDir, ".claude-swap-backup");
      mkdirSync(seqDir, { recursive: true });
      writeFileSync(
        join(seqDir, "sequence.json"),
        JSON.stringify(SAMPLE_SEQUENCE),
      );

      const result = runCLI(["--json"], {
        binDir,
        homeDir,
        cacheDir,
        sequenceFile: join(seqDir, "sequence.json"),
      });

      expect(result.exitCode).toBe(0);

      const output = JSON.parse(result.stdout);
      expect(output.five_hour).toBeDefined();
      expect(output.five_hour.utilization).toBe(3.0);
      expect(output.seven_day).toBeDefined();
      expect(output.seven_day.utilization).toBe(48.0);
    });
  });

  describe("active_account fields", () => {
    it("active_account contains email and org fields", () => {
      const binDir = makeTmpDir("bin");
      const homeDir = makeTmpDir("home");
      const cacheDir = makeTmpDir("cache");
      createShims(binDir);

      const seqDir = join(homeDir, ".claude-swap-backup");
      mkdirSync(seqDir, { recursive: true });
      writeFileSync(
        join(seqDir, "sequence.json"),
        JSON.stringify(SAMPLE_SEQUENCE),
      );

      const result = runCLI(["--json"], {
        binDir,
        homeDir,
        cacheDir,
        sequenceFile: join(seqDir, "sequence.json"),
      });

      expect(result.exitCode).toBe(0);

      const output = JSON.parse(result.stdout);
      expect(output.active_account).toBeDefined();
      expect(output.active_account.email).toBe("bob@example.com");
      expect(output.active_account.org).toBe("Bob's Organization");
      expect(output.active_account.account_number).toBe(2);
    });
  });

  describe("lists accounts", () => {
    it("accounts array lists all managed accounts", () => {
      const binDir = makeTmpDir("bin");
      const homeDir = makeTmpDir("home");
      const cacheDir = makeTmpDir("cache");
      createShims(binDir);

      const seqDir = join(homeDir, ".claude-swap-backup");
      mkdirSync(seqDir, { recursive: true });
      writeFileSync(
        join(seqDir, "sequence.json"),
        JSON.stringify(SAMPLE_SEQUENCE),
      );

      const result = runCLI(["--json"], {
        binDir,
        homeDir,
        cacheDir,
        sequenceFile: join(seqDir, "sequence.json"),
      });

      expect(result.exitCode).toBe(0);

      const output = JSON.parse(result.stdout);
      expect(output.accounts).toHaveLength(2);
      expect(output.accounts[0].email).toBe("alice@example.com");
      expect(output.accounts[0].account_number).toBe(1);
      expect(output.accounts[1].email).toBe("bob@example.com");
      expect(output.accounts[1].account_number).toBe(2);
    });
  });

  describe("writes cache", () => {
    it("writes utilization to per-account cache file", () => {
      const binDir = makeTmpDir("bin");
      const homeDir = makeTmpDir("home");
      const cacheDir = makeTmpDir("cache");
      createShims(binDir);

      const seqDir = join(homeDir, ".claude-swap-backup");
      mkdirSync(seqDir, { recursive: true });
      writeFileSync(
        join(seqDir, "sequence.json"),
        JSON.stringify(SAMPLE_SEQUENCE),
      );

      const result = runCLI(["--json"], {
        binDir,
        homeDir,
        cacheDir,
        sequenceFile: join(seqDir, "sequence.json"),
      });

      expect(result.exitCode).toBe(0);

      const cacheFile = join(cacheDir, "usage-cache.json");
      expect(existsSync(cacheFile)).toBe(true);

      const cache = JSON.parse(readFileSync(cacheFile, "utf-8"));
      expect(cache["2"]).toBeDefined();
      expect(cache["2"].five_hour_utilization).toBe(3.0);
      expect(cache["2"].seven_day_utilization).toBe(48.0);
      expect(cache["2"].timestamp).toBeDefined();
    });
  });

  describe("human-readable", () => {
    it("outputs human-readable summary by default", () => {
      const binDir = makeTmpDir("bin");
      const homeDir = makeTmpDir("home");
      const cacheDir = makeTmpDir("cache");
      createShims(binDir);

      const seqDir = join(homeDir, ".claude-swap-backup");
      mkdirSync(seqDir, { recursive: true });
      writeFileSync(
        join(seqDir, "sequence.json"),
        JSON.stringify(SAMPLE_SEQUENCE),
      );

      const result = runCLI([], {
        binDir,
        homeDir,
        cacheDir,
        sequenceFile: join(seqDir, "sequence.json"),
      });

      expect(result.exitCode).toBe(0);

      // Should contain percentage values and account email
      expect(result.stdout).toContain("3");
      expect(result.stdout).toContain("48");
      expect(result.stdout).toContain("bob@example.com");
      // Should NOT be valid JSON (it's human-readable)
      expect(() => JSON.parse(result.stdout)).toThrow();
    });
  });

  describe("exits non-zero", () => {
    it("exits non-zero when Keychain credentials are unavailable", () => {
      const binDir = makeTmpDir("bin");
      const homeDir = makeTmpDir("home");
      const cacheDir = makeTmpDir("cache");
      createShims(binDir, { securityExitCode: 1, securityOutput: "" });

      const result = runCLI(["--json"], {
        binDir,
        homeDir,
        cacheDir,
        sequenceFile: join(homeDir, "nonexistent", "sequence.json"),
      });

      expect(result.exitCode).not.toBe(0);
      expect(result.stderr).toContain("Keychain");
    });
  });

  describe("validates response", () => {
    it("exits non-zero on unexpected API response format", () => {
      const binDir = makeTmpDir("bin");
      const homeDir = makeTmpDir("home");
      const cacheDir = makeTmpDir("cache");

      // Return JSON without five_hour field
      const badResponse = JSON.stringify({
        something_else: { utilization: 5 },
      });
      createShims(binDir, { curlOutput: badResponse });

      const result = runCLI(["--json"], {
        binDir,
        homeDir,
        cacheDir,
        sequenceFile: join(homeDir, "nonexistent", "sequence.json"),
      });

      expect(result.exitCode).not.toBe(0);
      expect(result.stderr).toContain("Unexpected API response format");
    });

    it("exits non-zero when API returns non-200 status", () => {
      const binDir = makeTmpDir("bin");
      const homeDir = makeTmpDir("home");
      const cacheDir = makeTmpDir("cache");
      createShims(binDir, {
        curlOutput: '{"error":"unauthorized"}',
        curlHttpCode: "401",
      });

      const result = runCLI(["--json"], {
        binDir,
        homeDir,
        cacheDir,
        sequenceFile: join(homeDir, "nonexistent", "sequence.json"),
      });

      expect(result.exitCode).not.toBe(0);
      expect(result.stderr).toContain("401");
    });
  });

  describe("missing sequence", () => {
    it("handles missing sequence.json gracefully", () => {
      const binDir = makeTmpDir("bin");
      const homeDir = makeTmpDir("home");
      const cacheDir = makeTmpDir("cache");
      createShims(binDir);

      const result = runCLI(["--json"], {
        binDir,
        homeDir,
        cacheDir,
        sequenceFile: join(homeDir, "nonexistent", "sequence.json"),
      });

      expect(result.exitCode).toBe(0);

      const output = JSON.parse(result.stdout);
      expect(output.accounts).toEqual([]);
      expect(output.active_account).toBeNull();
    });
  });
});
