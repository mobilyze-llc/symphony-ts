#!/usr/bin/env node
/**
 * Live Codex probe for the generated headless Codex config.
 *
 * Builds an ephemeral CODEX_HOME through the same code path production uses
 * (prepareDisabledSkillsConfig from dist/), takes the worker `codex.command`
 * from a WORKFLOW.md, swaps the trailing `app-server` subcommand for
 * `debug prompt-input`, and asserts the model-visible prompt contains no
 * advertised skills inventory, apps connector block, or Hindsight memory block.
 *
 * Modes:
 *   real   probe against the operator's actual Codex home (skills installed)
 *   clean  probe against an empty source home (only built-in system skills)
 *
 * Usage:
 *   pnpm probe:codex-skills [-- --workflow <path>] [--mode real|clean|both] [--keep] [--ci-smoke]
 *
 * Requires a local authed `codex` CLI and a fresh `pnpm build`. Not part of
 * `pnpm test`: this intentionally exercises the real Codex binary so it can
 * catch Codex-version drift in skill discovery (run it after Codex upgrades).
 *
 * `--ci-smoke` is intentionally lighter: it uses a clean source home and dummy
 * auth, exits 0 with an explicit warning when `codex` is unavailable, and
 * exists to catch misspelled live CLI `--disable` tokens or `[features]` keys.
 * Local verification: `pnpm build && pnpm smoke:codex-headless`.
 */
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

function parseArgs(argv) {
  const args = {
    workflow: join(repoRoot, "pipeline-config", "WORKFLOW.md"),
    mode: "both",
    keep: false,
    ciSmoke: false,
  };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--workflow" && i + 1 < argv.length) {
      args.workflow = resolve(argv[++i]);
    } else if (argv[i] === "--mode" && i + 1 < argv.length) {
      args.mode = argv[++i];
    } else if (argv[i] === "--keep") {
      args.keep = true;
    } else if (argv[i] === "--ci-smoke") {
      args.ciSmoke = true;
    } else {
      console.error(`Unknown argument: ${argv[i]}`);
      process.exit(2);
    }
  }
  if (!["real", "clean", "both"].includes(args.mode)) {
    console.error(`--mode must be real, clean, or both (got ${args.mode})`);
    process.exit(2);
  }
  if (args.ciSmoke) {
    args.mode = "clean";
  }
  return args;
}

async function importDist() {
  const distEntries = [
    join(repoRoot, "dist", "src", "config", "workflow-loader.js"),
    join(repoRoot, "dist", "src", "config", "config-resolver.js"),
    join(repoRoot, "dist", "src", "codex", "app-server-client.js"),
  ];
  for (const entry of distEntries) {
    if (!existsSync(entry)) {
      console.error(`Missing ${entry} — run \`pnpm build\` first.`);
      process.exit(2);
    }
  }
  const [loader, resolver, codex] = await Promise.all(
    distEntries.map((entry) => import(entry)),
  );
  return {
    loadWorkflowDefinition: loader.loadWorkflowDefinition,
    resolveWorkflowConfig: resolver.resolveWorkflowConfig,
    prepareDisabledSkillsConfig: codex.prepareDisabledSkillsConfig,
  };
}

function probeCommandFrom(workerCommand) {
  const trimmed = workerCommand.trim();
  if (!trimmed.endsWith("app-server")) {
    console.error(
      `codex.command does not end with "app-server"; cannot derive the probe shape from: ${trimmed}`,
    );
    process.exit(2);
  }
  return `${trimmed.slice(0, -"app-server".length)}debug prompt-input 'symphony disable-skills probe noop'`;
}

async function buildEphemeralHome(input) {
  const sourceAuth = join(input.authSourceHome, "auth.json");
  if (!existsSync(sourceAuth)) {
    if (input.dummyAuth === true) {
      await writeFile(sourceAuth, "{}\n");
    } else {
      console.error(
        `No readable auth.json at ${sourceAuth} — the probe mirrors production, which symlinks operator auth into the ephemeral home.`,
      );
      process.exit(2);
    }
  }
  const codexHome = await mkdtemp(
    join(tmpdir(), "symphony-codex-skills-probe-"),
  );
  // Register for cleanup before any operation that can throw, so a failed
  // symlink or config render does not leak the directory.
  input.scratch.push(codexHome);
  await symlink(sourceAuth, join(codexHome, "auth.json"));
  const config = await input.prepareDisabledSkillsConfig({
    codexHome,
    cwd: input.cwd,
    sourceHome: input.sourceHome,
  });
  await writeFile(join(codexHome, "config.toml"), config);
  return codexHome;
}

