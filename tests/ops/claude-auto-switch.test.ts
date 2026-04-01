/**
 * Tests for ops/claude-auto-switch — SYMPH-241
 *
 * Each test spawns the bash script as a subprocess with a shimmed PATH
 * pointing to fake `claude-usage`, `cswap`, and `curl` binaries in a temp directory.
 * Each test gets its own HOME for cache isolation.
 *
 * Uses async spawn (not spawnSync) to avoid blocking the vitest worker
 * event loop — spawnSync prevents the worker from answering IPC
 * heartbeats, causing "Timeout calling onTaskUpdate" failures under load.
 */

import { spawn } from "node:child_process";
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
import { beforeEach, describe, expect, it } from "vitest";

const __dirname = dirname(fileURLToPath(import.meta.url));
const SCRIPT_PATH = join(__dirname, "../../ops/claude-auto-switch");

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

interface TestContext {
  homeDir: string;
  shimDir: string;
  opsShimDir: string;
}

function createTestContext(): TestContext {
  const id = randomBytes(6).toString("hex");
  const homeDir = join(tmpdir(), `claude-auto-switch-test-${id}`);
  const shimDir = join(homeDir, "shims");
  // Create a fake ops/ directory for the claude-usage shim
  const opsShimDir = join(homeDir, "fake-ops");
  mkdirSync(shimDir, { recursive: true });
  mkdirSync(opsShimDir, { recursive: true });
  return { homeDir, shimDir, opsShimDir };
}

function writeShim(dir: string, name: string, script: string) {
  const path = join(dir, name);
  writeFileSync(path, `#!/usr/bin/env bash\n${script}\n`);
  chmodSync(path, 0o755);
}

/**
 * Create a fake claude-usage script that outputs given JSON when called with --json
 */
function writeFakeClaudeUsage(
  opsShimDir: string,
  usageData: {
    five_hour_util: number;
    seven_day_util: number;
    active_account_num: number;
  },
) {
  const output = JSON.stringify({
    five_hour: {
      utilization: usageData.five_hour_util,
      resets_at: "2026-04-01T03:00:00+00:00",
    },
    seven_day: {
      utilization: usageData.seven_day_util,
      resets_at: "2026-04-04T10:00:00+00:00",
    },
    active_account: {
      account_number: usageData.active_account_num,
      email:
        usageData.active_account_num === 2
          ? "eric@mobilyze.com"
          : "eric@litman.org",
      org:
        usageData.active_account_num === 2
          ? "eric@mobilyze.com's Organization"
          : "Eric Litman",
    },
    accounts: [
      { account_number: 1, email: "eric@litman.org", org: "Eric Litman" },
      {
        account_number: 2,
        email: "eric@mobilyze.com",
        org: "eric@mobilyze.com's Organization",
      },
    ],
  });

  const responseFile = join(opsShimDir, "usage_response.json");
  writeFileSync(responseFile, output);
  writeShim(opsShimDir, "claude-usage", `cat "${responseFile}"`);
}

/**
 * Create a fake curl shim. For /api/v1/state, return the given state response.
 */
function writeFakeCurlShim(
  shimDir: string,
  stateResponse: string | null,
  exitCode = 0,
) {
  if (stateResponse === null || exitCode !== 0) {
    // Connection refused / unreachable
    writeShim(
      shimDir,
      "curl",
      `echo "curl: (7) Failed to connect" >&2; exit 7`,
    );
  } else {
    const responseFile = join(shimDir, "curl_response.json");
    writeFileSync(responseFile, stateResponse);
    writeShim(shimDir, "curl", `cat "${responseFile}"`);
  }
}

function writeFakeCswap(shimDir: string, logFile: string, exitCode = 0) {
  writeShim(
    shimDir,
    "cswap",
    `echo "cswap called with: $@" >> "${logFile}"; exit ${exitCode}`,
  );
}

