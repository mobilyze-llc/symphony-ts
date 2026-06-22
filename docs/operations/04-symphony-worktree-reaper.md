# Symphony Worktree Reaper

> **Status:** CANONICAL · **Template:** operations-doc v1.0 (`docs/operations/_TEMPLATE.md`) · **Owner:** Symphony
> **Source of truth:** `ops/symphony-ctl prune-worktrees`

## Purpose

`ops/symphony-ctl prune-worktrees` removes completed, project-local git
worktrees that keep old branches and dependency installs pinned under the stable
checkout. It defaults to dry-run and only considers registered worktrees under
`<stable-root>/.worktrees/` and `<stable-root>/.claude/worktrees/`; it does not
touch global Codex or Claude worktree folders.

## Installed location

| | |
|---|---|
| **On PATH** | Run from the stable checkout as `ops/symphony-ctl prune-worktrees` |
| **Wrapper / entry** | `ops/symphony-ctl` |
| **Source** | Bash implementation in `ops/symphony-ctl` |

## Usage

```bash
# Preview safe candidates.
ops/symphony-ctl prune-worktrees --dry-run

# Remove safe candidates at least seven days old, then prune now-unpinned branches.
ops/symphony-ctl prune-worktrees --execute

# Use a smaller threshold for a controlled synthetic test repo only.
SYMPHONY_ROOT=/tmp/synthetic-symphony \
  ops/symphony-ctl prune-worktrees --execute --older-than 0
```

## Flags / inputs

- `--dry-run`: default. Prints candidates, skip reasons, dependency footprint,
  durable-context signal, and estimated reclaimable size.
- `--execute`: removes safe candidates with `git worktree remove --force`, then
  runs the existing branch pruning path so stale branch refs stop being pinned.
- `--older-than N`: only remove candidates at least `N` days old. Default is `7`.
- `SYMPHONY_ROOT`: stable checkout root. Use this for synthetic tests; production
  cleanup should point at `/Users/ericlitman/projects/symphony-ts`.

## Safety Rules

A worktree is removable only when all checks pass:

- It is a registered git worktree under stable-root `.worktrees/` or
  `.claude/worktrees/`.
- It is branch-backed, not detached.
- It is not the current checkout, `SYMPHONY_ROOT`, `SYMPHONY_SERVICE_ROOT`, or
  `SYMPHONY_RUNTIME_CHECKOUT`.
- `git status --porcelain --untracked-files=all` is clean.
- Its upstream tracking branch is gone after `git fetch --prune`.
- It is old enough for the configured threshold.
- Its branch name or worktree directory name contains a recognized project issue
  key such as `SYMPH-890` or `MOB-146`, or the stable root has a matching
  `handoffs/` artifact.

Dirty worktrees, detached worktrees, recent worktrees, upstream-present branches,
and candidates without durable context are reported and left in place.

## Closeout Habit

Before abandoning or merging a lane, preserve any needed context outside the
throwaway worktree. Use Linear comments/docs or stable-root `handoffs/`, never a
handoff file that only exists inside the branch worktree being removed.

Then run:

```bash
ops/symphony-ctl prune-worktrees --dry-run
ops/symphony-ctl prune-worktrees --execute
```

Paste the summary line into the Linear/PR closeout when the cleanup was part of
the work.

## Edge Cases & Gotchas

- Dry-run can report branches as still pinned because the worktree has not been
  removed yet. Execute mode removes candidates first, then invokes
  `prune-branches`.
- `node_modules` is shown as a footprint indicator, not as a deletion reason.
  The deletion decision is still driven by git safety and durable context.
- If `git fetch --prune` fails, the command proceeds with local tracking data
  and prints a warning. Treat that dry-run as stale evidence.
- Dry-run warns when `git worktree prune --dry-run` detects stale registrations.
  Execute mode runs `git worktree prune` before evaluating registered
  worktrees.

## Exit Codes

| Code | Meaning |
|---|---|
| `0` | Completed inventory or cleanup. Individual candidates may still be skipped. |
| `1` | Invalid flags, non-git `SYMPHONY_ROOT`, or an unrecoverable shell error. |

## Maintenance

Update `ops/symphony-ctl`, `tests/ops/symphony-ctl-worktrees.test.ts`, and this
runbook together when changing candidate rules or output fields.
