import {
  mkdtempSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import { afterEach, describe, expect, it } from "vitest";

import { isDirectRun } from "../../src/cli/direct-run.js";

const tempRoots: string[] = [];

afterEach(() => {
  for (const root of tempRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe("isDirectRun", () => {
  it("matches the real argv path to import.meta.url", () => {
    const root = mkdtempSync(join(tmpdir(), "symph-direct-run-"));
    tempRoots.push(root);
    const entry = join(root, "entry.mjs");
    writeFileSync(entry, "export {};\n");

    expect(isDirectRun(pathToFileURL(realpathSync(entry)).href, entry)).toBe(
      true,
    );
  });

  it("recognizes direct execution through symlink paths", () => {
    const root = mkdtempSync(join(tmpdir(), "symph-direct-run-"));
    tempRoots.push(root);
    const realEntry = join(root, "real-entry.mjs");
    const linkedEntry = join(root, "linked-entry.mjs");
    writeFileSync(realEntry, "export {};\n");
    symlinkSync(realEntry, linkedEntry);

    expect(
      isDirectRun(pathToFileURL(realpathSync(realEntry)).href, linkedEntry),
    ).toBe(true);
  });

  it("returns false for a different existing argv path", () => {
    const root = mkdtempSync(join(tmpdir(), "symph-direct-run-"));
    tempRoots.push(root);
    const importedEntry = join(root, "imported-entry.mjs");
    const argvEntry = join(root, "argv-entry.mjs");
    writeFileSync(importedEntry, "export {};\n");
    writeFileSync(argvEntry, "export {};\n");

    expect(
      isDirectRun(pathToFileURL(realpathSync(importedEntry)).href, argvEntry),
    ).toBe(false);
  });

  it("returns false for missing or unreadable argv paths", () => {
    expect(isDirectRun("file:///tmp/entry.mjs", undefined)).toBe(false);
    expect(isDirectRun("file:///tmp/entry.mjs", "/tmp/does-not-exist")).toBe(
      false,
    );
  });
});
