---
name: spec-review-lane
description: Run Symphony's durable spec-time review lane for a targeted Linear ticket from a Codex orchestrator session. Use before implementing a newly picked Symphony ticket while the autonomous watcher is still being bootstrapped, or when an operator asks for an explicit spec review. Prefers symphony-spec-review-watch direct-ticket mode; prompt-only Claude runner fallback is manual reconciliation only.
---

# Symphony Spec Review Lane

Use this skill when Codex is acting as the temporary Symphony orchestrator and
needs to ask the durable spec-time review lane to review a specific Linear
ticket before implementation.

This skill is the spec-review wrapper. For general Claude calls unrelated to
durable ticket review, use the separate Claude-runner skill when it exists.

## Source And Install Model

The canonical skill source lives in `skills/spec-review-lane` in the stable
`symphony-ts` checkout. Cross-repo discovery should use the user-level symlink
`~/.agents/skills/spec-review-lane` pointing at that stable source directory.
Repo-local discovery uses `.agents/skills/spec-review-lane` as a symlink to the
same canonical repo directory. Do not install a copied global skill under
`~/.codex/skills/spec-review-lane`; copy-style installs drift.

## Default Path

Prefer the durable watcher path:

```bash
skills/spec-review-lane/scripts/run-spec-review-lane.mjs \
  --workflow WORKFLOW.md \
  --workspace /path/to/symphony-ts \
  --issue SYMPH-123 \
  --mode observe \
  --force
```

The wrapper calls `symphony-spec-review-watch` with `--issue-direct` so the
ticket does not need to be in the watcher's active states or Pipeline project.
It prints a compact operator summary derived from the watcher's JSON output.

Use `--dry-run` first when you only want selection proof:

```bash
skills/spec-review-lane/scripts/run-spec-review-lane.mjs \
  --workflow WORKFLOW.md \
  --workspace /path/to/symphony-ts \
  --issue SYMPH-123 \
  --mode observe \
  --force \
  --dry-run
```

## Inputs

- `--issue`: Linear identifier to review. Required.
- `--workspace`: Claude-readable repository root. Required.
- `--workflow`: workflow file. Defaults to `<workspace>/WORKFLOW.md` when
  omitted.
- `--mode`: `observe`, `warn`, or `enforce`. Default: `observe`.
- `--force`: review now even if normal selection heuristics would skip the
  ticket. Force never bypasses privacy-sensitive labels.
- `--source-ref`: source-of-truth file to include. Repeatable. Default is the
  watcher default, currently `SPEC.mobilyze.md`.
- `--artifact-root`: optional artifact directory.
- `--cmux-spawn-bin`: optional cmux-spawn override.
- `--symphony-spec-review-watch-bin`: optional watcher binary override.

## Operator Summary

The wrapper derives `nextAction` deterministically:

- `valid`: `none`
- `needs_operator_context`: `supply_operator_context`
- `failed`, `runner_failed`, `invalid_artifact`: `rerun_or_inspect_artifact`
- `privacy_blocked`: `handle_out_of_band`
- no result: `inspect_selection`

The raw durable evidence remains the watcher output, selection artifact, Linear
issue body, Linear Doc when created, and dispatcher journal row.

## Prompt-Only Fallback

Use `claude-runner` directly only when the durable watcher path is not
usable. Fallback artifacts are useful review evidence, but they are not durable
spec-review readiness state.

Fallback requirements:

- prompt file lives inside the declared workspace;
- declare source files with `--source`;
- require headings `Verdict`, `Source Read Status`, `Review`, and
  `Reconciliation JSON`;
- require a verdict enum and JSON reconciliation section;
- use `--min-bytes` and `--retry-on-invalid`;
- make `reconciliation: "manual"` explicit in your operator summary;
- do not write a `spec_review_result` journal row, generated readiness marker,
  or marker comment from a prompt-only artifact.

## Failure Handling

- Missing direct-fetch support fails closed before Claude is invoked.
- Missing or unresolved direct-ticket labels fail closed in the tracker layer.
- Privacy-sensitive labels produce `privacy_blocked`; force does not unblock
  them.
- A quiet Claude lane is not a stall. Poll the wrapper, result JSON, or watcher
  artifacts until terminal state or timeout.