function writeSequenceJson(homeDir: string, data: object) {
  const dir = join(homeDir, ".claude-swap-backup");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "sequence.json"), JSON.stringify(data));
}

function writeUsageCache(homeDir: string, data: Record<string, unknown>) {
  const dir = join(homeDir, ".symphony");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "usage-cache.json"), JSON.stringify(data));
}

function writeCooldownFile(homeDir: string, isoTimestamp: string) {
  const dir = join(homeDir, ".symphony");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "auto-switch-last"), isoTimestamp);
}

function makeStateResponse(runningCount: number): string {
  const issues = [];
  for (let i = 0; i < runningCount; i++) {
    issues.push({ id: `issue-${i}`, status: "running" });
  }
  return JSON.stringify({ issues });
}

const CLI_TIMEOUT_MS = 20_000;
const TEST_TIMEOUT_MS = 30_000;

function runAutoSwitch(
  ctx: TestContext,
  extraEnv: Record<string, string> = {},
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  return new Promise((resolve) => {
    const cswapLogFile = join(ctx.homeDir, "cswap.log");
    const env: Record<string, string> = {
      HOME: ctx.homeDir,
      PATH: `${ctx.shimDir}:${ctx.opsShimDir}:/usr/bin:/bin:/usr/local/bin`,
      BASE_URL: "fake-dashboard:9999",
      ...extraEnv,
    };

    // We need to patch the script to use our fake ops dir.
    // The script uses SCRIPT_DIR to find claude-usage, so we create a
    // wrapper that sets SCRIPT_DIR to our fake ops dir.
    const wrapperPath = join(ctx.homeDir, "run-auto-switch.sh");
    writeFileSync(
      wrapperPath,
      `${[
        "#!/usr/bin/env bash",
        // Override SCRIPT_DIR by sourcing the real script content
        // but replacing the SCRIPT_DIR assignment
        `export HOME="${ctx.homeDir}"`,
        `export PATH="${ctx.shimDir}:${ctx.opsShimDir}:/usr/bin:/bin:/usr/local/bin"`,
        `export BASE_URL="${env.BASE_URL}"`,
        // Read the real script, replace SCRIPT_DIR, and eval it
        `sed 's|^SCRIPT_DIR=.*|SCRIPT_DIR="${ctx.opsShimDir}"|' "${SCRIPT_PATH}" | bash`,
      ].join("\n")}\n`,
    );
    chmodSync(wrapperPath, 0o755);

    // Ensure cswap shim exists
    if (!existsSync(join(ctx.shimDir, "cswap"))) {
      writeFakeCswap(ctx.shimDir, cswapLogFile);
    }

    const child = spawn("bash", [wrapperPath], {
      env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
    }, CLI_TIMEOUT_MS);
    child.on("error", (err) => {
      clearTimeout(timer);
      resolve({ stdout, stderr: stderr + err.message, exitCode: 1 });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ stdout, stderr, exitCode: code ?? 1 });
    });
  });
}

function cswapWasCalled(ctx: TestContext): boolean {
  const logFile = join(ctx.homeDir, "cswap.log");
  if (!existsSync(logFile)) return false;
  const content = readFileSync(logFile, "utf-8");
  return content.includes("--switch");
}

