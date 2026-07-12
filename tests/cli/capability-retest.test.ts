import {
  access,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { runClusteringCapabilityRetest } from "../../src/cli/capability-retest-clustering.js";
import {
  parseCapabilityRetestVerdictResponse,
  renderVerdictPrompt,
} from "../../src/cli/capability-retest-runner.js";
import { createCapabilityRetestEvaluationWorkspace } from "../../src/cli/capability-retest-workspace.js";
import {
  CAPABILITY_RETEST_EXIT,
  parseCapabilityRetestCliArgs,
  runCapabilityRetestCli,
} from "../../src/cli/capability-retest.js";
import {
  getAltitudeReliabilityCapabilityLedgerPath,
  isAuthoritativeAltitudeReliabilityCapabilityLedgerRow,
  readAltitudeReliabilityCapabilityLedger,
  readClusteringBenchmarkCapabilityLedger,
} from "../../src/logging/capability-ledger.js";
import {
  type DispatcherRunJournalEntryDraft,
  appendDispatcherRunJournalEntriesWithLock,
  compactDispatcherRunJournalFileWithLock,
  getDispatcherRunJournalPath,
  readDispatcherRunJournal,
} from "../../src/logging/run-journal.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

function captureIo() {
  const stdout: string[] = [];
  const stderr: string[] = [];
  return {
    io: {
      stdout: (message: string) => stdout.push(message),
      stderr: (message: string) => stderr.push(message),
    },
    stdout: () => stdout.join(""),
    stderr: () => stderr.join(""),
  };
}

async function tempRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "capability-retest-"));
  roots.push(root);
  return root;
}

