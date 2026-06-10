---
tracker:
  kind: linear
  api_key: $LINEAR_API_KEY
  # CUSTOMIZE: Set to the Linear project's slugId for this product.
  # Find it via: linear_graphql query { projects { nodes { id name slugId } } }
  project_slug: <YOUR_PROJECT_SLUG_HERE>
  active_states:
    - Todo
    - In Progress
    - In Review
    - Resume
  terminal_states:
    - Done
    - Cancelled

escalation_state: Blocked

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
  # SYMPH-333: pause a unit that burns more than its share of a Codex
  # subscription window, in percent points of the window (0-100). Primary is
  # the 5-hour window, secondary the weekly window. Sized from SYMPH-319
  # canaries (a full investigate unit burned ~1% of the weekly window).
  max_primary_window_pct_per_unit: 25
  max_secondary_window_pct_per_unit: 5

# SYMPH-333: refuse NEW dispatches when the observed remaining share of a
# Codex subscription window is below these floors. Running lanes finish
# normally. Protects interactive operator headroom — the 2026-06-09 session
# halt happened at 3% weekly headroom while dollar budgets still admitted.
rate_limit_admission:
  min_primary_headroom_pct: 10
  min_secondary_headroom_pct: 5

# SYMPH-337: deterministic budget-escalation ladder. A budget hard stop
# auto-resumes the unit with a multiplied budget (base * multiplier^step)
# up to max_steps times per issue, then parks for the operator. With the
# investigate stage's $4 base this bounds cumulative per-issue spend at
# 4 + 8 + 16 = $28 per stage. Escalations never run while the admission
# floor is blocked, and only budget triggers escalate (never no_progress,
# iteration_cap, or permission stops). Operator-approved assertive defaults.
budget_escalation:
  max_steps: 2
  multiplier: 2

