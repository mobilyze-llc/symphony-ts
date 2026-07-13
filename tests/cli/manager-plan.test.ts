import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it, vi } from "vitest";

import type { PlannerRunResult } from "../../src/agent/triage-planner.js";
import { runTriagePlanner } from "../../src/agent/triage-planner.js";
import { readCalibrationJournal } from "../../src/calibration/journal-reader.js";
import {
  DEFAULT_MANAGER_PLAN_IN_FLIGHT_STATES,
  MANAGER_PLAN_RUNTIME_STATE_BASE_URL_ENV,
  type ManagerPlanCandidateQuery,
  type ManagerPlanCliDependencies,
  ManagerPlanCliUsageError,
  type ManagerPlanGroundingInput,
  type ManagerPlanPlannerRunnerInput,
  inferManagerPlanGroundingRepoScope,
  parseManagerPlanCliArgs,
  runManagerPlanCli,
  toPlannerCandidateGroundingEvidence,
} from "../../src/cli/manager-plan.js";
import type { Issue } from "../../src/domain/model.js";
import type { PlanReviewRecord } from "../../src/domain/standing-plan.js";
import {
  GROUNDING_EXTRACTOR_ROUTE,
  type GroundingExtractionResult,
} from "../../src/orchestrator/grounding-extractor.js";
import { assembleShadowPlannerContext } from "../../src/orchestrator/standing-plan-shadow.js";
import { PORTFOLIO_TAXONOMY_PROJECTS } from "../../src/portfolio/taxonomy.js";

function issue(
  id: string,
  identifier: string,
  priority = 2,
  overrides: Partial<Issue> = {},
): Issue {
  return {
    id,
    identifier,
    title: `Title ${identifier}`,
    description: null,
    priority,
    state: "Backlog",
    branchName: null,
    url: null,
    labels: [],
    blockedBy: [],
    createdAt: null,
    updatedAt: null,
    ...overrides,
  };
}

function captureIo() {
  const out: string[] = [];
  const err: string[] = [];
  return {
    io: {
      stdout: (message: string) => out.push(message),
      stderr: (message: string) => err.push(message),
    },
    out: () => out.join(""),
    err: () => err.join(""),
  };
}

const GOOD_ARTIFACT =
  '# Plan\n```json\n{"rationale":"go","batches":[{"mode":"parallel-isolated","issueIdentifiers":["MOB-1"],"rationale":"first"}]}\n```\n';

const ADVISORY_ARTIFACT = `# Plan
\`\`\`json
${JSON.stringify({
  rationale: "go",
  batches: [
    {
      mode: "parallel-isolated",
      issueIdentifiers: ["MOB-1"],
      rationale: "first",
    },
  ],
  structural_advisories: [
    {
      memberIssueIdentifiers: ["MOB-1", "MOB-2"],
      rootCauseHypothesis: "Shared root",
      structuralFix: "Centralize the fix",
      confidenceNote: "High",
    },
  ],
})}
\`\`\`
`;

const okRunner = () => async (): Promise<PlannerRunResult> => ({
  status: "ok",
  markdown: GOOD_ARTIFACT,
});

describe("parseManagerPlanCliArgs", () => {
  it("parses team, repeatable state, envelope flags, model, and boolean flags", () => {
    const opts = parseManagerPlanCliArgs([
      "--team",
      "MOB",
      "--state",
      "Backlog",
      "--state",
      "Todo",
      "--concurrency-ceiling",
      "5",
      "--risk",
      "high",
      "--modes",
      "parallel-isolated,canary-chain",
      "--model",
      "opus",
      "--effort",
      "high",
      "--prompt-only",
      "--json",
    ]);
    expect(opts.team).toBe("MOB");
    expect(opts.states).toEqual(["Backlog", "Todo"]);
    expect(opts.concurrencyCeiling).toBe(5);
    expect(opts.effort).toBe("high");
    expect(opts.risk).toBe("high");
    expect(opts.modes).toEqual(["parallel-isolated", "canary-chain"]);
    expect(opts.model).toBe("opus");
    expect(opts.promptOnly).toBe(true);
    expect(opts.json).toBe(true);
    expect(opts.commentEnrichment).toBe(true);
    expect(opts.outDir).toBeNull();
    expect(opts.inFlightStates).toEqual([
      ...DEFAULT_MANAGER_PLAN_IN_FLIGHT_STATES,
    ]);
  });

  it("defaults planner effort to max and rejects unsupported values", () => {
    expect(parseManagerPlanCliArgs(["--team", "MOB"]).effort).toBe("max");
    expect(() =>
      parseManagerPlanCliArgs(["--team", "MOB", "--effort", "xhigh"]),
    ).toThrow(ManagerPlanCliUsageError);
  });

  it("applies defaults and leaves modes unset when omitted", () => {
    const opts = parseManagerPlanCliArgs([
      "--team",
      "MOB",
      "--state",
      "Backlog",
    ]);
    expect(opts.concurrencyCeiling).toBe(3);
    expect(opts.risk).toBe("medium");
    expect(opts.model).toBe("opus");
    expect(opts.modes).toBeNull();
    expect(opts.promptOnly).toBe(false);
    expect(opts.json).toBe(false);
  });

  it("defaults --state to Backlog when no --state is given (SYMPH-867)", () => {
    expect(parseManagerPlanCliArgs(["--team", "MOB"]).states).toEqual([
      "Backlog",
    ]);
  });

  it("explicit --state overrides the Backlog default (SYMPH-867)", () => {
    expect(
      parseManagerPlanCliArgs(["--team", "MOB", "--state", "Todo"]).states,
    ).toEqual(["Todo"]);
  });

  it("explicit multi-state list overrides the default with no Backlog injected (SYMPH-867)", () => {
    expect(
      parseManagerPlanCliArgs([
        "--team",
        "MOB",
        "--state",
        "Todo",
        "--state",
        "In Review",
      ]).states,
    ).toEqual(["Todo", "In Review"]);
  });

  it("parses --no-canary (default false) (SYMPH-838)", () => {
    expect(
      parseManagerPlanCliArgs(["--team", "MOB", "--state", "Backlog"]).noCanary,
    ).toBe(false);
    expect(
      parseManagerPlanCliArgs([
        "--team",
        "MOB",
        "--state",
        "Backlog",
        "--no-canary",
      ]).noCanary,
    ).toBe(true);
  });

  it("parses in-flight and comment-enrichment controls (SYMPH-961)", () => {
    const opts = parseManagerPlanCliArgs([
      "--team",
      "MOB",
      "--in-flight-state",
      "Implementing",
      "--in-flight-state",
      "Review",
      "--no-comment-enrichment",
    ]);

    expect(opts.inFlightStates).toEqual(["Implementing", "Review"]);
    expect(opts.commentEnrichment).toBe(false);
  });

  it("parses gh PR context and opt-in persistence controls (SYMPH-838)", () => {
    const opts = parseManagerPlanCliArgs([
      "--team",
      "MOB",
      "--gh-pr-context",
      "--github-repo",
      "mobilyze-llc/symphony-ts",
      "--persist",
    ]);

    expect(opts.ghPrContext).toBe(true);
    expect(opts.githubRepo).toBe("mobilyze-llc/symphony-ts");
    expect(opts.persist).toBe(true);
  });

  it("parses planner grounding controls (SYMPH-1017 U4)", () => {
    const opts = parseManagerPlanCliArgs([
      "--team",
      "MOB",
      "--planner-grounding",
      "--planner-grounding-repo-url",
      "git@github.com:mobilyze-llc/symphony-ts.git",
      "--planner-grounding-commit",
      "abc123",
      "--planner-grounding-repo-scope",
      "symphony",
    ]);

    expect(opts.plannerGrounding).toBe(true);
    expect(opts.plannerGroundingRepoUrl).toBe(
      "git@github.com:mobilyze-llc/symphony-ts.git",
    );
    expect(opts.plannerGroundingCommit).toBe("abc123");
    expect(opts.plannerGroundingRepoScope).toBe("symphony");
  });

  it("infers Symphony planner grounding scope for common git URL forms (SYMPH-1017 council)", () => {
    expect(
      inferManagerPlanGroundingRepoScope(
        "https://github.com/mobilyze-llc/symphony-ts/",
      ),
    ).toBe("symphony");
    expect(
      inferManagerPlanGroundingRepoScope(
        "https://github.com/mobilyze-llc/symphony-ts.git/",
      ),
    ).toBe("symphony");
    expect(
      inferManagerPlanGroundingRepoScope(
        "git@github.com:mobilyze-llc/symphony.git",
      ),
    ).toBe("symphony");
    expect(
      inferManagerPlanGroundingRepoScope(
        "https://github.com/mobilyze-llc/not-symphony-ts.git/",
      ),
    ).toBe("non_symphony");
  });

  it("parses --out-dir for controller-side prompt evidence artifacts (SYMPH-961)", () => {
    const opts = parseManagerPlanCliArgs([
      "--project",
      "9c1064215e8d",
      "--out-dir",
      "/tmp/symphony-manager-plan-SYMPH-961-prompt-only",
    ]);

    expect(opts.outDir).toBe(
      "/tmp/symphony-manager-plan-SYMPH-961-prompt-only",
    );
  });

  it("parses --runtime-state-base-url for live runtime in-flight context (SYMPH-961)", () => {
    const opts = parseManagerPlanCliArgs([
      "--project",
      "9c1064215e8d",
      "--runtime-state-base-url",
      "http://127.0.0.1:4321",
    ]);

    expect(opts.runtimeStateBaseUrl).toBe("http://127.0.0.1:4321");
  });

  it("parses --project and --initiative scope flags (SYMPH-858)", () => {
    const opts = parseManagerPlanCliArgs([
      "--project",
      "abc123",
      "--initiative",
      "Healthspanners",
      "--state",
      "Backlog",
    ]);
    expect(opts.project).toBe("abc123");
    expect(opts.initiative).toBe("Healthspanners");
    expect(opts.team).toBeNull();
  });

  it("defaults --project and --initiative to null when omitted (SYMPH-858)", () => {
    const opts = parseManagerPlanCliArgs([
      "--team",
      "MOB",
      "--state",
      "Backlog",
    ]);
    expect(opts.project).toBeNull();
    expect(opts.initiative).toBeNull();
  });

  it("rejects a non-integer concurrency ceiling", () => {
    expect(() =>
      parseManagerPlanCliArgs(["--concurrency-ceiling", "abc"]),
    ).toThrow(ManagerPlanCliUsageError);
  });

  it("rejects a zero concurrency ceiling or page size (positive-integer contract)", () => {
    expect(() =>
      parseManagerPlanCliArgs(["--concurrency-ceiling", "0"]),
    ).toThrow(ManagerPlanCliUsageError);
    expect(() => parseManagerPlanCliArgs(["--page-size", "0"])).toThrow(
      ManagerPlanCliUsageError,
    );
  });

  it("rejects an unknown flag", () => {
    expect(() => parseManagerPlanCliArgs(["--frobnicate"])).toThrow(
      ManagerPlanCliUsageError,
    );
  });
});

