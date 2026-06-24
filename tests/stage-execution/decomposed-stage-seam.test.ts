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
  const multiLaneUrl = new URL(
    "../../src/stage-execution/multi-lane.ts",
    import.meta.url,
  );

  it("dispatches only through the StageExecutionBackend seam", async () => {
    const source = await readFile(runnerUrl, "utf8");
    const multiLaneSource = await readFile(multiLaneUrl, "utf8");

    // Must NOT reach the scheduler client or its submit/status/collect calls.
    expect(source).not.toMatch(/CrabrunnerSchedulerClient/);
    expect(source).not.toMatch(/crabrunner-backend/);
    expect(source).not.toMatch(/\.submit\s*\(/);
    expect(source).not.toMatch(/\.status\s*\(/);
    expect(source).not.toMatch(/\.collect\s*\(/);

    // Must delegate dispatch to the shared multi-lane primitive, with backend
    // resolution passed through as the seam.
    expect(source).toMatch(/resolveBackend\(/);
    expect(source).toMatch(/runStageExecutionLanes/);
    expect(source).toMatch(/["']\.\/multi-lane\.js["']/);

    // The shared multi-lane primitive now owns the backend seam, still without
    // coupling to the crabrunner scheduler client or its submit/status/collect
    // calls directly.
    expect(multiLaneSource).toMatch(/resolveBackend\(/);
    expect(multiLaneSource).toMatch(/\.execute\s*\(/);
    expect(multiLaneSource).not.toMatch(/CrabrunnerSchedulerClient/);
    expect(multiLaneSource).not.toMatch(/crabrunner-backend/);
    expect(multiLaneSource).not.toMatch(/\.submit\s*\(/);
    expect(multiLaneSource).not.toMatch(/\.status\s*\(/);
    expect(multiLaneSource).not.toMatch(/\.collect\s*\(/);
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
    // The CrabrunnerSchedulerClient interface may only appear in:
    //  - crabrunner-backend.ts: the interface declaration + its consumer.
    //  - crabrunner-scheduler-client.ts (SYMPH-853): the production
    //    `implements CrabrunnerSchedulerClient` over `bin/crabrunner`.
    // No decomposed-stage runner or other consumer may couple to it directly.
    const allowed = new Set([
      "crabrunner-backend.ts",
      "crabrunner-scheduler-client.ts",
    ]);
    const dirUrl = new URL("../../src/stage-execution/", import.meta.url);
    const entries = await readdir(dirUrl);
    const offenders: string[] = [];
    for (const entry of entries) {
      if (!entry.endsWith(".ts") || allowed.has(entry)) {
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
