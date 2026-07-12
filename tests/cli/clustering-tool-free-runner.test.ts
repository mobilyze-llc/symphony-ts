import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  CODEX_DISABLED_TOOL_FEATURES,
  createToolFreeClusteringPlannerRunner,
  resolveToolFreeInvocation,
} from "../../src/cli/clustering-tool-free-runner.js";

const roots: string[] = [];

/**
 * The complete Codex 0.144.1 tool/context surface inventory the tool-free
 * clustering boundary must disable, declared once as the single contract for
 * the whole suite (SYMPH-1128). Every name is a supported `codex features`
 * flag (validated against the installed CLI), so `--disable <name>` never aborts
 * on an unknown feature. Any other assertion about the denylist references this
 * list instead of re-listing a partial copy.
 */
const EXPECTED_CODEX_TOOL_FREE_DENYLIST = [
  "shell_tool",
  "unified_exec",
  "shell_snapshot",
  "browser_use",
  "browser_use_external",
  "browser_use_full_cdp_access",
  "computer_use",
  "in_app_browser",
  "apps",
  "plugins",
  "plugin_sharing",
  "remote_plugin",
  "multi_agent",
  "goals",
  "memories",
  "image_generation",
  "code_mode_host",
  "auth_elicitation",
  "tool_call_mcp_elicitation",
  "hooks",
  "tool_suggest",
  "workspace_dependencies",
  "skill_mcp_dependency_install",
] as const;

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

