import { describe, expect, it } from "vitest";

import {
  type PlannerContext,
  type PlannerRunResult,
  buildPlanBody,
  buildPlannerPrompt,
  createCmuxPlannerRunner,
  parsePlannerOutput,
  runTriagePlanner,
} from "../../src/agent/triage-planner.js";
import type { ClaudeRunnerResult } from "../../src/claude-runner/cmux-claude-runner.js";
import type { PlanEnvelope } from "../../src/domain/standing-plan.js";

const ENVELOPE: PlanEnvelope = {
  version: 1,
  concurrencyCeiling: 3,
  allowedRisk: "medium",
  allowedModes: ["parallel-isolated", "canary-chain"],
};

function context(): PlannerContext {
  return {
    backlog: [
      {
        issueId: "u-1",
        issueIdentifier: "SYMPH-1",
        title: "First",
        priority: 1,
        state: "Todo",
        blockedBy: [],
      },
      {
        issueId: "u-2",
        issueIdentifier: "SYMPH-2",
        title: "Second",
        priority: 2,
        state: "Todo",
        blockedBy: [],
      },
    ],
    openPrs: [{ issueIdentifier: "SYMPH-9", prNumber: 42, title: "WIP" }],
    recentlyMerged: [
      { issueIdentifier: "SYMPH-8", prNumber: 41, title: "Done" },
    ],
    inFlight: [{ issueIdentifier: "SYMPH-7", stage: "implement" }],
    envelope: ENVELOPE,
  };
}

function artifact(jsonBody: unknown): string {
  return `# Plan\n\nSome reasoning.\n\n\`\`\`json\n${JSON.stringify(
    jsonBody,
    null,
    2,
  )}\n\`\`\`\n`;
}

describe("buildPlannerPrompt", () => {
  it("includes backlog, envelope constraints, context, and the JSON output contract", () => {
    const prompt = buildPlannerPrompt(context());
    expect(prompt).toContain("SYMPH-1");
    expect(prompt).toContain("SYMPH-2");
    expect(prompt).toContain("parallel-isolated");
    expect(prompt).toContain("canary-chain");
    // shared-surface is out of the envelope -> must be presented as disallowed
    expect(prompt).not.toMatch(/allowed modes:.*shared-surface/i);
    expect(prompt).toContain("3"); // concurrency ceiling
    expect(prompt).toContain("SYMPH-7"); // in-flight
    expect(prompt).toContain("SYMPH-8"); // recently merged
    expect(prompt).toContain("SYMPH-9"); // open PR
    expect(prompt.toLowerCase()).toContain("json");
  });

  it("shows the exact canary object key names in the emitted example (SYMPH-836)", () => {
    const prompt = buildPlannerPrompt(context());
    // The model must be SHOWN the schema keys, not merely told "head + contingent"
    // — otherwise it emits {head, contingent} and the whole plan is rejected.
    expect(prompt).toContain("headIssueIdentifiers");
    expect(prompt).toContain("contingentIssueIdentifiers");
  });

  it("renders recorded blockedBy on the candidate line (SYMPH-841)", () => {
    const ctx = context();
    const first = ctx.backlog[0];
    if (first) {
      first.blockedBy = ["SYMPH-2"];
    }
    const prompt = buildPlannerPrompt(ctx);
    expect(prompt).toContain("(blocked by: SYMPH-2)");
  });

  it("asks the model to emit cross-batch dependencies (SYMPH-843)", () => {
    const prompt = buildPlannerPrompt(context());
    expect(prompt).toContain("dependencies");
    expect(prompt).toContain("dependsOn");
  });

  it("renders labels and the issue description on the candidate (SYMPH-874)", () => {
    const ctx = context();
    const first = ctx.backlog[0];
    if (first) {
      first.labels = ["area:scheduling", "kind:bug"];
      first.description =
        "Reworks the dispatch loop in src/orchestrator/core.ts.";
    }
    const prompt = buildPlannerPrompt(ctx);
    expect(prompt).toContain("(labels: area:scheduling, kind:bug)");
    expect(prompt).toContain(
      "\n    Reworks the dispatch loop in src/orchestrator/core.ts.",
    );
  });

  it("bounds an overlong description so the prompt cannot blow up (SYMPH-874)", () => {
    const ctx = context();
    const first = ctx.backlog[0];
    if (first) {
      first.description = `HEAD ${"x".repeat(5000)} TAILMARKER`;
    }
    const prompt = buildPlannerPrompt(ctx);
    expect(prompt).toContain("HEAD "); // the beginning of the body is rendered
    expect(prompt).not.toContain("TAILMARKER"); // content past the cap is dropped
  });

  it("omits the labels/description adornments when a candidate has neither (SYMPH-874)", () => {
    // context() candidates carry neither -> single-line rendering is unchanged.
    const prompt = buildPlannerPrompt(context());
    expect(prompt).not.toContain("(labels:");
    expect(prompt).toContain("] First\n- SYMPH-2");
  });
});

