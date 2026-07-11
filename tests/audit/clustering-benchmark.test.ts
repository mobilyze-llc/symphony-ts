import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  ClusteringGoldenSetFixtureSchema,
  buildClusteringBenchmarkPlannerContext,
  loadClusteringGoldenSetFixture,
  reconstructFixtureAsOfCutoff,
} from "../../src/audit/clustering-benchmark-fixture.js";
import { scoreStructuralAdvisories } from "../../src/audit/clustering-benchmark-score.js";
import type { StructuralAdvisory } from "../../src/domain/structural-advisory.js";

const fixtureDir = join(
  process.cwd(),
  "tests",
  "fixtures",
  "clustering-golden-set",
);
const positivePath = join(fixtureDir, "positive-crucible-strategy.json");
const negativePath = join(fixtureDir, "negative-symphony-t0.json");
const roots: string[] = [];

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

function advisory(
  members: string[],
  root: string | null | undefined = members[0] ?? "MOB-0",
): StructuralAdvisory {
  const rootLabel = root ?? members[0] ?? "MOB-0";
  return {
    memberIssueIdentifiers: members,
    rootCauseHypothesis: `${rootLabel} is the shared root`,
    structuralFix: "Fix the shared root once",
    confidenceNote: "Frozen-fixture test prediction",
  };
}

