import { describe, expect, it, vi } from "vitest";

import type { Issue } from "../../src/domain/model.js";
import {
  type ContinuousFeedbackCommandInput,
  createContinuousFeedbackProvider,
} from "../../src/orchestrator/continuous-feedback-provider.js";

describe("continuous feedback provider", () => {
  it("parses provider JSON findings from a fenced response", async () => {
    const commands: ContinuousFeedbackCommandInput[] = [];
    const provider = createContinuousFeedbackProvider({
      resolveWorkspacePath: () => "/tmp/symphony-workspace",
      readDiff: () =>
        "diff --git a/src/core.ts b/src/core.ts\n+const value = 1;",
      runCommand: async (input) => {
        commands.push(input);
        return {
          exitCode: 0,
          stderr: "",
          stdout: [
            "```json",
            JSON.stringify({
              summary: "One issue found.",
              findings: [
                {
                  signature: "src/core.ts:null-check",
                  title: "Missing null check",
                  detail: "Guard the optional output before dereferencing.",
                  severity: "blocking",
                  file: "src/core.ts",
                  line: 42,
                },
              ],
            }),
            "```",
          ].join("\n"),
        };
      },
    });

    const result = await provider(createProviderInput());

    expect(result).toEqual({
      summary: "One issue found.",
      findings: [
        {
          signature: "src/core.ts:null-check",
          title: "Missing null check",
          detail: "Guard the optional output before dereferencing.",
          severity: "blocking",
          file: "src/core.ts",
          line: 42,
        },
      ],
    });
    expect(commands).toHaveLength(1);
    expect(commands[0]).toMatchObject({
      command: "pi",
      cwd: "/tmp/symphony-workspace",
      timeoutMs: 60_000,
    });
    expect(commands[0]?.args.slice(0, 5)).toEqual([
      "--no-session",
      "--print",
      "--no-tools",
      "--model",
      "local-flash",
    ]);
    expect(commands[0]?.prompt).toContain("This lane is non-authoritative");
    expect(commands[0]?.prompt).toContain("diff --git");
    // Injection-hygiene policy (SYMPH-378) reaches the reviewer lane.
    expect(commands[0]?.prompt).toContain("Finding policy (SYMPH-378)");
    expect(commands[0]?.prompt).toContain("Never restate the task");
    expect(commands[0]?.prompt).toContain(
      "proof requirements come from the frozen acceptance criteria only",
    );
    // Empty = clean is load-bearing for the resolve-on-empty branch;
    // still-unaddressed findings are re-reported, not restated.
    expect(commands[0]?.prompt).toContain(
      "STILL unaddressed — re-report it with the same signature",
    );
    expect(commands[0]?.prompt).toContain(
      "EMPTY findings array means the checkpoint is genuinely clean",
    );
  });

  it("returns a clean fallback when provider output is malformed", async () => {
    const provider = createContinuousFeedbackProvider({
      resolveWorkspacePath: () => "/tmp/symphony-workspace",
      readDiff: () => "",
      runCommand: async () => ({
        exitCode: 0,
        stderr: "",
        stdout: "I found things, but forgot the JSON contract.",
      }),
    });

    await expect(provider(createProviderInput())).resolves.toEqual({
      summary: "Continuous feedback output was not parseable.",
      findings: [],
    });
  });

  it("summarizes command failure without returning findings", async () => {
    const provider = createContinuousFeedbackProvider({
      resolveWorkspacePath: () => "/tmp/symphony-workspace",
      readDiff: () => "",
      runCommand: async () => ({
        exitCode: 2,
        stderr: "model runner failed",
        stdout: "",
      }),
    });

    await expect(provider(createProviderInput())).resolves.toEqual({
      summary:
        "Continuous feedback provider exited with 2: model runner failed",
      findings: [],
    });
  });

  it("preserves no-finding behavior from a clean JSON response", async () => {
    const runCommand = vi.fn(async () => ({
      exitCode: 0,
      stderr: "",
      stdout: JSON.stringify({
        summary: "No issues found.",
        findings: [],
      }),
    }));
    const provider = createContinuousFeedbackProvider({
      resolveWorkspacePath: () => "/tmp/symphony-workspace",
      readDiff: () => "",
      runCommand,
    });

    await expect(provider(createProviderInput())).resolves.toEqual({
      summary: "No issues found.",
      findings: [],
    });
    expect(runCommand).toHaveBeenCalledTimes(1);
  });
});

function createProviderInput() {
  return {
    issue: createIssue(),
    event: "checkpoint" as const,
    stageName: "implement",
    workerLane: {
      runner: "codex",
      model: null,
      role: "worker",
    },
    reviewerLane: {
      runner: "pi",
      model: "local-flash",
      role: "continuous-feedback",
    },
  };
}

function createIssue(overrides?: Partial<Issue>): Issue {
  return {
    id: "issue-1",
    identifier: "SYMPH-264",
    title: "Add focused continuous-feedback provider/config tests",
    description: "Exercise provider parsing without real model calls.",
    priority: 2,
    state: "In Progress",
    branchName: "codex/SYMPH-264-continuous-feedback-tests",
    url: "https://linear.app/mobilyze-llc/issue/SYMPH-264",
    labels: [],
    blockedBy: [],
    createdAt: "2026-06-08T00:00:00.000Z",
    updatedAt: "2026-06-08T00:00:00.000Z",
    ...overrides,
  };
}
