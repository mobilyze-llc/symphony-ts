/**
 * Fail-open component visibility (SYMPH-407 scope 5).
 *
 * Every fail-open element of the pipeline reports `{enabled,
 * degraded_reason?}` in the /api/v1/state `components` section: a silently
 * disabled component is itself an incident class (the 2026-06-11 incident
 * burned a diagnosis cycle confirming which guards were even on).
 *
 * Detection contract — everything here is computed from resolved WORKFLOW
 * config plus cheap runtime presence checks. What is NOT detectable cheaply
 * (and therefore intentionally absent): live Slack webhook health (a dead
 * webhook URL still counts as "enabled" until a post fails), Linear API
 * availability for the watchdog filer, and the local judge endpoint actually
 * answering (the AC gate / spec-fidelity / pause-triage lanes are reported
 * from config; a flapping endpoint surfaces via the ac_gate_fail_open alert
 * stream, not this section).
 */

import type { ResolvedWorkflowConfig } from "../config/types.js";

export interface ComponentStatus {
  enabled: boolean;
  degraded_reason?: string;
}

export interface ComponentStatusInput {
  config: ResolvedWorkflowConfig;
  /** Whether a notification sink is wired (webhook configured). */
  notifierPresent: boolean;
  /** Whether any Codex rate-limit telemetry has been observed/hydrated. */
  rateLimitTelemetryPresent: boolean;
}

/**
 * Build the `components` section of the runtime snapshot. Keys are stable
 * snake_case component names; consumers must tolerate new keys appearing.
 */
export function buildComponentStatuses(
  input: ComponentStatusInput,
): Record<string, ComponentStatus> {
  const { config, notifierPresent, rateLimitTelemetryPresent } = input;
  const components: Record<string, ComponentStatus> = {};

  // Slack notifier (fail-open: alert failures never block dispatch).
  if (!notifierPresent) {
    components.slack_notifier = {
      enabled: false,
      degraded_reason:
        "no notification sink configured (SLACK_WEBHOOK_URL unset); alerts fail open to silence",
    };
  } else if (!config.notifications.slackEnabled) {
    components.slack_notifier = {
      enabled: false,
      degraded_reason:
        "notifications.slack_enabled=false in WORKFLOW; alerts suppressed for this product",
    };
  } else {
    components.slack_notifier = { enabled: true };
  }

  // Watchdog ticket filer (SYMPH-398): always wired when a tracker exists
  // (the host wires onSystemicCluster regardless of notifier presence).
  // Tracker write failures are only detectable at filing time.
  components.watchdog_filer = { enabled: true };

  // Stage circuit breaker (SYMPH-398).
  components.circuit_breaker = config.watchdog.circuitBreaker
    ? { enabled: true }
    : {
        enabled: false,
        degraded_reason:
          "watchdog.circuit_breaker=false; systemic signatures will not park stages",
      };

  // Watchdog L2 stuck-ticket triage (SYMPH-399). Default-disabled per
  // product until calibration.
  const stuckTriage = config.watchdog.stuckTriage;
  components.stuck_triage =
    stuckTriage?.enabled === true
      ? { enabled: true }
      : {
          enabled: false,
          degraded_reason:
            "watchdog.stuck_triage disabled or unconfigured; parked tickets wait for an operator",
        };

  // LLM pause triage (SYMPH-337 slice 2): disabled unless endpoint + model
  // are both set; fails closed to the operator pause.
  const pauseTriageConfigured =
    config.pauseTriage.baseUrl !== null && config.pauseTriage.model !== null;
  components.pause_triage = pauseTriageConfigured
    ? { enabled: true }
    : {
        enabled: false,
        degraded_reason:
          "pause_triage base_url/model unset; budget pauses park for the operator",
      };

  // AC falsifiability gate (SYMPH-354): FAIL-OPEN — a judge hiccup advances
  // the stage. Uses the pause_triage endpoint settings, so an enabled gate
  // with no endpoint is permanently fail-open.
  if (!config.acGate.enabled) {
    components.ac_gate = {
      enabled: false,
      degraded_reason:
        "ac_gate.enabled=false; investigate exits advance without AC scoring",
    };
  } else if (!pauseTriageConfigured) {
    components.ac_gate = {
      enabled: true,
      degraded_reason:
        "ac_gate enabled but pause_triage endpoint unset; gate fails open on every exit",
    };
  } else {
    components.ac_gate = { enabled: true };
  }

  // Spec-fidelity judge lane (SYMPH-343): advisory; same local-judge
  // endpoint dependency as the AC gate.
  if (!config.specFidelity.enabled) {
    components.spec_fidelity = {
      enabled: false,
      degraded_reason:
        "spec_fidelity.enabled=false; review exits carry no independent spec verdict",
    };
  } else if (!pauseTriageConfigured) {
    components.spec_fidelity = {
      enabled: true,
      degraded_reason:
        "spec_fidelity enabled but pause_triage endpoint unset; judge lane fails open",
    };
  } else {
    components.spec_fidelity = { enabled: true };
  }

  // Rate-limit dispatch admission floor (SYMPH-333/336): null floors disable
  // the guard; with floors set but no telemetry observed it fails open.
  const admissionConfigured =
    config.rateLimitAdmission.minPrimaryHeadroomPct !== null ||
    config.rateLimitAdmission.minSecondaryHeadroomPct !== null;
  if (!admissionConfigured) {
    components.rate_limit_admission = {
      enabled: false,
      degraded_reason:
        "rate_limit_admission floors unset; dispatch is never rate-limit gated",
    };
  } else if (!rateLimitTelemetryPresent) {
    components.rate_limit_admission = {
      enabled: true,
      degraded_reason:
        "no rate-limit telemetry observed yet; admission floor fails open until first snapshot",
    };
  } else {
    components.rate_limit_admission = { enabled: true };
  }

  return components;
}
