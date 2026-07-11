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
        '      ["ANTHROPIC_API_KEY", "LINEAR_API_KEY", "SYMPHONY_LINEAR_WEBHOOK_SECRET", "GH_TOKEN", "GH_ENTERPRISE_TOKEN", "GITHUB_TOKEN", "GITHUB_APP_PRIVATE_KEY", "SLACK_BOT_TOKEN", "SLACK_APP_TOKEN", "SLACK_WEBHOOK_URL", "SYMPHONY_SLACK_WEBHOOK_URL"].includes(name),',
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
        SYMPHONY_LINEAR_WEBHOOK_SECRET: "linear-webhook-secret",
        GH_TOKEN: "github-secret",
        GH_ENTERPRISE_TOKEN: "github-enterprise-secret",
        GITHUB_TOKEN: "github-secret-2",
        GITHUB_APP_PRIVATE_KEY: "github-private-key",
        SLACK_BOT_TOKEN: "slack-secret",
        SLACK_APP_TOKEN: "slack-secret-2",
        SLACK_WEBHOOK_URL: "slack-webhook-secret",
        SYMPHONY_SLACK_WEBHOOK_URL: "symphony-slack-webhook-secret",
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
    expect(processBoundary.env).not.toHaveProperty(
      "SYMPHONY_LINEAR_WEBHOOK_SECRET",
    );
    expect(processBoundary.env).not.toHaveProperty("GH_TOKEN");
    expect(processBoundary.env).not.toHaveProperty("GH_ENTERPRISE_TOKEN");
    expect(processBoundary.env).not.toHaveProperty("GITHUB_TOKEN");
    expect(processBoundary.env).not.toHaveProperty("GITHUB_APP_PRIVATE_KEY");
    expect(processBoundary.env).not.toHaveProperty("SLACK_BOT_TOKEN");
    expect(processBoundary.env).not.toHaveProperty("SLACK_APP_TOKEN");
    expect(processBoundary.env).not.toHaveProperty("SLACK_WEBHOOK_URL");
    expect(processBoundary.env).not.toHaveProperty(
      "SYMPHONY_SLACK_WEBHOOK_URL",
    );
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
});

function valueAfter(args: readonly string[], flag: string): string {
  const index = args.indexOf(flag);
  const value = args[index + 1];
  if (index === -1 || value === undefined) {
    throw new Error(`missing ${flag} value`);
  }
  return value;
}
