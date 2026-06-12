import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { readDispatcherRunJournal } from "../../src/logging/run-journal.js";
import { buildStateDelta } from "../../src/logging/runtime-snapshot.js";
import type {
  HeadlessCouncilGateResult,
  StructuredReviewerArtifact,
} from "../../src/review/headless-council-gate.js";
import {
  appendReviewJournalEventsToDispatcherJournal,
  buildReviewJournalEntries,
} from "../../src/review/review-journal-events.js";

describe("review journal events", () => {
  it("builds sanitized Council v2 review lifecycle events", () => {
    const result = reviewResult({
      verdict: "fail",
      artifact: structuredArtifact({
        verdict: "fail",
        findingIntroducedIn: "original_diff",
      }),
    });

    const entries = buildReviewJournalEntries(result, {
      issueIdentifier: "SYMPH-450",
      ownerId: "worker-1",
      source: "pipeline",
    });

    expect(entries.map((entry) => entry.kind)).toEqual([
      "review_round",
      "review_lane",
      "review_finding",
      "review_synthesis",
      "review_escalation",
      "review_gate_result",
    ]);
    expect(entries.every((entry) => !("sequence" in entry))).toBe(true);
    expect(entries[0]).toMatchObject({
      issueId: "issue-symph-450",
      issueIdentifier: "SYMPH-450",
      operation: "gate",
      stage: "review",
      ownerId: "worker-1",
      metadata: {
        schema_version: 1,
        actor_kind: "pipeline-worker",
        actor_id: "worker-1",
        source: "pipeline",
        contract_version: "structured_v1",
        repo: "mobilyze-llc/symphony-ts",
        pr_number: 450,
        base_sha: "base-sha",
        head_sha: "head-sha",
        bundle_hash: "bundle-hash",
        routing_mode: "full",
        round: 1,
      },
    });
    expect(
      entries.find((entry) => entry.kind === "review_finding")?.metadata,
    ).toMatchObject({
      lane_id: "claude-opus",
      finding_fingerprint: "fp-review-1",
      finding_severity: "P1",
      finding_disposition: "open",
      introduced_in: "original_diff",
      family: "journal substrate",
    });
    expect(
      entries.find((entry) => entry.kind === "review_synthesis")?.metadata,
    ).toMatchObject({
      family: "journal substrate",
      narrowing_status: "open",
      narrowing_rationale: "family retained: 1 remaining symptom(s), 1 fixed",
    });

    const serialized = JSON.stringify(entries);
    expect(serialized).not.toContain("SECRET");
    expect(serialized).not.toContain("diff --git");
    expect(serialized).not.toContain("raw reviewer rationale");
  });

  it("appends, replays, and projects safe review metadata through state delta", async () => {
    const workspaceRoot = await mkdtemp(
      join(tmpdir(), "symphony-review-journal-"),
    );
    const result = reviewResult({
      verdict: "fail",
      round: 2,
      mode: "convergence",
      previousReviewedHeadSha: "previous-head-sha",
      artifact: structuredArtifact({
        verdict: "fail",
        findingIntroducedIn: "fix_round_2",
      }),
    });

    const appendResult = await appendReviewJournalEventsToDispatcherJournal({
      workspaceRoot,
      result,
      options: {
        issueIdentifier: "SYMPH-450",
        ownerId: "worker-1",
        source: "interactive",
        stage: "review",
        attempt: 3,
      },
    });
    const replayed = await readDispatcherRunJournal(workspaceRoot);
    const delta = buildStateDelta(replayed, { sinceSeq: 0 });

    expect(appendResult.appendedEntries).toHaveLength(8);
    expect(replayed.map((entry) => entry.sequence)).toEqual([
      1, 2, 3, 4, 5, 6, 7, 8,
    ]);
    expect(replayed.map((entry) => entry.kind)).toEqual([
      "review_round",
      "fix_round",
      "review_rework",
      "review_lane",
      "review_finding",
      "review_synthesis",
      "review_escalation",
      "review_gate_result",
    ]);
    expect(delta.entries).toHaveLength(8);
    expect(
      delta.entries.find((entry) => entry.kind === "fix_round")?.metadata,
    ).toMatchObject({
      head_sha: "head-sha",
      previous_head_sha: "previous-head-sha",
      fix_round: 2,
    });
    expect(
      delta.entries.find((entry) => entry.kind === "review_finding")?.metadata,
    ).toEqual({
      actor_kind: "interactive-agent",
      actor_id: "worker-1",
      source: "interactive",
      contract_version: "structured_v1",
      repo: "mobilyze-llc/symphony-ts",
      base_ref: "main",
      head_ref: "codex/SYMPH-450-review-journal-events",
      base_sha: "base-sha",
      head_sha: "head-sha",
      bundle_hash: "bundle-hash",
      routing_mode: "convergence",
      round: 2,
      pr_number: 450,
      lane_id: "claude-opus",
      lane_agent: "claude",
      lane_role: "reviewer",
      finding_fingerprint: "fp-review-1",
      finding_severity: "P1",
      emitted_severity: "P1",
      finding_disposition: "open",
      introduced_in: "fix_round_2",
      family: "journal substrate",
      category: "correctness",
      confidence: 0.91,
    });
    expect(
      delta.entries.find((entry) => entry.kind === "review_synthesis")
        ?.metadata,
    ).toMatchObject({
      narrowing_status: "open",
      narrowing_rationale: "family retained: 1 remaining symptom(s), 1 fixed",
      fixed_symptom_count: 1,
      remaining_symptom_count: 1,
    });

    const serializedDelta = JSON.stringify(delta);
    expect(serializedDelta).not.toContain("SECRET");
    expect(serializedDelta).not.toContain("related_paths");
    expect(serializedDelta).not.toContain("evidence_locations");
  });
});

