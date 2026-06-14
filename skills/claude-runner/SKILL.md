---
name: claude-runner
description: Invoke the general-purpose Claude CMUX runner safely for bounded review, research, critique, spec-partner, and explicit development-agent prompts.
---

# Claude Runner

Use this skill when an agent needs a bounded Claude lane through Symphony's
approved CMUX substrate. The entrypoint is `claude-runner`, which wraps
`cmux-spawn run --agent claude` and validates the artifact before returning
success.

Do not call `claude -p`, `claude --bg`, or hand-written unmanaged Claude
subprocesses when `claude-runner` or the underlying CMUX substrate is
available. If the runner cannot be found, fail closed or ask the operator how to
continue; do not invent a parallel Claude launch path.

For durable spec-time ticket review, use `symphony-spec-review-watch` instead
of this generic skill. The watcher owns ticket selection, source-intent hashes,
Linear Doc publication, idempotency markers, and reconciliation into the
runtime. Use this skill for bounded one-off Claude work where the caller owns
the prompt, source list, validation contract, and result inspection.

## Source And Install Model

The canonical skill source lives in `skills/claude-runner` in the stable
`symphony-ts` checkout. Cross-repo discovery should use the user-level symlink
`~/.agents/skills/claude-runner` pointing at that stable source directory. Do
not install a copied global skill under `~/.codex/skills/claude-runner`, and do
not use the stale `symphony-claude-runner` skill name.

## Required Inputs

Prepare these before running the command:

- `WORKSPACE_ROOT`: repository or workspace root Claude may read.
- `PROMPT_FILE`: prompt Markdown inside `WORKSPACE_ROOT`.
- `ARTIFACT_DIR`: directory for runner outputs, usually inside the workspace.
- `ARTIFACT_NAME`: safe basename using letters, numbers, dots, underscores, or
  hyphens.
- `PURPOSE`: one of `review`, `research`, `spec-review`, `spec-partner`,
  `development-agent`, `critique`, or `custom`.
- `SOURCE` files: every source file Claude must read, expressed as paths inside
  `WORKSPACE_ROOT`; repeat `--source` for each one.
- `MODEL` and `PROFILE`: default to `opus` and `legacy` when omitted.
- `TIMEOUT_SECONDS`: lane timeout; default is 1800.
- `CMUX_SPAWN_BIN`: optional cmux-spawn override when `cmux-spawn` is not on
  `PATH`.

Prompts and sources must be inside the workspace. The runner checks prompt and
source visibility before invoking Claude, writes a failed result JSON when a
path is unreadable or outside the workspace, and does not spend model time on
that invalid setup.

## Base Command

```bash
WORKSPACE_ROOT="$(pwd)"
ARTIFACT_DIR="$WORKSPACE_ROOT/.symphony/claude-runner"
CMUX_SPAWN_BIN="${CMUX_SPAWN_BIN:-$(command -v cmux-spawn || true)}"

test -n "$CMUX_SPAWN_BIN" || {
  echo "Set CMUX_SPAWN_BIN to an executable cmux-spawn path or put cmux-spawn on PATH." >&2
  exit 1
}

claude-runner \
  --purpose custom \
  --workspace "$WORKSPACE_ROOT" \
  --prompt-file "$WORKSPACE_ROOT/prompts/claude-task.md" \
  --artifact-dir "$ARTIFACT_DIR" \
  --artifact-name claude-task \
  --model opus \
  --profile legacy \
  --timeout-seconds 1800 \
  --cmux-spawn-bin "$CMUX_SPAWN_BIN" \
  --source src/index.ts \
  --required-heading "Verdict" \
  --min-bytes 400 \
  --retry-on-invalid
```

## Purpose Templates

All templates assume:

```bash
WORKSPACE_ROOT="$(pwd)"
ARTIFACT_DIR="$WORKSPACE_ROOT/.symphony/claude-runner"
CMUX_SPAWN_BIN="${CMUX_SPAWN_BIN:-$(command -v cmux-spawn || true)}"
```

### `spec-partner`

Use for shaping or pressure-testing a draft spec. The lane is advisory and must
not mutate files or Linear.

