import { describe, expect, it } from "vitest";

import type { ResolvedWorkflowConfig } from "../../src/config/types.js";
import { buildComponentStatuses } from "../../src/observability/component-status.js";

function createConfig(
  overrides?: Partial<ResolvedWorkflowConfig>,
): ResolvedWorkflowConfig {
  return {
    workflowPath: "/tmp/WORKFLOW.md",
    promptTemplate: "Prompt",
    tracker: {
      kind: "linear",
      endpoint: "https://api.linear.app/graphql",
      apiKey: "token",
      projectSlug: "project",
      activeStates: ["Todo", "In Progress", "In Review", "Resume"],
      terminalStates: ["Done", "Canceled"],
    },
    polling: { intervalMs: 30_000 },
    workspace: { root: "/tmp/workspaces" },
    hooks: {
      afterCreate: null,
      beforeRun: null,
      afterRun: null,
      beforeRemove: null,
      timeoutMs: 30_000,
    },
    agent: {
      maxConcurrentAgents: 2,
      maxTurns: 5,
      maxRetryBackoffMs: 300_000,
      maxRetryAttempts: 5,
      maxConcurrentAgentsByState: {},
    },
    codex: {
      command: "codex-app-server",
      approvalPolicy: "never",
      threadSandbox: null,
      turnSandboxPolicy: null,
      turnTimeoutMs: 300_000,
      readTimeoutMs: 30_000,
      stallTimeoutMs: 300_000,
    },
    rateLimitAdmission: {
      minPrimaryHeadroomPct: null,
      minSecondaryHeadroomPct: null,
    },
    budgetEscalation: { maxSteps: null, multiplier: 2 },
    pauseTriage: { baseUrl: null, model: null, apiKey: null, maxResumes: 2 },
    acGate: { enabled: false },
    specFidelity: { enabled: false },
    admissionCard: { enabled: false },
    watchdog: {
      systemicThreshold: 2,
      circuitBreaker: true,
      maxFilingsPerHour: 3,
    },
    server: { port: null, host: null, slackNotifyChannel: null },
    notifications: { slackEnabled: true },
    observability: {
      dashboardEnabled: true,
      refreshMs: 1_000,
      renderIntervalMs: 16,
    },
    runner: { kind: "codex", model: null },
    stages: null,
    escalationState: null,
    ...overrides,
  };
}

describe("buildComponentStatuses (SYMPH-407)", () => {
  it("reports a disabled component with a degraded_reason", () => {
    const components = buildComponentStatuses({
      config: createConfig(),
      notifierPresent: false,
      rateLimitTelemetryPresent: false,
    });

    expect(components.slack_notifier).toEqual({
      enabled: false,
      degraded_reason: expect.stringContaining("no notification sink"),
    });
    expect(components.ac_gate).toEqual({
      enabled: false,
      degraded_reason: expect.stringContaining("ac_gate.enabled=false"),
    });
    expect(components.pause_triage?.enabled).toBe(false);
    expect(components.pause_triage?.degraded_reason).toBeDefined();
    expect(components.stuck_triage?.enabled).toBe(false);
    expect(components.spec_fidelity?.enabled).toBe(false);
    expect(components.rate_limit_admission).toEqual({
      enabled: false,
      degraded_reason: expect.stringContaining("floors unset"),
    });
  });

  it("flags enabled-but-degraded components (fail-open without prerequisites)", () => {
    const components = buildComponentStatuses({
      config: createConfig({
        acGate: { enabled: true },
        specFidelity: { enabled: true },
        rateLimitAdmission: {
          minPrimaryHeadroomPct: 10,
          minSecondaryHeadroomPct: 5,
        },
      }),
      notifierPresent: true,
      rateLimitTelemetryPresent: false,
    });

    // AC still needs the local judge endpoint; spec-fidelity is now the
    // adjacent crabrunner lane and has no pause-triage endpoint prerequisite.
    expect(components.ac_gate).toEqual({
      enabled: true,
      degraded_reason: expect.stringContaining("fails open"),
    });
    expect(components.spec_fidelity).toEqual({ enabled: true });
    // Floors set but no telemetry observed: floor fails open.
    expect(components.rate_limit_admission).toEqual({
      enabled: true,
      degraded_reason: expect.stringContaining("no rate-limit telemetry"),
    });
  });

  it("reports healthy components without a degraded_reason", () => {
    const components = buildComponentStatuses({
      config: createConfig({
        pauseTriage: {
          baseUrl: "http://localhost:1234/v1",
          model: "local-judge",
          apiKey: null,
          maxResumes: 2,
        },
        acGate: { enabled: true },
        specFidelity: { enabled: true },
        rateLimitAdmission: {
          minPrimaryHeadroomPct: 10,
          minSecondaryHeadroomPct: 5,
        },
        watchdog: {
          systemicThreshold: 2,
          circuitBreaker: true,
          maxFilingsPerHour: 3,
          stuckTriage: {
            enabled: true,
            baseUrl: "http://localhost:1234/v1",
            model: "local-judge",
            apiKey: null,
            timeoutMs: null,
          },
        },
      }),
      notifierPresent: true,
      rateLimitTelemetryPresent: true,
    });

    for (const name of [
      "slack_notifier",
      "watchdog_filer",
      "circuit_breaker",
      "stuck_triage",
      "pause_triage",
      "ac_gate",
      "spec_fidelity",
      "rate_limit_admission",
    ]) {
      expect(components[name], name).toEqual({ enabled: true });
    }
  });
});
