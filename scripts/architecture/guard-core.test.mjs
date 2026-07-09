import assert from "node:assert/strict";
import test from "node:test";
import {
  addedLines,
  evaluateFileSizeRatchet,
  evaluateGodFile,
  lineCount,
  pathMatchesAny,
  unwaived,
} from "./guard-core.mjs";

test("lineCount handles trailing newlines", () => {
  assert.equal(lineCount("a\nb\n"), 2);
  assert.equal(lineCount("a\nb"), 2);
  assert.equal(lineCount(""), 0);
});

test("glob matching supports recursive globs", () => {
  assert.equal(pathMatchesAny("docs/a/b.md", ["docs/**"]), true);
  assert.equal(pathMatchesAny("src/foo.test.mjs", ["**/*.test.*"]), true);
  assert.equal(pathMatchesAny("src/foo.mjs", ["**/*.test.*"]), false);
});

test("file-size ratchet caps new files and blocks large-file growth", () => {
  const rules = {
    new_file_line_cap: 2,
    no_growth_line_threshold: 3,
    exempt_path_globs: [],
    waivers: [],
  };
  assert.equal(
    unwaived(
      evaluateFileSizeRatchet({
        path: "src/new.mjs",
        oldContent: null,
        newContent: "1\n2\n3\n",
        rules,
      }),
    ).length,
    1,
  );
  assert.equal(
    unwaived(
      evaluateFileSizeRatchet({
        path: "src/old.mjs",
        oldContent: "1\n2\n3\n",
        newContent: "1\n2\n3\n4\n",
        rules,
      }),
    ).length,
    1,
  );
});

test("waivers are applied but remain visible", () => {
  const rules = {
    new_file_line_cap: 1,
    no_growth_line_threshold: 10,
    exempt_path_globs: [],
    waivers: [
      {
        path: "src/**",
        rule: "file_size.new_file_line_cap",
        reason: "fixture",
        expires: "2999-01-01",
      },
    ],
  };
  const verdicts = evaluateFileSizeRatchet({
    path: "src/new.mjs",
    oldContent: null,
    newContent: "1\n2\n",
    rules,
  });
  assert.equal(verdicts[0].status, "waived");
  assert.equal(unwaived(verdicts).length, 0);
});

test("god-file patterns match only added lines", () => {
  const rules = {
    pinned_files: [
      {
        path: "god.mjs",
        max_lines: 10,
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
  };
  assert.deepEqual(
    addedLines("const x = 1;\n", "const x = 1;\nfunction loadFooConfig() {}\n"),
    ["function loadFooConfig() {}"],
  );
  assert.equal(
    unwaived(
      evaluateGodFile({
        path: "god.mjs",
        oldContent: "const x = 1;\n",
        newContent: "const x = 1;\nfunction loadFooConfig() {}\n",
        rules,
      }),
    ).length,
    1,
  );
  assert.equal(
    evaluateGodFile({
      path: "god.mjs",
      oldContent: "function loadFooConfig() {}\n",
      newContent: "function loadFooConfig() {}\n",
      rules,
    }).length,
    0,
  );
});
