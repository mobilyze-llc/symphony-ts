---
name: council-review
description: High-assurance Codex-led code review council for non-trivial changes. Codex orchestrates Opus via claude and DeepSeek via pi through cmux-spawn, runs Codex cross-examination in-session, triages evidence, fixes issues, and optionally prepares a merge.
---

# Council Review - Codex-Led Cross-Examination

You are the **Codex Lead**. Run a compact review council. Codex handles
orchestration, in-session cross-examination, adversarial triage, fixes,
and closeout. External reviewer lanes are spawned through `cmux-spawn`
so they run in isolated cmux workspaces with uniform preflight, status,
artifact, telemetry, and concurrency-cap semantics.

This is the role-swapped version of the Claude-side council pattern:
Codex is the lead, Opus is the external Claude lane, and Pi/DeepSeek is
the second independent reviewer.

## When This Applies

Use for non-trivial feature work touching multiple files, adding tests,
or making architectural decisions. Skip for single-line fixes or
already-obvious mechanical edits.

## Runtime Contract

All external CLIs go through Crucible's `cmux-spawn` CLI at
`/Users/ericlitman/projects/crucible/bin/cmux-spawn` unless
`CMUX_SPAWN_BIN` overrides it. Do **not** shell out directly to
`claude -p`, `claude --bg`, `pi --print`, or `codex exec` from this
skill. If cmux-spawn is unavailable or unhealthy, fail closed; do not
invent a direct-subprocess fallback.

Read `~/.codex/skills/cmux-spawn/SKILL.md` if you need the full
substrate contract.

## Skill Contents

Read these files only when the workflow asks for them:

| File | Contents | When to Read |
| --- | --- | --- |
| `cli-reference.md` | Correct cmux-spawn commands for Opus and Pi, artifact paths, and failure rules | Before spawning external lanes |
| `templates/phase1-opus-prompt.md` | Phase 1 independent review prompt for Opus | During Phase 1 setup |
| `templates/phase1-pi-prompt.md` | Phase 1 independent review prompt for Pi/DeepSeek | During Phase 1 setup |
| `templates/cross-exam-codex-prompt.md` | Codex Lead's Phase 2 cross-exam worksheet | During Phase 2 setup |
| `templates/cross-exam-opus-prompt.md` | Opus Phase 2 cross-exam prompt for Pi findings | During Phase 2 setup |
| `templates/council-report.md` | Phase 3 report format | During triage |
| `templates/cycle-report.md` | Final cycle summary format | During closeout |
| `scripts/assert-clean-pass.py` | Executable setup and closeout assertion over PR/diff provenance and clean-PASS artifacts | During Setup and Closeout |
| `scripts/write-review-target-artifacts.py` | Executable setup helper that writes PR mode and diff provenance artifacts from `gh`, git, and base-ref facts | During Setup |
| `scripts/smoke-clean-pass.sh` | Focused smoke matrix for clean draft, mismatch, degraded, and no-PR cases | During skill validation |

Template paths are relative to `~/.codex/skills/council-review/`.

Track findings are persisted through the universal
`~/.agents/skills/linear-workflow/` unless the repo has a stricter local
workflow skill. Route by the repo's `.linear.toml` and durable ownership
surface. For Ezra repos, use `~/.codex/skills/ezra-linear-workflow/`.
Do not append new durable work to `docs/tracked-items.md`.

## Reviewer Lanes

| Phase | Work | Model | Mechanism |
| --- | --- | --- | --- |
| Phase 1 | Independent review | Opus | `cmux-spawn run --agent claude --model opus` |
| Phase 1 | Independent review | DeepSeek `deepseek-v4-pro` | `cmux-spawn run --agent pi --provider deepseek` |
| Phase 2 | Cross-exam Pi findings | Opus | `cmux-spawn run --agent claude --model opus` |
| Phase 2 | Cross-exam all external findings | Codex/GPT-5.5 | Current session, write `$COUNCIL_DIR/phase2-codex.md` |
| Phase 3+ | Triage, fixes, convergence | Codex/GPT-5.5 | Current session |

Pi is Phase 1 only. It does not cross-examine. Codex does not spawn a
separate Codex CLI lane for this skill because the current session is
the Codex Lead.

## Workflow

### Development Phase

Do the implementation work first. Run the relevant tests/typechecks
before starting the council. If tests are already failing, fix or
clearly record the baseline before asking reviewers to evaluate the
diff.