describe("planner grounding helpers", () => {
  it("keeps verified evidence visible when only some claims are ungrounded (SYMPH-1017 council)", () => {
    const result: GroundingExtractionResult = {
      route: GROUNDING_EXTRACTOR_ROUTE,
      digest: {
        text: "Mixed evidence should still guide the planner.",
        charLimit: 2_000,
        truncated: false,
        status: "unverified",
      },
      claims: [
        {
          id: "claim-verified",
          sourceId: "body",
          kind: "path_symbol",
          text: "src/agent/triage-planner.ts",
          summary: "Planner prompt rendering exists",
          status: "verified",
          citations: [
            {
              checkoutId: "checkout-1",
              commitSha: "abc123",
              path: "src/agent/triage-planner.ts",
              lineRange: [10, 12],
              contentHash: "hash",
              matchedSpan: "buildPlannerPrompt",
            },
          ],
          missing: [],
        },
        {
          id: "claim-ungrounded",
          sourceId: "body",
          kind: "behavioral",
          text: "Historical deployment note",
          summary: "No code citation found",
          status: "ungrounded",
          citations: [],
          missing: ["No matching repo evidence"],
        },
      ],
      units: [],
      groundingReport: {
        generatedAt: "2026-07-01T00:00:00.000Z",
        status: "verified",
        checkout: {
          checkoutId: "checkout-1",
          path: "/tmp/checkout-1",
          commitSha: "abc123",
          repoUrl: "git@github.com:mobilyze-llc/symphony-ts.git",
        },
        entries: [],
        cleanup: {
          leaseReleased: true,
          checkoutPurged: false,
          dirtyState: null,
        },
        warnings: ["grounding report warning"],
      },
      extractorCallCount: 1,
      warnings: ["extractor warning"],
    };

    const evidence = toPlannerCandidateGroundingEvidence(result, 37, [
      "doc warning",
    ]);

    expect(evidence.status).toBe("grounded");
    expect(evidence.reason).toBeNull();
    expect(evidence.claims.map((claim) => claim.status)).toEqual([
      "verified",
      "ungrounded",
    ]);
    expect(evidence.claims[0]?.citations[0]?.path).toBe(
      "src/agent/triage-planner.ts",
    );
    expect(evidence.warnings).toEqual([
      "doc warning",
      "extractor warning",
      "grounding report warning",
    ]);
  });

  it("marks the whole candidate ungrounded only when the grounding report is ungrounded", () => {
    const evidence = toPlannerCandidateGroundingEvidence(
      {
        route: GROUNDING_EXTRACTOR_ROUTE,
        digest: {
          text: "Repository outside supported scope.",
          charLimit: 2_000,
          truncated: false,
          status: "unverified",
        },
        claims: [],
        units: [],
        groundingReport: {
          generatedAt: "2026-07-01T00:00:00.000Z",
          status: "ungrounded",
          checkout: {
            checkoutId: null,
            path: null,
            commitSha: "abc123",
            repoUrl: "git@github.com:mobilyze-llc/other.git",
          },
          entries: [],
          cleanup: {
            leaseReleased: true,
            checkoutPurged: true,
            dirtyState: null,
          },
          warnings: [],
        },
        extractorCallCount: 1,
        warnings: [],
      },
      12,
    );

    expect(evidence.status).toBe("ungrounded");
    expect(evidence.reason).toContain(
      "outside the v1 Symphony grounding scope",
    );
  });
});

