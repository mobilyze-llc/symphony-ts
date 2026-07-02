import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  CrabboxSpineClient,
  type SpineCommandResult,
  type SpineCommandRunner,
  SpineUnavailableError,
} from "../../../src/review/spine/crabbox-spine-client.js";

const TRIAGE_PASS = {
  schema: "crucible.session-orchestrator.council-triage.v1",
  lanes: [
    {
      reviewer: "opus",
      file: "a.md",
      verdict: "PASS",
      parse_quality: "clean",
      finding_count: 0,
      none: true,
      fail_open: false,
    },
  ],
  summary: {
    lanes: 1,
    track: 0,
    escalate: 0,
    unparseable_lanes: 0,
    blocked_lanes: 0,
    partial_lanes: 0,
  },
  track: [],
  escalate: [],
  next_action: "no_blocking_findings_this_round",
};

const CROSS_EXAM_NOT_REQUIRED = {
  schema: "crucible.session-orchestrator.cross-exam-select.v1",
  cross_exam_required: false,
  reason: "frozen diff, nothing escalated",
  fix_diff_changed: false,
  fix_size_lines: null,
  fix_trivial: null,
  parseable_lanes: 1,
  target_count: 0,
  targets: [],
};

const CONVERGED = {
  schema: "crucible.session-orchestrator.convergence-decision.v1",
  input_rounds: 2,
  state: "converged",
  reason: "2 clean rounds over a frozen diff",
  rounds: 2,
};

function capturingRunner(
  result: SpineCommandResult | (() => SpineCommandResult),
): {
  runner: SpineCommandRunner;
  calls: string[][];
} {
  const calls: string[][] = [];
  const runner: SpineCommandRunner = async (argv) => {
    calls.push([...argv]);
    return typeof result === "function" ? result() : result;
  };
  return { runner, calls };
}

function ok(json: unknown): SpineCommandResult {
  return { stdout: JSON.stringify(json), stderr: "", exitCode: 0 };
}

