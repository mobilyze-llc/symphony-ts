import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it, vi } from "vitest";

import {
  type HeadlessReviewerLaneConfig,
  type ReviewContext,
  synthesizeStructuredReviewerArtifactRecord,
} from "../../src/review/headless-council-gate.js";
import {
  artifactSectionContent,
  artifactStartingVerdictToken,
  normalizeArtifactStart,
} from "../../src/review/review-artifacts.js";
import {
  type ReviewTrackFinding,
  type ReviewTrackFindingFiler,
  computeTrackFiling,
  resolveTrackFindingFilings,
} from "../../src/review/review-track-findings.js";
import {
  CrabboxSpineClient,
  type SpineCommandResult,
  type SpineCommandRunner,
} from "../../src/review/spine/crabbox-spine-client.js";
import { ReviewAggregator } from "../../src/review/spine/review-aggregator.js";
import {
  CONVERGENCE_DECISION_SCHEMA,
  COUNCIL_TRIAGE_SCHEMA,
  CROSS_EXAM_SELECT_SCHEMA,
  type CouncilTriageResult,
  type TriageFinding,
} from "../../src/review/spine/schemas.js";
import { readCollectedArtifact } from "../../src/stage-execution/collected-artifact.js";
import { parseCrabrunnerStatus } from "../../src/stage-execution/crabrunner-contract.js";

const FIXTURE_DIR = join(
  process.cwd(),
  "tests/fixtures/review-crucible-contract",
);
const REVIEWER_ARTIFACT_CONTRACT =
  "crucible MOB-348 reviewer-artifact contract v1";
const CRABRUNNER_STATUS_SCHEMA = "crucible.crabrunner.status.v1";
const LANE_WORKER_CLOSEOUT_SCHEMA = "crucible.lane-worker.closeout.v1";
const HEAD_SHA = "symph-999-head";

const CASES = [
  {
    fixture: "pass.md",
    reviewerVerdict: "PASS",
    structuredVerdict: "pass",
    aggregateVerdict: "pass",
    parseStatus: "synthesized_from_markdown",
    finding: null,
  },
  {
    fixture: "changes-requested-p1.md",
    reviewerVerdict: "CHANGES_REQUESTED",
    structuredVerdict: "fail",
    aggregateVerdict: "fail",
    parseStatus: "synthesized_from_markdown",
    finding: {
      severity: "P1",
      location: "src/review/headless-council-gate.ts:5631",
      summary: "CHANGES_REQUESTED must not degrade as malformed.",
      fp: "src/review/headless-council-gate.ts::symph999p1",
      bucket: "escalate",
    },
  },
  {
    fixture: "blocked.md",
    reviewerVerdict: "BLOCKED",
    structuredVerdict: "fail",
    aggregateVerdict: "fail",
    parseStatus: "synthesized_from_markdown",
    finding: {
      severity: "P2",
      location: "docs/review.md:12",
      summary: "Required review evidence was unavailable.",
      fp: "docs/review.md::symph999blocked",
      bucket: "escalate",
    },
  },
  {
    fixture: "track-only.md",
    reviewerVerdict: "PASS",
    structuredVerdict: "pass",
    aggregateVerdict: "pass",
    parseStatus: "synthesized_from_markdown",
    finding: {
      severity: "Track",
      location: "docs/operators.md:9",
      summary: "Document an adjacent rollout note.",
      fp: "docs/operators.md::symph999track",
      bucket: "track",
    },
  },
  {
    fixture: "malformed-preamble.md",
    reviewerVerdict: null,
    structuredVerdict: "fail",
    aggregateVerdict: "degraded",
    parseStatus: "malformed",
    finding: null,
  },
] as const;

type ReplayCase = (typeof CASES)[number];

