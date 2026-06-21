import { readFile, readdir } from "node:fs/promises";
import { describe, expect, it } from "vitest";

/**
 * SYMPH-835 seam-insulation guard. Sub-stage delegation must invoke execution
 * ONLY through the `StageExecutionBackend` interface (resolved via a backend
 * resolver), never the crabrunner scheduler client or its submit/status/collect
 * calls directly. This keeps the optional crabrunner provider (SYMPH-850) an
 * internal swap rather than a consumer-facing change, and prevents the
 * decomposition runner from coupling to a concrete scheduler.
 */
describe("decomposed-stage seam insulation", () => {
  const runnerUrl = new URL(
    "../../src/stage-execution/decomposed-stage.ts",
    import.meta.url,
  );

  it("dispatches only through the StageExecutionBackend seam", async () => {
    const source = await readFile(runnerUrl, "utf8");

    // Must NOT reach the scheduler client or its submit/status/collect calls.
    expect(source).not.toMatch(/CrabrunnerSchedulerClient/);
    expect(source).not.toMatch(/crabrunner-backend/);
    expect(source).not.toMatch(/\.submit\s*\(/);
    expect(source).not.toMatch(/\.status\s*\(/);
    expect(source).not.toMatch(/\.collect\s*\(/);

    // Must dispatch through the resolved backend's execute (the seam).
    expect(source).toMatch(/resolveBackend\(/);
    expect(source).toMatch(/\.execute\(/);
  });

  it("does not advance stage state or mutate the rework counter", async () => {
    const source = await readFile(runnerUrl, "utf8");

    // Ownership stays orchestrator-owned and journal-derived: the runner must
    // not touch the rework counter or stage-transition machinery.
    expect(source).not.toMatch(/issueReworkCounts/);
    expect(source).not.toMatch(/advanceStage/);
    expect(source).not.toMatch(/reworkGate/);
  });

  it("keeps the crabrunner scheduler client confined to the crabrunner backend", async () => {
    const dirUrl = new URL("../../src/stage-execution/", import.meta.url);
    const entries = await readdir(dirUrl);
    const offenders: string[] = [];
    for (const entry of entries) {
      if (!entry.endsWith(".ts") || entry === "crabrunner-backend.ts") {
        continue;
      }
      const source = await readFile(new URL(entry, dirUrl), "utf8");
      if (/CrabrunnerSchedulerClient/.test(source)) {
        offenders.push(entry);
      }
    }
    expect(offenders).toEqual([]);
  });
});
