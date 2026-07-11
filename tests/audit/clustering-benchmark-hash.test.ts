import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { beforeEach, describe, expect, it, vi } from "vitest";

const fixtureReads = vi.hoisted(() => ({
  calls: 0,
  original: "",
  changed: "",
}));

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...actual,
    readFile: vi.fn(
      async (
        path: Parameters<typeof actual.readFile>[0],
        options?: Parameters<typeof actual.readFile>[1],
      ) => {
        if (String(path).endsWith("mutable-clustering-fixture.json")) {
          const content =
            fixtureReads.calls === 0
              ? fixtureReads.original
              : fixtureReads.changed;
          fixtureReads.calls += 1;
          return options === "utf8" ? content : Buffer.from(content);
        }
        return actual.readFile(path, options);
      },
    ),
  };
});

import { runClusteringBenchmark } from "../../src/audit/clustering-benchmark.js";

const fixtureDir = join(
  process.cwd(),
  "tests",
  "fixtures",
  "clustering-golden-set",
);
const positivePath = join(fixtureDir, "positive-crucible-strategy.json");
const negativePath = join(fixtureDir, "negative-symphony-t0.json");

beforeEach(() => {
  fixtureReads.calls = 0;
  fixtureReads.original = readFileSync(positivePath, "utf8");
  const changed = JSON.parse(fixtureReads.original) as {
    issues: Array<{ title: string }>;
  };
  const first = changed.issues[0];
  if (first === undefined) throw new Error("fixture needs one issue");
  first.title = `${first.title} mutated after parse`;
  fixtureReads.changed = JSON.stringify(changed);
});

describe("clustering benchmark fixture hashes", () => {
  it("hashes the immutable fixture bytes that were parsed for scoring", async () => {
    const seenTitles: string[] = [];

    const result = await runClusteringBenchmark({
      fixturePaths: ["/tmp/mutable-clustering-fixture.json", negativePath],
      repeats: 1,
      model: "test-model",
      generatedAt: "2026-07-11T00:00:00.000Z",
      runInference: async ({ fixture }) => {
        seenTitles.push(fixture.issues[0]?.title ?? "");
        return [];
      },
    });

    expect(fixtureReads.calls).toBe(1);
    const originalFixture = JSON.parse(fixtureReads.original);
    expect(seenTitles[0]).toBe(originalFixture.issues[0].title);
    expect(result.fixtureContentHashes).toEqual(
      expect.arrayContaining([
        {
          fixtureId: originalFixture.fixture_id,
          sha256: sha256(fixtureReads.original),
        },
      ]),
    );
    expect(sha256(fixtureReads.changed)).not.toBe(
      result.fixtureContentHashes[0]?.sha256,
    );
  });
});

function sha256(content: string): string {
  return createHash("sha256").update(content).digest("hex");
}