describe("SYMPH-999 review-seam consumer conformance", () => {
  it.each(CASES)(
    "replays $fixture through the parser, spine client, and aggregator",
    async (replayCase) => {
      const markdown = await fixture(replayCase.fixture);
      const structured = await synthesize(markdown, replayCase.fixture);

      expect(structured.verdict).toBe(replayCase.structuredVerdict);
      expect(structured.parseStatus).toBe(replayCase.parseStatus);
      assertStructuredReviewerArtifactShape(structured);

      if (replayCase.reviewerVerdict === null) {
        expect(structured.malformedReason).toMatch(/parseable Verdict section/);
      } else {
        assertReviewerMarkdownContract(markdown);
        expect(
          artifactStartingVerdictToken(normalizeArtifactStart(markdown)),
        ).toBe(replayCase.reviewerVerdict);
        expect(structured.malformedReason).toBeNull();
      }

      const { runner, commands } = replayRunner(replayCase, markdown);
      const result = await new ReviewAggregator(
        new CrabboxSpineClient({ runCommand: runner }),
      ).aggregate({
        laneArtifacts: [{ reviewer: "codex", markdown }],
        currentDiffHash: `diff-${replayCase.fixture}`,
        rounds: [],
      });

      expect(commands).toEqual([
        "council-triage",
        "cross-exam-select",
        "convergence-decision",
      ]);
      expect(result.triage.schema).toBe(COUNCIL_TRIAGE_SCHEMA);
      expect(result.crossExam.schema).toBe(CROSS_EXAM_SELECT_SCHEMA);
      expect(result.convergence?.schema).toBe(CONVERGENCE_DECISION_SCHEMA);
      expect(result.verdict).toBe(replayCase.aggregateVerdict);

      if (replayCase.aggregateVerdict === "degraded") {
        expect(result.verdict).not.toBe("pass");
        expect(result.degradedLanes).toEqual([
          {
            reviewer: "codex",
            parse_quality: "unparseable",
            reason: "fail_open",
          },
        ]);
      }

      if (replayCase.finding?.bucket === "escalate") {
        expect(result.blockingFindings).toHaveLength(1);
        expect(result.blockingFindings[0]).toMatchObject({
          fp: replayCase.finding.fp,
          severity: replayCase.finding.severity,
          location: replayCase.finding.location,
        });
      }

      if (replayCase.finding?.bucket === "track") {
        expect(result.blockingFindings).toHaveLength(0);
        expect(result.trackFindings).toHaveLength(1);
        await expectTrackFindingFiled(result.trackFindings[0]!);
      }
    },
  );

  it("fails synthetic verdict vocabulary drift with the reviewer contract version", async () => {
    const drifted = (await fixture("pass.md")).replace("PASS", "APPROVED");

    expect(() => assertReviewerMarkdownContract(drifted)).toThrow(
      new RegExp(
        `${REVIEWER_ARTIFACT_CONTRACT}.*PASS\\|CHANGES_REQUESTED\\|BLOCKED`,
      ),
    );

    const structured = await synthesize(drifted, "vocabulary-drift.md");
    expect(structured.verdict).toBe("fail");
    expect(structured.parseStatus).toBe("malformed");
    expect(structured.malformedReason).toMatch(/parseable Verdict section/);
  });

  it("fails synthetic reviewer-artifact shape drift with the contract version", async () => {
    const markdownShapeDrift = (await fixture("pass.md")).replace(
      /\n## Findings\nNone\n?/,
      "\n",
    );
    expect(() => assertReviewerMarkdownContract(markdownShapeDrift)).toThrow(
      new RegExp(`${REVIEWER_ARTIFACT_CONTRACT}.*## Findings`),
    );

    const structured = await synthesize(
      await fixture("pass.md"),
      "shape-drift.md",
    );
    const drifted = structuredClone(structured) as unknown as Record<
      string,
      unknown
    >;
    const sections = drifted.sections as Record<string, unknown>;
    sections.findings = undefined;

    expect(() => assertStructuredReviewerArtifactShape(drifted)).toThrow(
      new RegExp(`${REVIEWER_ARTIFACT_CONTRACT}.*sections\\.findings`),
    );
  });

  it.each([
    ["council-triage", COUNCIL_TRIAGE_SCHEMA],
    ["cross-exam-select", CROSS_EXAM_SELECT_SCHEMA],
    ["convergence-decision", CONVERGENCE_DECISION_SCHEMA],
  ] as const)(
    "names %s schema v1 when a synthetic producer version drifts",
    async (subcommand, expectedSchema) => {
      const runner: SpineCommandRunner = async () =>
        ok({
          ...(subcommand === "council-triage"
            ? triagePayload(CASES[0])
            : subcommand === "cross-exam-select"
              ? crossExamPayload(triagePayload(CASES[0]))
              : convergencePayload()),
          schema: expectedSchema.replace(/\.v1$/, ".v2"),
        });
      const client = new CrabboxSpineClient({ runCommand: runner });
      const operation =
        subcommand === "council-triage"
          ? client.councilTriage({
              reviews: [{ file: "review.md", reviewer: "codex" }],
            })
          : subcommand === "cross-exam-select"
            ? client.crossExamSelect({
                triageFile: "triage.json",
                currentDiffHash: "head",
              })
            : client.convergenceDecision({ roundsFile: "rounds.json" });

      await expect(operation).rejects.toThrow(
        new RegExp(`contract drift.*${escapeRegExp(expectedSchema)}`, "s"),
      );
    },
  );

  it("replays crabrunner status and lane-worker closeout without duplicating the execution harness", () => {
    const status = parseCrabrunnerStatus(
      cliResult({
        schema: CRABRUNNER_STATUS_SCHEMA,
        job_id: "symph-999-review-codex",
        state: "complete",
        artifact_path: "attempts/1/artifact/review.md",
        collectible: true,
      }),
      "review conformance status",
      "symph-999-review-codex",
    );
    expect(status.schema).toBe(CRABRUNNER_STATUS_SCHEMA);
    expect(status.collectible).toBe(true);

    const closeout = laneWorkerCloseout();
    const collected = readCollectedArtifact({
      job_id: "symph-999-review-codex",
      materialized: {
        status: "ready",
        jobId: "symph-999-review-codex",
        primary: {
          name: "attempts/1/artifact/review.md",
          content: "## Verdict\nPASS\n\n## Findings\nNone\n",
          hash: "review-sha",
        },
        entries: [
          {
            name: "attempts/1/artifact/review.closeout.json",
            content: JSON.stringify(closeout),
            hash: "closeout-sha",
          },
        ],
      },
    });
    expect(collected.status).toBe("ready");
    const entry = collected.entries.find((candidate) =>
      candidate.name.endsWith(".closeout.json"),
    );
    expect(entry).toBeDefined();
    expect(entry).toHaveProperty("content");
    const parsed = JSON.parse(
      (entry as { content: string }).content,
    ) as unknown;
    assertLaneWorkerCloseoutShape(parsed);
  });

  it("names status and closeout schema versions when their synthetic shapes drift", () => {
    expect(() =>
      parseCrabrunnerStatus(
        cliResult({
          schema: "crucible.crabrunner.status.v2",
          job_id: "symph-999-review-codex",
          state: "complete",
        }),
        "review conformance status",
      ),
    ).toThrow(
      new RegExp(
        `status schema.*status\\.v2.*${escapeRegExp(CRABRUNNER_STATUS_SCHEMA)}`,
      ),
    );

    const closeout = laneWorkerCloseout();
    closeout.refs = undefined;
    expect(() => assertLaneWorkerCloseoutShape(closeout)).toThrow(
      new RegExp(`${escapeRegExp(LANE_WORKER_CLOSEOUT_SCHEMA)}.*refs`),
    );
  });
});

