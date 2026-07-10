import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  findUnregisteredReads,
  scanNamedEnvReads,
} from "./check-env-registry.mjs";

test("scanNamedEnvReads records dot and bracket reads by site", () => {
  const root = mkdtempSync(join(tmpdir(), "env-registry-test-"));
  const first = join(root, "first.ts");
  const second = join(root, "second.mjs");
  writeFileSync(
    first,
    "process.env.SYMPHONY_ALPHA; process.env['SYMPHONY_BETA'];\n",
  );
  writeFileSync(second, "process.env.SYMPHONY_ALPHA; env.SYMPHONY_GAMMA;\n");
  assert.deepEqual(scanNamedEnvReads([first, second]), [
    { name: "SYMPHONY_ALPHA", read_sites: [first, second] },
    { name: "SYMPHONY_BETA", read_sites: [first] },
    { name: "SYMPHONY_GAMMA", read_sites: [second] },
  ]);
});

test("scanNamedEnvReads ignores paths deleted from the working tree", () => {
  const root = mkdtempSync(join(tmpdir(), "env-registry-deleted-test-"));
  const deleted = join(root, "deleted.ts");
  assert.deepEqual(scanNamedEnvReads([deleted]), []);
});

test("findUnregisteredReads fails only new name and site pairs", () => {
  const actual = [
    { name: "A", read_sites: ["src/a.ts", "src/b.ts"] },
    { name: "B", read_sites: ["src/a.ts"] },
  ];
  const registered = [{ name: "A", read_sites: ["src/a.ts"] }];
  assert.deepEqual(findUnregisteredReads(actual, registered), [
    { name: "A", path: "src/b.ts" },
    { name: "B", path: "src/a.ts" },
  ]);
});
