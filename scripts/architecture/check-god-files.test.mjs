import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const script = fileURLToPath(new URL("./check-god-files.mjs", import.meta.url));

function git(cwd, args) {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
}

function repo() {
  const cwd = mkdtempSync(join(tmpdir(), "god-file-test-"));
  git(cwd, ["init"]);
  git(cwd, ["config", "user.email", "test@example.com"]);
  git(cwd, ["config", "user.name", "Test User"]);
  writeFileSync(join(cwd, "god.mjs"), "const ok = true;\n");
  git(cwd, ["add", "."]);
  git(cwd, ["commit", "-m", "base"]);
  return { cwd, base: git(cwd, ["rev-parse", "HEAD"]).trim() };
}

function config(path, maxLines = 10) {
  writeFileSync(
    path,
    JSON.stringify({
      schema: "symphony.architecture.god-files.v1",
      pinned_files: [
        {
          path: "god.mjs",
          max_lines: maxLines,
          forbidden_new_patterns: [
            {
              id: "loader",
              pattern: "\\bfunction\\s+load[A-Za-z]*Config\\b",
              remediation: "extract",
            },
          ],
        },
      ],
      waivers: [],
    }),
  );
}

test("script fails on forbidden added patterns", () => {
  const { cwd, base } = repo();
  const configPath = resolve(cwd, "god.json");
  config(configPath);
  writeFileSync(
    join(cwd, "god.mjs"),
    "const ok = true;\nfunction loadFooConfig() {}\n",
  );
  const result = spawnSync(
    process.execPath,
    [script, "--base", base, "--config", configPath],
    { cwd, encoding: "utf8" },
  );
  assert.equal(result.status, 1);
  assert.match(result.stdout, /god_file\.forbidden_new_pattern\.loader/);
});

test("--update-pins only lowers pins", () => {
  const { cwd } = repo();
  const configPath = resolve(cwd, "god.json");
  config(configPath, 5);
  const result = spawnSync(
    process.execPath,
    [script, "--config", configPath, "--update-pins"],
    { cwd, encoding: "utf8" },
  );
  assert.equal(result.status, 0);
  assert.equal(
    JSON.parse(readFileSync(configPath, "utf8")).pinned_files[0].max_lines,
    1,
  );
});

test("--full-set fails when an unchanged pinned file is over its pin", () => {
  const { cwd } = repo();
  const configPath = resolve(cwd, "god.json");
  config(configPath, 1);
  writeFileSync(
    join(cwd, "god.mjs"),
    "const ok = true;\nconst extra = true;\n",
  );
  const result = spawnSync(
    process.execPath,
    [script, "--config", configPath, "--full-set"],
    { cwd, encoding: "utf8" },
  );
  assert.equal(result.status, 1);
  assert.match(result.stdout, /god_file\.max_lines/);
  assert.match(result.stdout, /above pin 1/);
});

test("--full-set fails and flags stale-high pins", () => {
  const { cwd } = repo();
  const configPath = resolve(cwd, "god.json");
  config(configPath, 5);
  const result = spawnSync(
    process.execPath,
    [script, "--config", configPath, "--full-set"],
    { cwd, encoding: "utf8" },
  );
  assert.equal(result.status, 1);
  assert.match(result.stdout, /god_file\.stale_high_pin/);
  assert.match(result.stdout, /below pin 5/);
});

test("--full-set passes when every pin matches the current tree", () => {
  const { cwd } = repo();
  const configPath = resolve(cwd, "god.json");
  config(configPath, 1);
  const result = spawnSync(
    process.execPath,
    [script, "--config", configPath, "--full-set"],
    { cwd, encoding: "utf8" },
  );
  assert.equal(result.status, 0);
  assert.match(result.stdout, /god-file full-set checks passed/);
});