describe("ops/claude-auto-switch", { timeout: TEST_TIMEOUT_MS }, () => {
  let ctx: TestContext;

  beforeEach(() => {
    ctx = createTestContext();
  });

  it("switches on 5hr threshold", async () => {
    writeFakeClaudeUsage(ctx.opsShimDir, {
      five_hour_util: 92,
      seven_day_util: 40,
      active_account_num: 2,
    });
    writeFakeCurlShim(ctx.shimDir, makeStateResponse(0));
    writeSequenceJson(ctx.homeDir, SAMPLE_SEQUENCE);
    writeUsageCache(ctx.homeDir, {
      "1": {
        five_hour: 30,
        seven_day: 20,
        timestamp: new Date().toISOString(),
      },
    });
    const cswapLog = join(ctx.homeDir, "cswap.log");
    writeFakeCswap(ctx.shimDir, cswapLog);

    const result = await runAutoSwitch(ctx);
    expect(result.exitCode).toBe(0);
    expect(cswapWasCalled(ctx)).toBe(true);
  });

  it("switches on weekly threshold", async () => {
    writeFakeClaudeUsage(ctx.opsShimDir, {
      five_hour_util: 30,
      seven_day_util: 96,
      active_account_num: 2,
    });
    writeFakeCurlShim(ctx.shimDir, makeStateResponse(0));
    writeSequenceJson(ctx.homeDir, SAMPLE_SEQUENCE);
    const cswapLog = join(ctx.homeDir, "cswap.log");
    writeFakeCswap(ctx.shimDir, cswapLog);

    const result = await runAutoSwitch(ctx);
    expect(result.exitCode).toBe(0);
    expect(cswapWasCalled(ctx)).toBe(true);
  });

  it("respects cooldown", async () => {
    writeFakeClaudeUsage(ctx.opsShimDir, {
      five_hour_util: 95,
      seven_day_util: 40,
      active_account_num: 2,
    });
    writeFakeCurlShim(ctx.shimDir, makeStateResponse(0));
    writeSequenceJson(ctx.homeDir, SAMPLE_SEQUENCE);
    const cswapLog = join(ctx.homeDir, "cswap.log");
    writeFakeCswap(ctx.shimDir, cswapLog);

    // Write cooldown timestamp 2 minutes ago
    const twoMinutesAgo = new Date(Date.now() - 2 * 60 * 1000);
    writeCooldownFile(ctx.homeDir, twoMinutesAgo.toISOString());

    const result = await runAutoSwitch(ctx);
    expect(result.exitCode).toBe(0);
    expect(cswapWasCalled(ctx)).toBe(false);
    expect(result.stdout).toContain("Cooldown active");
  });

  it("no switch within limits", async () => {
    writeFakeClaudeUsage(ctx.opsShimDir, {
      five_hour_util: 60,
      seven_day_util: 50,
      active_account_num: 2,
    });
    writeFakeCurlShim(ctx.shimDir, makeStateResponse(0));
    writeSequenceJson(ctx.homeDir, SAMPLE_SEQUENCE);
    const cswapLog = join(ctx.homeDir, "cswap.log");
    writeFakeCswap(ctx.shimDir, cswapLog);

    const result = await runAutoSwitch(ctx);
    expect(result.exitCode).toBe(0);
    expect(cswapWasCalled(ctx)).toBe(false);
    expect(result.stdout).toContain("within limits");
  });

  it("skips when agents running", async () => {
    writeFakeClaudeUsage(ctx.opsShimDir, {
      five_hour_util: 95,
      seven_day_util: 40,
      active_account_num: 2,
    });
    writeFakeCurlShim(ctx.shimDir, makeStateResponse(2));
    writeSequenceJson(ctx.homeDir, SAMPLE_SEQUENCE);
    const cswapLog = join(ctx.homeDir, "cswap.log");
    writeFakeCswap(ctx.shimDir, cswapLog);

    const result = await runAutoSwitch(ctx);
    expect(result.exitCode).toBe(0);
    expect(cswapWasCalled(ctx)).toBe(false);
  });

  it("logs deferred", async () => {
    writeFakeClaudeUsage(ctx.opsShimDir, {
      five_hour_util: 95,
      seven_day_util: 40,
      active_account_num: 2,
    });
    writeFakeCurlShim(ctx.shimDir, makeStateResponse(2));
    writeSequenceJson(ctx.homeDir, SAMPLE_SEQUENCE);
    const cswapLog = join(ctx.homeDir, "cswap.log");
    writeFakeCswap(ctx.shimDir, cswapLog);

    const result = await runAutoSwitch(ctx);
    expect(result.stderr).toContain("deferred");
    expect(result.stderr).toContain("running");
  });

  it("target also exhausted", async () => {
    writeFakeClaudeUsage(ctx.opsShimDir, {
      five_hour_util: 95,
      seven_day_util: 40,
      active_account_num: 2,
    });
    writeFakeCurlShim(ctx.shimDir, makeStateResponse(0));
    writeSequenceJson(ctx.homeDir, SAMPLE_SEQUENCE);
    writeUsageCache(ctx.homeDir, {
      "1": {
        five_hour: 92,
        seven_day: 30,
        timestamp: new Date().toISOString(),
      },
    });
    const cswapLog = join(ctx.homeDir, "cswap.log");
    writeFakeCswap(ctx.shimDir, cswapLog);

    const result = await runAutoSwitch(ctx);
    expect(result.exitCode).toBe(0);
    expect(cswapWasCalled(ctx)).toBe(false);
  });

  it("both accounts near limit", async () => {
    writeFakeClaudeUsage(ctx.opsShimDir, {
      five_hour_util: 95,
      seven_day_util: 40,
      active_account_num: 2,
    });
    writeFakeCurlShim(ctx.shimDir, makeStateResponse(0));
    writeSequenceJson(ctx.homeDir, SAMPLE_SEQUENCE);
    writeUsageCache(ctx.homeDir, {
      "1": {
        five_hour: 92,
        seven_day: 30,
        timestamp: new Date().toISOString(),
      },
    });
    const cswapLog = join(ctx.homeDir, "cswap.log");
    writeFakeCswap(ctx.shimDir, cswapLog);

    const result = await runAutoSwitch(ctx);
    expect(result.stderr).toContain("Both accounts near limit");
  });

  it("stale cache ignored", async () => {
    writeFakeClaudeUsage(ctx.opsShimDir, {
      five_hour_util: 95,
      seven_day_util: 40,
      active_account_num: 2,
    });
    writeFakeCurlShim(ctx.shimDir, makeStateResponse(0));
    writeSequenceJson(ctx.homeDir, SAMPLE_SEQUENCE);
    // Cache older than 10 minutes — should be ignored
    const staleTimestamp = new Date(Date.now() - 15 * 60 * 1000).toISOString();
    writeUsageCache(ctx.homeDir, {
      "1": {
        five_hour: 92,
        seven_day: 30,
        timestamp: staleTimestamp,
      },
    });
    const cswapLog = join(ctx.homeDir, "cswap.log");
    writeFakeCswap(ctx.shimDir, cswapLog);

    const result = await runAutoSwitch(ctx);
    expect(result.exitCode).toBe(0);
    expect(cswapWasCalled(ctx)).toBe(true);
  });

  it("server unreachable", async () => {
    writeFakeClaudeUsage(ctx.opsShimDir, {
      five_hour_util: 95,
      seven_day_util: 40,
      active_account_num: 2,
    });
    // Curl returns connection refused
    writeFakeCurlShim(ctx.shimDir, null, 7);
    writeSequenceJson(ctx.homeDir, SAMPLE_SEQUENCE);
    const cswapLog = join(ctx.homeDir, "cswap.log");
    writeFakeCswap(ctx.shimDir, cswapLog);

    const result = await runAutoSwitch(ctx);
    expect(result.exitCode).toBe(0);
    expect(cswapWasCalled(ctx)).toBe(false);
  });

  it("warns unreachable", async () => {
    writeFakeClaudeUsage(ctx.opsShimDir, {
      five_hour_util: 95,
      seven_day_util: 40,
      active_account_num: 2,
    });
    writeFakeCurlShim(ctx.shimDir, null, 7);
    writeSequenceJson(ctx.homeDir, SAMPLE_SEQUENCE);
    const cswapLog = join(ctx.homeDir, "cswap.log");
    writeFakeCswap(ctx.shimDir, cswapLog);

    const result = await runAutoSwitch(ctx);
    expect(result.stderr).toContain("unreachable");
  });
});
