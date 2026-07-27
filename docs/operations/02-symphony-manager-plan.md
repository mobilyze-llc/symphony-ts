# symphony-manager-plan

> **Status:** CANONICAL · **Template:** operations-doc v1.0 (`docs/operations/_TEMPLATE.md`) · **Owner:** Symphony
> **Source of truth:** `src/cli/manager-plan.ts` (`renderUsage`), `scripts/symphony-manager-plan` (wrapper)
> The **Usage** block below is auto-synced from the CLI's `--help` by `scripts/docs-sync.mjs`. Edit `renderUsage()` in source — not the block — then `pnpm build && pnpm docs:sync`. `pnpm test` fails if the block drifts.

## Purpose

One-shot run of the Queue Triage v2 backlog **Manager (the planner)** against a Linear team / project / initiative's eligible backlog. It prints the suggested batch plan and exits. It spends **one Opus pass** (unless `--prompt-only`) and writes **nothing** to Linear, the live standing-plan store, or dispatch. It reuses the exact planner core the live shadow tick uses; only the candidate *source* is a standalone read. (SYMPH-837 / SYMPH-858 / SYMPH-867.)

By default it **journals the emitted structural advisories** as `cli-session` evidence into the existing dispatcher run journal (`.symphony/run-journals/dispatcher.jsonl`) whenever a run-journal root is present — the same journal the automated tick and the calibration digest already use. This is advisory *evidence only*, keyed by the existing structural-advisory fingerprint identity; it is **not** a plan mutation and is **not** a new persistence system. Use `--no-journal` to preserve the old preview-only behavior, or `--journal` to force journaling (and create the root) even when one does not exist yet. Advisory *grading* is a separate step — the interactive session agent records its decision with `symphony-advisory-grade` (source `cli-session`); `symphonyctl grade-advisory` remains the manual escape hatch. (SYMPH-1140.)

## Installed location

| | |
|---|---|
| **On PATH** | `~/.local/bin/symphony-manager-plan` → symlink to the wrapper (run it from anywhere) |
| **Wrapper** | `scripts/symphony-manager-plan` — loads `.env` (`LINEAR_API_KEY`), rebuilds `dist/` if stale, then execs the CLI |
| **CLI** | `dist/src/cli/manager-plan.js` ← `src/cli/manager-plan.ts` |

## Usage

