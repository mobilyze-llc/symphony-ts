import {
  access,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  stat,
  utimes,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  CodexAppServerClient,
  type CodexAppServerClientError,
  type CodexClientEvent,
  sweepStaleCodexHomes,
} from "../../src/codex/app-server-client.js";
import { createLinearGraphqlDynamicTool } from "../../src/codex/linear-graphql-tool.js";
import { ERROR_CODES } from "../../src/errors/codes.js";
import { createModeScopedPermissionPolicy } from "../../src/policy/hard-stops.js";

const roots: string[] = [];
const clients: CodexAppServerClient[] = [];
const fixturePath = join(
  dirname(fileURLToPath(import.meta.url)),
  "../fixtures/codex-fake-server.mjs",
);

afterEach(async () => {
  await Promise.allSettled(
    clients.splice(0).map(async (client) => {
      await client.close();
    }),
  );
  await Promise.allSettled(
    roots.splice(0).map(async (root) => {
      await rm(root, { recursive: true, force: true });
    }),
  );
});

describe("CodexAppServerClient", () => {
  it("launches the app-server, buffers partial stdout lines, and auto-resolves approvals/tool calls", async () => {
    const workspace = await createWorkspace();
    const events: CodexClientEvent[] = [];
    const client = createClient("happy", workspace, events);

    const result = await client.startSession({
      prompt: "Implement the ticket",
      title: "ABC-123: Example",
    });

    expect(result).toMatchObject({
      status: "completed",
      threadId: "thread-1",
      turnId: "turn-1",
      sessionId: "thread-1-turn-1",
      usage: {
        inputTokens: 14,
        outputTokens: 9,
        totalTokens: 23,
        cacheReadTokens: 4,
        reasoningTokens: 2,
      },
      rateLimits: {
        requestsRemaining: 10,
        tokensRemaining: 1000,
      },
      message: "First turn finished",
    });

    expect(events.map((event) => event.event)).toContain("session_started");
    expect(events.map((event) => event.event)).toContain(
      "approval_auto_approved",
    );
    expect(events.map((event) => event.event)).toContain(
      "unsupported_tool_call",
    );
    expect(events.map((event) => event.event)).toContain("turn_completed");
    expect(events).toContainEqual(
      expect.objectContaining({
        event: "other_message",
        message: "diagnostic from stderr",
      } satisfies Partial<CodexClientEvent>),
    );
    expect(events).toContainEqual(
      expect.objectContaining({
        event: "notification",
        usage: {
          inputTokens: 11,
          outputTokens: 7,
          totalTokens: 18,
        },
      } satisfies Partial<CodexClientEvent>),
    );

    await client.close();
  });

  it("runs configured commands through a shell so Codex config quoting is preserved", async () => {
    const workspace = await createWorkspace();
    const events: CodexClientEvent[] = [];
    const command = [
      "assert_codex_args() {",
      '[ "$1" = "--config" ] &&',
      '[ "$2" = \'model_reasoning_effort="low"\' ] &&',
      '[ "$3" = "app-server" ];',
      "};",
      "assert_codex_args --config 'model_reasoning_effort=\"low\"' app-server &&",
      `exec ${shellQuote(process.execPath)} ${shellQuote(fixturePath)} happy`,
    ].join(" ");
    const client = createClient("happy", workspace, events, { command });

    const result = await client.startSession({
      prompt: "Verify quoted config launch",
      title: "ABC-123: Example",
    });

    expect(result.status).toBe("completed");

    await client.close();
  });

  it("launches Codex with an ephemeral auth-only CODEX_HOME when configured", async () => {
    const workspace = await createWorkspace();
    const sourceHome = await createWorkspace();
    await mkdir(sourceHome, { recursive: true });
    await writeFile(join(sourceHome, "auth.json"), "{}\n");

    const markerPath = join(workspace, "codex-home.txt");
    const previousCodexHome = process.env.CODEX_HOME;
    process.env.CODEX_HOME = sourceHome;
    try {
      const events: CodexClientEvent[] = [];
      const command = [
        `printf '%s' "$CODEX_HOME" > ${shellQuote(markerPath)}`,
        'test -L "$CODEX_HOME/auth.json"',
        `exec ${shellQuote(process.execPath)} ${shellQuote(fixturePath)} happy`,
      ].join(" && ");
      const client = createClient("happy", workspace, events, {
        command,
        ephemeralHome: true,
      });

      const result = await client.startSession({
        prompt: "Verify ephemeral Codex home",
        title: "ABC-123: Example",
      });

      expect(result.status).toBe("completed");
      const codexHome = (await readFile(markerPath, "utf8")).trim();
      expect(codexHome).not.toBe(sourceHome);
      expect(codexHome).toContain("symphony-codex-home-");
      await client.close();
      await expect(access(codexHome)).rejects.toThrow();
    } finally {
      if (previousCodexHome === undefined) {
        Reflect.deleteProperty(process.env, "CODEX_HOME");
      } else {
        process.env.CODEX_HOME = previousCodexHome;
      }
    }
  });

  it("reasserts ephemeral CODEX_HOME after login profiles are loaded", async () => {
    const workspace = await createWorkspace();
    const sourceHome = await createWorkspace();
    const profileHome = await createWorkspace();
    const profileCodexHome = await createWorkspace();
    await writeFile(join(sourceHome, "auth.json"), "{}\n");
    await writeFile(
      join(profileHome, ".bash_profile"),
      `export CODEX_HOME=${shellQuote(profileCodexHome)}\n`,
    );

    const markerPath = join(workspace, "codex-home.txt");
    const previousCodexHome = process.env.CODEX_HOME;
    const previousHome = process.env.HOME;
    process.env.CODEX_HOME = sourceHome;
    process.env.HOME = profileHome;
    try {
      const events: CodexClientEvent[] = [];
      const command = [
        `printf '%s' "$CODEX_HOME" > ${shellQuote(markerPath)}`,
        `exec ${shellQuote(process.execPath)} ${shellQuote(fixturePath)} happy`,
      ].join(" && ");
      const client = createClient("happy", workspace, events, {
        command,
        ephemeralHome: true,
      });

      const result = await client.startSession({
        prompt: "Verify profile CODEX_HOME isolation",
        title: "ABC-123: Example",
      });

      expect(result.status).toBe("completed");
      const codexHome = (await readFile(markerPath, "utf8")).trim();
      expect(codexHome).not.toBe(sourceHome);
      expect(codexHome).not.toBe(profileCodexHome);
      expect(codexHome).toContain("symphony-codex-home-");
      await client.close();
      await expect(access(codexHome)).rejects.toThrow();
    } finally {
      if (previousCodexHome === undefined) {
        Reflect.deleteProperty(process.env, "CODEX_HOME");
      } else {
        process.env.CODEX_HOME = previousCodexHome;
      }
      if (previousHome === undefined) {
        Reflect.deleteProperty(process.env, "HOME");
      } else {
        process.env.HOME = previousHome;
      }
    }
  });

  it("writes a headless denylist config into the ephemeral CODEX_HOME when configured", async () => {
    const workspace = await createWorkspace();
    const sourceHome = await createWorkspace();
    const userSkillRoot = join(sourceHome, "skills", "example");
    const systemSkillRoot = join(sourceHome, "skills", ".system", "future");
    await mkdir(userSkillRoot, { recursive: true });
    await mkdir(systemSkillRoot, { recursive: true });
    await writeFile(join(sourceHome, "auth.json"), "{}\n");
    await writeFile(
      join(userSkillRoot, "SKILL.md"),
      "---\nname: example\ndescription: example\n---\n",
    );
    await writeFile(
      join(systemSkillRoot, "SKILL.md"),
      "---\nname: future\ndescription: future\n---\n",
    );

    const markerPath = join(workspace, "codex-home.txt");
    const configPath = join(workspace, "codex-config.toml");
    const previousCodexHome = process.env.CODEX_HOME;
    process.env.CODEX_HOME = sourceHome;
    try {
      const events: CodexClientEvent[] = [];
      const command = [
        `printf '%s' "$CODEX_HOME" > ${shellQuote(markerPath)}`,
        `cp "$CODEX_HOME/config.toml" ${shellQuote(configPath)}`,
        `exec ${shellQuote(process.execPath)} ${shellQuote(fixturePath)} happy`,
      ].join(" && ");
      const client = createClient("happy", workspace, events, {
        command,
        ephemeralHome: true,
        disableSkills: true,
      });

      const result = await client.startSession({
        prompt: "Verify ephemeral skill config",
        title: "ABC-123: Example",
      });

      expect(result.status).toBe("completed");
      const codexHome = (await readFile(markerPath, "utf8")).trim();
      const config = await readFile(configPath, "utf8");
      const skillPath = await realpath(join(userSkillRoot, "SKILL.md"));
      expect(config).toContain("project_doc_max_bytes = 0");
      expect(config).toContain("[features]");
      expect(config).toContain("apps = false");
      expect(config).toContain("browser_use = false");
      expect(config).toContain("codex_hooks = false");
      expect(config).toContain("computer_use = false");
      expect(config).toContain("memories = false");
      expect(config).toContain("multi_agent = false");
      expect(config).toContain("plugins = false");
      expect(config).toContain("tool_call_mcp_elicitation = false");
      expect(config).toContain("[[skills.config]]");
      expect(config).toContain(`path = "${skillPath}"`);
      expect(config).toContain(
        `path = "${join(codexHome, "skills", ".system", "openai-docs", "SKILL.md")}"`,
      );
      expect(config).toContain(
        `path = "${join(codexHome, "skills", ".system", "future", "SKILL.md")}"`,
      );
      expect(config).toContain("enabled = false");
      await client.close();
      await expect(access(codexHome)).rejects.toThrow();
    } finally {
      if (previousCodexHome === undefined) {
        Reflect.deleteProperty(process.env, "CODEX_HOME");
      } else {
        process.env.CODEX_HOME = previousCodexHome;
      }
    }
  });

  it("fails clearly when ephemeral CODEX_HOME cannot read operator auth", async () => {
    const workspace = await createWorkspace();
    const sourceHome = await createWorkspace();
    const previousCodexHome = process.env.CODEX_HOME;
    process.env.CODEX_HOME = sourceHome;
    try {
      const events: CodexClientEvent[] = [];
      const client = createClient("happy", workspace, events, {
        ephemeralHome: true,
      });

      await expect(
        client.startSession({
          prompt: "Verify auth failure",
          title: "ABC-123: Example",
        }),
      ).rejects.toMatchObject({
        code: ERROR_CODES.codexLaunchFailed,
        message: expect.stringContaining("no readable auth.json"),
      });
    } finally {
      if (previousCodexHome === undefined) {
        Reflect.deleteProperty(process.env, "CODEX_HOME");
      } else {
        process.env.CODEX_HOME = previousCodexHome;
      }
    }
  });

  it("denies PR creation approvals when prototype mode cannot open pull requests", async () => {
    const workspace = await createWorkspace();
    const events: CodexClientEvent[] = [];
    const client = createClient("denied-pr", workspace, events, {
      modePolicy: createModeScopedPermissionPolicy({
        mode: "prototype",
        configuredApprovalPolicy: "full-auto",
        configuredThreadSandbox: "workspace-write",
        configuredTurnSandboxPolicy: { type: "workspace-write" },
        maxBudgetUsd: 50,
      }),
    });

    const result = await client.startSession({
      prompt: "Implement the ticket",
      title: "ABC-123: Example",
    });

    expect(result.message).toBe("PR command denied by mode policy");
    expect(events).toContainEqual(
      expect.objectContaining({
        event: "unsupported_tool_call",
        toolName: "Bash",
        message: expect.stringContaining("open_pull_request is not allowed"),
      } satisfies Partial<CodexClientEvent>),
    );
    expect(events.map((event) => event.event)).not.toContain(
      "approval_auto_approved",
    );

    await client.close();
  });

  it("reuses the same thread id across continuation turns", async () => {
    const workspace = await createWorkspace();
    const events: CodexClientEvent[] = [];
    const client = createClient("happy", workspace, events);

    const first = await client.startSession({
      prompt: "First prompt",
      title: "ABC-123: Example",
    });
    const second = await client.continueTurn(
      "Continue the same issue",
      "ABC-123: Example",
    );

    expect(first.threadId).toBe("thread-1");
    expect(second.threadId).toBe("thread-1");
    expect(second.turnId).toBe("turn-2");
    expect(second.sessionId).toBe("thread-1-turn-2");

    const started = events.filter((event) => event.event === "session_started");
    expect(started).toHaveLength(2);
    expect(started[0]?.threadId).toBe("thread-1");
    expect(started[1]?.threadId).toBe("thread-1");
    expect(started[1]?.turnId).toBe("turn-2");

    await client.close();
  });

  it("fails the turn when the app-server asks for user input", async () => {
    const workspace = await createWorkspace();
    const events: CodexClientEvent[] = [];
    const client = createClient("user-input", workspace, events);

    await expect(
      client.startSession({
        prompt: "Need help?",
        title: "ABC-123: Example",
      }),
    ).rejects.toMatchObject({
      name: "CodexAppServerClientError",
      code: ERROR_CODES.codexUserInputRequired,
    } satisfies Partial<CodexAppServerClientError>);

    expect(events).toContainEqual(
      expect.objectContaining({
        event: "turn_input_required",
        errorCode: ERROR_CODES.codexUserInputRequired,
      }),
    );

    await client.close();
  });

  it("accepts compatible approval and telemetry payload variants", async () => {
    const workspace = await createWorkspace();
    const events: CodexClientEvent[] = [];
    const client = createClient("payload-variants", workspace, events);

    const first = await client.startSession({
      prompt: "Use alternate payloads",
      title: "ABC-123: Example",
    });
    const second = await client.continueTurn(
      "Continue with alternate payloads",
      "ABC-123: Example",
    );

    expect(first.status).toBe("completed");
    expect(second).toMatchObject({
      status: "completed",
      usage: {
        inputTokens: 20,
        outputTokens: 10,
        totalTokens: 30, // computed from input + output when total_tokens absent
        cacheReadTokens: 5, // extracted from cache_read_input_tokens
      },
      rateLimits: {
        requests_remaining: 9,
        tokens_remaining: 999,
      },
    });
    expect(events.map((event) => event.event)).toContain(
      "approval_auto_approved",
    );

    await client.close();
  });

  it("does not attach cached usage to non-telemetry notifications", async () => {
    const workspace = await createWorkspace();
    const events: CodexClientEvent[] = [];
    const client = createClient(
      "usage-then-noisy-notification",
      workspace,
      events,
    );

    const result = await client.startSession({
      prompt: "Run a tiny task",
      title: "ABC-123: Example",
    });

    expect(result.usage).toEqual({
      inputTokens: 100,
      outputTokens: 50,
      totalTokens: 150,
    });
    expect(result.rateLimits).toEqual({
      requestsRemaining: 7,
    });

    const usageNotification = events.find(
      (event) =>
        event.event === "notification" &&
        event.message === "thread/tokenUsage/updated",
    );
    expect(usageNotification).toMatchObject({
      usage: {
        inputTokens: 100,
        outputTokens: 50,
        totalTokens: 150,
      },
    } satisfies Partial<CodexClientEvent>);

    const noisyNotification = events.find(
      (event) =>
        event.event === "notification" && event.message === "item/started",
    );
    expect(noisyNotification?.usage).toBeUndefined();

    const rateLimitNotification = events.find(
      (event) =>
        event.event === "notification" &&
        event.message === "account/rateLimits/updated",
    );
    expect(rateLimitNotification?.usage).toBeUndefined();
    expect(rateLimitNotification?.rateLimits).toEqual({
      requestsRemaining: 7,
    });

    const completed = events.find((event) => event.event === "turn_completed");
    expect(completed).toMatchObject({
      usage: {
        inputTokens: 100,
        outputTokens: 50,
        totalTokens: 150,
      },
    } satisfies Partial<CodexClientEvent>);

    await client.close();
  });

  it("does not carry prior turn usage into a new turn without fresh usage", async () => {
    const workspace = await createWorkspace();
    const events: CodexClientEvent[] = [];
    const client = createClient("usage-reset-between-turns", workspace, events);

    const first = await client.startSession({
      prompt: "First prompt",
      title: "ABC-123: Example",
    });
    const second = await client.continueTurn(
      "Continue without usage",
      "ABC-123: Example",
    );

    expect(first.usage).toMatchObject({
      inputTokens: 14,
      outputTokens: 9,
      totalTokens: 23,
    });
    expect(second.usage).toBeNull();

    const secondTurnEvents = events.filter(
      (event) => event.turnId === "turn-2",
    );
    expect(secondTurnEvents.some((event) => event.usage !== undefined)).toBe(
      false,
    );

    await client.close();
  });

  it("fails the turn when user-input-required is emitted through a compatible variant", async () => {
    const workspace = await createWorkspace();
    const events: CodexClientEvent[] = [];
    const client = createClient("user-input-variant", workspace, events);

    await expect(
      client.startSession({
        prompt: "Need help?",
        title: "ABC-123: Example",
      }),
    ).rejects.toMatchObject({
      name: "CodexAppServerClientError",
      code: ERROR_CODES.codexUserInputRequired,
    } satisfies Partial<CodexAppServerClientError>);

    expect(events).toContainEqual(
      expect.objectContaining({
        event: "turn_input_required",
        errorCode: ERROR_CODES.codexUserInputRequired,
      }),
    );

    await client.close();
  });

  it("does not treat prompt echoes containing user-input-required text as operator input", async () => {
    const workspace = await createWorkspace();
    const events: CodexClientEvent[] = [];
    const client = createClient(
      "prompt-echo-user-input-code",
      workspace,
      events,
    );

    const result = await client.startSession({
      prompt:
        "Investigate why codex_user_input_required appears in this issue description.",
      title: "ABC-123: Example",
    });

    expect(result).toMatchObject({
      status: "completed",
      message: "Prompt echo did not pause the turn",
    });
    expect(events.some((event) => event.event === "turn_input_required")).toBe(
      false,
    );

    await client.close();
  });

  it("does not treat prompt echoes containing approval text as approval requests", async () => {
    const workspace = await createWorkspace();
    const events: CodexClientEvent[] = [];
    const client = createClient("prompt-echo-approval-text", workspace, events);

    const result = await client.startSession({
      prompt: "Investigate why approval appears in this issue description.",
      title: "ABC-123: Example",
    });

    expect(result).toMatchObject({
      status: "completed",
      message: "Approval prompt echo did not trigger approval handling",
    });
    expect(
      events.some((event) => event.event === "approval_auto_approved"),
    ).toBe(false);

    await client.close();
  });

  it("fails the turn when a headless MCP server requests elicitation", async () => {
    const workspace = await createWorkspace();
    const events: CodexClientEvent[] = [];
    const client = createClient("mcp-elicitation", workspace, events);

    await expect(
      client.startSession({
        prompt: "Write a workpad.",
        title: "ABC-123: Example",
      }),
    ).rejects.toMatchObject({
      name: "CodexAppServerClientError",
      code: ERROR_CODES.codexUserInputRequired,
    } satisfies Partial<CodexAppServerClientError>);

    expect(events).toContainEqual(
      expect.objectContaining({
        event: "turn_input_required",
        errorCode: ERROR_CODES.codexUserInputRequired,
        raw: expect.objectContaining({
          method: "mcpServer/elicitation/request",
        }),
      }),
    );
    await waitForEvent(
      events,
      (event) =>
        event.event === "other_message" &&
        event.message === "mcp-elicitation response received",
    );

    await client.close();
  });

  it("fails the turn when an MCP elicitation create request is emitted", async () => {
    const workspace = await createWorkspace();
    const events: CodexClientEvent[] = [];
    const client = createClient("mcp-elicitation-create", workspace, events);

    await expect(
      client.startSession({
        prompt: "Write a workpad.",
        title: "ABC-123: Example",
      }),
    ).rejects.toMatchObject({
      name: "CodexAppServerClientError",
      code: ERROR_CODES.codexUserInputRequired,
    } satisfies Partial<CodexAppServerClientError>);

    expect(events).toContainEqual(
      expect.objectContaining({
        event: "turn_input_required",
        errorCode: ERROR_CODES.codexUserInputRequired,
        raw: expect.objectContaining({
          method: "elicitation/create",
        }),
      }),
    );
    await waitForEvent(
      events,
      (event) =>
        event.event === "other_message" &&
        event.message === "mcp-elicitation-create response received",
    );

    await client.close();
  });

  it("sends the required initialize, thread/start, and turn/start policy payloads", async () => {
    const workspace = await createWorkspace();
    const client = createClient("handshake", workspace, [], {
      threadSandbox: { type: "workspaceWrite" },
    });

    const result = await client.startSession({
      prompt: "Inspect startup payloads",
      title: "ABC-123: Example",
    });

    expect(result.status).toBe("completed");

    await client.close();
  });

  it("canonicalizes snake_case turn sandbox aliases before sending them", async () => {
    const workspace = await createWorkspace();
    const client = createClient("handshake-snake-aliases", workspace, [], {
      turnSandboxPolicy: {
        type: "workspace-write",
        writable_roots: [workspace],
        network_access: true,
        exclude_tmpdir_env_var: true,
        exclude_slash_tmp: true,
      },
    });

    const result = await client.startSession({
      prompt: "Inspect alias normalization",
      title: "ABC-123: Example",
    });

    expect(result.status).toBe("completed");

    await client.close();
  });

  it("rejects per-turn sandbox policy fields in thread sandbox objects", async () => {
    const workspace = await createWorkspace();
    const events: CodexClientEvent[] = [];
    const client = createClient("happy", workspace, events, {
      threadSandbox: {
        type: "workspace-write",
        networkAccess: true,
      },
    });

    await expect(
      client.startSession({
        prompt: "Start with an over-specified thread sandbox",
        title: "ABC-123: Example",
      }),
    ).rejects.toMatchObject({
      name: "CodexAppServerClientError",
      code: ERROR_CODES.codexProtocolError,
      message: expect.stringContaining(
        "thread/start sandbox only accepts a mode",
      ),
    } satisfies Partial<CodexAppServerClientError>);

    expect(events).toContainEqual(
      expect.objectContaining({
        event: "startup_failed",
        errorCode: ERROR_CODES.codexProtocolError,
      } satisfies Partial<CodexClientEvent>),
    );

    await client.close();
  });

  it("rejects unknown thread sandbox modes before thread/start", async () => {
    const workspace = await createWorkspace();
    const events: CodexClientEvent[] = [];
    const client = createClient("happy", workspace, events, {
      threadSandbox: "workspace-writes",
    });

    await expect(
      client.startSession({
        prompt: "Start with an unknown thread sandbox",
        title: "ABC-123: Example",
      }),
    ).rejects.toMatchObject({
      name: "CodexAppServerClientError",
      code: ERROR_CODES.codexProtocolError,
      message: expect.stringContaining(
        'Unsupported Codex thread/start sandbox type "workspace-writes"',
      ),
    } satisfies Partial<CodexAppServerClientError>);

    expect(events).toContainEqual(
      expect.objectContaining({
        event: "startup_failed",
        errorCode: ERROR_CODES.codexProtocolError,
      } satisfies Partial<CodexClientEvent>),
    );

    await client.close();
  });

  it("rejects unknown turn sandbox policy modes before turn/start", async () => {
    const workspace = await createWorkspace();
    const events: CodexClientEvent[] = [];
    const client = createClient("happy", workspace, events, {
      turnSandboxPolicy: {
        type: "readOnlyy",
      },
    });

    await expect(
      client.startSession({
        prompt: "Start with an unknown turn sandbox",
        title: "ABC-123: Example",
      }),
    ).rejects.toMatchObject({
      name: "CodexAppServerClientError",
      code: ERROR_CODES.codexProtocolError,
      message: expect.stringContaining(
        'Unsupported Codex turn/start sandboxPolicy type "readOnlyy"',
      ),
    } satisfies Partial<CodexAppServerClientError>);

    expect(events.map((event) => event.event)).not.toContain("session_started");

    await client.close();
  });

  it("surfaces JSON-RPC response errors from the app-server", async () => {
    const workspace = await createWorkspace();
    const events: CodexClientEvent[] = [];
    const client = createClient("json-rpc-error", workspace, events);

    await expect(
      client.startSession({
        prompt: "Start with a protocol error",
        title: "ABC-123: Example",
      }),
    ).rejects.toMatchObject({
      name: "CodexAppServerClientError",
      code: ERROR_CODES.codexProtocolError,
      message: expect.stringContaining(
        "Codex app-server turn/start error -32600",
      ),
    } satisfies Partial<CodexAppServerClientError>);

    expect(events.map((event) => event.event)).not.toContain("session_started");

    await client.close();
  });

  it("advertises and executes the linear_graphql dynamic tool", async () => {
    const workspace = await createWorkspace();
    const events: CodexClientEvent[] = [];
    const fetchFn = vi.fn<typeof fetch>().mockResolvedValue(
      jsonResponse({
        data: {
          viewer: {
            id: "viewer-1",
            name: "Example User",
          },
        },
      }),
    );
    const client = createClient("linear-tool", workspace, events, {
      dynamicTools: [
        createLinearGraphqlDynamicTool({
          endpoint: "https://api.linear.app/graphql",
          apiKey: "linear-token",
          fetchFn,
        }),
      ],
    });

    const result = await client.startSession({
      prompt: "Use the tracker tool",
      title: "ABC-123: Example",
    });

    expect(result.status).toBe("completed");
    expect(fetchFn).toHaveBeenCalledTimes(1);
    expect(events.map((event) => event.event)).not.toContain(
      "unsupported_tool_call",
    );

    await client.close();
  });

  it("enforces read timeouts during the startup handshake", async () => {
    const workspace = await createWorkspace();
    const events: CodexClientEvent[] = [];
    const client = createClient("read-timeout", workspace, events, {
      readTimeoutMs: 50,
    });

    await expect(
      client.startSession({
        prompt: "Start",
        title: "ABC-123: Example",
      }),
    ).rejects.toMatchObject({
      name: "CodexAppServerClientError",
      code: ERROR_CODES.codexReadTimeout,
    } satisfies Partial<CodexAppServerClientError>);

    expect(events).toContainEqual(
      expect.objectContaining({
        event: "startup_failed",
      }),
    );
  });

  it("enforces per-turn timeouts after turn/start succeeds", async () => {
    const workspace = await createWorkspace();
    const events: CodexClientEvent[] = [];
    const client = createClient("turn-timeout", workspace, events, {
      turnTimeoutMs: 60,
      stallTimeoutMs: 500,
    });

    await expect(
      client.startSession({
        prompt: "Hang forever",
        title: "ABC-123: Example",
      }),
    ).rejects.toMatchObject({
      name: "CodexAppServerClientError",
      code: ERROR_CODES.codexTurnTimeout,
    } satisfies Partial<CodexAppServerClientError>);

    expect(events).toContainEqual(
      expect.objectContaining({
        event: "turn_ended_with_error",
        errorCode: ERROR_CODES.codexTurnTimeout,
      }),
    );

    await client.close();
  });

  it("disables stall detection when stallTimeoutMs is zero", async () => {
    const workspace = await createWorkspace();
    const events: CodexClientEvent[] = [];
    const client = createClient("turn-timeout", workspace, events, {
      stallTimeoutMs: 0,
      turnTimeoutMs: 50,
    });

    await expect(
      client.startSession({
        prompt: "Wait for turn timeout",
        title: "ABC-123: Example",
      }),
    ).rejects.toMatchObject({
      name: "CodexAppServerClientError",
      code: ERROR_CODES.codexTurnTimeout,
    } satisfies Partial<CodexAppServerClientError>);

    expect(events).toContainEqual(
      expect.objectContaining({
        event: "turn_ended_with_error",
        errorCode: ERROR_CODES.codexTurnTimeout,
      }),
    );
    expect(events).not.toContainEqual(
      expect.objectContaining({
        event: "turn_ended_with_error",
        errorCode: ERROR_CODES.codexSessionStalled,
      }),
    );

    await client.close();
  });
});

