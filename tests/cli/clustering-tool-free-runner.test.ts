import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { createToolFreeClusteringPlannerRunner } from "../../src/cli/clustering-tool-free-runner.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

describe("tool-free clustering planner runner", () => {
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

  it("returns unavailable without publishing a response artifact on failure", async () => {
    const root = await mkdtemp(join(tmpdir(), "clustering-tool-free-"));
    roots.push(root);
    const runner = createToolFreeClusteringPlannerRunner({
      model: "opus",
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

  it("bounds an injected process rejection as unavailable", async () => {
    const root = await mkdtemp(join(tmpdir(), "clustering-tool-free-"));
    roots.push(root);
    const runner = createToolFreeClusteringPlannerRunner({
      model: "opus",
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

function valueAfter(args: readonly string[], flag: string): string {
  const index = args.indexOf(flag);
  const value = args[index + 1];
  if (index === -1 || value === undefined) {
    throw new Error(`missing ${flag} value`);
  }
  return value;
}