describe("parsePlannerOutput", () => {
  it("extracts and validates a fenced JSON plan", () => {
    const md = artifact({
      rationale: "top first",
      batches: [
        {
          mode: "parallel-isolated",
          issueIdentifiers: ["SYMPH-1"],
          rationale: "highest priority",
        },
      ],
    });
    const result = parsePlannerOutput(md);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.batches).toHaveLength(1);
    }
  });

  it("extracts an unfenced JSON plan embedded in prose", () => {
    const plan = {
      rationale: "top first",
      batches: [
        {
          mode: "parallel-isolated",
          issueIdentifiers: ["SYMPH-1"],
          rationale: "highest priority",
        },
      ],
    };
    const fenced = parsePlannerOutput(artifact(plan));
    const prose = parsePlannerOutput(
      `# Portfolio thesis\n\nA smaller aside: {"note":"not the plan"}\n\n${JSON.stringify(
        plan,
        null,
        2,
      )}\n\nDeferred: none.`,
    );

    expect(fenced.ok).toBe(true);
    expect(prose.ok).toBe(true);
    if (fenced.ok && prose.ok) {
      expect(prose.value).toEqual(fenced.value);
    }
  });

  it("fails when there is no JSON plan object", () => {
    const result = parsePlannerOutput("# Plan\n\nNo json here.\n");
    expect(result.ok).toBe(false);
  });

  it("fails when the JSON does not match the schema", () => {
    const result = parsePlannerOutput(artifact({ rationale: "x" }));
    expect(result.ok).toBe(false);
  });

  it("preserves a top-level dependencies field (SYMPH-843)", () => {
    const result = parsePlannerOutput(
      artifact({
        rationale: "x",
        batches: [
          {
            mode: "parallel-isolated",
            issueIdentifiers: ["SYMPH-1"],
            rationale: "a",
          },
        ],
        dependencies: [{ issueIdentifier: "SYMPH-1", dependsOn: ["SYMPH-2"] }],
      }),
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.dependencies).toEqual([
        { issueIdentifier: "SYMPH-1", dependsOn: ["SYMPH-2"] },
      ]);
    }
  });

  it("normalizes aliased canary keys (head/contingent) instead of rejecting the plan (SYMPH-836)", () => {
    // The exact MOB/Crucible failure: Opus emitted {head, contingent} rather than
    // the schema's {headIssueIdentifiers, contingentIssueIdentifiers}, which voided
    // the whole plan. Aliases must be coerced, not rejected.
    const result = parsePlannerOutput(
      artifact({
        rationale: "x",
        batches: [
          {
            mode: "canary-chain",
            issueIdentifiers: ["SYMPH-1", "SYMPH-2"],
            rationale: "chain with aliased canary keys",
            canary: { head: "SYMPH-1", contingent: ["SYMPH-2"] },
          },
        ],
      }),
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.batches[0]?.canary).toEqual({
        headIssueIdentifiers: ["SYMPH-1"],
        contingentIssueIdentifiers: ["SYMPH-2"],
      });
    }
  });

  it("tolerates a canary-chain with an empty head — drops the canary instead of voiding the plan (SYMPH-836)", () => {
    // Previously an empty head voided the WHOLE plan (a single bad canary lost
    // every batch). That contradicted buildPlanBody's own no-valid-head downgrade.
    // Now parse drops the unusable canary to null and the batch is downgraded to
    // honest parallel-isolated work downstream.
    const parsed = parsePlannerOutput(
      artifact({
        rationale: "x",
        batches: [
          {
            mode: "canary-chain",
            issueIdentifiers: ["SYMPH-1"],
            rationale: "empty head",
            canary: {
              headIssueIdentifiers: [],
              contingentIssueIdentifiers: ["SYMPH-1"],
            },
          },
        ],
      }),
    );
    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      expect(parsed.value.batches[0]?.canary).toBeNull();
      const body = buildPlanBody(parsed.value, context());
      expect(body.batches[0]?.mode).toBe("parallel-isolated");
      expect(body.batches[0]?.canary).toBeNull();
    }
  });
});

