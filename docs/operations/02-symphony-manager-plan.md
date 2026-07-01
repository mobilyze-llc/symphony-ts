# symphony-manager-plan

> **Status:** CANONICAL · **Template:** operations-doc v1.0 (`docs/operations/_TEMPLATE.md`) · **Owner:** Symphony
> **Source of truth:** `src/cli/manager-plan.ts` (`renderUsage`), `scripts/symphony-manager-plan` (wrapper)
> The **Usage** block below is auto-synced from the CLI's `--help` by `scripts/docs-sync.mjs`. Edit `renderUsage()` in source — not the block — then `pnpm build && pnpm docs:sync`. `pnpm test` fails if the block drifts.

## Purpose

One-shot, **output-only** run of the Queue Triage v2 backlog **Manager (the planner)** against a Linear team / project / initiative's eligible backlog. It prints the suggested batch plan and exits. It spends **one Opus pass** (unless `--prompt-only`) and writes **nothing** to Linear, the live standing-plan store, or dispatch — so it is safe to run any time to preview what the Manager would propose. It reuses the exact planner core the live shadow tick uses; only the candidate *source* is a standalone read. (SYMPH-837 / SYMPH-858 / SYMPH-867.)

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
eligible backlog and print the suggested batch plan. Output-only: it spends one
Opus planner pass unless --prompt-only, and writes NOTHING to Linear,
the live standing-plan store, or dispatch. --persist writes only to an isolated
manager-plan store under this run's artifact directory.

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
  --page-size <n>              Linear candidate page size
  --out-dir <path>             Directory for planner artifacts and prompt-only prompt output
  --runtime-state-base-url <url>
                               Runtime host base URL for live in-flight issues (GET /api/v1/state)
  --in-flight-state <name>     Linear fallback in-flight state (repeatable; defaults In Progress, In Review, Resume)
  --no-comment-enrichment      Disable curated comment enrichment in the planner prompt
  --gh-pr-context              Source open/recently merged PR context from gh
  --github-repo <OWNER/REPO>   GitHub repo for --gh-pr-context
  --planner-grounding          Add report-only code grounding evidence to the planner prompt
  --planner-grounding-repo-url <url>
                               Repository URL for planner grounding (defaults env/git remote)
  --planner-grounding-commit <sha>
                               Commit SHA for planner grounding (defaults env/git HEAD)
  --planner-grounding-repo-scope <symphony|non_symphony>
                               Explicit grounding repo scope (defaults inferred from repo URL)
  --persist                    Persist the plan revision to an isolated artifact store
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
```

## Dogfood evidence

When live Linear access is unavailable in a worker, the controller must generate
the SYMPH-961 dogfood evidence with:

```bash
scripts/symphony-manager-plan --project 9c1064215e8d --state Backlog --state Todo --runtime-state-base-url http://127.0.0.1:4321 --prompt-only --out-dir /tmp/symphony-manager-plan-SYMPH-961-prompt-only
```

The artifact must follow `src/cli/manager-plan-dogfood-evidence.ts`: record the
prompt-only/live-equivalent rerun, classify `SYMPH-941`,
`SYMPH-877`/`SYMPH-878` with `SYMPH-947`, and `SYMPH-839` with in-flight
`SYMPH-950` as category `(a)`/`(b)`/`(c)`, and include the Phase 0 gate
decision. Do not mark the acceptance criteria complete without the live evidence
artifact.

## Edge cases & gotchas

- **No scope given** → exit 1 (`Provide at least one scope: --team … | --project … | --initiative …`).
- **`--prompt-only` still calls Linear.** It fetches candidates to build the prompt; it only skips the Opus pass. It does not need network-free operation.
- **Runtime in-flight context** comes from `--runtime-state-base-url` / `SYMPHONY_MANAGER_PLAN_RUNTIME_STATE_BASE_URL` when set; otherwise `--in-flight-state` uses the standalone Linear fallback.
- **Empty result** → exit 0 with `No eligible candidates for <scope> in state(s) [...]`. Usually means `--state` doesn't match the scope's real state names, or the scope is empty.
- **`--page-size 0` (or any non-positive integer)** → exit 1; `--concurrency-ceiling` likewise must be a positive integer.
- **Portfolio-held candidates** are excluded before planning (the human/JSON output reports how many were held).

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
