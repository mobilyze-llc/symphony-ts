import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
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
      'export CMUX_SPAWN_BIN="/opt/cmux-spawn"',
      "SYMPHONY_COUNCIL_REVIEW_GATE='/opt/symphony-council-review-gate'",
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
  expect(result.stdout).toContain("<key>CMUX_SPAWN_BIN</key>");
  expect(result.stdout).toContain("<string>/opt/cmux-spawn</string>");
  expect(result.stdout).toContain("<key>SYMPHONY_COUNCIL_REVIEW_GATE</key>");
  expect(result.stdout).toContain(
    "<string>/opt/symphony-council-review-gate</string>",
  );
  expect(result.stdout).toContain("<key>PATH</key>");
  expect(result.stdout).toContain(
    "<string>/opt/homebrew/bin:/usr/bin</string>",
  );
  expect(result.stdout).not.toContain("<key>export CMUX_SPAWN_BIN</key>");
  expect(result.stdout).not.toContain("'/opt/symphony-council-review-gate'");
  expect(result.stdout).not.toContain("launchd path");
  expect(result.stdout).not.toContain("not a dotenv assignment");
});

it("defaults the service root to the detached runtime checkout", async () => {
  const root = await createTempDir("symphony-ctl-default-root-");
  const home = join(root, "home");
  const result = await runRootProbe(root, { HOME: home });

  const runtimeRoot = `${home}/.codex/worktrees/symphony-ts-runtime-main`;
  expect(result.status).toBe(0);
  expect(result.stderr).toBe("");
  expect(result.stdout).toContain(`root=${runtimeRoot}`);
  expect(result.stdout).toContain(`env=${runtimeRoot}/.env`);
  expect(result.stdout).toContain(
    `workflow=${runtimeRoot}/pipeline-config/workflows/WORKFLOW-symphony.md`,
  );
  expect(result.stdout).toContain(`cli=${runtimeRoot}/dist/src/cli/main.js`);
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

async function runRootProbe(
  root: string,
  env: Record<string, string>,
): Promise<ReturnType<typeof spawnSync>> {
  const probe = join(root, `probe-${Math.random().toString(16).slice(2)}.sh`);
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
