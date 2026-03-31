/**
 * Tests for ops/claude-usage — SYMPH-236
 *
 * Spawns the bash CLI as a subprocess with shimmed PATH pointing to fake
 * `security` and `curl` binaries in a temp directory. Each test gets its
 * own temp dir with custom HOME to isolate sequence.json and usage-cache.json.
 */

import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
  chmodSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

const __dirname = dirname(fileURLToPath(import.meta.url));
const SCRIPT_PATH = join(__dirname, "../../ops/claude-usage");

const SAMPLE_KEYCHAIN_JSON = JSON.stringify({
  claudeAiOauth: {
    accessToken: "test-access-token-abc123",
    refreshToken: "test-refresh-token",
    expiresAt: "2099-01-01T00:00:00Z",
  },
});

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

const SAMPLE_SEQUENCE = {
  activeAccountNumber: 2,
  accounts: {
    "1": { email: "eric@litman.org", organizationName: "Eric Litman" },
    "2": {
      email: "eric@mobilyze.com",
      organizationName: "eric@mobilyze.com's Organization",
    },
  },
};

const dirsToCleanup: string[] = [];

function tmpDir(prefix: string = "claude-usage-test") {
  const dir = join(
    tmpdir(),
    `${prefix}-${randomBytes(6).toString("hex")}`,
  );
  mkdirSync(dir, { recursive: true });
  dirsToCleanup.push(dir);
  return dir;
}

function createFakeBin(
  dir: string,
  name: string,
  script: string,
): void {
  const path = join(dir, name);
  writeFileSync(path, script);
  chmodSync(path, 0o755);
}

function setupTestEnv(options: {
  keychainOutput?: string;
  keychainExitCode?: number;
  curlOutput?: string;
  curlHttpCode?: number;
  sequenceJson?: object | null;
}) {
  const home = tmpDir("claude-usage-home");
  const binDir = tmpDir("claude-usage-bin");

  // Create fake security binary
  const securityExitCode = options.keychainExitCode ?? 0;
  const securityOutput = options.keychainOutput ?? SAMPLE_KEYCHAIN_JSON;
  createFakeBin(
    binDir,
    "security",
    `#!/usr/bin/env bash
if [[ "$securityExitCode" -ne 0 ]]; then exit $securityExitCode; fi
echo '${securityOutput.replace(/'/g, "'\\''")}'
exit ${securityExitCode}
`,
  );

  // Create fake curl binary
  const httpCode = options.curlHttpCode ?? 200;
  const curlBody = options.curlOutput ?? SAMPLE_API_RESPONSE;
  createFakeBin(
    binDir,
    "curl",
    `#!/usr/bin/env bash
echo '${curlBody.replace(/'/g, "'\\''")}'
echo "${httpCode}"
`,
  );

  // Create sequence.json if provided
  if (options.sequenceJson !== null && options.sequenceJson !== undefined) {
    const swapDir = join(home, ".claude-swap-backup");
    mkdirSync(swapDir, { recursive: true });
    writeFileSync(
      join(swapDir, "sequence.json"),
      JSON.stringify(options.sequenceJson),
    );
  }

  // Ensure .symphony dir exists for cache
  mkdirSync(join(home, ".symphony"), { recursive: true });

  return { home, binDir };
}

function runCLI(
  args: string[],
  env: { home: string; binDir: string },
  extraEnv: Record<string, string> = {},
) {
  const result = spawnSync("bash", [SCRIPT_PATH, ...args], {
    env: {
      ...process.env,
      HOME: env.home,
      PATH: `${env.binDir}:/usr/bin:/bin:/usr/local/bin`,
      CLAUDE_USAGE_KEYCHAIN_USER: "testuser",
      ...extraEnv,
    },
    encoding: "utf-8",
    timeout: 15000,
  });
  return {
    stdout: result.stdout || "",
    stderr: result.stderr || "",
    exitCode: result.status ?? 1,
  };
}

