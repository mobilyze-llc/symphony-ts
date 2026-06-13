import { join } from "node:path";
import { describe, expect, it } from "vitest";

import {
  REVIEW_CALIBRATION_BUG_CLASSES,
  REVIEW_CALIBRATION_LANES,
  REVIEW_CALIBRATION_METRICS,
  REVIEW_CALIBRATION_OWNER_ISSUE,
  REVIEW_CALIBRATION_PARENT_ISSUE,
  REVIEW_CALIBRATION_REPLAY_SOURCE,
  type ReviewCalibrationBugClass,
  type ReviewCalibrationCorpus,
  type ReviewCalibrationFixture,
  collectReviewCalibrationFutureRefHygieneGaps,
  findReviewCalibrationFixture,
  getReviewCalibrationFixturesByBugClass,
  loadReviewCalibrationCorpusFile,
  validateReviewCalibrationCorpus,
} from "../../../src/review/calibration/fixtures.js";

const CORPUS_PATH = join(
  import.meta.dirname,
  "../../fixtures/review-calibration/corpus.json",
);

function loadCorpus(): ReviewCalibrationCorpus {
  return loadReviewCalibrationCorpusFile(CORPUS_PATH);
}

function fixture(
  corpus: ReviewCalibrationCorpus,
  id: string,
): ReviewCalibrationFixture {
  const found = findReviewCalibrationFixture(corpus, id);
  expect(found).not.toBeNull();
  if (found === null) {
    throw new Error(`Missing review calibration fixture ${id}`);
  }
  return found;
}