For non-trivial work, the preferred review target is a clean draft PR:

1. Commit all intended files.
2. Push the branch.
3. Open a draft PR with the owning Linear issue in the body.
4. Run `council-review` against that stable PR/diff.

Keep the PR in draft while fixing P1/P2 findings. Mark it ready only
after tests, convergence evidence, and the council report are clean.

The first council pass is an initial broad pass. Later review rounds are
convergence passes: review only `previous_reviewed_head..HEAD` plus the
semantic neighborhood, consumers, and producers needed to falsify the
named invariant from the prior round. Do not reopen unrelated P3/Track
items unless the fix delta creates a current-head P1/P2.

Dirty working-tree review is a degraded fallback. Use it only when a
PR-backed review is impossible or explicitly deferred. Before using the
fallback, make staged, unstaged, and untracked-file handling explicit in
the council report.

### Setup

Read `cli-reference.md`, then run preflight from the repo under review:

```bash
CMUX_SPAWN_BIN="${CMUX_SPAWN_BIN:-/Users/ericlitman/projects/crucible/bin/cmux-spawn}"
test -x "$CMUX_SPAWN_BIN" || { echo "cmux-spawn not installed at $CMUX_SPAWN_BIN" >&2; exit 1; }
COUNCIL_REVIEW_SKILL_DIR="${COUNCIL_REVIEW_SKILL_DIR:-$HOME/.codex/skills/council-review}"

BASE_BRANCH=$(git rev-parse --abbrev-ref HEAD@{upstream} 2>/dev/null | sed 's|origin/||' || echo main)
if [ "$BASE_BRANCH" = "main" ] && ! git rev-parse --verify main >/dev/null 2>&1; then
  BASE_BRANCH=$(git remote show origin 2>/dev/null | awk '/HEAD branch/ {print $NF}')
fi
: "${BASE_BRANCH:=main}"
if ! git rev-parse --verify "$BASE_BRANCH" >/dev/null 2>&1; then
  if git rev-parse --verify "origin/$BASE_BRANCH" >/dev/null 2>&1; then
    BASE_BRANCH="origin/$BASE_BRANCH"
  else
    echo "Cannot resolve base branch/ref '$BASE_BRANCH'. Set BASE_BRANCH explicitly before rerunning." >&2
    exit 1
  fi
fi

WORKSPACE_PATH=$(git rev-parse --show-toplevel)
COUNCIL_ID=$(date +%s)-$$
COUNCIL_DIR="/tmp/codex-council-${COUNCIL_ID}"
mkdir -p "$COUNCIL_DIR"
REVIEW_MODE="${REVIEW_MODE:-initial broad pass}"
REVIEW_ROUND="${REVIEW_ROUND:-1}"
PREVIOUS_REVIEWED_HEAD_SHA="${PREVIOUS_REVIEWED_HEAD_SHA:-n/a}"
ARTIFACT_STATUS="${ARTIFACT_STATUS:-complete}"

"$CMUX_SPAWN_BIN" preflight --caffeinate --json > "$COUNCIL_DIR/preflight.json"
if [ $? -ne 0 ]; then
  echo "cmux-spawn preflight failed:" >&2
  cat "$COUNCIL_DIR/preflight.json" >&2
  exit 1
fi

CLAUDE_AVAILABLE=false
PI_AVAILABLE=false
DIRTY=false
command -v claude >/dev/null 2>&1 && CLAUDE_AVAILABLE=true
command -v pi >/dev/null 2>&1 && PI_AVAILABLE=true

PR_VIEW_STATUS=0
if command -v gh >/dev/null 2>&1; then
  gh pr view --json url,isDraft,headRefName,baseRefName,headRefOid,baseRefOid \
    > "$COUNCIL_DIR/pr.json" 2> "$COUNCIL_DIR/pr.stderr" || PR_VIEW_STATUS=$?
else
  PR_VIEW_STATUS=127
  echo "gh not installed; cannot detect PR state" > "$COUNCIL_DIR/pr.stderr"
fi
printf '%s\n' "$PR_VIEW_STATUS" > "$COUNCIL_DIR/pr-view-exit-code.txt"

git status --short > "$COUNCIL_DIR/git-status-short.txt"
git rev-parse HEAD > "$COUNCIL_DIR/local-head-sha.txt"
git rev-parse "$BASE_BRANCH" > "$COUNCIL_DIR/resolved-base-sha.txt"
printf '%s\n' "$BASE_BRANCH" > "$COUNCIL_DIR/resolved-base-ref.txt"

if ! git diff --quiet 2>/dev/null || ! git diff --cached --quiet 2>/dev/null; then
  DIRTY=true
  echo "DEGRADED: council will review the working tree plus committed diff against $BASE_BRANCH." >&2
  echo "Prefer committing, pushing, and opening a draft PR before review." >&2
fi

UNTRACKED="$(git ls-files --others --exclude-standard)"
if [ -n "$UNTRACKED" ]; then
  echo "Untracked files are not included in git diff. Stage/commit intended files, or add intentionally excluded paths to .gitignore before rerunning:" >&2
  echo "$UNTRACKED" >&2
  exit 1
fi

"$COUNCIL_REVIEW_SKILL_DIR/scripts/write-review-target-artifacts.py" "$COUNCIL_DIR" || exit 1

CLEAN_PASS_ASSERTION_STATUS=0
printf '%s\n' "$COUNCIL_REVIEW_SKILL_DIR/scripts/assert-clean-pass.py" \
  > "$COUNCIL_DIR/clean-pass-helper-path.txt"
if command -v shasum >/dev/null 2>&1; then
  shasum -a 256 "$COUNCIL_REVIEW_SKILL_DIR/scripts/assert-clean-pass.py" \
    > "$COUNCIL_DIR/clean-pass-helper-sha256.txt" 2> "$COUNCIL_DIR/clean-pass-helper-sha256.stderr" || true
else
  printf 'unknown shasum-unavailable\n' > "$COUNCIL_DIR/clean-pass-helper-sha256.txt"
fi
"$COUNCIL_REVIEW_SKILL_DIR/scripts/assert-clean-pass.py" "$COUNCIL_DIR" \
  > "$COUNCIL_DIR/clean-pass-assertion.txt" \
  2> "$COUNCIL_DIR/clean-pass-assertion.stderr" || CLEAN_PASS_ASSERTION_STATUS=$?
printf '%s\n' "$CLEAN_PASS_ASSERTION_STATUS" > "$COUNCIL_DIR/clean-pass-assertion-exit-code.txt"
```

