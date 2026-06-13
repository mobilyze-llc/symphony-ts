---
tracker:
  kind: linear
  api_key: $LINEAR_API_KEY
  project_slug: 1fa66498be91
  active_states:
    - Todo
    - Resume
  terminal_states:
    - Done
    - Cancelled

polling:
  interval_ms: 30000

workspace:
  root: ./workspaces

agent:
  max_concurrent_agents: 1
  max_turns: 30
  max_retry_backoff_ms: 300000

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

runner:
  kind: codex

hooks:
  after_create: |
    set -euo pipefail
    if [ -z "${REPO_URL:-}" ]; then
      echo "ERROR: REPO_URL environment variable is not set" >&2
      exit 1
    fi
    echo "Cloning $REPO_URL into workspace..."
    git clone --depth 1 "$REPO_URL" .
    if [ -f package.json ]; then
      if [ -f bun.lock ]; then
        bun install --frozen-lockfile
      elif [ -f pnpm-lock.yaml ]; then
        pnpm install --frozen-lockfile
      elif [ -f yarn.lock ]; then
        yarn install --frozen-lockfile
      else
        npm install
      fi
    fi
    echo "Workspace setup complete."
  before_run: |
    set -euo pipefail
    echo "Syncing workspace with upstream main..."
    git fetch origin main
    if ! git rebase origin/main 2>/dev/null; then
      echo "WARNING: Rebase failed, aborting rebase" >&2
      git rebase --abort
    fi
    echo "Workspace synced."
  timeout_ms: 120000

server:
  port: 4321

observability:
  dashboard_enabled: true
  refresh_ms: 5000
---

You are running in headless/unattended mode. Do NOT use interactive skills, slash commands, or plan mode. Do not prompt for user input. Complete your work autonomously.

Implement only what your task specifies. If you encounter missing functionality that another task covers, add a TODO comment rather than implementing it. Do not refactor surrounding code or add unsolicited improvements.

Never hardcode localhost or 127.0.0.1. Use the $BASE_URL environment variable for all URL references. Set BASE_URL=localhost:<port> during local development.

## Headless Output Discipline

Headless Codex turns have a strict output budget. This applies during investigation, code search, log inspection, validation, and PR writeup.

- Do not run high-volume commands as direct streaming commands such as `npm test 2>&1`, `pnpm test 2>&1`, broad `rg`, full log dumps, unfiltered JSON, or full lockfile/dist output.
- Start broad inspection with path/count-only commands such as `rg -l ... | sed -n '1,80p'`, `rg -c ...`, `find ... | sed -n '1,80p'`, and `git diff --stat`. Then inspect relevant files with bounded contextual commands such as `rg -n ... -m 50 path` or `sed -n '<start>,<end>p'`. Do not stream broad match lines across the whole repo.
- Keep direct command output under roughly 2,000 tokens. When a tool supports `max_output_tokens`, set it to 1,500 or less and also bound the command itself with `sed`, `head`, `tail`, `jq`, or `wc`.
- For every command that may print more than ~200 lines or 20 KB, write full stdout/stderr to `.symphony/validation/` and return only command metadata, exit code, log path, and a bounded tail/summary to the model.
- If `scripts/symphony-run-logged.mjs` exists, use it for noisy commands: `node scripts/symphony-run-logged.mjs --label <label> --tail-bytes 4000 -- <command> [args...]`.
- Shell snippets must be zsh-safe. Do not assign to `status`; zsh treats it as a read-only parameter. Use neutral names such as `cmd_status` or `exit_code`.
- If the helper does not exist, redirect output yourself: `mkdir -p .symphony/validation && <command> > .symphony/validation/<label>.log 2>&1; cmd_status=$?; tail -n 80 .symphony/validation/<label>.log; exit $cmd_status`.
- Do not poll a long-running command with a large output budget. Wait for completion, then inspect only the log path, exit code, and a short tail unless deeper diagnosis is required.
- PR bodies, workpads, and Linear comments should include command, exit code, log path, and a compact summary/tail. Do not paste full raw logs, broad search output, or SAST JSON unless the artifact is under 20 KB.

# Implementation: {{ issue.identifier }} — {{ issue.title }}

You are implementing Linear issue {{ issue.identifier }}.

## Issue Description

{{ issue.description }}

{% if issue.labels.size > 0 %}
Labels: {{ issue.labels | join: ", " }}
{% endif %}

## Implementation Steps

1. Read any investigation notes from previous comments on this issue.
2. Create a feature branch from the issue's suggested branch name{% if issue.branch_name %} (`{{ issue.branch_name }}`){% endif %}, or use `{{ issue.identifier | downcase }}/<short-description>`.
3. Implement the task per the issue description.
4. Write tests as needed.
5. Run all `# Verify:` commands from the spec. You are not done until every verify command exits 0.
6. Commit your changes with message format: `feat({{ issue.identifier }}): <description>`.
7. Open a PR targeting this repo (not its upstream fork parent) via `gh pr create --repo $(git remote get-url origin | sed "s|.*github.com/||;s|\.git$||")` with the issue description in the PR body.
8. Link the PR to the Linear issue by including `{{ issue.identifier }}` in the PR title or body.

## Scope Discipline

- If your task requires a capability that doesn't exist in the codebase and isn't specified in the spec, stop and comment what's missing on the issue. Don't scaffold unspecced infrastructure.
- Tests must be runnable against $BASE_URL (no localhost assumptions in committed tests).

## Documentation Maintenance

- Put generated markdown docs, plans, handoffs, ADR-style notes, runbooks, and investigation briefs in Linear Docs, not repo-local markdown, unless the issue explicitly asks for checked-in documentation.
- Use `linear-pp-cli documents create/edit --content-file <temp-file> --issue {{ issue.identifier }} --agent` for issue-scoped markdown docs.
- If a checked-in docs change is explicitly required by the issue, keep it scoped to that requirement and include it in the same PR as the code change.
- If the markdown names durable follow-up work, search Linear first, then create or update the issue before mentioning it in the doc.
- Do not update docs/generated/ files; those are auto-generated and will be overwritten.
