import { readFile } from "node:fs/promises";

import { expect, it } from "vitest";

it("does not invoke the removed local review runtime preflight", async () => {
  const deploy = await readFile("ops/symphony-deploy", "utf8");

  expect(deploy).not.toContain("run_review_runtime_preflight");
  expect(deploy).not.toContain("review-runtime-preflight.js");
  expect(deploy).not.toContain("SYMPHONY_COUNCIL_REVIEW_GATE");
  expect(deploy).not.toContain("CMUX_SPAWN_BIN");
  expect(deploy).toContain("review/QA runs through crabrunner when configured");
});

it("sets the service reinstall flag only when service env was refreshed", async () => {
  const deploy = await readFile("ops/symphony-deploy", "utf8");
  const envPresentBlock = deploy.match(
    /if \[\[ -f "\$local_env" \]\]; then[\s\S]*?else/,
  )?.[0];

  expect(envPresentBlock).toContain("Using service environment from .env");
  expect(envPresentBlock).toContain("if $NEED_ENV_RESTART");
  expect(envPresentBlock).toContain("NEED_SERVICE_REINSTALL=true");
});

it("warns on missing .env and continues to branch pruning", async () => {
  const deploy = await readFile("ops/symphony-deploy", "utf8");
  const missingEnvWarningIndex = deploy.indexOf(
    ".env not found — skipping service environment refresh",
  );
  const pruneIndex = deploy.indexOf("Pruning stale branches...");

  expect(missingEnvWarningIndex).toBeGreaterThan(-1);
  expect(pruneIndex).toBeGreaterThan(missingEnvWarningIndex);
});

it("reinstalls launchd when an env refresh requires it", async () => {
  const deploy = await readFile("ops/symphony-deploy", "utf8");
  const serviceBlock = deploy.match(
    /if ! service_installed; then[\s\S]*?else\s*\n {4}info "Starting service\.\.\."/,
  )?.[0];

  expect(serviceBlock).toContain(
    "elif $NEED_ENV_RESTART || $NEED_SERVICE_REINSTALL; then",
  );
  expect(serviceBlock).toContain('run_or_dry "$CTL" uninstall');
  expect(serviceBlock).toContain('run_or_dry "$CTL" install');
  expect(serviceBlock).toContain('run_or_dry "$CTL" start');
});
