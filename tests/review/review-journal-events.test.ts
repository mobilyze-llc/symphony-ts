import { mkdir, mkdtemp, readFile, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  getDispatcherRunJournalLockPath,
  getDispatcherRunJournalPath,
  readDispatcherRunJournal,
} from "../../src/logging/run-journal.js";
import { buildStateDelta } from "../../src/logging/runtime-snapshot.js";
import { reduceMergeCandidates } from "../../src/orchestrator/merge-candidate.js";
import type {
  HeadlessCouncilGateResult,
  StructuredReviewerArtifact,
  TargetedConvergenceHypothesis,
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
    const serialized = JSON.stringify(entries);
    expect(serialized).not.toContain("SECRET");
    expect(serialized).not.toContain("diff --git");
    expect(serialized).not.toContain("raw reviewer rationale");
  });

  it("records Council v2 routing metadata in review journal entries", () => {
    const result = reviewResult({
      verdict: "pass",
      artifact: structuredArtifact({
        verdict: "pass",
        findingIntroducedIn: "original_diff",
      }),
    });
    result.review_metadata.routing_mode = "standard";
    result.review_routing = standardReviewRouting();

    const entries = buildReviewJournalEntries(result, {
      issueIdentifier: "SYMPH-445",
      ownerId: "worker-1",
      source: "pipeline",
    });

    expect(entries[0]?.metadata).toMatchObject({
      routing_mode: "standard",
      selected_lanes: ["pi-deepseek", "codex-excavation", "codex-high-lead"],
      skipped_lanes: ["claude-opus:standard_mode_routes_off_opus"],
      escalation_predicates: ["codex_author_codex_lead_tripwire"],
      decorrelation_merge_eligible: true,
      decorrelated_reviewer_lanes: ["pi-deepseek"],
      direct_signal_lanes: ["codex-excavation", "codex-high-lead"],
      author_families: ["openai-codex"],
      high_risk_predicate_triggers: [],
      high_risk_predicate_paths: [],
    });
    const gateResult = entries.find(
      (entry) => entry.kind === "review_gate_result",
    );
    expect(gateResult?.metadata).toMatchObject({
      routing_mode: "standard",
      decorrelation_summary:
        "Merge-eligible decorrelated reviewer artifact(s): pi-deepseek.",
    });
    expect(
      entries.find((entry) => entry.kind === "merge_candidate"),
    ).toBeDefined();
  });

  it("excludes non-authoritative shadow findings from journal escalation", () => {
    const result = reviewResult({ verdict: "pass" });
    const shadowArtifact = structuredArtifact({
      verdict: "fail",
      findingIntroducedIn: "fix_round_4",
    });
    shadowArtifact.lane = {
      ...shadowArtifact.lane,
      laneId: "kimi-k27-shadow",
      agent: "kimi",
      role: "kimi-k27-shadow-reviewer",
      mergeAuthoritative: false,
    };
    result.lanes.push({
      ...result.lanes[0]!,
      laneId: "kimi-k27-shadow",
      agent: "kimi",
      role: "kimi-k27-shadow-reviewer",
      model: "configured-default",
      verdict: "fail",
      independentReviewer: false,
      mergeAuthoritative: false,
      structuredArtifact: shadowArtifact,
      structuredArtifactPath: "/tmp/kimi.structured.json",
    });

    const entries = buildReviewJournalEntries(result, {
      issueIdentifier: "SYMPH-689",
      ownerId: "worker-1",
      source: "pipeline",
    });

    expect(entries).toContainEqual(
      expect.objectContaining({
        kind: "review_lane",
        metadata: expect.objectContaining({ lane_id: "kimi-k27-shadow" }),
      }),
    );
    expect(entries.map((entry) => entry.kind)).not.toContain("review_finding");
    expect(entries.map((entry) => entry.kind)).not.toContain(
      "review_escalation",
    );
    expect(entries[0]?.metadata).toMatchObject({
      finding_count: 0,
    });
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

    expect(appendResult.appendedEntries).toHaveLength(7);
    expect(replayed.map((entry) => entry.sequence)).toEqual([
      1, 2, 3, 4, 5, 6, 7,
    ]);
    expect(replayed.map((entry) => entry.kind)).toEqual([
      "review_round",
      "fix_round",
      "review_rework",
      "review_lane",
      "review_finding",
      "review_escalation",
      "review_gate_result",
    ]);
    expect(delta.entries).toHaveLength(7);
    expect(
      delta.entries.find((entry) => entry.kind === "fix_round")?.metadata,
    ).toMatchObject({
      head_sha: "head-sha",
      previous_head_sha: "previous-head-sha",
      fix_round: 2,
    });
    const reworkDelta = delta.entries.find(
      (entry) => entry.kind === "review_rework",
    );
    expect(reworkDelta?.metadata).toMatchObject({
      actor_kind: "interactive-agent",
      actor_id: "worker-1",
      source: "interactive",
      contract_version: "structured_v1",
      routing_mode: "convergence",
      round: 2,
      rework_finding_count: 1,
    });
    expect(reworkDelta?.metadata).not.toHaveProperty("introduced_in");
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
    const escalationDelta = delta.entries.find(
      (entry) => entry.kind === "review_escalation",
    );
    expect(escalationDelta?.metadata).toMatchObject({
      actor_kind: "interactive-agent",
      actor_id: "worker-1",
      source: "interactive",
      contract_version: "structured_v1",
      routing_mode: "convergence",
      round: 2,
      gate_verdict: "fail",
      escalation_reason: "blocking_findings",
      blocking_finding_count: 1,
      degraded_condition_count: 0,
    });
    expect(escalationDelta?.metadata).not.toHaveProperty("degraded_conditions");

    const serializedDelta = JSON.stringify(delta);
    expect(serializedDelta).not.toContain("SECRET");
    expect(serializedDelta).not.toContain("related_paths");
    expect(serializedDelta).not.toContain("evidence_locations");
  });

  it("replays the captured v1 review and merge-candidate journal compatibility fixture", async () => {
    const fixture = await readFile(
      new URL(
        "../fixtures/review/v1-review-merge-candidate-journal.jsonl",
        import.meta.url,
      ),
      "utf8",
    );
    const workspaceRoot = await mkdtemp(
      join(tmpdir(), "symphony-v1-review-replay-"),
    );
    const journalPath = getDispatcherRunJournalPath(workspaceRoot);
    await mkdir(dirname(journalPath), { recursive: true });
    await writeFile(journalPath, fixture);

    const replayed = await readDispatcherRunJournal(workspaceRoot);
    const delta = buildStateDelta(replayed, { sinceSeq: 0 });
    const candidates = reduceMergeCandidates(replayed);

    expect(replayed.map((entry) => entry.kind)).toEqual([
      "review_round",
      "review_gate_result",
      "merge_candidate",
    ]);
    expect(delta.entries.map((entry) => entry.kind)).toEqual([
      "review_round",
      "review_gate_result",
      "merge_candidate",
    ]);
    expect(
      replayed.find((entry) => entry.kind === "review_gate_result")?.metadata,
    ).toMatchObject({
      schema_version: 1,
      gate_verdict: "pass",
      decorrelation_merge_eligible: true,
      review_result_path: "/tmp/symph-804/review-result.json",
    });
    expect(candidates["issue-symph-804"]).toMatchObject({
      issueIdentifier: "SYMPH-804",
      repo: "mobilyze-llc/symphony-ts",
      prNumber: 804,
      baseSha: "base-sha-v1",
      headSha: "head-sha-v1",
      reviewedHeadSha: "head-sha-v1",
      reviewResultPath: "/tmp/symph-804/review-result.json",
      councilVerdict: "pass",
      decorrelationMergeEligible: true,
      round: 1,
      status: "candidate",
    });
  });

  it("persists lane wall-time and token telemetry through state delta", async () => {
    const workspaceRoot = await mkdtemp(
      join(tmpdir(), "symphony-review-journal-telemetry-"),
    );
    const result = reviewResult({
      verdict: "pass",
      wallTimeMs: 12_345,
      tokenUsage: {
        available: true,
        model: "opus",
        inputTokens: 200,
        outputTokens: 50,
        totalTokens: 250,
        cacheReadTokens: 25,
        cacheWriteTokens: null,
        reasoningTokens: null,
        totalCostUsd: 0.19,
      },
    });

    const entries = buildReviewJournalEntries(result, {
      issueIdentifier: "SYMPH-479",
      ownerId: "worker-1",
      source: "pipeline",
    });
    expect(
      entries.find((entry) => entry.kind === "review_lane")?.metadata,
    ).toMatchObject({
      lane_id: "claude-opus",
      wall_time_ms: 12_345,
      input_tokens: 200,
      output_tokens: 50,
      total_tokens: 250,
      artifact_path: "/tmp/claude.md",
      structured_artifact_path: "/tmp/claude.structured.json",
      review_bundle_file_hash: "bundle-file-hash",
      review_bundle_hash: "bundle-hash",
    });
    expect(
      entries.find((entry) => entry.kind === "review_lane")?.metadata,
    ).not.toHaveProperty("totalCostUsd");

    await appendReviewJournalEventsToDispatcherJournal({
      workspaceRoot,
      result,
      options: {
        issueIdentifier: "SYMPH-479",
        ownerId: "worker-1",
        source: "pipeline",
      },
    });
    const delta = buildStateDelta(
      await readDispatcherRunJournal(workspaceRoot),
      {
        sinceSeq: 0,
      },
    );
    expect(
      delta.entries.find((entry) => entry.kind === "review_lane")?.metadata,
    ).toMatchObject({
      lane_id: "claude-opus",
      wall_time_ms: 12_345,
      input_tokens: 200,
      output_tokens: 50,
      total_tokens: 250,
      artifact_path: "/tmp/claude.md",
      structured_artifact_path: "/tmp/claude.structured.json",
      review_bundle_file_hash: "bundle-file-hash",
      review_bundle_hash: "bundle-hash",
    });
    expect(JSON.stringify(delta)).not.toContain("totalCostUsd");
    expect(JSON.stringify(delta)).not.toContain("SECRET");
  });

  it("emits termination ladder telemetry through review journal events", () => {
    const result = reviewResult({
      verdict: "fail",
      round: 3,
      mode: "convergence",
      termination: {
        status: "operator_decision",
        reason: "round_cap_hit",
        action: "operator_decision_required_with_synthesis",
        roundsPerCycle: 3,
        thresholds: {
          roundWarning: 2,
          roundCap: 3,
        },
        alertLevel: "operator",
        blockingFindingCount: 0,
        nonBlockingFindingCount: 0,
        trackFindingCount: 0,
        trackFiling: {
          status: "none",
          required: 0,
          filed: 0,
          reason: null,
          findings: [],
        },
        familySyntheses: [
          {
            key: "termination ladder",
            name: "termination ladder",
            safetyClaim: null,
            nextRoundQuestion: null,
            fixedSymptoms: [],
            remainingSymptoms: [],
            findingFingerprints: [],
          },
        ],
        familySynthesisCount: 1,
        synthesisAttached: true,
        synthesisFamilyNames: ["termination ladder"],
      },
    });

    const entries = buildReviewJournalEntries(result, {
      issueIdentifier: "SYMPH-469",
      ownerId: "worker-1",
      source: "interactive",
    });

    expect(
      entries.find((entry) => entry.kind === "review_round")?.metadata,
    ).toMatchObject({
      rounds_per_cycle: 3,
      round_warning_threshold: 2,
      round_cap: 3,
      termination_alert_level: "operator",
    });
    expect(
      entries.find((entry) => entry.kind === "review_escalation")?.metadata,
    ).toMatchObject({
      escalation_reason: "round_cap_hit",
      termination_status: "operator_decision",
      termination_reason: "round_cap_hit",
      termination_action: "operator_decision_required_with_synthesis",
      synthesis_count: 1,
      blocking_finding_count: 0,
    });
    expect(
      entries.find((entry) => entry.kind === "review_gate_result")?.metadata,
    ).toMatchObject({
      termination_status: "operator_decision",
      termination_reason: "round_cap_hit",
      termination_action: "operator_decision_required_with_synthesis",
      rounds_per_cycle: 3,
      round_warning_threshold: 2,
      round_cap: 3,
      termination_alert_level: "operator",
      synthesis_count: 1,
      non_blocking_finding_count: 0,
      track_finding_count: 0,
    });
  });

  it("surfaces the Track-finding filing status in review_gate_result metadata (SYMPH-760)", () => {
    // The merge gate must not silently treat trackFindingCount > 0 with missing
    // issue IDs as a clean closeout: the filing status rides into the durable
    // review_gate_result row so it is machine-readable downstream.
    const result = reviewResult({
      verdict: "pass",
      termination: {
        status: "converged",
        reason: "disposition_exit",
        action: "continue_pipeline",
        roundsPerCycle: 1,
        thresholds: { roundWarning: 2, roundCap: 3 },
        alertLevel: "warning",
        blockingFindingCount: 0,
        nonBlockingFindingCount: 1,
        trackFindingCount: 1,
        trackFiling: {
          status: "unfiled",
          required: 1,
          filed: 0,
          reason: "track_findings_unfiled",
          findings: [
            {
              fingerprint: "abc123",
              title: "doc gap",
              issueId: null,
              url: null,
            },
          ],
        },
        familySyntheses: [],
        familySynthesisCount: 0,
        synthesisAttached: false,
        synthesisFamilyNames: [],
      },
    });

    const entries = buildReviewJournalEntries(result, {
      issueIdentifier: "SYMPH-760",
      ownerId: "worker-1",
      source: "pipeline",
    });

    expect(
      entries.find((entry) => entry.kind === "review_gate_result")?.metadata,
    ).toMatchObject({
      track_finding_count: 1,
      track_filing_status: "unfiled",
      track_filing_reason: "track_findings_unfiled",
      track_filing_filed_count: 0,
    });
  });

  it("persists targeted convergence narrowing rationale through review journal events", () => {
    const targetedConvergence = targetedConvergenceHypothesis();
    const artifact = structuredArtifact({
      verdict: "fail",
      findingIntroducedIn: "fix_round_2",
    });
    const result = reviewResult({
      verdict: "fail",
      round: 2,
      mode: "convergence",
      previousReviewedHeadSha: "previous-head-sha",
      artifact,
      targetedConvergence,
    });

    const entries = buildReviewJournalEntries(result, {
      issueIdentifier: "SYMPH-468",
      ownerId: "worker-1",
      source: "interactive",
    });

    expect(
      entries.find((entry) => entry.kind === "review_round")?.metadata,
    ).toMatchObject({
      targeting_hypothesis_version: "targeted_convergence_v1",
      targeting_trigger: "shared_asserted_family",
      targeting_family: "journal substrate",
      targeting_invariant: "every journal write is replayable",
      targeting_fix_delta_range: "previous-head-sha..head-sha",
      targeting_merge_base_sha: "merge-base-sha",
      narrowing_rationale:
        "2 confirmed findings asserted family journal substrate; next round narrows to falsifying every journal write is replayable while still reviewing the fix delta",
      fix_delta_path_count: 2,
      semantic_neighborhood_path_count: 3,
      producer_path_count: 1,
      consumer_path_count: 1,
      skip_unchanged_remainder: true,
    });
    expect(
      entries.find((entry) => entry.kind === "review_gate_result")?.metadata,
    ).toMatchObject({
      targeting_trigger: "shared_asserted_family",
      skip_unchanged_remainder: true,
    });
  });

  it("emits escalation when termination reason requires operator attention", () => {
    const result = reviewResult({
      verdict: "pass",
      termination: {
        status: "operator_decision",
        reason: "round_cap_hit",
        action: "operator_decision_required_with_synthesis",
        roundsPerCycle: 3,
        thresholds: {
          roundWarning: 2,
          roundCap: 3,
        },
        alertLevel: "operator",
        blockingFindingCount: 0,
        nonBlockingFindingCount: 0,
        trackFindingCount: 0,
        trackFiling: {
          status: "none",
          required: 0,
          filed: 0,
          reason: null,
          findings: [],
        },
        familySyntheses: [
          {
            key: "termination ladder",
            name: "termination ladder",
            safetyClaim: null,
            nextRoundQuestion: null,
            fixedSymptoms: [],
            remainingSymptoms: [],
            findingFingerprints: [],
          },
        ],
        familySynthesisCount: 1,
        synthesisAttached: true,
        synthesisFamilyNames: ["termination ladder"],
      },
    });

    const entries = buildReviewJournalEntries(result, {
      issueIdentifier: "SYMPH-469",
      ownerId: "worker-1",
      source: "interactive",
    });

    expect(entries.map((entry) => entry.kind)).toEqual([
      "review_round",
      "review_lane",
      "review_escalation",
      "review_gate_result",
    ]);
    expect(
      entries.find((entry) => entry.kind === "review_escalation")?.metadata,
    ).toMatchObject({
      escalation_reason: "round_cap_hit",
      termination_status: "operator_decision",
      termination_reason: "round_cap_hit",
      termination_action: "operator_decision_required_with_synthesis",
      gate_verdict: "pass",
      blocking_finding_count: 0,
    });
  });

  it("serializes concurrent standalone review appends into one journal sequence stream", async () => {
    const workspaceRoot = await mkdtemp(
      join(tmpdir(), "symphony-review-journal-concurrent-"),
    );
    const appendCount = 8;

    await Promise.all(
      Array.from({ length: appendCount }, (_, index) =>
        appendReviewJournalEventsToDispatcherJournal({
          workspaceRoot,
          result: reviewResult({ verdict: "pass" }),
          options: {
            issueIdentifier: "SYMPH-450",
            ownerId: `worker-${index}`,
            source: "pipeline",
            idempotencyKeyPrefix: `review-concurrent-${index}`,
          },
        }),
      ),
    );

    const replayed = await readDispatcherRunJournal(workspaceRoot);
    const sequences = replayed.map((entry) => entry.sequence);

    expect(replayed).toHaveLength(appendCount * 3);
    expect(sequences).toEqual(
      Array.from({ length: appendCount * 3 }, (_, index) => index + 1),
    );
    expect(new Set(sequences).size).toBe(sequences.length);
    expect(
      replayed.filter((entry) => entry.kind === "review_gate_result"),
    ).toHaveLength(appendCount);
  });

  it("skips duplicate concurrent standalone review appends under the write lock", async () => {
    const workspaceRoot = await mkdtemp(
      join(tmpdir(), "symphony-review-journal-concurrent-duplicates-"),
    );

    const results = await Promise.all(
      Array.from({ length: 6 }, (_, index) =>
        appendReviewJournalEventsToDispatcherJournal({
          workspaceRoot,
          result: reviewResult({ verdict: "pass" }),
          options: {
            issueIdentifier: "SYMPH-450",
            ownerId: `worker-${index}`,
            source: "pipeline",
            idempotencyKeyPrefix: "review-concurrent-shared",
          },
        }),
      ),
    );

    const replayed = await readDispatcherRunJournal(workspaceRoot);
    const sequences = replayed.map((entry) => entry.sequence);

    expect(replayed).toHaveLength(3);
    expect(sequences).toEqual([1, 2, 3]);
    expect(results.flatMap((result) => result.appendedEntries)).toHaveLength(3);
    expect(results.flatMap((result) => result.skippedEntries)).toHaveLength(15);
  });

  it("recovers a standalone review append after a dead owner leaves a lock", async () => {
    const workspaceRoot = await mkdtemp(
      join(tmpdir(), "symphony-review-journal-stale-lock-"),
    );
    const lockPath = getDispatcherRunJournalLockPath(workspaceRoot);
    await mkdir(lockPath, { recursive: true });
    await writeFile(
      join(lockPath, "owner.json"),
      `${JSON.stringify({
        pid: 999_999_999,
        acquiredAt: new Date(Date.now() - 60_000).toISOString(),
      })}\n`,
    );

    const result = await appendReviewJournalEventsToDispatcherJournal({
      workspaceRoot,
      result: reviewResult({ verdict: "pass" }),
      options: {
        issueIdentifier: "SYMPH-450",
        ownerId: "worker-1",
        source: "pipeline",
      },
    });

    expect(result.appendedEntries).toHaveLength(3);
    expect(await readDispatcherRunJournal(workspaceRoot)).toHaveLength(3);
  });

  it("serializes concurrent recovery from a dead-owner lock", async () => {
    const workspaceRoot = await mkdtemp(
      join(tmpdir(), "symphony-review-journal-stale-lock-concurrent-"),
    );
    const lockPath = getDispatcherRunJournalLockPath(workspaceRoot);
    await mkdir(lockPath, { recursive: true });
    await writeFile(
      join(lockPath, "owner.json"),
      `${JSON.stringify({
        pid: 999_999_999,
        acquiredAt: new Date(Date.now() - 60_000).toISOString(),
      })}\n`,
    );

    const appendCount = 6;
    const results = await Promise.all(
      Array.from({ length: appendCount }, (_, index) =>
        appendReviewJournalEventsToDispatcherJournal({
          workspaceRoot,
          result: reviewResult({ verdict: "pass" }),
          options: {
            issueIdentifier: "SYMPH-450",
            ownerId: `worker-${index}`,
            source: "pipeline",
            idempotencyKeyPrefix: `review-stale-recovery-${index}`,
          },
        }),
      ),
    );

    const replayed = await readDispatcherRunJournal(workspaceRoot);
    const sequences = replayed.map((entry) => entry.sequence);

    expect(results.flatMap((result) => result.appendedEntries)).toHaveLength(
      appendCount * 3,
    );
    expect(replayed).toHaveLength(appendCount * 3);
    expect(sequences).toEqual(
      Array.from({ length: appendCount * 3 }, (_, index) => index + 1),
    );
    expect(new Set(sequences).size).toBe(sequences.length);
  });

  it("recovers from stale corrupt lock owner metadata", async () => {
    const workspaceRoot = await mkdtemp(
      join(tmpdir(), "symphony-review-journal-corrupt-lock-"),
    );
    const lockPath = getDispatcherRunJournalLockPath(workspaceRoot);
    const staleTimestamp = new Date(Date.now() - 60_000);
    await mkdir(lockPath, { recursive: true });
    await writeFile(join(lockPath, "owner.json"), "");
    await utimes(lockPath, staleTimestamp, staleTimestamp);

    const result = await appendReviewJournalEventsToDispatcherJournal({
      workspaceRoot,
      result: reviewResult({ verdict: "pass" }),
      options: {
        issueIdentifier: "SYMPH-450",
        ownerId: "worker-1",
        source: "pipeline",
      },
    });

    expect(result.appendedEntries).toHaveLength(3);
    expect(await readDispatcherRunJournal(workspaceRoot)).toHaveLength(3);
  });

  it("recovers when a stale recovery claim is abandoned", async () => {
    const workspaceRoot = await mkdtemp(
      join(tmpdir(), "symphony-review-journal-stale-recovery-claim-"),
    );
    const lockPath = getDispatcherRunJournalLockPath(workspaceRoot);
    const recoveryPath = join(lockPath, "recovery.lock");
    const staleTimestamp = new Date(Date.now() - 60_000);
    await mkdir(recoveryPath, { recursive: true });
    await writeFile(
      join(lockPath, "owner.json"),
      `${JSON.stringify({
        pid: 999_999_999,
        acquiredAt: staleTimestamp.toISOString(),
      })}\n`,
    );
    await utimes(recoveryPath, staleTimestamp, staleTimestamp);

    const result = await appendReviewJournalEventsToDispatcherJournal({
      workspaceRoot,
      result: reviewResult({ verdict: "pass" }),
      options: {
        issueIdentifier: "SYMPH-450",
        ownerId: "worker-1",
        source: "pipeline",
      },
    });

    expect(result.appendedEntries).toHaveLength(3);
    expect(await readDispatcherRunJournal(workspaceRoot)).toHaveLength(3);
  });
});

