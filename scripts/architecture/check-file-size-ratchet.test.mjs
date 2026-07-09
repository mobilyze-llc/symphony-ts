import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const script = fileURLToPath(
  new URL("./check-file-size-ratchet.mjs", import.meta.url),
);

function git(cwd, args) {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
}

function repo() {
  const cwd = mkdtempSync(join(tmpdir(), "ratchet-test-"));
  git(cwd, ["init"]);
  git(cwd, ["config", "user.email", "test@example.com"]);
  git(cwd, ["config", "user.name", "Test User"]);
  mkdirSync(join(cwd, "src"));
  writeFileSync(join(cwd, "src", "large.mjs"), "1\n2\n3\n");
  git(cwd, ["add", "."]);
  git(cwd, ["commit", "-m", "base"]);
  return { cwd, base: git(cwd, ["rev-parse", "HEAD"]).trim() };
}

test("script fails when a large existing file grows", () => {
  const { cwd, base } = repo();
  const config = resolve(cwd, "ratchet.json");
  writeFileSync(
    config,
    JSON.stringify({
      schema: "symphony.architecture.file-size-ratchet.v1",
      new_file_line_cap: 10,
      no_growth_line_threshold: 3,
      exempt_path_globs: [],
      waivers: [],
    }),
  );
  writeFileSync(join(cwd, "src", "large.mjs"), "1\n2\n3\n4\n");
  const result = spawnSync(
    process.execPath,
    [script, "--base", base, "--config", config],
    { cwd, encoding: "utf8" },
  );
  assert.equal(result.status, 1);
  assert.match(result.stdout, /file_size\.no_growth_over_threshold/);
});

test("script honors exemptions", () => {
  const { cwd, base } = repo();
  const config = resolve(cwd, "ratchet.json");
  writeFileSync(
    config,
    JSON.stringify({
      schema: "symphony.architecture.file-size-ratchet.v1",
      new_file_line_cap: 1,
      no_growth_line_threshold: 3,
      exempt_path_globs: ["src/generated/**"],
      waivers: [],
    }),
  );
  mkdirSync(join(cwd, "src", "generated"));
  writeFileSync(join(cwd, "src", "generated", "note.mjs"), "1\n2\n");
  const result = spawnSync(
    process.execPath,
    [script, "--base", base, "--config", config],
    { cwd, encoding: "utf8" },
  );
  assert.equal(result.status, 0);
});
