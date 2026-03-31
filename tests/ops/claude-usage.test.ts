/**
 * Tests for ops/claude-usage — SYMPH-236
 *
 * These tests validate the Claude usage CLI by spawning the bash script
 * as a subprocess with shimmed PATH pointing to fake `security` and `curl`
 * binaries in a temp directory.
 */

import { randomBytes } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";

const __dirname = dirname(fileURLToPath(import.meta.url));
const SCRIPT_PATH = join(__dirname, "../../ops/claude-usage");

// --- Sample data ---

const SAMPLE_KEYCHAIN_JSON = JSON.stringify({
  claudeAiOauth: {
    accessToken: "test-access-token-abc123",
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

const SAMPLE_SEQUENCE_JSON = {
  activeAccountNumber: 2,
  accounts: {
    "1": { email: "eric@litman.org", organizationName: "Eric Litman" },
    "2": {
      email: "eric@mobilyze.com",
      organizationName: "eric@mobilyze.com's Organization",
    },
  },
};

// --- Helpers ---

function tmpDir(prefix: string) {
  const dir = join(
    tmpdir(),
    `claude-usage-test-${prefix}-${randomBytes(6).toString("hex")}`,
  );
  mkdirSync(dir, { recursive: true });
  return dir;
}

function createFakeBinary(dir: string, name: string, script: string) {
  const path = join(dir, name);
  writeFileSync(path, script, { mode: 0o755 });
  chmodSync(path, 0o755);
  return path;
}

function createFakeSecurityBin(
  binDir: string,
  output: string,
  exitCode = 0,
) {
  createFakeBinary(
    binDir,
    "security",
    `#!/usr/bin/env bash
if [ ${exitCode} -ne 0 ]; then
  exit ${exitCode}
fi
echo '${output.replace(/'/g, "'\\''")}'
`,
  );
}

function createFakeCurlBin(binDir: string, output: string, exitCode = 0) {
  createFakeBinary(
    binDir,
    "curl",
    `#!/usr/bin/env bash
if [ ${exitCode} -ne 0 ]; then
  exit ${exitCode}
fi
echo '${output.replace(/'/g, "'\\''")}'
`,
  );
}

interface RunResult {
  stdout: string;
  stderr: string;
  status: number | null;
}

function runCLI(
  args: string[],
  opts: {
    binDir: string;
    homeDir: string;
    extraEnv?: Record<string, string>;
  },
): RunResult {
  const env: Record<string, string> = {
    PATH: `${opts.binDir}:/usr/bin:/bin:/usr/local/bin`,
    HOME: opts.homeDir,
    CLAUDE_USAGE_KEYCHAIN_USER: "testuser",
    ...(opts.extraEnv || {}),
  };

  const result = spawnSync("bash", [SCRIPT_PATH, ...args], {
    env,
    encoding: "utf-8",
    timeout: 15000,
  });

  return {
    stdout: result.stdout || "",
    stderr: result.stderr || "",
    status: result.status,
  };
}

// --- Test state ---

let binDir: string;
let homeDir: string;

beforeEach(() => {
  binDir = tmpDir("bin");
  homeDir = tmpDir("home");
});

// --- Tests ---

describe("CLI outputs valid JSON", () => {
  it("outputs valid JSON with five_hour and seven_day utilization fields", () => {
    createFakeSecurityBin(binDir, SAMPLE_KEYCHAIN_JSON);
    createFakeCurlBin(binDir, SAMPLE_API_RESPONSE);

    // Create sequence.json
    const seqDir = join(homeDir, ".claude-swap-backup");
    mkdirSync(seqDir, { recursive: true });
    writeFileSync(
      join(seqDir, "sequence.json"),
      JSON.stringify(SAMPLE_SEQUENCE_JSON),
    );

    // Create .symphony dir for cache
    mkdirSync(join(homeDir, ".symphony"), { recursive: true });

    const result = runCLI(["--json"], { binDir, homeDir });
    expect(result.status).toBe(0);

    const output = JSON.parse(result.stdout);
    expect(output.five_hour).toBeDefined();
    expect(output.five_hour.utilization).toBe(3);
    expect(output.seven_day).toBeDefined();
    expect(output.seven_day.utilization).toBe(48);
    expect(output.five_hour.resets_at).toBe(
      "2026-03-31T03:00:00.663100+00:00",
    );
    expect(output.seven_day.resets_at).toBe(
      "2026-04-04T09:59:59.663126+00:00",
    );
  });

  it("includes active_account fields", () => {
    createFakeSecurityBin(binDir, SAMPLE_KEYCHAIN_JSON);
    createFakeCurlBin(binDir, SAMPLE_API_RESPONSE);

    const seqDir = join(homeDir, ".claude-swap-backup");
    mkdirSync(seqDir, { recursive: true });
    writeFileSync(
      join(seqDir, "sequence.json"),
      JSON.stringify(SAMPLE_SEQUENCE_JSON),
    );
    mkdirSync(join(homeDir, ".symphony"), { recursive: true });

    const result = runCLI(["--json"], { binDir, homeDir });
    expect(result.status).toBe(0);

    const output = JSON.parse(result.stdout);
    expect(output.active_account).toBeDefined();
    expect(output.active_account.email).toBe("eric@mobilyze.com");
    expect(output.active_account.org).toBe(
      "eric@mobilyze.com's Organization",
    );
    expect(output.active_account.account_number).toBe(2);
  });

  it("lists accounts", () => {
    createFakeSecurityBin(binDir, SAMPLE_KEYCHAIN_JSON);
    createFakeCurlBin(binDir, SAMPLE_API_RESPONSE);

    const seqDir = join(homeDir, ".claude-swap-backup");
    mkdirSync(seqDir, { recursive: true });
    writeFileSync(
      join(seqDir, "sequence.json"),
      JSON.stringify(SAMPLE_SEQUENCE_JSON),
    );
    mkdirSync(join(homeDir, ".symphony"), { recursive: true });

    const result = runCLI(["--json"], { binDir, homeDir });
    expect(result.status).toBe(0);

    const output = JSON.parse(result.stdout);
    expect(output.accounts).toHaveLength(2);
    expect(output.accounts[0]).toHaveProperty("email");
    expect(output.accounts[0]).toHaveProperty("account_number");
    expect(output.accounts[1]).toHaveProperty("email");
    expect(output.accounts[1]).toHaveProperty("account_number");

    const emails = output.accounts.map(
      (a: { email: string }) => a.email,
    );
    expect(emails).toContain("eric@litman.org");
    expect(emails).toContain("eric@mobilyze.com");
  });
});

describe("CLI writes cache", () => {
  it("writes utilization to per-account cache file", () => {
    createFakeSecurityBin(binDir, SAMPLE_KEYCHAIN_JSON);
    createFakeCurlBin(binDir, SAMPLE_API_RESPONSE);

    const seqDir = join(homeDir, ".claude-swap-backup");
    mkdirSync(seqDir, { recursive: true });
    writeFileSync(
      join(seqDir, "sequence.json"),
      JSON.stringify(SAMPLE_SEQUENCE_JSON),
    );
    mkdirSync(join(homeDir, ".symphony"), { recursive: true });

    const result = runCLI(["--json"], { binDir, homeDir });
    expect(result.status).toBe(0);

    const cacheFile = join(homeDir, ".symphony", "usage-cache.json");
    expect(existsSync(cacheFile)).toBe(true);

    const cache = JSON.parse(readFileSync(cacheFile, "utf-8"));
    expect(cache["2"]).toBeDefined();
    expect(cache["2"].five_hour).toBe(3);
    expect(cache["2"].seven_day).toBe(48);
    expect(cache["2"].timestamp).toBeDefined();
  });
});

describe("CLI outputs human-readable summary", () => {
  it("human-readable output includes usage percentages and account email", () => {
    createFakeSecurityBin(binDir, SAMPLE_KEYCHAIN_JSON);
    createFakeCurlBin(binDir, SAMPLE_API_RESPONSE);

    const seqDir = join(homeDir, ".claude-swap-backup");
    mkdirSync(seqDir, { recursive: true });
    writeFileSync(
      join(seqDir, "sequence.json"),
      JSON.stringify(SAMPLE_SEQUENCE_JSON),
    );
    mkdirSync(join(homeDir, ".symphony"), { recursive: true });

    const result = runCLI([], { binDir, homeDir });
    expect(result.status).toBe(0);

    // Should contain usage percentages
    expect(result.stdout).toContain("3");
    expect(result.stdout).toContain("48");
    // Should contain account email
    expect(result.stdout).toContain("eric@mobilyze.com");
    // Should NOT be valid JSON
    expect(() => JSON.parse(result.stdout)).toThrow();
  });
});

describe("CLI exits non-zero when Keychain credentials unavailable", () => {
  it("exits non-zero with error when security command fails", () => {
    createFakeSecurityBin(binDir, "", 1);
    createFakeCurlBin(binDir, SAMPLE_API_RESPONSE);
    mkdirSync(join(homeDir, ".symphony"), { recursive: true });

    const result = runCLI(["--json"], { binDir, homeDir });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("Keychain");
  });

  it("exits non-zero when access token is empty", () => {
    createFakeSecurityBin(
      binDir,
      JSON.stringify({ claudeAiOauth: {} }),
    );
    createFakeCurlBin(binDir, SAMPLE_API_RESPONSE);
    mkdirSync(join(homeDir, ".symphony"), { recursive: true });

    const result = runCLI(["--json"], { binDir, homeDir });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("token");
  });
});

describe("CLI validates response shape", () => {
  it("validates response and exits non-zero on unexpected format", () => {
    createFakeSecurityBin(binDir, SAMPLE_KEYCHAIN_JSON);
    // Return response without five_hour field
    createFakeCurlBin(
      binDir,
      JSON.stringify({
        some_other_field: { value: 42 },
      }),
    );
    mkdirSync(join(homeDir, ".symphony"), { recursive: true });

    const result = runCLI(["--json"], { binDir, homeDir });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("Unexpected API response format");
  });

  it("validates response and exits non-zero when utilization is missing", () => {
    createFakeSecurityBin(binDir, SAMPLE_KEYCHAIN_JSON);
    createFakeCurlBin(
      binDir,
      JSON.stringify({
        five_hour: { resets_at: "2026-03-31T03:00:00+00:00" },
        seven_day: {
          utilization: 48,
          resets_at: "2026-04-04T09:59:59+00:00",
        },
      }),
    );
    mkdirSync(join(homeDir, ".symphony"), { recursive: true });

    const result = runCLI(["--json"], { binDir, homeDir });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("Unexpected API response format");
  });
});

describe("CLI handles missing sequence.json gracefully", () => {
  it("missing sequence.json results in empty accounts and null active_account", () => {
    createFakeSecurityBin(binDir, SAMPLE_KEYCHAIN_JSON);
    createFakeCurlBin(binDir, SAMPLE_API_RESPONSE);
    mkdirSync(join(homeDir, ".symphony"), { recursive: true });
    // Do NOT create sequence.json

    const result = runCLI(["--json"], { binDir, homeDir });
    expect(result.status).toBe(0);

    const output = JSON.parse(result.stdout);
    expect(output.accounts).toEqual([]);
    expect(output.active_account).toBeNull();
  });
});