<!-- AUTOGEN:help START — managed by scripts/docs-sync.mjs; edit src/cli/manager-plan.ts renderUsage() -->
```text
Usage: symphony-manager-plan (--team <KEY> | --project <name-or-slugId> | --initiative <name|uuid>)... [--state <name>...] [options]

Run the Queue Triage v2 backlog Manager (planner) ONE-SHOT against the scoped
eligible backlog and print the suggested batch plan. It spends one Opus planner
pass unless --prompt-only, and writes NOTHING to Linear, the live standing-plan
store, or dispatch. --persist writes only to an isolated manager-plan store under
this run's artifact directory. By default it journals emitted structural
advisories as cli-session evidence into an existing dispatcher run journal when
one exists (--no-journal preserves preview-only; --journal forces it).

Scope (provide at least one; additive — combine them to narrow):
  --team <KEY>                 Linear team key whose backlog to plan (e.g. MOB)
  --project <name-or-slugId>   Linear project name or slugId to scope candidates to
  --initiative <name|uuid>     Linear initiative (UUID matches by id, else by name)

Options:
  --state <name>               Eligible-to-start state (repeatable; default Backlog)
  --concurrency-ceiling <n>    Operating-envelope ceiling (default 3)
  --risk <low|medium|high>     Allowed risk tier (default medium)
  --modes <csv>                Allowed batch modes (default parallel-isolated,canary-chain)
  --no-canary                  Drop canary-chain from the allowed modes (no canary runners)
  --model <name>               Planner model alias (default opus)
  --effort <level>             Planner effort: low, medium, high, max (default max)
  --page-size <n>              Linear candidate page size
  --out-dir <path>             Directory for planner artifacts and prompt-only prompt output
  --runtime-state-base-url <url>
                               Runtime host base URL for live in-flight issues (GET /api/v1/state)
  --in-flight-state <name>     Linear fallback in-flight state (repeatable; defaults In Progress, In Review, Resume)
  --no-comment-enrichment      Disable curated comment enrichment in the planner prompt
  --gh-pr-context              Source open/recently merged PR context from gh
  --github-repo <OWNER/REPO>   GitHub repo for --gh-pr-context
  --planner-grounding          Add report-only code grounding evidence to the planner prompt
  --triage-prep                Emit fresh deterministic per-finding evidence and add its read-only prompt pointer
  --triage-prep-repo <key=url> Repository to inspect at fresh origin/main (repeatable; or use env JSON)
  --planner-grounding-repo-url <url>
                               Repository URL for planner grounding (defaults env/git remote)
  --planner-grounding-commit <sha>
                               Commit SHA for planner grounding (defaults env/git HEAD)
  --planner-grounding-repo-scope <symphony|non_symphony>
                               Explicit grounding repo scope (defaults inferred from repo URL)
  --persist                    Persist the plan revision to an isolated artifact store
  --journal                    Force journaling emitted advisories as cli-session evidence
  --no-journal                 Preview only — do not journal emitted advisories
  --journal-root <path>        Run-journal root (defaults to the working directory)
  --prompt-only                Print the assembled planner prompt and exit (no Opus pass)
  --json                       Emit the plan as JSON
  --help                       Show this help text

Environment:
  LINEAR_API_KEY               Required (reads the backlog)
  LINEAR_ENDPOINT              Optional override of the Linear GraphQL endpoint
  GITHUB_REPOSITORY          Optional OWNER/REPO fallback for --gh-pr-context
  REPO_URL                  Optional Git remote URL fallback for --gh-pr-context
  SYMPHONY_MANAGER_PLAN_GROUNDING_REPO_URL
                               Optional repo URL fallback for --planner-grounding
  SYMPHONY_MANAGER_PLAN_GROUNDING_COMMIT
                               Optional commit SHA fallback for --planner-grounding
  SYMPHONY_MANAGER_PLAN_GROUNDING_REPO_SCOPE
                               Optional symphony/non_symphony scope for --planner-grounding
  SYMPHONY_MANAGER_PLAN_RUNTIME_STATE_BASE_URL
                               Optional runtime host base URL for live in-flight issues
  SYMPHONY_TRIAGE_PREP_REPOSITORIES
                               Optional JSON array of {"key","repoUrl"} repositories for --triage-prep
```
<!-- AUTOGEN:help END -->

## Scope — additive (provide at least one)

`--team`, `--project`, and `--initiative` **AND** together; supply any one or any combination to narrow.

- **`--team <KEY>`** — Linear team key (e.g. `MOB`, `SYMPH`).
- **`--project <slugId>`** — Linear project **slugId** (e.g. `9c1064215e8d`), not the team key. Find it from the project URL or via the Linear API.
- **`--initiative <name|uuid>`** — a canonical UUID matches by initiative **id**; any other string matches by **name** (initiative names are assumed unique in the workspace).
- `--team MOB --project <slug>` → issues in that team **and** project. `--project <slug> --initiative <x>` → issues whose project is `<slug>` **and** belongs to initiative `<x>`.

## Eligible state

- **`--state <name>`** is optional, repeatable, and **defaults to `Backlog`** when omitted (SYMPH-867).
- An explicit `--state` (one or more) **overrides** the default entirely — e.g. `--state Todo` plans Todo only, not Todo + Backlog.
- An explicit empty `--state ""` is rejected (exit 1). State names are **team-specific** — match them to the scope's real workflow.

## Examples