describe("clustering golden-set scoring", () => {
  it("scores perfect cluster and root recovery at 1.0", async () => {
    const fixture = await loadClusteringGoldenSetFixture(positivePath);
    const predicted = fixture.answer_key.clusters.map((cluster) =>
      advisory(cluster.member_issue_identifiers, cluster.root_issue_identifier),
    );

    expect(scoreStructuralAdvisories(fixture, predicted)).toMatchObject({
      pairwisePrecision: 1,
      pairwiseRecall: 1,
      rootIdentificationAccuracy: 1,
      falseClusterRate: 0,
    });
  });

  it("accepts an explicitly adjudicated absorbed-equivalent root", async () => {
    const fixture = await loadClusteringGoldenSetFixture(positivePath);
    const predicted = fixture.answer_key.clusters.map((cluster) =>
      advisory(
        cluster.member_issue_identifiers,
        cluster.absorbed_equivalent_root_identifiers[0] ??
          cluster.root_issue_identifier,
      ),
    );

    expect(
      scoreStructuralAdvisories(fixture, predicted).rootIdentificationAccuracy,
    ).toBe(1);
  });

  it("counts an explicit in-corpus root as a cluster member for pairwise scoring (SYMPH-1124)", async () => {
    const fixture = await loadClusteringGoldenSetFixture(positivePath);
    const cluster = fixture.answer_key.clusters.find(
      (candidate) => candidate.root_issue_identifier !== null,
    );
    expect(cluster).toBeDefined();
    if (cluster === undefined || cluster.root_issue_identifier === null) {
      return;
    }
    const nonRootMembers = cluster.member_issue_identifiers.filter(
      (identifier) => identifier !== cluster.root_issue_identifier,
    );
    // Root named once, in the root field, per the schema — not repeated in
    // members. Every root<->member pair must still count.
    const prediction: StructuralAdvisory = {
      ...advisory(nonRootMembers, cluster.root_issue_identifier),
      rootIssueIdentifier: cluster.root_issue_identifier,
    };
    const score = scoreStructuralAdvisories(fixture, [prediction]);
    const clusterPairs =
      (cluster.member_issue_identifiers.length *
        (cluster.member_issue_identifiers.length - 1)) /
      2;
    expect(score.truePositivePairs).toBe(clusterPairs);
    expect(score.pairwisePrecision).toBe(1);
  });

  it("scores a null prediction as correct for a null-root answer-key cluster (SYMPH-1124)", async () => {
    const fixture = await loadClusteringGoldenSetFixture(positivePath);
    const nullRootCluster = fixture.answer_key.clusters.find(
      (candidate) =>
        candidate.root_issue_identifier === null &&
        candidate.absorbed_equivalent_root_identifiers.length === 0,
    );
    expect(nullRootCluster).toBeDefined();
    if (nullRootCluster === undefined) return;
    const declined: StructuralAdvisory = {
      memberIssueIdentifiers: nullRootCluster.member_issue_identifiers,
      rootCauseHypothesis:
        "These share a disposition family; no canonical root ticket exists.",
      structuralFix: "Dispose as a family without a superseding root.",
      confidenceNote: "test",
    };
    const declinedScore = scoreStructuralAdvisories(fixture, [declined]);
    const clusterIndex = fixture.answer_key.clusters.indexOf(nullRootCluster);
    expect(declinedScore.rootIdentificationAccuracy).toBeGreaterThanOrEqual(
      1 / fixture.answer_key.clusters.length,
    );
    expect(clusterIndex).toBeGreaterThanOrEqual(0);
    const named: StructuralAdvisory = {
      ...declined,
      rootIssueIdentifier:
        nullRootCluster.member_issue_identifiers[0] ?? "MOB-0",
    };
    const namedScore = scoreStructuralAdvisories(fixture, [named]);
    expect(namedScore.rootIdentificationAccuracy).toBe(0);
  });

  it("scores an explicit root identifier before falling back to hypothesis prose", async () => {
    const fixture = await loadClusteringGoldenSetFixture(positivePath);
    const predicted = fixture.answer_key.clusters.map((cluster, index) => ({
      ...advisory(
        cluster.member_issue_identifiers,
        cluster.root_issue_identifier,
      ),
      ...(index === 0
        ? {
            rootIssueIdentifier: cluster.root_issue_identifier,
            rootCauseHypothesis:
              "The shared failure comes from ambient workspace identity.",
          }
        : {}),
    }));

    expect(
      scoreStructuralAdvisories(fixture, predicted).rootIdentificationAccuracy,
    ).toBe(1);
  });

  it("treats an explicit root identifier as authoritative over a prose identifier", async () => {
    const fixture = await loadClusteringGoldenSetFixture(positivePath);
    const predicted = fixture.answer_key.clusters.map((cluster, index) => ({
      ...advisory(
        cluster.member_issue_identifiers,
        cluster.root_issue_identifier,
      ),
      ...(index === 0 ? { rootIssueIdentifier: "SYMPH-999999" } : {}),
    }));

    expect(
      scoreStructuralAdvisories(fixture, predicted).rootIdentificationAccuracy,
    ).toBe(7 / 8);
  });

  it("falls back to hypothesis prose when the explicit root is malformed", async () => {
    const fixture = await loadClusteringGoldenSetFixture(positivePath);
    const predicted = fixture.answer_key.clusters.map((cluster, index) => ({
      ...advisory(
        cluster.member_issue_identifiers,
        cluster.root_issue_identifier,
      ),
      ...(index === 0 ? { rootIssueIdentifier: "not-an-issue" } : {}),
    }));

    expect(
      scoreStructuralAdvisories(fixture, predicted).rootIdentificationAccuracy,
    ).toBe(1);
  });

  it("drops precision, not recall, when two answer-key clusters merge", async () => {
    const fixture = await loadClusteringGoldenSetFixture(positivePath);
    const [left, right, ...rest] = fixture.answer_key.clusters;
    if (left === undefined || right === undefined)
      throw new Error("fixture needs two clusters");
    const predicted = [
      advisory([
        ...left.member_issue_identifiers,
        ...right.member_issue_identifiers,
      ]),
      ...rest.map((cluster) => advisory(cluster.member_issue_identifiers)),
    ];

    const score = scoreStructuralAdvisories(fixture, predicted);
    expect(score.pairwisePrecision).toBeLessThan(1);
    expect(score.pairwiseRecall).toBe(1);
    expect(score.rootIdentificationAccuracy).toBeLessThan(1);
  });

  it("drops recall, not precision, when one answer-key cluster splits", async () => {
    const fixture = await loadClusteringGoldenSetFixture(positivePath);
    const [split, ...rest] = fixture.answer_key.clusters;
    if (split === undefined) throw new Error("fixture needs a cluster");
    const predicted = [
      advisory(split.member_issue_identifiers.slice(0, 3)),
      advisory(split.member_issue_identifiers.slice(3)),
      ...rest.map((cluster) => advisory(cluster.member_issue_identifiers)),
    ];

    const score = scoreStructuralAdvisories(fixture, predicted);
    expect(score.pairwisePrecision).toBe(1);
    expect(score.pairwiseRecall).toBeLessThan(1);
    expect(score.rootIdentificationAccuracy).toBe(1);
  });

  it("reports zero false clusters for singleton-only negative predictions", async () => {
    const fixture = await loadClusteringGoldenSetFixture(negativePath);
    const predicted = fixture.issues.map((issue) =>
      advisory([issue.identifier]),
    );

    expect(scoreStructuralAdvisories(fixture, predicted)).toMatchObject({
      pairwisePrecision: null,
      pairwiseRecall: null,
      falseClusterRate: 0,
      predictedPairs: 0,
    });
  });

  it("drops a whole advisory with one hallucinated member and reports its rate", async () => {
    const fixture = await loadClusteringGoldenSetFixture(positivePath);
    const first = fixture.answer_key.clusters[0];
    if (first === undefined) throw new Error("fixture needs a cluster");
    const score = scoreStructuralAdvisories(fixture, [
      advisory(first.member_issue_identifiers, first.root_issue_identifier),
      advisory([first.member_issue_identifiers[0] ?? "MOB-981", "MOB-999999"]),
    ]);

    expect(score).toMatchObject({
      predictedPairs: 6,
      truePositivePairs: 6,
      invalidAdvisoryCount: 1,
      invalidMemberCount: 1,
      totalAttemptedMemberCount: 6,
    });
    expect(score.invalidMemberRate).toBe(1 / 6);
  });

  it("uses a global maximum-weight overlap assignment instead of greedy edges", async () => {
    const fixture = await loadClusteringGoldenSetFixture(positivePath);
    const identifiers = ["TEST-1", "TEST-2", "TEST-3", "TEST-4", "TEST-5"];
    fixture.issues = fixture.issues.slice(0, 5).map((issue, index) => ({
      ...issue,
      identifier: identifiers[index] ?? "TEST-0",
    }));
    fixture.answer_key = {
      exclusions: [],
      clusters: [
        {
          id: "A",
          root_issue_identifier: "TEST-1",
          absorbed_equivalent_root_identifiers: [],
          member_issue_identifiers: ["TEST-1", "TEST-2", "TEST-3"],
          rationale: "counterexample A",
        },
        {
          id: "B",
          root_issue_identifier: "TEST-4",
          absorbed_equivalent_root_identifiers: [],
          member_issue_identifiers: ["TEST-4", "TEST-5"],
          rationale: "counterexample B",
        },
      ],
    };
    const predictions = [
      advisory(identifiers, "TEST-4"),
      advisory(["TEST-1", "TEST-2"], "TEST-1"),
    ];

    expect(
      scoreStructuralAdvisories(fixture, predictions)
        .rootIdentificationAccuracy,
    ).toBe(1);
  });
});

