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
