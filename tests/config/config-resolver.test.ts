import { homedir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  resolveStagesConfig,
  resolveWorkflowConfig,
  validateDispatchConfig,
  validateStagesConfig,
} from "../../src/config/config-resolver.js";
import {
  DEFAULT_CODEX_COMMAND,
  DEFAULT_CODEX_MAX_HEALTHY_COMPACTIONS_PER_STAGE,
  DEFAULT_CODEX_MODEL_AUTO_COMPACT_TOKEN_LIMIT,
  DEFAULT_CODEX_SESSION_ROTATION_INPUT_TOKENS,
  DEFAULT_CODEX_TOOL_OUTPUT_TOKEN_LIMIT,
  DEFAULT_CODE_GROUNDING_BASE_DIR,
  DEFAULT_CODE_GROUNDING_ENABLED,
  DEFAULT_CODE_GROUNDING_MATERIALIZATION_TIMEOUT_MS,
  DEFAULT_CODE_GROUNDING_MAX_CHECKOUTS_PER_REPO,
  DEFAULT_CODE_GROUNDING_TTL_MS,
  DEFAULT_CONTINUOUS_FEEDBACK_BOUNCE_ON_FINDING,
  DEFAULT_CONTINUOUS_FEEDBACK_ENABLED,
  DEFAULT_CONTINUOUS_FEEDBACK_EVENTS,
  DEFAULT_CONTINUOUS_FEEDBACK_MODEL,
  DEFAULT_CONTINUOUS_FEEDBACK_ROLE,
  DEFAULT_CONTINUOUS_FEEDBACK_RUNNER,
  DEFAULT_HARD_STOP_CACHED_TOKEN_COST_RATIO,
  DEFAULT_HARD_STOP_ESTIMATED_COST_PER_1K_TOKENS_USD,
  DEFAULT_HARD_STOP_LIVE_BUDGET_GRACE_RATIO,
  DEFAULT_HARD_STOP_MAX_DOLLAR_BUDGET_USD,
  DEFAULT_HARD_STOP_MAX_ITERATIONS,
  DEFAULT_HARD_STOP_MAX_TOKENS_PER_UNIT,
  DEFAULT_HARD_STOP_NO_PROGRESS_TURNS,
  DEFAULT_HARD_STOP_PREMIUM_BUDGET_PAUSE_RATIO,
  DEFAULT_HOOK_TIMEOUT_MS,
  DEFAULT_MAX_CONCURRENT_AGENTS,
  DEFAULT_MAX_RETRY_BACKOFF_MS,
  DEFAULT_MAX_TURNS,
  DEFAULT_MERGE_ACTUATOR_MAX_DRAFT_WAIT_OBSERVATIONS,
  DEFAULT_MERGE_ACTUATOR_MAX_LIVE_STATE_FAILURES,
  DEFAULT_MERGE_ACTUATOR_MAX_PENDING_CHECKS_WAIT_OBSERVATIONS,
  DEFAULT_MERGE_ACTUATOR_MAX_SIDE_EFFECT_FAILURES,
  DEFAULT_MERGE_ACTUATOR_MAX_UNKNOWN_MERGEABILITY_WAIT_OBSERVATIONS,
  DEFAULT_MERGE_ACTUATOR_MAX_WAIT_MS,
  DEFAULT_OBSERVABILITY_ENABLED,
  DEFAULT_OBSERVABILITY_REFRESH_MS,
  DEFAULT_OBSERVABILITY_RENDER_INTERVAL_MS,
  DEFAULT_POLL_INTERVAL_MS,
  DEFAULT_READ_TIMEOUT_MS,
  DEFAULT_RISK_PREDICATE_REASONING_EFFORT,
  DEFAULT_STALL_TIMEOUT_MS,
  DEFAULT_TURN_TIMEOUT_MS,
  DEFAULT_WORKSPACE_ROOT,
} from "../../src/config/defaults.js";
import { ERROR_CODES } from "../../src/errors/codes.js";