describe("buildPlanBody", () => {
  it("resolves identifiers, assigns batch ids + [opt-N] options + release intents", () => {
    const body = buildPlanBody(
      {
        rationale: "plan",
        batches: [
          {
            mode: "parallel-isolated",
            issueIdentifiers: ["SYMPH-1", "SYMPH-2"],
            rationale: "two together",
          },
        ],
      },
      context(),
    );
    expect(body.source).toBe("planner");
    expect(body.batches).toHaveLength(1);
    const batch = body.batches[0];
    expect(batch?.status).toBe("lookahead");
    expect(batch?.members).toEqual([
      { issueId: "u-1", issueIdentifier: "SYMPH-1" },
      { issueId: "u-2", issueIdentifier: "SYMPH-2" },
    ]);
    expect(body.options[0]?.marker).toBe("[opt-1]");
    expect(body.options[0]?.intent).toEqual({
      verb: "release_batch",
      batchId: batch?.batchId,
    });
  });

  it("drops unknown identifiers and skips a batch left with no members", () => {
    const body = buildPlanBody(
      {
        rationale: "plan",
        batches: [
          {
            mode: "parallel-isolated",
            issueIdentifiers: ["SYMPH-404"],
            rationale: "ghost",
          },
          {
            mode: "parallel-isolated",
            issueIdentifiers: ["SYMPH-1", "SYMPH-404"],
            rationale: "one real",
          },
        ],
      },
      context(),
    );
    expect(body.batches).toHaveLength(1);
    expect(body.batches[0]?.members).toEqual([
      { issueId: "u-1", issueIdentifier: "SYMPH-1" },
    ]);
  });

  it("drops a batch whose mode is outside the envelope", () => {
    const body = buildPlanBody(
      {
        rationale: "plan",
        batches: [
          {
            mode: "shared-surface",
            issueIdentifiers: ["SYMPH-1"],
            rationale: "not allowed yet",
          },
          {
            mode: "parallel-isolated",
            issueIdentifiers: ["SYMPH-2"],
            rationale: "ok",
          },
        ],
      },
      context(),
    );
    expect(body.batches.map((b) => b.mode)).toEqual(["parallel-isolated"]);
  });

  it("assigns content-derived batch ids: stable for identical content, distinct otherwise", () => {
    const raw = {
      rationale: "plan",
      batches: [
        {
          mode: "parallel-isolated" as const,
          issueIdentifiers: ["SYMPH-1"],
          rationale: "a",
        },
      ],
    };
    const a = buildPlanBody(raw, context());
    const b = buildPlanBody(raw, context());
    expect(a.batches[0]?.batchId).toBe(b.batches[0]?.batchId);
    expect(a.batches[0]?.batchId).toMatch(/^b-[0-9a-f]{12}$/);

    const other = buildPlanBody(
      {
        rationale: "plan",
        batches: [
          {
            mode: "parallel-isolated" as const,
            issueIdentifiers: ["SYMPH-2"],
            rationale: "b",
          },
        ],
      },
      context(),
    );
    expect(other.batches[0]?.batchId).not.toBe(a.batches[0]?.batchId);
  });

  it("filters canary identifiers to the batch's resolved members", () => {
    const body = buildPlanBody(
      {
        rationale: "plan",
        batches: [
          {
            mode: "canary-chain" as const,
            issueIdentifiers: ["SYMPH-1", "SYMPH-2"],
            rationale: "chain",
            canary: {
              headIssueIdentifiers: ["SYMPH-1", "SYMPH-404"],
              contingentIssueIdentifiers: ["SYMPH-2", "SYMPH-999"],
            },
          },
        ],
      },
      context(),
    );
    expect(body.batches[0]?.canary).toEqual({
      headIssueIdentifiers: ["SYMPH-1"],
      contingentIssueIdentifiers: ["SYMPH-2"],
    });
  });

  it("drops the canary AND downgrades the mode to parallel-isolated when no valid head survives (council R1, Codex P1)", () => {
    const body = buildPlanBody(
      {
        rationale: "plan",
        batches: [
          {
            mode: "canary-chain" as const,
            issueIdentifiers: ["SYMPH-1"],
            rationale: "chain",
            canary: {
              headIssueIdentifiers: ["SYMPH-404"],
              contingentIssueIdentifiers: ["SYMPH-1"],
            },
          },
        ],
      },
      context(),
    );
    // No valid head → canary dropped; the mode is downgraded so the batch is an
    // honest parallel-isolated batch, never an unexecutable "canary" with no
    // canary structure (which would bypass the contingent-release gate).
    expect(body.batches[0]?.canary).toBeNull();
    expect(body.batches[0]?.mode).toBe("parallel-isolated");
    expect(body.batches[0]?.members.map((m) => m.issueIdentifier)).toEqual([
      "SYMPH-1",
    ]);
  });

  it("drops a canary-chain batch that would downgrade to a mode outside the envelope (council R1, Codex)", () => {
    // canary-chain-only envelope: a batch with no usable canary must downgrade
    // to parallel-isolated, which is NOT allowed here — so it is dropped rather
    // than emitted with a mode outside the envelope.
    const body = buildPlanBody(
      {
        rationale: "plan",
        batches: [
          {
            mode: "canary-chain" as const,
            issueIdentifiers: ["SYMPH-1"],
            rationale: "no usable canary",
            canary: null,
          },
        ],
      },
      {
        ...context(),
        envelope: { ...ENVELOPE, allowedModes: ["canary-chain"] },
      },
    );
    expect(body.batches).toEqual([]);
  });

  it("resolves dependencyEdges from soft deps + recorded blockedBy + canary, members-only (SYMPH-843)", () => {
    const ctx: PlannerContext = {
      ...context(),
      backlog: [
        {
          issueId: "u-1",
          issueIdentifier: "SYMPH-1",
          title: "A",
          priority: 1,
          state: "Todo",
          blockedBy: [],
        },
        {
          issueId: "u-2",
          issueIdentifier: "SYMPH-2",
          title: "B",
          priority: 2,
          state: "Todo",
          blockedBy: ["SYMPH-1"],
        },
        {
          issueId: "u-3",
          issueIdentifier: "SYMPH-3",
          title: "C",
          priority: 3,
          state: "Todo",
          blockedBy: [],
        },
      ],
    };
    const body = buildPlanBody(
      {
        rationale: "plan",
        batches: [
          {
            mode: "parallel-isolated",
            issueIdentifiers: ["SYMPH-1", "SYMPH-2", "SYMPH-3"],
            rationale: "r",
          },
        ],
        dependencies: [
          { issueIdentifier: "SYMPH-3", dependsOn: ["SYMPH-2"] },
          { issueIdentifier: "SYMPH-2", dependsOn: ["SYMPH-404"] },
        ],
      },
      ctx,
    );
    // recorded blockedBy: SYMPH-2 -> SYMPH-1; soft dep: SYMPH-3 -> SYMPH-2.
    expect(body.dependencyEdges).toContainEqual({
      issueIdentifier: "SYMPH-2",
      dependsOn: "SYMPH-1",
    });
    expect(body.dependencyEdges).toContainEqual({
      issueIdentifier: "SYMPH-3",
      dependsOn: "SYMPH-2",
    });
    // a dependsOn that is not a planned member is dropped.
    expect(body.dependencyEdges).not.toContainEqual({
      issueIdentifier: "SYMPH-2",
      dependsOn: "SYMPH-404",
    });
  });

  it("keeps the dependency graph acyclic — hard edge wins, the cycle-closing soft edge is dropped (council R1)", () => {
    const ctx: PlannerContext = {
      ...context(),
      backlog: [
        {
          issueId: "u-1",
          issueIdentifier: "SYMPH-1",
          title: "A",
          priority: 1,
          state: "Todo",
          blockedBy: ["SYMPH-2"],
        },
        {
          issueId: "u-2",
          issueIdentifier: "SYMPH-2",
          title: "B",
          priority: 2,
          state: "Todo",
          blockedBy: [],
        },
      ],
    };
    const body = buildPlanBody(
      {
        rationale: "plan",
        batches: [
          {
            mode: "parallel-isolated",
            issueIdentifiers: ["SYMPH-1", "SYMPH-2"],
            rationale: "r",
          },
        ],
        // recorded blockedBy gives SYMPH-1 -> SYMPH-2 (added first); the soft edge
        // SYMPH-2 -> SYMPH-1 would close the cycle and is dropped.
        dependencies: [{ issueIdentifier: "SYMPH-2", dependsOn: ["SYMPH-1"] }],
      },
      ctx,
    );
    expect(body.dependencyEdges).toContainEqual({
      issueIdentifier: "SYMPH-1",
      dependsOn: "SYMPH-2",
    });
    expect(body.dependencyEdges).not.toContainEqual({
      issueIdentifier: "SYMPH-2",
      dependsOn: "SYMPH-1",
    });
  });
});