```bash
claude-runner \
  --purpose spec-partner \
  --workspace "$WORKSPACE_ROOT" \
  --prompt-file "$WORKSPACE_ROOT/prompts/spec-partner.md" \
  --artifact-dir "$ARTIFACT_DIR" \
  --artifact-name spec-partner-opus \
  --cmux-spawn-bin "$CMUX_SPAWN_BIN" \
  --source docs/spec-draft.md \
  --required-heading "Source Read Status" \
  --required-heading "Spec Pressure Test" \
  --required-heading "Recommended Changes" \
  --require-first-heading "Source Read Status" \
  --min-bytes 800 \
  --retry-on-invalid
```

### `spec-review`

Use only for prompt-only spec-review fallback when the durable watcher path is
not usable. Prefer `symphony-spec-review-watch` or the `spec-review-lane` skill
for durable ticket readiness. Treat fallback artifacts as manual reconciliation
evidence.

```bash
claude-runner \
  --purpose spec-review \
  --workspace "$WORKSPACE_ROOT" \
  --prompt-file "$WORKSPACE_ROOT/prompts/spec-review.md" \
  --artifact-dir "$ARTIFACT_DIR" \
  --artifact-name spec-review-opus \
  --cmux-spawn-bin "$CMUX_SPAWN_BIN" \
  --source SPEC.mobilyze.md \
  --required-heading "Source Read Status" \
  --required-heading "Verdict" \
  --required-heading "Review" \
  --required-heading "Reconciliation JSON" \
  --required-json-section "Reconciliation JSON" \
  --verdict-enum ready_as_written \
  --verdict-enum needs_changes \
  --min-bytes 900 \
  --retry-on-invalid
```

### `research`

Use for bounded codebase or document research where Claude returns findings and
source-backed evidence.

```bash
claude-runner \
  --purpose research \
  --workspace "$WORKSPACE_ROOT" \
  --prompt-file "$WORKSPACE_ROOT/prompts/research.md" \
  --artifact-dir "$ARTIFACT_DIR" \
  --artifact-name research-opus \
  --cmux-spawn-bin "$CMUX_SPAWN_BIN" \
  --source src/claude-runner/cmux-claude-runner.ts \
  --source src/cli/claude-runner.ts \
  --required-heading "Source Read Status" \
  --required-heading "Findings" \
  --required-heading "Open Questions" \
  --min-bytes 600 \
  --retry-on-invalid
```

### `critique`

Use for critique of an existing plan, prompt, design, or implementation idea.

```bash
claude-runner \
  --purpose critique \
  --workspace "$WORKSPACE_ROOT" \
  --prompt-file "$WORKSPACE_ROOT/prompts/critique.md" \
  --artifact-dir "$ARTIFACT_DIR" \
  --artifact-name critique-opus \
  --cmux-spawn-bin "$CMUX_SPAWN_BIN" \
  --source docs/plan.md \
  --required-heading "Source Read Status" \
  --required-heading "Strengths" \
  --required-heading "Risks" \
  --required-heading "Recommendation" \
  --min-bytes 600 \
  --retry-on-invalid
```

### `review`

Use for read-only review where the caller wants a verdict enum. For PR-backed
merge decisions, prefer the repo's council-review workflow when it applies.

```bash
claude-runner \
  --purpose review \
  --workspace "$WORKSPACE_ROOT" \
  --prompt-file "$WORKSPACE_ROOT/prompts/review.md" \
  --artifact-dir "$ARTIFACT_DIR" \
  --artifact-name review-opus \
  --cmux-spawn-bin "$CMUX_SPAWN_BIN" \
  --source src/target.ts \
  --source tests/target.test.ts \
  --required-heading "Source Read Status" \
  --required-heading "Verdict" \
  --required-heading "Findings" \
  --require-first-heading "Source Read Status" \
  --verdict-enum pass \
  --verdict-enum fail \
  --verdict-enum degraded \
  --min-bytes 800 \
  --retry-on-invalid
```

### `development-agent`

Use only when the operator explicitly authorizes Claude to propose or perform a
bounded development task. Include scope, allowed files, stop conditions, and a
validation command in the prompt. Keep file mutation authority explicit; read-only
development planning should use `research`, `critique`, or `custom`.