describe("capability re-test CLI", () => {
  it("parses a model alias and workspace", () => {
    const options = parseCapabilityRetestCliArgs(
      ["--model=opus", "--workspace", "fixture"],
      "/repo",
    );

    expect(options.model).toBe("opus");
    expect(options.workspace).toBe("/repo/fixture");
    expect(options.benchmark).toBe("altitude");
  });

  it("parses the clustering benchmark surface", () => {
    const options = parseCapabilityRetestCliArgs(
      ["--model", "opus", "--benchmark", "clustering", "--repeats", "4"],
      "/repo",
    );

    expect(options).toMatchObject({ benchmark: "clustering", repeats: 4 });
  });

  it("defaults the reasoning level to the pinned high level", () => {
    const options = parseCapabilityRetestCliArgs(["--model", "opus"], "/repo");

    expect(options.reasoningLevel).toBe("high");
  });

  it.each(["xhigh", "max"] as const)(
    "parses the new %s reasoning level",
    (reasoningLevel) => {
      const options = parseCapabilityRetestCliArgs(
        ["--model", "opus", "--reasoning-level", reasoningLevel],
        "/repo",
      );

      expect(options.reasoningLevel).toBe(reasoningLevel);
    },
  );

  it("rejects an unsupported reasoning level", () => {
    expect(() =>
      parseCapabilityRetestCliArgs(
        ["--model", "opus", "--reasoning-level", "extreme"],
        "/repo",
      ),
    ).toThrow("--reasoning-level must be one of low, medium, high, xhigh, max");
  });

  it("returns usage exit 1 when the model alias is missing", async () => {
    const capture = captureIo();
    const exit = await runCapabilityRetestCli([], { io: capture.io });

    expect(exit).toBe(CAPABILITY_RETEST_EXIT.usage);
    expect(capture.stderr()).toContain(
      "--model must be a non-empty model alias",
    );
  });

  it("rejects gate-authoritative clustering runs below three repeats", async () => {
    const capture = captureIo();
    const exit = await runCapabilityRetestCli(
      ["--model", "opus", "--benchmark", "clustering", "--repeats", "2"],
      { io: capture.io },
    );

    expect(exit).toBe(CAPABILITY_RETEST_EXIT.usage);
    expect(capture.stderr()).toContain("requires --repeats >= 3");
  });

  it("rejects low-N direct ledger-producing calls before inference or append", async () => {
    const root = await tempRoot();
    const runInference = vi.fn();
    const appendCapabilityLedger = vi.fn();

    await expect(
      runClusteringCapabilityRetest({
        model: "opus",
        reasoningLevel: "high",
        workspace: root,
        evaluationWorkspace: root,
        outDir: join(root, "out"),
        fixtureDir: join(
          process.cwd(),
          "tests",
          "fixtures",
          "clustering-golden-set",
        ),
        repeats: 2,
        generatedAt: "2026-07-10T22:00:00.000Z",
        runId: "low-n",
        env: {},
        dependencies: { runInference, appendCapabilityLedger },
      }),
    ).rejects.toThrow("requires at least 3 repeats");
    expect(runInference).not.toHaveBeenCalled();
    expect(appendCapabilityLedger).not.toHaveBeenCalled();
    expect(await readClusteringBenchmarkCapabilityLedger(root)).toEqual([]);
  });

  it("runs three clustering repeats through the production prompt path and appends the durable ledger", async () => {
    const root = await tempRoot();
    const capture = captureIo();
    const fixtureDir = join(
      process.cwd(),
      "tests",
      "fixtures",
      "clustering-golden-set",
    );
    const exit = await runCapabilityRetestCli(
      [
        "--model",
        "opus",
        "--benchmark",
        "clustering",
        "--workspace",
        root,
        "--fixture-dir",
        fixtureDir,
        "--repeats",
        "3",
      ],
      {
        cwd: root,
        io: capture.io,
        now: () => new Date("2026-07-10T22:00:00.000Z"),
        runId: () => "clustering-run-1",
        runClusteringInference: async ({ fixture }) =>
          fixture.fixture_kind === "positive"
            ? fixture.answer_key.clusters.map((cluster) => ({
                memberIssueIdentifiers: cluster.member_issue_identifiers,
                rootCauseHypothesis: `${cluster.root_issue_identifier} is the root`,
                structuralFix: "Fix the shared root",
                confidenceNote: "fixture injection",
              }))
            : [],
      },
    );

    expect(exit).toBe(CAPABILITY_RETEST_EXIT.ok);
    expect(JSON.parse(capture.stdout())).toMatchObject({
      kind: "clustering_golden_set_benchmark",
      repeats: 3,
      fixtureContentHashes: [
        {
          fixtureId: "crucible-root-cause-strategy-pr409",
          sha256: expect.stringMatching(/^[0-9a-f]{64}$/),
        },
        {
          fixtureId: "symphony-intake-t0-negative-control",
          sha256: expect.stringMatching(/^[0-9a-f]{64}$/),
        },
      ],
      summary: {
        pairwisePrecision: { mean: 1, spread: 0 },
        negativeFalseClusterRate: { mean: 0, spread: 0 },
      },
    });
    const rows = await readClusteringBenchmarkCapabilityLedger(root);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      run_id: "clustering-run-1",
      model: "opus",
      reasoning_level: "high",
      result: {
        kind: "clustering_golden_set_benchmark",
        repeats: 3,
        fixtureContentHashes: expect.arrayContaining([
          expect.objectContaining({
            fixtureId: "crucible-root-cause-strategy-pr409",
            sha256: expect.stringMatching(/^[0-9a-f]{64}$/),
          }),
        ]),
      },
    });
  });

  it("records fixture content hashes that change when fixture bytes change", async () => {
    const root = await tempRoot();
    const fixtureDir = join(root, "fixtures");
    await mkdir(fixtureDir, { recursive: true });
    const sourceFixtureDir = join(
      process.cwd(),
      "tests",
      "fixtures",
      "clustering-golden-set",
    );
    const positivePath = join(fixtureDir, "positive-crucible-strategy.json");
    const negativePath = join(fixtureDir, "negative-symphony-t0.json");
    await writeFile(
      positivePath,
      await readFile(
        join(sourceFixtureDir, "positive-crucible-strategy.json"),
        "utf8",
      ),
    );
    await writeFile(
      negativePath,
      await readFile(
        join(sourceFixtureDir, "negative-symphony-t0.json"),
        "utf8",
      ),
    );
    const run = (generatedAt: string, runId: string) =>
      runClusteringCapabilityRetest({
        model: "opus",
        reasoningLevel: "high",
        workspace: root,
        evaluationWorkspace: root,
        outDir: join(root, "out", runId),
        fixtureDir,
        repeats: 3,
        generatedAt,
        runId,
        env: {},
        dependencies: {
          runInference: async ({ fixture }) =>
            fixture.fixture_kind === "positive"
              ? fixture.answer_key.clusters.map((cluster) => ({
                  memberIssueIdentifiers: cluster.member_issue_identifiers,
                  rootCauseHypothesis: `${cluster.root_issue_identifier} is the root`,
                  structuralFix: "Fix the shared root",
                  confidenceNote: "fixture injection",
                }))
              : [],
        },
      });

    const first = await run("2026-07-10T22:01:00.000Z", "hash-run-1");
    const positiveHash = (result: typeof first) =>
      result.fixtureContentHashes.find(
        (entry) => entry.fixtureId === "crucible-root-cause-strategy-pr409",
      )?.sha256;
    const firstHash = positiveHash(first);
    const positive = JSON.parse(await readFile(positivePath, "utf8")) as {
      provenance: { reconstruction: string };
    };
    positive.provenance.reconstruction += " Byte-level evidence changed.";
    await writeFile(positivePath, `${JSON.stringify(positive, null, 2)}\n`);

    const second = await run("2026-07-10T22:02:00.000Z", "hash-run-2");

    expect(positiveHash(second)).not.toBe(firstHash);
    expect(await readClusteringBenchmarkCapabilityLedger(root)).toMatchObject([
      {
        run_id: "hash-run-1",
        result: {
          fixtureContentHashes: expect.arrayContaining([
            expect.objectContaining({ sha256: firstHash }),
          ]),
        },
      },
      {
        run_id: "hash-run-2",
        result: {
          fixtureContentHashes: expect.arrayContaining([
            expect.objectContaining({ sha256: positiveHash(second) }),
          ]),
        },
      },
    ]);
  });

  it("scores the answer key as capability arrived and writes cases to the run journal", async () => {
    const root = await tempRoot();
    const capture = captureIo();
    const exit = await runCapabilityRetestCli(
      ["--model", "opus", "--workspace", root, "--reasoning-level", "medium"],
      {
        cwd: root,
        io: capture.io,
        now: () => new Date("2026-07-10T20:00:00.000Z"),
        runId: () => "run-success",
        runVerdict: async (testCase) => testCase.expectedVerdict,
      },
    );

    expect(exit).toBe(CAPABILITY_RETEST_EXIT.ok);
    expect(JSON.parse(capture.stdout())).toMatchObject({
      model: "opus",
      capabilityArrived: true,
      metrics: { accuracy: 1, killPrecision: 1, falseKills: 0 },
    });
    const journalRows = (
      await readFile(getDispatcherRunJournalPath(root), "utf8")
    )
      .trim()
      .split("\n")
      .map((row) => JSON.parse(row));
    expect(journalRows).toHaveLength(1);
    expect(journalRows[0]).toMatchObject({
      idempotencyKey:
        "altitude_reliability_retest:opus:2026-07-10T20:00:00.000Z:run-success",
      kind: "altitude_reliability_retest",
      metadata: {
        kind: "altitude_reliability_retest",
        model: "opus",
        reasoning_level: "medium",
        capability_arrived: true,
        gate_authority: false,
        evidence_role: "operational_measurement_observation",
        authoritative_evidence_path:
          ".symphony/capability-ledger/altitude-reliability.jsonl",
      },
    });
    expect(journalRows[0].metadata.cases).toHaveLength(5);
    expect(journalRows[0].metadata.cases[0]).toMatchObject({
      issue_identifier: "SYMPH-941",
      expected_verdict: "kill",
      actual_verdict: "kill",
    });
    const durableRows = await readAltitudeReliabilityCapabilityLedger(root);
    expect(durableRows).toHaveLength(1);
    expect(durableRows[0]).toMatchObject({
      run_id: "run-success",
      model: "opus",
      reasoning_level: "medium",
      protocol: "snapshot-v1",
      result: { protocol: "snapshot-v1", capability_arrived: true },
    });
    expect(
      isAuthoritativeAltitudeReliabilityCapabilityLedgerRow(durableRows[0]!),
    ).toBe(true);
  });

  it("reads a legacy altitude ledger row without a reasoning level", async () => {
    const root = await tempRoot();
    const ledgerPath = getAltitudeReliabilityCapabilityLedgerPath(root);
    await mkdir(join(root, ".symphony", "capability-ledger"), {
      recursive: true,
    });
    const legacyRow = {
      schema_version: 1,
      idempotency_key: "legacy",
      run_id: "legacy-run",
      generated_at: "2026-07-10T19:00:00.000Z",
      model: "opus",
      result: { capability_arrived: true },
    };
    await writeFile(ledgerPath, `${JSON.stringify(legacyRow)}\n`);

    const rows = await readAltitudeReliabilityCapabilityLedger(root);
    expect(rows).toEqual([legacyRow]);
    expect(rows[0]).not.toHaveProperty("reasoning_level");
    expect(
      isAuthoritativeAltitudeReliabilityCapabilityLedgerRow(rows[0]!),
    ).toBe(false);
  });

  it("writes the scored ledger and exits non-zero when one false kill fails the bar", async () => {
    const root = await tempRoot();
    const capture = captureIo();
    const exit = await runCapabilityRetestCli(
      ["--model", "opus", "--workspace", root],
      {
        cwd: root,
        io: capture.io,
        now: () => new Date("2026-07-10T20:01:00.000Z"),
        runId: () => "run-failed-bar",
        runVerdict: async (testCase) =>
          testCase.issueIdentifier === "SYMPH-956"
            ? "kill"
            : testCase.expectedVerdict,
      },
    );

    expect(exit).toBe(CAPABILITY_RETEST_EXIT.barFailed);
    expect(JSON.parse(capture.stdout())).toMatchObject({
      capabilityArrived: false,
      metrics: { falseKills: 1 },
    });
    const journal = await readFile(getDispatcherRunJournalPath(root), "utf8");
    expect(journal).toContain('"capability_arrived":false');
  });

  it("writes a scored ledger and exits 2 for a parseable output-contract violation", async () => {
    const root = await tempRoot();
    const capture = captureIo();
    const exit = await runCapabilityRetestCli(
      ["--model", "fable", "--workspace", root],
      {
        cwd: root,
        io: capture.io,
        now: () => new Date("2026-07-10T20:01:30.000Z"),
        runId: () => "run-contract-violation",
        runVerdict: async (testCase) =>
          testCase.issueIdentifier === "SYMPH-941"
            ? parseCapabilityRetestVerdictResponse(
                {
                  status: "ok",
                  markdown:
                    'Explanation: object uses {}\n{"verdict":"kill"}\nTrailing object uses {}',
                },
                testCase.issueIdentifier,
              )
            : testCase.expectedVerdict,
      },
    );

    expect(exit).toBe(CAPABILITY_RETEST_EXIT.barFailed);
    const stdout = JSON.parse(capture.stdout()) as {
      results: Array<Record<string, unknown>>;
    };
    expect(stdout).toMatchObject({
      capabilityArrived: false,
    });
    expect(
      stdout.results.find((entry) => entry.issueIdentifier === "SYMPH-941"),
    ).toMatchObject({
      actualVerdict: "kill",
      correct: false,
      contractViolation: { type: "output_contract_violation" },
    });
    const ledgerRows = await readAltitudeReliabilityCapabilityLedger(root);
    expect(ledgerRows).toHaveLength(1);
    expect(ledgerRows[0]?.run_id).toBe("run-contract-violation");
    const ledgerResult = ledgerRows[0]?.result as {
      cases: Array<Record<string, unknown>>;
    };
    expect(
      ledgerResult.cases.find(
        (entry) => entry.issue_identifier === "SYMPH-941",
      ),
    ).toMatchObject({
      model_contract_violation: {
        type: "output_contract_violation",
      },
      correct: false,
    });
  });

  it("keeps altitude independent from clustering inference injection", async () => {
    const root = await tempRoot();
    const runClusteringInference = vi.fn();
    const exit = await runCapabilityRetestCli(
      ["--model", "opus", "--workspace", root],
      {
        cwd: root,
        io: captureIo().io,
        runVerdict: async (testCase) => testCase.expectedVerdict,
        runClusteringInference,
      },
    );

    expect(exit).toBe(CAPABILITY_RETEST_EXIT.ok);
    expect(runClusteringInference).not.toHaveBeenCalled();
  });

  it("isolates model evaluation from answer-bearing files and original git history", async () => {
    const source = await tempRoot();
    await mkdir(join(source, "src", "audit"), { recursive: true });
    await mkdir(join(source, "src", "agent"), { recursive: true });
    await mkdir(join(source, "src", "cli"), { recursive: true });
    await mkdir(join(source, "src", "domain"), { recursive: true });
    await mkdir(join(source, "src", "logging"), { recursive: true });
    await mkdir(join(source, "tests", "fixtures", "clustering-golden-set"), {
      recursive: true,
    });
    await mkdir(join(source, "docs", "plans"), { recursive: true });
    await mkdir(join(source, ".git"), { recursive: true });
    await writeFile(
      join(source, "src", "safe.ts"),
      "export const safe = true;\n",
    );
    await writeFile(
      join(source, "src", "audit", "altitude-reliability.ts"),
      "export const expectedVerdict = 'kill';\n",
    );
    await writeFile(
      join(source, "src", "cli", "capability-retest.ts"),
      "export const answerKey = true;\n",
    );
    const retainedPlannerDependencies = [
      join("src", "agent", "triage-planner.ts"),
      join("src", "agent", "structural-advisory-output.ts"),
      join("src", "domain", "structural-advisory.ts"),
    ];
    for (const path of retainedPlannerDependencies) {
      await writeFile(join(source, path), "export const production = true;\n");
    }
    const clusteringAnswerSurfaces = [
      join("src", "audit", "clustering-benchmark.ts"),
      join("src", "audit", "clustering-benchmark-fixture.ts"),
      join("src", "audit", "clustering-benchmark-score.ts"),
      join("src", "cli", "capability-retest-clustering.ts"),
      join("src", "cli", "capability-retest-options.ts"),
      join("src", "cli", "capability-retest-runner.ts"),
      join("src", "cli", "capability-retest-workspace.ts"),
      join("src", "cli", "clustering-tool-free-runner.ts"),
      join("src", "logging", "capability-ledger.ts"),
    ];
    for (const path of clusteringAnswerSurfaces) {
      await writeFile(join(source, path), "export const answer = true;\n");
    }
    await writeFile(
      join(source, "tests", "fixtures", "clustering-golden-set", "answer.json"),
      "{}\n",
    );
    await writeFile(join(source, "docs", "plans", "answer.md"), "kill\n");
    await writeFile(join(source, ".git", "answer"), "kill\n");

    const evaluation = await createCapabilityRetestEvaluationWorkspace(source);
    expect(
      await readFile(join(evaluation.path, "src", "safe.ts"), "utf8"),
    ).toContain("safe = true");
    await expectMissing(
      join(evaluation.path, "src", "audit", "altitude-reliability.ts"),
    );
    await expectMissing(
      join(evaluation.path, "src", "cli", "capability-retest.ts"),
    );
    for (const path of clusteringAnswerSurfaces) {
      await expectMissing(join(evaluation.path, path));
    }
    for (const path of retainedPlannerDependencies) {
      expect(await readFile(join(evaluation.path, path), "utf8")).toContain(
        "production = true",
      );
    }
    await expectMissing(join(evaluation.path, "tests"));
    await expectMissing(join(evaluation.path, "docs"));
    await expectMissing(join(evaluation.path, ".git"));

    const evaluationPath = evaluation.path;
    await evaluation.cleanup();
    await expectMissing(evaluationPath);
  });

  it("parses recoverable verdict contract violations at the model boundary", () => {
    expect(
      parseCapabilityRetestVerdictResponse(
        { status: "ok", markdown: '{"verdict":"reframe"}' },
        "SYMPH-957",
      ),
    ).toBe("reframe");
    expect(
      parseCapabilityRetestVerdictResponse(
        { status: "ok", markdown: '{"verdict":"kill"}\nExplanation.' },
        "SYMPH-941",
      ),
    ).toMatchObject({
      verdict: "kill",
      contractViolation: {
        type: "output_contract_violation",
        detail: expect.stringContaining("after"),
      },
    });
    expect(
      parseCapabilityRetestVerdictResponse(
        {
          status: "ok",
          markdown: 'Explanation: object uses {}\n{"verdict":"kill"}',
        },
        "SYMPH-941",
      ),
    ).toMatchObject({
      verdict: "kill",
      contractViolation: {
        type: "output_contract_violation",
        detail: expect.stringContaining("before"),
      },
    });
    expect(
      parseCapabilityRetestVerdictResponse(
        { status: "ok", markdown: '{"verdict":"kill","answer":"key"}' },
        "SYMPH-941",
      ),
    ).toMatchObject({
      verdict: "kill",
      contractViolation: {
        type: "output_contract_violation",
        detail: expect.stringContaining("extra"),
      },
    });
    expect(() =>
      parseCapabilityRetestVerdictResponse(
        { status: "ok", markdown: '{"verdict":17}' },
        "SYMPH-941",
      ),
    ).toThrow(/invalid verdict object/);
  });

  it("keeps the altitude verdict prompt context-contained for empty evaluation snapshots", () => {
    const prompt = renderVerdictPrompt({
      issueIdentifier: "SYMPH-941",
      expectedVerdict: "reframe",
      snapshot: {
        title: "Frozen issue title",
        description: "Frozen issue description",
        cutoff: "2026-06-28T00:00:00.000Z",
        answerIntroducedAt: "2026-06-28T00:00:00.001Z",
        source: "Linear issue fixture",
        reconstructedAt: "2026-07-12T00:00:00.000Z",
        reconstructionNote: "Fixture reconstruction",
      },
    });

    expect(prompt).toContain(
      "Classify Linear issue SYMPH-941 from this prompt alone",
    );
    expect(prompt).toContain("no live Linear access");
    expect(prompt).toContain("Do not use tools");
    expect(prompt).toContain("Title: Frozen issue title");
    expect(prompt).toContain("Frozen issue description");
    expect(prompt).not.toContain("reframe\n");
    expect(prompt).not.toContain("Independently investigate");
  });

  it.each([
    ["runner failure", new Error("runner unavailable")],
    ["verdict parsing failure", new Error("invalid verdict object")],
  ])("exits 3 without scored stdout on %s", async (_name, failure) => {
    const root = await tempRoot();
    const capture = captureIo();
    const exit = await runCapabilityRetestCli(
      ["--model", "opus", "--workspace", root],
      {
        cwd: root,
        io: capture.io,
        runVerdict: async () => {
          throw failure;
        },
      },
    );

    expect(exit).toBe(CAPABILITY_RETEST_EXIT.unavailable);
    expect(capture.stdout()).toBe("");
    expect(capture.stderr()).toContain(failure.message);
    await expectMissing(getDispatcherRunJournalPath(root));
    await expectMissing(getAltitudeReliabilityCapabilityLedgerPath(root));
  });

  it("exits 3 without scored stdout when the dispatcher journal write fails", async () => {
    const root = await tempRoot();
    const capture = captureIo();
    const exit = await runCapabilityRetestCli(
      ["--model", "opus", "--workspace", root],
      {
        cwd: root,
        io: capture.io,
        runVerdict: async (testCase) => testCase.expectedVerdict,
        appendJournal: async () => {
          throw new Error("journal disk full");
        },
      },
    );

    expect(exit).toBe(CAPABILITY_RETEST_EXIT.unavailable);
    expect(capture.stdout()).toBe("");
    expect(capture.stderr()).toContain("journal disk full");
    await expectMissing(getAltitudeReliabilityCapabilityLedgerPath(root));
  });

  it("leaves only a non-authoritative journal observation when the capability-ledger write fails", async () => {
    const root = await tempRoot();
    const capture = captureIo();
    const exit = await runCapabilityRetestCli(
      ["--model", "opus", "--workspace", root],
      {
        cwd: root,
        io: capture.io,
        runVerdict: async (testCase) => testCase.expectedVerdict,
        appendCapabilityLedger: async () => {
          throw new Error("capability ledger disk full");
        },
      },
    );

    expect(exit).toBe(CAPABILITY_RETEST_EXIT.unavailable);
    expect(capture.stdout()).toBe("");
    expect(capture.stderr()).toContain("capability ledger disk full");
    await expectMissing(getAltitudeReliabilityCapabilityLedgerPath(root));
    expect(await readDispatcherRunJournal(root)).toMatchObject([
      {
        kind: "altitude_reliability_retest",
        metadata: {
          gate_authority: false,
          evidence_role: "operational_measurement_observation",
          authoritative_evidence_path:
            ".symphony/capability-ledger/altitude-reliability.jsonl",
        },
      },
    ]);
  });

  it("uses distinct run IDs for same-model invocations at the same timestamp", async () => {
    const root = await tempRoot();
    const ids = ["same-time-a", "same-time-b"];
    for (const id of ids) {
      const exit = await runCapabilityRetestCli(
        ["--model", "opus", "--workspace", root],
        {
          cwd: root,
          now: () => new Date("2026-07-10T20:02:00.000Z"),
          runId: () => id,
          io: captureIo().io,
          runVerdict: async (testCase) => testCase.expectedVerdict,
        },
      );
      expect(exit).toBe(CAPABILITY_RETEST_EXIT.ok);
    }

    expect(
      (await readDispatcherRunJournal(root)).map((row) => row.metadata.run_id),
    ).toEqual(ids);
    expect(
      (await readAltitudeReliabilityCapabilityLedger(root)).map(
        (row) => row.run_id,
      ),
    ).toEqual(ids);
  });

  it("retains the dedicated capability score after dispatcher compaction", async () => {
    const root = await tempRoot();
    const exit = await runCapabilityRetestCli(
      ["--model", "opus", "--workspace", root],
      {
        cwd: root,
        now: () => new Date("2026-07-10T20:03:00.000Z"),
        runId: () => "durable-run",
        io: captureIo().io,
        runVerdict: async (testCase) => testCase.expectedVerdict,
      },
    );
    expect(exit).toBe(CAPABILITY_RETEST_EXIT.ok);

    await appendDispatcherRunJournalEntriesWithLock(
      root,
      [2, 3, 4, 5, 6].map((sequence) => journalDraft(sequence)),
    );
    const compacted = await compactDispatcherRunJournalFileWithLock(
      root,
      checkpointDraft(6),
      { tailEntryCount: 2, minEntryCount: 3 },
    );

    expect(compacted.compacted).toBe(true);
    expect(
      (await readDispatcherRunJournal(root)).some(
        (row) => row.kind === "altitude_reliability_retest",
      ),
    ).toBe(false);
    expect(await readAltitudeReliabilityCapabilityLedger(root)).toMatchObject([
      { run_id: "durable-run", result: { capability_arrived: true } },
    ]);
  });
});

async function expectMissing(path: string): Promise<void> {
  await expect(access(path)).rejects.toMatchObject({ code: "ENOENT" });
}

function journalDraft(sequence: number): DispatcherRunJournalEntryDraft {
  return {
    idempotencyKey: `fixture:${sequence}`,
    timestamp: `2026-07-10T20:03:0${sequence}.000Z`,
    kind: "admission",
    issueId: "fixture",
    issueIdentifier: "SYMPH-FIXTURE",
    operation: "dispatcher",
    stage: null,
    attempt: null,
    ownerId: "test",
    lease: null,
    summary: `fixture ${sequence}`,
    metadata: {},
  };
}

function checkpointDraft(
  coveredThroughSequence: number,
): DispatcherRunJournalEntryDraft {
  return {
    idempotencyKey: `checkpoint:${coveredThroughSequence}`,
    timestamp: "2026-07-10T20:04:00.000Z",
    kind: "journal_checkpoint",
    issueId: "__dispatcher__",
    issueIdentifier: "DISPATCHER",
    operation: "dispatcher",
    stage: null,
    attempt: null,
    ownerId: "test",
    lease: null,
    summary: "checkpoint",
    metadata: { coveredThroughSequence },
  };
}
