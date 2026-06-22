import { spawnSync } from "node:child_process";
import {
  mkdir,
  mkdtemp,
  readFile,
  realpath,
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

it("renders export-style dotenv keys as launchd environment keys", async () => {
  const root = await createTempDir("symphony-ctl-env-");
  const envFile = join(root, ".env");
  await writeFile(
    envFile,
    [
      "# review runtime env",
      'export SYMPHONY_CRABRUNNER_ROOT="/opt/crucible"',
      "SYMPHONY_CRABRUNNER_TARGET_REPO='/opt/product-repo'",
      "PATH=/opt/homebrew/bin:/usr/bin\t# launchd path",
      "not a dotenv assignment",
      "",
    ].join("\n"),
  );

  const ctl = await readFile("ops/symphony-ctl", "utf8");
  const functionBody = ctl.match(/generate_env_dict\(\) \{[\s\S]*?\n\}/)?.[0];
  expect(functionBody).toBeDefined();

  const result = spawnSync(
    "bash",
    [
      "-c",
      `${functionBody}\nENV_FILE="$1"\ngenerate_env_dict`,
      "bash",
      envFile,
    ],
    { encoding: "utf8" },
  );

  expect(result.status).toBe(0);
  expect(result.stderr).toBe("");
  expect(result.stdout).toContain("<key>SYMPHONY_CRABRUNNER_ROOT</key>");
  expect(result.stdout).toContain("<string>/opt/crucible</string>");
  expect(result.stdout).toContain("<key>SYMPHONY_CRABRUNNER_TARGET_REPO</key>");
  expect(result.stdout).toContain("<string>/opt/product-repo</string>");
  expect(result.stdout).toContain("<key>PATH</key>");
  expect(result.stdout).toContain(
    "<string>/opt/homebrew/bin:/usr/bin</string>",
  );
  expect(result.stdout).not.toContain(
    "<key>export SYMPHONY_CRABRUNNER_ROOT</key>",
  );
  expect(result.stdout).not.toContain("'/opt/product-repo'");
  expect(result.stdout).not.toContain("launchd path");
  expect(result.stdout).not.toContain("not a dotenv assignment");
});

it("defaults the service root to the checkout containing symphony-ctl", async () => {
  const root = await createTempDir("symphony-ctl-default-root-");
  const home = join(root, "home");
  const result = await runRootProbe(root, { HOME: home });

  const runtimeRoot = await realpath(join(root, "checkout"));
  expect(result.status).toBe(0);
  expect(result.stderr).toBe("");
  expect(result.stdout).toContain(`root=${runtimeRoot}`);
  expect(result.stdout).toContain(`env=${runtimeRoot}/.env`);
  expect(result.stdout).toContain(
    `workflow=${runtimeRoot}/pipeline-config/workflows/WORKFLOW-symphony.md`,
  );
  expect(result.stdout).toContain(`cli=${runtimeRoot}/dist/src/cli/main.js`);
});

it("refuses install from worktree roots unless explicitly allowed", async () => {
  const ctl = await readFile("ops/symphony-ctl", "utf8");
  const guard = extractShellFunction(ctl, "check_service_root_not_worktree");
  const install = extractShellFunction(ctl, "cmd_install");

  expect(
    install.indexOf("check_service_root_not_worktree"),
  ).toBeGreaterThanOrEqual(0);
  expect(install.indexOf("check_service_root_not_worktree")).toBeLessThan(
    install.indexOf("check_built"),
  );

  const denied = spawnSync(
    "bash",
    [
      "-c",
      [
        'die() { echo "$*" >&2; exit 1; }',
        guard,
        'SYMPHONY_ROOT="$1"',
        "check_service_root_not_worktree",
      ].join("\n"),
      "bash",
      "/tmp/.codex/worktrees/symphony-ts-runtime-main",
    ],
    { encoding: "utf8" },
  );

  expect(denied.status).toBe(1);
  expect(denied.stderr).toContain("Refusing to install from worktree root");

  const allowed = spawnSync(
    "bash",
    [
      "-c",
      [
        'die() { echo "$*" >&2; exit 1; }',
        guard,
        "SYMPHONY_ALLOW_WORKTREE_ROOT=1",
        'SYMPHONY_ROOT="$1"',
        "check_service_root_not_worktree",
      ].join("\n"),
      "bash",
      "/tmp/.codex/worktrees/symphony-ts-runtime-main",
    ],
    { encoding: "utf8" },
  );

  expect(allowed.status).toBe(0);
  expect(allowed.stderr).toBe("");
});

it("refuses install from a linked git worktree whose path has no worktrees component", async () => {
  const root = await createTempDir("symphony-ctl-linked-worktree-");
  const primary = join(root, "primary");
  await mkdir(primary, { recursive: true });
  git(primary, ["init", "-b", "main"]);
  git(primary, ["config", "user.email", "agent@example.com"]);
  git(primary, ["config", "user.name", "Agent"]);
  await writeFile(join(primary, "README.md"), "first\n");
  git(primary, ["add", "README.md"]);
  git(primary, ["commit", "-m", "first"]);

  // Linked worktree at a path with NO "worktrees" component — substring
  // detection would miss it; the git-aware check must still refuse it.
  const linked = join(root, "linked-checkout");
  git(primary, ["worktree", "add", linked]);

  const result = await runWorktreeGuard(linked);
  expect(result.status).toBe(1);
  expect(result.stderr).toContain("linked git worktree root");
});

it("allows install from an ordinary checkout whose parent directory is named worktrees", async () => {
  const root = await createTempDir("symphony-ctl-worktrees-parent-");
  // Parent directory is literally "worktrees" but this is a primary checkout,
  // not a linked worktree — the old substring guard false-positived here.
  const checkout = join(root, "worktrees", "service-root");
  await mkdir(checkout, { recursive: true });
  git(checkout, ["init", "-b", "main"]);
  git(checkout, ["config", "user.email", "agent@example.com"]);
  git(checkout, ["config", "user.name", "Agent"]);
  await writeFile(join(checkout, "README.md"), "first\n");
  git(checkout, ["add", "README.md"]);
  git(checkout, ["commit", "-m", "first"]);

  const result = await runWorktreeGuard(checkout);
  expect(result.status).toBe(0);
  expect(result.stderr).toBe("");
});

it("warns instead of silently allowing when git is unavailable for the check", async () => {
  const root = await createTempDir("symphony-ctl-git-absent-");
  const primary = join(root, "primary");
  await mkdir(primary, { recursive: true });
  git(primary, ["init", "-b", "main"]);
  git(primary, ["config", "user.email", "agent@example.com"]);
  git(primary, ["config", "user.name", "Agent"]);
  await writeFile(join(primary, "README.md"), "first\n");
  git(primary, ["add", "README.md"]);
  git(primary, ["commit", "-m", "first"]);
  const linked = join(root, "linked-checkout");
  git(primary, ["worktree", "add", linked]);

  // Point PATH at an empty dir so `command -v git` fails on every platform
  // (bash is invoked by absolute path, so it stays runnable). NB: a bare /bin
  // is NOT git-free on merged-/usr Linux, where /bin -> /usr/bin. A safety guard
  // that cannot verify must surface the degradation, not silently allow a real
  // linked worktree through.
  const emptyBin = join(root, "no-tools");
  await mkdir(emptyBin, { recursive: true });
  const result = await runWorktreeGuard(linked, emptyBin);
  expect(result.status).toBe(0);
  expect(result.stderr).toContain("git not found on PATH");
});

it("resolves service root overrides in documented precedence order", async () => {
  const root = await createTempDir("symphony-ctl-root-precedence-");
  const home = join(root, "home");

  const serviceRootResult = await runRootProbe(root, {
    HOME: home,
    SYMPHONY_RUNTIME_CHECKOUT: "/tmp/runtime-root",
    SYMPHONY_SERVICE_ROOT: "/tmp/service-root",
  });
  expect(serviceRootResult.status).toBe(0);
  expect(serviceRootResult.stdout).toContain("root=/tmp/service-root");

  const symphonyRootResult = await runRootProbe(root, {
    HOME: home,
    SYMPHONY_ROOT: "/tmp/explicit-root",
    SYMPHONY_RUNTIME_CHECKOUT: "/tmp/runtime-root",
    SYMPHONY_SERVICE_ROOT: "/tmp/service-root",
  });
  expect(symphonyRootResult.status).toBe(0);
  expect(symphonyRootResult.stdout).toContain("root=/tmp/explicit-root");
});

it("documents service root help text with exact precedence", async () => {
  const ctl = await readFile("ops/symphony-ctl", "utf8");
  const environment = ctl.match(/Environment:\n[\s\S]*?\nEOF/)?.[0];

  expect(environment).toBeDefined();
  expect(environment).toContain(
    "SYMPHONY_ROOT > SYMPHONY_SERVICE_ROOT >\n" +
      "                             SYMPHONY_RUNTIME_CHECKOUT > default",
  );
  expect(environment).toContain(
    "SYMPHONY_SERVICE_ROOT      Service checkout root override used after\n" +
      "                             SYMPHONY_ROOT and before\n" +
      "                             SYMPHONY_RUNTIME_CHECKOUT",
  );

  const serviceRootLine = environment
    ?.split("\n")
    .find((line) => line.includes("SYMPHONY_SERVICE_ROOT"));
  expect(serviceRootLine).toBeDefined();
  expect(serviceRootLine).not.toMatch(/\balias\b/i);
});

it("renders the launchd plist from the configured service root", async () => {
  const root = await createTempDir("symphony-ctl-plist-root-");
  const envFile = join(root, ".env");
  await writeFile(envFile, "LINEAR_API_KEY=test-key\n");

  const ctl = await readFile("ops/symphony-ctl", "utf8");
  const result = spawnSync(
    "bash",
    [
      "-c",
      [
        extractShellFunction(ctl, "generate_env_dict"),
        extractShellFunction(ctl, "generate_plist"),
        'SYMPHONY_ROOT="$1"',
        'SERVICE_LABEL="com.symphony.symphony"',
        'NODE_BIN="/opt/homebrew/bin/node"',
        'CLI_JS="$SYMPHONY_ROOT/dist/src/cli/main.js"',
        'WORKFLOW_PATH="$SYMPHONY_ROOT/pipeline-config/workflows/WORKFLOW-symphony.md"',
        'LOG_DIR="$2/logs"',
        'ENV_FILE="$3"',
        'HOME="$2/home"',
        "generate_plist",
      ].join("\n"),
      "bash",
      "/tmp/runtime-checkout",
      root,
      envFile,
    ],
    { encoding: "utf8" },
  );

  expect(result.status).toBe(0);
  expect(result.stderr).toBe("");
  expect(result.stdout).toContain(
    "<string>/tmp/runtime-checkout/dist/src/cli/main.js</string>",
  );
  expect(result.stdout).toContain(
    "<string>/tmp/runtime-checkout/pipeline-config/workflows/WORKFLOW-symphony.md</string>",
  );
  expect(result.stdout).toContain(
    "<key>WorkingDirectory</key>\n    <string>/tmp/runtime-checkout</string>",
  );
  expect(result.stdout).toContain("<key>LINEAR_API_KEY</key>");
});

it("enables launchd services before bootstrap or kickstart", async () => {
  const ctl = await readFile("ops/symphony-ctl", "utf8");
  const enableService = extractShellFunction(ctl, "enable_service");
  const install = extractShellFunction(ctl, "cmd_install");
  const start = extractShellFunction(ctl, "cmd_start");
  const restart = extractShellFunction(ctl, "cmd_restart");

  expect(enableService).toContain(
    'launchctl enable "gui/$(id -u)/${SERVICE_LABEL}"',
  );
  expect(install.indexOf("enable_service")).toBeGreaterThanOrEqual(0);
  expect(install.indexOf("enable_service")).toBeLessThan(
    install.indexOf("launchctl bootstrap"),
  );
  expect(start.indexOf("enable_service")).toBeGreaterThanOrEqual(0);
  expect(start.indexOf("enable_service")).toBeLessThan(
    start.indexOf("launchctl bootstrap"),
  );
  expect(start.indexOf("enable_service")).toBeLessThan(
    start.indexOf("launchctl kickstart"),
  );
  expect(restart.indexOf("enable_service")).toBeGreaterThanOrEqual(0);
  expect(restart.indexOf("launchctl bootstrap")).toBeGreaterThanOrEqual(0);
  expect(restart.indexOf("enable_service")).toBeLessThan(
    restart.indexOf("launchctl bootstrap"),
  );
  expect(restart.indexOf("enable_service")).toBeLessThan(
    restart.indexOf("launchctl kickstart"),
  );
});

async function createTempDir(prefix: string): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), prefix));
  tempDirs.push(path);
  return path;
}

