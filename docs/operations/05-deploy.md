# symphony deploy & control paths

> **Status:** CANONICAL · **Template:** operations-doc v1.0 (`docs/operations/_TEMPLATE.md`) · **Owner:** Symphony
> **Source of truth:** `ops/symphony-deploy`, `ops/deploy-train.sh`, `ops/symphony-ctl` (root resolution + worktree guard)
> Not auto-synced — this runbook is prose + commands. Update it by hand when the deploy scripts change.

## Purpose

Symphony has **two intentionally separate deploy flows** plus one **control surface**. This doc records which to use and how they resolve the service root, so the two operator paths don't encode contradictory root models (the SYMPH-708 decision). It does **not** replace the `symphony-ops` skill (live deploy/restart procedure) or the reserved `docs/operations/00-symphony.md` overview.

- **`symphony-deploy`** — the routine, **canonical** deploy. Pull + build + restart the **stable in-place** checkout that `symphony-ctl` serves from.
- **`deploy-train.sh`** — the heavyweight deploy for when lanes may be running. Operates on a **disposable, detached** runtime checkout and adds a drain gate + version gate.
- **`symphony-ctl`** — the launchd control surface (`install`/`start`/`stop`/`restart`/`status`/…). Both deploy flows call it to bounce the service.

## The two deploy flows

| | `symphony-deploy` | `deploy-train.sh` |
|---|---|---|
| **Role** | Routine, canonical deploy (use this by default) | Heavyweight deploy when lanes may be running |
| **Root model** | **Stable in-place** checkout (`$SCRIPT_DIR/..`, e.g. `~/projects/symphony-ts`) | **Disposable, detached** runtime checkout (`SYMPHONY_RUNTIME_CHECKOUT`, default `~/.codex/worktrees/symphony-ts-runtime-main`) |
| **Update mechanism** | `git pull --ff-only` in place — fails loudly on a dirty/diverged tree, never stashes or resets | `git reset --hard` + `git checkout --detach origin/main` — the target is treated as disposable |
| **Drain gate** | ❌ not yet (tracked: SYMPH-888) | ✅ require `running_lane_count==0 && retrying_lane_count==0` for 3 consecutive checks |
| **Version gate** | ❌ not yet (tracked: SYMPH-888) | ✅ assert live `symphony_version` contains the deployed short SHA |
| **Also handles** | claude-config repo, report-server plist, review-runtime preflight | reads the real serve path from the installed plist |
| **Restart** | via `symphony-ctl` | via `symphony-ctl` |

Both are correct; they are **different root models by design**. The detached model exists so the deploy target is disposable (safe to `reset --hard`); the in-place model exists so a normal `git pull --ff-only` updates the live checkout without a second tree. pro14 (current host) deploys in place via `symphony-deploy`; the detached model is the codex/pro16-era flow, preserved for its safety gates.

## Root model & the worktree guard

`symphony-ctl` resolves the service root in this precedence (highest first):

```
SYMPHONY_ROOT > SYMPHONY_SERVICE_ROOT > SYMPHONY_RUNTIME_CHECKOUT > default
```

…where **default** is the checkout containing `ops/symphony-ctl` — i.e. the **stable in-place root** (SYMPH-707). `symphony-deploy` relies on this default; it never sets `SYMPHONY_RUNTIME_CHECKOUT`.

Two guards keep the root coherent:

