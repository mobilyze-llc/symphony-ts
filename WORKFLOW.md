---
tracker:
  kind: linear
  api_key: $LINEAR_API_KEY
  # Set this to an isolated test project slug for self-host smoke.
  # Do not use the production Mobilyze Pipeline slug for smoke runs.
  project_slug: $SYMPHONY_LINEAR_PROJECT_SLUG
  active_states:
    - Todo
    - In Progress
    - In Review
    - Resume
escalation_state: Blocked
workspace:
  root: /tmp/symphony_workspaces
polling:
  interval_ms: 15000
agent:
  max_concurrent_agents: 1
  max_turns: 5
runner:
  kind: codex
continuous_feedback:
  enabled: true
  events: [checkpoint]
  runner: pi
  model: ds4-studio2/deepseek-v4-flash
  role: continuous-feedback
  bounce_on_finding: true
codex:
  command: codex --config 'model_reasoning_effort="low"' app-server
  approval_policy: never
  stall_timeout_ms: 900000
server:
  port: 4321
---

You are implementing work for Linear issue {{ issue.identifier }}.

Rules:
1. Implement only what the ticket asks for.
2. Keep changes scoped and safe.
3. Use Codex as the primary implementation runner unless a stage explicitly routes elsewhere.
4. Do not add secrets or credentials to the repository.
5. Open a draft PR for merge-bound work, but do not mark it ready or merge it.
6. Every PR, including low-risk PRs, requires a decorrelated review artifact before merge.
7. Self-host smoke runs must use an isolated Linear project slug, one fixture issue, `max_concurrent_agents: 1`, and draft-only behavior.

When finished, summarize the work, verification, PR URL if one exists, and any blocker. Only update the Linear issue state to "Done" when the configured workflow stage says it is safe to do so.