// Absolute bash path so callers can set PATH to a git-free dir (to exercise the
// git-unavailable branch) without breaking bash resolution itself.
const BASH_PATH = (() => {
  const probe = spawnSync("bash", ["-c", "command -v bash"], {
    encoding: "utf8",
  });
  return probe.status === 0 && probe.stdout.trim()
    ? probe.stdout.trim()
    : "/bin/bash";
})();

async function runWorktreeGuard(
  symphonyRoot: string,
  pathEnv = "/usr/bin:/bin",
): Promise<ReturnType<typeof spawnSync>> {
  const ctl = await readFile("ops/symphony-ctl", "utf8");
  const guard = extractShellFunction(ctl, "check_service_root_not_worktree");
  return spawnSync(
    BASH_PATH,
    [
      "-c",
      [
        'die() { echo "$*" >&2; exit 1; }',
        'warn() { echo "$*" >&2; }',
        guard,
        'SYMPHONY_ROOT="$1"',
        "check_service_root_not_worktree",
      ].join("\n"),
      "bash",
      symphonyRoot,
    ],
    {
      encoding: "utf8",
      env: { HOME: symphonyRoot, PATH: pathEnv },
    },
  );
}

function git(cwd: string, args: string[]): ReturnType<typeof spawnSync> {
  const result = spawnSync("git", args, {
    cwd,
    encoding: "utf8",
    env: { HOME: cwd, PATH: "/usr/bin:/bin" },
  });
  if (result.status !== 0) {
    throw new Error(
      `git ${args.join(" ")} failed\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`,
    );
  }
  return result;
}

