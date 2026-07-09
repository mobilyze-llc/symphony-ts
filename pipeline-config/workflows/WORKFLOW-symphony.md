---
base_config: ../templates/WORKFLOW-template.md
# Single-homing guard (SYMPH-383): only this host may dispatch the symphony
# product. A second orchestrator fails loudly at startup instead of racing.
owner_host: pro14
# SYMPH-840: team-scoped dispatch. This instance grooms the whole SYMPH team's
# eligible backlog across every Linear project (not the `project` field). team_keys
# forces the mandatory admission gate + autoReleaseFrontier=0, so nothing dispatches
# without an explicit operator `symphonyctl release_batch`. project_slug is pinned
# to null to override the base template's placeholder and retire the Pipeline project
# as the dispatch scope (SYMPH-299 tracks the Linear-side terminal-issue cleanup).
# active_states is inherited from the base template; Backlog is NOT eligible, so
# moving an issue to Todo is the deliberate "make it a candidate" signal.
tracker:
  team_keys: [SYMPH]
  project_slug: null
# SYMPH-840: arm the Queue Triage v2 planner — REQUIRED alongside team_keys. The
# only admit path is `release_batch` against a persisted standing plan; with the
# planner OFF the team-scoped gate would hold every candidate forever (permanent
# lock, no escape hatch). shadow_mode keeps dispatch ORDERING on the proven
# comparator while the planner still persists releasable plans; team-scope forces
# operator-gated release regardless of shadow. Empty Todo => empty plan => quiescent.
planner_grounding:
  enabled: true
code_grounding:
  enabled: true
queue_triage:
  enabled: true
  shadow_mode: true
  plan_review:
    enabled: true
  # SYMPH-916: flip the SYMPH-896 curated-comment planner enrichment ON to start
  # the measurement window for the SYMPH-905 topology decision (two-pass vs
  # curated one-pass). Report-only: shadow_mode stays true, so this only enlarges
  # the planner context + emits queue_triage_comment_enrichment_measure events —
  # dispatch is unaffected. Caps stay at shipped defaults (measure-before-caps);
  # re-tuning the caps and the topology decision are SYMPH-905, not here.
  comment_enrichment:
    enabled: true
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
# SYMPH-812: the live Symphony workflow opts into the crabrunner review job
# group. Runtime wiring is fail-closed: the app-server must have
# SYMPHONY_CRABRUNNER_ROOT so main.ts registers both the crabrunner backend and
# the review dispatcher; otherwise review does not fall back to the removed CMUX
# runtime.
review_execution:
  crabrunner_job_group:
    enabled: true
---

You are working on the Symphony orchestrator (symphony-ts). This is the pipeline orchestration layer that schedules and coordinates autonomous development agents.

{% if stageName == "review" %}
## Symphony Review Infrastructure Routing

For this live Symphony pipeline, consume the crabrunner review job group's substrate-stall signal from `<artifact-dir>/review-result.json`. If the machine result is `verdict: "error"` because any lane has `degradedReason: "substrate_stall"` or any `degradedConditions` entry starts with `substrate_stall:`, and there are no surviving P1/P2 code findings, this is review infrastructure, not implement rework.

- First occurrence: post `## Review Infrastructure Retry` with the artifact directory, reviewed head SHA, and stalled lane(s), then output `[STAGE_FAILED: infra]` with `substrate_stall:<lane>` details.
- Repeated substrate-stall occurrence: the orchestrator parks infra-blocked; do not write `## Review Findings` or send the issue to implement unless the council artifact contains actual surviving P1/P2 code findings.
- If every reviewer lane passed but the aggregate gate failed only on routing/provenance guarantees such as `routing_author_provenance_missing`, `routing_absent_decorrelated_reviewer_artifact`, or `routing_required_lane_not_decorrelated:<lane>`, this is a procedure/provenance stop. Post `## Review Infrastructure Retry` with the artifact directory, reviewed head SHA, and routing condition(s), then output `[STAGE_FAILED: infra]`; do not send the issue to implement for product-code rework.
- Any other readable `verdict: "error"` or degraded condition is not a clean review: post `## Review Findings` with the error/degraded condition and artifact directory, then output `[STAGE_FAILED: review]`. Never output `[STAGE_COMPLETE]` for a non-PASS review-result.
{% endif %}
