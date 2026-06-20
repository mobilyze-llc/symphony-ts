import { describe, expect, it } from "vitest";

import type { PlannerRunResult } from "../../src/agent/triage-planner.js";
import {
  ManagerPlanCliUsageError,
  parseManagerPlanCliArgs,
  runManagerPlanCli,
} from "../../src/cli/manager-plan.js";
import type { Issue } from "../../src/domain/model.js";

function issue(id: string, identifier: string, priority = 2): Issue {
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
  it("errors when --team is missing", async () => {
    const { io, err } = captureIo();
    const code = await runManagerPlanCli(["--state", "Backlog"], {
      io,
      env: {},
      loadCandidates: async () => [],
      createPlannerRunner: okRunner,
    });
    expect(code).toBe(1);
    expect(err()).toMatch(/--team/);
  });

  it("errors when --state is missing", async () => {
    const { io, err } = captureIo();
    const code = await runManagerPlanCli(["--team", "MOB"], {
      io,
      env: {},
      loadCandidates: async () => [],
      createPlannerRunner: okRunner,
    });
    expect(code).toBe(1);
    expect(err()).toMatch(/--state/);
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