async function fixture(name: string): Promise<string> {
  return readFile(join(FIXTURE_DIR, name), "utf8");
}

async function synthesize(markdown: string, name: string) {
  const dir = await mkdtemp(join(tmpdir(), "symph-999-review-seam-"));
  try {
    const artifactPath = join(dir, name);
    return await synthesizeStructuredReviewerArtifactRecord({
      context: reviewContext(),
      lane: reviewerLane(),
      artifactPath,
      artifact: markdown,
      structuredArtifactPath: `${artifactPath}.json`,
      reviewBundle: null,
      mode: "full",
      routingMode: null,
      round: 1,
    });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

function reviewContext(): ReviewContext {
  return {
    issueId: "SYMPH-999",
    repo: "symphony-ts",
    prNumber: null,
    baseRef: "origin/main",
    headRef: "codex/SYMPH-999-review-seam-conformance",
    baseSha: "base-sha",
    headSha: HEAD_SHA,
    diff: "diff --git a/file.ts b/file.ts\n+changed\n",
  };
}

function reviewerLane(): HeadlessReviewerLaneConfig {
  return {
    laneId: "codex",
    agent: "codex",
    role: "codex-reviewer",
    model: "gpt-5.5",
    reasoningEffort: "high",
  };
}

function replayRunner(
  replayCase: ReplayCase,
  expectedMarkdown: string,
): { runner: SpineCommandRunner; commands: string[] } {
  const commands: string[] = [];
  const triage = triagePayload(replayCase);
  const runner: SpineCommandRunner = async (argv) => {
    const subcommand = argv[1];
    commands.push(subcommand ?? "missing");
    if (subcommand === "council-triage") {
      const reviewFile = argv[argv.indexOf("--review-file") + 1];
      expect(reviewFile).toBeDefined();
      expect(await readFile(reviewFile!, "utf8")).toBe(expectedMarkdown);
      return ok(triage);
    }
    if (subcommand === "cross-exam-select") {
      return ok(crossExamPayload(triage));
    }
    if (subcommand === "convergence-decision") {
      return ok(convergencePayload());
    }
    throw new Error(`unexpected review spine subcommand: ${subcommand}`);
  };
  return { runner, commands };
}

function triagePayload(replayCase: ReplayCase): CouncilTriageResult {
  const finding = replayCase.finding;
  const triageFinding =
    finding === null
      ? null
      : ({
          severity: finding.severity,
          location: finding.location,
          summary: finding.summary,
          evidence: finding.location,
          failure: "synthetic conformance replay failure mode",
          test: "pnpm exec vitest run",
          fp: finding.fp,
          reviewer: "codex",
        } satisfies TriageFinding);
  const malformed = replayCase.reviewerVerdict === null;
  const blocked = replayCase.reviewerVerdict === "BLOCKED";
  const trackFindings: TriageFinding[] =
    finding?.bucket === "track" && triageFinding !== null
      ? [triageFinding]
      : [];
  const escalateFindings: TriageFinding[] =
    finding?.bucket === "escalate" && triageFinding !== null
      ? [triageFinding]
      : [];
  const track = trackFindings.length > 0;
  const escalate = escalateFindings.length > 0;
  return {
    schema: COUNCIL_TRIAGE_SCHEMA,
    lanes: [
      {
        reviewer: "codex",
        file: replayCase.fixture,
        verdict: replayCase.reviewerVerdict ?? "UNKNOWN",
        parse_quality: malformed ? "unparseable" : "clean",
        finding_count: triageFinding === null ? 0 : 1,
        none: triageFinding === null,
        fail_open: malformed,
      },
    ],
    summary: {
      lanes: 1,
      track: track ? 1 : 0,
      escalate: escalate ? 1 : 0,
      unparseable_lanes: malformed ? 1 : 0,
      blocked_lanes: blocked ? 1 : 0,
      partial_lanes: 0,
    },
    track: trackFindings,
    escalate: escalateFindings,
    next_action: escalate
      ? "cross_exam_required"
      : malformed
        ? "review_degraded"
        : "no_blocking_findings_this_round",
  };
}

function crossExamPayload(triage: CouncilTriageResult) {
  const targets = triage.escalate.map((finding) => ({
    fp: finding.fp,
    severity: finding.severity,
    location: finding.location,
    summary: finding.summary,
    reviewers: [finding.reviewer],
    lane_count: 1,
    agreement: "single_lane",
  }));
  return {
    schema: CROSS_EXAM_SELECT_SCHEMA,
    cross_exam_required: targets.length > 0,
    reason:
      targets.length > 0 ? "blocking finding escalated" : "nothing escalated",
    fix_diff_changed: false,
    fix_size_lines: null,
    fix_trivial: null,
    parseable_lanes: triage.summary.unparseable_lanes === 0 ? 1 : 0,
    target_count: targets.length,
    targets,
  };
}

function convergencePayload() {
  return {
    schema: CONVERGENCE_DECISION_SCHEMA,
    input_rounds: 1,
    state: "continue",
    reason: "one replay round",
    rounds: 1,
  };
}

function ok(json: unknown): SpineCommandResult {
  return { stdout: JSON.stringify(json), stderr: "", exitCode: 0 };
}

function cliResult(json: unknown) {
  return { stdout: JSON.stringify(json), stderr: "", exitCode: 0 };
}

function assertReviewerMarkdownContract(markdown: string): void {
  const normalized = normalizeArtifactStart(markdown);
  const token = artifactStartingVerdictToken(normalized);
  if (token === null) {
    throw new Error(
      `${REVIEWER_ARTIFACT_CONTRACT}: expected verdict vocabulary PASS|CHANGES_REQUESTED|BLOCKED`,
    );
  }
  if (artifactSectionContent(normalized, "Findings") === "") {
    throw new Error(
      `${REVIEWER_ARTIFACT_CONTRACT}: missing required ## Findings section`,
    );
  }
}

function assertStructuredReviewerArtifactShape(value: unknown): void {
  const artifact = record(value);
  if (
    artifact?.schemaVersion !== 1 ||
    artifact.kind !== "symphony-headless-council-reviewer-artifact"
  ) {
    throw new Error(
      `${REVIEWER_ARTIFACT_CONTRACT}: expected structured schemaVersion 1 and reviewer-artifact kind`,
    );
  }
  for (const field of [
    "lane",
    "routing",
    "reviewBundle",
    "verdict",
    "confidence",
    "parseStatus",
    "rawArtifactPath",
    "malformedReason",
    "sections",
    "findings",
    "headSha",
  ]) {
    if (!Object.hasOwn(artifact, field)) {
      throw new Error(`${REVIEWER_ARTIFACT_CONTRACT}: missing ${field}`);
    }
  }
  const sections = record(artifact.sections);
  for (const field of [
    "findings",
    "p1",
    "p2",
    "track",
    "dismissedOrTheoretical",
    "triage",
  ]) {
    if (typeof sections?.[field] !== "string") {
      throw new Error(
        `${REVIEWER_ARTIFACT_CONTRACT}: missing or invalid sections.${field}`,
      );
    }
  }
}

async function expectTrackFindingFiled(finding: TriageFinding): Promise<void> {
  const trackFinding: ReviewTrackFinding = {
    fingerprint: finding.fp,
    severity: "Track",
    title: finding.summary,
    leadDisposition: "track",
  };
  const filer = vi.fn<ReviewTrackFindingFiler<ReviewTrackFinding>>(
    async (findings) =>
      findings.map((candidate) => ({
        fingerprint: candidate.fingerprint,
        issueId: "SYMPH-TRACK-999",
        url: "https://linear.app/mobilyze-llc/issue/SYMPH-TRACK-999",
      })),
  );
  const resolved = await resolveTrackFindingFilings([trackFinding], filer);
  const filing = computeTrackFiling([trackFinding], resolved);
  expect(filer).toHaveBeenCalledWith([trackFinding]);
  expect(filing).toMatchObject({ status: "filed", required: 1, filed: 1 });
}

function laneWorkerCloseout(): Record<string, unknown> {
  return {
    schema: LANE_WORKER_CLOSEOUT_SCHEMA,
    status: "valid",
    source_kind: "runtime",
    producer: {
      role: "review",
      stage: "review",
      phase: "review",
      job_id: "symph-999-review-codex",
      attempt_id: "1",
      model: "gpt-5.5",
      provider: "openai",
      runtime: "codex",
      profile: "review",
    },
    refs: {
      issue_ids: ["SYMPH-999"],
      pr_refs: [],
      artifact: "review.md",
      usage: "review.usage.json",
    },
    coverage: {
      project: "crucible",
      execution_path: "crabrunner-lane",
      stage_coverage: "full-stage",
      turn_coverage: null,
    },
    metadata: {
      artifact_name: "review",
      phase: "review",
      job_id: "symph-999-review-codex",
      attempt_id: "1",
      issue_ids: ["SYMPH-999"],
      pr_refs: [],
    },
    payload: { summary: "review complete", next_action: "collect" },
  };
}

function assertLaneWorkerCloseoutShape(value: unknown): void {
  const closeout = record(value);
  if (closeout?.schema !== LANE_WORKER_CLOSEOUT_SCHEMA) {
    throw new Error(
      `${LANE_WORKER_CLOSEOUT_SCHEMA}: unexpected schema ${String(closeout?.schema)}`,
    );
  }
  for (const field of [
    "status",
    "source_kind",
    "producer",
    "refs",
    "coverage",
    "metadata",
    "payload",
  ]) {
    if (!Object.hasOwn(closeout, field)) {
      throw new Error(`${LANE_WORKER_CLOSEOUT_SCHEMA}: missing ${field}`);
    }
  }
  if (
    record(closeout.producer) === null ||
    record(closeout.refs) === null ||
    record(closeout.coverage) === null ||
    record(closeout.metadata) === null ||
    record(closeout.payload) === null
  ) {
    throw new Error(
      `${LANE_WORKER_CLOSEOUT_SCHEMA}: producer/refs/coverage/metadata/payload shape drift`,
    );
  }
}

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
