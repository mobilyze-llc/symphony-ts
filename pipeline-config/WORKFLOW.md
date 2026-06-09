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

codex:
  command: codex --disable plugins --config 'model_reasoning_effort="low"' app-server
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
You are the review-gate operator, not the reviewer. Every PR, including low-risk PRs, must pass the headless council gate before merge.

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
  --timeout-seconds 1800
```

Read `$ARTIFACT_DIR/review-result.json` and `$ARTIFACT_DIR/council-report.md`.

If the gate reports `PASS`, output `[STAGE_COMPLETE]`.
If the gate reports `FAIL`, is degraded, times out, or artifacts are missing/malformed: post a `## Review Findings` comment on the Linear issue with the council report path and blocking summary, then output `[STAGE_FAILED: review]`.
{% endif %}
