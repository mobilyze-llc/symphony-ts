import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it, vi } from "vitest";

import type { PlannerRunResult } from "../../src/agent/triage-planner.js";
import {
  DEFAULT_MANAGER_PLAN_IN_FLIGHT_STATES,
  MANAGER_PLAN_RUNTIME_STATE_BASE_URL_ENV,
  type ManagerPlanCandidateQuery,
  type ManagerPlanCliDependencies,
  ManagerPlanCliUsageError,
  type ManagerPlanGroundingInput,
  inferManagerPlanGroundingRepoScope,
  parseManagerPlanCliArgs,
  runManagerPlanCli,
  toPlannerCandidateGroundingEvidence,
} from "../../src/cli/manager-plan.js";
import type { Issue } from "../../src/domain/model.js";
import {
  GROUNDING_EXTRACTOR_ROUTE,
  type GroundingExtractionResult,
} from "../../src/orchestrator/grounding-extractor.js";
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
      "--prompt-only",
      "--json",
    ]);
    expect(opts.team).toBe("MOB");
    expect(opts.states).toEqual(["Backlog", "Todo"]);
    expect(opts.concurrencyCeiling).toBe(5);
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

  it("does not persist by default and persists only with --persist (SYMPH-838)", async () => {
    const { io, out } = captureIo();
    const outDir = await mkdtemp(join(tmpdir(), "manager-plan-persist-"));
    const persistPlanRevision = vi.fn<
      NonNullable<ManagerPlanCliDependencies["persistPlanRevision"]>
    >(async (_workspaceRoot, body, options) => ({
      recorded: true,
      plan: {
        planId: options.planId,
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
    expect(parsed.batches[0].members[0].issueIdentifier).toBe("MOB-1");
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