async function runRootProbe(
  root: string,
  env: Record<string, string>,
): Promise<ReturnType<typeof spawnSync>> {
  const checkoutRoot = join(root, "checkout");
  const opsDir = join(checkoutRoot, "ops");
  await mkdir(opsDir, { recursive: true });
  const probe = join(opsDir, "symphony-ctl");
  const ctl = await readFile("ops/symphony-ctl", "utf8");
  const preamble = ctl.split("\n# Colors")[0];

  await writeFile(
    probe,
    [
      preamble,
      'printf "root=%s\\n" "$SYMPHONY_ROOT"',
      'printf "env=%s\\n" "$ENV_FILE"',
      'printf "workflow=%s\\n" "$WORKFLOW_PATH"',
      'printf "cli=%s\\n" "$CLI_JS"',
    ].join("\n"),
  );

  return spawnSync("bash", [probe], {
    encoding: "utf8",
    env: {
      PATH: "/usr/bin:/bin",
      ...env,
    },
  });
}

function extractShellFunction(source: string, name: string): string {
  const lines = source.split("\n");
  const start = lines.findIndex((line) => line === `${name}() {`);
  expect(start).toBeGreaterThanOrEqual(0);

  const end = lines.findIndex((line, index) => {
    if (index <= start || line !== "}") {
      return false;
    }

    const nextLine = lines[index + 1] ?? "";
    return (
      nextLine === "" ||
      nextLine.startsWith("# ---") ||
      /^[A-Za-z_][A-Za-z0-9_]*\(\) \{$/.test(nextLine)
    );
  });
  expect(end).toBeGreaterThan(start);

  return lines.slice(start, end + 1).join("\n");
}
