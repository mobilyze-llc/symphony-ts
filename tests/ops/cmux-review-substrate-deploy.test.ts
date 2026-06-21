import { spawnSync } from "node:child_process";
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, expect, it } from "vitest";

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.allSettled(
    tempDirs
      .splice(0)
      .map((path) => rm(path, { recursive: true, force: true })),
  );
});

it("prints the runbook and lightweight Kimi review contract in help", () => {
  const result = spawnSync(
    "bash",
    ["ops/cmux-review-substrate-deploy", "--help"],
    {
      encoding: "utf8",
    },
  );

  expect(result.status).toBe(0);
  expect(result.stdout).toContain(
    "docs/operations/01-cmux-review-substrate-deploy.md",
  );
  expect(result.stdout).toContain("Kimi review lane");
  expect(result.stdout).toContain("Fix meaningful correctness");
});

it("writes a local evidence bundle and caller audit without remote access", async () => {
  const root = await createTempDir("cmux-deploy-evidence-");
  const auditRoot = join(root, "audit-root");
  const artifactDir = join(root, "evidence");
  await mkdir(auditRoot, { recursive: true });
  await writeFile(
    join(auditRoot, "skill.md"),
    [
      "CMUX_SPAWN_BIN=${CMUX_SPAWN_BIN:-/Users/ericlitman/projects/crucible/bin/cmux-spawn}",
      "CMUX_SPAWN_BIN=${CMUX_SPAWN_BIN:-$(command -v cmux-spawn || true)}",
      "CMUX_SPAWN_BIN=${CMUX_SPAWN_BIN:-$HOME/projects/crucible/bin/cmux-spawn-remote}",
      "",
    ].join("\n"),
  );

  const result = spawnSync(
    "bash",
    [
      "ops/cmux-review-substrate-deploy",
      "--no-remote",
      "--artifact-dir",
      artifactDir,
    ],
    {
      encoding: "utf8",
      env: {
        ...process.env,
        CMUX_DEPLOY_AUDIT_ROOTS: auditRoot,
      },
    },
  );

  expect(result.status).toBe(0);
  expect(result.stdout).toContain(
    `cmux review substrate evidence: ${artifactDir}`,
  );

  const metadata = await readFile(join(artifactDir, "metadata.env"), "utf8");
  expect(metadata).toContain("schema=mobilyze.cmux-review-substrate-deploy.v1");
  expect(metadata).toContain("route_tier=forced-local-pro14");
  expect(metadata).toContain("no_remote=true");

  const skipped = await readFile(
    join(artifactDir, "remote-skipped.txt"),
    "utf8",
  );
  expect(skipped).toContain("remote probe skipped");

  const audit = await readFile(join(artifactDir, "caller-audit.txt"), "utf8");
  expect(audit).toContain("/Users/ericlitman/projects/crucible/bin/cmux-spawn");
  expect(audit).toContain("command -v cmux-spawn");
  expect(audit).not.toContain("cmux-spawn-remote");

  const summary = await readFile(join(artifactDir, "README.md"), "utf8");
  expect(summary).toContain("Classify every `caller-audit.txt` hit");
  expect(summary).toContain("Kimi lightweight review artifact");
});

it("passes remote gates when Pro16 preflight and checkout gates are healthy", async () => {
  const root = await createTempDir("cmux-deploy-remote-ok-");
  const artifactDir = join(root, "evidence");
  const fakeSsh = await writeFakeSsh(root);
  const fakeCrucible = await writeFakeCrucible(root, true);

  const result = spawnSync(
    "bash",
    ["ops/cmux-review-substrate-deploy", "--artifact-dir", artifactDir],
    {
      encoding: "utf8",
      env: {
        ...process.env,
        CMUX_REVIEW_SSH_BIN: fakeSsh,
        LOCAL_CRUCIBLE: fakeCrucible,
      },
    },
  );

  expect(result.status).toBe(0);

  const metadata = await readFile(join(artifactDir, "metadata.env"), "utf8");
  expect(metadata).toContain("route_tier=remote-pro16");
  expect(metadata).toContain(
    "effective_runtime_root=clawdilize@pro16.local:~/projects/crucible",
  );
  expect(metadata).toContain("failure_count=0");

  const gates = await readFile(
    join(artifactDir, "remote-checkout-gates.tsv"),
    "utf8",
  );
  expect(gates).toContain("symphony\t/Users/clawdilize/projects/symphony-ts");
  expect(gates).toContain("\tpass");

  const failures = await readFile(
    join(artifactDir, "gate-failures.txt"),
    "utf8",
  );
  expect(failures).toBe("");
});