describe("tool-free clustering planner runner", () => {
  it.each(["xhigh", "max"])(
    "threads %s verbatim to both Claude and Codex",
    (reasoningLevel) => {
      const claude = resolveToolFreeInvocation("opus", reasoningLevel);
      const codex = resolveToolFreeInvocation(
        "openai/gpt-5.6-sol",
        reasoningLevel,
      );

      expect(valueAfter(claude.args, "--effort")).toBe(reasoningLevel);
      expect(codex.args).toContain(
        `model_reasoning_effort="${reasoningLevel}"`,
      );
    },
  );
  it("hard-disables tools and strips tracker credentials at the subprocess boundary", async () => {
    const root = await mkdtemp(join(tmpdir(), "clustering-tool-free-"));
    roots.push(root);
    const executable = join(root, "claude");
    const capturePath = join(root, "process-boundary.json");
    await writeFile(
      executable,
      [
        "#!/usr/bin/env node",
        'const { writeFileSync } = require("node:fs");',
        "const chunks = [];",
        'process.stdin.on("data", (chunk) => chunks.push(chunk));',
        'process.stdin.on("end", () => {',
        "  writeFileSync(process.env.CAPTURE_PATH, JSON.stringify({",
        "    args: process.argv.slice(2),",
        '    stdin: Buffer.concat(chunks).toString("utf8"),',
        "    env: Object.fromEntries(Object.entries(process.env).filter(([name]) =>",
        '      ["ANTHROPIC_API_KEY", "LINEAR_API_KEY", "LINEAR_WORKSPACE_PAT", "SYMPHONY_LINEAR_WEBHOOK_SECRET", "SYMPHONY_LINEAR_ADMIN_TOKEN_CACHE", "GH_TOKEN", "GH_AUTOMATION_PAT", "GITHUB_TOKEN", "GITHUB_APP_PRIVATE_KEY", "GITHUB_APP_CLIENT_SECRET_ROTATED", "SLACK_BOT_TOKEN", "SLACK_SIGNING_SECRET_V2", "SLACK_WEBHOOK_URL", "SYMPHONY_SLACK_ALERT_WEBHOOK_URL_PRIMARY", "LINEAR_PROJECT_SLUG", "GITHUB_REPOSITORY", "SLACK_NOTIFY_CHANNEL"].includes(name),',
        "    )),",
        "  }));",
        '  process.stdout.write(\'{"rationale":"measured","batches":[]}\');',
        "});",
        "",
      ].join("\n"),
      "utf8",
    );
    await chmod(executable, 0o755);
    const runner = createToolFreeClusteringPlannerRunner({
      model: "opus",
      reasoningLevel: "high",
      workspace: root,
      artifactDir: join(root, "artifacts"),
      artifactName: "repeat-1",
      env: {
        PATH: `${root}${delimiter}${process.env.PATH ?? ""}`,
        CAPTURE_PATH: capturePath,
        ANTHROPIC_API_KEY: "model-auth",
        LINEAR_API_KEY: "linear-secret",
        LINEAR_WORKSPACE_PAT: "linear-missed-pattern",
        SYMPHONY_LINEAR_WEBHOOK_SECRET: "linear-webhook-secret",
        SYMPHONY_LINEAR_ADMIN_TOKEN_CACHE: "linear-token-cache",
        GH_TOKEN: "github-secret",
        GH_AUTOMATION_PAT: "github-missed-pattern",
        GITHUB_TOKEN: "github-secret-2",
        GITHUB_APP_PRIVATE_KEY: "github-private-key",
        GITHUB_APP_CLIENT_SECRET_ROTATED: "github-client-secret",
        SLACK_BOT_TOKEN: "slack-secret",
        SLACK_SIGNING_SECRET_V2: "slack-signing-secret",
        SLACK_WEBHOOK_URL: "slack-webhook-secret",
        SYMPHONY_SLACK_ALERT_WEBHOOK_URL_PRIMARY:
          "symphony-slack-webhook-secret",
        LINEAR_PROJECT_SLUG: "preserved-project",
        GITHUB_REPOSITORY: "preserved/repository",
        SLACK_NOTIFY_CHANNEL: "preserved-channel",
      },
    });

    await expect(runner("planner prompt")).resolves.toEqual({
      status: "ok",
      markdown: '{"rationale":"measured","batches":[]}',
    });
    const processBoundary = JSON.parse(await readFile(capturePath, "utf8")) as {
      args: string[];
      stdin: string;
      env: Record<string, string>;
    };
    expect(processBoundary.stdin).toBe("planner prompt");
    expect(valueAfter(processBoundary.args, "--tools")).toBe("");
    expect(processBoundary.args).toContain("--strict-mcp-config");
    expect(
      JSON.parse(valueAfter(processBoundary.args, "--mcp-config")),
    ).toEqual({
      mcpServers: {},
    });
    expect(valueAfter(processBoundary.args, "--model")).toBe("opus");
    expect(valueAfter(processBoundary.args, "--effort")).toBe("high");
    expect(valueAfter(processBoundary.args, "--setting-sources")).toBe("");
    expect(processBoundary.args).toEqual(
      expect.arrayContaining([
        "--safe-mode",
        "--disable-slash-commands",
        "--no-chrome",
        "--no-session-persistence",
      ]),
    );
    expect(processBoundary.env.ANTHROPIC_API_KEY).toBe("model-auth");
    expect(processBoundary.env).not.toHaveProperty("LINEAR_API_KEY");
    expect(processBoundary.env).not.toHaveProperty("LINEAR_WORKSPACE_PAT");
    expect(processBoundary.env).not.toHaveProperty(
      "SYMPHONY_LINEAR_WEBHOOK_SECRET",
    );
    expect(processBoundary.env).not.toHaveProperty(
      "SYMPHONY_LINEAR_ADMIN_TOKEN_CACHE",
    );
    expect(processBoundary.env).not.toHaveProperty("GH_TOKEN");
    expect(processBoundary.env).not.toHaveProperty("GH_AUTOMATION_PAT");
    expect(processBoundary.env).not.toHaveProperty("GITHUB_TOKEN");
    expect(processBoundary.env).not.toHaveProperty("GITHUB_APP_PRIVATE_KEY");
    expect(processBoundary.env).not.toHaveProperty(
      "GITHUB_APP_CLIENT_SECRET_ROTATED",
    );
    expect(processBoundary.env).not.toHaveProperty("SLACK_BOT_TOKEN");
    expect(processBoundary.env).not.toHaveProperty("SLACK_SIGNING_SECRET_V2");
    expect(processBoundary.env).not.toHaveProperty("SLACK_WEBHOOK_URL");
    expect(processBoundary.env).not.toHaveProperty(
      "SYMPHONY_SLACK_ALERT_WEBHOOK_URL_PRIMARY",
    );
    expect(processBoundary.env.LINEAR_PROJECT_SLUG).toBe("preserved-project");
    expect(processBoundary.env.GITHUB_REPOSITORY).toBe("preserved/repository");
    expect(processBoundary.env.SLACK_NOTIFY_CHANNEL).toBe("preserved-channel");
    expect(
      await readFile(join(root, "artifacts", "repeat-1.prompt.md"), "utf8"),
    ).toBe("planner prompt");
    expect(await readFile(join(root, "artifacts", "repeat-1.md"), "utf8")).toBe(
      '{"rationale":"measured","batches":[]}\n',
    );
  });

  it("pins the reasoning level on the claude boundary via --effort", async () => {
    const root = await mkdtemp(join(tmpdir(), "clustering-tool-free-"));
    roots.push(root);
    let captured: { command: string; args: readonly string[] } | null = null;
    const runner = createToolFreeClusteringPlannerRunner({
      model: "opus",
      reasoningLevel: "low",
      workspace: root,
      artifactDir: join(root, "artifacts"),
      artifactName: "repeat-1",
      env: {},
      runProcess: async ({ command, args }) => {
        captured = { command, args };
        return { status: "completed", exitCode: 0, stdout: "{}", stderr: "" };
      },
    });

    await expect(runner("planner prompt")).resolves.toEqual({
      status: "ok",
      markdown: "{}",
    });
    if (captured === null) throw new Error("expected an invocation");
    const invocation = captured as { command: string; args: readonly string[] };
    expect(invocation.command).toBe("claude");
    expect(valueAfter(invocation.args, "--effort")).toBe("low");
  });

  it("routes openai/codex aliases to a codex exec run with a pinned reasoning effort", async () => {
    const root = await mkdtemp(join(tmpdir(), "clustering-tool-free-"));
    roots.push(root);
    let captured: { command: string; args: readonly string[] } | null = null;
    const runner = createToolFreeClusteringPlannerRunner({
      model: "openai/gpt-5.6-sol",
      reasoningLevel: "high",
      workspace: root,
      artifactDir: join(root, "artifacts"),
      artifactName: "repeat-1",
      env: {},
      runProcess: async ({ command, args }) => {
        captured = { command, args };
        return {
          status: "completed",
          exitCode: 0,
          stdout: '{"rationale":"measured","batches":[]}',
          stderr: "",
        };
      },
    });

    await expect(runner("planner prompt")).resolves.toEqual({
      status: "ok",
      markdown: '{"rationale":"measured","batches":[]}',
    });
    if (captured === null) throw new Error("expected an invocation");
    const invocation = captured as { command: string; args: readonly string[] };
    expect(invocation.command).toBe("codex");
    expect(invocation.args).toContain("exec");
    expect(invocation.args).toContain("--ignore-user-config");
    expect(invocation.args).toContain('model_reasoning_effort="high"');
    // The provider prefix is stripped for the codex --model id.
    expect(valueAfter(invocation.args, "--model")).toBe("gpt-5.6-sol");
    // The built-in execution/agent/tool surfaces are hard-disabled so the codex
    // boundary cannot inspect the evaluation workspace (SYMPH-1128).
    for (const feature of EXPECTED_CODEX_TOOL_FREE_DENYLIST) {
      expect(flagValues(invocation.args, "--disable")).toContain(feature);
    }
    // The evaluation workspace is history-free, so codex must skip its git-repo
    // guard or it aborts before inference (SYMPH-1128).
    expect(invocation.args).toContain("--skip-git-repo-check");
  });

  it("runs codex against a non-Git workspace via --skip-git-repo-check with the complete same-surface denylist", async () => {
    const root = await mkdtemp(join(tmpdir(), "clustering-tool-free-"));
    roots.push(root);
    // A workspace sentinel: the capability retest evaluation workspace is
    // intentionally history-free with no `.git`. Without `--skip-git-repo-check`
    // codex aborts before inference (SYMPH-1128).
    await expect(
      readFile(join(root, ".git", "HEAD"), "utf8"),
    ).rejects.toMatchObject({ code: "ENOENT" });
    let captured: { command: string; args: readonly string[] } | null = null;
    const runner = createToolFreeClusteringPlannerRunner({
      model: "openai/gpt-5.6-sol",
      reasoningLevel: "high",
      workspace: root,
      artifactDir: join(root, "artifacts"),
      artifactName: "repeat-1",
      env: {},
      runProcess: async ({ command, args }) => {
        captured = { command, args };
        return { status: "completed", exitCode: 0, stdout: "{}", stderr: "" };
      },
    });

    await expect(runner("planner prompt")).resolves.toEqual({
      status: "ok",
      markdown: "{}",
    });
    if (captured === null) throw new Error("expected an invocation");
    const invocation = captured as { command: string; args: readonly string[] };
    expect(invocation.command).toBe("codex");
    // Direct argv contract: the non-Git flag rides inside the exec run.
    expect(invocation.args).toContain("--skip-git-repo-check");
    expect(invocation.args.indexOf("--skip-git-repo-check")).toBeGreaterThan(
      invocation.args.indexOf("exec"),
    );
    // Direct argv contract: the complete same-surface denylist, in order.
    expect(flagValues(invocation.args, "--disable")).toEqual([
      ...EXPECTED_CODEX_TOOL_FREE_DENYLIST,
    ]);
  });

  it("disables the complete Codex 0.144.1 tool/context surface inventory", async () => {
    const root = await mkdtemp(join(tmpdir(), "clustering-tool-free-"));
    roots.push(root);
    let captured: { command: string; args: readonly string[] } | null = null;
    const runner = createToolFreeClusteringPlannerRunner({
      model: "openai/gpt-5.6-sol",
      reasoningLevel: "high",
      workspace: root,
      artifactDir: join(root, "artifacts"),
      artifactName: "repeat-1",
      env: {},
      runProcess: async ({ command, args }) => {
        captured = { command, args };
        return { status: "completed", exitCode: 0, stdout: "{}", stderr: "" };
      },
    });

    await expect(runner("planner prompt")).resolves.toEqual({
      status: "ok",
      markdown: "{}",
    });
    if (captured === null) throw new Error("expected an invocation");
    const invocation = captured as { command: string; args: readonly string[] };
    // Single source of truth: the source denylist and the invocation's
    // `--disable` values are exactly the complete supported inventory, in the
    // same order — no partial or duplicated list anywhere in the contract.
    expect([...CODEX_DISABLED_TOOL_FEATURES]).toEqual([
      ...EXPECTED_CODEX_TOOL_FREE_DENYLIST,
    ]);
    expect(flagValues(invocation.args, "--disable")).toEqual([
      ...EXPECTED_CODEX_TOOL_FREE_DENYLIST,
    ]);
    // Every surface the reviewer flagged as missing is now covered, alongside
    // the plugin/hook/shell-snapshot/tool-suggestion/workspace/skill-dependency
    // surfaces called out for the complete inventory (SYMPH-1128).
    for (const feature of [
      "image_generation",
      "in_app_browser",
      "auth_elicitation",
      "code_mode_host",
      "plugins",
      "plugin_sharing",
      "hooks",
      "shell_snapshot",
      "tool_suggest",
      "workspace_dependencies",
      "skill_mcp_dependency_install",
    ]) {
      expect(EXPECTED_CODEX_TOOL_FREE_DENYLIST).toContain(feature);
    }
    // The denylist advertises no duplicate feature name.
    expect(new Set(EXPECTED_CODEX_TOOL_FREE_DENYLIST).size).toBe(
      EXPECTED_CODEX_TOOL_FREE_DENYLIST.length,
    );
  });

  it("hard-disables codex built-in execution/agent surfaces before the config and model flags", async () => {
    const root = await mkdtemp(join(tmpdir(), "clustering-tool-free-"));
    roots.push(root);
    let captured: { command: string; args: readonly string[] } | null = null;
    const runner = createToolFreeClusteringPlannerRunner({
      model: "codex/gpt-5.6-sol",
      reasoningLevel: "medium",
      workspace: root,
      artifactDir: join(root, "artifacts"),
      artifactName: "repeat-1",
      env: {},
      runProcess: async ({ command, args }) => {
        captured = { command, args };
        return { status: "completed", exitCode: 0, stdout: "{}", stderr: "" };
      },
    });

    await expect(runner("planner prompt")).resolves.toEqual({
      status: "ok",
      markdown: "{}",
    });
    if (captured === null) throw new Error("expected an invocation");
    const invocation = captured as { command: string; args: readonly string[] };
    // Every disable pairs a `--disable <feature>` and precedes the pinned
    // reasoning override and model selection so no tool surface leaks through.
    expect(flagValues(invocation.args, "--disable")).toEqual([
      ...EXPECTED_CODEX_TOOL_FREE_DENYLIST,
    ]);
    const lastDisable = invocation.args.lastIndexOf("--disable");
    expect(lastDisable).toBeGreaterThan(invocation.args.indexOf("exec"));
    expect(lastDisable).toBeLessThan(invocation.args.indexOf("--config"));
    expect(lastDisable).toBeLessThan(invocation.args.indexOf("--model"));
  });

  it("freezes out repository instruction files via project_doc_max_bytes=0", async () => {
    const root = await mkdtemp(join(tmpdir(), "clustering-tool-free-"));
    roots.push(root);
    // A workspace sentinel documenting why the override is required: without
    // `project_doc_max_bytes=0`, codex would load this repository instruction
    // file into the frozen clustering prompt, contaminating the benchmark with
    // workspace-derived context (SYMPH-1128).
    await writeFile(
      join(root, "AGENTS.md"),
      "# forbidden workspace-derived instructions\n",
      "utf8",
    );
    let captured: { command: string; args: readonly string[] } | null = null;
    const runner = createToolFreeClusteringPlannerRunner({
      model: "codex/gpt-5.6-sol",
      reasoningLevel: "high",
      workspace: root,
      artifactDir: join(root, "artifacts"),
      artifactName: "repeat-1",
      env: {},
      runProcess: async ({ command, args }) => {
        captured = { command, args };
        return { status: "completed", exitCode: 0, stdout: "{}", stderr: "" };
      },
    });

    await expect(runner("planner prompt")).resolves.toEqual({
      status: "ok",
      markdown: "{}",
    });
    if (captured === null) throw new Error("expected an invocation");
    const invocation = captured as { command: string; args: readonly string[] };
    expect(invocation.command).toBe("codex");
    // The exact supported config override that disables project-doc loading.
    expect(flagValues(invocation.args, "--config")).toContain(
      "project_doc_max_bytes=0",
    );
    // It sits inside the tool-free contract without disturbing the other pins.
    expect(invocation.args).toContain("--ignore-user-config");
    expect(flagValues(invocation.args, "--config")).toContain(
      'model_reasoning_effort="high"',
    );
  });

  it("reports codex boundary failures with the codex label", async () => {
    const root = await mkdtemp(join(tmpdir(), "clustering-tool-free-"));
    roots.push(root);
    const runner = createToolFreeClusteringPlannerRunner({
      model: "openai/gpt-5.6-sol",
      reasoningLevel: "high",
      workspace: root,
      artifactDir: join(root, "artifacts"),
      artifactName: "repeat-1",
      env: {},
      runProcess: async () => ({
        status: "completed",
        exitCode: 5,
        stdout: "",
        stderr: "codex unavailable",
      }),
    });

    await expect(runner("planner prompt")).resolves.toEqual({
      status: "unavailable",
      detail: "tool-free Codex exited 5: codex unavailable",
    });
  });

  it("returns unavailable without publishing a response artifact on failure", async () => {
    const root = await mkdtemp(join(tmpdir(), "clustering-tool-free-"));
    roots.push(root);
    const runner = createToolFreeClusteringPlannerRunner({
      model: "opus",
      reasoningLevel: "high",
      workspace: root,
      artifactDir: join(root, "artifacts"),
      artifactName: "repeat-1",
      env: {},
      runProcess: async () => ({
        status: "completed",
        exitCode: 7,
        stdout: "",
        stderr: "runner unavailable",
      }),
    });

    await expect(runner("planner prompt")).resolves.toEqual({
      status: "unavailable",
      detail: "tool-free Claude exited 7: runner unavailable",
    });
    await expect(
      readFile(join(root, "artifacts", "repeat-1.md"), "utf8"),
    ).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("normalizes early stdin pipe errors as unavailable", async () => {
    const root = await mkdtemp(join(tmpdir(), "clustering-tool-free-"));
    roots.push(root);
    const executable = join(root, "claude");
    await writeFile(
      executable,
      [
        "#!/usr/bin/env node",
        'require("node:fs").closeSync(0);',
        "setTimeout(() => process.exit(0), 50);",
        "",
      ].join("\n"),
      "utf8",
    );
    await chmod(executable, 0o755);
    const runner = createToolFreeClusteringPlannerRunner({
      model: "opus",
      reasoningLevel: "high",
      workspace: root,
      artifactDir: join(root, "artifacts"),
      artifactName: "repeat-1",
      env: { PATH: `${root}${delimiter}${process.env.PATH ?? ""}` },
    });

    const result = await runner("x".repeat(16 * 1024 * 1024));

    expect(result.status).toBe("unavailable");
    if (result.status !== "unavailable") throw new Error("expected failure");
    expect(result.detail).toContain("tool-free Claude");
    await expect(
      readFile(join(root, "artifacts", "repeat-1.md"), "utf8"),
    ).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("preserves timeouts when killing a non-reading child breaks stdin", async () => {
    const root = await mkdtemp(join(tmpdir(), "clustering-tool-free-"));
    roots.push(root);
    const executable = join(root, "claude");
    await writeFile(
      executable,
      ["#!/usr/bin/env node", "setTimeout(() => {}, 60_000);", ""].join("\n"),
      "utf8",
    );
    await chmod(executable, 0o755);
    const runner = createToolFreeClusteringPlannerRunner({
      model: "opus",
      reasoningLevel: "high",
      workspace: root,
      artifactDir: join(root, "artifacts"),
      artifactName: "repeat-1",
      env: { PATH: `${root}${delimiter}${process.env.PATH ?? ""}` },
      timeoutMs: 10,
    });

    await expect(runner("x".repeat(16 * 1024 * 1024))).resolves.toEqual({
      status: "unavailable",
      detail: "tool-free Claude timed out after 10ms",
    });
    await expect(
      readFile(join(root, "artifacts", "repeat-1.md"), "utf8"),
    ).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("bounds an injected process rejection as unavailable", async () => {
    const root = await mkdtemp(join(tmpdir(), "clustering-tool-free-"));
    roots.push(root);
    const runner = createToolFreeClusteringPlannerRunner({
      model: "opus",
      reasoningLevel: "high",
      workspace: root,
      artifactDir: join(root, "artifacts"),
      artifactName: "repeat-1",
      env: {},
      runProcess: async () => {
        throw new Error(`spawn failed ${"x".repeat(3_000)}`);
      },
    });

    const result = await runner("planner prompt");
    expect(result.status).toBe("unavailable");
    if (result.status !== "unavailable") throw new Error("expected failure");
    expect(result.detail).toMatch(
      /^tool-free Claude process failed: spawn failed/,
    );
    expect(result.detail.length).toBeLessThan(2_100);
    expect(result.detail.endsWith("…")).toBe(true);
    await expect(
      readFile(join(root, "artifacts", "repeat-1.md"), "utf8"),
    ).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("reports an injected timeout distinctly", async () => {
    const root = await mkdtemp(join(tmpdir(), "clustering-tool-free-"));
    roots.push(root);
    const runner = createToolFreeClusteringPlannerRunner({
      model: "opus",
      reasoningLevel: "high",
      workspace: root,
      artifactDir: join(root, "artifacts"),
      artifactName: "repeat-1",
      env: {},
      timeoutMs: 17,
      runProcess: async () => ({
        status: "timed_out",
        stdout: "partial",
        stderr: "killed",
      }),
    });

    await expect(runner("planner prompt")).resolves.toEqual({
      status: "unavailable",
      detail: "tool-free Claude timed out after 17ms",
    });
    await expect(
      readFile(join(root, "artifacts", "repeat-1.md"), "utf8"),
    ).rejects.toMatchObject({ code: "ENOENT" });
  });
});

function flagValues(args: readonly string[], flag: string): string[] {
  const values: string[] = [];
  for (let index = 0; index < args.length; index += 1) {
    if (args[index] !== flag) continue;
    const value = args[index + 1];
    if (value === undefined) throw new Error(`missing ${flag} value`);
    values.push(value);
  }
  return values;
}

function valueAfter(args: readonly string[], flag: string): string {
  const index = args.indexOf(flag);
  const value = args[index + 1];
  if (index === -1 || value === undefined) {
    throw new Error(`missing ${flag} value`);
  }
  return value;
}