If both `CLAUDE_AVAILABLE` and `PI_AVAILABLE` are false, stop. If only
one is available, use the degradation matrix below.

### Phase 1: Independent External Reviews

Populate the two Phase 1 prompt templates. Use the same diff for both
reviewers for fairness:

```bash
if [ "$DIRTY" = "true" ]; then
  MERGE_BASE=$(git merge-base "$BASE_BRANCH" HEAD 2>/dev/null || git rev-parse "$BASE_BRANCH")
  git diff "$MERGE_BASE" > "$COUNCIL_DIR/diff.patch"
else
  git diff "$BASE_BRANCH"...HEAD > "$COUNCIL_DIR/diff.patch"
fi

if [ ! -s "$COUNCIL_DIR/diff.patch" ]; then
  echo "No diff to review against '$BASE_BRANCH'. Commit intended changes, check base detection, or set BASE_BRANCH explicitly before rerunning." >&2
  exit 1
fi
```

Read `templates/phase1-opus-prompt.md` and
`templates/phase1-pi-prompt.md`. Replace `{BASE_BRANCH}`,
`{WORKSPACE_PATH}`, `{REVIEW_MODE}`, `{REVIEW_ROUND}`,
`{CURRENT_HEAD_SHA}`, `{PREVIOUS_REVIEWED_HEAD_SHA}`,
`{ARTIFACT_STATUS}`, and `[DIFF]`; write the populated prompts to:

- `$COUNCIL_DIR/phase1-opus-prompt.md`
- `$COUNCIL_DIR/phase1-pi-prompt.md`

For the first pass, use `REVIEW_MODE="initial broad pass"` and
`PREVIOUS_REVIEWED_HEAD_SHA=n/a`. For convergence, use
`REVIEW_MODE="convergence pass"`, set
`PREVIOUS_REVIEWED_HEAD_SHA` to the last reviewed head, and make sure the
diff being reviewed is the current head fix delta plus any semantic
neighborhood needed to falsify the named invariant.

Launch available reviewers in parallel with the commands from
`cli-reference.md`:

