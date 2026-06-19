---
base_config: ../templates/WORKFLOW-template.md
# Single-homing guard (SYMPH-383): only this host may dispatch the symphony
# product. A second orchestrator fails loudly at startup instead of racing.
owner_host: pro14
tracker:
  project_slug: fdba14472043
agent:
  max_concurrent_agents: 5
server:
  port: 4321
# SYMPH-735: enable the live merge actuator for the symphony self-work pipeline.
# When a council-passed PR reaches the merge stage, the orchestrator marks it
# ready, enqueues it (auto-merge, head-pinned to the reviewed SHA), and writes
# the tracker Done — with bounded, replay-stable recovery and operator parking
# (runMergeActuatorCycle, SYMPH-746/748). Default-off for every other product;
# ceilings inherit config defaults (1h queue wait, 5/3/20 failure ceilings).
# SYMPH-754: `auto_merge` is the actuator's auto-merge/enqueue permission,
# DISTINCT from `enabled` and default-CLOSED. `enabled: true` lets the actuator
# run/observe; `auto_merge: true` grants it permission to ENQUEUE. It MUST be
# granted explicitly here for symphony — otherwise every symphony PR would park
# as `auto_merge_permission_denied` instead of auto-merging. Every other product
# leaves it closed (the actuator is the sole auto-merge path; the worker's mode
# envelope governs the worker only and is advisory w.r.t. the actuator).
merge_actuator:
  enabled: true
  auto_merge: true
# SYMPH-784: Queue Triage v2 Manager — armed to SHADOW (Stage 1–2 of the go-live
# runbook). enabled + shadow_mode means the Opus planner computes/journals a
# standing plan every heartbeat AND the living "🚦Ticket Triage Controls" doc
# publishes/ingests, but dispatch STAYS on the comparator (shadow_mode does not
# drive dispatch). This is a calibration window: compare the plan vs. what the
# comparator actually dispatched before exiting shadow. Stages 3–4 (shadow_mode:
# false → plan drives dispatch; admission_guardrail.enabled: true → bare project
# no longer admits) are a deliberate, separate operator go-live — see the
# "Queue Triage v2 — Go-Live Runbook" Linear doc. admission_guardrail stays
# default-OFF here.
queue_triage:
  enabled: true
  shadow_mode: true
  control_doc:
    enabled: true
    team_id: 955e3adf-13d3-4691-a09a-c66d2420580b
# Operator allowlist for the 🚦 control-doc comment surface (SYMPH-486/791): only
# these author emails can drive plan-control actions via doc comments; the agent
# service account is deliberately excluded so it cannot self-approve. In shadow,
# recorded decisions are inert (the consumer does not drive dispatch).
operator_anchors:
  operator_allowlist:
    - eric@litman.org
---

You are working on the Symphony orchestrator (symphony-ts). This is the pipeline orchestration layer that schedules and coordinates autonomous development agents.

{% if stageName == "review" %}
## Symphony Review Infrastructure Routing

For this live Symphony pipeline, consume the headless council gate's substrate-stall signal from `$ARTIFACT_DIR/review-result.json`. If the machine result is `verdict: "error"` because any lane has `degradedReason: "substrate_stall"` or any `degradedConditions` entry starts with `substrate_stall:`, and there are no surviving P1/P2 code findings, this is review infrastructure, not implement rework.

- First occurrence: post `## Review Infrastructure Retry` with the artifact directory, reviewed head SHA, and stalled lane(s), then output `[STAGE_FAILED: infra]` with `substrate_stall:<lane>` details.
- Repeated substrate-stall occurrence: the orchestrator parks infra-blocked; do not write `## Review Findings` or send the issue to implement unless the council artifact contains actual surviving P1/P2 code findings.
- If every reviewer lane passed but the aggregate gate failed only on routing/provenance guarantees such as `routing_author_provenance_missing`, `routing_absent_decorrelated_reviewer_artifact`, or `routing_required_lane_not_decorrelated:<lane>`, this is a procedure/provenance stop. Post `## Review Infrastructure Retry` with the artifact directory, reviewed head SHA, and routing condition(s), then output `[STAGE_FAILED: infra]`; do not send the issue to implement for product-code rework.
- Any other readable `verdict: "error"` or degraded condition is not a clean review: post `## Review Findings` with the error/degraded condition and artifact directory, then output `[STAGE_FAILED: review]`. Never output `[STAGE_COMPLETE]` for a non-PASS review-result.
{% endif %}