describe("runTriagePlanner", () => {
  it("returns a valid empty plan without invoking the model when the backlog is empty", async () => {
    let invoked = false;
    const result = await runTriagePlanner(
      {
        ...context(),
        backlog: [],
      },
      {
        runClaude: async (): Promise<PlannerRunResult> => {
          invoked = true;
          return {
            status: "ok",
            markdown: artifact({ rationale: "unused", batches: [] }),
          };
        },
      },
    );

    expect(invoked).toBe(false);
    expect(result.status).toBe("ok");
    if (result.status === "ok") {
      expect(result.body.batches).toEqual([]);
      expect(result.body.options).toEqual([]);
      expect(result.body.source).toBe("planner");
    }
  });

  it("returns a plan body on a good model artifact", async () => {
    const deps = {
      runClaude: async (): Promise<PlannerRunResult> => ({
        status: "ok",
        markdown: artifact({
          rationale: "go",
          batches: [
            {
              mode: "parallel-isolated",
              issueIdentifiers: ["SYMPH-1"],
              rationale: "first",
            },
          ],
        }),
      }),
    };
    const result = await runTriagePlanner(context(), deps);
    expect(result.status).toBe("ok");
    if (result.status === "ok") {
      expect(result.body.batches).toHaveLength(1);
    }
  });

  it("degrades gracefully when the model runner is unavailable", async () => {
    const deps = {
      runClaude: async (): Promise<PlannerRunResult> => ({
        status: "unavailable",
        detail: "cmux preflight failed",
      }),
    };
    const result = await runTriagePlanner(context(), deps);
    expect(result.status).toBe("unavailable");
  });

  it("reports invalid when the model output cannot be parsed", async () => {
    const deps = {
      runClaude: async (): Promise<PlannerRunResult> => ({
        status: "ok",
        markdown: "# Plan\n\nI refuse to emit JSON.\n",
      }),
    };
    const result = await runTriagePlanner(context(), deps);
    expect(result.status).toBe("invalid");
  });

  it("downgrades a single malformed-canary batch instead of voiding the whole plan (SYMPH-836)", async () => {
    const deps = {
      runClaude: async (): Promise<PlannerRunResult> => ({
        status: "ok",
        markdown: artifact({
          rationale: "two batches; one carries a garbage canary",
          batches: [
            {
              mode: "parallel-isolated",
              issueIdentifiers: ["SYMPH-1"],
              rationale: "valid",
            },
            {
              mode: "canary-chain",
              issueIdentifiers: ["SYMPH-2"],
              rationale: "garbage canary must not void the whole plan",
              canary: { nonsense: true },
            },
          ],
        }),
      }),
    };
    const result = await runTriagePlanner(context(), deps);
    expect(result.status).toBe("ok");
    if (result.status === "ok") {
      expect(result.body.batches).toHaveLength(2);
      const downgraded = result.body.batches.find((b) =>
        b.members.some((m) => m.issueIdentifier === "SYMPH-2"),
      );
      expect(downgraded?.mode).toBe("parallel-isolated");
      expect(downgraded?.canary).toBeNull();
    }
  });
});