# SYMPH-337 slice 2: LLM pause triage on the operator's local model (zero
# marginal cost; never consumes the Codex window it adjudicates). Consulted
# only when the ladder declines a budget pause; a continue verdict grants
# ONE continuation at the current ceiling, bounded by max_resumes per issue.
# Any endpoint/schema failure parks for the operator (fail closed).
pause_triage:
  base_url: http://studio2.local:8000/v1
  model: deepseek-v4-flash
  api_key: $LOCAL_LLM_API_KEY
  max_resumes: 2

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
  after_create: |
    set -euo pipefail
    if [ -z "${REPO_URL:-}" ]; then
      echo "ERROR: REPO_URL environment variable is not set" >&2
      exit 1
    fi

    # --- Derive bare clone path (absolute, shared across workers) ---
    REPO_SLUG=$(basename "${REPO_URL%.git}")
    BARE_CLONE_DIR="$(cd .. && pwd)/.bare-clones"
    BARE_CLONE="$BARE_CLONE_DIR/$REPO_SLUG"
    WORKSPACE_DIR="$PWD"
    ISSUE_KEY=$(basename "$WORKSPACE_DIR")
    BRANCH_NAME="worktree/$ISSUE_KEY"

    # --- Create bare clone if it doesn't exist (race-safe) ---
    mkdir -p "$BARE_CLONE_DIR"
    if [ ! -d "$BARE_CLONE" ]; then
      echo "Creating shared bare clone for $REPO_SLUG..."
      if ! git clone --bare "$REPO_URL" "$BARE_CLONE" 2>/dev/null; then
        # Another worker may have created it concurrently — verify it exists
        if [ ! -d "$BARE_CLONE" ]; then
          echo "ERROR: Failed to create bare clone at $BARE_CLONE" >&2
          exit 1
        fi
        echo "Bare clone already created by another worker."
      fi
    else
      echo "Using existing bare clone at $BARE_CLONE"
    fi

    # --- Fetch latest refs into bare clone ---
    BASE_BRANCH="${SYMPHONY_BASE_BRANCH:-main}"
    if ! git -C "$BARE_CLONE" fetch origin \
      "+refs/heads/$BASE_BRANCH:refs/heads/$BASE_BRANCH" \
      "+refs/heads/*:refs/remotes/origin/*" 2>/dev/null; then
      echo "WARNING: fetch failed, using cached refs" >&2
    fi

    if git -C "$BARE_CLONE" show-ref --verify --quiet "refs/remotes/origin/$BASE_BRANCH"; then
      WORKTREE_BASE="origin/$BASE_BRANCH"
    elif git -C "$BARE_CLONE" show-ref --verify --quiet "refs/heads/$BASE_BRANCH"; then
      WORKTREE_BASE="$BASE_BRANCH"
    else
      echo "ERROR: Could not resolve base branch $BASE_BRANCH in $BARE_CLONE" >&2
      exit 1
    fi

    # --- Clean up stale branch from previous failed attempt (idempotency) ---
    if git -C "$BARE_CLONE" show-ref --verify --quiet "refs/heads/$BRANCH_NAME"; then
      echo "Cleaning up stale branch $BRANCH_NAME from previous attempt..."
      # Remove workspace contents so the worktree entry becomes stale
      find "$WORKSPACE_DIR" -mindepth 1 -maxdepth 1 -exec rm -rf {} + 2>/dev/null || true
      # Prune now-stale worktree entry, then delete the orphaned branch
      git -C "$BARE_CLONE" worktree prune 2>/dev/null || true
      git -C "$BARE_CLONE" branch -D "$BRANCH_NAME" 2>/dev/null || true
    fi

    # --- Create worktree for this issue ---
    echo "Creating worktree for $ISSUE_KEY on branch $BRANCH_NAME from $WORKTREE_BASE..."
    git -C "$BARE_CLONE" worktree add "$WORKSPACE_DIR" -b "$BRANCH_NAME" "$WORKTREE_BASE"

    # --- Install dependencies ---
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
    # --- Build code graph (best-effort) ---
    if command -v code-review-graph >/dev/null 2>&1; then
      echo "Building code review graph..."
      code-review-graph build --repo . || echo "WARNING: code-review-graph build failed, continuing without graph" >&2
    else
      echo "WARNING: code-review-graph not installed, skipping graph build" >&2
    fi
    echo "Workspace setup complete (worktree: $BRANCH_NAME)."
  before_run: |
    set -euo pipefail
    echo "Syncing workspace with upstream..."

    # --- Resolve git dir (worktree .git is a file, not a directory) ---
    resolve_git_dir() {
      if [ -f .git ]; then
        # Worktree: .git is a file containing "gitdir: /path/to/.bare-clones/repo/worktrees/..."
        sed 's/^gitdir: //' .git
      elif [ -d .git ]; then
        echo ".git"
      else
        echo ""
      fi
    }
    GIT_DIR=$(resolve_git_dir)

    # --- Git lock handling (works for both worktrees and regular clones) ---
    wait_for_git_lock() {
      if [ -z "$GIT_DIR" ]; then return; fi
      local lock_file="$GIT_DIR/index.lock"
      local attempt=0
      while [ -f "$lock_file" ] && [ $attempt -lt 6 ]; do
        echo "WARNING: $lock_file exists, waiting 5s (attempt $((attempt+1))/6)..." >&2
        sleep 5
        attempt=$((attempt+1))
      done
      if [ -f "$lock_file" ]; then
        echo "WARNING: $lock_file still exists after 30s, removing stale lock" >&2
        rm -f "$lock_file"
      fi
    }

    # --- Git fetch with retry ---
    fetch_ok=false
    for attempt in 1 2 3; do
      wait_for_git_lock
      if git fetch origin 2>/dev/null; then
        fetch_ok=true
        break
      fi
      echo "WARNING: git fetch failed (attempt $attempt/3), retrying in 2s..." >&2
      sleep 2
    done
    if [ "$fetch_ok" = false ]; then
      echo "WARNING: git fetch failed after 3 attempts, continuing with stale refs" >&2
    fi

    # --- Rebase (best-effort) ---
    CURRENT_BRANCH=$(git rev-parse --abbrev-ref HEAD 2>/dev/null || echo "unknown")
    if [ "$CURRENT_BRANCH" = "main" ] || [ "$CURRENT_BRANCH" = "master" ]; then
      echo "On $CURRENT_BRANCH — rebasing onto latest..."
      wait_for_git_lock
      # In bare clone worktrees, refs are stored as refs/heads/<branch>, not refs/remotes/origin/<branch>
      # Try origin/<branch> first (regular clone), fall back to <branch> (bare clone worktree)
      if git show-ref --verify --quiet "refs/remotes/origin/$CURRENT_BRANCH"; then
        REBASE_TARGET="origin/$CURRENT_BRANCH"
      else
        REBASE_TARGET="$CURRENT_BRANCH"
      fi
      if ! git rebase "$REBASE_TARGET" 2>/dev/null; then
        echo "WARNING: Rebase failed, aborting rebase" >&2
        git rebase --abort 2>/dev/null || true
      fi
    else
      echo "On feature branch $CURRENT_BRANCH — skipping rebase, fetch only."
    fi
    # Import rebase briefs into CLAUDE.md (skip during merge — merge agent doesn't need them)
    if [ "${SYMPHONY_STAGE:-}" != "merge" ]; then
      if [ -f "REBASE-BRIEF.md" ]; then
        if ! grep -q "@REBASE-BRIEF.md" CLAUDE.md 2>/dev/null; then
          echo '' >> CLAUDE.md
          echo '@REBASE-BRIEF.md' >> CLAUDE.md
        fi
      fi
    fi
    echo "Workspace synced."
  before_remove: |
    set -uo pipefail

    # --- Handle case where worktree was never fully set up ---
    if [ ! -e .git ]; then
      echo "No git repo in workspace, nothing to clean up."
      exit 0
    fi

    BRANCH=$(git rev-parse --abbrev-ref HEAD 2>/dev/null || echo "")
    if [ -z "$BRANCH" ] || [ "$BRANCH" = "main" ] || [ "$BRANCH" = "master" ] || [ "$BRANCH" = "HEAD" ]; then
      exit 0
    fi

    echo "Cleaning up branch $BRANCH..."

    # --- Close any open PR for this branch ---
    PR_NUM=$(gh pr list --head "$BRANCH" --state open --json number --jq '.[0].number' 2>/dev/null || echo "")
    if [ -n "$PR_NUM" ]; then
      echo "Closing PR #$PR_NUM and deleting remote branch..."
      gh pr close "$PR_NUM" --delete-branch 2>/dev/null || true
    else
      echo "No open PR found, deleting remote branch..."
      git push origin --delete "$BRANCH" 2>/dev/null || true
    fi

    # --- Remove worktree entry from bare clone ---
    REPO_SLUG=$(basename "${REPO_URL%.git}")
    BARE_CLONE="$(cd .. && pwd)/.bare-clones/$REPO_SLUG"
    if [ -d "$BARE_CLONE" ]; then
      echo "Removing worktree entry from bare clone..."
      git -C "$BARE_CLONE" worktree remove "$PWD" --force 2>/dev/null || true
      git -C "$BARE_CLONE" branch -D "$BRANCH" 2>/dev/null || true
    fi
    echo "Cleanup complete."
  timeout_ms: 120000

