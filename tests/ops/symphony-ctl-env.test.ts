import { spawnSync } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { expect, it } from "vitest";

it("renders export-style dotenv keys as launchd environment keys", async () => {
  const envFile = join(tmpdir(), `symphony-ctl-env-${process.pid}.env`);
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
