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
  max_tokens_per_unit: 250000
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
      max_tokens_per_unit: 200000
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
You are the review-gate operator, not the reviewer. Council is a loop over the merge candidate: every PR, including low-risk PRs, must pass the headless council gate before merge, and every material post-review change must get a convergence rerun against the new HEAD.

Do NOT run `/self-moa-review`, `/codex-review`, direct `claude -p`, or any other direct Claude invocation. Claude must run through CMUX via `symphony-council-review-gate`.

Run:

```bash
PR_NUMBER=$(gh pr view --json number --jq '.number')
REPO=$(gh repo view --json nameWithOwner --jq '.nameWithOwner')
ARTIFACT_DIR="${TMPDIR:-/tmp}/symphony-council-{{ issue.identifier }}-$(date +%s)"
CMUX_SPAWN_BIN="${CMUX_SPAWN_BIN:-$(command -v cmux-spawn || true)}"
if [ -z "$CMUX_SPAWN_BIN" ] || [ ! -x "$CMUX_SPAWN_BIN" ]; then
  echo "Set CMUX_SPAWN_BIN to an executable cmux-spawn path or put cmux-spawn on PATH." >&2
  exit 1
fi

run_council_gate() {
  if [ -n "${SYMPHONY_COUNCIL_REVIEW_GATE:-}" ]; then
    "$SYMPHONY_COUNCIL_REVIEW_GATE" "$@"
  elif command -v symphony-council-review-gate >/dev/null 2>&1; then
    symphony-council-review-gate "$@"
  elif [ -f dist/src/cli/council-review-gate.js ]; then
    pnpm build
    node dist/src/cli/council-review-gate.js "$@"
  else
    echo "Set SYMPHONY_COUNCIL_REVIEW_GATE to the Symphony gate executable, install symphony-council-review-gate on PATH, or run from a built symphony-ts checkout." >&2
    return 1
  fi
}

run_council_gate \
  --issue-id {{ issue.identifier }} \
  --artifact-dir "$ARTIFACT_DIR" \
  --workspace "$PWD" \
  --repo "$REPO" \
  --pr "$PR_NUMBER" \
  --cmux-spawn-bin "$CMUX_SPAWN_BIN" \
  --author-family codex \
  --mode {% if reworkCount > 0 %}convergence{% else %}full{% endif %} \
  --round {{ reworkCount | plus: 1 }} \
  --timeout-seconds 1800
```

Read `$ARTIFACT_DIR/review-result.json` and `$ARTIFACT_DIR/council-report.md`. The machine result must contain `review_metadata.reviewed_head_sha`, `review_metadata.base_sha`, `review_metadata.round`, `review_metadata.mode`, and a clean verdict.

If the gate reports `PASS`, output `[STAGE_COMPLETE]`.
If the gate reports `FAIL`, is degraded, times out, or artifacts are missing/malformed: post a `## Review Findings` comment on the Linear issue with the council report path and blocking summary, then output `[STAGE_FAILED: review]`.
{% endif %}
