import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it, vi } from "vitest";

import type { Issue } from "../../src/domain/model.js";
import {
  type ContinuousFeedbackCommandInput,
  createContinuousFeedbackProvider,
  probeContinuousFeedbackModel,
  runContinuousFeedbackCommand,
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

  it("marks malformed provider output as unavailable", async () => {
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
      status: "unavailable",
    });
  });

  it("marks provider output without a findings array as unavailable", async () => {
    const provider = createContinuousFeedbackProvider({
      resolveWorkspacePath: () => "/tmp/symphony-workspace",
      readDiff: () => "",
      runCommand: async () => ({
        exitCode: 0,
        stderr: "",
        stdout: JSON.stringify({
          summary: "Temporary provider error.",
        }),
      }),
    });

    await expect(provider(createProviderInput())).resolves.toEqual({
      summary: "Temporary provider error.",
      findings: [],
      status: "unavailable",
    });
  });

  it("marks provider output with non-array findings as unavailable", async () => {
    const provider = createContinuousFeedbackProvider({
      resolveWorkspacePath: () => "/tmp/symphony-workspace",
      readDiff: () => "",
      runCommand: async () => ({
        exitCode: 0,
        stderr: "",
        stdout: JSON.stringify({
          summary: "Schema violation.",
          findings: {},
        }),
      }),
    });

    await expect(provider(createProviderInput())).resolves.toEqual({
      summary: "Schema violation.",
      findings: [],
      status: "unavailable",
    });
  });

  it("marks provider output with only invalid findings as unavailable", async () => {
    const provider = createContinuousFeedbackProvider({
      resolveWorkspacePath: () => "/tmp/symphony-workspace",
      readDiff: () => "",
      runCommand: async () => ({
        exitCode: 0,
        stderr: "",
        stdout: JSON.stringify({
          summary: "Invalid finding payload.",
          findings: [{ detail: "Missing title." }],
        }),
      }),
    });

    await expect(provider(createProviderInput())).resolves.toEqual({
      summary: "Invalid finding payload.",
      findings: [],
      status: "unavailable",
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
      status: "unavailable",
    });
  });

  it("marks timeout exits without a code as unavailable", async () => {
    const provider = createContinuousFeedbackProvider({
      resolveWorkspacePath: () => "/tmp/symphony-workspace",
      readDiff: () => "",
      runCommand: async () => ({
        exitCode: null,
        stderr: "Continuous feedback command timed out after 10ms.",
        stdout: "",
      }),
    });

    await expect(provider(createProviderInput())).resolves.toEqual({
      summary:
        "Continuous feedback provider exited without an exit code: Continuous feedback command timed out after 10ms.",
      findings: [],
      status: "unavailable",
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

  it("probes the continuous-feedback model as available on a zero-exit runner call (SYMPH-761)", async () => {
    const commands: ContinuousFeedbackCommandInput[] = [];
    const result = await probeContinuousFeedbackModel(
      {
        runner: "pi",
        model: "ds4-studio2/deepseek-v4-flash",
        role: "continuous-feedback",
      },
      {
        cwd: "/tmp/symphony-workspace",
        runCommand: async (input) => {
          commands.push(input);
          return { exitCode: 0, stderr: "", stdout: "OK" };
        },
      },
    );

    expect(result.available).toBe(true);
    expect(result.detail).toContain("ds4-studio2/deepseek-v4-flash");
    expect(result.detail).toContain("pi");
    // The probe exercises the SAME runner + model-resolution arg path the live
    // lane uses, so a model the runner cannot resolve fails the probe too.
    expect(commands).toHaveLength(1);
    expect(commands[0]?.command).toBe("pi");
    expect(commands[0]?.args).toEqual(
      expect.arrayContaining(["--model", "ds4-studio2/deepseek-v4-flash"]),
    );
  });

  it("probes the continuous-feedback model as unavailable on a non-zero runner call (SYMPH-761)", async () => {
    const result = await probeContinuousFeedbackModel(
      {
        runner: "pi",
        model: "ds4-studio2/missing-model",
        role: "continuous-feedback",
      },
      {
        cwd: "/tmp/symphony-workspace",
        runCommand: async () => ({
          exitCode: 1,
          stderr: "model not found: ds4-studio2/missing-model",
          stdout: "",
        }),
      },
    );

    expect(result.available).toBe(false);
    expect(result.detail).toContain("model not found");
  });

  it("treats a probe timeout (null exit code) as unavailable (SYMPH-761)", async () => {
    const result = await probeContinuousFeedbackModel(
      {
        runner: "pi",
        model: "ds4-studio2/deepseek-v4-flash",
        role: "continuous-feedback",
      },
      {
        runCommand: async () => ({
          exitCode: null,
          stderr: "Continuous feedback command timed out after 20000ms.",
          stdout: "",
        }),
      },
    );

    expect(result.available).toBe(false);
    expect(result.detail).toContain("timed out");
  });

  it("force-kills a SIGTERM-ignoring runner so a timed-out probe child cannot outlive the call (SYMPH-761)", async () => {
    const dir = await mkdtemp(join(tmpdir(), "symphony-cf-probe-kill-"));
    const pidFile = join(dir, "pid");
    // A child that records its pid, ignores SIGTERM, and stays alive: only the
    // SIGKILL escalation can stop it, and the call must not resolve until it
    // actually exits (no orphaned runner past the awaited startup preflight).
    const result = await runContinuousFeedbackCommand({
      command: process.execPath,
      args: [
        "-e",
        `require("fs").writeFileSync(${JSON.stringify(pidFile)}, String(process.pid)); process.on("SIGTERM", () => {}); setInterval(() => {}, 1000);`,
      ],
      cwd: process.cwd(),
      prompt: "",
      timeoutMs: 250,
      killGraceMs: 250,
    });

    expect(result.exitCode).toBeNull();
    const childPid = Number((await readFile(pidFile, "utf8")).trim());
    expect(Number.isInteger(childPid)).toBe(true);
    // The call resolved only from `close`, so the child must already be dead.
    let alive = true;
    try {
      process.kill(childPid, 0);
    } catch {
      alive = false;
    }
    if (alive) {
      // Safety net so a regression cannot leak the child into the suite.
      try {
        process.kill(childPid, "SIGKILL");
      } catch {
        // already gone
      }
    }
    expect(alive).toBe(false);
  });

  it("does not hang when a timed-out runner leaves a descendant holding the inherited pipes (SYMPH-761)", async () => {
    const dir = await mkdtemp(join(tmpdir(), "symphony-cf-probe-desc-"));
    const runnerPidFile = join(dir, "runner-pid");
    const descPidFile = join(dir, "desc-pid");
    const runnerScript = join(dir, "runner.mjs");
    // The runner ignores SIGTERM and spawns a descendant that INHERITS its
    // stdio (the pipes back to us) and never exits. `close` would wait for
    // those pipes to drain (never), so resolving on `close` would hang the
    // awaited preflight forever; resolving on the runner's `exit` does not.
    const descInline = `require("fs").writeFileSync(${JSON.stringify(descPidFile)}, String(process.pid)); setInterval(() => {}, 1000);`;
    const runnerSource = `import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";
writeFileSync(${JSON.stringify(runnerPidFile)}, String(process.pid));
spawn(process.execPath, ["-e", ${JSON.stringify(descInline)}], { stdio: "inherit" });
process.on("SIGTERM", () => {});
setInterval(() => {}, 1000);
`;
    await writeFile(runnerScript, runnerSource, "utf8");

    const result = await runContinuousFeedbackCommand({
      command: process.execPath,
      args: [runnerScript],
      cwd: process.cwd(),
      prompt: "",
      timeoutMs: 250,
      killGraceMs: 250,
    });

    // It RESOLVED (did not hang on the descendant's held pipes).
    expect(result.exitCode).toBeNull();

    // Cleanup: the runner is force-killed; the orphaned descendant is not reaped
    // by us (full process-tree reaping is out of scope — see follow-up), so kill
    // it here to avoid leaking into the suite.
    for (const file of [runnerPidFile, descPidFile]) {
      try {
        const pid = Number((await readFile(file, "utf8")).trim());
        if (Number.isInteger(pid)) {
          process.kill(pid, "SIGKILL");
        }
      } catch {
        // not written yet, or already gone
      }
    }
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