```bash
# Team backlog, default state (Backlog)
symphony-manager-plan --team SYMPH

# Project, explicit states
symphony-manager-plan --project 9c1064215e8d --state Backlog --state Todo

# Initiative by name, dry run (assemble the prompt, spend NO Opus pass)
symphony-manager-plan --initiative "Autonomous Work Selection & Dispatch" --prompt-only

# Additive scope + machine-readable output
symphony-manager-plan --team SYMPH --project 9c1064215e8d --json

# Triage rubric input: fresh read-only evidence, no model pass
symphony-manager-plan --team MOB --state Triage --triage-prep --prompt-only \
  --triage-prep-repo crucible=https://github.com/mobilyze-llc/crucible.git \
  --out-dir /tmp/mob-triage
```

## Edge cases & gotchas

- **No scope given** → exit 1 (`Provide at least one scope: --team … | --project … | --initiative …`).
- **`--prompt-only` still calls Linear.** It fetches candidates to build the prompt; it only skips the Opus pass. It does not need network-free operation.
- **Runtime in-flight context** comes from `--runtime-state-base-url` / `SYMPHONY_MANAGER_PLAN_RUNTIME_STATE_BASE_URL` when set; otherwise `--in-flight-state` uses the standalone Linear fallback.
- **Empty result** → exit 0 with `No eligible candidates for <scope> in state(s) [...]`. Usually means `--state` doesn't match the scope's real state names, or the scope is empty.
- **`--page-size 0` (or any non-positive integer)** → exit 1; `--concurrency-ceiling` likewise must be a positive integer.
- **Portfolio-held candidates** are excluded before planning (the human/JSON output reports how many were held).
- **Triage-prep sheets are ephemeral.** `--triage-prep` writes `triage-prep-evidence.json` under the current `--out-dir` (or generated run directory), fetches every configured repository's fresh `origin/main`, and adds one read-only pointer to the prompt. It never attaches the sheet or writes a disposition to Linear. Use repeatable `--triage-prep-repo <key=url>` flags or `SYMPHONY_TRIAGE_PREP_REPOSITORIES` JSON for multi-repository findings.

## Exit codes

| Code | Meaning |
|---|---|
| `0` | OK — plan printed, or no eligible candidates (a hint is printed) |
| `1` | Usage error (bad or missing arguments; missing `LINEAR_API_KEY`) |
| `3` | Planner unavailable (degraded — the live pipeline would fall back to the comparator) |
| `4` | Planner produced an invalid plan |
| `5` | Candidate load failed (Linear / network) |

## Deploy

The installed command runs from the **pro14 host repo** at `~/projects/symphony-ts`. To make a new build live:

```bash
cd ~/projects/symphony-ts
git checkout main && git fetch origin main && git merge --ff-only origin/main
pnpm install --frozen-lockfile && pnpm build
symphony-manager-plan --help          # verify the new flags/usage
```

- This is a **standalone CLI** — a manager-plan-only change needs **no orchestrator restart** (the `com.symphony.symphony` LaunchAgent runs `dist/src/cli/main.js`, which does not use this CLI).
- Keep the host worktree clean of uncommitted **tracked** changes so `git merge --ff-only` succeeds. `docs:sync` deliberately does not run during `pnpm build` for exactly this reason.
- Full Symphony deploy/restart procedure: the `symphony-ops` skill and the forthcoming `docs/operations/00-symphony.md`.

## Future direction

- SYMPH-838 ("manager-plan CLI v2") still tracks **opt-in persistence** of the plan and **`gh` PR-context enrichment** — not yet built.
- A future default beyond `Backlog` (per-team eligible-state config) is possible if teams diverge from the `Backlog`/`Todo` convention.

## Maintenance

Change flags/usage in `renderUsage()` (`src/cli/manager-plan.ts`), then `pnpm build && pnpm docs:sync`; `pnpm test` enforces the Usage block matches. Update the prose sections by hand when behavior changes. This doc instantiates `docs/operations/_TEMPLATE.md` (operations-doc v1.0).
