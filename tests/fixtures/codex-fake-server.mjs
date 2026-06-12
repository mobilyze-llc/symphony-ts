import { mkdirSync, realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import process from "node:process";
import readline from "node:readline";

const scenario = process.argv[2] ?? "happy";
const handshakeScenario = scenario.startsWith("handshake");
const requests = [];
let turnCount = 0;

const rl = readline.createInterface({
  input: process.stdin,
  crlfDelay: Number.POSITIVE_INFINITY,
});

rl.on("line", async (line) => {
  if (line.trim().length === 0) {
    return;
  }

  const message = JSON.parse(line);
  requests.push(message);

  try {
    await handleMessage(message);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
});

async function handleMessage(message) {
  if (message.method === "initialize") {
    if (scenario === "read-timeout") {
      return;
    }

    if (handshakeScenario) {
      assertEqual(
        message.params.clientInfo?.name,
        "symphony-ts",
        "initialize must include clientInfo.name",
      );
      assertEqual(
        typeof message.params.clientInfo?.version,
        "string",
        "initialize must include clientInfo.version",
      );
      assertEqual(
        typeof message.params.capabilities,
        "object",
        "initialize must include a capabilities object",
      );
    }

    writeJson({
      id: message.id,
      result: {
        serverInfo: {
          name: "fake-codex",
        },
      },
    });
    return;
  }

  if (message.method === "thread/start") {
    assertEqual(
      realpathSync(process.cwd()),
      realpathSync(message.params.cwd),
      "spawn cwd must equal request cwd",
    );
    if (scenario === "linear-tool") {
      assertEqual(
        message.params.tools?.[0]?.name,
        "linear_graphql",
        "thread/start must advertise linear_graphql",
      );
    }
    if (handshakeScenario) {
      assertEqual(
        message.params.approvalPolicy,
        "never",
        "thread/start must include approvalPolicy",
      );
      assertEqual(
        message.params.sandbox,
        "workspace-write",
        "thread/start must include thread sandbox policy",
      );
    }
    writeJson({
      id: message.id,
      result: {
        thread: {
          id: "thread-1",
        },
      },
    });
    return;
  }

  if (message.method === "turn/start") {
    turnCount += 1;
    if (scenario === "session-artifact" && process.env.CODEX_HOME) {
      const sessionDir = join(process.env.CODEX_HOME, "sessions", "2026");
      mkdirSync(sessionDir, { recursive: true });
      writeFileSync(
        join(sessionDir, "rollout-test.jsonl"),
        `${JSON.stringify({ type: "token_usage", input_tokens: 12, output_tokens: 3, total_tokens: 15 })}\n`,
      );
    }
    assertEqual(message.params.threadId, "thread-1", "threadId must be reused");
    assertEqual(
      realpathSync(process.cwd()),
      realpathSync(message.params.cwd),
      "turn cwd must equal workspace path",
    );
    assertEqual(
      message.params.input?.[0]?.type,
      "text",
      "turn input must contain a single text item",
    );
    if (handshakeScenario) {
      assertEqual(
        message.params.approvalPolicy,
        "never",
        "turn/start must include approvalPolicy",
      );
      assertEqual(
        message.params.sandboxPolicy?.type,
        "workspaceWrite",
        "turn/start must include per-turn sandbox policy",
      );
      assertEqual(
        Array.isArray(message.params.sandboxPolicy?.writableRoots),
        true,
        "turn/start workspace sandbox must include writableRoots",
      );
      assertEqual(
        message.params.sandboxPolicy?.networkAccess,
        scenario === "handshake-snake-aliases",
        "turn/start workspace sandbox must include networkAccess",
      );
      if (scenario === "handshake-snake-aliases") {
        assertEqual(
          message.params.sandboxPolicy?.writableRoots?.[0],
          message.params.cwd,
          "turn/start workspace sandbox must canonicalize writableRoots",
        );
        assertEqual(
          message.params.sandboxPolicy?.networkAccess,
          true,
          "turn/start workspace sandbox must canonicalize networkAccess",
        );
        assertEqual(
          message.params.sandboxPolicy?.excludeTmpdirEnvVar,
          true,
          "turn/start workspace sandbox must canonicalize excludeTmpdirEnvVar",
        );
        assertEqual(
          message.params.sandboxPolicy?.excludeSlashTmp,
          true,
          "turn/start workspace sandbox must canonicalize excludeSlashTmp",
        );
        assertEqual(
          "writable_roots" in message.params.sandboxPolicy,
          false,
          "turn/start workspace sandbox must strip writable_roots",
        );
        assertEqual(
          "network_access" in message.params.sandboxPolicy,
          false,
          "turn/start workspace sandbox must strip network_access",
        );
        assertEqual(
          "exclude_tmpdir_env_var" in message.params.sandboxPolicy,
          false,
          "turn/start workspace sandbox must strip exclude_tmpdir_env_var",
        );
        assertEqual(
          "exclude_slash_tmp" in message.params.sandboxPolicy,
          false,
          "turn/start workspace sandbox must strip exclude_slash_tmp",
        );
      }
    }

    if (scenario === "json-rpc-error") {
      writeJson({
        id: message.id,
        error: {
          code: -32600,
          message: "Invalid request: unknown variant `workspace-write`",
        },
      });
      return;
    }

    writeJson({
      id: message.id,
      result: {
        turn: {
          id: `turn-${turnCount}`,
        },
      },
    });

    if (scenario === "turn-timeout") {
      return;
    }

    if (scenario === "exit-mid-turn") {
      // SYMPH-412: the app-server dies while the turn is still streaming.
      setTimeout(() => {
        process.exit(1);
      }, 10);
      return;
    }

    if (scenario === "agent-message-item") {
      setTimeout(() => {
        writeJson({
          method: "item/agentMessage/delta",
          params: {
            delta: "Investigation complete.",
          },
        });
        writeJson({
          method: "item/completed",
          params: {
            item: {
              type: "agentMessage",
              text: "Investigation complete.\n\n[STAGE_COMPLETE]",
            },
          },
        });
        // Real codex-cli 0.135 shape: turn/completed carries usage only,
        // never the agent message (SYMPH-350).
        writeJson({
          method: "turn/completed",
          params: {
            usage: {
              inputTokens: 21,
              outputTokens: 8,
              totalTokens: 29,
            },
          },
        });
      }, 10);
      return;
    }

    if (scenario === "usage-then-noisy-notification") {
      setTimeout(() => {
        writeJson({
          method: "thread/tokenUsage/updated",
          params: {
            usage: {
              inputTokens: 100,
              outputTokens: 50,
              totalTokens: 150,
            },
          },
        });
        writeJson({
          method: "item/started",
          params: {
            item: {
              type: "tool_call",
              name: "Bash",
            },
          },
        });
        writeJson({
          method: "account/rateLimits/updated",
          params: {
            rateLimits: {
              requestsRemaining: 7,
            },
          },
        });
        writeJson({
          method: "turn/completed",
          params: {
            message: "Noisy turn finished",
          },
        });
      }, 10);
      return;
    }

    if (scenario === "codex-cached-usage") {
      setTimeout(() => {
        // Real codex app-server v2 usage shape: the cached share is named
        // cachedInputTokens (camelCase notification) / cached_input_tokens
        // (rollout snake_case), not cache_read_tokens. The two payloads use
        // DIFFERENT cached/reasoning values so each alias is pinned
        // independently — the notification event must carry 41000/7 and the
        // turn result 56064/12.
        writeJson({
          method: "thread/tokenUsage/updated",
          params: {
            usage: {
              inputTokens: 67419,
              cachedInputTokens: 41000,
              outputTokens: 598,
              totalTokens: 68017,
              reasoningOutputTokens: 7,
            },
          },
        });
        writeJson({
          method: "turn/completed",
          params: {
            message: "Cached usage turn finished",
            usage: {
              input_tokens: 81831,
              cached_input_tokens: 56064,
              output_tokens: 681,
              total_tokens: 82512,
              reasoning_output_tokens: 12,
            },
          },
        });
      }, 10);
      return;
    }

    if (scenario === "usage-reset-between-turns" && turnCount === 2) {
      setTimeout(() => {
        writeJson({
          method: "item/started",
          params: {
            item: {
              type: "tool_call",
              name: "Bash",
            },
          },
        });
        writeJson({
          method: "turn/completed",
          params: {
            message: "Second turn without usage",
          },
        });
      }, 10);
      return;
    }

    if (scenario === "user-input") {
      setTimeout(() => {
        writeJson({
          method: "turn/input_required",
          params: {
            reason: "Please confirm.",
          },
        });
      }, 10);
      return;
    }

    if (scenario === "user-input-variant") {
      setTimeout(() => {
        writeJson({
          method: "turn/user_input_required",
          params: {
            reason: "Please confirm.",
          },
        });
      }, 10);
      return;
    }

    if (scenario === "prompt-echo-user-input-code") {
      setTimeout(() => {
        writeJson({
          method: "item/started",
          params: {
            item: {
              type: "userMessage",
              content: [
                {
                  type: "text",
                  text: "Issue text mentions codex_user_input_required but is not a protocol request.",
                },
              ],
            },
          },
        });
        writeJson({
          method: "item/completed",
          params: {
            item: {
              type: "userMessage",
              content: [
                {
                  type: "text",
                  text: "Issue text mentions codex_user_input_required but is not a protocol request.",
                },
              ],
            },
          },
        });
        writeJson({
          method: "turn/completed",
          params: {
            message: "Prompt echo did not pause the turn",
            usage: {
              inputTokens: 12,
              outputTokens: 4,
              totalTokens: 16,
            },
          },
        });
      }, 10);
      return;
    }

    if (scenario === "prompt-echo-approval-text") {
      setTimeout(() => {
        writeJson({
          method: "item/started",
          params: {
            item: {
              type: "userMessage",
              content: [
                {
                  type: "text",
                  text: "Issue text mentions approval but is not an approval request.",
                },
              ],
            },
          },
        });
        writeJson({
          method: "item/completed",
          params: {
            item: {
              type: "userMessage",
              content: [
                {
                  type: "text",
                  text: "Issue text mentions approval but is not an approval request.",
                },
              ],
            },
          },
        });
        writeJson({
          method: "turn/completed",
          params: {
            message: "Approval prompt echo did not trigger approval handling",
            usage: {
              inputTokens: 12,
              outputTokens: 4,
              totalTokens: 16,
            },
          },
        });
      }, 10);
      return;
    }

    if (scenario === "mcp-elicitation") {
      setTimeout(() => {
        writeJson({
          id: "elicitation-1",
          method: "mcpServer/elicitation/request",
          params: {
            server: "linear",
            requestId: "elicitation-1",
            prompt: "Confirm Linear comment write.",
          },
        });
      }, 10);
      return;
    }

    if (scenario === "mcp-elicitation-create") {
      setTimeout(() => {
        writeJson({
          id: "elicitation-1",
          method: "elicitation/create",
          params: {
            requestId: "elicitation-1",
            message: "Confirm Linear comment write.",
          },
        });
      }, 10);
      return;
    }

    if (scenario === "late-tool-exit") {
      setTimeout(() => {
        writeJson({
          id: "late-tool-1",
          method: "item/tool/call",
          params: {
            toolName: "slow_tool",
            input: {},
          },
        });
        setTimeout(() => {
          writeJson({
            method: "turn/completed",
            params: {
              message: "Exiting before tool response",
            },
          });
          setTimeout(() => {
            process.exit(0);
          }, 5);
        }, 5);
      }, 10);
      return;
    }

    if (turnCount === 1) {
      setTimeout(() => {
        process.stderr.write("diagnostic from stderr\n");

        writePartialJson({
          method: "turn/update",
          params: {
            total_token_usage: {
              input_tokens: 11,
              output_tokens: 7,
              total_tokens: 18,
            },
          },
        });

        setTimeout(() => {
          writeJson({
            id: "approval-1",
            method:
              scenario === "payload-variants"
                ? "turn/approval_required"
                : "approval/request",
            params:
              scenario === "denied-pr"
                ? {
                    kind: "command_execution",
                    toolName: "Bash",
                    input: {
                      command: "gh pr create --fill",
                    },
                  }
                : scenario === "broad-rg-denied"
                  ? {
                      kind: "command_execution",
                      toolName: "Bash",
                      input: {
                        command:
                          'rg -n "token_telemetry|codex|running" src ops -m 80',
                      },
                    }
                  : {
                      kind: "command_execution",
                    },
          });
        }, 10);
      }, 10);
      return;
    }

    setTimeout(() => {
      writeJson({
        method: "turn/completed",
        params: {
          message: "Second turn finished",
          result:
            scenario === "payload-variants"
              ? {
                  telemetry: {
                    usage: {
                      input_tokens: 20,
                      output_tokens: 10,
                      cache_read_input_tokens: 5,
                    },
                  },
                  rate_limits: {
                    requests_remaining: 9,
                    tokens_remaining: 999,
                  },
                }
              : {
                  rate_limits: {
                    requests_remaining: 9,
                    tokens_remaining: 999,
                  },
                },
          ...(scenario === "payload-variants"
            ? {}
            : {
                usage: {
                  inputTokens: 20,
                  outputTokens: 10,
                  totalTokens: 30,
                },
              }),
        },
      });
    }, 10);
    return;
  }

  if (message.id === "approval-1") {
    if (scenario === "denied-pr" || scenario === "broad-rg-denied") {
      assertEqual(
        message.result?.decision,
        "decline",
        "denied approval must send the Codex decision field",
      );
      assertEqual(
        message.result?.approved,
        false,
        "denied approval must be denied",
      );

      setTimeout(() => {
        writeJson({
          method: "turn/completed",
          params: {
            message:
              scenario === "broad-rg-denied"
                ? "Broad rg command denied by output guard"
                : "PR command denied by mode policy",
            usage: {
              inputTokens: 14,
              outputTokens: 9,
              totalTokens: 23,
            },
          },
        });
      }, 10);
      return;
    }

    assertEqual(
      message.result?.decision,
      "accept",
      "approval must send the Codex decision field",
    );
    assertEqual(
      message.result?.approved,
      true,
      "approval must be auto-approved",
    );

    setTimeout(() => {
      writeJson({
        id: "tool-1",
        method: "item/tool/call",
        params: {
          toolName:
            scenario === "linear-tool" ? "linear_graphql" : "not_supported",
          input:
            scenario === "linear-tool"
              ? {
                  query: "query Viewer { viewer { id name } }",
                  variables: {
                    includeArchived: false,
                  },
                }
              : undefined,
        },
      });
    }, 10);
    return;
  }

  if (message.id === "tool-1") {
    if (scenario === "linear-tool") {
      assertEqual(
        message.result?.success,
        true,
        "supported linear_graphql tool call must succeed",
      );
      assertEqual(
        message.result?.response?.body?.data?.viewer?.id,
        "viewer-1",
        "linear_graphql tool must return the GraphQL response body",
      );
    } else {
      assertEqual(
        message.result?.success,
        false,
        "unsupported tool calls must return success=false",
      );
    }

    setTimeout(() => {
      writeJson({
        method: "turn/completed",
        params: {
          message: "First turn finished",
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
        },
      });
    }, 10);
    return;
  }

  if (message.id === "elicitation-1") {
    assertEqual(
      message.error?.data?.code,
      "codex_user_input_required",
      "elicitation requests must receive a user-input-required error response",
    );
    process.stderr.write(`${scenario} response received\n`);
  }
}

function writeJson(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

function writePartialJson(message) {
  const encoded = `${JSON.stringify(message)}\n`;
  const halfway = Math.floor(encoded.length / 2);
  process.stdout.write(encoded.slice(0, halfway));
  setTimeout(() => {
    process.stdout.write(encoded.slice(halfway));
  }, 5);
}

function assertEqual(actual, expected, message) {
  if (actual !== expected) {
    throw new Error(`${message}: expected ${expected}, received ${actual}`);
  }
}