- **`symphony-ctl` worktree guard** (`check_service_root_not_worktree`, SYMPH-707 + **SYMPH-712**): refuses `install` when the resolved `SYMPHONY_ROOT` is a worktree. It is **git-aware** — it refuses a *linked* git worktree (one whose `git rev-parse --absolute-git-dir` differs from `--git-common-dir`) even when the path has no `worktrees` component, and it still refuses the known `.codex/worktrees/` and `.claude/worktrees/` operator-hazard paths by name. An ordinary checkout that merely lives under a directory called `worktrees` is **allowed** (no false positive). Override with `SYMPHONY_ALLOW_WORKTREE_ROOT=1`. The git-aware check needs git ≥ 2.31 on `PATH` (`--absolute-git-dir` / `--path-format=absolute`); if git is unavailable it is skipped with a warning rather than silently passing, and the `.codex/.claude` refusals still apply.
- **`deploy-train.sh` coherence guard** (`check_runtime_checkout_not_stable_root`, **SYMPH-708**): refuses to run when `SYMPHONY_RUNTIME_CHECKOUT` resolves to the **stable in-place root**. Because deploy-train does `reset --hard` + `checkout --detach`, pointing it at the live checkout would discard local state and detach it. Override with `DEPLOY_TRAIN_ALLOW_STABLE_ROOT=1`. This guard is **path-equality only** — a separate git worktree *linked to* the stable checkout is not yet refused (tracked: **SYMPH-892**), so don't point the deploy train at one.

How `SYMPHONY_RUNTIME_CHECKOUT` interacts with the two: it is the **lowest-priority** root override for `symphony-ctl` (used only if `SYMPHONY_ROOT`/`SYMPHONY_SERVICE_ROOT` are unset), and it is the **target** for `deploy-train.sh`. Setting it to a worktree path is exactly what the `symphony-ctl` worktree guard refuses for `install`; setting it to the stable root is what the `deploy-train.sh` coherence guard refuses. Leave it unset for routine `symphony-deploy` runs.

Bootstrapping the detached flow is the one case where the two guards collide: installing a plist rooted under `.codex/worktrees/` (which the default runtime checkout is) is refused by the `symphony-ctl` worktree guard, so it requires `SYMPHONY_ALLOW_WORKTREE_ROOT=1` at `symphony-ctl install` time. On the current host (pro14, in-place via `symphony-deploy`) the detached flow is not bootstrapped, so this does not arise.

## Examples

```bash
# Routine deploy (canonical). Pull + build + restart the in-place checkout.
cd ~/projects/symphony-ts
ops/symphony-deploy                      # both repos (symphony-ts + claude-config)
ops/symphony-deploy --symphony           # symphony-ts only
ops/symphony-deploy --dry-run            # show the plan, change nothing

# Heavyweight deploy when lanes may be running (drain + version gated).
# Operates on the disposable detached runtime checkout, NOT the stable root.
ops/deploy-train.sh --dry-run
ops/deploy-train.sh                       # drain gate -> stop -> build -> start -> version gate
SYMPHONY_RUNTIME_CHECKOUT=~/.codex/worktrees/symphony-ts-runtime-main ops/deploy-train.sh

# Control surface only (no code update).
ops/symphony-ctl status
ops/symphony-ctl restart
```

## Deploy-managed crabrunner environment (planner/review lane placement)

The crabrunner planner/review lanes read their configuration from the LaunchAgent
environment, which `symphony-ctl install` bakes into the plist from the durable
**SOPS** source (`.env` decrypted from `.env.enc`). `symphony-deploy` runs a
review preflight that **refuses to deploy** when a required crabrunner var
(`SYMPHONY_CRABRUNNER_ROOT`/`_VERSION`/`_STATE_ROOT`) is set only in the operator
shell — an ambient-only value disappears when the LaunchAgent restarts.

- **`SYMPHONY_CRABRUNNER_HOST`** (SYMPH-1144) selects where planner/review lanes
  run. Unset/blank runs them locally; **production pins it to `pro16`**. It is the
  *only* lever for planner lane placement (no fleet admission/capacity machinery).
  The runtime logs the resolved host at startup (`queue_triage_planner_host_resolved`)
  and stamps `planner_host` on every planner tick journal record, including
  `queue_triage_skipped_empty_backlog`.
