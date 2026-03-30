---
base_config: ../templates/WORKFLOW-template.md
tracker:
  project_slug: fdba14472043
agent:
  max_concurrent_agents: 5
server:
  port: 4321
stages:
  fast_track:
    label: trivial
    initial_stage: implement
---

You are working on the Symphony orchestrator (symphony-ts). This is the pipeline orchestration layer that schedules and coordinates autonomous development agents.
