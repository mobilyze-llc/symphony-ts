import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  type CommandRunner,
  type HeadlessReviewerLaneConfig,
  runHeadlessCouncilGate,
} from "../../src/review/headless-council-gate.js";

describe("runHeadlessCouncilGate", () => {
  it("runs Claude, Pi, and Codex lead through cmux-spawn and writes artifacts", async () => {
    const harness = await createHarness();
    const result = await runHeadlessCouncilGate(
      {
        issueId: "MOB-88",
        workspace: harness.workspace,
        artifactDir: harness.artifactDir,
        diffPath: harness.diffPath,
        cmuxSpawnBin: "/tmp/cmux-spawn",
      },
      { runCommand: harness.runCommand },
    );

    expect(result.verdict).toBe("pass");
    expect(result.lanes).toHaveLength(3);
    expect(
      result.lanes.find((lane) => lane.laneId === "codex-xhigh-lead"),
    ).toMatchObject({ independentReviewer: false, verdict: "pass" });
    expect(harness.commands).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          command: "/tmp/cmux-spawn",
          args: expect.arrayContaining([
            "run",
            "--agent",
            "claude",
            "--model",
            "opus",
          ]),
        }),
        expect.objectContaining({
          command: "/tmp/cmux-spawn",
          args: expect.arrayContaining([
            "run",
            "--agent",
            "pi",
            "--provider",
            "deepseek",
          ]),
        }),
        expect.objectContaining({
          command: "/tmp/cmux-spawn",
          args: expect.arrayContaining([
            "run",
            "--agent",
            "codex",
            "--read-only",
          ]),
        }),
      ]),
    );

    const resultJson = await readFile(result.artifactPaths.resultJson, "utf-8");
    expect(JSON.parse(resultJson)).toMatchObject({
      issueId: "MOB-88",
      verdict: "pass",
    });
    const report = await readFile(result.artifactPaths.councilReport, "utf-8");
    expect(report).toContain("Headless Council Review");
  });

  it("fails closed when zero reviewer lanes are configured", async () => {
    const harness = await createHarness();
    const result = await runHeadlessCouncilGate(
      {
        issueId: "MOB-88",
        workspace: harness.workspace,
        artifactDir: harness.artifactDir,
        diffPath: harness.diffPath,
        reviewerLanes: [],
      },
      { runCommand: harness.runCommand },
    );

    expect(result.verdict).toBe("error");
    expect(result.degradedConditions).toContain("zero-reviewer-lanes");
    expect(harness.commands).toEqual([]);
  });

  it("fails closed on cmux preflight failure", async () => {
    const harness = await createHarness({
      preflight: { exitCode: 1, stdout: "{}", stderr: "cmux unavailable" },
    });
    const result = await runHeadlessCouncilGate(
      {
        issueId: "MOB-88",
        workspace: harness.workspace,
        artifactDir: harness.artifactDir,
        diffPath: harness.diffPath,
      },
      { runCommand: harness.runCommand },
    );

    expect(result.verdict).toBe("error");
    expect(result.degradedConditions).toContain("cmux-preflight-failed");
  });

  it("fails closed when cmux returns malformed lane JSON", async () => {
    const harness = await createHarness({
      laneBehavior: { "claude-opus": { stdout: "not json" } },
    });
    const result = await runHeadlessCouncilGate(
      {
        issueId: "MOB-88",
        workspace: harness.workspace,
        artifactDir: harness.artifactDir,
        diffPath: harness.diffPath,
      },
      { runCommand: harness.runCommand },
    );

    expect(result.verdict).toBe("error");
    expect(
      result.lanes.find((lane) => lane.laneId === "claude-opus"),
    ).toMatchObject({
      state: "error",
      verdict: "error",
    });
  });

  it("fails closed when a reviewer times out", async () => {
    const harness = await createHarness({
      laneBehavior: {
        "pi-deepseek": {
          exitCode: 1,
          json: { state: "timed_out", message: "timed out" },
        },
      },
    });
    const result = await runHeadlessCouncilGate(
      {
        issueId: "MOB-88",
        workspace: harness.workspace,
        artifactDir: harness.artifactDir,
        diffPath: harness.diffPath,
      },
      { runCommand: harness.runCommand },
    );

    expect(result.verdict).toBe("error");
    expect(
      result.lanes.find((lane) => lane.laneId === "pi-deepseek"),
    ).toMatchObject({
      state: "timed_out",
      verdict: "error",
    });
  });

  it("fails closed when a lane artifact is missing", async () => {
    const harness = await createHarness({
      laneBehavior: {
        "claude-opus": {
          json: { state: "complete", artifact_path: "/tmp/does-not-exist.md" },
        },
      },
    });
    const result = await runHeadlessCouncilGate(
      {
        issueId: "MOB-88",
        workspace: harness.workspace,
        artifactDir: harness.artifactDir,
        diffPath: harness.diffPath,
      },
      { runCommand: harness.runCommand },
    );

    expect(result.verdict).toBe("error");
    expect(
      result.lanes.find((lane) => lane.laneId === "claude-opus"),
    ).toMatchObject({
      verdict: "error",
      message: "Reviewer artifact was missing or empty.",
    });
  });

  it("fails closed when a lane artifact has no parseable verdict", async () => {
    const harness = await createHarness({
      laneBehavior: {
        "claude-opus": {
          artifact: "I looked at the diff and it seems fine.",
        },
      },
    });
    const result = await runHeadlessCouncilGate(
      {
        issueId: "MOB-88",
        workspace: harness.workspace,
        artifactDir: harness.artifactDir,
        diffPath: harness.diffPath,
      },
      { runCommand: harness.runCommand },
    );

    expect(result.verdict).toBe("fail");
    expect(
      result.lanes.find((lane) => lane.laneId === "claude-opus"),
    ).toMatchObject({
      verdict: "fail",
      message: "Artifact did not include a parseable Verdict section.",
    });
  });

  it("returns fail when a completed reviewer reports findings", async () => {
    const harness = await createHarness({
      laneBehavior: {
        "claude-opus": {
          artifact: "## Verdict\nFINDINGS\n\n## P2 Should Fix\n- Bug",
        },
      },
    });
    const result = await runHeadlessCouncilGate(
      {
        issueId: "MOB-88",
        workspace: harness.workspace,
        artifactDir: harness.artifactDir,
        diffPath: harness.diffPath,
      },
      { runCommand: harness.runCommand },
    );

    expect(result.verdict).toBe("fail");
    expect(
      result.lanes.find((lane) => lane.laneId === "claude-opus"),
    ).toMatchObject({
      verdict: "fail",
    });
  });

  it("supports a single decorrelated reviewer for low-risk gates", async () => {
    const harness = await createHarness();
    const reviewerLanes: HeadlessReviewerLaneConfig[] = [
      {
        laneId: "claude-opus",
        agent: "claude",
        role: "opus-direct-reviewer",
        model: "opus",
      },
    ];
    const result = await runHeadlessCouncilGate(
      {
        issueId: "MOB-88",
        workspace: harness.workspace,
        artifactDir: harness.artifactDir,
        diffPath: harness.diffPath,
        reviewerLanes,
        codexLead: false,
      },
      { runCommand: harness.runCommand },
    );

    expect(result.verdict).toBe("pass");
    expect(result.lanes).toHaveLength(1);
    expect(result.degradedConditions).toContain("codex-lead-disabled");
  });
});