- **Keep `SYMPHONY_CRABRUNNER_HOST=pro16` in the durable SOPS env source** so it
  **survives host moves and LaunchAgent restarts**. Do not rely on an
  operator-shell export. To set/rotate it: edit the decrypted `.env`, re-encrypt
  to `.env.enc` (`sops --encrypt`), commit the encrypted file, then re-run
  `ops/symphony-ctl install` (or `ops/symphony-deploy`) so the plist picks up the
  new value. Confirm with `ops/symphony-ctl status` and the startup
  `queue_triage_planner_host_resolved` log line showing `planner_host=pro16`.

## Edge cases & gotchas

- **`deploy-train.sh` refuses the stable root.** If `SYMPHONY_RUNTIME_CHECKOUT` (or its default) resolves to the same path as the script's own checkout, it dies before touching anything (`Refusing to run the detached deploy train against the stable in-place checkout`). Use `symphony-deploy` for in-place deploys, or set `DEPLOY_TRAIN_ALLOW_STABLE_ROOT=1` only if you truly mean to `reset --hard` that checkout.
- **`symphony-ctl install` refuses a worktree root.** A `.codex/worktrees/` or `.claude/worktrees/` path dies with `Refusing to install from worktree root`; any other linked git worktree dies with `Refusing to install from a linked git worktree root`. Re-run from the stable checkout, or set `SYMPHONY_ALLOW_WORKTREE_ROOT=1` to override. If `git` is not on `PATH`, the git-aware check is skipped with a warning instead of silently passing.
- **`symphony-deploy` never stashes or resets.** A dirty or diverged tracked tree fails the `git pull --ff-only` loudly — by design (stash-churn caused a stale deploy on 2026-06-10). Commit or stash by hand, then re-run.
- **`symphony-deploy` has no drain/version gate yet.** It stops the service without waiting for in-flight lanes to drain and restarts without asserting the deployed SHA. Tracked in **SYMPH-888**; until then, prefer `deploy-train.sh` when lanes may be running.
- **`cmux-spawn` skill source of truth is `claude-config`.** During the config phase, `symphony-deploy` requires `~/projects/claude-config/skills/cmux-spawn/SKILL.md`, enforces `~/.agents/skills/cmux-spawn` as a resolved symlink to that source, and archives any active duplicate installs under `~/.claude/skills/cmux-spawn` or `~/.codex/skills/cmux-spawn` so later `pnpm test` pretests do not fail on duplicate skill discovery.

## Deploy

To make a new build live on the current host, routine path:

```bash
cd ~/projects/symphony-ts
git checkout main && git fetch origin main && git merge --ff-only origin/main
ops/symphony-deploy --symphony            # pull + build + restart; --dry-run to preview
ops/symphony-ctl status                   # confirm the service is up on the new SHA
```

Keep the host worktree clean of uncommitted **tracked** changes so `git merge --ff-only` and `symphony-deploy`'s in-place pull succeed. Full live procedure: the `symphony-ops` skill.

## Future direction

- **SYMPH-888** — port the `deploy-train.sh` drain gate + version gate into `symphony-deploy` so the canonical path gets the same safety guarantees. Once it lands, update the comparison table above.
- **SYMPH-892** — make the `deploy-train.sh` coherence guard git-aware (refuse a worktree *linked to* the stable root, not just the exact stable path), once it's confirmed safe against the legitimate detached checkout.
- The reserved `docs/operations/00-symphony.md` overview will link here as the deploy section.

## Maintenance

Change behavior in `ops/symphony-deploy`, `ops/deploy-train.sh`, or `ops/symphony-ctl`; then update this doc by hand (it is not AUTOGEN-synced). The root-resolution precedence is enforced by `tests/ops/symphony-ctl-env.test.ts`; the worktree guard and the deploy-train coherence guard are covered by `tests/ops/symphony-ctl-env.test.ts` and `tests/ops/deploy-train.test.ts` respectively. This doc instantiates `docs/operations/_TEMPLATE.md` (operations-doc v1.0).
