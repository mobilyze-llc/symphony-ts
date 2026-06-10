import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import {
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const SCRIPT_PATH = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../../scripts/symphony-run-logged.mjs",
);

let tmpDir: string;

function makeTmpDir(): string {
  const dir = join(
    tmpdir(),
    `symphony-run-logged-test-${randomBytes(6).toString("hex")}`,
  );
  mkdirSync(dir, { recursive: true });
  return dir;
}

function runLogged(args: string[]): {
  stdout: string;
  stderr: string;
  status: number | null;
} {
  const result = spawnSync(process.execPath, [SCRIPT_PATH, ...args], {
    encoding: "utf8",
    timeout: 15_000,
  });
  return {
    stdout: result.stdout,
    stderr: result.stderr,
    status: result.status,
  };
}

function readOnlyLog(): string {
  const logs = readdirSync(tmpDir).filter((name) => name.endsWith(".log"));
  expect(logs).toHaveLength(1);
  return readFileSync(join(tmpDir, logs[0]!), "utf8");
}

describe("symphony-run-logged", () => {
  beforeEach(() => {
    tmpDir = makeTmpDir();
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("keeps full command output in a log while returning a bounded tail", () => {
    const noisyProgram = [
      "for (let index = 0; index < 200; index += 1) {",
      "  console.log(`NOISY_LINE_${index} ${'x'.repeat(120)}`);",
      "}",
    ].join("\n");

    const result = runLogged([
      "--label",
      "noisy",
      "--log-dir",
      tmpDir,
      "--tail-bytes",
      "900",
      "--",
      process.execPath,
      "-e",
      noisyProgram,
    ]);

    expect(result.status).toBe(0);
    expect(result.stderr).toBe("");
    expect(result.stdout).toContain("[symphony-run-logged] exit_code: 0");
    expect(result.stdout).toContain("[symphony-run-logged] log:");
    expect(result.stdout).toContain("NOISY_LINE_199");
    expect(result.stdout).not.toContain("NOISY_LINE_0");
    expect(Buffer.byteLength(result.stdout, "utf8")).toBeLessThan(2_000);

    const log = readOnlyLog();
    expect(log).toContain("NOISY_LINE_0");
    expect(log).toContain("NOISY_LINE_199");
    expect(Buffer.byteLength(log, "utf8")).toBeGreaterThan(
      Buffer.byteLength(result.stdout, "utf8"),
    );
  });

  it("preserves nonzero validation exit codes", () => {
    const result = runLogged([
      "--label",
      "failure",
      "--log-dir",
      tmpDir,
      "--",
      process.execPath,
      "-e",
      "console.error('validation failed'); process.exit(7);",
    ]);

    expect(result.status).toBe(7);
    expect(result.stdout).toContain("[symphony-run-logged] exit_code: 7");
    expect(result.stdout).toContain("validation failed");
    expect(readOnlyLog()).toContain("validation failed");
  });

  it("returns 127 instead of hanging when the command cannot spawn", () => {
    const result = runLogged([
      "--label",
      "missing-command",
      "--log-dir",
      tmpDir,
      "--",
      "/definitely/missing/symphony-run-logged-command",
    ]);

    expect(result.status).toBe(127);
    expect(result.stderr).toBe("");
    expect(result.stdout).toContain("[symphony-run-logged] exit_code: 127");
    expect(result.stdout).toContain("ENOENT");
    expect(readOnlyLog()).toContain("ENOENT");
  });

  it("fails cleanly when the validation log directory cannot be created", () => {
    const filePath = join(tmpDir, "not-a-directory");
    writeFileSync(filePath, "already a file\n");

    const result = runLogged([
      "--label",
      "log-dir-error",
      "--log-dir",
      filePath,
      "--",
      process.execPath,
      "-e",
      "process.exit(0);",
    ]);

    expect(result.status).toBe(74);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("[symphony-run-logged] log_dir_error:");
  });

  it("keeps bounded UTF-8 tails valid when trimming after split chunks", () => {
    const splitUtf8Program = [
      'const prefix = Buffer.from(`PREFIX-${"x".repeat(80)}`, "utf8");',
      'const emoji = Buffer.from("🙂", "utf8");',
      'const suffix = Buffer.from("TAIL", "utf8");',
      "process.stdout.write(prefix);",
      "process.stdout.write(emoji.subarray(0, 2));",
      "setTimeout(() => {",
      "  process.stdout.write(emoji.subarray(2));",
      "  process.stdout.end(suffix);",
      "}, 10);",
    ].join("\n");

    const result = runLogged([
      "--label",
      "utf8",
      "--log-dir",
      tmpDir,
      "--tail-bytes",
      "12",
      "--",
      process.execPath,
      "-e",
      splitUtf8Program,
    ]);

    expect(result.status).toBe(0);
    expect(result.stdout).not.toContain("�");
    const tailMatch = result.stdout.match(
      /--- log tail ---\n([\s\S]*?)\n--- end log tail ---/,
    );
    expect(tailMatch).not.toBeNull();
    const tailBody = tailMatch?.[1] ?? "";
    expect(tailBody).toContain("🙂TAIL");
    expect(tailBody).not.toContain("PREFIX-");
    expect(Buffer.byteLength(tailBody, "utf8")).toBeLessThanOrEqual(12);

    const log = readOnlyLog();
    expect(log).toContain("PREFIX-");
    expect(log).toContain("🙂TAIL");
  });
});