interface LaneBehavior {
  exitCode?: number;
  stdout?: string;
  json?: Record<string, unknown>;
  artifact?: string;
}

async function createHarness(options?: {
  preflight?: { exitCode: number; stdout: string; stderr: string };
  laneBehavior?: Record<string, LaneBehavior>;
}) {
  const root = await mkdtemp(join(tmpdir(), "symphony-headless-gate-"));
  const workspace = join(root, "workspace");
  const artifactDir = join(root, "artifacts");
  const diffPath = join(root, "diff.patch");
  await writeFile(
    diffPath,
    "diff --git a/file.ts b/file.ts\n+const ok = true;\n",
  );

  const commands: { command: string; args: readonly string[] }[] = [];
  const runCommand: CommandRunner = async (command, args) => {
    commands.push({ command, args });
    if (args[0] === "preflight") {
      return options?.preflight ?? { exitCode: 0, stdout: "{}", stderr: "" };
    }

    if (args[0] === "run") {
      const artifactName = args[args.indexOf("--artifact-name") + 1]!;
      const behavior = options?.laneBehavior?.[artifactName] ?? {};
      if (behavior.stdout !== undefined) {
        return {
          exitCode: behavior.exitCode ?? 0,
          stdout: behavior.stdout,
          stderr: "",
        };
      }
      const artifactPath =
        typeof behavior.json?.artifact_path === "string"
          ? behavior.json.artifact_path
          : join(artifactDir, `${artifactName}.md`);
      if (behavior.json?.artifact_path === undefined) {
        await writeFile(
          artifactPath,
          behavior.artifact ?? "## Verdict\nPASS\n\n## P1 Must Fix\nNone\n",
        );
      }
      return {
        exitCode: behavior.exitCode ?? 0,
        stdout: JSON.stringify({
          state: "complete",
          artifact_path: artifactPath,
          ...(behavior.json ?? {}),
        }),
        stderr: "",
      };
    }

    return { exitCode: 1, stdout: "", stderr: `unexpected command ${command}` };
  };

  return { root, workspace, artifactDir, diffPath, commands, runCommand };
}
