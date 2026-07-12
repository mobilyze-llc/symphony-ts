import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  STRUCTURAL_ADVISORY_PROMPT_INSTRUCTION_LINES,
  STRUCTURAL_ADVISORY_PROMPT_JSON_LINES,
} from "../../src/agent/structural-advisory-output.js";
import { parsePlannerOutput } from "../../src/agent/triage-planner.js";
import { loadClusteringGoldenSetFixture } from "../../src/audit/clustering-benchmark-fixture.js";
import { scoreStructuralAdvisories } from "../../src/audit/clustering-benchmark-score.js";
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
  root: string | null | undefined = members[0] ?? "MOB-0",
): StructuralAdvisory {
  return {
    memberIssueIdentifiers: members,
    rootCauseHypothesis:
      root === null
        ? "No canonical root exists for this disposition family."
        : `${root ?? members[0] ?? "MOB-0"} is the shared root`,
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
      const opening = prompt.indexOf("<SYMPHONY_UNTRUSTED_CANDIDATES_");
      const backlog = prompt.indexOf("## Backlog candidates");
      const advisoryInput = prompt.indexOf(
        "## Backlog advisory input (REPORT-ONLY; never eligible for a batch)",
      );
      const closing = prompt.indexOf("</SYMPHONY_UNTRUSTED_CANDIDATES_");
      expect(opening).toBeGreaterThanOrEqual(0);
      expect(backlog).toBeGreaterThan(opening);
      expect(advisoryInput).toBeGreaterThan(backlog);
      expect(closing).toBeGreaterThan(advisoryInput);
      const dispatchBacklog = prompt.slice(backlog, advisoryInput);
      const reportOnlyInput = prompt.slice(advisoryInput, closing);
      expect(dispatchBacklog).toContain("- (none)");
      expect(dispatchBacklog).not.toMatch(/[A-Z][A-Z0-9]+-\d+/);
      expect(reportOnlyInput).toMatch(/[A-Z][A-Z0-9]+-\d+/);
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

  it("preserves U6 explicit roots through parsePlannerOutput and scoring", async () => {
    const fixture = await loadClusteringGoldenSetFixture(positivePath);
    const structuralAdvisories = fixture.answer_key.clusters.map((cluster) => ({
      memberIssueIdentifiers: cluster.member_issue_identifiers,
      rootCauseHypothesis: "A shared runtime condition explains these symptoms",
      structuralFix: "Fix the shared runtime condition once",
      confidenceNote: "Frozen-fixture evidence",
      rootIssueIdentifier: cluster.root_issue_identifier,
    }));
    const parsed = parsePlannerOutput(
      `\`\`\`json\n${JSON.stringify({
        rationale: "report-only clustering",
        batches: [],
        structural_advisories: structuralAdvisories,
      })}\n\`\`\``,
    );
    if (!parsed.ok) throw new Error(parsed.reason);

    expect(parsed.value.structural_advisories).toEqual(structuralAdvisories);
    expect(
      scoreStructuralAdvisories(
        fixture,
        parsed.value.structural_advisories ?? [],
      ).rootIdentificationAccuracy,
    ).toBe(1);
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
