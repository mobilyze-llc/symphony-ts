---
# ============================================================
# tracker — Issue tracker connection (currently only "linear")
# ============================================================
tracker:
  # Tracker backend. Only "linear" is supported.
  kind: linear

  # GraphQL endpoint for the Linear API.
  # Default: https://api.linear.app/graphql
  endpoint: https://api.linear.app/graphql

  # Linear API key. Use $ENV_VAR syntax to read from environment,
  # or set the LINEAR_API_KEY environment variable directly.
  # Required for dispatch.
  api_key: $LINEAR_API_KEY

  # Linear project slug (the short identifier visible in issue URLs).
  # Required for dispatch. Use $ENV_VAR syntax for self-host smoke so
  # production project slugs are not baked into repo-local workflows.
  # Example: $SYMPHONY_LINEAR_PROJECT_SLUG
  project_slug: $SYMPHONY_LINEAR_PROJECT_SLUG

  # Issue states that are eligible for the agent to pick up.
  # Default: [Todo, In Progress, In Review, Resume]
  active_states: [Todo, In Progress, In Review, Resume]

  # Issue states that are considered permanently finished.
  # Reaching one of these triggers workspace cleanup.
  # Default: [Closed, Cancelled, Canceled, Duplicate, Done]
  terminal_states: [Closed, Cancelled, Canceled, Duplicate, Done]

# Issue state used when Symphony pauses a work item for manual review.
# Keep this out of active_states unless your workflow has an explicit
# Blocked-state recovery contract.
escalation_state: Blocked

# ============================================================
# polling — How often Symphony checks for new/changed issues
# ============================================================
polling:
  # Interval between poll ticks in milliseconds.
  # Default: 30000 (30 s)
  interval_ms: 30000

# ============================================================
# workspace — Per-issue working directory management
# ============================================================
workspace:
  # Root directory under which per-issue workspaces are created.
  # Supports ~ expansion, relative paths (resolved from WORKFLOW.md),
  # and $ENV_VAR references.
  # Default: <os.tmpdir()>/symphony_workspaces
  root: /tmp/symphony_workspaces

# ============================================================
# hooks — Shell commands run at workspace lifecycle events
# All hooks are optional (omit or set to null/empty to skip).
# ============================================================
hooks:
  # Run after a new workspace directory is created.
  after_create: null

  # Run before each agent turn starts (fatal on non-zero exit).
  before_run: null

  # Run after each agent turn finishes (best-effort, errors suppressed).
  after_run: null

  # Run before a workspace is removed (best-effort, errors suppressed).
  before_remove: null

  # Maximum time in ms any single hook may run before being killed.
  # Default: 60000 (60 s)
  timeout_ms: 60000

# ============================================================
# agent — Concurrency and retry behaviour
# ============================================================
agent:
  # Maximum number of issues being processed simultaneously.
  # Default: 10
  max_concurrent_agents: 10

  # Maximum number of Codex turns allowed per run attempt.
  # Default: 20
  max_turns: 20

  # Maximum retry back-off delay in milliseconds (exponential back-off cap).
  # Default: 300000 (5 min)
  max_retry_backoff_ms: 300000

  # Per-state concurrency limits (optional, overrides max_concurrent_agents
  # for issues in a specific state). Example:
  #   max_concurrent_agents_by_state:
  #     In Review: 2
  # Default: {} (no per-state limits)
  max_concurrent_agents_by_state: {}

# ============================================================
# runner — Primary implementation lane
# ============================================================
runner:
  # Codex is the default developer runner. Use stage-level overrides for
  # specialist/review lanes rather than changing the normal implementation lane.
  # Default: codex
  kind: codex

# ============================================================
# continuous_feedback — Cheap inner-loop decorrelated pressure
# ============================================================
continuous_feedback:
  # Continuous feedback is advisory inner-loop pressure, not terminal QA.
  # Default: true
  enabled: true

  # Events that trigger feedback. Default: [checkpoint]
  events: [checkpoint]

  # Default cheap lane. Override per workflow if a different feedback runner is
  # available, but keep this separate from authoritative terminal review.
  runner: pi
  model: ds4-studio2/deepseek-v4-flash
  role: continuous-feedback
  bounce_on_finding: true

# ============================================================
# hard_stops — Per-unit loop ceilings
# ============================================================
hard_stops:
  # Maximum turns allowed before the unit is marked STALLED.
  # Default: 20
  max_iterations: 20

  # Repeated unchanged turns allowed before no-progress STALLED.
  # Set 0 to disable no-progress detection.
  # Default: 3
  no_progress_turns: 3

  # Maximum cumulative tokens before PAUSED-budget.
  # Default: 200000
  max_tokens_per_unit: 200000

  # Maximum estimated dollar spend before PAUSED-budget.
  # Default: 50
  max_dollar_budget_usd: 50

  # Pause early when premium spend reaches this share of the dollar ceiling.
  # Default: 0.8
  premium_budget_pause_ratio: 0.8

  # Estimated cost used when providers report tokens but not dollars.
  # Default: 0.05
  estimated_cost_per_1k_tokens_usd: 0.05