describe("clustering golden-set fixtures", () => {
  it("rejects fixtures missing schema version or cutoff", async () => {
    const root = await mkdtemp(join(tmpdir(), "clustering-fixture-"));
    roots.push(root);
    const missingSchema = join(root, "missing-schema.json");
    const missingCutoff = join(root, "missing-cutoff.json");
    await writeFile(missingSchema, JSON.stringify({ fixture_id: "bad" }));
    await writeFile(
      missingCutoff,
      JSON.stringify({ schema_version: 1, fixture_id: "bad" }),
    );

    await expect(
      loadClusteringGoldenSetFixture(missingSchema),
    ).rejects.toThrow();
    await expect(
      loadClusteringGoldenSetFixture(missingCutoff),
    ).rejects.toThrow();
  });

  it("strips post-cutoff comments, relations, and labels before prompt assembly", async () => {
    const fixture = await loadClusteringGoldenSetFixture(positivePath);
    const reconstructed = reconstructFixtureAsOfCutoff(fixture);
    const rawPrimary = fixture.issues.find(
      (candidate) => candidate.identifier === "MOB-981",
    );
    const primary = reconstructed.issues.find(
      (candidate) => candidate.identifier === "MOB-981",
    );
    const disposition = rawPrimary?.comments.find((comment) =>
      comment.body.includes("Triage root-cause pass"),
    );
    expect(disposition).toBeDefined();
    expect(primary?.comments.map((comment) => comment.id)).not.toContain(
      disposition?.id,
    );
    expect(rawPrimary?.relations).toContainEqual(
      expect.objectContaining({
        type: "relatesTo",
        issue_identifier: "MOB-853",
      }),
    );
    expect(primary?.relations).not.toContainEqual(
      expect.objectContaining({ issue_identifier: "MOB-853" }),
    );
    const withLateLabel = structuredClone(fixture);
    withLateLabel.issues[0]?.labels.push({
      name: "post-cutoff-test-label",
      created_at: "2026-07-09T23:52:01.000Z",
    });
    const strippedLabels = reconstructFixtureAsOfCutoff(withLateLabel);
    expect(
      strippedLabels.issues[0]?.labels.map((label) => label.name),
    ).not.toContain("post-cutoff-test-label");
    const context = buildClusteringBenchmarkPlannerContext(withLateLabel);
    expect(context.backlog).toEqual([]);
    expect(context.structuralAdvisoriesEnabled).toBe(true);
    const candidate = context.advisoryInput?.find(
      (entry) => entry.issueIdentifier === "MOB-981",
    );
    expect(candidate?.advisoryRelations?.relatesTo ?? []).not.toContain(
      "MOB-853",
    );
    expect(candidate?.labels).not.toContain("post-cutoff-test-label");
  });

  it("commits the complete T0 union and explicit re-adjudication exclusions", async () => {
    const fixture = await loadClusteringGoldenSetFixture(negativePath);
    expect(fixture.issues).toHaveLength(51);
    expect(
      fixture.answer_key.exclusions.map((entry) => entry.issue_identifier),
    ).toEqual(
      expect.arrayContaining(["SYMPH-1070", "SYMPH-1081", "SYMPH-709"]),
    );
    expect(fixture.provenance.re_adjudication).toContain("Already-root-traced");
  });

  it("uses actual frozen Linear candidate prose rather than answer-derived summaries", async () => {
    const positive = await loadClusteringGoldenSetFixture(positivePath);
    const negative = await loadClusteringGoldenSetFixture(negativePath);
    expect(
      positive.issues.find((issue) => issue.identifier === "MOB-981"),
    ).toMatchObject({
      title:
        "Fix council-flow static lease proofs for materialized PR review worktrees",
    });
    expect(
      negative.issues.find((issue) => issue.identifier === "SYMPH-951"),
    ).toMatchObject({
      title:
        "Test-harden spine review-gate cutover edge cases (SYMPH-923 council P3s)",
    });
    for (const issue of [...positive.issues, ...negative.issues]) {
      expect(issue.description).not.toMatch(
        /Frozen T0 issue snapshot|^Symptom:|^Root:/,
      );
    }
  });

  it("validates the fixture schema independently", async () => {
    const fixture = await loadClusteringGoldenSetFixture(positivePath);
    expect(ClusteringGoldenSetFixtureSchema.parse(fixture).schema_version).toBe(
      1,
    );
  });
});