```bash
claude-runner \
  --purpose development-agent \
  --workspace "$WORKSPACE_ROOT" \
  --prompt-file "$WORKSPACE_ROOT/prompts/development-agent.md" \
  --artifact-dir "$ARTIFACT_DIR" \
  --artifact-name development-agent-opus \
  --cmux-spawn-bin "$CMUX_SPAWN_BIN" \
  --source src/target.ts \
  --source tests/target.test.ts \
  --required-heading "Source Read Status" \
  --required-heading "Implementation Plan" \
  --required-heading "Validation" \
  --required-json-section "Change Contract JSON" \
  --min-bytes 900 \
  --timeout-seconds 2400 \
  --retry-on-invalid
```

### `custom`

Use for bounded one-off prompts that do not fit the named purposes. Make the
validation contract specific enough that an empty or generic artifact cannot
pass.

```bash
claude-runner \
  --purpose custom \
  --workspace "$WORKSPACE_ROOT" \
  --prompt-file "$WORKSPACE_ROOT/prompts/custom.md" \
  --artifact-dir "$ARTIFACT_DIR" \
  --artifact-name custom-opus \
  --cmux-spawn-bin "$CMUX_SPAWN_BIN" \
  --source README.md \
  --required-heading "Source Read Status" \
  --required-heading "Result" \
  --min-bytes 400 \
  --retry-on-invalid
```

## Validation Contract

Use validation flags to make the expected artifact machine-checkable:

- `--required-heading <text>`: require a Markdown heading anywhere in the
  artifact. Repeat for every mandatory section.
- `--require-first-heading <text>`: require the first non-empty line to be that
  heading.
- `--verdict-enum <value>`: require a verdict line whose enum is one of the
  repeated values, for example `verdict: pass`.
- `--required-json-section <heading>`: require exactly one fenced JSON object in
  that section. Missing, duplicate, non-object, unterminated, or malformed JSON
  fails validation.
- `--min-bytes <n>`: raise the default artifact floor when a terse response
  would be unsafe.
- `--retry-on-invalid`: retry once with a repair prompt that includes the
  validation errors and previous artifact.

After the command returns, inspect `<ARTIFACT_DIR>/<ARTIFACT_NAME>.result.json`.
Treat only `"status": "passed"` as success. The normalized result records
`validationErrors`, `attempts`, `sourceVisibility`, bounded preflight and lane
diagnostics, usage when cmux-spawn reports it, the artifact path, and the status
path. A process exit code of 1 with `invalid_artifact`, `failed`, `timed_out`,
or `degraded` is not a usable pass.

## Quiet-Lane Semantics

Claude lanes may be quiet for most of their runtime. Silence is not failure.
Do not kill or restart a lane merely because stdout is idle. Wait for
`claude-runner` to return or for its timeout to expire. When monitoring
from another shell, poll these files until the command reaches a terminal state:

- `<ARTIFACT_DIR>/<ARTIFACT_NAME>.status.json`
- `<ARTIFACT_DIR>/<ARTIFACT_NAME>.cli.json`
- `<ARTIFACT_DIR>/<ARTIFACT_NAME>.result.json`

If `status.json` is still running, keep polling. If the runner exits with a
failed result, use the result JSON's `message`, `diagnostics`, and
`validationErrors` before deciding whether to retry with a revised prompt.

## Source Visibility

Every declared source must be readable inside `WORKSPACE_ROOT`. The prompt file
must also live inside `WORKSPACE_ROOT`. Outside-workspace paths, unreadable
files, and missing prompts fail before model invocation with
`sourceVisibility.status` set to `invalid_source_path`.

Use relative `--source` paths when possible. Do not pass secrets, private home
directory files, or broad directories as sources. The source list is the
operator's declaration of what Claude is allowed and expected to inspect.

## Dogfood Note

A prompt-only dogfood run for the spec-review wrapper exposed the intended safe
path: an initial outside-workspace prompt failed before Claude invocation; after
moving the prompt into the workspace and declaring the relevant source files,
the runner produced a validated Opus artifact with required headings, verdict
enums, a required JSON section, a minimum byte floor, and `--retry-on-invalid`.
Use that pattern: fix source-visibility failures first, then trust the result
JSON rather than informal lane impressions.