describe("ops/claude-usage", { timeout: 30000 }, () => {
  afterEach(() => {
    for (const dir of dirsToCleanup.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  describe("outputs valid JSON", () => {
    it("outputs valid JSON with five_hour and seven_day utilization fields", () => {
      const env = setupTestEnv({ sequenceJson: SAMPLE_SEQUENCE });
      const { stdout, exitCode } = runCLI(["--json"], env);

      expect(exitCode).toBe(0);
      const output = JSON.parse(stdout);
      expect(output.five_hour).toBeDefined();
      expect(output.five_hour.utilization).toBe(3);
      expect(output.five_hour.resets_at).toBe(
        "2026-03-31T03:00:00.663100+00:00",
      );
      expect(output.seven_day).toBeDefined();
      expect(output.seven_day.utilization).toBe(48);
      expect(output.seven_day.resets_at).toBe(
        "2026-04-04T09:59:59.663126+00:00",
      );
    });

    it("includes active_account fields", () => {
      const env = setupTestEnv({ sequenceJson: SAMPLE_SEQUENCE });
      const { stdout, exitCode } = runCLI(["--json"], env);

      expect(exitCode).toBe(0);
      const output = JSON.parse(stdout);
      expect(output.active_account).toBeDefined();
      expect(output.active_account.email).toBe("eric@mobilyze.com");
      expect(output.active_account.org).toBe(
        "eric@mobilyze.com's Organization",
      );
      expect(output.active_account.account_number).toBe(2);
    });

    it("lists accounts from sequence.json", () => {
      const env = setupTestEnv({ sequenceJson: SAMPLE_SEQUENCE });
      const { stdout, exitCode } = runCLI(["--json"], env);

      expect(exitCode).toBe(0);
      const output = JSON.parse(stdout);
      expect(output.accounts).toHaveLength(2);
      expect(output.accounts[0].email).toBe("eric@litman.org");
      expect(output.accounts[0].account_number).toBe(1);
      expect(output.accounts[1].email).toBe("eric@mobilyze.com");
      expect(output.accounts[1].account_number).toBe(2);
    });
  });

  describe("writes cache", () => {
    it("writes utilization to per-account cache file", () => {
      const env = setupTestEnv({ sequenceJson: SAMPLE_SEQUENCE });
      const { exitCode } = runCLI(["--json"], env);

      expect(exitCode).toBe(0);

      const cacheFile = join(env.home, ".symphony", "usage-cache.json");
      expect(existsSync(cacheFile)).toBe(true);

      const cache = JSON.parse(readFileSync(cacheFile, "utf-8"));
      expect(cache["2"]).toBeDefined();
      expect(cache["2"].five_hour).toBe(3);
      expect(cache["2"].seven_day).toBe(48);
      expect(cache["2"].timestamp).toBeDefined();
    });

    it("merges with existing cache entries", () => {
      const env = setupTestEnv({ sequenceJson: SAMPLE_SEQUENCE });

      // Pre-populate cache with account 1 data
      const cacheFile = join(env.home, ".symphony", "usage-cache.json");
      writeFileSync(
        cacheFile,
        JSON.stringify({
          "1": {
            five_hour: 10,
            seven_day: 20,
            timestamp: "2026-03-30T00:00:00Z",
          },
        }),
      );

      const { exitCode } = runCLI(["--json"], env);
      expect(exitCode).toBe(0);

      const cache = JSON.parse(readFileSync(cacheFile, "utf-8"));
      // Account 1 data should be preserved
      expect(cache["1"].five_hour).toBe(10);
      // Account 2 data should be added
      expect(cache["2"].five_hour).toBe(3);
    });
  });

  describe("human-readable", () => {
    it("outputs human-readable summary by default", () => {
      const env = setupTestEnv({ sequenceJson: SAMPLE_SEQUENCE });
      const { stdout, exitCode } = runCLI([], env);

      expect(exitCode).toBe(0);
      expect(stdout).toContain("3%");
      expect(stdout).toContain("48%");
      expect(stdout).toContain("eric@mobilyze.com");
      expect(stdout).toContain("Usage Summary");
    });
  });

  describe("exits non-zero", () => {
    it("exits non-zero when Keychain credentials are unavailable", () => {
      const env = setupTestEnv({
        keychainOutput: "",
        keychainExitCode: 44,
        sequenceJson: SAMPLE_SEQUENCE,
      });
      const { exitCode, stderr } = runCLI(["--json"], env);

      expect(exitCode).not.toBe(0);
      expect(stderr).toContain("Keychain");
    });

    it("exits non-zero when Keychain returns empty credentials", () => {
      const env = setupTestEnv({
        keychainOutput: "",
        keychainExitCode: 0,
        sequenceJson: SAMPLE_SEQUENCE,
      });
      const { exitCode, stderr } = runCLI(["--json"], env);

      expect(exitCode).not.toBe(0);
      expect(stderr).toBeTruthy();
    });
  });

  describe("validates response", () => {
    it("exits non-zero on unexpected API response format", () => {
      const badResponse = JSON.stringify({
        something_else: { value: 42 },
      });
      const env = setupTestEnv({
        curlOutput: badResponse,
        sequenceJson: SAMPLE_SEQUENCE,
      });
      const { exitCode, stderr } = runCLI(["--json"], env);

      expect(exitCode).not.toBe(0);
      expect(stderr).toContain("Unexpected API response format");
    });

    it("exits non-zero when five_hour is missing", () => {
      const badResponse = JSON.stringify({
        seven_day: { utilization: 48, resets_at: "2026-04-04T09:59:59Z" },
      });
      const env = setupTestEnv({
        curlOutput: badResponse,
        sequenceJson: SAMPLE_SEQUENCE,
      });
      const { exitCode, stderr } = runCLI(["--json"], env);

      expect(exitCode).not.toBe(0);
      expect(stderr).toContain("five_hour");
    });

    it("exits non-zero on non-200 HTTP status", () => {
      const env = setupTestEnv({
        curlHttpCode: 401,
        sequenceJson: SAMPLE_SEQUENCE,
      });
      const { exitCode, stderr } = runCLI(["--json"], env);

      expect(exitCode).not.toBe(0);
      expect(stderr).toContain("401");
    });
  });

  describe("missing sequence", () => {
    it("handles missing sequence.json gracefully", () => {
      const env = setupTestEnv({ sequenceJson: null });
      const { stdout, exitCode } = runCLI(["--json"], env);

      expect(exitCode).toBe(0);
      const output = JSON.parse(stdout);
      expect(output.accounts).toEqual([]);
      expect(output.active_account).toBeNull();
    });
  });
});