describe("config-resolver", () => {
  it("applies spec defaults when workflow config is empty", () => {
    const resolved = resolveWorkflowConfig({
      workflowPath: "/repo/WORKFLOW.md",
      config: {},
      promptTemplate: "Prompt",
    });

    expect(resolved.tracker.kind).toBe("linear");
    expect(resolved.tracker.endpoint).toBe("https://api.linear.app/graphql");
    expect(resolved.tracker.activeStates).toEqual([
      "Todo",
      "In Progress",
      "In Review",
      "Resume",
    ]);
    expect(resolved.tracker.terminalStates).toEqual([
      "Closed",
      "Cancelled",
      "Canceled",
      "Duplicate",
      "Done",
    ]);
    expect(resolved.polling.intervalMs).toBe(DEFAULT_POLL_INTERVAL_MS);
    expect(resolved.workspace.root).toBe(DEFAULT_WORKSPACE_ROOT);
    expect(resolved.hooks.timeoutMs).toBe(DEFAULT_HOOK_TIMEOUT_MS);
    expect(resolved.agent.maxConcurrentAgents).toBe(
      DEFAULT_MAX_CONCURRENT_AGENTS,
    );
    expect(resolved.agent.maxTurns).toBe(DEFAULT_MAX_TURNS);
    expect(resolved.agent.maxRetryBackoffMs).toBe(DEFAULT_MAX_RETRY_BACKOFF_MS);
    expect(resolved.hardStops).toEqual({
      maxIterations: DEFAULT_HARD_STOP_MAX_ITERATIONS,
      noProgressTurns: DEFAULT_HARD_STOP_NO_PROGRESS_TURNS,
      maxTokensPerUnit: DEFAULT_HARD_STOP_MAX_TOKENS_PER_UNIT,
      maxDollarBudgetUsd: DEFAULT_HARD_STOP_MAX_DOLLAR_BUDGET_USD,
      premiumBudgetPauseRatio: DEFAULT_HARD_STOP_PREMIUM_BUDGET_PAUSE_RATIO,
      liveBudgetGraceRatio: DEFAULT_HARD_STOP_LIVE_BUDGET_GRACE_RATIO,
      estimatedCostPer1kTokensUsd:
        DEFAULT_HARD_STOP_ESTIMATED_COST_PER_1K_TOKENS_USD,
      cachedTokenCostRatio: DEFAULT_HARD_STOP_CACHED_TOKEN_COST_RATIO,
      maxPrimaryWindowPctPerUnit: null,
      maxSecondaryWindowPctPerUnit: null,
    });
    expect(resolved.rateLimitAdmission).toEqual({
      minPrimaryHeadroomPct: null,
      minSecondaryHeadroomPct: null,
      deferUntilReset: false,
      expectedUnitBurnPct: null,
      deferJitterMs: 0,
      snapshotMaxAgeMs: 21_600_000,
    });
    expect(resolved.riskPredicateReasoning).toEqual({
      effort: DEFAULT_RISK_PREDICATE_REASONING_EFFORT,
    });
    expect(resolved.codex.command).toBe(DEFAULT_CODEX_COMMAND);
    expect(resolved.codex.turnTimeoutMs).toBe(DEFAULT_TURN_TIMEOUT_MS);
    expect(resolved.codex.readTimeoutMs).toBe(DEFAULT_READ_TIMEOUT_MS);
    expect(resolved.codex.stallTimeoutMs).toBe(DEFAULT_STALL_TIMEOUT_MS);
    expect(resolved.codex.sessionRotationInputTokens).toBe(
      DEFAULT_CODEX_SESSION_ROTATION_INPUT_TOKENS,
    );
    expect(resolved.codex.toolOutputTokenLimit).toBe(
      DEFAULT_CODEX_TOOL_OUTPUT_TOKEN_LIMIT,
    );
    expect(resolved.codex.modelAutoCompactTokenLimit).toBe(
      DEFAULT_CODEX_MODEL_AUTO_COMPACT_TOKEN_LIMIT,
    );
    expect(resolved.codex.maxHealthyCompactionsPerStage).toBe(
      DEFAULT_CODEX_MAX_HEALTHY_COMPACTIONS_PER_STAGE,
    );
    expect(resolved.continuousFeedback).toEqual({
      enabled: DEFAULT_CONTINUOUS_FEEDBACK_ENABLED,
      events: [...DEFAULT_CONTINUOUS_FEEDBACK_EVENTS],
      runner: DEFAULT_CONTINUOUS_FEEDBACK_RUNNER,
      model: DEFAULT_CONTINUOUS_FEEDBACK_MODEL,
      role: DEFAULT_CONTINUOUS_FEEDBACK_ROLE,
      bounceOnFinding: DEFAULT_CONTINUOUS_FEEDBACK_BOUNCE_ON_FINDING,
      preflightFailClosed: false,
    });
    expect(resolved.observability.dashboardEnabled).toBe(
      DEFAULT_OBSERVABILITY_ENABLED,
    );
    expect(resolved.observability.refreshMs).toBe(
      DEFAULT_OBSERVABILITY_REFRESH_MS,
    );
    expect(resolved.observability.renderIntervalMs).toBe(
      DEFAULT_OBSERVABILITY_RENDER_INTERVAL_MS,
    );
    expect(resolved.server.slackNotifyChannel).toBeNull();
    expect(resolved.operatorAnchors).toEqual({
      operatorAllowlist: [],
      serviceAccounts: [],
      fieldName: null,
      ingestSecret: null,
    });
    expect(resolved.codeGrounding).toEqual({
      enabled: DEFAULT_CODE_GROUNDING_ENABLED,
      baseDir: DEFAULT_CODE_GROUNDING_BASE_DIR,
      ttlMs: DEFAULT_CODE_GROUNDING_TTL_MS,
      maxCheckoutsPerRepo: DEFAULT_CODE_GROUNDING_MAX_CHECKOUTS_PER_REPO,
      materializationTimeoutMs:
        DEFAULT_CODE_GROUNDING_MATERIALIZATION_TIMEOUT_MS,
    });
    expect(DEFAULT_CODE_GROUNDING_BASE_DIR).toBe(".symphony/code-grounding");
    expect(resolved.mergeActuator).toEqual({
      enabled: false,
      autoMerge: false,
      maxWaitMs: DEFAULT_MERGE_ACTUATOR_MAX_WAIT_MS,
      maxLiveStateFailures: DEFAULT_MERGE_ACTUATOR_MAX_LIVE_STATE_FAILURES,
      maxSideEffectFailures: DEFAULT_MERGE_ACTUATOR_MAX_SIDE_EFFECT_FAILURES,
      maxDraftWaitObservations:
        DEFAULT_MERGE_ACTUATOR_MAX_DRAFT_WAIT_OBSERVATIONS,
      maxPendingChecksWaitObservations:
        DEFAULT_MERGE_ACTUATOR_MAX_PENDING_CHECKS_WAIT_OBSERVATIONS,
      maxUnknownMergeabilityWaitObservations:
        DEFAULT_MERGE_ACTUATOR_MAX_UNKNOWN_MERGEABILITY_WAIT_OBSERVATIONS,
    });
    // Documented numeric defaults (SYMPH-735/752/755): pinned literals so a
    // drift in defaults.ts is caught here, not just mirrored through the constant.
    expect(resolved.mergeActuator?.enabled).toBe(false);
    // SYMPH-754: the auto-merge permission is default-CLOSED.
    expect(resolved.mergeActuator?.autoMerge).toBe(false);
    expect(DEFAULT_MERGE_ACTUATOR_MAX_WAIT_MS).toBe(3_600_000);
    expect(DEFAULT_MERGE_ACTUATOR_MAX_LIVE_STATE_FAILURES).toBe(5);
    expect(DEFAULT_MERGE_ACTUATOR_MAX_SIDE_EFFECT_FAILURES).toBe(3);
    expect(DEFAULT_MERGE_ACTUATOR_MAX_DRAFT_WAIT_OBSERVATIONS).toBe(20);
    expect(DEFAULT_MERGE_ACTUATOR_MAX_PENDING_CHECKS_WAIT_OBSERVATIONS).toBe(
      30,
    );
    expect(
      DEFAULT_MERGE_ACTUATOR_MAX_UNKNOWN_MERGEABILITY_WAIT_OBSERVATIONS,
    ).toBe(20);
  });

  it("resolves merge actuator config from frontmatter", () => {
    const resolved = resolveWorkflowConfig({
      workflowPath: "/repo/WORKFLOW.md",
      promptTemplate: "Prompt",
      config: {
        merge_actuator: {
          enabled: true,
          auto_merge: true,
          max_wait_ms: 123,
          max_live_state_failures: 7,
          max_side_effect_failures: 4,
          max_draft_wait_observations: 9,
          max_pending_checks_wait_observations: 11,
          max_unknown_mergeability_wait_observations: 13,
        },
      },
    });

    expect(resolved.mergeActuator).toEqual({
      enabled: true,
      autoMerge: true,
      maxWaitMs: 123,
      maxLiveStateFailures: 7,
      maxSideEffectFailures: 4,
      maxDraftWaitObservations: 9,
      maxPendingChecksWaitObservations: 11,
      maxUnknownMergeabilityWaitObservations: 13,
    });
  });

  it("keeps the actuator auto-merge permission closed unless granted exactly true (SYMPH-754)", () => {
    // enabled without an explicit auto_merge grant: the actuator runs but must
    // NOT have enqueue permission — default-CLOSED.
    const ungranted = resolveWorkflowConfig({
      workflowPath: "/repo/WORKFLOW.md",
      promptTemplate: "Prompt",
      config: {
        merge_actuator: {
          enabled: true,
        },
      },
    });
    expect(ungranted.mergeActuator?.enabled).toBe(true);
    expect(ungranted.mergeActuator?.autoMerge).toBe(false);

    // A truthy-but-non-boolean grant must not open it.
    const stringy = resolveWorkflowConfig({
      workflowPath: "/repo/WORKFLOW.md",
      promptTemplate: "Prompt",
      config: {
        merge_actuator: {
          enabled: true,
          auto_merge: "true",
        },
      },
    });
    expect(stringy.mergeActuator?.autoMerge).toBe(false);
  });

  it("keeps the merge actuator disabled unless enabled is exactly true", () => {
    const resolved = resolveWorkflowConfig({
      workflowPath: "/repo/WORKFLOW.md",
      promptTemplate: "Prompt",
      config: {
        merge_actuator: {
          enabled: "true",
        },
      },
    });

    // enabled must default false unless strictly boolean true; bad numeric
    // overrides fall back to the documented defaults.
    expect(resolved.mergeActuator?.enabled).toBe(false);
    expect(resolved.mergeActuator?.maxWaitMs).toBe(
      DEFAULT_MERGE_ACTUATOR_MAX_WAIT_MS,
    );
  });

  it("resolves managed code-grounding config", () => {
    const resolved = resolveWorkflowConfig({
      workflowPath: "/repo/WORKFLOW.md",
      promptTemplate: "Prompt",
      config: {
        code_grounding: {
          enabled: "true",
          base_dir: ".cache/grounding",
          ttl_ms: "120000",
          max_checkouts_per_repo: "2",
          materialization_timeout_ms: "180000",
        },
      },
    });

    expect(resolved.codeGrounding).toEqual({
      enabled: true,
      baseDir: ".cache/grounding",
      ttlMs: 120_000,
      maxCheckoutsPerRepo: 2,
      materializationTimeoutMs: 180_000,
    });
  });

  it("resolves operator anchor ingestion config with normalized account emails", () => {
    const resolved = resolveWorkflowConfig(
      {
        workflowPath: "/repo/WORKFLOW.md",
        promptTemplate: "Prompt",
        config: {
          operator_anchors: {
            operator_allowlist: ["Operator@Mobilyze.com"],
            service_accounts: "Eric@Mobilyze.com, worker@mobilyze.com",
            field_name: "Queue Anchor",
            ingest_secret: "$ANCHOR_INGEST_SECRET",
          },
        },
      },
      {
        ANCHOR_INGEST_SECRET: "shared-secret",
      },
    );

    expect(resolved.operatorAnchors).toEqual({
      operatorAllowlist: ["operator@mobilyze.com"],
      serviceAccounts: ["eric@mobilyze.com", "worker@mobilyze.com"],
      fieldName: "Queue Anchor",
      ingestSecret: "shared-secret",
    });
  });

  it("coerces env-backed fields, path-like roots, and state limits", () => {
    const resolved = resolveWorkflowConfig(
      {
        workflowPath: "/repo/WORKFLOW.md",
        promptTemplate: "Prompt",
        config: {
          tracker: {
            api_key: "$LINEAR_TOKEN",
            project_slug: "ENG",
            active_states: "Todo, In Progress, Ready for QA",
          },
          polling: {
            interval_ms: "15000",
          },
          workspace: {
            root: "./tmp/workspaces",
          },
          hooks: {
            timeout_ms: "0",
            before_run: "pnpm test",
          },
          agent: {
            max_concurrent_agents: "4",
            max_turns: "8",
            max_retry_backoff_ms: "120000",
            max_concurrent_agents_by_state: {
              " In Progress ": "2",
              Done: 0,
            },
          },
          hard_stops: {
            max_iterations: "6",
            no_progress_turns: "2",
            max_tokens_per_unit: "50000",
            max_dollar_budget_usd: "12.5",
            premium_budget_pause_ratio: "0.75",
            live_budget_grace_ratio: "0.2",
            estimated_cost_per_1k_tokens_usd: "0.08",
          },
          codex: {
            command: "codex app-server --stdio",
            ephemeral_home: "true",
            disable_skills: "true",
            turn_timeout_ms: "90000",
            read_timeout_ms: "2500",
            stall_timeout_ms: "-1",
            session_rotation_input_tokens: "0",
            tool_output_token_limit: "1234",
            model_auto_compact_token_limit: "12345",
            max_healthy_compactions_per_stage: "2",
          },
          server: {
            port: "8080",
          },
          observability: {
            dashboard_enabled: "false",
            refresh_ms: "2500",
            render_interval_ms: "33",
          },
          risk_predicate_reasoning_effort: "HIGH",
        },
      },
      {
        LINEAR_TOKEN: "secret-token",
      },
    );

    expect(resolved.tracker.apiKey).toBe("secret-token");
    expect(resolved.tracker.projectSlug).toBe("ENG");
    expect(resolved.tracker.activeStates).toEqual([
      "Todo",
      "In Progress",
      "Ready for QA",
    ]);
    expect(resolved.polling.intervalMs).toBe(15_000);
    expect(resolved.workspace.root).toBe(join("/repo", "tmp/workspaces"));
    expect(resolved.hooks.beforeRun).toBe("pnpm test");
    expect(resolved.hooks.timeoutMs).toBe(DEFAULT_HOOK_TIMEOUT_MS);
    expect(resolved.agent.maxConcurrentAgents).toBe(4);
    expect(resolved.agent.maxTurns).toBe(8);
    expect(resolved.agent.maxRetryBackoffMs).toBe(120_000);
    expect(resolved.agent.maxConcurrentAgentsByState).toEqual({
      "in progress": 2,
    });
    expect(resolved.hardStops).toEqual({
      maxIterations: 6,
      noProgressTurns: 2,
      maxTokensPerUnit: 50_000,
      maxDollarBudgetUsd: 12.5,
      premiumBudgetPauseRatio: 0.75,
      liveBudgetGraceRatio: 0.2,
      estimatedCostPer1kTokensUsd: 0.08,
      cachedTokenCostRatio: DEFAULT_HARD_STOP_CACHED_TOKEN_COST_RATIO,
      maxPrimaryWindowPctPerUnit: null,
      maxSecondaryWindowPctPerUnit: null,
    });
    expect(resolved.codex.command).toBe("codex app-server --stdio");
    expect(resolved.codex.ephemeralHome).toBe(true);
    expect(resolved.codex.disableSkills).toBe(true);
    expect(resolved.codex.turnTimeoutMs).toBe(90_000);
    expect(resolved.codex.readTimeoutMs).toBe(2_500);
    expect(resolved.codex.stallTimeoutMs).toBe(-1);
    expect(resolved.codex.sessionRotationInputTokens).toBe(0);
    expect(resolved.codex.toolOutputTokenLimit).toBe(1_234);
    expect(resolved.codex.modelAutoCompactTokenLimit).toBe(12_345);
    expect(resolved.codex.maxHealthyCompactionsPerStage).toBe(2);
    expect(resolved.riskPredicateReasoning).toEqual({ effort: "high" });
    expect(resolved.server.port).toBe(8080);
    expect(resolved.observability.dashboardEnabled).toBe(false);
    expect(resolved.observability.refreshMs).toBe(2_500);
    expect(resolved.observability.renderIntervalMs).toBe(33);
  });

  it("resolves tracker.team_keys into the team-scoped candidate source (SYMPH-794)", () => {
    const resolved = resolveWorkflowConfig({
      workflowPath: "/repo/WORKFLOW.md",
      promptTemplate: "Prompt",
      config: {
        tracker: {
          api_key: "token",
          project_slug: "ENG",
          team_keys: ["SYMPH", "MOB"],
        },
      },
    });

    expect(resolved.tracker.teamKeys).toEqual(["SYMPH", "MOB"]);
  });

  it("defaults tracker.teamKeys to an empty list (project-scoped backward compat)", () => {
    const resolved = resolveWorkflowConfig({
      workflowPath: "/repo/WORKFLOW.md",
      promptTemplate: "Prompt",
      config: {
        tracker: {
          api_key: "token",
          project_slug: "ENG",
        },
      },
    });

    expect(resolved.tracker.teamKeys).toEqual([]);
  });

  it("resolves path-like hook scripts relative to the workflow file", () => {
    const resolved = resolveWorkflowConfig(
      {
        workflowPath: "/repo/pipeline-config/WORKFLOW.md",
        promptTemplate: "Prompt",
        config: {
          hooks: {
            after_create: "./hooks/after-create.sh",
            before_run:
              "test -x ./hooks/before-run.sh && ./hooks/before-run.sh",
            after_run: "$AFTER_RUN_HOOK",
            before_remove: "~/bin/symphony-cleanup",
          },
        },
      },
      {
        AFTER_RUN_HOOK: "./hooks/after-run.sh",
      },
    );

    expect(resolved.hooks.afterCreate).toBe(
      join("/repo/pipeline-config", "hooks/after-create.sh"),
    );
    expect(resolved.hooks.beforeRun).toBe(
      "test -x ./hooks/before-run.sh && ./hooks/before-run.sh",
    );
    expect(resolved.hooks.afterRun).toBe(
      join("/repo/pipeline-config", "hooks/after-run.sh"),
    );
    expect(resolved.hooks.beforeRemove).toBe(
      join(homedir(), "bin/symphony-cleanup"),
    );
  });

  it("quotes resolved hook paths when the workflow directory contains spaces", () => {
    const resolved = resolveWorkflowConfig({
      workflowPath: "/repo/My Pipeline Config/WORKFLOW.md",
      promptTemplate: "Prompt",
      config: {
        hooks: {
          after_create: "./hooks/after-create.sh",
          before_run: "test -x ./hooks/before-run.sh && ./hooks/before-run.sh",
        },
      },
    });

    expect(resolved.hooks.afterCreate).toBe(
      `"${join("/repo/My Pipeline Config", "hooks/after-create.sh")}"`,
    );
    // Shell command hooks stay verbatim even under a spaced workflow dir.
    expect(resolved.hooks.beforeRun).toBe(
      "test -x ./hooks/before-run.sh && ./hooks/before-run.sh",
    );
  });

  it("keeps $VAR segments expandable when quoting spaced hook paths", () => {
    const resolved = resolveWorkflowConfig(
      {
        workflowPath: "/repo/My Pipeline Config/WORKFLOW.md",
        promptTemplate: "Prompt",
        config: {
          hooks: {
            before_run: "./$PRODUCT/hooks/before-run.sh",
          },
        },
      },
      {},
    );

    // Double-quoted, with $PRODUCT left unescaped for runtime expansion.
    expect(resolved.hooks.beforeRun).toBe(
      `"${join("/repo/My Pipeline Config", "$PRODUCT/hooks/before-run.sh")}"`,
    );
  });

  it("escapes double quotes and backslashes in quoted hook paths", () => {
    const resolved = resolveWorkflowConfig({
      workflowPath: '/repo/we"ird path/WORKFLOW.md',
      promptTemplate: "Prompt",
      config: {
        hooks: {
          after_create: "./hooks/after-create.sh",
        },
      },
    });

    expect(resolved.hooks.afterCreate).toBe(
      `"${join('/repo/we\\"ird path', "hooks/after-create.sh")}"`,
    );
  });

  it("escapes backticks in quoted hook paths", () => {
    const resolved = resolveWorkflowConfig({
      workflowPath: "/repo/we`ird path/WORKFLOW.md",
      promptTemplate: "Prompt",
      config: {
        hooks: {
          after_create: "./hooks/after-create.sh",
        },
      },
    });

    // An unescaped backtick inside double quotes would be legacy command
    // substitution when the hook runs through `sh -lc`.
    expect(resolved.hooks.afterCreate).toBe(
      `"${join("/repo/we\\`ird path", "hooks/after-create.sh")}"`,
    );
  });

  it("leaves multi-line hook scripts verbatim", () => {
    const script = [
      "set -euo pipefail",
      "test -x ./hooks/before-run.sh",
      "./hooks/before-run.sh",
    ].join("\n");

    const resolved = resolveWorkflowConfig({
      workflowPath: "/repo/pipeline-config/WORKFLOW.md",
      promptTemplate: "Prompt",
      config: {
        hooks: {
          before_run: script,
        },
      },
    });

    expect(resolved.hooks.beforeRun).toBe(script);
  });

  it("leaves unresolved env-backed hook scripts for the shell", () => {
    const resolved = resolveWorkflowConfig(
      {
        workflowPath: "/repo/pipeline-config/WORKFLOW.md",
        promptTemplate: "Prompt",
        config: {
          hooks: {
            after_create: "$AFTER_CREATE_HOOK",
            before_run: "./$PRODUCT/hooks/before-run.sh",
          },
        },
      },
      {},
    );

    expect(resolved.hooks.afterCreate).toBe("$AFTER_CREATE_HOOK");
    expect(resolved.hooks.beforeRun).toBe(
      join("/repo/pipeline-config", "$PRODUCT/hooks/before-run.sh"),
    );
  });

  it("projects explicit continuous_feedback event, runner, and model settings", () => {
    const resolved = resolveWorkflowConfig({
      workflowPath: "/repo/WORKFLOW.md",
      promptTemplate: "Prompt",
      config: {
        continuous_feedback: {
          enabled: "false",
          events: ["commit", "diff", "checkpoint", "unsupported", "diff"],
          runner: "claude",
          model: "sonnet",
          role: "cheap-reviewer",
          bounce_on_finding: "false",
          preflight_fail_closed: "true",
        },
      },
    });

    expect(resolved.continuousFeedback).toEqual({
      enabled: false,
      events: ["commit", "diff", "checkpoint"],
      runner: "claude",
      model: "sonnet",
      role: "cheap-reviewer",
      bounceOnFinding: false,
      preflightFailClosed: true,
    });
  });

  it("falls back to checkpoint when continuous_feedback events are invalid", () => {
    const resolved = resolveWorkflowConfig({
      workflowPath: "/repo/WORKFLOW.md",
      promptTemplate: "Prompt",
      config: {
        continuous_feedback: {
          events: ["unsupported"],
        },
      },
    });

    expect(resolved.continuousFeedback?.events).toEqual(["checkpoint"]);
  });

  it("accepts server.port zero for ephemeral listener binding", () => {
    const resolved = resolveWorkflowConfig({
      workflowPath: "/repo/WORKFLOW.md",
      promptTemplate: "Prompt",
      config: {
        server: {
          port: 0,
        },
      },
    });

    expect(resolved.server.port).toBe(0);
  });

  it("ignores invalid negative or non-integer server.port values", () => {
    const negative = resolveWorkflowConfig({
      workflowPath: "/repo/WORKFLOW.md",
      promptTemplate: "Prompt",
      config: {
        server: {
          port: -1,
        },
      },
    });
    const invalidString = resolveWorkflowConfig({
      workflowPath: "/repo/WORKFLOW.md",
      promptTemplate: "Prompt",
      config: {
        server: {
          port: "eight-thousand",
        },
      },
    });

    expect(negative.server.port).toBeNull();
    expect(invalidString.server.port).toBeNull();
  });

  it("parses server.host as the dashboard bind address opt-in", () => {
    const resolved = resolveWorkflowConfig({
      workflowPath: "/repo/WORKFLOW.md",
      promptTemplate: "Prompt",
      config: {
        server: {
          port: 8080,
          host: "0.0.0.0",
        },
      },
    });

    expect(resolved.server.host).toBe("0.0.0.0");
  });

  it("normalizes blank server.host to null instead of a wildcard bind", () => {
    for (const blank of ["", "   ", "\t"]) {
      const resolved = resolveWorkflowConfig({
        workflowPath: "/repo/WORKFLOW.md",
        promptTemplate: "Prompt",
        config: {
          server: {
            port: 8080,
            host: blank,
          },
        },
      });

      expect(resolved.server.host).toBeNull();
    }
  });

  it("defaults server.host to null so the dashboard binds loopback", () => {
    const resolved = resolveWorkflowConfig({
      workflowPath: "/repo/WORKFLOW.md",
      promptTemplate: "Prompt",
      config: {
        server: {
          port: 8080,
        },
      },
    });

    expect(resolved.server.host).toBeNull();
  });

  it("uses the canonical LINEAR_API_KEY env var fallback", () => {
    const resolved = resolveWorkflowConfig(
      {
        workflowPath: "/repo/WORKFLOW.md",
        promptTemplate: "Prompt",
        config: {
          tracker: {
            project_slug: "ENG",
          },
        },
      },
      {
        LINEAR_API_KEY: "canonical-secret",
      },
    );

    expect(resolved.tracker.apiKey).toBe("canonical-secret");
  });

  it("resolves tracker.project_slug from an environment reference", () => {
    const resolved = resolveWorkflowConfig(
      {
        workflowPath: "/repo/WORKFLOW.md",
        promptTemplate: "Prompt",
        config: {
          tracker: {
            project_slug: "$SYMPHONY_LINEAR_PROJECT_SLUG",
          },
        },
      },
      {
        SYMPHONY_LINEAR_PROJECT_SLUG: "isolated-test-project",
      },
    );

    expect(resolved.tracker.projectSlug).toBe("isolated-test-project");
  });

  it("fails closed when tracker.project_slug references an unset environment variable", () => {
    const resolved = resolveWorkflowConfig(
      {
        workflowPath: "/repo/WORKFLOW.md",
        promptTemplate: "Prompt",
        config: {
          tracker: {
            api_key: "token",
            project_slug: "$SYMPHONY_LINEAR_PROJECT_SLUG",
          },
        },
      },
      {},
    );

    expect(resolved.tracker.projectSlug).toBeNull();
    expect(validateDispatchConfig(resolved)).toEqual({
      ok: false,
      error: {
        code: ERROR_CODES.configInvalid,
        message: "tracker.project_slug must be configured before dispatch.",
      },
    });
  });

  it("resolves owner_host and defaults it to null when absent", () => {
    const withOwner = resolveWorkflowConfig(
      {
        workflowPath: "/repo/WORKFLOW.md",
        promptTemplate: "Prompt",
        config: {
          owner_host: "pro14",
          tracker: { api_key: "token", project_slug: "proj" },
        },
      },
      {},
    );
    expect(withOwner.ownerHost).toBe("pro14");

    const withoutOwner = resolveWorkflowConfig(
      {
        workflowPath: "/repo/WORKFLOW.md",
        promptTemplate: "Prompt",
        config: {
          tracker: { api_key: "token", project_slug: "proj" },
        },
      },
      {},
    );
    expect(withoutOwner.ownerHost).toBeNull();
  });

  it("single-homing guard: dispatch passes when the machine matches owner_host (label-wise, case-insensitive)", () => {
    const resolved = resolveWorkflowConfig(
      {
        workflowPath: "/repo/WORKFLOW.md",
        promptTemplate: "Prompt",
        config: {
          owner_host: "pro14",
          tracker: { api_key: "token", project_slug: "proj" },
        },
      },
      {},
    );

    expect(
      validateDispatchConfig(resolved, { hostname: "PRO14.local" }),
    ).toEqual({ ok: true });
    expect(validateDispatchConfig(resolved, { hostname: "pro14" })).toEqual({
      ok: true,
    });
  });

  it("single-homing guard: dispatch fails loudly on a non-owner host (SYMPH-383)", () => {
    const resolved = resolveWorkflowConfig(
      {
        workflowPath: "/repo/WORKFLOW.md",
        promptTemplate: "Prompt",
        config: {
          owner_host: "pro14",
          tracker: { api_key: "token", project_slug: "proj" },
        },
      },
      {},
    );

    const validation = validateDispatchConfig(resolved, {
      hostname: "pro16.local",
    });
    expect(validation.ok).toBe(false);
    if (!validation.ok) {
      expect(validation.error.code).toBe(ERROR_CODES.ownerHostMismatch);
      expect(validation.error.message).toContain("single-homed");
    }
  });

  it("single-homing guard: present-but-blank owner_host fails closed", () => {
    for (const blank of ["", "   "]) {
      const resolved = resolveWorkflowConfig(
        {
          workflowPath: "/repo/WORKFLOW.md",
          promptTemplate: "Prompt",
          config: {
            owner_host: blank,
            tracker: { api_key: "token", project_slug: "proj" },
          },
        },
        {},
      );

      const validation = validateDispatchConfig(resolved, {
        hostname: "pro14",
      });
      expect(validation.ok).toBe(false);
      if (!validation.ok) {
        expect(validation.error.code).toBe(ERROR_CODES.configInvalid);
        expect(validation.error.message).toContain("owner_host");
      }
    }
  });

  it("single-homing guard: no owner_host means any host may dispatch", () => {
    const resolved = resolveWorkflowConfig(
      {
        workflowPath: "/repo/WORKFLOW.md",
        promptTemplate: "Prompt",
        config: {
          tracker: { api_key: "token", project_slug: "proj" },
        },
      },
      {},
    );

    expect(
      validateDispatchConfig(resolved, { hostname: "anything.example" }),
    ).toEqual({ ok: true });
  });

  it("resolves env-backed workspace roots and expands the home directory", () => {
    const envBacked = resolveWorkflowConfig(
      {
        workflowPath: "/repo/WORKFLOW.md",
        promptTemplate: "Prompt",
        config: {
          workspace: {
            root: "$WORKSPACE_ROOT",
          },
        },
      },
      {
        WORKSPACE_ROOT: "~/symphony-workspaces",
      },
    );

    expect(envBacked.workspace.root).toBe(
      join(homedir(), "symphony-workspaces"),
    );
  });

  it("parses escalation_state from top-level config", () => {
    const resolved = resolveWorkflowConfig({
      workflowPath: "/repo/WORKFLOW.md",
      promptTemplate: "Prompt",
      config: {
        escalation_state: "Needs Triage",
      },
    });

    expect(resolved.escalationState).toBe("Needs Triage");
  });

  it("defaults escalationState to null when not specified", () => {
    const resolved = resolveWorkflowConfig({
      workflowPath: "/repo/WORKFLOW.md",
      promptTemplate: "Prompt",
      config: {},
    });

    expect(resolved.escalationState).toBeNull();
  });

  it("blocks dispatch when required tracker settings are missing", () => {
    const resolved = resolveWorkflowConfig(
      {
        workflowPath: "/repo/WORKFLOW.md",
        promptTemplate: "Prompt",
        config: {},
      },
      {},
    );

    const validation = validateDispatchConfig(resolved);
    expect(validation).toEqual({
      ok: false,
      error: {
        code: ERROR_CODES.trackerCredentialsMissing,
        message: "tracker.api_key must be configured before dispatch.",
      },
    });
  });

  it("rejects unsupported tracker kinds during dispatch validation", () => {
    const validation = validateDispatchConfig(
      resolveWorkflowConfig(
        {
          workflowPath: "/repo/WORKFLOW.md",
          promptTemplate: "Prompt",
          config: {
            tracker: {
              kind: "jira",
              api_key: "token",
              project_slug: "ENG",
            },
          },
        },
        {},
      ),
    );

    expect(validation).toEqual({
      ok: false,
      error: {
        code: ERROR_CODES.unsupportedTrackerKind,
        message: "tracker.kind 'jira' is not supported.",
      },
    });
  });

  it("rejects disabling skills without an ephemeral Codex home during dispatch validation", () => {
    const validation = validateDispatchConfig(
      resolveWorkflowConfig(
        {
          workflowPath: "/repo/WORKFLOW.md",
          promptTemplate: "Prompt",
          config: {
            tracker: {
              kind: "linear",
              api_key: "token",
              project_slug: "ENG",
            },
            codex: {
              disable_skills: true,
              ephemeral_home: false,
            },
          },
        },
        {},
      ),
    );

    expect(validation).toEqual({
      ok: false,
      error: {
        code: ERROR_CODES.configInvalid,
        message:
          "codex.disable_skills requires codex.ephemeral_home before dispatch.",
      },
    });
  });

  it("accepts dispatch when tracker and codex prerequisites are present", () => {
    const validation = validateDispatchConfig(
      resolveWorkflowConfig(
        {
          workflowPath: "/repo/WORKFLOW.md",
          promptTemplate: "Prompt",
          config: {
            tracker: {
              kind: "linear",
              api_key: "token",
              project_slug: "ENG",
            },
          },
        },
        {},
      ),
    );

    expect(validation).toEqual({ ok: true });
  });
});

describe("config-resolver fast_track", () => {
  it("parses fast_track label and initial_stage from stages config", () => {
    const resolved = resolveWorkflowConfig({
      workflowPath: "/repo/WORKFLOW.md",
      promptTemplate: "Prompt",
      config: {
        stages: {
          initial_stage: "investigate",
          fast_track: {
            label: "trivial",
            initial_stage: "implement",
          },
          investigate: { type: "agent", on_complete: "implement" },
          implement: { type: "agent", on_complete: "done" },
          done: { type: "terminal" },
        },
      },
    });

    expect(resolved.stages).not.toBeNull();
    expect(resolved.stages?.fastTrack).toEqual({
      label: "trivial",
      labels: ["trivial"],
      initialStage: "implement",
    });
  });

  it("parses fast_track labels and keeps the legacy label as an alias", () => {
    const resolved = resolveWorkflowConfig({
      workflowPath: "/repo/WORKFLOW.md",
      promptTemplate: "Prompt",
      config: {
        stages: {
          initial_stage: "investigate",
          fast_track: {
            label: "trivial",
            labels: ["trivial", "kind:test"],
            initial_stage: "implement",
          },
          investigate: { type: "agent", on_complete: "implement" },
          implement: { type: "agent", on_complete: "done" },
          done: { type: "terminal" },
        },
      },
    });

    expect(resolved.stages?.fastTrack).toEqual({
      label: "trivial",
      labels: ["trivial", "kind:test"],
      initialStage: "implement",
    });
  });

  it("sets fastTrack to null when fast_track is not present in stages config", () => {
    const resolved = resolveWorkflowConfig({
      workflowPath: "/repo/WORKFLOW.md",
      promptTemplate: "Prompt",
      config: {
        stages: {
          initial_stage: "investigate",
          investigate: { type: "agent", on_complete: "done" },
          done: { type: "terminal" },
        },
      },
    });

    expect(resolved.stages?.fastTrack).toBeNull();
  });

  it("parses per-stage hard stop overrides without filling global defaults", () => {
    const resolved = resolveWorkflowConfig({
      workflowPath: "/repo/WORKFLOW.md",
      promptTemplate: "Prompt",
      config: {
        stages: {
          initial_stage: "investigate",
          investigate: {
            type: "agent",
            hard_stops: {
              max_iterations: "4",
              max_tokens_per_unit: "80000",
              max_dollar_budget_usd: "4",
              premium_budget_pause_ratio: "0.9",
              live_budget_grace_ratio: "0.25",
            },
            on_complete: "done",
          },
          done: { type: "terminal" },
        },
      },
    });

    expect(resolved.stages?.stages.investigate?.hardStops).toEqual({
      maxIterations: 4,
      maxTokensPerUnit: 80_000,
      maxDollarBudgetUsd: 4,
      premiumBudgetPauseRatio: 0.9,
      liveBudgetGraceRatio: 0.25,
    });
    expect(
      resolved.stages?.stages.investigate?.hardStops
        ?.estimatedCostPer1kTokensUsd,
    ).toBeUndefined();
    expect(resolved.stages?.stages.done?.hardStops).toBeNull();
  });

  it("parses cached_token_cost_ratio at workflow and stage level", () => {
    const resolved = resolveWorkflowConfig({
      workflowPath: "/repo/WORKFLOW.md",
      promptTemplate: "Prompt",
      config: {
        hard_stops: {
          cached_token_cost_ratio: "0.25",
        },
        stages: {
          initial_stage: "investigate",
          investigate: {
            type: "agent",
            hard_stops: {
              cached_token_cost_ratio: "0.5",
            },
            on_complete: "done",
          },
          done: { type: "terminal" },
        },
      },
    });

    expect(resolved.hardStops?.cachedTokenCostRatio).toBe(0.25);
    expect(
      resolved.stages?.stages.investigate?.hardStops?.cachedTokenCostRatio,
    ).toBe(0.5);
  });

  it("defaults cached_token_cost_ratio and rejects out-of-range values", () => {
    const resolved = resolveWorkflowConfig({
      workflowPath: "/repo/WORKFLOW.md",
      promptTemplate: "Prompt",
      config: {
        hard_stops: {
          cached_token_cost_ratio: "1.5",
        },
      },
    });

    expect(resolved.hardStops?.cachedTokenCostRatio).toBe(0.1);
  });

  it("accepts cached_token_cost_ratio of exactly 0 (free cache reads)", () => {
    const resolved = resolveWorkflowConfig({
      workflowPath: "/repo/WORKFLOW.md",
      promptTemplate: "Prompt",
      config: {
        hard_stops: {
          cached_token_cost_ratio: "0",
        },
      },
    });

    expect(resolved.hardStops?.cachedTokenCostRatio).toBe(0);
  });

  it("parses rate-limit window budgets at workflow and stage level", () => {
    const resolved = resolveWorkflowConfig({
      workflowPath: "/repo/WORKFLOW.md",
      promptTemplate: "Prompt",
      config: {
        hard_stops: {
          max_primary_window_pct_per_unit: "25",
          max_secondary_window_pct_per_unit: 5,
        },
        stages: {
          initial_stage: "investigate",
          investigate: {
            type: "agent",
            hard_stops: {
              max_secondary_window_pct_per_unit: "2.5",
            },
            on_complete: "done",
          },
          done: { type: "terminal" },
        },
      },
    });

    expect(resolved.hardStops?.maxPrimaryWindowPctPerUnit).toBe(25);
    expect(resolved.hardStops?.maxSecondaryWindowPctPerUnit).toBe(5);
    expect(
      resolved.stages?.stages.investigate?.hardStops
        ?.maxSecondaryWindowPctPerUnit,
    ).toBe(2.5);
  });

  it("defaults rate-limit window budgets to null and rejects out-of-range values", () => {
    const unset = resolveWorkflowConfig({
      workflowPath: "/repo/WORKFLOW.md",
      promptTemplate: "Prompt",
      config: {},
    });
    expect(unset.hardStops?.maxPrimaryWindowPctPerUnit).toBeNull();
    expect(unset.hardStops?.maxSecondaryWindowPctPerUnit).toBeNull();

    const outOfRange = resolveWorkflowConfig({
      workflowPath: "/repo/WORKFLOW.md",
      promptTemplate: "Prompt",
      config: {
        hard_stops: {
          max_primary_window_pct_per_unit: "150",
          max_secondary_window_pct_per_unit: "0",
        },
      },
    });
    expect(outOfRange.hardStops?.maxPrimaryWindowPctPerUnit).toBeNull();
    expect(outOfRange.hardStops?.maxSecondaryWindowPctPerUnit).toBeNull();
  });

  it("parses rate_limit_admission floors and defaults them to null", () => {
    const resolved = resolveWorkflowConfig({
      workflowPath: "/repo/WORKFLOW.md",
      promptTemplate: "Prompt",
      config: {
        rate_limit_admission: {
          min_primary_headroom_pct: "10",
          min_secondary_headroom_pct: 5,
        },
      },
    });
    expect(resolved.rateLimitAdmission).toEqual({
      minPrimaryHeadroomPct: 10,
      minSecondaryHeadroomPct: 5,
      deferUntilReset: false,
      expectedUnitBurnPct: null,
      deferJitterMs: 0,
      snapshotMaxAgeMs: 21_600_000,
    });

    const unset = resolveWorkflowConfig({
      workflowPath: "/repo/WORKFLOW.md",
      promptTemplate: "Prompt",
      config: {},
    });
    expect(unset.rateLimitAdmission).toEqual({
      minPrimaryHeadroomPct: null,
      minSecondaryHeadroomPct: null,
      deferUntilReset: false,
      expectedUnitBurnPct: null,
      deferJitterMs: 0,
      snapshotMaxAgeMs: 21_600_000,
    });
  });

  it("parses rate_limit_admission deferral settings", () => {
    const resolved = resolveWorkflowConfig({
      workflowPath: "/repo/WORKFLOW.md",
      promptTemplate: "Prompt",
      config: {
        rate_limit_admission: {
          defer_until_reset: true,
          expected_unit_burn_pct: "1.5",
          defer_jitter_ms: 30000,
        },
      },
    });

    expect(resolved.rateLimitAdmission).toEqual({
      minPrimaryHeadroomPct: null,
      minSecondaryHeadroomPct: null,
      deferUntilReset: true,
      expectedUnitBurnPct: 1.5,
      deferJitterMs: 30000,
      snapshotMaxAgeMs: 21_600_000,
    });
  });

  it("parses rate_limit_admission snapshot_max_age_ms and defaults it (SYMPH-778)", () => {
    const resolved = resolveWorkflowConfig({
      workflowPath: "/repo/WORKFLOW.md",
      promptTemplate: "Prompt",
      config: {
        rate_limit_admission: {
          snapshot_max_age_ms: 3_600_000,
        },
      },
    });
    expect(resolved.rateLimitAdmission.snapshotMaxAgeMs).toBe(3_600_000);

    const unset = resolveWorkflowConfig({
      workflowPath: "/repo/WORKFLOW.md",
      promptTemplate: "Prompt",
      config: {},
    });
    expect(unset.rateLimitAdmission.snapshotMaxAgeMs).toBe(21_600_000);

    // Explicit null disables the staleness bypass (strict persisted blocking).
    const disabled = resolveWorkflowConfig({
      workflowPath: "/repo/WORKFLOW.md",
      promptTemplate: "Prompt",
      config: {
        rate_limit_admission: {
          snapshot_max_age_ms: null,
        },
      },
    });
    expect(disabled.rateLimitAdmission.snapshotMaxAgeMs).toBeNull();
  });

  it("parses budget_escalation and defaults it off", () => {
    const resolved = resolveWorkflowConfig({
      workflowPath: "/repo/WORKFLOW.md",
      promptTemplate: "Prompt",
      config: {
        budget_escalation: {
          max_steps: "2",
          multiplier: "3",
        },
      },
    });
    expect(resolved.budgetEscalation).toEqual({ maxSteps: 2, multiplier: 3 });

    const unset = resolveWorkflowConfig({
      workflowPath: "/repo/WORKFLOW.md",
      promptTemplate: "Prompt",
      config: {},
    });
    expect(unset.budgetEscalation).toEqual({ maxSteps: null, multiplier: 2 });
  });

  it("rejects out-of-range budget_escalation multipliers", () => {
    const resolved = resolveWorkflowConfig({
      workflowPath: "/repo/WORKFLOW.md",
      promptTemplate: "Prompt",
      config: {
        budget_escalation: {
          max_steps: 2,
          multiplier: "1",
        },
      },
    });
    // multiplier must be in (1, 10]; invalid values fall back to the default.
    expect(resolved.budgetEscalation).toEqual({ maxSteps: 2, multiplier: 2 });

    const tooBig = resolveWorkflowConfig({
      workflowPath: "/repo/WORKFLOW.md",
      promptTemplate: "Prompt",
      config: {
        budget_escalation: { max_steps: 1, multiplier: 25 },
      },
    });
    expect(tooBig.budgetEscalation.multiplier).toBe(2);
  });

  it("resolves slack_notify_channel from YAML config", () => {
    const resolved = resolveWorkflowConfig({
      workflowPath: "/repo/WORKFLOW.md",
      config: {
        server: { slack_notify_channel: "C12345" },
      },
      promptTemplate: "Prompt",
    });

    expect(resolved.server.slackNotifyChannel).toBe("C12345");
  });

  it("resolves slack_notify_channel from SLACK_NOTIFY_CHANNEL env var fallback", () => {
    const resolved = resolveWorkflowConfig(
      {
        workflowPath: "/repo/WORKFLOW.md",
        config: {},
        promptTemplate: "Prompt",
      },
      { SLACK_NOTIFY_CHANNEL: "C99999" },
    );

    expect(resolved.server.slackNotifyChannel).toBe("C99999");
  });

  it("YAML slack_notify_channel takes precedence over env var", () => {
    const resolved = resolveWorkflowConfig(
      {
        workflowPath: "/repo/WORKFLOW.md",
        config: {
          server: { slack_notify_channel: "C_YAML" },
        },
        promptTemplate: "Prompt",
      },
      { SLACK_NOTIFY_CHANNEL: "C_ENV" },
    );

    expect(resolved.server.slackNotifyChannel).toBe("C_YAML");
  });

  it("returns null for slack_notify_channel when neither YAML nor env var is set", () => {
    const resolved = resolveWorkflowConfig(
      {
        workflowPath: "/repo/WORKFLOW.md",
        config: {},
        promptTemplate: "Prompt",
      },
      {},
    );

    expect(resolved.server.slackNotifyChannel).toBeNull();
  });

  it("ignores non-string slack_notify_channel values", () => {
    const resolved = resolveWorkflowConfig({
      workflowPath: "/repo/WORKFLOW.md",
      config: {
        server: { slack_notify_channel: 12345 },
      },
      promptTemplate: "Prompt",
    });

    expect(resolved.server.slackNotifyChannel).toBeNull();
  });

  it("fast_track validation rejects unknown fast_track initial_stage target", () => {
    const stagesConfig = resolveStagesConfig({
      initial_stage: "investigate",
      fast_track: {
        label: "trivial",
        initial_stage: "nonexistent",
      },
      investigate: { type: "agent", on_complete: "done" },
      done: { type: "terminal" },
    });

    const result = validateStagesConfig(stagesConfig);

    expect(result.ok).toBe(false);
    expect(result.errors).toEqual(
      expect.arrayContaining([
        expect.stringContaining("fast_track.initial_stage 'nonexistent'"),
      ]),
    );
  });
});

describe("config-resolver watchdog.stuck_triage (SYMPH-399)", () => {
  it("defaults to disabled when the block is absent", () => {
    const resolved = resolveWorkflowConfig({
      workflowPath: "/repo/WORKFLOW.md",
      config: {},
      promptTemplate: "Prompt",
    });

    expect(resolved.watchdog.stuckTriage).toEqual({
      enabled: false,
      baseUrl: null,
      model: null,
      apiKey: null,
      timeoutMs: 600_000,
    });
  });

  it("parses a full block and resolves $ENV api_key references", () => {
    const resolved = resolveWorkflowConfig(
      {
        workflowPath: "/repo/WORKFLOW.md",
        config: {
          watchdog: {
            stuck_triage: {
              enabled: true,
              base_url: "http://studio2.local:8000/v1",
              model: "deepseek-v4-flash",
              api_key: "$STUCK_TRIAGE_KEY",
              timeout_ms: 120_000,
            },
          },
        },
        promptTemplate: "Prompt",
      },
      { STUCK_TRIAGE_KEY: "secret-token" } as NodeJS.ProcessEnv,
    );

    expect(resolved.watchdog.stuckTriage).toEqual({
      enabled: true,
      baseUrl: "http://studio2.local:8000/v1",
      model: "deepseek-v4-flash",
      apiKey: "secret-token",
      timeoutMs: 120_000,
    });
  });

  it("fails loudly on a malformed block instead of silently disabling", () => {
    expect(() =>
      resolveWorkflowConfig({
        workflowPath: "/repo/WORKFLOW.md",
        config: {
          watchdog: {
            stuck_triage: {
              enabled: "yes",
            },
          },
        },
        promptTemplate: "Prompt",
      }),
    ).toThrowError(/stuck_triage/);
  });

  it("rejects unknown keys (declared-vs-consumed contract)", () => {
    expect(() =>
      resolveWorkflowConfig({
        workflowPath: "/repo/WORKFLOW.md",
        config: {
          watchdog: {
            stuck_triage: {
              enabled: true,
              base_uri: "http://typo.local",
            },
          },
        },
        promptTemplate: "Prompt",
      }),
    ).toThrowError(/stuck_triage/);
  });
});