function reviewResult(input: {
  verdict: "pass" | "fail" | "error";
  round?: number;
  mode?: "full" | "convergence";
  previousReviewedHeadSha?: string | null;
  artifact?: StructuredReviewerArtifact;
  wallTimeMs?: number | null;
  tokenUsage?: HeadlessCouncilGateResult["lanes"][number]["tokenUsage"];
  termination?: HeadlessCouncilGateResult["termination"];
  targetedConvergence?: TargetedConvergenceHypothesis | null;
}): HeadlessCouncilGateResult {
  const round = input.round ?? 1;
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
      round,
      mode: input.mode ?? "full",
      verdict: input.verdict,
    },
    review_routing: null,
    review_bundle: {
      path: "/tmp/review-bundle.json",
      hash: "bundle-file-hash",
      bundleHash: "bundle-hash",
      hashAlgorithm: "sha256",
    },
    targeted_convergence: input.targetedConvergence ?? null,
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
        reasoningEffort: null,
        independentReviewer: true,
        mergeAuthoritative: true,
        message: "SECRET lane message with diff --git data",
        degradedReason: null,
        reviewBundle: {
          path: "/tmp/review-bundle.json",
          hash: "bundle-file-hash",
          bundleHash: "bundle-hash",
          hashAlgorithm: "sha256",
        },
        wallTimeMs: input.wallTimeMs ?? null,
        tokenUsage: input.tokenUsage ?? null,
        rawArtifactPath: "/tmp/claude.md",
        structuredArtifactPath: "/tmp/claude.structured.json",
        structuredArtifact: input.artifact ?? null,
      },
    ],
    degradedConditions: input.verdict === "error" ? ["cmux-failed"] : [],
    termination:
      input.termination ??
      defaultTerminationAssessment(input.verdict, round, input.artifact),
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

