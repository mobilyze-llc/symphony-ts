# Symphony-TS Developer Quick-Start Guide

> For: developers with a Linear test project who want to run Symphony locally and start contributing.

---

## What Is This Project

Symphony-TS is a TypeScript implementation of the [Symphony](https://github.com/openai/symphony) baseline with Mobilyze fork behavior documented in [`../SPEC.mobilyze.md`](../SPEC.mobilyze.md).

**In one sentence**: A long-running daemon that polls a Linear board, creates isolated workspaces for each active issue, launches a Codex (OpenAI coding agent) subprocess per issue, and manages concurrency, retries, state reconciliation, and observability.

**Core data flow**:

```
WORKFLOW.md (config + prompt template)
      |
      v
[Orchestrator] -- polls Linear --> active Issues
      |
      v
[WorkspaceManager] -- creates /tmp/symphony_workspaces/<issue-key>/
      |
      v
[AgentRunner] -- spawns codex app-server subprocess in workspace
      |
      v
Codex agent works on the issue, writes back to Linear via linear_graphql tool
```

---

## Project Structure

```
src/
  cli/              # Entry point: main.ts - parses CLI args, loads config, starts runtime
  config/           # WORKFLOW.md parsing, typed config resolution, hot-reload file watcher
  domain/           # Core type definitions (Issue, RunAttempt, LiveSession, etc.)
  orchestrator/     # Dispatch core (core.ts) + runtime host (runtime-host.ts)
  agent/            # AgentRunner (spawns Codex subprocess) + prompt builder
  tracker/          # Linear GraphQL client, queries, response normalization
  codex/            # Codex app-server protocol client + linear_graphql dynamic tool
  workspace/        # Workspace directory management, path safety, lifecycle hooks
  logging/          # Structured logging, session metrics, runtime snapshots
  observability/    # Optional HTTP dashboard server
  errors/           # Error code constants
  index.ts          # Public API exports

tests/              # Vitest tests, mirroring src/ structure
```

**Key files at a glance**:

| Concern | File |
|---------|------|
| Dispatch logic | [src/orchestrator/core.ts](src/orchestrator/core.ts) |
| Runtime startup | [src/orchestrator/runtime-host.ts](src/orchestrator/runtime-host.ts) |
| Config resolution | [src/config/config-resolver.ts](src/config/config-resolver.ts) |
| Defaults | [src/config/defaults.ts](src/config/defaults.ts) |
| Linear client | [src/tracker/linear-client.ts](src/tracker/linear-client.ts) |
| Agent launch | [src/agent/runner.ts](src/agent/runner.ts) |
| Prompt construction | [src/agent/prompt-builder.ts](src/agent/prompt-builder.ts) |
| Codex protocol | [src/codex/app-server-client.ts](src/codex/app-server-client.ts) |
| CLI entry | [src/cli/main.ts](src/cli/main.ts) |
| Domain model | [src/domain/model.ts](src/domain/model.ts) |

---

## Step-by-Step Quick Start

### Step 1: Prerequisites

Make sure you have:
- Node.js >= 22
- pnpm >= 10
- Codex CLI installed (`codex app-server` command must be available)

```bash
node --version    # must be v22+
pnpm --version    # must be 10+
codex --version   # must support codex app-server
```

### Step 2: Install Dependencies and Build

```bash
pnpm install
pnpm build
```

Build output goes to `dist/`. The CLI entry point is `dist/src/cli/main.js`.

Verify the build:

```bash
node dist/src/cli/main.js --help
```

### Step 3: Get Your Linear API Key and Project Slug

1. Go to Linear -> Settings -> API -> Personal API Keys
2. Create a new key and copy it
3. Find your test project's **slug** (visible in the URL or project settings)

Export the key as an environment variable (never commit it):

```bash
export LINEAR_API_KEY="lin_api_xxxxxxxxxxxx"
```

Or put it in an untracked `.env.local` and source it yourself — Symphony does not auto-load `.env` files.

### Step 4: Create WORKFLOW.md

Create a `WORKFLOW.md` in the **target repository** (the codebase Codex will work in), or in any directory you will run Symphony from.

Minimal working example:

```markdown
---
tracker:
  kind: linear
  api_key: $LINEAR_API_KEY
  project_slug: $SYMPHONY_LINEAR_PROJECT_SLUG
  active_states:
    - "Todo"
    - "In Progress"
    - "In Review"
    - "Resume"
  terminal_states:
    - "Closed"
    - "Cancelled"
    - "Canceled"
    - "Duplicate"
    - "Done"

escalation_state: "Blocked"

polling:
  interval_ms: 30000

workspace:
  root: ~/symphony_workspaces

agent:
  max_concurrent_agents: 2
  max_turns: 20

runner:
  kind: codex

codex:
  command: "codex app-server"
  approval_policy: "never"
  turn_timeout_ms: 3600000
  stall_timeout_ms: 300000
---

You are a software engineer working on a Linear issue.

Issue: {{ issue.identifier }} - {{ issue.title }}
State: {{ issue.state }}
Description: {{ issue.description | default: "No description provided." }}
{% if attempt %}Retry attempt: {{ attempt }}{% endif %}

Work on this issue. When done, use the linear_graphql tool to transition the
issue to "In Review" and leave a comment summarizing what you did.
```

**WORKFLOW.md field reference**:

> For an annotated file covering every field with defaults and comments, see
> [WORKFLOW.template.md](WORKFLOW.template.md).

| Field | Description | Default |
|-------|-------------|---------|
| `tracker.kind` | Tracker backend. Only `linear` is supported | `linear` |
| `tracker.endpoint` | GraphQL endpoint for the Linear API | `https://api.linear.app/graphql` |
| `tracker.api_key` | Linear API key; use `$ENV_VAR` to reference env | Reads `LINEAR_API_KEY` env var |
| `tracker.project_slug` | Linear project slug — required; use `$ENV_VAR` for self-host smoke | None |
| `tracker.active_states` | Issue states that trigger dispatch | `[Todo, In Progress, In Review, Resume]` |
| `tracker.terminal_states` | States that trigger workspace cleanup | `[Closed, Cancelled, Canceled, Duplicate, Done]` |
| `escalation_state` | Issue state used when Symphony pauses a work item for manual review; keep it out of `active_states` unless your workflow has an explicit recovery contract | None |
| `polling.interval_ms` | Poll interval in milliseconds | `30000` |
| `workspace.root` | Root directory for all workspaces | `<os.tmpdir()>/symphony_workspaces` |
| `hooks.after_create` | Shell command run after workspace is created | `null` |
| `hooks.before_run` | Shell command run before each agent turn (fatal on non-zero exit) | `null` |
| `hooks.after_run` | Shell command run after each agent turn (errors suppressed) | `null` |
| `hooks.before_remove` | Shell command run before workspace removal (errors suppressed) | `null` |
| `hooks.timeout_ms` | Max time in ms for any single hook | `60000` |
| `agent.max_concurrent_agents` | Global agent concurrency cap | `10` |
| `agent.max_turns` | Max Codex turns per run | `20` |
| `agent.max_retry_backoff_ms` | Max retry back-off delay in ms (exponential cap) | `300000` |
| `agent.max_concurrent_agents_by_state` | Per-state concurrency overrides (map of state → limit) | `{}` |
| `runner.kind` | Default implementation runner | `codex` |
| `hard_stops.max_iterations` | Per-unit turn cap before `STALLED` | `20` |
| `hard_stops.no_progress_turns` | Repeated unchanged turns before `STALLED`; `0` disables | `3` |
| `hard_stops.max_tokens_per_unit` | Token ceiling before `PAUSED-budget` | `200000` |
| `hard_stops.max_dollar_budget_usd` | Estimated dollar ceiling before `PAUSED-budget` | `50` |
| `hard_stops.premium_budget_pause_ratio` | Early pause threshold as a share of dollar ceiling | `0.8` |
| `hard_stops.estimated_cost_per_1k_tokens_usd` | Fallback cost estimate for token-only providers | `0.05` |
| `codex.command` | Shell command to launch Codex | `codex app-server` |
| `codex.ephemeral_home` | Launch Codex with a temporary `CODEX_HOME` that symlinks only operator auth | `false` |
| `codex.disable_skills` | With `ephemeral_home`, write a generated `config.toml` that disables discovered Codex skills for the worker | `false` |
| `codex.approval_policy` | Codex approval policy, passed through to the installed Codex schema | Inherits Codex default |
| `codex.thread_sandbox` | Thread-level sandbox mode (e.g. `workspace-write`) | `null` |
| `codex.turn_sandbox_policy` | Per-turn sandbox policy object | `null` |
| `codex.turn_timeout_ms` | Max wall-clock time in ms for a full agent turn | `3600000` |
| `codex.read_timeout_ms` | Max time in ms to wait for the next Codex event before declaring stream stalled | `5000` |
| `codex.stall_timeout_ms` | Max silent time in ms before a running agent is declared stalled and stopped | `300000` |
| `server.port` | HTTP dashboard port; omit or `null` to disable | `null` |
| `SYMPHONY_OPERATOR_TOKEN` | Bearer token required by dashboard mutating routes and used by `symphonyctl` | unset |
| `observability.dashboard_enabled` | Enable live dashboard updates when the HTTP server is running | `true` |
| `observability.refresh_ms` | Dashboard heartbeat interval in ms for time-based refreshes | `1000` |
| `observability.render_interval_ms` | Minimum spacing in ms between pushed dashboard renders | `16` |

The prompt body uses **Liquid template syntax**. Available variables:
- `{{ issue.identifier }}`, `{{ issue.title }}`, `{{ issue.description }}`
- `{{ issue.state }}`, `{{ issue.url }}`, `{{ issue.labels }}`
- `{{ attempt }}` — `null` on first run, integer on retries

### Step 5: Run Symphony

```bash
# Run from the directory containing WORKFLOW.md
node dist/src/cli/main.js --acknowledge-high-trust-preview

# Or specify the WORKFLOW.md path explicitly
node dist/src/cli/main.js /path/to/your/WORKFLOW.md \
  --acknowledge-high-trust-preview

# Enable the optional HTTP dashboard
node dist/src/cli/main.js --acknowledge-high-trust-preview --port 3000
```

> `--acknowledge-high-trust-preview` is a required safety flag. Symphony runs agent code without sandboxing by default; this flag confirms you understand that.

### Environment and networked CLI note

If your workflow depends on environment variables from the launching shell, launch Codex with
shell environment inheritance enabled:

```yaml
codex:
  command: codex --config shell_environment_policy.inherit=all app-server
```

If the agent must use networked tools during a turn, configure an explicit
`codex.turn_sandbox_policy` that allows network access, for example:

```yaml
codex:
  approval_policy: never
  thread_sandbox: workspace-write
  turn_sandbox_policy:
    type: workspaceWrite
    writableRoots:
      - /tmp/symphony_workspaces
    readOnlyAccess:
      type: fullAccess
    networkAccess: true
    excludeTmpdirEnvVar: false
    excludeSlashTmp: false
```

With that in place, env-based credentials exported before launching Symphony are available to turn
commands. If a specific external CLI still does not find usable credentials in your environment,
provide that tool's credential explicitly via an env var such as `GH_TOKEN`, `GITHUB_TOKEN`, or a
provider-specific API key.

The exact accepted sandbox and approval values depend on the installed Codex app-server version. To
inspect the local schema, run `codex app-server generate-json-schema --out <dir>` and inspect the
generated `ThreadStartParams` and `TurnStartParams` schema files.

### Step 6: Trigger a Test Issue in Linear

1. Open your Linear test project
2. Create an issue and set its state to `Todo` or `In Progress`
3. Wait for the next poll cycle (default: 30 seconds)
4. Watch Symphony's terminal output — the issue should be dispatched
5. Codex will run inside `~/symphony_workspaces/<issue-key>/`

### Step 7: Run Tests

```bash
pnpm test           # run all tests once
pnpm test:watch     # watch mode
pnpm typecheck      # TypeScript type check only
pnpm lint           # Biome lint check
pnpm format         # Biome auto-format
```

---

## Key Concepts for Development

### Orchestrator State Machine

Each issue moves through these internal states:

```
unclaimed -> claimed -> running -> (retry_queued -> running)* -> released
```

- **unclaimed**: fetched from Linear but not yet reserved
- **claimed**: slot reserved; prevents duplicate dispatch
- **running**: Codex agent is active
- **retry_queued**: agent exited, waiting to re-dispatch (normal exit: 1s delay; abnormal exit: exponential backoff capped at 5 minutes)
- **released**: issue reached a terminal state; claim freed

### Workspace Lifecycle Hooks

Configure shell scripts in `WORKFLOW.md` that run at workspace lifecycle points:

```yaml
hooks:
  after_create: |
    git clone https://github.com/your-org/your-repo.git .
    npm install
  before_run: |
    git pull --rebase
  after_run: |
    echo "Agent finished"
  before_remove: |
    echo "Workspace being cleaned up"
  timeout_ms: 60000
```

`after_create` is the most important hook — use it to clone your repo into the fresh workspace before the agent starts.

### Headless Codex Skill Denylist (`codex.disable_skills`)

With `codex.ephemeral_home: true`, each worker launch gets a temporary
`CODEX_HOME` containing only a symlink to the operator's `auth.json`. With
`codex.disable_skills: true`, Symphony also writes a generated `config.toml`
into that home with one `[[skills.config]] ... enabled = false` entry per
discovered skill.

**Why this exists (token economics).** Codex re-sends the advertised skills
inventory on every app-server tool interaction, so a worker is rebilled for it
on each tool call. On the SYMPH-309 reproduction, the denylist cut the
model-visible prompt from ~16.8k chars (21 advertised skills) to ~4.8k chars
(zero skills); the unhardened run burned ~1M tokens on a single thin issue.

**The discovery contract** (see `discoverCodexSkillPaths` in
`src/codex/app-server-client.ts`). The generated denylist must cover every
path Codex's own skill discovery can resolve at launch:

- **Built-in system skills** materialize at runtime under
  `$CODEX_HOME/skills/.system/<name>/SKILL.md` — inside the *ephemeral* home,
  even when it starts empty. The denylist therefore pre-disables those paths
  before they exist, for a pinned default name list plus any `.system` entries
  found in the operator home (which capture names added by newer Codex
  versions).
- **External skill roots**: `~/.agents/skills` and `/etc/codex/skills` are
  scanned by Codex outside the ephemeral `CODEX_HOME`, so their `SKILL.md`
  files are disabled by absolute (realpath'd) path. The operator home's
  `skills/.system` directory is still read for future system-skill names, but
  the operator home's user `skills/` directory is not a live discovery root once
  `CODEX_HOME` points at the ephemeral home.
- **Repo-local skills**: `.agents/skills` directories from the workspace cwd
  up to the nearest `.git` boundary.

**Why a generated config file rather than CLI flags.** `--disable skills` does
not exist on Codex 0.135.0 (`codex features list` has no `skills` flag), so
per-skill `[[skills.config]]` entries are the documented disable mechanism.
The same TOML array could be passed inline via `-c 'skills.config=[...]'`;
Symphony writes it to the ephemeral home's `config.toml` instead so the
denylist (and any future worker-scoped settings) live in one generated file
and the worker command stays operator-readable. Hindsight/memory suppression
is *not* provided by the denylist — it comes from the bare worker command
(`--disable hooks --disable plugin_hooks`, verified effective on 0.135.0) plus
the clean home.

**What a future Codex change must preserve.** If a Codex upgrade adds new
discovery roots, renames the `.system` materialization path, or ships a real
`skills` feature flag, `discoverCodexSkillPaths` must be updated to match.
The canary is the live probe — run it after every Codex CLI upgrade:

```bash
pnpm build
pnpm probe:codex-skills            # real + empty-clean-home modes
pnpm probe:codex-skills --mode clean
```

The probe (`scripts/probe-codex-skills.mjs`) builds an ephemeral home through
the exact production code path, swaps the workflow `codex.command`'s trailing
`app-server` for `debug prompt-input`, and fails if the rendered prompt still
contains a `### Available skills` section or a Hindsight block. It needs a
local authed `codex` CLI, so it is not part of `pnpm test`.

### linear_graphql Dynamic Tool

Every Codex agent run automatically gets a `linear_graphql` tool injected, allowing the agent to read and write Linear directly.

For issue/comment/document body writes, pass markdown through GraphQL variables, use `sync_workpad`, or use `linear-pp-cli` file-backed commands such as `comments add/edit --body-file` and `documents create/edit --content-file`. Do not use Codex app/connector MCP tools for Linear writes in headless runs because they can request interactive elicitation.
Symphony rejects inline `body: "..."`, `description: "..."`, and `content: "..."` literals on Linear write mutations so shell-sensitive snippets such as `$VAR`, `${VAR}`, `$(cmd)`, and backticks remain literal data.

```graphql
# Example mutation an agent might run to update issue state
mutation UpdateState($id: String!, $stateId: String!) {
  issueUpdate(id: $id, input: { stateId: $stateId }) {
    success
  }
}
```

### Concurrency Control

```yaml
agent:
  max_concurrent_agents: 5           # global cap
  max_concurrent_agents_by_state:    # per-state fine-grained control
    "in progress": 3
    "todo": 2
```

State keys are matched case-insensitively.

### Config Hot-Reload

These fields take effect on the next poll tick without restarting Symphony:
- `polling.interval_ms`
- `agent.max_concurrent_agents`
- `agent.max_retry_backoff_ms`
- `hooks.timeout_ms`

---

## Troubleshooting

**An issue in Todo is silently never dispatched (requires-explicit-resume mark)**

Repro of the 2026-06-11 frozen-queue incident, now diagnosable with ONE read
(SYMPH-405/406). Before, confirming a park meant cross-referencing seven data
sources (Linear state + comments, orchestrator logs, journal grep, dashboard,
retry queue, lease table, breaker state). Now:

```bash
curl -s http://localhost:3000/api/v1/state | jq '.explicit_resume_required, .dispositions'
```

The same single read now also answers the rest of the 2026-06-11 question
list (SYMPH-407):

```bash
curl -s http://localhost:3000/api/v1/state | jq '{
  as_of_sequence,            # journal cursor — feed into /api/v1/state/delta
  counters,                  # per-issue escalation steps, triage resumes, rework, token spend
  rate_limit_views,          # BOTH rate trackers side by side + disagreement flag
  deploy_drift,              # running commit vs origin/main (captured at startup)
  watchdog,                  # signature clusters + open breakers with journal cursors
  components                 # every fail-open element: {enabled, degraded_reason?}
}'
```

- `counters[<issueId>]` shows the durable SYMPH-401 counters next to the
  issue's disposition and mark: `escalation_steps`, `triage_resumes`,
  `rework_count`, and cumulative `spend.total_tokens`.
- `rate_limit_views` renders the runner snapshot file
  (`.symphony/rate-limits.json`) and the dispatch admission gate's last
  evaluation side by side with their sources; `disagreement: true` is the
  SYMPH-338 6%-vs-98% case made visible instead of costing a diagnosis cycle.
- `deploy_drift` makes "merged ≠ deployed" one field: `running_commit` vs
  `origin_main_commit` with `captured_at`. Both are captured ONCE at startup
  and never refreshed (`origin_main_commit` is the local ref, no fetch) —
  treat `captured_at` as the comparison's truth time.
- `components` lists every fail-open element (Slack notifier, watchdog
  filer, circuit breaker, stuck triage, pause triage, AC gate,
  spec-fidelity, rate-limit admission) as `{enabled, degraded_reason?}` — a
  silently disabled guard shows up here instead of being discovered
  mid-incident.
- Cursor-forward reads: take `as_of_sequence` from one snapshot, then fetch
  exactly what happened since with
  `curl -s "http://localhost:3000/api/v1/state/delta?since_seq=<N>&limit=100"`
  — journal-backed entries between the two cursors, bounded (max 500 per
  page; `truncated: true` means page again from the last entry's sequence).
  Slack gate/halt alerts and watchdog tickets carry the matching
  `(issue, seq)` cursor.
  `/state/delta` is a projection, not a raw journal passthrough: metadata is
  limited to bounded scalar and count fields. Array-valued review metadata such
  as rework origins, synthesis fingerprints, degraded condition labels, related
  paths, and evidence locations stays in `.symphony/run-journals/dispatcher.jsonl`;
  dashboard/control surfaces should use `rework_finding_count`,
  `blocking_finding_count`, and `degraded_condition_count` plus the projected
  scalar reason/verdict fields.
- Restart replay is bounded by journal checkpoints (SYMPH-293). On successful
  dispatcher-journal hydration, Symphony may rewrite
  `.symphony/run-journals/dispatcher.jsonl` under the journal write lock as one
  `journal_checkpoint` row plus the most recent raw tail (default 1000 rows).
  Checkpoints preserve the replay-reduced state needed for restart correctness:
  active claims/leases, explicit-resume marks and guards, hard-stop state,
  tracker-write terminal state, gate outcomes, admission/disposition state,
  supervision dedupe guards, anchors, counters, and dispatcher decision-quality
  inputs. Sequence numbers are never renumbered; the checkpoint records the
  covered cursor and later appends continue from the durable tail cursor.
- `/state/delta` remains exact inside the retained raw tail. If an operator asks
  for a `since_seq` before the checkpoint horizon, the response includes the
  checkpoint row plus retained tail rather than every historical event. Treat
  the checkpoint as the restart proof for older state and use current snapshot
  sections (`explicit_resume_required`, `decorrelated_gates`, `decision_quality`,
  `dispositions`, `watchdog`, `counters`) for the reduced view.
- Emergency-stop recovery is fail-closed: if hydration finds an interrupted
  process tree whose cleanup proof is still unconfirmed, journal compaction is
  skipped so the raw stop/proof rows remain available to the next restart.
- Council review artifacts carry the fuller `review_routing` object. Treat
  `selectedLanes[].reason` as a machine-readable contract:
  `non_author_family_reviewer_artifact` means the lane can satisfy the required
  decorrelated reviewer gate, `same_family_author_signal` means the lane ran as
  useful auxiliary signal but cannot satisfy decorrelation for the current
  author family, `direct_codex_excavation_signal` means a Codex excavation lane
  ran as direct edge-case search, and `codex_lead_triage` means in-session Codex
  adjudication. For `codex-excavation`, `selectedLanes[].codexExcavationSweep`
  records the selected execution preset (`standard` or `high-risk`) so reports,
  dashboards, and replay tooling can distinguish the selected metadata from the
  actual lane command budget.
- The JSON `review-result.json` and lane `*.structured.json` artifacts remain
  the source of truth for council tooling. The Markdown council report is
  operator-facing, but its lane table keeps `Bundle File Hash` and
  `Bundle Hash` columns as a compatibility surface for existing table readers.
  Structured artifact `confidence` is `0` for malformed artifacts, otherwise
  the maximum parsed per-finding confidence when findings exist; clean
  no-finding artifacts use the verdict parser confidence (`0.75` for PASS,
  `0.6` otherwise).
- `review_routing.decorrelationBasis.authorFamilies` canonicalizes author
  provenance with token-boundary model-family matching. Recognized tokens are
  OpenAI/Codex (`codex`, `openai`, `gpt` including separator-delimited
  variants such as `gpt-*`), Anthropic (`anthropic`, `claude`, `opus`,
  `sonnet`), and Pi/DeepSeek (`pi`, `deepseek`). Wrapper names and transport
  labels such as `myopenaiclient`, `claudewrapper`, or `local-api` remain their
  explicit provenance string instead of collapsing into a canonical family.
  Underscore/snake_case separators are intentional token boundaries:
  `my_codex_client` canonicalizes to `openai-codex`.
- Council reviewer artifact preambles are normalized only when the text before
  `## Verdict` is plain prose within the calibrated bounds of 3000 characters
  and 12 non-empty lines. Treat those values as evidence-backed parser
  calibration constants. Change them only with raw reviewer artifacts showing
  safe Pi/DeepSeek prose rejected solely by the bound; keep the malformed,
  diff-token, markdown-structure, and smuggled-heading rejection tests paired
  with any bound change.
- Preamble list and task-list lines fail closed when they start with an
  artifact section label. Supported heading-label delimiters are `:`, `.`, `!`,
  `?`, `-`, `–`, and `—`; the parser accepts the same label separators between
  heading words, so both `P2 Should Fix - ...` and `P2 - Should Fix: ...` are
  rejected before `## Verdict`. This keeps reviewer prose from smuggling a
  blocking section into text that would otherwise be skipped.
- Artifact section headings normalize by replacing colons with spaces,
  collapsing whitespace, and lowercasing. New `ARTIFACT_SECTION_HEADINGS`
  entries must have unique normalized keys; module initialization fails on a
  collision so aliases such as `P2: Should Fix` cannot silently change parser
  policy.
- Claude runner artifacts are validated before a lane can report `passed`.
  Purpose-specific callers can require a first heading, required headings,
  verdict enums, non-empty `## Source Read Status`, and required fenced JSON
  sections. `requireSourceReadStatus` is section-based: incidental
  `SOURCE_READ_STATUS` prose elsewhere in the artifact does not count. Required
  JSON sections are delimiter-aware and accept wider fences when the JSON string
  contains shorter markdown fences, but malformed, unterminated, missing,
  duplicate, or non-object JSON fails closed with actionable validation errors.
- `claude-runner` writes bounded command diagnostics into the normalized
  result envelope under `diagnostics`. Each stdout/stderr value records retained
  text, original byte count, omitted byte count, truncation status, and the
  configured byte limit. Use `--diagnostic-byte-limit` when a caller needs a
  tighter or wider retained diagnostic budget.

- `explicit_resume_required` lists every parked issue with the `reason`
  (e.g. `hard_stop:token_budget`, `operator_input_required`,
  `intent:park:manual_park`) and `set_by_sequence` — the journal event cursor
  that set the mark (look up the full event by `sequence` in
  `.symphony/run-journals/dispatcher.jsonl`).
- `dispositions[<issueId>]` shows the live skip verdict
  (`skip` / `requires_explicit_resume`) with the remedy: transition the issue
  into **Resume** (Todo alone is skipped), or clear the park with the fenced
  `release` intent verb. Marks survive restarts via journal replay; the only
  clear paths are the release/resume verb (journaled with actor attribution)
  and an explicit Resume transition.

**Issues are not being dispatched after startup**
- Verify `tracker.project_slug` matches exactly (check Linear project URL)
- For self-host smoke, set `SYMPHONY_LINEAR_PROJECT_SLUG` to an isolated test project slug, not the production project slug
- Verify `LINEAR_API_KEY` is set and valid
- Check that the issue's current state matches an entry in `active_states` (comparison is case-insensitive after trim)

**`codex app-server` command not found**
- Confirm Codex CLI is installed and on `PATH`
- Use an absolute path in WORKFLOW.md: `codex.command: "/usr/local/bin/codex app-server"`

**Agent stalls and never finishes**
- `codex.stall_timeout_ms` (default 5 minutes) will kill and retry a stalled agent
- Set `codex.stall_timeout_ms: 0` to disable stall detection

**How to watch runtime state**
- Structured JSON logs are the primary observability surface
- Launch with `--port 3000` to access the HTTP dashboard at `http://localhost:3000`
- The dashboard serves an initial HTML snapshot, then stays current over `/api/v1/events`
- Dashboard read routes stay open; POST routes that mutate runtime state require
  `Authorization: Bearer $SYMPHONY_OPERATOR_TOKEN`. Set the same variable before running
  `symphonyctl` for pause/resume/stop/intent commands.

---