server:
  port: 4321

observability:
  dashboard_enabled: true
  refresh_ms: 5000

stages:
  initial_stage: investigate

  # Fast-track: issues with this label skip the investigate stage and start at the target stage.
  # Comment out this block to disable fast-track routing.
  fast_track:
    label: trivial
    labels:
      - trivial
      - kind:test
    initial_stage: implement

  investigate:
    type: agent
    runner: codex
    max_turns: 8
    hard_stops:
      max_iterations: 4
      # Total-token runaway guard only — kept below the observed pathological
      # first-turn count (233,719). The binding budget is the cache-aware
      # dollar estimate (cached input discounted via cached_token_cost_ratio);
      # 80000 predated cache-aware costing and paused workers whose billable
      # volume was ~30% of the raw total (SYMPH-319).
      max_tokens_per_unit: 200000
      max_dollar_budget_usd: 4
      premium_budget_pause_ratio: 0.9
    linear_state: In Progress
    mcp_servers:
      code-review-graph:
        command: uvx
        args:
          - code-review-graph
          - serve
    on_complete: implement

  implement:
    type: agent
    runner: codex
    max_turns: 30
    mcp_servers:
      code-review-graph:
        command: uvx
        args:
          - code-review-graph
          - serve
    on_complete: review

  review:
    type: agent
    runner: codex
    max_turns: 8
    max_rework: 3
    linear_state: In Review
    on_complete: merge
    on_rework: implement

  merge:
    type: agent
    runner: codex
    max_turns: 5
    on_complete: done
    on_rework: implement
    max_rework: 2

  done:
    type: terminal
    linear_state: Done
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

# {{ issue.identifier }} — {{ issue.title }}

<!-- CUSTOMIZE: Update the product description below to match your product. -->
You are working on Linear issue {{ issue.identifier }}.

{% if issue.labels.size > 0 %}
Labels: {{ issue.labels | join: ", " }}
{% endif %}

{% if stageName == "investigate" %}
## Stage: Investigation

## Issue Description

{{ issue.description }}

## Investigation Token Brake

Investigation is a routing and planning stage, not a full implementation rehearsal.

- First inspect the latest Linear issue comments/workpad/resume notes. Do not trust repo-root scratch files such as `workpad.md` or `INVESTIGATION-BRIEF.md` unless they explicitly name the current issue and stage. If the Linear context already identifies the next implementation move, reuse that plan instead of rediscovering the repo.
- Spend at most 6 shell/tool calls before posting the investigation workpad, unless a command fails and a single retry is necessary.
- Use `max_output_tokens` of 800 or less in investigate-stage shell calls. Prefer 400 for Linear/comment reads and 800 for source snippets.
- Do not run multi-file `sed` batches, broad `rg -n` over multiple top-level directories, full docs scans, or source dumps during investigate.
- If more discovery is truly required, write the open questions into the workpad and output `[STAGE_COMPLETE]`; the implement stage can do targeted reads while making changes.