```bash
if [ "$CLAUDE_AVAILABLE" = "true" ]; then
  "$CMUX_SPAWN_BIN" run \
      --agent claude --model opus \
      --allowed-tools "Read,Grep,Glob,Bash(git diff *),Bash(git log *),Bash(git show *),Bash(find *)" \
      --workspace "$WORKSPACE_PATH" \
      --prompt-file "$COUNCIL_DIR/phase1-opus-prompt.md" \
      --artifact-dir "$COUNCIL_DIR" \
      --artifact-name phase1-opus \
      --lane-id opus \
      --timeout-seconds 1800 \
      > "$COUNCIL_DIR/phase1-opus.cli.json" \
      2> "$COUNCIL_DIR/phase1-opus.cli.stderr" &
  OPUS_PID=$!
fi

if [ "$PI_AVAILABLE" = "true" ]; then
  "$CMUX_SPAWN_BIN" run \
      --agent pi --provider deepseek --model deepseek-v4-pro --thinking high \
      --tools "read,grep,find,ls" \
      --workspace "$WORKSPACE_PATH" \
      --prompt-file "$COUNCIL_DIR/phase1-pi-prompt.md" \
      --artifact-dir "$COUNCIL_DIR" \
      --artifact-name phase1-pi \
      --lane-id pi \
      --timeout-seconds 1800 \
      > "$COUNCIL_DIR/phase1-pi.cli.json" \
      2> "$COUNCIL_DIR/phase1-pi.cli.stderr" &
  PI_PID=$!
fi

[ -n "${OPUS_PID:-}" ] && wait "$OPUS_PID"
[ -n "${PI_PID:-}" ] && wait "$PI_PID"
```

The authoritative outputs are:

- Opus: `$COUNCIL_DIR/phase1-opus.md`
- Pi: `$COUNCIL_DIR/phase1-pi.md`
- Status: `$COUNCIL_DIR/phase1-{opus,pi}.status.json`
- Usage: `$COUNCIL_DIR/phase1-{opus,pi}.usage.json`
- Substrate logs: `$COUNCIL_DIR/phase1-{opus,pi}.{events.jsonl,pane.log,cli.stderr}`

Claude/Opus liveness rule: after launching a Claude lane, wait for the
`cmux-spawn run` process to finish or hit its configured
`--timeout-seconds`. Do not kill or reroute solely because the interim
status is quiet. Current cmux-spawn writes `state: "running"` once the
cmux workspace is launched; older builds may leave a live Claude lane
at `state: "starting"` until completion. Treat non-terminal
`starting`/`running` as in-progress unless `.cli.stderr`,
`.status.json`, or `.pane.log` shows a terminal startup error.

Treat a lane as failed if its status state is not `complete`, its
artifact is missing, its artifact is empty, or its artifact does not
satisfy the review artifact contract. A one-line summary artifact is
not review evidence, even when the status JSON says `complete` or its
message claims P1/P2 findings. Status messages are diagnostic only; the
Markdown artifact body is the authoritative evidence surface. Record
the artifact path, byte count, status message, and validation reason in
the council report, then continue only if at least one external
reviewer produced a contract-valid artifact.

### Phase 2: Cross-Examination

This is the value-add phase. Do not fix anything yet.

Codex Lead cross-examines every surviving Phase 1 finding in-session:

1. Read `templates/cross-exam-codex-prompt.md`.
2. Replace the Opus/Pi findings placeholders with available Phase 1
   artifacts.
3. Keep the prompt itself blind: Reviewer Alpha = Opus, Reviewer Beta
   = Pi. Do not let the labels become an authority signal.
4. Use it as the worksheet for your own adversarial review.
5. Write results to `$COUNCIL_DIR/phase2-codex.md`.

If both Opus and Pi succeeded in Phase 1, also ask Opus to
cross-examine Pi's findings:

1. Read `templates/cross-exam-opus-prompt.md`.
2. Replace `{WORKSPACE_PATH}`, `{BASE_BRANCH}`, `{REVIEW_MODE}`,
   `{CURRENT_HEAD_SHA}`, `{PREVIOUS_REVIEWED_HEAD_SHA}`,
   `{ARTIFACT_STATUS}`, and
   `[content from Reviewer Beta Phase 1 findings]`.
