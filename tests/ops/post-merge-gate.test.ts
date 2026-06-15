import { execFileSync, spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import {
  type IncomingMessage,
  type ServerResponse,
  createServer,
} from "node:http";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const __dirname = dirname(fileURLToPath(import.meta.url));
const SCRIPT_PATH = resolve(__dirname, "../../scripts/post-merge-gate.mjs");
const WORKFLOW_PATH = resolve(
  __dirname,
  "../../.github/workflows/post-merge-gate.yml",
);

let tmpDir: string;

function makeTmpDir(): string {
  const dir = join(
    tmpdir(),
    `post-merge-gate-test-${randomBytes(6).toString("hex")}`,
  );
  mkdirSync(dir, { recursive: true });
  return dir;
}

function writePackageVersion(version: string): string {
  const packageJson = join(tmpDir, "package.json");
  writeFileSync(packageJson, `${JSON.stringify({ version }, null, 2)}\n`);
  return packageJson;
}

function runScript(args: string[], env: Record<string, string> = {}): string {
  return execFileSync(process.execPath, [SCRIPT_PATH, ...args], {
    encoding: "utf8",
    env: { ...process.env, ...env },
    timeout: 15_000,
  });
}

function runScriptAsync(
  args: string[],
  env: Record<string, string> = {},
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  return new Promise((resolveProcess) => {
    const child = spawn(process.execPath, [SCRIPT_PATH, ...args], {
      env: { ...process.env, ...env },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
    }, 15_000);

    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    child.on("error", (error) => {
      clearTimeout(timer);
      resolveProcess({
        stdout,
        stderr: `${stderr}${error.message}`,
        exitCode: 1,
      });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolveProcess({ stdout, stderr, exitCode: code ?? 1 });
    });
  });
}

function readRequestBody(request: IncomingMessage): Promise<string> {
  return new Promise((resolveRequest) => {
    let body = "";
    request.on("data", (chunk: Buffer) => {
      body += chunk.toString();
    });
    request.on("end", () => resolveRequest(body));
  });
}

function writeJson(response: ServerResponse, body: unknown): void {
  response.writeHead(200, { "Content-Type": "application/json" });
  response.end(JSON.stringify(body));
}

const postMergeGateEnv = {
  LINEAR_API_KEY: "test-key",
  GITHUB_SHA: "abc1234deadbeefabc1234deadbeefabc1234d",
  GITHUB_SERVER_URL: "https://github.com",
  GITHUB_REPOSITORY: "mobilyze-llc/symphony-ts",
  GITHUB_RUN_ID: "27181480681",
  POST_MERGE_GATE_PR_NUMBER: "280",
  STEP_LINT_OUTCOME: "success",
  STEP_TYPECHECK_OUTCOME: "success",
  STEP_TEST_OUTCOME: "failure",
  STEP_BUILD_OUTCOME: "success",
  STEP_CALVER_OUTCOME: "skipped",
};

function existingGateIssue(
  overrides: {
    id?: string;
    identifier?: string;
    title?: string;
    description?: string;
    stateType?: string;
  } = {},
): Record<string, unknown> {
  return {
    id: overrides.id ?? "existing-issue",
    identifier: overrides.identifier ?? "SYMPH-888",
    url: "https://linear.app/mobilyze-llc/issue/SYMPH-888/existing-halt",
    title:
      overrides.title ?? "pipeline-halt: post-merge gate failure on abc1234",
    description:
      overrides.description ??
      "<!-- post-merge-gate sha=abc1234deadbeefabc1234deadbeefabc1234d pr=280 -->\n\n## Post-Merge Gate Failure",
    state: { type: overrides.stateType ?? "started" },
  };
}

describe("post-merge gate helper", () => {
  beforeEach(() => {
    tmpDir = makeTmpDir();
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("computes the next calver without mutating package.json", () => {
    const packageJson = writePackageVersion("2026.06.09.2");

    const output = runScript([
      "calver-plan",
      "--json",
      "--package-json",
      packageJson,
      "--today",
      "2026.06.09",
    ]);

    expect(JSON.parse(output)).toMatchObject({
      currentVersion: "2026.06.09.2",
      nextVersion: "2026.06.09.3",
      mode: "non_blocking",
      trackingIssue: "SYMPH-267",
    });
    expect(JSON.parse(readFileSync(packageJson, "utf8")).version).toBe(
      "2026.06.09.2",
    );
  });

  it("builds Linear issue requests through GraphQL variables after lookup miss", async () => {
    const requests: Array<{
      query: string;
      variables: Record<string, unknown>;
    }> = [];
    const server = createServer(async (request, response) => {
      const body = JSON.parse(await readRequestBody(request));
      requests.push(body);

      if (body.query.includes("PostMergeGateLookup")) {
        writeJson(response, {
          data: {
            teams: { nodes: [{ id: "team-symph" }] },
            issueLabels: { nodes: [{ id: "label-halt" }] },
          },
        });
      } else if (body.query.includes("FindExistingPipelineHaltIssues")) {
        writeJson(response, {
          data: {
            issues: { nodes: [] },
          },
        });
      } else if (body.query.includes("CreatePipelineHaltIssue")) {
        writeJson(response, {
          data: {
            issueCreate: {
              success: true,
              issue: {
                id: "issue-1",
                identifier: "SYMPH-999",
                url: "https://linear.app/mobilyze-llc/issue/SYMPH-999/test",
              },
            },
          },
        });
      } else {
        writeJson(response, { errors: [{ message: "unexpected query" }] });
      }
    });

    await new Promise<void>((resolveServer) => {
      server.listen(0, "127.0.0.1", resolveServer);
    });

    try {
      const address = server.address();
      if (!address || typeof address === "string") {
        throw new Error("Expected an IPv4 test server address.");
      }

      const result = await runScriptAsync(["linear-failure-issue", "--json"], {
        ...postMergeGateEnv,
        LINEAR_ENDPOINT: `http://127.0.0.1:${address.port}/graphql`,
      });

      expect(result).toMatchObject({ exitCode: 0, stderr: "" });
      expect(JSON.parse(result.stdout).identifier).toBe("SYMPH-999");
      expect(JSON.parse(result.stdout).action).toBe("created");
      expect(
        requests.some((request) =>
          request.query.includes("FindExistingPipelineHaltIssues"),
        ),
      ).toBe(true);
      const createIssueRequest = requests.find((request) =>
        request.query.includes("CreatePipelineHaltIssue"),
      );
      expect(createIssueRequest?.variables).toMatchObject({
        input: {
          teamId: "team-symph",
          title: "pipeline-halt: post-merge gate failure on abc1234",
          labelIds: ["label-halt"],
        },
      });
      const input = createIssueRequest?.variables.input as {
        description: string;
      };
      expect(input.description).toContain(
        "<!-- post-merge-gate sha=abc1234deadbeefabc1234deadbeefabc1234d pr=280 -->",
      );
      expect(input.description).toContain("**PR:** #280");
      expect(input.description).toContain(
        "**Run:** https://github.com/mobilyze-llc/symphony-ts/actions/runs/27181480681",
      );
      expect(input.description).toContain("- Test");
    } finally {
      await new Promise<void>((resolveClose) => {
        server.close(() => resolveClose());
      });
    }
  });

  it("comments on an existing same-SHA post-merge halt instead of creating a duplicate", async () => {
    const requests: Array<{
      query: string;
      variables: Record<string, unknown>;
    }> = [];
    const server = createServer(async (request, response) => {
      const body = JSON.parse(await readRequestBody(request));
      requests.push(body);

      if (body.query.includes("PostMergeGateLookup")) {
        writeJson(response, {
          data: {
            teams: { nodes: [{ id: "team-symph" }] },
            issueLabels: { nodes: [{ id: "label-halt" }] },
          },
        });
      } else if (body.query.includes("FindExistingPipelineHaltIssues")) {
        writeJson(response, {
          data: {
            issues: { nodes: [existingGateIssue()] },
          },
        });
      } else if (body.query.includes("CommentExistingPipelineHaltIssue")) {
        writeJson(response, {
          data: {
            commentCreate: {
              success: true,
              comment: { id: "comment-1", url: "https://linear/comment-1" },
            },
          },
        });
      } else {
        writeJson(response, { errors: [{ message: "unexpected query" }] });
      }
    });

    await new Promise<void>((resolveServer) => {
      server.listen(0, "127.0.0.1", resolveServer);
    });

    try {
      const address = server.address();
      if (!address || typeof address === "string") {
        throw new Error("Expected an IPv4 test server address.");
      }

      const result = await runScriptAsync(["linear-failure-issue", "--json"], {
        ...postMergeGateEnv,
        LINEAR_ENDPOINT: `http://127.0.0.1:${address.port}/graphql`,
      });

      expect(result).toMatchObject({ exitCode: 0, stderr: "" });
      expect(JSON.parse(result.stdout)).toMatchObject({
        identifier: "SYMPH-888",
        action: "updated",
      });
      expect(
        requests.some((request) =>
          request.query.includes("CreatePipelineHaltIssue"),
        ),
      ).toBe(false);
      const commentRequest = requests.find((request) =>
        request.query.includes("CommentExistingPipelineHaltIssue"),
      );
      expect(commentRequest?.variables).toMatchObject({
        input: {
          issueId: "existing-issue",
        },
      });
      const input = commentRequest?.variables.input as { body: string };
      expect(input.body).toContain(
        "https://github.com/mobilyze-llc/symphony-ts/actions/runs/27181480681",
      );
      expect(input.body).toContain("- Test");
    } finally {
      await new Promise<void>((resolveClose) => {
        server.close(() => resolveClose());
      });
    }
  });

  it("round-trips its generated post-merge marker through existing issue lookup", async () => {
    const requests: Array<{
      query: string;
      variables: Record<string, unknown>;
    }> = [];
    let createdDescription = "missing generated post-merge marker";
    let lookupCount = 0;
    const server = createServer(async (request, response) => {
      const body = JSON.parse(await readRequestBody(request));
      requests.push(body);

      if (body.query.includes("PostMergeGateLookup")) {
        writeJson(response, {
          data: {
            teams: { nodes: [{ id: "team-symph" }] },
            issueLabels: { nodes: [{ id: "label-halt" }] },
          },
        });
      } else if (body.query.includes("FindExistingPipelineHaltIssues")) {
        lookupCount += 1;
        writeJson(response, {
          data: {
            issues: {
              nodes:
                lookupCount === 1
                  ? []
                  : [
                      existingGateIssue({
                        description: createdDescription,
                      }),
                    ],
            },
          },
        });
      } else if (body.query.includes("CreatePipelineHaltIssue")) {
        const input = body.variables.input as { description: string };
        createdDescription = input.description;
        writeJson(response, {
          data: {
            issueCreate: {
              success: true,
              issue: {
                id: "issue-1",
                identifier: "SYMPH-999",
                url: "https://linear.app/mobilyze-llc/issue/SYMPH-999/test",
              },
            },
          },
        });
      } else if (body.query.includes("CommentExistingPipelineHaltIssue")) {
        writeJson(response, {
          data: {
            commentCreate: {
              success: true,
              comment: { id: "comment-1", url: "https://linear/comment-1" },
            },
          },
        });
      } else {
        writeJson(response, { errors: [{ message: "unexpected query" }] });
      }
    });

    await new Promise<void>((resolveServer) => {
      server.listen(0, "127.0.0.1", resolveServer);
    });

    try {
      const address = server.address();
      if (!address || typeof address === "string") {
        throw new Error("Expected an IPv4 test server address.");
      }
      const env = {
        ...postMergeGateEnv,
        LINEAR_ENDPOINT: `http://127.0.0.1:${address.port}/graphql`,
      };

      const firstResult = await runScriptAsync(
        ["linear-failure-issue", "--json"],
        env,
      );
      const secondResult = await runScriptAsync(
        ["linear-failure-issue", "--json"],
        env,
      );

      expect(firstResult).toMatchObject({ exitCode: 0, stderr: "" });
      expect(secondResult).toMatchObject({ exitCode: 0, stderr: "" });
      expect(JSON.parse(firstResult.stdout).action).toBe("created");
      expect(JSON.parse(secondResult.stdout).action).toBe("updated");
      expect(createdDescription).toContain("<!-- post-merge-gate sha=");
      expect(
        requests.filter((request) =>
          request.query.includes("CreatePipelineHaltIssue"),
        ),
      ).toHaveLength(1);
      expect(
        requests.filter((request) =>
          request.query.includes("CommentExistingPipelineHaltIssue"),
        ),
      ).toHaveLength(1);
    } finally {
      await new Promise<void>((resolveClose) => {
        server.close(() => resolveClose());
      });
    }
  });

  it("comments on an existing same-PR post-merge halt even when the SHA differs", async () => {
    const requests: Array<{
      query: string;
      variables: Record<string, unknown>;
    }> = [];
    const server = createServer(async (request, response) => {
      const body = JSON.parse(await readRequestBody(request));
      requests.push(body);

      if (body.query.includes("PostMergeGateLookup")) {
        writeJson(response, {
          data: {
            teams: { nodes: [{ id: "team-symph" }] },
            issueLabels: { nodes: [{ id: "label-halt" }] },
          },
        });
      } else if (body.query.includes("FindExistingPipelineHaltIssues")) {
        writeJson(response, {
          data: {
            issues: {
              nodes: [
                existingGateIssue({
                  description:
                    "<!-- post-merge-gate sha=fffffffdeadbeefabc1234deadbeefabc1234d pr=280 -->",
                }),
              ],
            },
          },
        });
      } else if (body.query.includes("CommentExistingPipelineHaltIssue")) {
        writeJson(response, {
          data: {
            commentCreate: {
              success: true,
              comment: { id: "comment-1", url: "https://linear/comment-1" },
            },
          },
        });
      } else {
        writeJson(response, { errors: [{ message: "unexpected query" }] });
      }
    });

    await new Promise<void>((resolveServer) => {
      server.listen(0, "127.0.0.1", resolveServer);
    });

    try {
      const address = server.address();
      if (!address || typeof address === "string") {
        throw new Error("Expected an IPv4 test server address.");
      }

      const result = await runScriptAsync(["linear-failure-issue", "--json"], {
        ...postMergeGateEnv,
        LINEAR_ENDPOINT: `http://127.0.0.1:${address.port}/graphql`,
      });

      expect(result).toMatchObject({ exitCode: 0, stderr: "" });
      expect(JSON.parse(result.stdout)).toMatchObject({
        identifier: "SYMPH-888",
        action: "updated",
      });
      expect(
        requests.some((request) =>
          request.query.includes("CreatePipelineHaltIssue"),
        ),
      ).toBe(false);
    } finally {
      await new Promise<void>((resolveClose) => {
        server.close(() => resolveClose());
      });
    }
  });

  it("ignores foreign pipeline-halt issues without the post-merge marker", async () => {
    const requests: Array<{
      query: string;
      variables: Record<string, unknown>;
    }> = [];
    const server = createServer(async (request, response) => {
      const body = JSON.parse(await readRequestBody(request));
      requests.push(body);

      if (body.query.includes("PostMergeGateLookup")) {
        writeJson(response, {
          data: {
            teams: { nodes: [{ id: "team-symph" }] },
            issueLabels: { nodes: [{ id: "label-halt" }] },
          },
        });
      } else if (body.query.includes("FindExistingPipelineHaltIssues")) {
        writeJson(response, {
          data: {
            issues: {
              nodes: [
                existingGateIssue({
                  title: "Pipeline Halt",
                  description: "Operator pause; no post-merge marker.",
                }),
              ],
            },
          },
        });
      } else if (body.query.includes("CreatePipelineHaltIssue")) {
        writeJson(response, {
          data: {
            issueCreate: {
              success: true,
              issue: {
                id: "issue-1",
                identifier: "SYMPH-999",
                url: "https://linear.app/mobilyze-llc/issue/SYMPH-999/test",
              },
            },
          },
        });
      } else {
        writeJson(response, { errors: [{ message: "unexpected query" }] });
      }
    });

    await new Promise<void>((resolveServer) => {
      server.listen(0, "127.0.0.1", resolveServer);
    });

    try {
      const address = server.address();
      if (!address || typeof address === "string") {
        throw new Error("Expected an IPv4 test server address.");
      }

      const result = await runScriptAsync(["linear-failure-issue", "--json"], {
        ...postMergeGateEnv,
        LINEAR_ENDPOINT: `http://127.0.0.1:${address.port}/graphql`,
      });

      expect(result).toMatchObject({ exitCode: 0, stderr: "" });
      expect(JSON.parse(result.stdout)).toMatchObject({
        identifier: "SYMPH-999",
        action: "created",
      });
      expect(
        requests.some((request) =>
          request.query.includes("CommentExistingPipelineHaltIssue"),
        ),
      ).toBe(false);
    } finally {
      await new Promise<void>((resolveClose) => {
        server.close(() => resolveClose());
      });
    }
  });

  it("fails closed when the existing issue lookup is malformed", async () => {
    const requests: Array<{
      query: string;
      variables: Record<string, unknown>;
    }> = [];
    const server = createServer(async (request, response) => {
      const body = JSON.parse(await readRequestBody(request));
      requests.push(body);

      if (body.query.includes("PostMergeGateLookup")) {
        writeJson(response, {
          data: {
            teams: { nodes: [{ id: "team-symph" }] },
            issueLabels: { nodes: [{ id: "label-halt" }] },
          },
        });
      } else if (body.query.includes("FindExistingPipelineHaltIssues")) {
        writeJson(response, {
          data: {
            issues: { nodes: null },
          },
        });
      } else {
        writeJson(response, { errors: [{ message: "unexpected query" }] });
      }
    });

    await new Promise<void>((resolveServer) => {
      server.listen(0, "127.0.0.1", resolveServer);
    });

    try {
      const address = server.address();
      if (!address || typeof address === "string") {
        throw new Error("Expected an IPv4 test server address.");
      }

      const result = await runScriptAsync(["linear-failure-issue", "--json"], {
        ...postMergeGateEnv,
        LINEAR_ENDPOINT: `http://127.0.0.1:${address.port}/graphql`,
      });

      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain(
        "::error::Malformed Linear issue lookup response",
      );
      expect(
        requests.some((request) =>
          request.query.includes("CreatePipelineHaltIssue"),
        ),
      ).toBe(false);
    } finally {
      await new Promise<void>((resolveClose) => {
        server.close(() => resolveClose());
      });
    }
  });

  it("fails closed when an existing issue lookup node is malformed", async () => {
    const requests: Array<{
      query: string;
      variables: Record<string, unknown>;
    }> = [];
    const server = createServer(async (request, response) => {
      const body = JSON.parse(await readRequestBody(request));
      requests.push(body);

      if (body.query.includes("PostMergeGateLookup")) {
        writeJson(response, {
          data: {
            teams: { nodes: [{ id: "team-symph" }] },
            issueLabels: { nodes: [{ id: "label-halt" }] },
          },
        });
      } else if (body.query.includes("FindExistingPipelineHaltIssues")) {
        writeJson(response, {
          data: {
            issues: {
              nodes: [
                {
                  ...existingGateIssue(),
                  description: null,
                },
              ],
            },
          },
        });
      } else {
        writeJson(response, { errors: [{ message: "unexpected query" }] });
      }
    });

    await new Promise<void>((resolveServer) => {
      server.listen(0, "127.0.0.1", resolveServer);
    });

    try {
      const address = server.address();
      if (!address || typeof address === "string") {
        throw new Error("Expected an IPv4 test server address.");
      }

      const result = await runScriptAsync(["linear-failure-issue", "--json"], {
        ...postMergeGateEnv,
        LINEAR_ENDPOINT: `http://127.0.0.1:${address.port}/graphql`,
      });

      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain(
        "::error::Malformed Linear issue lookup node",
      );
      expect(
        requests.some((request) =>
          request.query.includes("CreatePipelineHaltIssue"),
        ),
      ).toBe(false);
    } finally {
      await new Promise<void>((resolveClose) => {
        server.close(() => resolveClose());
      });
    }
  });

  it("keeps the workflow free of direct main pushes", () => {
    const workflow = readFileSync(WORKFLOW_PATH, "utf8");

    expect(workflow).toContain("contents: read");
    expect(workflow).toContain(
      "node scripts/post-merge-gate.mjs calver-plan --summary",
    );
    expect(workflow).not.toContain("git push");
    expect(workflow).not.toContain("git commit");
    expect(workflow).not.toContain("git reset --soft");
  });
});