# ============================================================
# codex — Codex app-server process configuration
# ============================================================
codex:
  # Shell command used to launch the Codex app-server.
  # Add `--config shell_environment_policy.inherit=all` if agent turns
  # should inherit environment variables from the launching shell.
  # Default: codex app-server
  command: codex app-server

  # Launch Codex with a temporary CODEX_HOME containing only the operator auth
  # file. Use this for headless workers that should not inherit global hooks,
  # plugins, or AGENTS.md from the development environment.
  # Default: false
  ephemeral_home: false

  # When used with ephemeral_home, write a generated config.toml that disables
  # discovered Codex skills for the worker process. This removes the advertised
  # skills inventory from headless worker startup context without touching the
  # operator's real Codex config.
  # Default: false
  disable_skills: false

  # Codex approval policy, passed through to the app-server.
  # Common values depend on the installed Codex schema.
  # Example values: never, on-request, on-failure
  # Default: (not set — inherits Codex default)
  approval_policy: never

  # Thread-level sandbox mode passed through to Codex.
  # Example values: workspace-write
  # Default: (not set)
  thread_sandbox: null

  # Per-turn sandbox policy passed through to Codex.
  # Example:
  #   turn_sandbox_policy:
  #     type: workspaceWrite
  #     writableRoots:
  #       - /tmp/symphony_workspaces
  #     readOnlyAccess:
  #       type: fullAccess
  #     networkAccess: true
  #     excludeTmpdirEnvVar: false
  #     excludeSlashTmp: false
  # Default: (not set)
  turn_sandbox_policy: null

  # Maximum wall-clock time in ms for a full agent turn.
  # Default: 3600000 (1 h)
  turn_timeout_ms: 3600000

  # Maximum time in ms to wait for the next event from Codex before
  # considering the stream stalled.
  # Default: 5000 (5 s)
  read_timeout_ms: 5000

  # Maximum time in ms a running agent may be silent before being
  # declared stalled and stopped.
  # Default: 300000 (5 min)
  # Use 900000 for workflows with Claude-bearing or other slow review lanes.
  stall_timeout_ms: 300000

# ============================================================
# server — Built-in HTTP status server (optional)
# ============================================================
server:
  # Port to listen on. Set to a number to enable, or omit/null to disable.
  # Default: null (disabled)
  port: null

# ============================================================
# observability — Live dashboard refresh behavior (optional)
# ============================================================
observability:
  # Enable live updates for the HTTP dashboard.
  # Default: true
  dashboard_enabled: true

  # Heartbeat interval in milliseconds for live dashboard refreshes.
  # Used to keep runtime counters current even when no orchestration state changes.
  # Default: 1000 (1 s)
  refresh_ms: 1000

  # Minimum spacing between pushed dashboard renders in milliseconds.
  # Default: 16 (~60 FPS upper bound)
  render_interval_ms: 16
---

You are implementing work for Linear issue {{ issue.identifier }}.

<!-- Replace the lines below with your actual agent instructions. -->

Rules:

1. Implement only what the ticket asks for.
2. Keep changes scoped and safe.
3. Run the test suite before finishing.
4. Do not add secrets or credentials to the repository.
5. Open a draft PR for merge-bound work, but do not mark it ready or merge it.
6. Every PR, including low-risk PRs, requires a decorrelated review artifact before merge.
7. Keep continuous feedback separate from terminal QA.

If this workflow needs environment variables from the launching shell:

1. Launch Codex with `--config shell_environment_policy.inherit=all`.
2. Export the required environment variables before launching Symphony.

If the agent must call networked tools during a turn:

1. Configure `codex.turn_sandbox_policy` with explicit `networkAccess: true`.
2. If a specific CLI still does not find usable credentials in your environment, provide that
   tool's credential via an env var such as `GH_TOKEN`, `GITHUB_TOKEN`, or a provider-specific API
   key.

When finished:

1. Update the Linear issue state to "Done" using the `linear_graphql` tool.
   First, query the available workflow states to find the "Done" state ID:
   ```graphql
   query GetWorkflowStates {
     workflowStates {
       nodes { id name }
     }
   }
   ```
   Then update the issue:
   ```graphql
   mutation CompleteIssue($id: String!, $stateId: String!) {
     issueUpdate(id: $id, input: { stateId: $stateId }) {
       success
     }
   }
   ```

2. Provide a summary:
   - What changed
   - Test command and result
   - Any follow-up risks
