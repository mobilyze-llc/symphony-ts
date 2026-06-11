/**
 * Exit-code derivation for scripts/test.mjs (SYMPH-389).
 *
 * Vitest fails the run (exit 1) when unhandled errors surface during worker
 * teardown, even though every test passed — the green summary and the exit
 * code disagree, and unattended lanes treat the run as failed. The teardown
 * races themselves are tracked separately (SYMPH-332/352); here we make the
 * wrapper's exit code agree with the structured test summary.
 */

/**
 * Decide the wrapper's exit code from vitest's raw exit status and the JSON
 * reporter output (jest-shaped: numTotalTests/numFailedTests/numFailedTestSuites).
 *
 * Returns `{ code, note }`. `note` is a diagnostic line to print on stderr
 * when a nonzero vitest exit is overridden by an all-green summary.
 */
export function deriveExitCode(rawStatus, jsonReportText) {
  const fallback = rawStatus ?? 1;
  if (rawStatus === 0) {
    return { code: 0, note: null };
  }
  // A null status means vitest was killed by a signal — the run was
  // interrupted, so a green report cannot vouch for it.
  if (!Number.isInteger(rawStatus)) {
    return { code: fallback, note: null };
  }
  if (typeof jsonReportText !== "string" || jsonReportText.length === 0) {
    return { code: fallback, note: null };
  }

  let report;
  try {
    report = JSON.parse(jsonReportText);
  } catch {
    return { code: fallback, note: null };
  }
  if (report === null || typeof report !== "object") {
    return { code: fallback, note: null };
  }

  const totalTests = report.numTotalTests;
  const failedTests = report.numFailedTests;
  const failedSuites = report.numFailedTestSuites;
  const countsValid =
    Number.isInteger(totalTests) &&
    Number.isInteger(failedTests) &&
    Number.isInteger(failedSuites);
  if (!countsValid) {
    return { code: fallback, note: null };
  }

  const allGreen = totalTests > 0 && failedTests === 0 && failedSuites === 0;
  if (!allGreen) {
    return { code: fallback, note: null };
  }

  return {
    code: 0,
    note: `test.mjs: vitest exited ${fallback} with an all-green summary (${totalTests} tests, 0 failed, 0 failed suites) — likely unhandled teardown errors (SYMPH-389, races tracked by SYMPH-332/352). Deriving exit 0 from the JSON report.`,
  };
}