describe("review calibration fixture corpus (SYMPH-493)", () => {
  it("loads and validates the fixture-only corpus without runtime wiring", () => {
    const corpus = loadCorpus();
    const result = validateReviewCalibrationCorpus(corpus);

    expect(result).toEqual({
      ok: true,
      fixtureCount: 13,
      errors: [],
    });
    expect(collectReviewCalibrationFutureRefHygieneGaps(corpus)).toEqual([]);
    expect(corpus).toMatchObject({
      ownerIssue: REVIEW_CALIBRATION_OWNER_ISSUE,
      parentIssue: REVIEW_CALIBRATION_PARENT_ISSUE,
    });
  });

  it("covers every required bug class with deterministic metadata", () => {
    const corpus = loadCorpus();
    const coveredClasses = new Set(
      corpus.fixtures.map((candidate) => candidate.bugClass),
    );

    expect(coveredClasses).toEqual(new Set(REVIEW_CALIBRATION_BUG_CLASSES));
    for (const bugClass of REVIEW_CALIBRATION_BUG_CLASSES) {
      const fixtures = getReviewCalibrationFixturesByBugClass(corpus, bugClass);
      expect(fixtures.length).toBeGreaterThanOrEqual(1);
      expect(fixtures[0]?.sourceRefs.length).toBeGreaterThan(0);
      expect(fixtures[0]?.tags.length).toBeGreaterThan(0);
    }
  });

  it("rejects depleted coverage and category/bug-class drift", () => {
    const corpus = loadCorpus();
    const emptyCorpus = structuredClone(corpus);
    emptyCorpus.fixtures = [];

    expect(validateReviewCalibrationCorpus(emptyCorpus).errors).toEqual(
      expect.arrayContaining([
        {
          path: "$.fixtures",
          message: "must not be empty",
        },
        {
          path: "$.fixtures",
          message:
            "must include one fixture for bug class security:path_traversal",
        },
      ]),
    );

    const driftedCorpus = structuredClone(corpus);
    driftedCorpus.fixtures[0]!.category = "workflow";
    expect(
      validateReviewCalibrationCorpus(driftedCorpus).errors,
    ).toContainEqual({
      path: "$.fixtures[0].category",
      message: "must be security for bugClass security:path_traversal",
    });
  });

  it("records fixture-only measurement and retrospective replay metadata", () => {
    const corpus = loadCorpus();

    expect(corpus.measurementPlan).toMatchObject({
      harnessMode: "fixture_only",
      routingMode: "council_v2_calibration_static",
      liveModelCalls: "forbidden",
      laneSet: [...REVIEW_CALIBRATION_LANES],
      metrics: [...REVIEW_CALIBRATION_METRICS],
    });
    expect(corpus.measurementPlan.scoring.primarySignal).toContain(
      "Codex excavation unique real finding",
    );
    expect(corpus.retrospectiveReplay).toMatchObject({
      source: REVIEW_CALIBRATION_REPLAY_SOURCE,
      noLiveModelCalls: true,
      forbiddenRuntimeFields: ["modelProvider", "modelPrompt", "gateMutation"],
    });
    expect(corpus.retrospectiveReplay.cases).toHaveLength(10);
    expect(
      corpus.retrospectiveReplay.cases.map((replayCase) => replayCase.id),
    ).toEqual(
      expect.arrayContaining([
        "pr-422-symph-495-calibration-validator-hardening",
        "pr-410-symph-482-queue-audit-baseline",
        "pr-395-symph-321-structured-reviewer-artifacts",
        "pr-392-symph-440-budget-terminal-precedence",
      ]),
    );
    expect(
      corpus.retrospectiveReplay.cases.every(
        (replayCase) => replayCase.source === REVIEW_CALIBRATION_REPLAY_SOURCE,
      ),
    ).toBe(true);
    expect(
      corpus.retrospectiveReplay.cases.some(
        (replayCase) =>
          replayCase.fixRereviewConvergence === "fixed_before_clean" &&
          replayCase.reviewerYield.expectedRealFindingsLowerBound > 0,
      ),
    ).toBe(true);
    expect(
      corpus.retrospectiveReplay.cases.some(
        (replayCase) => replayCase.opusUsage === "degraded",
      ),
    ).toBe(true);
  });

  it("rejects retrospective replay runtime fields and depleted replay coverage", () => {
    const corpus = loadCorpus();

    const runtimeFieldCorpus = structuredClone(corpus);
    (
      runtimeFieldCorpus.retrospectiveReplay as unknown as Record<
        string,
        unknown
      >
    ).modelProvider = "claude";
    expect(validateReviewCalibrationCorpus(runtimeFieldCorpus).errors).toEqual(
      expect.arrayContaining([
        {
          path: "$.retrospectiveReplay.modelProvider",
          message: "must not include forbidden runtime field",
        },
      ]),
    );

    const depletedReplayCorpus = structuredClone(corpus);
    depletedReplayCorpus.retrospectiveReplay.cases =
      depletedReplayCorpus.retrospectiveReplay.cases.slice(0, 9);
    expect(
      validateReviewCalibrationCorpus(depletedReplayCorpus).errors,
    ).toEqual(
      expect.arrayContaining([
        {
          path: "$.retrospectiveReplay.cases",
          message: "must include at least 10 replay cases",
        },
      ]),
    );
  });

  it("pins malicious security outcomes and benign false-positive traps", () => {
    const corpus = loadCorpus();
    const maliciousClasses: ReviewCalibrationBugClass[] = [
      "security:path_traversal",
      "security:shell_injection",
      "security:secret_exposure",
    ];
    const safeClasses: ReviewCalibrationBugClass[] = [
      "security:safe_filesystem",
      "security:safe_auth_adjacent",
    ];

    for (const bugClass of maliciousClasses) {
      const [candidate] = getReviewCalibrationFixturesByBugClass(
        corpus,
        bugClass,
      );
      expect(candidate?.expectedReviewerOutcome).toMatchObject({
        disposition: "finding",
        shouldBlock: true,
      });
      expect(candidate?.falsePositiveTrap).toBeNull();
    }

    for (const bugClass of safeClasses) {
      const [candidate] = getReviewCalibrationFixturesByBugClass(
        corpus,
        bugClass,
      );
      expect(candidate?.expectedReviewerOutcome).toMatchObject({
        disposition: "no_finding",
        shouldBlock: false,
      });
      expect(candidate?.falsePositiveTrap).toEqual(
        expect.objectContaining({
          trapKind: expect.any(String),
          expectation: expect.stringContaining("Do not flag"),
        }),
      );
    }

    const unsafeSafeCorpus = structuredClone(corpus);
    const safeIndex = unsafeSafeCorpus.fixtures.findIndex(
      (candidate) => candidate.bugClass === "security:safe_filesystem",
    );
    expect(safeIndex).toBeGreaterThanOrEqual(0);
    unsafeSafeCorpus.fixtures[safeIndex]!.expectedReviewerOutcome.shouldBlock =
      true;
    expect(validateReviewCalibrationCorpus(unsafeSafeCorpus).errors).toEqual(
      expect.arrayContaining([
        {
          path: `$.fixtures[${safeIndex}].expectedReviewerOutcome.shouldBlock`,
          message: "safe security fixtures must not block",
        },
      ]),
    );
  });

  it("keeps instruction, workflow, and frontmatter classes explicit", () => {
    const corpus = loadCorpus();

    expect(
      fixture(corpus, "instruction-prompt-injection-malicious")
        .expectedReviewerOutcome,
    ).toMatchObject({
      disposition: "finding",
      findingFamily: "instruction-boundary",
    });
    expect(
      fixture(corpus, "workflow-premature-done-transition")
        .expectedReviewerOutcome,
    ).toMatchObject({
      disposition: "finding",
      findingFamily: "premature-terminal-state",
    });
    expect(
      fixture(corpus, "frontmatter-reviewer-metadata-drift")
        .expectedReviewerOutcome,
    ).toMatchObject({
      disposition: "finding",
      findingFamily: "review-frontmatter-drift",
    });
    expect(
      fixture(corpus, "frontmatter-reviewer-metadata-drift").sourceRefs.map(
        (sourceRef) => sourceRef.id,
      ),
    ).toEqual(expect.arrayContaining(["SYMPH-456"]));
  });

  it("preserves historical Symphony replay metadata for SYMPH-440 and PR #392", () => {
    const corpus = loadCorpus();
    const historical = fixture(
      corpus,
      "historical-symph-440-pr-392-placeholder",
    );
    const sourceIds = historical.sourceRefs.map((sourceRef) => sourceRef.id);

    expect(sourceIds).toEqual(
      expect.arrayContaining(["SYMPH-440", "PR #392", "SYMPH-493"]),
    );
    expect(historical.expectedReviewerOutcome).toMatchObject({
      disposition: "metadata_only",
      findingFamily: "budget-terminal-precedence",
    });
    expect(historical.replay).toMatchObject({
      kind: "historical_symphony_placeholder",
      status: "metadata_only",
      requiredSourceRefIds: ["SYMPH-440", "PR #392"],
      expectedEventShape: {
        eventName: "review_calibration_replay_case",
        forbiddenRuntimeFields: [
          "modelProvider",
          "modelPrompt",
          "gateMutation",
        ],
      },
    });
    expect(historical.replay?.expectedEventShape.sample).toMatchObject({
      source: REVIEW_CALIBRATION_REPLAY_SOURCE,
      sourceIssue: "SYMPH-440",
      sourcePullRequest: "PR #392",
    });
  });

  it("preserves PR #395 as a second historical council-finding fixture", () => {
    const corpus = loadCorpus();
    const historical = fixture(
      corpus,
      "historical-symph-321-pr-395-structured-artifacts",
    );
    const sourceIds = historical.sourceRefs.map((sourceRef) => sourceRef.id);

    expect(sourceIds).toEqual(
      expect.arrayContaining(["SYMPH-321", "PR #395", "SYMPH-298"]),
    );
    expect(historical.expectedReviewerOutcome).toMatchObject({
      disposition: "finding",
      shouldBlock: true,
      findingFamily: "structured-artifact-parser-triage",
    });
    expect(historical.replay).toMatchObject({
      kind: "historical_symphony_placeholder",
      status: "fixture_ready",
      requiredSourceRefIds: ["SYMPH-321", "PR #395"],
    });
    expect(historical.replay?.expectedEventShape.sample).toMatchObject({
      source: REVIEW_CALIBRATION_REPLAY_SOURCE,
      sourceIssue: "SYMPH-321",
      sourcePullRequest: "PR #395",
      expectedRealFindingsLowerBound: 2,
    });
  });

  it("drives required historical source refs from replay metadata", () => {
    const corpus = loadCorpus();
    const historicalIndex = corpus.fixtures.findIndex(
      (candidate) => candidate.category === "historical-replay",
    );
    expect(historicalIndex).toBeGreaterThanOrEqual(0);

    const missingRefCorpus = structuredClone(corpus);
    const missingRefReplay = missingRefCorpus.fixtures[historicalIndex]!.replay;
    if (missingRefReplay === null) {
      throw new Error("expected replay metadata");
    }
    missingRefReplay.requiredSourceRefIds = ["SYMPH-440", "PR #999"];

    expect(validateReviewCalibrationCorpus(missingRefCorpus).errors).toEqual(
      expect.arrayContaining([
        {
          path: `$.fixtures[${historicalIndex}].sourceRefs`,
          message: "must include required historical source ref PR #999",
        },
      ]),
    );

    const undeclaredRequirementCorpus = structuredClone(corpus);
    const undeclaredRequirementReplay =
      undeclaredRequirementCorpus.fixtures[historicalIndex]!.replay;
    if (undeclaredRequirementReplay === null) {
      throw new Error("expected replay metadata");
    }
    const {
      requiredSourceRefIds: _requiredSourceRefIds,
      ...replayWithoutRequiredSourceRefIds
    } = undeclaredRequirementReplay;
    undeclaredRequirementCorpus.fixtures[historicalIndex]!.replay =
      replayWithoutRequiredSourceRefIds;

    expect(
      validateReviewCalibrationCorpus(undeclaredRequirementCorpus).errors,
    ).toContainEqual({
      path: `$.fixtures[${historicalIndex}].replay.requiredSourceRefIds`,
      message: "must be an array",
    });

    const nonHistoricalRequirementCorpus = structuredClone(corpus);
    const convergenceIndex = nonHistoricalRequirementCorpus.fixtures.findIndex(
      (candidate) => candidate.category === "targeted-convergence",
    );
    expect(convergenceIndex).toBeGreaterThanOrEqual(0);
    const convergenceReplay =
      nonHistoricalRequirementCorpus.fixtures[convergenceIndex]!.replay;
    if (convergenceReplay === null) {
      throw new Error("expected replay metadata");
    }
    convergenceReplay.requiredSourceRefIds = ["SYMPH-440"];

    expect(
      validateReviewCalibrationCorpus(nonHistoricalRequirementCorpus).errors,
    ).toContainEqual({
      path: `$.fixtures[${convergenceIndex}].replay.requiredSourceRefIds`,
      message:
        "only historical replay fixtures may declare requiredSourceRefIds",
    });
  });

  it("pins targeted-convergence cases without wiring narrowing behavior", () => {
    const corpus = loadCorpus();
    const sameFamily = fixture(corpus, "convergence-same-family-reopen");
    const regression = fixture(
      corpus,
      "convergence-fix-round-regression-outside-family",
    );
    const replayShape = fixture(
      corpus,
      "convergence-expected-replay-event-shape",
    );

    expect(sameFamily.expectedReviewerOutcome).toMatchObject({
      disposition: "finding",
      findingFamily: "budget-terminal-precedence",
    });
    expect(sameFamily.replay?.expectedEventShape.sample).toMatchObject({
      expectedAction: "reopen_same_family",
      priorFindingFamily: "budget-terminal-precedence",
      currentFindingFamily: "budget-terminal-precedence",
    });
    expect(regression.expectedReviewerOutcome).toMatchObject({
      disposition: "finding",
      findingFamily: "review-journal-idempotency-regression",
    });
    expect(regression.replay?.expectedEventShape.sample).toMatchObject({
      expectedAction: "report_new_family",
      priorFindingFamily: "budget-terminal-precedence",
      currentFindingFamily: "review-journal-idempotency-regression",
    });
    expect(replayShape.expectedReviewerOutcome).toMatchObject({
      disposition: "metadata_only",
      shouldBlock: false,
    });
    expect(replayShape.replay?.expectedEventShape).toMatchObject({
      eventName: "review_calibration_replay_case",
      requiredFields: [
        "source",
        "fixtureId",
        "bugClass",
        "expectedDisposition",
        "expectedFindingFamily",
      ],
      forbiddenRuntimeFields: ["modelProvider", "modelPrompt", "gateMutation"],
    });
  });

  it("rejects replay samples that omit required fields or include forbidden runtime fields", () => {
    const corpus = loadCorpus();
    const invalidCorpus = structuredClone(corpus);
    const fixtureIndex = invalidCorpus.fixtures.findIndex(
      (candidate) => candidate.id === "convergence-expected-replay-event-shape",
    );
    expect(fixtureIndex).toBeGreaterThanOrEqual(0);
    const replay = invalidCorpus.fixtures[fixtureIndex]!.replay;
    if (replay === null) {
      throw new Error("expected replay metadata");
    }

    const { fixtureId: _fixtureId, ...sampleWithoutFixtureId } =
      replay.expectedEventShape.sample;
    replay.expectedEventShape.sample = {
      ...sampleWithoutFixtureId,
      modelPrompt: "unsafe runtime prompt",
    };

    expect(validateReviewCalibrationCorpus(invalidCorpus).errors).toEqual(
      expect.arrayContaining([
        {
          path: `$.fixtures[${fixtureIndex}].replay.expectedEventShape.sample.fixtureId`,
          message: "must include required field",
        },
        {
          path: `$.fixtures[${fixtureIndex}].replay.expectedEventShape.sample.modelPrompt`,
          message: "must not include forbidden runtime field",
        },
      ]),
    );
  });

  it("handles cyclic in-memory replay samples while scanning forbidden runtime fields", () => {
    const corpus = loadCorpus();
    const cyclicCorpus = structuredClone(corpus);
    const fixtureIndex = cyclicCorpus.fixtures.findIndex(
      (candidate) => candidate.id === "convergence-expected-replay-event-shape",
    );
    expect(fixtureIndex).toBeGreaterThanOrEqual(0);
    const replay = cyclicCorpus.fixtures[fixtureIndex]!.replay;
    if (replay === null) {
      throw new Error("expected replay metadata");
    }

    const cyclicSample: Record<string, unknown> = {
      source: REVIEW_CALIBRATION_REPLAY_SOURCE,
      fixtureId: "convergence-expected-replay-event-shape",
      bugClass: "convergence:replay_event_shape",
      expectedDisposition: "metadata_only",
      expectedFindingFamily: null,
      metadata: {
        ownerIssue: REVIEW_CALIBRATION_OWNER_ISSUE,
        parentIssue: REVIEW_CALIBRATION_PARENT_ISSUE,
        futureConsumers: ["SYMPH-446", "SYMPH-468"],
        runtimeWiring: "not_wired",
      },
    };
    cyclicSample.self = cyclicSample;
    cyclicSample.nestedUnsafe = {
      modelPrompt: "unsafe runtime prompt",
    };
    replay.expectedEventShape.sample = cyclicSample;

    expect(validateReviewCalibrationCorpus(cyclicCorpus).errors).toContainEqual(
      {
        path: `$.fixtures[${fixtureIndex}].replay.expectedEventShape.sample.nestedUnsafe.modelPrompt`,
        message: "must not include forbidden runtime field",
      },
    );
  });

  it("requires historical replay metadata and nested runtime-field hygiene", () => {
    const corpus = loadCorpus();

    const missingReplayCorpus = structuredClone(corpus);
    const historicalIndex = missingReplayCorpus.fixtures.findIndex(
      (candidate) => candidate.category === "historical-replay",
    );
    expect(historicalIndex).toBeGreaterThanOrEqual(0);
    missingReplayCorpus.fixtures[historicalIndex]!.replay = null;
    expect(
      validateReviewCalibrationCorpus(missingReplayCorpus).errors,
    ).toContainEqual({
      path: `$.fixtures[${historicalIndex}].replay`,
      message: "historical replay fixtures require replay metadata",
    });

    const nestedRuntimeCorpus = structuredClone(corpus);
    const replayShapeIndex = nestedRuntimeCorpus.fixtures.findIndex(
      (candidate) => candidate.id === "convergence-expected-replay-event-shape",
    );
    expect(replayShapeIndex).toBeGreaterThanOrEqual(0);
    const replay = nestedRuntimeCorpus.fixtures[replayShapeIndex]!.replay;
    if (replay === null) {
      throw new Error("expected replay metadata");
    }
    const sampleMetadata = replay.expectedEventShape.sample.metadata;
    if (
      sampleMetadata === null ||
      typeof sampleMetadata !== "object" ||
      Array.isArray(sampleMetadata)
    ) {
      throw new Error("expected replay sample metadata");
    }
    replay.expectedEventShape.sample.metadata = {
      ...(sampleMetadata as Record<string, unknown>),
      gateMutation: "unsafe runtime mutation",
    };

    expect(
      validateReviewCalibrationCorpus(nestedRuntimeCorpus).errors,
    ).toContainEqual({
      path: `$.fixtures[${replayShapeIndex}].replay.expectedEventShape.sample.metadata.gateMutation`,
      message: "must not include forbidden runtime field",
    });

    const metadataDriftCorpus = structuredClone(corpus);
    const metadataReplay =
      metadataDriftCorpus.fixtures[replayShapeIndex]!.replay;
    if (metadataReplay === null) {
      throw new Error("expected replay metadata");
    }
    const metadata = metadataReplay.expectedEventShape.sample.metadata;
    if (
      metadata === null ||
      typeof metadata !== "object" ||
      Array.isArray(metadata)
    ) {
      throw new Error("expected replay sample metadata");
    }
    const { ownerIssue: _ownerIssue, ...metadataWithoutOwnerIssue } =
      metadata as Record<string, unknown>;
    metadataReplay.expectedEventShape.sample.metadata =
      metadataWithoutOwnerIssue;

    expect(
      validateReviewCalibrationCorpus(metadataDriftCorpus).errors,
    ).toContainEqual({
      path: `$.fixtures[${replayShapeIndex}].replay.expectedEventShape.sample.metadata.ownerIssue`,
      message: "must include metadata field",
    });
  });

  it("requires future-ref hygiene fields on every fixture", () => {
    const corpus = loadCorpus();

    for (const candidate of corpus.fixtures) {
      expect(candidate.futureRefHygiene).toMatchObject({
        ownerIssue: REVIEW_CALIBRATION_OWNER_ISSUE,
        parentIssue: REVIEW_CALIBRATION_PARENT_ISSUE,
        runtimeWiring: "not_wired",
        liveModelCalls: "forbidden",
        rolloutRouting: "forbidden",
      });
      expect(candidate.futureRefHygiene.futureConsumers).toEqual(
        expect.arrayContaining(["SYMPH-446", "SYMPH-468"]),
      );
    }

    const invalidCorpus = structuredClone(corpus);
    invalidCorpus.fixtures[0]!.futureRefHygiene.liveModelCalls =
      "allowed" as "forbidden";
    expect(
      validateReviewCalibrationCorpus(invalidCorpus).errors,
    ).toContainEqual({
      path: "$.fixtures[0].futureRefHygiene.liveModelCalls",
      message: "must be forbidden",
    });
  });
});