function reviewResult(input: {
  verdict: "pass" | "fail" | "error";
  round?: number;
  mode?: "full" | "convergence";
  previousReviewedHeadSha?: string | null;
  artifact?: StructuredReviewerArtifact;
}): HeadlessCouncilGateResult {
  return {
    schemaVersion: 1,
    issueId: "issue-symph-450",
    verdict: input.verdict,
    startedAt: "2026-06-12T10:00:00.000Z",
    completedAt: "2026-06-12T10:03:00.000Z",
    pr: {
      repo: "mobilyze-llc/symphony-ts",
      number: 450,
      baseRef: "main",
      headRef: "codex/SYMPH-450-review-journal-events",
    },
    review_metadata: {
      reviewed_head_sha: "head-sha",
      previous_reviewed_head_sha: input.previousReviewedHeadSha ?? null,
      base_sha: "base-sha",
      round: input.round ?? 1,
      mode: input.mode ?? "full",
      verdict: input.verdict,
    },
    review_bundle: {
      path: "/tmp/review-bundle.json",
      hash: "bundle-file-hash",
      bundleHash: "bundle-hash",
      hashAlgorithm: "sha256",
    },
    lanes: [
      {
        laneId: "claude-opus",
        agent: "claude",
        role: "reviewer",
        model: "claude-opus-4",
        state: "complete",
        verdict: input.verdict,
        artifactPath: "/tmp/claude.md",
        promptPath: "/tmp/claude.prompt.md",
        stderrPath: "/tmp/claude.stderr",
        cliJsonPath: "/tmp/claude.json",
        independentReviewer: true,
        message: "SECRET lane message with diff --git data",
        degradedReason: null,
        reviewBundle: {
          path: "/tmp/review-bundle.json",
          hash: "bundle-file-hash",
          bundleHash: "bundle-hash",
          hashAlgorithm: "sha256",
        },
        rawArtifactPath: "/tmp/claude.md",
        structuredArtifactPath: "/tmp/claude.structured.json",
        structuredArtifact: input.artifact ?? null,
      },
    ],
    degradedConditions: input.verdict === "error" ? ["cmux-failed"] : [],
    artifactPaths: {
      artifactDir: "/tmp",
      diff: "/tmp/diff.patch",
      reviewBundle: "/tmp/review-bundle.json",
      structuredArtifacts: ["/tmp/claude.structured.json"],
      resultJson: "/tmp/review-result.json",
      councilReport: "/tmp/council-report.md",
    },
    summary: "SECRET raw summary with diff --git payload",
  };
}

function structuredArtifact(input: {
  verdict: "pass" | "fail" | "error";
  findingIntroducedIn: "original_diff" | `fix_round_${number}`;
}): StructuredReviewerArtifact {
  return {
    schemaVersion: 1,
    kind: "symphony-headless-council-reviewer-artifact",
    lane: {
      laneId: "claude-opus",
      agent: "claude",
      role: "reviewer",
      model: "claude-opus-4",
      modelFamily: "claude",
      reasoningEffort: "high",
      independentReviewer: true,
    },
    routing: {
      mode: "full",
      round: 1,
    },
    reviewBundle: {
      path: "/tmp/review-bundle.json",
      hash: "bundle-file-hash",
      bundleHash: "bundle-hash",
      hashAlgorithm: "sha256",
    },
    verdict: input.verdict,
    confidence: 0.9,
    parseStatus: "synthesized_from_markdown",
    rawArtifactPath: "/tmp/raw.md",
    malformedReason: null,
    sections: {
      p1: "SECRET raw section",
      p2: "",
      track: "",
      dismissedOrTheoretical: "",
      triage: "",
    },
    findings: [
      {
        fingerprint: "fp-review-1",
        severity: "P1",
        emittedSeverity: "P1",
        title: "SECRET raw reviewer rationale with diff --git",
        titleStem: "SECRET raw reviewer rationale",
        category: "correctness",
        confidence: 0.91,
        evidence: [
          {
            path: "src/review/review-journal-events.ts",
            lineStart: 42,
            lineEnd: 50,
            changedPath: true,
          },
        ],
        relatedPaths: ["src/review/review-journal-events.ts"],
        rationale: "SECRET raw reviewer rationale with code body",
        leadDisposition: "open",
        repeatOf: null,
        introducedIn: input.findingIntroducedIn,
        dismissalReason: null,
        family: {
          name: "journal substrate",
          safetyClaim: "SECRET family safety claim",
          nextRoundQuestion: "SECRET next round question",
          fixedSymptoms: ["SECRET fixed symptom"],
          remainingSymptoms: ["SECRET remaining symptom"],
        },
      },
    ],
    familySyntheses: [
      {
        name: "journal substrate",
        safetyClaim: "SECRET family safety claim",
        nextRoundQuestion: "SECRET next round question",
        fixedSymptoms: ["SECRET fixed symptom"],
        remainingSymptoms: ["SECRET remaining symptom"],
        findingFingerprints: ["fp-review-1"],
      },
    ],
  };
}
