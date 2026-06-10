---
tracker:
  kind: linear
  api_key: $LINEAR_API_KEY
  project_slug: fdba14472043
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
    # --- Build code graph (best-effort) ---
    if command -v code-review-graph >/dev/null 2>&1; then
      echo "Building code review graph..."
      code-review-graph build --repo . || echo "WARNING: code-review-graph build failed, continuing without graph" >&2
    else
      echo "WARNING: code-review-graph not installed, skipping graph build" >&2
    fi
    echo "Workspace setup complete."
  before_run: |
    set -euo pipefail
    echo "Syncing workspace with upstream..."

    # --- Git lock handling ---
    wait_for_git_lock() {
      local attempt=0
      while [ -f .git/index.lock ] && [ $attempt -lt 6 ]; do
        echo "WARNING: .git/index.lock exists, waiting 5s (attempt $((attempt+1))/6)..." >&2
        sleep 5
        attempt=$((attempt+1))
      done
      if [ -f .git/index.lock ]; then
        echo "WARNING: .git/index.lock still exists after 30s, removing stale lock" >&2
        rm -f .git/index.lock
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
      if ! git rebase "origin/$CURRENT_BRANCH" 2>/dev/null; then
        echo "WARNING: Rebase failed, aborting rebase" >&2
        git rebase --abort 2>/dev/null || true
      fi
    else
      echo "On feature branch $CURRENT_BRANCH — skipping rebase, fetch only."
    fi
    echo "Workspace synced."
  before_remove: |
    set -uo pipefail
    BRANCH=$(git rev-parse --abbrev-ref HEAD 2>/dev/null || echo "")
    if [ -z "$BRANCH" ] || [ "$BRANCH" = "main" ] || [ "$BRANCH" = "master" ] || [ "$BRANCH" = "HEAD" ]; then
      exit 0
    fi
    echo "Cleaning up branch $BRANCH..."
    # Close any open PR for this branch (also deletes the remote branch via --delete-branch)
    PR_NUM=$(gh pr list --head "$BRANCH" --state open --json number --jq '.[0].number' 2>/dev/null || echo "")
    if [ -n "$PR_NUM" ]; then
      echo "Closing PR #$PR_NUM and deleting remote branch..."
      gh pr close "$PR_NUM" --delete-branch 2>/dev/null || true
    else
      # No open PR — just delete the remote branch if it exists
      echo "No open PR found, deleting remote branch..."
      git push origin --delete "$BRANCH" 2>/dev/null || true
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

  investigate:
    type: agent
    runner: codex
    max_turns: 8
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

You are working on Linear issue {{ issue.identifier }}.

## Issue Description

{{ issue.description }}

{% if issue.labels.size > 0 %}
Labels: {{ issue.labels | join: ", " }}
{% endif %}

{% if stageName == "investigate" %}
## Stage: Investigation
You are in the INVESTIGATE stage. Your job is to analyze the issue and create an implementation plan.

{% if issue.state == "Resume" %}
## RESUME CONTEXT
This issue was previously blocked. Check the issue comments for a `## Resume Context` comment explaining what changed. Focus your investigation on the blocking reasons and what has been updated.
{% endif %}

- Read the codebase to understand existing patterns and architecture
- Identify which files need to change and what the approach should be
- Post a workpad comment on the Linear issue with your investigation findings and proposed implementation plan
- Do NOT implement code, create branches, or open PRs in this stage — investigation only

### Workpad (investigate)
After completing your investigation, create the workpad comment on this Linear issue.
**Preferred**: Write the workpad content to a local `workpad.md` file and call `sync_workpad` with `issue_id` and `file_path`. Save the returned `comment_id` for future updates.
**Fallback** (if `sync_workpad` is unavailable):
1. First, search for an existing workpad comment using `linear_graphql`:
   ```graphql
   query { issue(id: "{{ issue.id }}") { comments { nodes { id body } } } }
   ```
   Look for a comment whose body starts with `## Workpad`.
2. If no workpad comment exists, create one using `commentCreate`. If one exists, update it using `commentUpdate`.
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

### Required: Structured Map

After your prose findings, you MUST include a structured map section in the workpad with the following format:

```
### Files to Change
- path/to/file.ts:LINE_START-LINE_END — what needs to change and why

### Read Order
1. path/to/primary.ts (primary change target)
2. path/to/types.ts (type definitions needed)
3. path/to/related.test.ts (test file to update)

### Key Dependencies
- FunctionX is called from A, B, C
- InterfaceY is used in D, E
```

This structured map helps the implementation agent navigate the codebase efficiently without re-reading files you already explored.

## Completion Signals
When you are done:
- If investigation is complete and workpad is posted: output `[STAGE_COMPLETE]`
- If the spec is ambiguous or contradictory: output `[STAGE_FAILED: spec]` with an explanation
- If you hit infrastructure issues (API limits, network errors): output `[STAGE_FAILED: infra]` with details
{% endif %}

{% if stageName == "implement" %}
## Stage: Implementation
You are in the IMPLEMENT stage. An investigation was done in the previous stage — check issue comments for the plan.

{% if reworkCount > 0 %}
## REWORK ATTEMPT {{ reworkCount }}
This is a rework attempt. Read ALL comments on this Linear issue starting with `## Review Findings`. These contain the specific findings you must fix.
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
6. Before creating the PR, capture structured tool output as bounded artifacts:
   - Run `node scripts/symphony-run-logged.mjs --label typecheck -- npx tsc --noEmit` when the helper exists, or redirect equivalent output to `.symphony/validation/typecheck.log`; include command, exit code, log path, and summary/tail in PR body under `## Tool Output > TypeScript`.
   - Run the test command through the same log-capturing path, preferably `node scripts/symphony-run-logged.mjs --label tests -- pnpm test` when the helper exists; include command, exit code, log path, and summary/tail in PR body under `## Tool Output > Tests`.
   - Run Semgrep through the same log-capturing path if available, for example `node scripts/symphony-run-logged.mjs --label semgrep -- semgrep scan --config auto --json`; include the raw artifact path and a compact summary under `## SAST Output`, and paste raw JSON only if the artifact is under 20 KB.
7. Commit your changes with message format: `feat({{ issue.identifier }}): <description>`.
8. Open a PR targeting this repo (not its upstream fork parent) via `gh pr create --repo $(git remote get-url origin | sed "s|.*github.com/||;s|\.git$||")` with the issue description in the PR body. Include the Tool Output and SAST Output sections.
9. Link the PR to the Linear issue by including `{{ issue.identifier }}` in the PR title or body.

### Workpad (implement)
Update the workpad comment at these milestones during implementation.
**Preferred**: Edit your local `workpad.md` file and call `sync_workpad` with `issue_id`, `file_path`, and `comment_id` (from the investigate stage).
**Fallback** (if `sync_workpad` is unavailable):
1. Search for the existing workpad comment (body starts with `## Workpad`) using `linear_graphql`:
   ```graphql
   query { issue(id: "{{ issue.id }}") { comments { nodes { id body } } } }
   ```
2. Update it using `commentUpdate` with the comment's `id`.
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

{% if stageName == "merge" %}
## Stage: Merge
You are in the MERGE stage. The PR has been reviewed and approved.
- Merge the PR via `gh pr merge --squash --delete-branch --repo $(git remote get-url origin | sed "s|.*github.com/||;s|\.git$||")`
- Verify the merge succeeded on the main branch
- Do NOT modify code in this stage

### Workpad (merge)
After merging the PR, update the workpad comment one final time.
**Preferred**: Edit your local `workpad.md` file and call `sync_workpad` with `issue_id`, `file_path`, and `comment_id`.
**Fallback** (if `sync_workpad` is unavailable):
1. Search for the existing workpad comment (body starts with `## Workpad`) using `linear_graphql`:
   ```graphql
   query { issue(id: "{{ issue.id }}") { comments { nodes { id body } } } }
   ```
2. Update it using `commentUpdate`:
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
- **Prefer `sync_workpad` over raw GraphQL.** Write your workpad content to a local `workpad.md` file, then call `sync_workpad` with `issue_id`, `file_path`, and optionally `comment_id` (returned from the first sync). This keeps the workpad body out of your conversation context and saves tokens. Fall back to `linear_graphql` only if `sync_workpad` is unavailable.
- Do not use Codex app/connector MCP tools for Linear comments or documents in headless runs; they can request interactive elicitation and block the worker.
- **`linear_graphql` fallback patterns** (use only if `sync_workpad` is unavailable):
  - Search comments: `query { issue(id: "<issue_id>") { comments { nodes { id body } } } }`
  - Create comments with GraphQL variables only: `mutation Create($issueId: String!, $body: String!) { commentCreate(input: { issueId: $issueId, body: $body }) { comment { id } } }`
  - Update comments with GraphQL variables only: `mutation Update($commentId: String!, $body: String!) { commentUpdate(id: $commentId, input: { body: $body }) { comment { id } } }`
  - Never inline markdown into `body:`, `description:`, or `content:` literals. Put the markdown in variables so shell snippets like `$VAR`, `${VAR}`, `$(cmd)`, and backticks stay literal.
- **Never use `__type` or `__schema` introspection queries** against the Linear API. Use the exact patterns above.

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