function createClient(
  scenario: string,
  workspace: string,
  events: CodexClientEvent[],
  overrides?: Partial<{
    readTimeoutMs: number;
    turnTimeoutMs: number;
    stallTimeoutMs: number;
    modePolicy: ConstructorParameters<
      typeof CodexAppServerClient
    >[0]["modePolicy"];
    dynamicTools: NonNullable<
      ConstructorParameters<typeof CodexAppServerClient>[0]["dynamicTools"]
    >;
    command: string;
    ephemeralHome: boolean;
    disableSkills: boolean;
    threadSandbox: ConstructorParameters<
      typeof CodexAppServerClient
    >[0]["threadSandbox"];
    turnSandboxPolicy: ConstructorParameters<
      typeof CodexAppServerClient
    >[0]["turnSandboxPolicy"];
  }>,
): CodexAppServerClient {
  const client = new CodexAppServerClient({
    command:
      overrides?.command ?? `${process.execPath} "${fixturePath}" ${scenario}`,
    ...(overrides?.ephemeralHome === undefined
      ? {}
      : { ephemeralHome: overrides.ephemeralHome }),
    ...(overrides?.disableSkills === undefined
      ? {}
      : { disableSkills: overrides.disableSkills }),
    cwd: workspace,
    approvalPolicy: "full-auto",
    threadSandbox: overrides?.threadSandbox ?? "workspace-write",
    turnSandboxPolicy: overrides?.turnSandboxPolicy ?? {
      type: "workspace-write",
    },
    // Generous defaults: these bound failure detection, not happy-path
    // speed. Tight values (750ms initialize) flaked under parallel-suite
    // load (SYMPH-313); tests that assert timeout behavior pass explicit
    // small overrides.
    readTimeoutMs: overrides?.readTimeoutMs ?? 10_000,
    turnTimeoutMs: overrides?.turnTimeoutMs ?? 10_000,
    stallTimeoutMs: overrides?.stallTimeoutMs ?? 10_000,
    ...(overrides?.modePolicy === undefined
      ? {}
      : { modePolicy: overrides.modePolicy }),
    ...(overrides?.dynamicTools === undefined
      ? {}
      : { dynamicTools: overrides.dynamicTools }),
    onEvent: (event) => {
      events.push(event);
    },
  });
  clients.push(client);
  return client;
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json",
    },
  });
}