describe("runManagerPlanCli", () => {
  it("errors when no scope (team/project/initiative) is given (SYMPH-858)", async () => {
    const { io, err } = captureIo();
    const code = await runManagerPlanCli(["--state", "Backlog"], {
      io,
      env: {},
      loadCandidates: async () => [],
      createPlannerRunner: okRunner,
    });
    expect(code).toBe(1);
    expect(err()).toMatch(/at least one scope/i);
  });

  it("accepts --project alone (no --team) and passes it to the loader (SYMPH-858)", async () => {
    const { io } = captureIo();
    const seen: ManagerPlanCandidateQuery[] = [];
    await runManagerPlanCli(
      ["--project", "abc123", "--state", "Backlog", "--prompt-only"],
      {
        io,
        env: {},
        loadCandidates: async (input) => {
          seen.push(input);
          return [issue("u1", "MOB-1")];
        },
        createPlannerRunner: okRunner,
      },
    );
    expect(seen[0]?.teamKeys).toEqual([]);
    expect(seen[0]?.projectSlug).toBe("abc123");
    expect(seen[0]?.initiative).toBeNull();
  });

  it("passes the current workspace to the default-capable planner runner", async () => {
    const { io } = captureIo();
    const seen: ManagerPlanPlannerRunnerInput[] = [];
    const outDir = join(tmpdir(), "manager-plan-runner-workspace");

    const code = await runManagerPlanCli(
      ["--project", "abc123", "--state", "Backlog", "--out-dir", outDir],
      {
        io,
        env: {},
        loadCandidates: async () => [issue("u1", "MOB-1")],
        createPlannerRunner: (input) => {
          seen.push(input);
          return okRunner();
        },
      },
    );

    expect(code).toBe(0);
    expect(seen[0]).toMatchObject({
      artifactDir: outDir,
      model: "opus",
      effort: "max",
      workspace: process.cwd(),
    });
  });

  it("resolves --project name-or-slug to slugId before loading candidates (SYMPH-838)", async () => {
    const { io } = captureIo();
    const seen: ManagerPlanCandidateQuery[] = [];
    const code = await runManagerPlanCli(
      [
        "--project",
        "Runtime Operations & Admission Safety",
        "--state",
        "Backlog",
        "--prompt-only",
      ],
      {
        io,
        env: {},
        resolveProjectSlug: async (input) => ({
          id: "project-1",
          name: input.project,
          slugId: "runtime-ops",
        }),
        loadCandidates: async (input) => {
          seen.push(input);
          return [issue("u1", "MOB-1")];
        },
        createPlannerRunner: okRunner,
      },
    );

    expect(code).toBe(0);
    expect(seen[0]?.projectSlug).toBe("runtime-ops");
  });

  it("accepts --initiative alone and passes it to the loader (SYMPH-858)", async () => {
    const { io } = captureIo();
    const seen: ManagerPlanCandidateQuery[] = [];
    await runManagerPlanCli(
      ["--initiative", "Healthspanners", "--state", "Backlog", "--prompt-only"],
      {
        io,
        env: {},
        loadCandidates: async (input) => {
          seen.push(input);
          return [issue("u1", "MOB-1")];
        },
        createPlannerRunner: okRunner,
      },
    );
    expect(seen[0]?.teamKeys).toEqual([]);
    expect(seen[0]?.projectSlug).toBeNull();
    expect(seen[0]?.initiative).toBe("Healthspanners");
  });

  it("passes additive --team + --project + --initiative scope to the loader (SYMPH-858)", async () => {
    const { io } = captureIo();
    const seen: ManagerPlanCandidateQuery[] = [];
    await runManagerPlanCli(
      [
        "--team",
        "MOB",
        "--project",
        "abc123",
        "--initiative",
        "Healthspanners",
        "--state",
        "Backlog",
        "--prompt-only",
      ],
      {
        io,
        env: {},
        loadCandidates: async (input) => {
          seen.push(input);
          return [issue("u1", "MOB-1")];
        },
        createPlannerRunner: okRunner,
      },
    );
    expect(seen[0]?.teamKeys).toEqual(["MOB"]);
    expect(seen[0]?.projectSlug).toBe("abc123");
    expect(seen[0]?.initiative).toBe("Healthspanners");
  });

  it("defaults to the Backlog state when --state is omitted (SYMPH-867)", async () => {
    const { io } = captureIo();
    const seen: ManagerPlanCandidateQuery[] = [];
    const code = await runManagerPlanCli(["--team", "MOB", "--prompt-only"], {
      io,
      env: {},
      loadCandidates: async (input) => {
        seen.push(input);
        return [issue("u1", "MOB-1")];
      },
      createPlannerRunner: okRunner,
    });
    expect(code).toBe(0);
    expect(seen[0]?.activeStates).toEqual(["Backlog"]);
  });

  it("errors when a --state value is empty", async () => {
    const { io, err } = captureIo();
    const code = await runManagerPlanCli(["--team", "MOB", "--state", ""], {
      io,
      env: {},
      loadCandidates: async () => [],
      createPlannerRunner: okRunner,
    });
    expect(code).toBe(1);
    expect(err()).toMatch(/--state/);
  });

  it("returns a distinct exit code (5) when loading candidates fails", async () => {
    const { io, err } = captureIo();
    const code = await runManagerPlanCli(
      ["--team", "MOB", "--state", "Backlog"],
      {
        io,
        env: {},
        loadCandidates: async () => {
          throw new Error("Linear is down");
        },
        createPlannerRunner: okRunner,
      },
    );
    expect(code).toBe(5);
    expect(err()).toContain("Linear is down");
  });

  it("--prompt-only prints the planner prompt and never invokes the model", async () => {
    const { io, out } = captureIo();
    let plannerCalls = 0;
    const code = await runManagerPlanCli(
      ["--team", "MOB", "--state", "Backlog", "--prompt-only"],
      {
        io,
        env: {},
        loadCandidates: async () => [
          issue("u1", "MOB-1"),
          issue("u2", "MOB-2"),
        ],
        createPlannerRunner: () => async () => {
          plannerCalls += 1;
          return { status: "ok", markdown: GOOD_ARTIFACT };
        },
      },
    );
    expect(code).toBe(0);
    expect(plannerCalls).toBe(0);
    expect(out()).toContain("MOB-1");
    // The emitted prompt shows the exact canary keys (SYMPH-836).
    expect(out()).toContain("headIssueIdentifiers");
    expect(out()).toContain('"structural_advisories"');
    expect(out()).toContain("non-binding and report-only");
  });

  it("--prompt-only writes the assembled prompt when --out-dir is provided (SYMPH-961)", async () => {
    const { io, out } = captureIo();
    const outDir = await mkdtemp(join(tmpdir(), "manager-plan-test-"));
    try {
      const code = await runManagerPlanCli(
        [
          "--project",
          "9c1064215e8d",
          "--state",
          "Backlog",
          "--prompt-only",
          "--out-dir",
          outDir,
        ],
        {
          io,
          env: {},
          loadCandidates: async () => [issue("u1", "SYMPH-941")],
          createPlannerRunner: okRunner,
        },
      );

      expect(code).toBe(0);
      const prompt = await readFile(
        join(outDir, "manager-plan-prompt.txt"),
        "utf8",
      );
      expect(prompt).toContain("SYMPH-941");
      expect(out()).toContain("SYMPH-941");
    } finally {
      await rm(outDir, { recursive: true, force: true });
    }
  });

  it("--prompt-only includes loaded in-flight issues and curated comments (SYMPH-961)", async () => {
    const { io, out } = captureIo();
    const seenInFlightQueries: ManagerPlanCandidateQuery[] = [];
    const fetchedCommentsFor: string[] = [];
    const code = await runManagerPlanCli(
      ["--team", "MOB", "--state", "Backlog", "--prompt-only"],
      {
        io,
        env: {},
        loadCandidates: async () => [issue("u1", "MOB-1")],
        loadInFlight: async (input) => {
          seenInFlightQueries.push(input);
          return [issue("u2", "MOB-2", 1, { state: "In Progress" })];
        },
        fetchIssueComments: async (issueId) => {
          fetchedCommentsFor.push(issueId);
          return [
            {
              id: "comment-1",
              body: "Parked decision: MOB-1 should wait for the relation edge.",
              createdAt: "2026-06-28T00:00:00.000Z",
              updatedAt: "2026-06-28T00:00:00.000Z",
              user: {
                kind: "user",
                id: "user-1",
                name: "Operator",
                displayName: "Operator",
                email: "operator@example.com",
                botType: null,
                botSubType: null,
              },
              botActor: null,
            },
          ];
        },
        createPlannerRunner: okRunner,
      },
    );

    expect(code).toBe(0);
    expect(seenInFlightQueries[0]?.activeStates).toEqual([
      ...DEFAULT_MANAGER_PLAN_IN_FLIGHT_STATES,
    ]);
    expect(fetchedCommentsFor).toEqual(["u1"]);
    expect(out()).toContain("- MOB-2 (In Progress)");
    expect(out()).toContain("comments:");
    expect(out()).toContain("Parked decision");
  });

  it("--planner-grounding enriches the prompt after comments without invoking mutation (SYMPH-1017 U4/U5)", async () => {
    const { io, out } = captureIo();
    const info = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const seenGroundingInputs: ManagerPlanGroundingInput[] = [];
    try {
      const code = await runManagerPlanCli(
        [
          "--team",
          "MOB",
          "--state",
          "Backlog",
          "--prompt-only",
          "--planner-grounding",
          "--planner-grounding-repo-url",
          "git@github.com:mobilyze-llc/symphony-ts.git",
          "--planner-grounding-commit",
          "abc123",
          "--planner-grounding-repo-scope",
          "symphony",
        ],
        {
          io,
          env: {},
          loadCandidates: async () => [
            issue("u1", "MOB-1", 1, {
              description: "Plan references src/agent/triage-planner.ts",
            }),
          ],
          fetchIssueComments: async () => [
            {
              id: "comment-1",
              body: "Closeout: src/agent/triage-planner.ts is complete.",
              createdAt: "2026-06-28T00:00:00.000Z",
              updatedAt: "2026-06-28T00:00:00.000Z",
              user: null,
              botActor: null,
            },
          ],
          groundPlannerContext: async (input) => {
            seenGroundingInputs.push(input);
            return {
              context: {
                ...input.context,
                backlog: input.context.backlog.map((candidate) => ({
                  ...candidate,
                  groundingEvidence: {
                    status: "grounded" as const,
                    reason: null,
                    digest: {
                      text: "Digest from ticket, comment, and referenced docs.",
                      status: "unverified" as const,
                      truncated: false,
                    },
                    claims: [
                      {
                        id: "claim-1",
                        kind: "path_symbol" as const,
                        text: "src/agent/triage-planner.ts",
                        summary: "Planner grounding renderer exists",
                        status: "verified" as const,
                        citations: [
                          {
                            path: "src/agent/triage-planner.ts",
                            lineRange: [1, 3] as const,
                            matchedSpan: "export function buildPlannerPrompt",
                          },
                        ],
                        missing: [],
                      },
                    ],
                    units: [],
                    warnings: [],
                    extractorCallCount: 1,
                    wallClockMs: 5,
                  },
                })),
              },
            };
          },
          createPlannerRunner: okRunner,
        },
      );

      expect(code).toBe(0);
      expect(seenGroundingInputs).toHaveLength(1);
      expect(
        seenGroundingInputs[0]?.context.backlog[0]?.comments?.[0]?.body,
      ).toContain("Closeout");
      expect(seenGroundingInputs[0]?.repoUrl).toBe(
        "git@github.com:mobilyze-llc/symphony-ts.git",
      );
      expect(seenGroundingInputs[0]?.commitSha).toBe("abc123");
      expect(out()).toContain("grounding evidence (report-only");
      expect(out()).toContain("[verified] Planner grounding renderer exists");
    } finally {
      info.mockRestore();
    }
  });

  it("--gh-pr-context includes gh-sourced open and recently merged PRs in the planner prompt (SYMPH-838)", async () => {
    const { io, out } = captureIo();
    const code = await runManagerPlanCli(
      [
        "--team",
        "MOB",
        "--state",
        "Backlog",
        "--prompt-only",
        "--gh-pr-context",
        "--github-repo",
        "mobilyze-llc/symphony-ts",
      ],
      {
        io,
        env: {},
        loadCandidates: async () => [issue("u1", "MOB-1")],
        loadPrContext: async (query) => {
          expect(query.repo).toBe("mobilyze-llc/symphony-ts");
          return {
            openPrs: [
              { issueIdentifier: "MOB-9", prNumber: 99, title: "Open PR" },
            ],
            recentlyMerged: [
              {
                issueIdentifier: "MOB-8",
                prNumber: 98,
                title: "Merged PR",
              },
            ],
          };
        },
        createPlannerRunner: okRunner,
      },
    );

    expect(code).toBe(0);
    expect(out()).toContain("## Open PRs");
    expect(out()).toContain("- MOB-9 #99 Open PR");
    expect(out()).toContain("## Recently merged (context)");
    expect(out()).toContain("- MOB-8 #98 Merged PR");
  });

  it("--gh-pr-context requires a repo slug from flag or environment (SYMPH-838)", async () => {
    const { io, err } = captureIo();
    const code = await runManagerPlanCli(
      ["--team", "MOB", "--state", "Backlog", "--gh-pr-context"],
      {
        io,
        env: {},
        loadCandidates: async () => [issue("u1", "MOB-1")],
        createPlannerRunner: okRunner,
      },
    );

    expect(code).toBe(1);
    expect(err()).toContain("--gh-pr-context requires");
  });

  it("prefers runtime-state in-flight over the Linear state fallback (SYMPH-961)", async () => {
    const { io, out } = captureIo();
    const fallbackLoadInFlight = vi.fn(async () => [
      issue("linear", "MOB-LINEAR", 1, { state: "In Progress" }),
    ]);
    const runtimeLoadInFlight = vi.fn(async () => [
      { issueIdentifier: "MOB-RUNTIME", stage: "Resume" },
    ]);

    const code = await runManagerPlanCli(
      [
        "--team",
        "MOB",
        "--state",
        "Backlog",
        "--runtime-state-base-url",
        "http://127.0.0.1:4321/",
        "--prompt-only",
      ],
      {
        io,
        env: {},
        loadCandidates: async () => [issue("u1", "MOB-1")],
        loadInFlight: fallbackLoadInFlight,
        loadRuntimeInFlight: runtimeLoadInFlight,
        createPlannerRunner: okRunner,
      },
    );

    expect(code).toBe(0);
    expect(runtimeLoadInFlight).toHaveBeenCalledWith("http://127.0.0.1:4321/");
    expect(fallbackLoadInFlight).not.toHaveBeenCalled();
    expect(out()).toContain("- MOB-RUNTIME (Resume)");
    expect(out()).not.toContain("MOB-LINEAR");
  });

  it("uses the runtime-state env override before the Linear state fallback (SYMPH-961)", async () => {
    const { io, out } = captureIo();
    const fallbackLoadInFlight = vi.fn(async () => [
      issue("linear", "MOB-LINEAR", 1, { state: "In Progress" }),
    ]);

    const code = await runManagerPlanCli(
      ["--team", "MOB", "--state", "Backlog", "--prompt-only"],
      {
        io,
        env: {
          [MANAGER_PLAN_RUNTIME_STATE_BASE_URL_ENV]: "http://127.0.0.1:4321",
        },
        loadCandidates: async () => [issue("u1", "MOB-1")],
        loadInFlight: fallbackLoadInFlight,
        loadRuntimeInFlight: async () => [
          { issueIdentifier: "MOB-RUNTIME", stage: "In Review" },
        ],
        createPlannerRunner: okRunner,
      },
    );

    expect(code).toBe(0);
    expect(fallbackLoadInFlight).not.toHaveBeenCalled();
    expect(out()).toContain("- MOB-RUNTIME (In Review)");
    expect(out()).not.toContain("MOB-LINEAR");
  });

  it("loads runtime-state in-flight with an abortable fetch (SYMPH-961)", async () => {
    const { io, out } = captureIo();
    const originalFetch = globalThis.fetch;
    const fetchMock = vi.fn(
      async (_input: Parameters<typeof fetch>[0], _init?: RequestInit) => {
        return new Response(
          JSON.stringify({
            running: [{ issue_identifier: "MOB-RUNTIME", state: "Resume" }],
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      },
    );
    globalThis.fetch = fetchMock as typeof fetch;

    try {
      const code = await runManagerPlanCli(
        [
          "--team",
          "MOB",
          "--state",
          "Backlog",
          "--runtime-state-base-url",
          "http://127.0.0.1:4321",
          "--prompt-only",
        ],
        {
          io,
          env: {},
          loadCandidates: async () => [issue("u1", "MOB-1")],
          createPlannerRunner: okRunner,
        },
      );

      expect(code).toBe(0);
      expect(fetchMock).toHaveBeenCalledWith(
        "http://127.0.0.1:4321/api/v1/state",
        expect.objectContaining({ headers: { accept: "application/json" } }),
      );
      const init = fetchMock.mock.calls[0]?.[1] as RequestInit | undefined;
      expect(init?.signal).toBeInstanceOf(AbortSignal);
      expect(out()).toContain("- MOB-RUNTIME (Resume)");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("--no-comment-enrichment does not fetch issue comments (SYMPH-961)", async () => {
    const { io, out } = captureIo();
    const fetchIssueComments = vi.fn(async () => [
      {
        id: "comment-1",
        body: "This comment must not be fetched.",
        createdAt: "2026-06-28T00:00:00.000Z",
        updatedAt: "2026-06-28T00:00:00.000Z",
        user: null,
        botActor: null,
      },
    ]);

    const code = await runManagerPlanCli(
      [
        "--team",
        "MOB",
        "--state",
        "Backlog",
        "--prompt-only",
        "--no-comment-enrichment",
      ],
      {
        io,
        env: {},
        loadCandidates: async () => [issue("u1", "MOB-1")],
        fetchIssueComments,
        createPlannerRunner: okRunner,
      },
    );

    expect(code).toBe(0);
    expect(fetchIssueComments).not.toHaveBeenCalled();
    expect(out()).toContain("MOB-1");
    expect(out()).not.toContain("This comment must not be fetched.");
  });

  it("prints the suggested batches on a good plan and invokes the planner once", async () => {
    const { io, out } = captureIo();
    const prompts: string[] = [];
    const code = await runManagerPlanCli(
      ["--team", "MOB", "--state", "Backlog"],
      {
        io,
        env: {},
        loadCandidates: async () => [issue("u1", "MOB-1")],
        createPlannerRunner: () => async (prompt: string) => {
          prompts.push(prompt);
          return { status: "ok", markdown: GOOD_ARTIFACT };
        },
      },
    );
    expect(code).toBe(0);
    expect(prompts).toHaveLength(1);
    expect(out()).toContain("MOB-1");
    expect(out().toLowerCase()).toContain("batch");
  });

  it("renders structural advisories as preview-only and never journals them", async () => {
    const { io, out } = captureIo();
    const outDir = await mkdtemp(join(tmpdir(), "manager-plan-advisory-"));
    const persistPlanRevision = vi.fn<
      NonNullable<ManagerPlanCliDependencies["persistPlanRevision"]>
    >(async (_workspaceRoot, body, options) => ({
      recorded: true,
      plan: {
        planId: options.planId ?? "plan-1",
        revision: 1,
        contentHash: "hash",
        envelope: body.envelope,
        batches: body.batches,
        dependencyEdges: body.dependencyEdges,
        options: body.options,
        rationale: body.rationale,
        createdAt: options.createdAt,
        updatedAt: options.createdAt,
      },
    }));
    try {
      const code = await runManagerPlanCli(
        [
          "--team",
          "MOB",
          "--state",
          "Backlog",
          "--out-dir",
          outDir,
          "--persist",
        ],
        {
          io,
          env: {},
          loadCandidates: async () => [issue("u1", "MOB-1")],
          createPlannerRunner: () => async () => ({
            status: "ok",
            markdown: ADVISORY_ARTIFACT,
          }),
          persistPlanRevision,
        },
      );

      expect(code).toBe(0);
      expect(out()).toContain("preview only — not journaled by this command");
      expect(out()).toContain("Members: MOB-1, MOB-2");
      expect(
        persistPlanRevision.mock.calls[0]?.[1].structuralAdvisories,
      ).toBeUndefined();
    } finally {
      await rm(outDir, { recursive: true, force: true });
    }
  });

  it("journals emitted advisories as cli-session evidence by default when a run-journal root exists (SYMPH-1140)", async () => {
    const { io, out } = captureIo();
    const root = await mkdtemp(join(tmpdir(), "manager-plan-journal-"));
    await mkdir(join(root, ".symphony", "run-journals"), { recursive: true });
    const journalStructuralAdvisories = vi.fn<
      NonNullable<ManagerPlanCliDependencies["journalStructuralAdvisories"]>
    >(async () => ({
      appended: [{} as never],
      skipped: [],
      invalidAdvisoryCount: 0,
    }));
    try {
      const code = await runManagerPlanCli(
        ["--team", "MOB", "--state", "Backlog"],
        {
          io,
          env: {},
          cwd: root,
          loadCandidates: async () => [
            issue("u1", "MOB-1"),
            issue("u2", "MOB-2"),
          ],
          createPlannerRunner: () => async () => ({
            status: "ok",
            markdown: ADVISORY_ARTIFACT,
          }),
          journalStructuralAdvisories,
        },
      );
      expect(code).toBe(0);
      expect(journalStructuralAdvisories).toHaveBeenCalledTimes(1);
      const call = journalStructuralAdvisories.mock.calls[0]?.[0];
      expect(call?.source).toBe("cli-session");
      expect(call?.root).toBe(root);
      expect(call?.advisories[0]?.memberIssueIdentifiers).toEqual([
        "MOB-1",
        "MOB-2",
      ]);
      expect(out()).toContain("journaled as cli-session evidence");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("skips an advisory containing a member outside the presented planner context (SYMPH-1140)", async () => {
    const { io, out } = captureIo();
    const root = await mkdtemp(join(tmpdir(), "manager-plan-invalid-member-"));
    try {
      const code = await runManagerPlanCli(
        [
          "--team",
          "MOB",
          "--state",
          "Backlog",
          "--journal",
          "--journal-root",
          root,
          "--json",
        ],
        {
          io,
          env: {},
          loadCandidates: async () => [issue("u1", "MOB-1")],
          createPlannerRunner: () => async () => ({
            status: "ok",
            markdown: ADVISORY_ARTIFACT,
          }),
        },
      );

      expect(code).toBe(0);
      expect(await readCalibrationJournal(root)).toEqual([]);
      expect(JSON.parse(out()).structuralAdvisoryJournal).toMatchObject({
        journaledCount: 0,
        skippedCount: 1,
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("--no-journal preserves preview-only even when a run-journal root exists (SYMPH-1140)", async () => {
    const { io, out } = captureIo();
    const root = await mkdtemp(join(tmpdir(), "manager-plan-nojournal-"));
    await mkdir(join(root, ".symphony", "run-journals"), { recursive: true });
    const journalStructuralAdvisories = vi.fn();
    try {
      const code = await runManagerPlanCli(
        ["--team", "MOB", "--state", "Backlog", "--no-journal", "--json"],
        {
          io,
          env: {},
          cwd: root,
          loadCandidates: async () => [issue("u1", "MOB-1")],
          createPlannerRunner: () => async () => ({
            status: "ok",
            markdown: ADVISORY_ARTIFACT,
          }),
          journalStructuralAdvisories,
        },
      );
      expect(code).toBe(0);
      expect(journalStructuralAdvisories).not.toHaveBeenCalled();
      expect(JSON.parse(out()).structuralAdvisoryDisposition).toBe(
        "preview_only_not_journaled",
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("--journal forces journaling even when no run-journal root exists yet (SYMPH-1140)", async () => {
    const { io } = captureIo();
    const root = await mkdtemp(join(tmpdir(), "manager-plan-forcejournal-"));
    const journalStructuralAdvisories = vi.fn<
      NonNullable<ManagerPlanCliDependencies["journalStructuralAdvisories"]>
    >(async () => ({
      appended: [{} as never],
      skipped: [],
      invalidAdvisoryCount: 0,
    }));
    try {
      const code = await runManagerPlanCli(
        [
          "--team",
          "MOB",
          "--state",
          "Backlog",
          "--journal",
          "--journal-root",
          root,
        ],
        {
          io,
          env: {},
          loadCandidates: async () => [
            issue("u1", "MOB-1"),
            issue("u2", "MOB-2"),
          ],
          createPlannerRunner: () => async () => ({
            status: "ok",
            markdown: ADVISORY_ARTIFACT,
          }),
          journalStructuralAdvisories,
        },
      );
      expect(code).toBe(0);
      expect(journalStructuralAdvisories).toHaveBeenCalledTimes(1);
      expect(journalStructuralAdvisories.mock.calls[0]?.[0].root).toBe(root);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("does not persist by default and persists only with --persist (SYMPH-838)", async () => {
    const { io, out } = captureIo();
    const outDir = await mkdtemp(join(tmpdir(), "manager-plan-persist-"));
    const persistPlanRevision = vi.fn<
      NonNullable<ManagerPlanCliDependencies["persistPlanRevision"]>
    >(async (_workspaceRoot, body, options) => ({
      recorded: true,
      plan: {
        planId: options.planId ?? "plan-1",
        revision: 1,
        contentHash: "hash",
        envelope: body.envelope,
        batches: body.batches,
        dependencyEdges: body.dependencyEdges,
        options: body.options,
        rationale: body.rationale,
        premises: body.premises ?? [],
        findings: options.findings ?? [],
        createdAt: options.createdAt,
        updatedAt: options.createdAt,
      },
    }));
    try {
      const previewCode = await runManagerPlanCli(
        ["--team", "MOB", "--state", "Backlog"],
        {
          io,
          env: {},
          loadCandidates: async () => [issue("u1", "MOB-1")],
          createPlannerRunner: okRunner,
          persistPlanRevision,
        },
      );
      expect(previewCode).toBe(0);
      expect(persistPlanRevision).not.toHaveBeenCalled();

      const persistCode = await runManagerPlanCli(
        [
          "--team",
          "MOB",
          "--state",
          "Backlog",
          "--out-dir",
          outDir,
          "--persist",
        ],
        {
          io,
          env: {},
          loadCandidates: async () => [issue("u1", "MOB-1")],
          createPlannerRunner: okRunner,
          persistPlanRevision,
          now: () => new Date("2026-06-30T13:15:03.000Z"),
        },
      );

      expect(persistCode).toBe(0);
      expect(persistPlanRevision).toHaveBeenCalledTimes(1);
      expect(persistPlanRevision.mock.calls[0]?.[0]).toBe(
        join(outDir, "manager-plan-store"),
      );
      expect(out()).toContain("Persisted revision 1");
    } finally {
      await rm(outDir, { recursive: true, force: true });
    }
  });

  it("persists tier-1 findings from the CLI without mutating the planned body", async () => {
    const { io } = captureIo();
    const outDir = await mkdtemp(join(tmpdir(), "manager-plan-tier1-"));
    const candidates = [issue("u1", "MOB-1", 2, { state: "Cancelled" })];
    const persistPlanRevision = vi.fn<
      NonNullable<ManagerPlanCliDependencies["persistPlanRevision"]>
    >(async (_workspaceRoot, body, options) => ({
      recorded: true,
      plan: {
        planId: options.planId ?? "plan-1",
        revision: 1,
        contentHash: "hash",
        envelope: body.envelope,
        batches: body.batches,
        dependencyEdges: body.dependencyEdges,
        options: body.options,
        rationale: body.rationale,
        premises: body.premises ?? [],
        findings: options.findings ?? [],
        createdAt: options.createdAt,
        updatedAt: options.createdAt,
      },
    }));

    try {
      const expectedContext = assembleShadowPlannerContext({
        candidates,
        inFlight: [],
        envelope: {
          version: 1,
          concurrencyCeiling: 3,
          allowedRisk: "medium",
          allowedModes: ["parallel-isolated", "canary-chain"],
        },
      });
      const expected = await runTriagePlanner(expectedContext, {
        runClaude: okRunner(),
      });
      expect(expected.status).toBe("ok");
      if (expected.status !== "ok") {
        throw new Error("expected ok planner result");
      }

      const code = await runManagerPlanCli(
        [
          "--team",
          "MOB",
          "--state",
          "Cancelled",
          "--out-dir",
          outDir,
          "--persist",
          "--no-comment-enrichment",
        ],
        {
          io,
          env: {},
          loadCandidates: async () => candidates,
          loadInFlight: async () => [],
          createPlannerRunner: okRunner,
          persistPlanRevision,
          now: () => new Date("2026-06-30T13:15:03.000Z"),
        },
      );

      expect(code).toBe(0);
      const { structuralAdvisories: _previewOnly, ...expectedPersistedBody } =
        expected.body;
      expect(JSON.stringify(persistPlanRevision.mock.calls[0]?.[1])).toBe(
        JSON.stringify(expectedPersistedBody),
      );
      expect(persistPlanRevision.mock.calls[0]?.[2].findings).toEqual([
        {
          title: "Scheduled ineligible candidate MOB-1 (Cancelled)",
          planAnchor: `${expected.body.batches[0]?.batchId}:MOB-1`,
          severity: "P2",
        },
      ]);
    } finally {
      await rm(outDir, { recursive: true, force: true });
    }
  });

  it("persists report-only tier-2 review records from the CLI hook", async () => {
    const { io } = captureIo();
    const outDir = await mkdtemp(join(tmpdir(), "manager-plan-tier2-"));
    const tier2Record: PlanReviewRecord = {
      tier: "tier-2",
      status: "reviewed",
      diffHash: "plan-content-hash",
      gateReason: "no_baseline",
      aggregateVerdict: "pass",
      note: null,
      reviewedGroundingEvidence: [
        {
          issueId: "u1",
          issueIdentifier: "MOB-1",
          status: "grounded",
          renderedHash: "rendered-hash",
          renderedChars: 12,
          claimIds: ["claim-1"],
          unitIds: ["unit-1"],
          warnings: [],
        },
      ],
      findingFingerprints: [],
      postHocEntries: [],
    };
    const persistPlanRevision = vi.fn<
      NonNullable<ManagerPlanCliDependencies["persistPlanRevision"]>
    >(async (_workspaceRoot, body, options) => ({
      recorded: true,
      plan: {
        planId: options.planId ?? "plan-1",
        revision: 1,
        contentHash: "hash",
        envelope: body.envelope,
        batches: body.batches,
        dependencyEdges: body.dependencyEdges,
        options: body.options,
        rationale: body.rationale,
        premises: body.premises ?? [],
        findings: options.findings ?? [],
        reviewRecords: options.reviewRecords ?? [],
        createdAt: options.createdAt,
        updatedAt: options.createdAt,
      },
    }));
    const postEmitReview = vi.fn<
      NonNullable<ManagerPlanCliDependencies["runPlanPostEmitReview"]>
    >(async (deps) => {
      expect(deps.tier2).toMatchObject({
        enabled: true,
        artifactDir: outDir,
        workspace: process.cwd(),
        plannerGroundingEnabled: true,
      });
      return {
        findings: [],
        reviewRecords: [tier2Record],
      };
    });

    try {
      const code = await runManagerPlanCli(
        [
          "--team",
          "MOB",
          "--state",
          "Backlog",
          "--out-dir",
          outDir,
          "--persist",
          "--planner-grounding",
        ],
        {
          io,
          env: {},
          loadCandidates: async () => [issue("u1", "MOB-1")],
          createPlannerRunner: okRunner,
          groundPlannerContext: async ({ context }) => ({ context }),
          persistPlanRevision,
          runPlanPostEmitReview: postEmitReview,
          now: () => new Date("2026-06-30T13:15:03.000Z"),
        },
      );

      expect(code).toBe(0);
      expect(postEmitReview).toHaveBeenCalledTimes(1);
      expect(persistPlanRevision.mock.calls[0]?.[2].reviewRecords).toEqual([
        tier2Record,
      ]);
    } finally {
      await rm(outDir, { recursive: true, force: true });
    }
  });

  it("rejects --persist with --prompt-only because no plan revision exists (SYMPH-838)", async () => {
    const { io, err } = captureIo();
    const code = await runManagerPlanCli(
      ["--team", "MOB", "--prompt-only", "--persist"],
      {
        io,
        env: {},
        loadCandidates: async () => [issue("u1", "MOB-1")],
        createPlannerRunner: okRunner,
      },
    );

    expect(code).toBe(1);
    expect(err()).toContain("--persist cannot be combined");
  });

  it("renders execution waves from the plan's dependency edges (SYMPH-843)", async () => {
    const { io, out } = captureIo();
    const artifactWithDeps = `# Plan\n\`\`\`json\n${JSON.stringify({
      rationale: "go",
      batches: [
        {
          mode: "parallel-isolated",
          issueIdentifiers: ["MOB-1", "MOB-2"],
          rationale: "r",
        },
      ],
      dependencies: [{ issueIdentifier: "MOB-2", dependsOn: ["MOB-1"] }],
    })}\n\`\`\`\n`;
    const code = await runManagerPlanCli(
      ["--team", "MOB", "--state", "Backlog"],
      {
        io,
        env: {},
        loadCandidates: async () => [
          issue("u1", "MOB-1"),
          issue("u2", "MOB-2"),
        ],
        createPlannerRunner: () => async () => ({
          status: "ok",
          markdown: artifactWithDeps,
        }),
      },
    );
    expect(code).toBe(0);
    expect(out()).toContain("Execution waves");
    expect(out()).toContain("Wave 1: MOB-1");
    expect(out()).toContain("waits on MOB-1");
  });

  it("--no-canary drops canary-chain from the allowed modes (SYMPH-838)", async () => {
    const { io, out } = captureIo();
    const code = await runManagerPlanCli(
      ["--team", "MOB", "--state", "Backlog", "--no-canary", "--prompt-only"],
      {
        io,
        env: {},
        loadCandidates: async () => [issue("u1", "MOB-1")],
        createPlannerRunner: okRunner,
      },
    );
    expect(code).toBe(0);
    expect(out()).toContain("allowed modes: parallel-isolated\n");
  });

  it("errors when --no-canary empties the allowed modes (--modes canary-chain --no-canary) (SYMPH-838)", async () => {
    const { io } = captureIo();
    const code = await runManagerPlanCli(
      [
        "--team",
        "MOB",
        "--state",
        "Backlog",
        "--modes",
        "canary-chain",
        "--no-canary",
        "--prompt-only",
      ],
      {
        io,
        env: {},
        loadCandidates: async () => [issue("u1", "MOB-1")],
        createPlannerRunner: okRunner,
      },
    );
    expect(code).toBe(1);
  });

  it("passes the team and eligible states through to the candidate loader", async () => {
    const { io } = captureIo();
    const seen: Array<{ teamKeys?: string[]; activeStates: string[] }> = [];
    await runManagerPlanCli(
      [
        "--team",
        "MOB",
        "--state",
        "Backlog",
        "--state",
        "Todo",
        "--prompt-only",
      ],
      {
        io,
        env: {},
        loadCandidates: async (input) => {
          seen.push({
            teamKeys: input.teamKeys,
            activeStates: input.activeStates,
          });
          return [issue("u1", "MOB-1")];
        },
        createPlannerRunner: okRunner,
      },
    );
    expect(seen[0]?.teamKeys).toEqual(["MOB"]);
    expect(seen[0]?.activeStates).toEqual(["Backlog", "Todo"]);
  });

  it("emits machine JSON with --json", async () => {
    const { io, out } = captureIo();
    const code = await runManagerPlanCli(
      ["--team", "MOB", "--state", "Backlog", "--json"],
      {
        io,
        env: {},
        loadCandidates: async () => [issue("u1", "MOB-1")],
        createPlannerRunner: okRunner,
      },
    );
    expect(code).toBe(0);
    const parsed = JSON.parse(out());
    expect(parsed).toMatchObject({
      plannerModel: "opus",
      plannerEffort: "max",
    });
    expect(parsed.batches[0].members[0].issueIdentifier).toBe("MOB-1");
    expect(parsed.structuralAdvisoryDisposition).toBe(
      "preview_only_not_journaled",
    );
  });

  it("emits the normalized advisory preview payload with --json", async () => {
    const { io, out } = captureIo();
    const code = await runManagerPlanCli(
      ["--team", "MOB", "--state", "Backlog", "--json"],
      {
        io,
        env: {},
        loadCandidates: async () => [issue("u1", "MOB-1")],
        createPlannerRunner: () => async () => ({
          status: "ok",
          markdown: ADVISORY_ARTIFACT,
        }),
      },
    );

    expect(code).toBe(0);
    expect(JSON.parse(out())).toMatchObject({
      structuralAdvisoryDisposition: "preview_only_not_journaled",
      structuralAdvisories: [
        {
          memberIssueIdentifiers: ["MOB-1", "MOB-2"],
          rootCauseHypothesis: "Shared root",
          structuralFix: "Centralize the fix",
          confidenceNote: "High",
        },
      ],
    });
  });

  it("keeps --json machine output parseable when planner grounding emits telemetry", async () => {
    const { io, out } = captureIo();
    const telemetry = vi
      .spyOn(console, "error")
      .mockImplementation(() => undefined);
    try {
      const code = await runManagerPlanCli(
        [
          "--team",
          "MOB",
          "--state",
          "Backlog",
          "--json",
          "--planner-grounding",
        ],
        {
          io,
          env: {},
          loadCandidates: async () => [issue("u1", "MOB-1")],
          groundPlannerContext: async (input) => ({
            context: {
              ...input.context,
              backlog: input.context.backlog.map((candidate) => ({
                ...candidate,
                groundingEvidence: {
                  status: "grounded" as const,
                  reason: null,
                  digest: {
                    text: "Grounding telemetry should not corrupt JSON stdout.",
                    status: "unverified" as const,
                    truncated: false,
                  },
                  claims: [],
                  units: [],
                  warnings: [],
                  extractorCallCount: 1,
                  wallClockMs: 3,
                },
              })),
            },
          }),
          createPlannerRunner: okRunner,
        },
      );

      expect(code).toBe(0);
      const parsed = JSON.parse(out());
      expect(parsed.batches[0].members[0].issueIdentifier).toBe("MOB-1");
      expect(telemetry).toHaveBeenCalledWith(
        expect.stringContaining("planner grounding telemetry"),
      );
    } finally {
      telemetry.mockRestore();
    }
  });

  it("emits project and initiative scope in --json output (SYMPH-858)", async () => {
    const { io, out } = captureIo();
    const code = await runManagerPlanCli(
      [
        "--project",
        "abc123",
        "--initiative",
        "Healthspanners",
        "--state",
        "Backlog",
        "--json",
      ],
      {
        io,
        env: {},
        loadCandidates: async () => [issue("u1", "MOB-1")],
        createPlannerRunner: okRunner,
      },
    );
    expect(code).toBe(0);
    const parsed = JSON.parse(out());
    expect(parsed.project).toBe("abc123");
    expect(parsed.initiative).toBe("Healthspanners");
    expect(parsed.team).toBeNull();
  });

  it("describes the active scope in the no-candidates message (SYMPH-858)", async () => {
    const { io, out } = captureIo();
    const code = await runManagerPlanCli(
      ["--project", "abc123", "--state", "Backlog"],
      {
        io,
        env: {},
        loadCandidates: async () => [],
        createPlannerRunner: okRunner,
      },
    );
    expect(code).toBe(0);
    expect(out()).toContain("project abc123");
    expect(out()).not.toContain("team");
  });

  it("prunes candidates superseded by completed Linear relations before manager planning (SYMPH-1014)", async () => {
    const { io, out } = captureIo();
    const prompts: string[] = [];
    const code = await runManagerPlanCli(
      ["--team", "MOB", "--state", "Backlog", "--json"],
      {
        io,
        env: {},
        loadCandidates: async () => [
          issue("u1", "MOB-1", 2, {
            supersededBy: [
              {
                id: "u3",
                identifier: "MOB-3",
                state: "Done",
                title: "Completed replacement",
              },
            ],
          }),
          issue("u2", "MOB-2"),
        ],
        createPlannerRunner: () => async (prompt: string) => {
          prompts.push(prompt);
          return {
            status: "ok",
            markdown:
              '# Plan\n```json\n{"rationale":"go","batches":[{"mode":"parallel-isolated","issueIdentifiers":["MOB-2"],"rationale":"surviving candidate"}]}\n```\n',
          };
        },
      },
    );

    expect(code).toBe(0);
    expect(prompts).toHaveLength(1);
    expect(prompts[0]).not.toContain("MOB-1");
    expect(prompts[0]).toContain("MOB-2");
    const parsed = JSON.parse(out());
    expect(parsed.candidateCount).toBe(1);
    expect(parsed.batches[0].members[0].issueIdentifier).toBe("MOB-2");
  });

  it("excludes portfolio-held candidates from manager planning JSON", async () => {
    const taxonomyProject = PORTFOLIO_TAXONOMY_PROJECTS.find(
      (project) =>
        project.name === "Portfolio Taxonomy & Agent Workflow Tooling",
    )!;
    const { io, out } = captureIo();
    const prompts: string[] = [];
    const code = await runManagerPlanCli(
      ["--team", "MOB", "--state", "Backlog", "--json"],
      {
        io,
        env: {},
        loadCandidates: async () => [
          issue("u1", "MOB-1", 2, {
            teamKey: "MOB",
            projectId: taxonomyProject.id,
            projectSlug: taxonomyProject.slugId,
            projectName: taxonomyProject.name,
          }),
          issue("u2", "MOB-2", 2, {
            teamKey: "MOB",
            projectId: null,
            projectSlug: null,
            projectName: null,
          }),
        ],
        createPlannerRunner: () => async (prompt: string) => {
          prompts.push(prompt);
          return {
            status: "ok",
            markdown: GOOD_ARTIFACT,
          };
        },
      },
    );
    expect(code).toBe(0);
    expect(prompts).toHaveLength(1);
    expect(prompts[0]).toContain("MOB-1");
    expect(prompts[0]).not.toContain("MOB-2");
    const parsed = JSON.parse(out());
    expect(parsed.candidateCount).toBe(1);
    expect(parsed.portfolioHeldCount).toBe(1);
  });

  it("returns 3 and a message when the planner is unavailable", async () => {
    const { io, err } = captureIo();
    const code = await runManagerPlanCli(
      ["--team", "MOB", "--state", "Backlog"],
      {
        io,
        env: {},
        loadCandidates: async () => [issue("u1", "MOB-1")],
        createPlannerRunner: () => async () => ({
          status: "unavailable",
          detail: "cmux down",
        }),
      },
    );
    expect(code).toBe(3);
    expect(err().toLowerCase()).toContain("unavailable");
  });

  it("returns 4 and a message when the plan is invalid", async () => {
    const { io, err } = captureIo();
    const code = await runManagerPlanCli(
      ["--team", "MOB", "--state", "Backlog"],
      {
        io,
        env: {},
        loadCandidates: async () => [issue("u1", "MOB-1")],
        createPlannerRunner: () => async () => ({
          status: "ok",
          markdown: "# Plan\n\nno json here\n",
        }),
      },
    );
    expect(code).toBe(4);
    expect(err().toLowerCase()).toContain("invalid");
  });

  it("exits 0 with a hint and no planner call when the backlog is empty", async () => {
    const { io, out } = captureIo();
    let plannerCalls = 0;
    const code = await runManagerPlanCli(
      ["--team", "MOB", "--state", "Backlog"],
      {
        io,
        env: {},
        loadCandidates: async () => [],
        createPlannerRunner: () => async () => {
          plannerCalls += 1;
          return { status: "ok", markdown: GOOD_ARTIFACT };
        },
      },
    );
    expect(code).toBe(0);
    expect(plannerCalls).toBe(0);
    expect(out().toLowerCase()).toContain("no eligible");
  });

  it("requires LINEAR_API_KEY when no candidate loader is injected", async () => {
    const { io, err } = captureIo();
    const code = await runManagerPlanCli(
      ["--team", "MOB", "--state", "Backlog"],
      {
        io,
        env: {},
      },
    );
    expect(code).toBe(1);
    expect(err()).toContain("LINEAR_API_KEY");
  });
});