function defaultTerminationAssessment(
  verdict: "pass" | "fail" | "error",
  round: number,
  artifact: StructuredReviewerArtifact | undefined,
): NonNullable<HeadlessCouncilGateResult["termination"]> {
  const blockingFindingCount =
    artifact?.findings.filter(
      (finding) =>
        (finding.severity === "P1" || finding.severity === "P2") &&
        finding.leadDisposition === "open",
    ).length ?? 0;
  const trackFindingCount =
    artifact?.findings.filter(
      (finding) =>
        finding.severity === "Track" || finding.leadDisposition === "track",
    ).length ?? 0;
  const status =
    verdict === "pass"
      ? "converged"
      : verdict === "error"
        ? "degraded"
        : "continue";
  return {
    status,
    reason:
      status === "converged"
        ? "clean"
        : status === "degraded"
          ? "gate_error"
          : "blocking_findings",
    action:
      status === "converged"
        ? "continue_pipeline"
        : status === "degraded"
          ? "inspect_review_substrate"
          : "continue_fix_loop",
    roundsPerCycle: round,
    thresholds: {
      roundWarning: 2,
      roundCap: 3,
    },
    alertLevel: round >= 3 ? "operator" : round >= 2 ? "warning" : "ok",
    blockingFindingCount,
    nonBlockingFindingCount:
      (artifact?.findings.length ?? 0) - blockingFindingCount,
    trackFindingCount: trackFindingCount,
    trackFiling:
      trackFindingCount === 0
        ? { status: "none", required: 0, filed: 0, reason: null, findings: [] }
        : {
            status: "unfiled",
            required: trackFindingCount,
            filed: 0,
            reason: "track_findings_unfiled",
            findings: [],
          },
    familySynthesisCount: 0,
    synthesisAttached: false,
    synthesisFamilyNames: [],
    familySyntheses: [],
  };
}

