import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  STRUCTURAL_ADVISORY_PROMPT_INSTRUCTION_LINES,
  STRUCTURAL_ADVISORY_PROMPT_JSON_LINES,
} from "../../src/agent/structural-advisory-output.js";
import { loadClusteringGoldenSetFixture } from "../../src/audit/clustering-benchmark-fixture.js";
import { runClusteringBenchmark } from "../../src/audit/clustering-benchmark.js";
import type { StructuralAdvisory } from "../../src/domain/structural-advisory.js";

const fixtureDir = join(
  process.cwd(),
  "tests",
  "fixtures",
  "clustering-golden-set",
);
const positivePath = join(fixtureDir, "positive-crucible-strategy.json");
const negativePath = join(fixtureDir, "negative-symphony-t0.json");

function advisory(
  members: string[],
  root = members[0] ?? "MOB-0",
): StructuralAdvisory {
  return {
    memberIssueIdentifiers: members,
    rootCauseHypothesis: `${root} is the shared root`,
    structuralFix: "Fix the shared root once",
    confidenceNote: "Frozen-fixture test prediction",
  };
}

describe("clustering benchmark production-path contract", () => {
  it("uses the current U4 prompt and context assembler for all N>=3 repeats", async () => {
    const prompts: string[] = [];
    const result = await runClusteringBenchmark({
      fixturePaths: [positivePath, negativePath],
      repeats: 3,
      model: "opus",
      generatedAt: "2026-07-10T22:00:00.000Z",
      runInference: async ({ prompt, fixture }) => {
        prompts.push(prompt);
        return fixture.fixture_kind === "positive"
          ? [
              ...fixture.answer_key.clusters.map((cluster) =>
                advisory(
                  cluster.member_issue_identifiers,
                  cluster.root_issue_identifier,
                ),
              ),
              advisory(["MOB-981", "MOB-999999"]),
            ]
          : [];
      },
    });
    expect(prompts).toHaveLength(6);
    for (const prompt of prompts) {
      for (const line of STRUCTURAL_ADVISORY_PROMPT_INSTRUCTION_LINES)
        expect(prompt).toContain(line);
      for (const line of STRUCTURAL_ADVISORY_PROMPT_JSON_LINES)
        expect(prompt).toContain(line);
      expect(prompt).toContain("## Backlog candidates");
      expect(prompt).toContain("SYMPHONY_UNTRUSTED_CANDIDATES_");
    }
    const positive = result.perRepeat[0]?.fixtures.find(
      (entry) => entry.fixtureKind === "positive",
    );
    expect(positive?.advisories).toHaveLength(8);
    expect(positive?.score).toMatchObject({
      invalidAdvisoryCount: 1,
      invalidMemberCount: 1,
    });
    expect(result.summary).toMatchObject({
      pairwisePrecision: { mean: 1, spread: 0 },
      pairwiseRecall: { mean: 1, spread: 0 },
      rootIdentificationAccuracy: { mean: 1, spread: 0 },
      negativeFalseClusterRate: { mean: 0, spread: 0 },
      invalidAdvisoryCount: 3,
      invalidMemberCount: 3,
      totalAttemptedMemberCount: 102,
    });
    expect(result.summary.invalidMemberRate).toBeCloseTo(1 / 34);
  });

  it("weights graduation invalid-member rate by attempted members", async () => {
    const negative = await loadClusteringGoldenSetFixture(negativePath);
    const excluded = new Set(
      negative.answer_key.exclusions.map((entry) => entry.issue_identifier),
    );
    const eligibleNegative = negative.issues.filter(
      (issue) => !excluded.has(issue.identifier),
    );
    const result = await runClusteringBenchmark({
      fixturePaths: [positivePath, negativePath],
      repeats: 1,
      model: "test",
      generatedAt: "2026-07-10T22:00:00.000Z",
      runInference: async ({ fixture }) =>
        fixture.fixture_kind === "positive"
          ? [
              advisory([
                fixture.issues[0]?.identifier ?? "MOB-981",
                "MOB-999999",
              ]),
            ]
          : eligibleNegative.map((issue) => advisory([issue.identifier])),
    });
    expect(result.summary).toMatchObject({
      invalidMemberCount: 1,
      totalAttemptedMemberCount: eligibleNegative.length + 2,
    });
    expect(result.summary.invalidMemberRate).toBeCloseTo(
      1 / (eligibleNegative.length + 2),
    );
  });
});