3. Write `$COUNCIL_DIR/cross-exam-opus-prompt.md`.
4. Keep Pi labeled as Reviewer Beta in that prompt; do not include
   model names in the cross-exam text.
5. Spawn Opus through cmux-spawn:

```bash
"$CMUX_SPAWN_BIN" run \
    --agent claude --model opus \
    --allowed-tools "Read,Grep,Glob,Bash(git diff *),Bash(git log *),Bash(git show *),Bash(find *)" \
    --workspace "$WORKSPACE_PATH" \
    --prompt-file "$COUNCIL_DIR/cross-exam-opus-prompt.md" \
    --artifact-dir "$COUNCIL_DIR" \
    --artifact-name phase2-opus \
    --lane-id opus \
    --timeout-seconds 1800 \
    > "$COUNCIL_DIR/phase2-opus.cli.json" \
    2> "$COUNCIL_DIR/phase2-opus.cli.stderr"
```

Read `$COUNCIL_DIR/phase2-opus.md` if the status is `complete`.
If Opus Phase 2 fails, proceed with Codex cross-exam only.

### Phase 3: Adversarial Triage

Read all Phase 1 findings and Phase 2 cross-exam artifacts, then
produce a unified triage. Use
`templates/council-report.md` as `$COUNCIL_DIR/council-report.md`.
Populate its Review Target section from `$COUNCIL_DIR/pr.json`,
`$COUNCIL_DIR/pr-is-draft.txt`, `$COUNCIL_DIR/pr-mode.txt`,
`$COUNCIL_DIR/pr-view-exit-code.txt`, `$COUNCIL_DIR/pr-diff-provenance.txt`,
`$COUNCIL_DIR/pr-head-sha.txt`, `$COUNCIL_DIR/local-head-sha.txt`,
`$COUNCIL_DIR/pr-base-ref.txt`, `$COUNCIL_DIR/resolved-base-ref.txt`,
`$COUNCIL_DIR/pr-base-equivalence.txt`, `$COUNCIL_DIR/pr-base-sha.txt`,
`$COUNCIL_DIR/resolved-base-sha.txt`,
`$COUNCIL_DIR/clean-pass-helper-path.txt`,
`$COUNCIL_DIR/clean-pass-helper-sha256.txt`,
`$COUNCIL_DIR/clean-pass-assertion.txt`,
`$COUNCIL_DIR/clean-pass-assertion-exit-code.txt`,
`$COUNCIL_DIR/git-status-short.txt`, and `$COUNCIL_DIR/diff.patch`
before recording the verdict. If a PR
exists, include its URL and mechanically asserted `isDraft` value. If
`$COUNCIL_DIR/pr-mode.txt` contains `PR-backed non-draft deviation`, the
report must use that mode and must not call the run a compliant
PR-backed clean PASS. If `$COUNCIL_DIR/pr-mode.txt` contains a degraded
mode such as `DEGRADED dirty working tree`, `DEGRADED gh-unavailable`,
or `DEGRADED pr-diff-provenance`, the report must use degraded mode even
when `$COUNCIL_DIR/pr-is-draft.txt` is `true` or `unknown`. A PR-backed
clean PASS also requires
`$COUNCIL_DIR/clean-pass-assertion-exit-code.txt` to be `0`; any
nonzero value means the run may pass correctness review but must not be
reported as a compliant PR-backed clean PASS. The only non-draft
exception is a PR intentionally
marked ready after all closeout gates passed; record that later
transition in closeout evidence before calling the final PR state ready.
If the review is degraded, list staged, unstaged, and untracked-file or
PR-detection state explicitly.

After reviewer artifacts and `$COUNCIL_DIR/council-report.md` exist,
rerun `scripts/assert-clean-pass.py --closeout` and refresh
`clean-pass-assertion.txt` plus
`clean-pass-assertion-exit-code.txt`. The setup-time assertion only
checks PR/diff provenance; the closeout assertion additionally rejects
missing, non-complete, tiny, or malformed Phase 1 reviewer artifacts.
Do not report a clean PASS from the setup-time assertion alone.

Triage process:

1. Collect every Phase 1 finding.
2. Annotate each finding with cross-exam verdicts:
   - Opus findings have Codex cross-exam evidence.
   - Pi findings have Codex cross-exam evidence and, when available,
     Opus cross-exam evidence.
3. Attempt to disprove each finding, even if multiple reviewers
   confirmed it. Read the actual code, not only the diff.