function standardReviewRouting(): NonNullable<
  HeadlessCouncilGateResult["review_routing"]
> {
  return {
    schemaVersion: 1,
    mode: "standard",
    selectedLanes: [
      {
        laneId: "pi-deepseek",
        agent: "pi",
        role: "deepseek-direct-reviewer",
        required: true,
        decorrelatedSignal: true,
        reason: "non_author_family_reviewer_artifact",
      },
      {
        laneId: "codex-excavation",
        agent: "codex",
        role: "codex-edge-case-excavation",
        required: false,
        decorrelatedSignal: false,
        reason: "direct_codex_excavation_signal",
      },
      {
        laneId: "codex-high-lead",
        agent: "codex",
        role: "codex-lead-triage",
        required: false,
        decorrelatedSignal: false,
        reason: "codex_lead_triage",
      },
    ],
    skippedLanes: [
      {
        laneId: "claude-opus",
        agent: "claude",
        reason: "standard_mode_routes_off_opus",
      },
    ],
    decorrelationBasis: {
      authorFamilies: ["openai-codex"],
      requiredNonAuthorFamilyReviewer: true,
      requiredReviewerLaneIds: ["pi-deepseek"],
      directSignalLaneIds: ["codex-excavation", "codex-high-lead"],
      decorrelatedReviewerArtifacts: [
        {
          laneId: "pi-deepseek",
          agent: "pi",
          modelFamily: "pi",
        },
      ],
      mergeEligible: true,
      summary: "Merge-eligible decorrelated reviewer artifact(s): pi-deepseek.",
    },
    escalationPredicates: ["codex_author_codex_lead_tripwire"],
    operatorOverrideReason: null,
    highRiskPredicate: {
      triggerHits: [],
      matchedPaths: [],
      matches: [],
    },
    leadConfidenceThreshold: 0.7,
  };
}

