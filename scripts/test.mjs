#!/usr/bin/env node
/**
 * Thin vitest wrapper:
 * - maps --grep <pattern> to vitest's -t <pattern>, so that
 *   `npm test -- --grep "..."` works as expected (mocha-compatible CLI).
 * - derives the exit code from vitest's structured JSON report (SYMPH-389):
 *   unhandled teardown errors flip vitest's exit to 1 even when every test
 *   passes, so an all-green summary wins over the raw exit status.
 */
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { deriveExitCode } from "./test-exit.mjs";

const args = process.argv.slice(2);
const translated = [];

for (let i = 0; i < args.length; i++) {
  if (args[i] === "--grep" && i + 1 < args.length) {
    translated.push("-t", args[++i]);
  } else {
    translated.push(args[i]);
  }
}

// CLI reporters override vitest.config.ts reporters, so re-add verbose
// alongside the JSON report. If the caller picks reporters explicitly,
// leave them alone and fall back to vitest's raw exit code.
const callerControlsReporters = translated.some(
  (arg) => arg === "--reporter" || arg.startsWith("--reporter="),
);

let reportDir = null;
let reportPath = null;
if (!callerControlsReporters) {
  reportDir = mkdtempSync(join(tmpdir(), "symphony-test-"));
  reportPath = join(reportDir, "vitest-report.json");
  translated.push(
    "--reporter=verbose",
    "--reporter=json",
    `--outputFile.json=${reportPath}`,
  );
}

const result = spawnSync("vitest", ["run", ...translated], {
  stdio: "inherit",
});

if (result.error) {
  // e.g. ENOENT when vitest is not on PATH — surface it instead of a
  // silent exit-1 with no output.
  console.error(`test.mjs: failed to spawn vitest: ${result.error.message}`);
}

let reportText = null;
if (reportPath !== null) {
  try {
    reportText = readFileSync(reportPath, "utf8");
  } catch {
    reportText = null;
  }
  rmSync(reportDir, { recursive: true, force: true });
}

const { code, note } = deriveExitCode(result.status, reportText);
if (note !== null) {
  console.error(note);
}
process.exit(code);
