import { join } from "node:path";
import { describe, expect, it } from "vitest";

import {
  REVIEW_CALIBRATION_BUG_CLASSES,
  REVIEW_CALIBRATION_OWNER_ISSUE,
  REVIEW_CALIBRATION_PARENT_ISSUE,
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
      fixtureCount: 12,
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
      expect(fixtures).toHaveLength(1);
      expect(fixtures[0]?.sourceRefs.length).toBeGreaterThan(0);
      expect(fixtures[0]?.tags.length).toBeGreaterThan(0);
    }
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
      sourceIssue: "SYMPH-440",
      sourcePullRequest: "PR #392",
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
        "fixtureId",
        "bugClass",
        "expectedDisposition",
        "expectedFindingFamily",
      ],
      forbiddenRuntimeFields: ["modelProvider", "modelPrompt", "gateMutation"],
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