function targetedConvergenceHypothesis(): TargetedConvergenceHypothesis {
  return {
    schemaVersion: 1,
    kind: "symphony-targeted-convergence-hypothesis",
    hypothesisVersion: "targeted_convergence_v1",
    familyMetadataTrustBoundary:
      "prior_reviewer_family_metadata_untrusted_data",
    trigger: "shared_asserted_family",
    family: "journal substrate",
    namedInvariant: "every journal write is replayable",
    safetyClaim: "every journal write is replayable",
    nextRoundQuestion: "did replay preserve the write?",
    sourceFindingFingerprints: ["fp-review-1", "fp-review-2"],
    sourceRounds: [1],
    narrowingRationale:
      "2 confirmed findings asserted family journal substrate; next round narrows to falsifying every journal write is replayable while still reviewing the fix delta",
    roleTargets: {
      codex: "hunt_same_family_variants",
      pi: "validate_matrix_completeness",
    },
    scope: {
      previousReviewedHeadSha: "previous-head-sha",
      currentHeadSha: "head-sha",
      mergeBaseSha: "merge-base-sha",
      fixDeltaRange: "previous-head-sha..head-sha",
      fixDeltaPaths: [
        "src/review/review-journal-events.ts",
        "tests/review/review-journal-events.test.ts",
      ],
      semanticNeighborhoodPaths: [
        "src/review/review-journal-events.ts",
        "tests/review/review-journal-events.test.ts",
        "docs/review-runbook.md",
      ],
      producerPaths: ["src/review/review-journal-events.ts"],
      consumerPaths: ["tests/review/review-journal-events.test.ts"],
      fixDeltaSource: "git_range_exact",
      mergeBaseSource: "git_merge_base_exact",
      semanticNeighborhoodSource: "merge_base_exact",
      scopeDegradedReasons: [],
      skipUnchangedRemainder: true,
    },
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
      mergeAuthoritative: true,
    },
    routing: {
      mode: "full",
      routingMode: null,
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
      findings: "",
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
  };
}
