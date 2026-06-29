---
tracker:
  kind: linear
  api_key: $LINEAR_API_KEY
  project_slug: $LINEAR_PROJECT_SLUG
  active_states:
    - Todo
    - In Progress
    - In Review
    - Rework
    - Resume
  terminal_states:
    - Done
    - Cancelled

polling:
  interval_ms: 30000

workspace:
  root: ./workspaces

agent:
  max_concurrent_agents: 3
  max_turns: 30
  max_retry_backoff_ms: 300000
  max_concurrent_agents_by_state:
    in progress: 3
    in review: 2

hard_stops:
  max_iterations: 20
  no_progress_turns: 3
  max_tokens_per_unit: 1500000
  max_dollar_budget_usd: 12.5
  premium_budget_pause_ratio: 0.8
  estimated_cost_per_1k_tokens_usd: 0.05

risk_predicate_reasoning_effort: high

codex:
  command: codex --disable plugins --disable hooks --disable plugin_hooks --disable apps --disable browser_use --disable browser_use_external --disable computer_use --disable multi_agent --disable goals --disable memories --disable tool_call_mcp_elicitation --config 'model_reasoning_effort="low"' --config 'project_doc_max_bytes=0' --config 'features.codex_hooks=false' app-server
  ephemeral_home: true
  disable_skills: true
  approval_policy: never
  thread_sandbox: workspace-write
  turn_sandbox_policy:
    type: workspace-write
    network_access: true
  stall_timeout_ms: 3600000

runner:
  kind: codex

review_execution:
  crabrunner_job_group:
    enabled: true

hooks:
  after_create: ./hooks/after-create.sh
  before_run: ./hooks/before-run.sh
  timeout_ms: 120000

server:
  port: 4321

observability:
  dashboard_enabled: true
  refresh_ms: 5000

stages:
  initial_stage: investigate

  investigate:
    type: agent
    runner: codex
    max_turns: 8
    hard_stops:
      max_iterations: 4
      max_tokens_per_unit: 1200000
      max_dollar_budget_usd: 4
      premium_budget_pause_ratio: 0.9
    prompt: prompts/investigate.liquid
    on_complete: implement

  implement:
    type: agent
    runner: codex
    max_turns: 30
    prompt: prompts/implement.liquid
    on_complete: review

  review:
    type: agent
    runner: codex
    max_turns: 8
    max_rework: 3
    on_complete: merge
    on_rework: implement

  merge:
    type: agent
    runner: codex
    max_turns: 5
    prompt: prompts/merge.liquid
    on_complete: done

  done:
    type: terminal
---

{% render 'prompts/global.liquid' %}

You are working on Linear issue {{ issue.identifier }}: {{ issue.title }}.

{{ issue.description }}

{% if issue.labels.size > 0 %}
Labels: {{ issue.labels | join: ", " }}
{% endif %}

{% if stageName == "review" %}
## Stage: Review
You are the review-gate operator, not the reviewer. This workflow opts into the crabrunner-backed review job group with `review_execution.crabrunner_job_group.enabled: true`; the runtime must dispatch reviewer and QA lanes through the registered crabrunner stage backend and return a canonical `[REVIEW_GATE_RESULT_PATH: ...]` marker.

Do not run local reviewer commands or direct model-review shortcuts from this prompt. If this prompt is reached as an ordinary agent turn instead of being replaced by crabrunner review dispatch, treat that as infrastructure misconfiguration: post `## Review Infrastructure Retry` with the missing crabrunner backend or dispatcher evidence, then output `[STAGE_FAILED: infra]`.

If the investigate workpad or PR body names `risk-contract-artifact: <path>`, the runtime-owned review bundle must record that bounded artifact path under `optionalInputs.riskContractArtifactPaths`.

The runtime-owned review result must include `review_metadata.reviewed_head_sha`, `review_metadata.base_sha`, `review_metadata.round`, `review_metadata.mode`, `review_routing.decorrelationBasis.mergeEligible` (or legacy `review_metadata.decorrelation_merge_eligible`), and a clean verdict. If the crabrunner review job group reports `PASS`, the runtime emits `[REVIEW_GATE_RESULT_PATH: <artifact-dir>/review-result.json]` immediately before `[STAGE_COMPLETE]`.

If the job group reports `FAIL`, is degraded, times out, or artifacts are missing/malformed: post a `## Review Findings` comment on the Linear issue with the council report path and blocking summary, then output `[STAGE_FAILED: review]`. If the failure is substrate-only and there are no surviving P1/P2 code findings, post `## Review Infrastructure Retry` and output `[STAGE_FAILED: infra]`.
{% endif %}
