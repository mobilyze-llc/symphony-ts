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
---

You are working on the Symphony orchestrator (symphony-ts). This is the pipeline orchestration layer that schedules and coordinates autonomous development agents.

{% if stageName == "review" %}
## Symphony Review Infrastructure Routing

For this live Symphony pipeline, consume the headless council gate's substrate-stall signal from `$ARTIFACT_DIR/review-result.json`. If the machine result is `verdict: "error"` because any lane has `degradedReason: "substrate_stall"` or any `degradedConditions` entry starts with `substrate_stall:`, and there are no surviving P1/P2 code findings, this is review infrastructure, not implement rework.

- First occurrence: post `## Review Infrastructure Retry` with the artifact directory, reviewed head SHA, and stalled lane(s), then output `[STAGE_FAILED: infra]` with `substrate_stall:<lane>` details.
- Repeated substrate-stall occurrence: the orchestrator parks infra-blocked; do not write `## Review Findings` or send the issue to implement unless the council artifact contains actual surviving P1/P2 code findings.
- Any other readable `verdict: "error"` or degraded condition is not a clean review: post `## Review Findings` with the error/degraded condition and artifact directory, then output `[STAGE_FAILED: review]`. Never output `[STAGE_COMPLETE]` for a non-PASS review-result.
{% endif %}