function runProbe(command, codexHome, cwd) {
  // bash -lc mirrors the production worker spawn exactly (app-server-client
  // launches via spawn("bash", ["-lc", ...])) so shell semantics cannot drift.
  return spawnSync("bash", ["-lc", command], {
    cwd,
    env: { ...process.env, CODEX_HOME: codexHome },
    encoding: "utf8",
    timeout: 120_000,
    maxBuffer: 32 * 1024 * 1024,
  });
}

function evaluate(label, result) {
  const failures = [];
  if (result.error !== undefined) {
    failures.push(`codex failed to run: ${result.error.message}`);
  } else if (result.status !== 0) {
    const signalSuffix =
      result.signal === null || result.signal === undefined
        ? ""
        : ` (signal ${result.signal})`;
    failures.push(`codex exited with status ${result.status}${signalSuffix}`);
  }
  // Content assertions run against stdout only: that is the rendered prompt
  // (the model-visible surface). stderr diagnostics can mention skill paths
  // without those skills being advertised to the model.
  const stdout = result.stdout ?? "";
  if (stdout.trim().length < 200) {
    failures.push(
      `suspiciously short prompt output (${stdout.trim().length} chars) — codex may not have rendered the prompt`,
    );
  }
  if (/### Available skills/i.test(stdout)) {
    failures.push(
      "prompt still advertises a skills inventory (`### Available skills`)",
    );
  }
  if (/<apps_instructions>|## Apps \(Connectors\)/i.test(stdout)) {
    failures.push("prompt still advertises apps connector instructions");
  }
  if (/hindsight/i.test(stdout)) {
    failures.push("prompt still contains a Hindsight memory block");
  }
  const status = failures.length === 0 ? "PASS" : "FAIL";
  console.log(`[${label}] ${status} — prompt chars: ${stdout.length}`);
  for (const failure of failures) {
    console.log(`[${label}]   ✗ ${failure}`);
  }
  return failures.length === 0;
}

const args = parseArgs(process.argv.slice(2));
const {
  loadWorkflowDefinition,
  resolveWorkflowConfig,
  prepareDisabledSkillsConfig,
} = await importDist();

const codexVersion = spawnSync("codex", ["--version"], { encoding: "utf8" });
if (codexVersion.error !== undefined || codexVersion.status !== 0) {
  if (args.ciSmoke) {
    console.log(
      "::warning::codex binary not found on PATH; skipped live Codex headless feature-flag smoke. Local verification: pnpm build && pnpm smoke:codex-headless",
    );
    process.exit(0);
  }
  console.error(
    "codex binary not found on PATH — this probe needs a local Codex CLI.",
  );
  process.exit(2);
}
console.log(`codex: ${codexVersion.stdout.trim()}`);

const workflow = await loadWorkflowDefinition(args.workflow);
const resolved = resolveWorkflowConfig(workflow);
const probeCommand = probeCommandFrom(resolved.codex.command);
console.log(`workflow: ${args.workflow}`);
console.log(`probe command: ${probeCommand}`);
if (args.ciSmoke) {
  console.log(
    "CI smoke: validating shipped headless Codex command/config against the installed Codex CLI. Local verification: pnpm build && pnpm smoke:codex-headless",
  );
}

const operatorHome = process.env.CODEX_HOME ?? join(homedir(), ".codex");
const scratch = [];
let allPassed = true;

try {
  if (args.mode === "real" || args.mode === "both") {
    const home = await buildEphemeralHome({
      sourceHome: operatorHome,
      authSourceHome: operatorHome,
      cwd: repoRoot,
      prepareDisabledSkillsConfig,
      scratch,
    });
    allPassed =
      evaluate("real", runProbe(probeCommand, home, repoRoot)) && allPassed;
  }

  if (args.mode === "clean" || args.mode === "both") {
    const emptySourceHome = await mkdtemp(
      join(tmpdir(), "symphony-codex-skills-probe-clean-src-"),
    );
    const emptyCwd = await mkdtemp(
      join(tmpdir(), "symphony-codex-skills-probe-clean-cwd-"),
    );
    scratch.push(emptySourceHome, emptyCwd);
    const home = await buildEphemeralHome({
      sourceHome: emptySourceHome,
      authSourceHome: args.ciSmoke ? emptySourceHome : operatorHome,
      cwd: emptyCwd,
      prepareDisabledSkillsConfig,
      scratch,
      dummyAuth: args.ciSmoke,
    });
    allPassed =
      evaluate("clean", runProbe(probeCommand, home, emptyCwd)) && allPassed;
  }
} finally {
  if (args.keep) {
    console.log(`--keep set; probe dirs retained:\n  ${scratch.join("\n  ")}`);
  } else {
    await Promise.allSettled(
      scratch.map((path) => rm(path, { recursive: true, force: true })),
    );
  }
}

process.exit(allPassed ? 0 : 1);