4. Before dismissing, answer: "Is the code correct, or did we merely
   not change it?" Pre-existing but real risks go to Track, not
   Dismissed.
5. Classify each finding exactly once:
   - **P1**: real bug/security issue introduced by this diff; blocks
     merge.
   - **P2**: meaningful quality or contract issue introduced by this
     diff; fix before merge.
   - **Track**: not introduced by this diff, but the post-merge system
     has a real correctness risk.
   - **Dismissed**: code is correct, out of scope, style-only, or an
     intentional design decision.
6. For every surviving P1/P2, verify it has current-head evidence:
   exact file:line, current head SHA, contract violated, reachable
   failure mode, and missing test/proof gap. If the finding relies on a
   stale base, degraded lane, malformed artifact, partial artifact, empty
   artifact, or prior-round prose without current-head code evidence,
   record artifact-quality/unavailable evidence instead of treating it
   as a merge-blocking code finding.
7. For every surviving Track finding, use `linear-workflow`: verify the
   repo's `.linear.toml`, search Linear first, then create or update an
   issue in the owning team/project with source refs, acceptance
   criteria, and verification. Track findings must be cold-read
   actionable: source refs, acceptance criteria, and verification steps
   go in Linear before the issue ID is cited. For Ezra repos, use
   `ezra-linear-workflow`. Record the issue ID and URL in the council
   report.

P1 and P2 findings stay in the current PR until fixed. If a P1/P2 also
reveals a broader durable risk outside the current diff, create or
update a separate Linear Track issue for that broader family.

Always write `$COUNCIL_DIR/council-track.json`, even when empty:

```json
{
  "schema_version": 1,
  "branch": "<branch name>",
  "linear_team": "<team key from .linear.toml or issue owner>",
  "linear_project": "<project name/id from .linear.toml, or null>",
  "items": []
}
```

### Phase 4: Fix And Verify

Fix all surviving P1/P2 findings. Keep patches scoped. Run the repo's
relevant tests/typechecks and record exact commands. If fixes are
substantial, run convergence.

### Phase 5: Convergence

The full council runs once. After fixes, stop at a decision checkpoint:

- Default path: rerun standard Phase 1 review with the available
  external lanes and triage directly. Do not repeat Phase 2
  cross-examination.
- Repeat cross-examination only when the P1/P2 fix materially changes
  the reviewed product surface, public contract, data flow,
  security/privacy boundary, or orchestration architecture enough that
  the post-fix diff is no longer just a fix to the original findings.
- In interactive sessions, pause before launching another full
  cross-exam and ask the user whether to spend that extra review cycle,
  unless they already requested autonomous closeout.
- In autonomous closeout mode, Codex Lead may decide to repeat
  cross-exam, but must record the threshold and rationale in the
  council report.

Stop when all reviewers are clean or only P3/theoretical findings
remain for two consecutive rounds.

If a same-family finding reopens after a convergence fix, stop treating
the next action as another tactical patch by default. Either restructure
against the named safety claim/contract or park the family with a
synthesis that names fixed symptoms, remaining symptoms, evidence, and
the next question. If the round cap is hit, write an operator-decision brief
with remaining families, fixed evidence, tests, recommended
action, and the exact next question. Do not silently launch another broad review loop.

### Closeout

Summarize:

- reviewer availability and failures;
- P1/P2 findings fixed;
- tests run;
- Track items with Linear issue IDs or URLs;
- PR/merge status, if requested;
- `$COUNCIL_DIR` location.

For PR-backed reviews, keep the PR draft until all P1/P2 findings are
fixed, tests pass, convergence evidence is recorded, and Track items
are filed. When asked to merge, mark the PR ready if needed, wait for
required checks, and merge using the repository's normal merge method.
If `pr-is-draft.txt` was `false` before those gates passed, closeout
must preserve `PR-backed non-draft deviation` as the review mode and
must not describe the run as a compliant PR-backed PASS. If the PR is
marked ready after the gates pass, record the command, timestamp, and
post-transition `gh pr view --json url,isDraft` evidence.
If `pr-mode.txt` was `DEGRADED dirty working tree`, closeout must not
describe the run as a PR-backed clean PASS, regardless of draft state.
If `pr-mode.txt` was `DEGRADED gh-unavailable`, closeout must not
describe the run as PR-backed or no-PR clean PASS; report the
`pr-view-exit-code.txt` value and `pr.stderr` evidence.
If `pr-mode.txt` was `DEGRADED pr-diff-provenance`, closeout must not
describe the run as a PR-backed clean PASS; report the PR head/base
artifacts, the local HEAD/base artifacts, and the
`clean-pass-assertion.txt` failure. A PR base-tip SHA mismatch is an
intentional clean-PASS degradation even when the three-dot diff might
still be equivalent after a base branch advance; fetch/rebase or record
the run as degraded instead of calling it a compliant PR-backed clean
PASS.