it("fails closed when the remote preflight fails", async () => {
  const root = await createTempDir("cmux-deploy-remote-fail-");
  const artifactDir = join(root, "evidence");
  const fakeSsh = await writeFakeSsh(root);
  const fakeCrucible = await writeFakeCrucible(root, false);

  const result = spawnSync(
    "bash",
    ["ops/cmux-review-substrate-deploy", "--artifact-dir", artifactDir],
    {
      encoding: "utf8",
      env: {
        ...process.env,
        CMUX_REVIEW_SSH_BIN: fakeSsh,
        LOCAL_CRUCIBLE: fakeCrucible,
      },
    },
  );

  expect(result.status).toBe(1);
  expect(result.stderr).toContain("deploy gates failed");

  const metadata = await readFile(join(artifactDir, "metadata.env"), "utf8");
  expect(metadata).toContain("route_tier=failed-closed");
  expect(metadata).toContain("failure_count=1");

  const failures = await readFile(
    join(artifactDir, "gate-failures.txt"),
    "utf8",
  );
  expect(failures).toContain("remote preflight: exited 5");
});

async function createTempDir(prefix: string): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), prefix));
  tempDirs.push(path);
  return path;
}

async function writeFakeSsh(root: string): Promise<string> {
  const path = join(root, "fake-ssh");
  await writeFile(
    path,
    [
      "#!/usr/bin/env bash",
      "set -euo pipefail",
      'while [[ "${1:-}" == "-o" ]]; do shift 2; done',
      "shift || true",
      'cmd="$*"',
      'if [[ "$cmd" == *"bash -s"* ]]; then',
      "  cat >/dev/null",
      '  printf "symphony\\t/Users/clawdilize/projects/symphony-ts\\tabc\\tmain\\tmain\\t0\\torigin/main\\tabc\\ttrue\\tpass\\n"',
      '  printf "crucible\\t/Users/clawdilize/projects/crucible\\tdef\\tmain\\tmain\\t0\\torigin/main\\tdef\\ttrue\\tpass\\n"',
      "  exit 0",
      "fi",
      'if [[ "$cmd" == *"cmux-spawn run --help"* ]]; then',
      '  printf "usage: cmux-spawn run --agent {agy,claude,codex,kimi,pi}\\n"',
      "  exit 0",
      "fi",
      'if [[ "$cmd" == *"cmux --version"* ]]; then',
      '  printf "cmux 0.64.15 (95)\\n"',
      "  exit 0",
      "fi",
      'if [[ "$cmd" == *"git status"* ]]; then',
      '  printf "## main...origin/main\\nabc 2026-06-15 00:00:00 +0000 (HEAD -> main) fake\\nabc\\n"',
      "  exit 0",
      "fi",
      "exit 0",
      "",
    ].join("\n"),
  );
  await chmod(path, 0o755);
  return path;
}

async function writeFakeCrucible(
  root: string,
  preflightOk: boolean,
): Promise<string> {
  const bin = join(root, "crucible", "bin");
  await mkdir(bin, { recursive: true });
  const path = join(bin, "cmux-spawn-remote");
  await writeFile(
    path,
    [
      "#!/usr/bin/env bash",
      'if [[ "${1:-}" == "preflight" ]]; then',
      preflightOk
        ? '  printf \'{"ok":true,"errors":[]}\\n\'; exit 0'
        : '  printf \'{"ok":false,"errors":["boom"]}\\n\'; exit 5',
      "fi",
      "exit 64",
      "",
    ].join("\n"),
  );
  await chmod(path, 0o755);
  return join(root, "crucible");
}