describe("createCmuxPlannerRunner", () => {
  function cmuxResult(over: Partial<ClaudeRunnerResult>): ClaudeRunnerResult {
    return {
      status: "passed",
      artifactPath: "/artifacts/plan.md",
      message: "ok",
      model: "opus",
      ...over,
    } as unknown as ClaudeRunnerResult;
  }

  it("invokes the version-floating opus alias and returns the artifact markdown on pass", async () => {
    const calls: Array<{ model: string | undefined; promptFile: string }> = [];
    const writes: Array<{ path: string; data: string }> = [];
    const runner = createCmuxPlannerRunner({
      workspace: "/ws",
      artifactDir: "/artifacts",
      artifactName: "plan",
      runCmux: async (input) => {
        calls.push({ model: input.model, promptFile: input.promptFile });
        return cmuxResult({ artifactPath: "/artifacts/plan.md" });
      },
      fs: {
        mkdir: async () => undefined,
        writeFile: async (path, data) => {
          writes.push({ path: String(path), data: String(data) });
        },
        readFile: async () => "# Plan\n```json\n{}\n```\n",
      },
    });

    const result = await runner("PROMPT-BODY");
    expect(result.status).toBe("ok");
    if (result.status === "ok") {
      expect(result.markdown).toContain("```json");
    }
    expect(calls[0]?.model).toBe("opus");
    expect(writes[0]?.data).toBe("PROMPT-BODY");
  });

  it("degrades to unavailable when cmux does not pass", async () => {
    const runner = createCmuxPlannerRunner({
      workspace: "/ws",
      artifactDir: "/artifacts",
      artifactName: "plan",
      runCmux: async () =>
        cmuxResult({ status: "degraded", artifactPath: null }),
      fs: {
        mkdir: async () => undefined,
        writeFile: async () => undefined,
        readFile: async () => {
          throw new Error("should not read");
        },
      },
    });

    const result = await runner("PROMPT-BODY");
    expect(result.status).toBe("unavailable");
  });
});
