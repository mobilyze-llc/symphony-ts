import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it, vi } from "vitest";

import type { PlannerRunResult } from "../../src/agent/triage-planner.js";
import {
  DEFAULT_MANAGER_PLAN_IN_FLIGHT_STATES,
  MANAGER_PLAN_RUNTIME_STATE_BASE_URL_ENV,
  type ManagerPlanCandidateQuery,
  ManagerPlanCliUsageError,
  parseManagerPlanCliArgs,
  runManagerPlanCli,
} from "../../src/cli/manager-plan.js";
import type { Issue } from "../../src/domain/model.js";
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