You are in the INVESTIGATE stage. Your job is to analyze the issue and create an implementation plan.

### Spec-Informed Investigation
If the issue description contains a detailed spec with specific file paths, line numbers, and proposed changes (typical of spec-gen'd issues): DO NOT re-explore the codebase from scratch. Instead:
1. Read the spec from the issue description
2. Verify the cited files and line numbers are still accurate (quick reads, not full grep sweeps)
3. Reformat the spec content into the Linear workpad structure below
4. Post the workpad to Linear and complete

Save full codebase exploration for issues with vague or ambiguous descriptions that lack specific file references.

{% if issue.state == "Resume" %}
## RESUME CONTEXT
This issue was previously blocked. Check the issue comments for a `## Resume Context` comment explaining what changed. Focus your investigation on the blocking reasons and what has been updated.
{% endif %}

- Check the latest Linear comments/workpad/resume notes before source search. If a current implementation plan already exists, reuse it and do not repeat broad repo discovery.
- Read only the minimal code needed to understand existing patterns and architecture. Stay within the Investigation Token Brake.
- Identify which files need to change and what the approach should be
- Post a workpad comment on the Linear issue with your investigation findings and proposed implementation plan
- Do NOT implement code, create branches, or open PRs in this stage — investigation only

### Workpad (investigate)
After completing your investigation, create the workpad comment on this Linear issue.
**Preferred**: Write the workpad content to a local `workpad.md` file and call the injected `sync_workpad` tool with `issue_id` and `file_path`. Save the returned `comment_id` for future updates.
**Fallback** (if `sync_workpad` is unavailable): Use `linear_graphql` with GraphQL variables to search for an existing workpad comment and call `commentCreate` or `commentUpdate`. If shell CLI access is available, `linear-pp-cli` may do the file-backed write after `linear_graphql` gives you the existing comment UUID:
```bash
# If no existing workpad comment was found:
linear-pp-cli comments add --issue {{ issue.identifier }} --body-file workpad.md --agent
# If an existing workpad comment was found:
linear-pp-cli comments edit <COMMENT_UUID> --body-file workpad.md --agent
```
Do not use Codex app/connector MCP tools for Linear comments or documents in headless runs; they can request interactive elicitation and block the worker.
3. Use this template for the workpad body:
   ```
   ## Workpad
   **Environment**: <hostname>:<workspace-path>@<git-short-sha>

   ### Plan
   - [ ] Step 1 derived from issue description
   - [ ] Step 2 ...
     - [ ] Substep if needed

   ### Acceptance Criteria
   - [ ] Criterion from issue requirements
   - [ ] ...

   ### Validation
   - `<test command from spec>`
   - `<any verify commands>`

   ### Notes
   - <timestamp> Investigation complete. Plan posted.

   ### Confusions
   (Only add this section if something in the issue was genuinely unclear.)
   ```
4. Fill the Plan and Acceptance Criteria sections from your investigation findings.

## Linear Workpad Orientation

After investigation, post a concise Linear workpad/comment for the implement-stage agent instead of writing root-level scratch files. Keep the workpad under ~200 lines (~4K tokens) and use this structure:

```markdown
## Issue: [ISSUE-KEY] — [Title]

## Objective
One-paragraph summary of what needs to be done and why.

## Relevant Files (ranked by importance)
1. `src/path/to/primary-file.ts` — Main file to modify. [What it does, why it matters]
2. `src/path/to/secondary-file.ts` — Related dependency. [What to know]
3. `tests/path/to/test-file.test.ts` — Existing tests. [Coverage notes]

## Key Code Patterns
- Pattern X is used for Y (see `file.ts:42-67`)
- The codebase uses Z convention for this type of change

## Architecture Context
- Brief description of relevant subsystem
- Data flow: A → B → C
- Key interfaces/types to be aware of

## Test Strategy
- Existing test files and what they cover
- Test patterns used (describe/it, vitest, mocking approach)
- Edge cases to cover

## Gotchas & Constraints
- Don't modify X because Y
- Z is deprecated, use W instead

## Key Code Excerpts
[2-3 most important code blocks with file path and line numbers]

## Files to Change
- `path/to/file.ts:LINE_START-LINE_END` — what needs to change and why
- `path/to/other-file.ts:LINE_START-LINE_END` — what needs to change and why

## Read Order
1. Primary change target (start here)
2. Direct dependency of #1
3. Test file for #1

## Key Dependencies
- `functionA()` in `file.ts` is called by `moduleB.ts:45` and `moduleC.ts:92`
- Interface `FooConfig` is implemented by 3 classes (list them)
```

## Completion Signals
When you are done:
- If investigation is complete and workpad is posted: output `[STAGE_COMPLETE]`
- If the spec is ambiguous or contradictory: output `[STAGE_FAILED: spec]` with an explanation
- If you hit infrastructure issues (API limits, network errors): output `[STAGE_FAILED: infra]` with details
{% endif %}

{% if stageName == "implement" %}
## Stage: Implementation

## Issue Description

{{ issue.description }}

You are in the IMPLEMENT stage. Read the latest Linear issue comments/workpad/resume notes first for targeted investigation findings, relevant files, code patterns, architecture context, and test strategy. Do not trust repo-root scratch files such as `workpad.md` or `INVESTIGATION-BRIEF.md` unless they explicitly name the current issue and stage. Follow the workpad Read Order section when it exists — do NOT re-read files not listed there unless you discover a dependency not covered in Key Dependencies. The investigation agent already read the codebase; your job is to change it, not re-explore it.

{% if reworkCount > 0 %}
## REWORK ATTEMPT {{ reworkCount }}

**First, determine the rework type:**

### If `REBASE-BRIEF.md` exists in the worktree root — this is a REBASE REWORK:
1. Read `REBASE-BRIEF.md` for context on conflicting files and recent main commits
2. Rebase the current branch onto `origin/main` and resolve all merge conflicts
3. Run `pnpm format --write` to auto-format, then run `pnpm lint` to verify no lint errors remain. Fix any lint errors before proceeding.
4. Run all `# Verify:` commands from the spec to ensure the build still passes
5. Delete `REBASE-BRIEF.md` after successful rebase and verification
6. Do NOT modify code beyond what is necessary to resolve conflicts and pass lint/verify
7. If conflicts cannot be resolved cleanly, output `[STAGE_FAILED: verify]` with details

### Else if `CI-FAILURE-BRIEF.md` exists in the worktree root — this is a CI FAILURE REWORK:
The merge queue CI rejected the PR. The brief contains the failing check name and error output.
1. Read `CI-FAILURE-BRIEF.md` for the specific CI failure details
2. Run the full CI suite locally to reproduce: `pnpm lint`, `pnpm typecheck`, `pnpm test`, `pnpm build`
3. Fix whatever is failing. For lint errors, run `pnpm format --write` first, then fix any remaining `pnpm lint` errors manually.
4. Run all `# Verify:` commands from the spec to ensure nothing else regressed
5. Delete `CI-FAILURE-BRIEF.md` after all checks pass
6. If the failure cannot be resolved, output `[STAGE_FAILED: verify]` with details

### Else if `## Review Findings` comments exist — this is a REVIEW REWORK:
Read ALL comments on this Linear issue starting with `## Review Findings`. These contain the specific findings you must fix.
- Fix ONLY the identified findings
- Do not modify code outside the affected files unless strictly necessary
- Do not reinterpret the spec
- If a finding conflicts with the spec, output `[STAGE_FAILED: spec]` with an explanation
{% endif %}

## Implementation Steps

1. Read any investigation notes from previous comments on this issue.
2. Create a feature branch from the issue's suggested branch name{% if issue.branch_name %} (`{{ issue.branch_name }}`){% endif %}, or use `{{ issue.identifier | downcase }}/<short-description>`.
3. Implement the task per the issue description.
4. Write tests as needed.
5. Run all `# Verify:` commands from the spec. You are not done until every verify command exits 0.
6. Run `pnpm format --write` to auto-format code, then run `pnpm lint` to verify no lint errors remain. If lint fails, fix the errors and re-run until clean. This must pass before creating the PR.
7. Before creating the PR, capture structured tool output as bounded artifacts:
   - Run `node scripts/symphony-run-logged.mjs --label typecheck -- npx tsc --noEmit` when the helper exists, or redirect equivalent output to `.symphony/validation/typecheck.log`; include command, exit code, log path, and summary/tail in PR body under `## Tool Output > TypeScript`.
   - Run `node scripts/symphony-run-logged.mjs --label lint -- pnpm lint` when the helper exists, or redirect equivalent output to `.symphony/validation/lint.log`; include command, exit code, log path, and summary/tail in PR body under `## Tool Output > Lint`.
   - Run the test command through the same log-capturing path, preferably `node scripts/symphony-run-logged.mjs --label tests -- pnpm test` when the helper exists; include command, exit code, log path, and summary/tail in PR body under `## Tool Output > Tests`.
   - Run Semgrep through the same log-capturing path if available, for example `node scripts/symphony-run-logged.mjs --label semgrep -- semgrep scan --config auto --json`; include the raw artifact path and a compact summary under `## SAST Output`, and paste raw JSON only if the artifact is under 20 KB.
8. Commit your changes with message format: `feat({{ issue.identifier }}): <description>`.
9. Open a PR targeting this repo (not its upstream fork parent) via `gh pr create --repo $(git remote get-url origin | sed "s|.*github.com/||;s|\.git$||")` with the issue description in the PR body. Include the Tool Output and SAST Output sections.
10. Link the PR to the Linear issue by including `{{ issue.identifier }}` in the PR title or body.

### Workpad (implement)
Update the workpad comment at these milestones during implementation.
**Preferred**: Edit your local `workpad.md` file and call the injected `sync_workpad` tool with `issue_id`, `file_path`, and `comment_id` (from the investigate stage).
**Fallback** (if `sync_workpad` is unavailable): Use `linear_graphql` with GraphQL variables to find the existing `## Workpad` comment and call `commentUpdate`. If shell CLI access is available, `linear-pp-cli` may do the file-backed update after `linear_graphql` gives you the comment UUID:
```bash
linear-pp-cli comments edit <COMMENT_UUID> --body-file workpad.md --agent
```
3. At each milestone, update the relevant sections:
   - **After starting implementation**: Check off Plan items as you complete them.
   - **After implementation is done**: Add a Notes entry (e.g., `- <timestamp> Implementation complete. PR #<number> opened.`), update Validation with actual commands run.
   - **After all tests pass**: Check off Acceptance Criteria items, add a Notes entry confirming validation.
4. Do NOT update the workpad after every small code change — only at the milestones above.
5. If no workpad comment exists (e.g., investigation stage was skipped), create one using the template from the investigate stage instructions.

10. **If your changes are app-touching** (UI, API responses visible to users, frontend assets), capture a screenshot after validation passes and embed it in the workpad:
   - Take a screenshot (e.g., `npx playwright screenshot` or `curl` the endpoint and save the response).
   - Upload it using the fileUpload flow described in the **Media in Workpads** section.
   - Add the image to the workpad comment under Notes: `![screenshot after validation](assetUrl)`.
   - Skip this step for non-visual changes (library code, configs, internal refactors).

## Completion Signals
When you are done:
- If all verify commands pass and PR is created: output `[STAGE_COMPLETE]`
- If you cannot resolve a verify failure after 3 attempts: output `[STAGE_FAILED: verify]` with the failing command and output
- If the spec is ambiguous or contradictory: output `[STAGE_FAILED: spec]` with an explanation
- If you hit infrastructure issues (API limits, network errors): output `[STAGE_FAILED: infra]` with details

Headless worker permissions are preconfigured. Do not request sandbox, network,
or permission escalation from the user. If a required command is still denied by
policy, output `[STAGE_FAILED: infra]` with the exact denied command and error.
{% endif %}

{% if stageName == "review" %}
## Stage: Review
You are the review-gate operator, not the reviewer. Every PR, including low-risk PRs, must pass the headless council gate before merge.

Do NOT run `/self-moa-review`, `/codex-review`, direct `claude -p`, or any other direct Claude invocation. Claude must run through CMUX via `symphony-council-review-gate`.

{% if reworkCount > 0 %}
### Re-review After Rework (rework #{{ reworkCount }})
This is a re-review after a rework cycle. Run the same headless council gate again and verify the previous `## Review Findings` are resolved.
{% endif %}

### Run the headless council gate

1. Resolve the PR and repository:
   ```bash
   PR_NUMBER=$(gh pr view --json number --jq '.number')
   REPO=$(gh repo view --json nameWithOwner --jq '.nameWithOwner')
   ```
2. Run the gate through CMUX:
   ```bash
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
3. Read `$ARTIFACT_DIR/review-result.json` and `$ARTIFACT_DIR/council-report.md`.

### Evaluate findings

If the gate reports `PASS`, post a short workpad note with the artifact directory and output `[STAGE_COMPLETE]`.
If the gate reports `FAIL`, is degraded, times out, or artifacts are missing/malformed: post a `## Review Findings` comment on the Linear issue with the council report path and blocking summary, then output `[STAGE_FAILED: review]`.
{% endif %}

{% if stageName == "merge" %}
## Stage: Merge
You are in the MERGE stage. The PR has been reviewed and approved.

**MUST NOT:**
- Modify any source code, tests, configs, or documentation
- Reinterpret review findings or reopen closed discussions
- Run test suites, linters, or build commands
- Create new commits or amend existing ones
- Cherry-pick, rebase, or manipulate git history

Your ONLY job is to merge the PR and update the workpad.

### Merge Queue Context
This repo uses GitHub's merge queue. When you run `gh pr merge`, GitHub will:
- **If checks passed**: Add the PR to the merge queue. You'll see: `"✓ Pull request ...#N will be added to the merge queue for main when ready"`
- **If checks pending**: Enable auto-merge. You'll see: `"✓ Pull request ...#N will be automatically merged via squash when all requirements are met"`

In BOTH cases, the merge is not immediate — GitHub queues it, rebases, runs CI on the rebased version, then merges. This is normal behavior. Do NOT interpret it as a failure.

### Step 1: Merge the PR
First, get the PR number for the current branch:
```
PR_NUMBER=$(gh pr view --json number --jq '.number')
```
Then merge:
```
gh pr merge $PR_NUMBER --auto
```
This single command is sufficient. The merge queue controls the merge strategy (squash) and branch cleanup.

Do NOT pass `--squash`, `--delete-branch`, `--repo`, or `--admin` — the merge queue controls these. Do NOT:
- Retry the merge command if you see a "merge queue" or "auto-merge" response — that IS success
- Run `gh pr merge` with `--admin` to bypass the queue
- Modify any code in this stage

### Step 2: Wait for Merge to Complete
After the merge command succeeds, wait for the merge queue to finish:
```
gh pr checks --watch --required --fail-fast
```
This blocks until all checks complete (including merge queue CI). Then confirm the PR merged:
```
gh pr view --json state --jq '.state'
```
Expected: `MERGED`. If the state is `MERGED`, proceed to workpad update.

If the merge queue rejects the PR (check failures on rebased code):
1. Run `gh pr view --json state,statusCheckRollup` to identify which check failed and why
2. Write `CI-FAILURE-BRIEF.md` to the worktree root with the following structure:
   ```markdown
   # CI Failure Brief
   ## Issue: {{ issue.identifier }} — {{ issue.title }}

   ## Failed Check
   - Check name: (e.g., "Lint", "Typecheck", "Test")
   - Error output: (paste the relevant error output from the check run)

   ## What to Fix
   - (brief description of what needs to change, e.g., "Biome formatting errors in src/foo.ts lines 100-105")
   ```
3. To get detailed error output, run `gh run view <run-id> --log-failed` using the run ID from the statusCheckRollup
4. Output `[STAGE_FAILED: rebase]` as the very last line of your final message

### Step 2b: If Conflicts — Write Rebase Brief and Signal Failure
If the PR has merge conflicts (mergeable is "CONFLICTING" or mergeStateStatus indicates conflicts):
1. Do NOT attempt to resolve conflicts — detect and signal only
2. Write `REBASE-BRIEF.md` to the worktree root with the following structure (keep under ~50 lines):
   ```markdown
   # Rebase Brief
   ## Issue: {{ issue.identifier }} — {{ issue.title }}

   ## Conflicting Files
   - `path/to/conflicted-file.ts` — nature of conflict if identifiable

   ## Recent Main Commits
   (output of git log origin/main --oneline -10 since branch diverged)

   ## Semantic Context
   - Any observations about what the conflicting PRs changed (from PR titles/commits)
   ```
3. To identify conflicting files, run `git fetch origin && git merge-tree $(git merge-base HEAD origin/main) HEAD origin/main` or attempt a dry-run merge
4. To get recent main commits, run `git log origin/main --oneline -10`
5. Output `[STAGE_FAILED: rebase]` as the very last line of your final message

### Workpad (merge)
After merging the PR, update the workpad comment one final time.
**Preferred**: Edit your local `workpad.md` file and call the injected `sync_workpad` tool with `issue_id`, `file_path`, and `comment_id`.
**Fallback** (if `sync_workpad` is unavailable): Use `linear_graphql` with GraphQL variables to find the existing `## Workpad` comment and call `commentUpdate`. If shell CLI access is available, `linear-pp-cli` may do the file-backed update after `linear_graphql` gives you the comment UUID:
```bash
linear-pp-cli comments edit <COMMENT_UUID> --body-file workpad.md --agent
```
Update the workpad to:
- Check off all remaining Plan and Acceptance Criteria items.
- Add a final Notes entry: `- <timestamp> PR merged. Issue complete.`

- When you have successfully merged the PR, output the exact text `[STAGE_COMPLETE]` as the very last line of your final message.
{% endif %}
## Scope Discipline

- If your task requires a capability that doesn't exist in the codebase and isn't specified in the spec, stop and comment what's missing on the issue. Don't scaffold unspecced infrastructure.
- Tests must be runnable against $BASE_URL (no localhost assumptions in committed tests).

## Workpad Rules

You maintain a single persistent `## Workpad` comment on the Linear issue. This is your structured progress document.

**Critical rules:**
- **Never create multiple workpad comments.** Always search for an existing comment with `## Workpad` in its body before creating a new one.
- **Update at milestones only** — plan finalized, implementation done, validation complete. Do NOT sync after every minor change.
- **Prefer the injected headless tools.** Write your workpad content to a local `workpad.md` file, then call `sync_workpad` with `issue_id`, `file_path`, and optionally `comment_id` (returned from the first sync). This keeps the workpad body out of your conversation context and saves tokens.
- **Headless-safe fallbacks** (if `sync_workpad` is unavailable):
  - Use `linear_graphql` with GraphQL variables to search for the existing `## Workpad` comment and call `commentCreate` or `commentUpdate`.
  - Use `linear-pp-cli comments add/edit --body-file ... --agent` only after you already know whether you are creating or updating.
  - Do not use the old `linear` CLI or Codex app/connector MCP tools for Linear comments/documents in headless runs.
  ```bash
  # Find the existing workpad comment (positional issue form):
  linear-pp-cli comments list <ISSUE_KEY> --agent --select comments.id,comments.body
  # If no existing workpad comment was found:
  linear-pp-cli comments add --issue <ISSUE_KEY> --body-file workpad.md --agent
  # If an existing workpad comment was found:
  linear-pp-cli comments edit <COMMENT_UUID> --body-file workpad.md --agent
  ```
- **Issue state changes via CLI** (when shell CLI access is available): do not hunt for workflow-state UUIDs with raw SQL or GraphQL. Use the first-class commands:
  ```bash
  # One-command transition resolved against the issue's own team:
  linear-pp-cli issues edit <ISSUE_KEY> --state-name "In Progress" --agent
  # Or list the team's states to get the UUID for issues edit --state:
  linear-pp-cli workflow-states list --team <TEAM_KEY> --agent --select id,name,type
  ```
  Without CLI access, keep using the `linear_graphql` tool for state mutations.
- **CLI errors are JSON in agent mode.** `linear-pp-cli ... --agent` emits failures as one-line `{"error","code","type"}` envelopes on stdout with typed exit codes, so parse stdout directly — no `2>&1 | python` defensive wrappers.
- **Never inline markdown into Linear GraphQL `body:`, `description:`, or `content:` literals.** Use `sync_workpad`, `linear-pp-cli` file flags, or GraphQL variables so shell snippets like `$VAR`, `${VAR}`, `$(cmd)`, and backticks stay literal.

## Media in Workpads (fileUpload)

When you capture evidence (screenshots, recordings, logs) during implementation, embed them in the workpad using Linear's `fileUpload` API. This is a 3-step flow:

**Step 1: Get upload URL** via `linear_graphql`:
```graphql
mutation($filename: String!, $contentType: String!, $size: Int!) {
  fileUpload(filename: $filename, contentType: $contentType, size: $size, makePublic: true) {
    success
    uploadFile { uploadUrl assetUrl headers { key value } }
  }
}
```

**Step 2: Upload file bytes** using `curl`:
```bash
# Build header flags from the returned headers array
curl -X PUT -H "Content-Type: <contentType>" \
  -H "<key1>: <value1>" -H "<key2>: <value2>" \
  --data-binary @<local-file-path> "<uploadUrl>"
```

**Step 3: Embed in workpad** — add `![description](assetUrl)` to the workpad comment body (either via `sync_workpad` or `commentUpdate`).

**Supported content types**: `image/png`, `image/jpeg`, `image/gif`, `video/mp4`, `application/pdf`.

**When to capture media**: Only when evidence adds value — screenshots of UI changes, recordings of interaction flows, or error screenshots for debugging. Do not upload media for non-visual tasks (e.g., pure API or library changes).

## Documentation Maintenance

- Put generated markdown docs, plans, handoffs, ADR-style notes, runbooks, and investigation briefs in Linear Docs, not repo-local markdown, unless the issue explicitly asks for checked-in documentation.
- Use `linear-pp-cli documents create/edit --content-file <temp-file> --issue {{ issue.identifier }} --agent` for issue-scoped markdown docs.
- If a checked-in docs change is explicitly required by the issue, keep it scoped to that requirement and include it in the same PR as the code change.
- If the markdown names durable follow-up work, search Linear first, then create or update the issue before mentioning it in the doc.
- Do not update docs/generated/ files; those are auto-generated and will be overwritten.