describe("CrabboxSpineClient", () => {
  it("parses a council-triage result and pairs review-file/reviewer argv in order", async () => {
    const { runner, calls } = capturingRunner(ok(TRIAGE_PASS));
    const client = new CrabboxSpineClient({ runCommand: runner });
    const result = await client.councilTriage({
      reviews: [
        { file: "a.md", reviewer: "opus" },
        { file: "b.md", reviewer: "deepseek" },
      ],
    });
    expect(result.summary.escalate).toBe(0);
    expect(result.next_action).toBe("no_blocking_findings_this_round");
    const argv = calls[0]!;
    expect(argv).toContain("council-triage");
    expect(argv.join(" ")).toContain(
      "--review-file a.md --reviewer opus --review-file b.md --reviewer deepseek",
    );
  });

  it("coalesces wording-only same-location escalations while preserving reviewer provenance", async () => {
    const { runner } = capturingRunner(
      ok({
        ...TRIAGE_PASS,
        summary: { ...TRIAGE_PASS.summary, lanes: 2, escalate: 2 },
        escalate: [
          {
            severity: "P1",
            location: "src/parser.ts:42",
            summary: "Parser drops findings from the crucible section.",
            evidence: "",
            failure: "same location with one wording.",
            test: "fixture documents fingerprint wording sensitivity.",
            fp: "src/parser.ts::9609936f74",
            reviewer: "codex",
          },
          {
            severity: "P1",
            location: "src/parser.ts:42",
            summary: "Crucible findings section is ignored by the parser.",
            evidence: "",
            failure: "same location with different wording.",
            test: "fixture documents fingerprint wording sensitivity.",
            fp: "src/parser.ts::4ad7ac701c",
            reviewer: "cursor",
          },
        ],
      }),
    );
    const client = new CrabboxSpineClient({ runCommand: runner });

    const result = await client.councilTriage({
      reviews: [
        { file: "a.md", reviewer: "codex" },
        { file: "b.md", reviewer: "cursor" },
      ],
    });

    expect(result.summary.escalate).toBe(1);
    expect(result.escalate).toHaveLength(1);
    expect(result.escalate[0]?.fp).toBe("src/parser.ts::9609936f74");
    expect((result.escalate[0] as { reviewers?: string[] }).reviewers).toEqual([
      "codex",
      "cursor",
    ]);
    expect(
      (result.escalate[0] as { coalesced_fps?: string[] }).coalesced_fps,
    ).toEqual(["src/parser.ts::9609936f74", "src/parser.ts::4ad7ac701c"]);
  });

  it("preserves low-overlap same-location escalations as distinct contracts", async () => {
    const { runner } = capturingRunner(
      ok({
        ...TRIAGE_PASS,
        summary: { ...TRIAGE_PASS.summary, lanes: 2, escalate: 2 },
        escalate: [
          {
            severity: "P1",
            location: "src/auth.ts:42",
            summary: "Missing null check on token.",
            evidence: "",
            failure: "token may be absent.",
            test: "unit covers nullable token.",
            fp: "src/auth.ts::token",
            reviewer: "codex",
          },
          {
            severity: "P1",
            location: "src/auth.ts:42",
            summary: "Audit logger writes secrets to disk.",
            evidence: "",
            failure: "secret leakage.",
            test: "unit covers logging redaction.",
            fp: "src/auth.ts::logger",
            reviewer: "cursor",
          },
        ],
      }),
    );
    const client = new CrabboxSpineClient({ runCommand: runner });

    const result = await client.councilTriage({
      reviews: [
        { file: "a.md", reviewer: "codex" },
        { file: "b.md", reviewer: "cursor" },
      ],
    });

    expect(result.summary.escalate).toBe(2);
    expect(result.escalate.map((finding) => finding.fp)).toEqual([
      "src/auth.ts::token",
      "src/auth.ts::logger",
    ]);
  });

  it("omits unknown optional flags from cross-exam-select argv (no literal null)", async () => {
    const { runner, calls } = capturingRunner(ok(CROSS_EXAM_NOT_REQUIRED));
    const client = new CrabboxSpineClient({ runCommand: runner });
    const result = await client.crossExamSelect({
      triageFile: "t.json",
      currentDiffHash: "abc123",
    });
    expect(result.cross_exam_required).toBe(false);
    const argv = calls[0]!.join(" ");
    expect(argv).toContain("--current-diff-hash abc123");
    expect(argv).not.toContain("--fix-size-lines");
    expect(argv).not.toContain("--prior-diff-hash");
    expect(argv).not.toContain("null");
  });

  it("includes optional cross-exam flags when provided", async () => {
    const { runner, calls } = capturingRunner(ok(CROSS_EXAM_NOT_REQUIRED));
    const client = new CrabboxSpineClient({ runCommand: runner });
    await client.crossExamSelect({
      triageFile: "t.json",
      currentDiffHash: "head",
      priorDiffHash: "prior",
      fixSizeLines: 12,
    });
    const argv = calls[0]!.join(" ");
    expect(argv).toContain("--prior-diff-hash prior");
    expect(argv).toContain("--fix-size-lines 12");
  });

  it("parses a convergence-decision result", async () => {
    const { runner } = capturingRunner(ok(CONVERGED));
    const client = new CrabboxSpineClient({ runCommand: runner });
    const result = await client.convergenceDecision({ roundsFile: "r.json" });
    expect(result.state).toBe("converged");
  });

  it("throws SpineUnavailableError on a non-zero exit", async () => {
    const { runner } = capturingRunner({
      stdout: "",
      stderr: "boom",
      exitCode: 2,
    });
    const client = new CrabboxSpineClient({ runCommand: runner });
    await expect(
      client.councilTriage({ reviews: [{ file: "a.md", reviewer: "opus" }] }),
    ).rejects.toBeInstanceOf(SpineUnavailableError);
  });

  it("throws SpineUnavailableError on malformed JSON", async () => {
    const { runner } = capturingRunner({
      stdout: "not json",
      stderr: "",
      exitCode: 0,
    });
    const client = new CrabboxSpineClient({ runCommand: runner });
    await expect(
      client.councilTriage({ reviews: [{ file: "a.md", reviewer: "opus" }] }),
    ).rejects.toThrow(/valid JSON/);
  });

  it("throws SpineUnavailableError on a drifted schema id (contract drift)", async () => {
    const drifted = {
      ...TRIAGE_PASS,
      schema: "crucible.session-orchestrator.council-triage.v2",
    };
    const { runner } = capturingRunner(ok(drifted));
    const client = new CrabboxSpineClient({ runCommand: runner });
    await expect(
      client.councilTriage({ reviews: [{ file: "a.md", reviewer: "opus" }] }),
    ).rejects.toThrow(/contract drift/);
  });

  it("rejects an empty reviewer set", async () => {
    const { runner } = capturingRunner(ok(TRIAGE_PASS));
    const client = new CrabboxSpineClient({ runCommand: runner });
    await expect(client.councilTriage({ reviews: [] })).rejects.toBeInstanceOf(
      SpineUnavailableError,
    );
  });

  it("preflight resolves when the spine returns a single triaged lane", async () => {
    const { runner } = capturingRunner(ok(TRIAGE_PASS));
    const client = new CrabboxSpineClient({ runCommand: runner });
    await expect(client.preflight()).resolves.toBeUndefined();
  });

  it("preflight fails closed when the spine returns no lanes", async () => {
    const empty = {
      ...TRIAGE_PASS,
      lanes: [],
      summary: { ...TRIAGE_PASS.summary, lanes: 0 },
    };
    const { runner } = capturingRunner(ok(empty));
    const client = new CrabboxSpineClient({ runCommand: runner });
    await expect(client.preflight()).rejects.toBeInstanceOf(
      SpineUnavailableError,
    );
  });

  it("fails closed via the real runner when the spine path is missing", async () => {
    // No injected runner: a non-existent spine path makes node exit non-zero, which
    // must surface end-to-end as a fail-closed SpineUnavailableError (never a pass).
    const client = new CrabboxSpineClient({
      spinePath: "/nonexistent/symphony-spine-does-not-exist.mjs",
      timeoutMs: 10_000,
    });
    await expect(
      client.councilTriage({ reviews: [{ file: "a.md", reviewer: "opus" }] }),
    ).rejects.toBeInstanceOf(SpineUnavailableError);
  });

  it("wraps a runner spawn rejection as a 'spawn failed' SpineUnavailableError", async () => {
    const runner: SpineCommandRunner = async () => {
      throw new Error("ETIMEDOUT");
    };
    const client = new CrabboxSpineClient({ runCommand: runner });
    await expect(
      client.councilTriage({ reviews: [{ file: "a.md", reviewer: "opus" }] }),
    ).rejects.toThrow(/spawn failed/);
  });
});

// Live conformance: run the real crucible spine when it is present (controller /
// local dev). Skipped in CI where the crucible checkout is absent.
const LIVE_SPINE_PATH =
  process.env.SYMPHONY_REVIEW_SPINE_PATH ??
  join(
    homedir(),
    "projects/crucible/skills/session-orchestrator/scripts/production-rollout.mjs",
  );

describe.skipIf(!existsSync(LIVE_SPINE_PATH))(
  "CrabboxSpineClient (live spine)",
  () => {
    it("preflights against the real crucible spine", async () => {
      const client = new CrabboxSpineClient({ spinePath: LIVE_SPINE_PATH });
      await expect(client.preflight()).resolves.toBeUndefined();
    });
  },
);