For degraded dirty working-tree reviews, closeout must explicitly state
that the council did not run against a draft PR and list the staged,
unstaged, and untracked-file state that reviewers evaluated or
explicitly excluded.

## Degradation Matrix

| Available Phase 1 reviewers | Phase 1 | Phase 2 | Phase 3 |
| --- | --- | --- | --- |
| Opus + Pi | Full parallel review | Codex cross-exams Opus + Pi; Opus cross-examines Pi | Triage with strongest evidence |
| Opus only | Opus review | Codex cross-examines Opus; skip Opus self-cross-exam | Triage with partial evidence |
| Pi only | Pi review | Codex cross-examines Pi; skip Opus | Triage with partial evidence |
| None | Fail closed | - | - |

If cmux-spawn preflight fails, the entire council fails closed. Do not
fall back to direct CLI invocations.

## Important Rules

- Council cross-examination runs on Round 1 only unless the explicit
  Phase 5 repeat threshold is met.
- Never fix findings before all available Phase 1 and Phase 2 outputs
  are collected.
- External model access goes through `cmux-spawn` only.
- Prompt files are mandatory; do not pass large prompts as shell
  arguments.
- Pi is Phase 1 only.
- Codex Lead stays in-session; do not spawn a separate Codex lane for
  this skill.
- No code edits in Phases 1-3.
- Prefer clean draft PR review for non-trivial work; dirty working-tree
  review is degraded and must document staged, unstaged, and untracked
  file handling.
- PR-backed clean PASS requires `scripts/assert-clean-pass.py --closeout`
  to exit 0 against `$COUNCIL_DIR` after reviewer artifacts exist. The
  helper reads the mechanical draft-state, git-status, PR head/base,
  local HEAD/base, base-equivalence, provenance artifacts, and at least
  one contract-valid completed Phase 1 reviewer artifact. The required
  values include
  `pr-is-draft.txt=true`, `pr-mode.txt=PR-backed draft`,
  `pr-view-exit-code.txt=0`, `pr-diff-provenance.txt=match`, safe base
  equivalence, matching PR/local head SHAs, matching PR/local base SHAs,
  and no staged or unstaged changes. Non-draft PRs before closeout gates are
  `PR-backed non-draft deviation`; dirty working trees are
  `DEGRADED dirty working tree`; unknown PR detection is
  `DEGRADED gh-unavailable`; PR/local diff identity mismatch is
  `DEGRADED pr-diff-provenance`. Base-tip divergence after a base branch
  advance, or a stale local base ref, intentionally lands in
  `DEGRADED pr-diff-provenance` until the local/PR base provenance is
  refreshed.
- Scope P1/P2 to the current diff. Track pre-existing but real risks in
  Linear.
- Tests must pass before closeout unless you explicitly report the
  blocker.
- Frontend web changes require a browser evidence pass before closeout:
  run deterministic checks, exercise the changed flow with `agent-browser`
  when installed, capture screenshots plus a short video, and attach the
  evidence to the owning Linear issue. Canonical protocol:
  `docs/frontend-qa-evidence-gate.md` in Crucible; automation issue:
  `MOB-45`.

## Error Handling

Before reading any artifact, check:

1. Does `$COUNCIL_DIR/error-{name}.md` exist?
2. Is `$COUNCIL_DIR/phaseN-{name}.status.json` state `complete`?
3. Is `$COUNCIL_DIR/phaseN-{name}.md` present and non-empty?

For failed lanes, inspect the corresponding `.cli.stderr`,
`.status.json`, and `.pane.log`. Pi auth, quota, provider, and capacity
failures require user action; do not retry blindly.

## Related Skills

- `~/.codex/skills/cmux-spawn/` - the lane spawn substrate contract.
- Claude-side `/council-review` - same process with Opus as lead and
  Codex as the external lane.
