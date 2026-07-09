import assert from "node:assert/strict";
import test from "node:test";

import { issueKeys } from "./check-dead-exports.mjs";

test("issueKeys normalizes dead exports and types without source positions", () => {
  assert.deepEqual(
    issueKeys({
      issues: [
        {
          file: "src/a.ts",
          exports: [{ name: "unused", line: 10 }],
          types: [{ name: "UnusedType", line: 20 }],
        },
      ],
    }),
    ["src/a.ts:exports:unused", "src/a.ts:types:UnusedType"],
  );
});