async function createWorkspace(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "symphony-task9-"));
  const workspace = join(root, "ABC-123");
  await mkdir(workspace, { recursive: true });
  roots.push(root);
  return workspace;
}

async function waitForEvent(
  events: CodexClientEvent[],
  predicate: (event: CodexClientEvent) => boolean,
  timeoutMs = 500,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() <= deadline) {
    if (events.some(predicate)) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(
    `Timed out waiting for event. Seen events: ${events
      .map((event) => event.event)
      .join(", ")}`,
  );
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

describe("sweepStaleCodexHomes", () => {
  const MAX_AGE_MS = 48 * 60 * 60 * 1000;

  async function backdate(path: string, ageMs: number): Promise<void> {
    const past = new Date(Date.now() - ageMs);
    await utimes(path, past, past);
  }

  it("removes only stale symphony-codex-home directories", async () => {
    const root = await mkdtemp(join(tmpdir(), "symphony-sweep-test-"));
    roots.push(root);
    const stale = join(root, "symphony-codex-home-stale");
    const fresh = join(root, "symphony-codex-home-fresh");
    const unrelated = join(root, "unrelated-dir");
    await mkdir(join(stale, "sessions"), { recursive: true });
    await writeFile(join(stale, "config.toml"), "");
    await mkdir(fresh, { recursive: true });
    await mkdir(unrelated, { recursive: true });
    await backdate(stale, MAX_AGE_MS + 60 * 60 * 1000);
    await backdate(unrelated, MAX_AGE_MS + 60 * 60 * 1000);

    const removed = await sweepStaleCodexHomes({
      root,
      maxAgeMs: MAX_AGE_MS,
      now: () => Date.now(),
    });

    expect(removed).toEqual([stale]);
    await expect(access(stale)).rejects.toThrow();
    await expect(access(fresh)).resolves.toBeUndefined();
    await expect(access(unrelated)).resolves.toBeUndefined();
  });

  it("treats age exactly equal to maxAgeMs as fresh", async () => {
    const root = await mkdtemp(join(tmpdir(), "symphony-sweep-test-"));
    roots.push(root);
    const boundary = join(root, "symphony-codex-home-boundary");
    await mkdir(boundary, { recursive: true });
    await backdate(boundary, MAX_AGE_MS);
    // Pin the injected clock to the dir's actual mtime so the delta is
    // exactly maxAgeMs — the real clock would drift past the boundary.
    const mtimeMs = (await stat(boundary)).mtimeMs;

    const removed = await sweepStaleCodexHomes({
      root,
      maxAgeMs: MAX_AGE_MS,
      now: () => mtimeMs + MAX_AGE_MS,
    });

    expect(removed).toEqual([]);
    await expect(access(boundary)).resolves.toBeUndefined();
  });

  it("ignores plain files that match the prefix", async () => {
    const root = await mkdtemp(join(tmpdir(), "symphony-sweep-test-"));
    roots.push(root);
    const file = join(root, "symphony-codex-home-file");
    await writeFile(file, "");
    await backdate(file, MAX_AGE_MS + 60 * 60 * 1000);

    const removed = await sweepStaleCodexHomes({
      root,
      maxAgeMs: MAX_AGE_MS,
      now: () => Date.now(),
    });

    expect(removed).toEqual([]);
    await expect(access(file)).resolves.toBeUndefined();
  });

  it("returns empty for a missing root", async () => {
    const removed = await sweepStaleCodexHomes({
      root: join(tmpdir(), "symphony-sweep-test-does-not-exist"),
      maxAgeMs: MAX_AGE_MS,
      now: () => Date.now(),
    });
    expect(removed).toEqual([]);
  });
});
