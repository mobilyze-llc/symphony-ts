# Symphony-ts Documentation Index

Shallow index of `docs/`. Loaded into every session via `@docs/README.md` in `CLAUDE.md`. Describes the **mandate** of each doc ("what belongs here"), not its current contents — so entries don't drift on every edit.

## Conventions (project-specific)

- **`docs/operations/` uses numbered names** `NN-topic.md` (deliberate override of the default kebab-only shape) so operator runbooks have a stable reading order. `00-` is reserved for a Symphony overview/runbook doc (forthcoming).
- **Operations docs follow `docs/operations/_TEMPLATE.md`** (operations-doc template, currently v1.0). New operations docs copy it.
- **Generated blocks must not drift.** Docs that embed generated output (e.g. a CLI `--help`) wrap it in `<!-- AUTOGEN:* -->` markers synced by `scripts/docs-sync.mjs` (`pnpm docs:sync`) and enforced by a vitest gate under `pnpm test`.
- Evergreen specs: `kebab-case-topic.md`. Point-in-time artifacts: `YYYY-MM-DD-slug.md` (or an issue-prefixed name). Never reuse a filename; supersede by moving the old file to `docs/archive/`.

## Operations (`docs/operations/`)

- `docs/operations/00-*` [RESERVED] — Symphony overview / top-level operator runbook. Not yet written.
- `docs/operations/01-cmux-review-substrate-deploy.md` — Deploy runbook for the (deprecating) CMUX review substrate. Pairs with `ops/cmux-review-substrate-deploy`.
- `docs/operations/02-symphony-manager-plan.md` [CANONICAL] — Canonical usage + deploy doc for the `symphony-manager-plan` one-shot Manager/planner CLI. Usage block auto-synced from `renderUsage()`.
- `docs/operations/03-crabrunner-review-qa.md` [CANONICAL] — Operator runbook for crabrunner-backed Symphony review and QA gates.
- `docs/operations/04-symphony-worktree-reaper.md` [CANONICAL] — Operator runbook for safe stable-root `.worktrees/` and `.claude/worktrees/` cleanup via `ops/symphony-ctl prune-worktrees`.
- `docs/operations/05-deploy.md` [CANONICAL] — Canonical map of the two deploy flows (`symphony-deploy` in-place vs `deploy-train.sh` detached) + the `symphony-ctl` root model and worktree guard. Records the SYMPH-708 decision.
- `docs/operations/_TEMPLATE.md` — The operations-doc template. Source for every numbered operations doc.

## Reference specs (`docs/`)

- `docs/DEV_GUIDE.md` — Developer onboarding/setup reference.
- `docs/WORKFLOW.template.md` — Canonical template for per-product `WORKFLOW.md` configs.
- `docs/stage-provider-capabilities.md` — Source of truth for stage/provider capability matrix.
- `docs/stage-usage-measurement.md` — Source of truth for stage usage/token measurement.
- `docs/conformance-test-matrix.md` — Conformance test coverage matrix.
- `docs/intake-triage-rubric.md` — Evergreen evidence, clustering, lifecycle, disposition, and state-transition contract for Triage intake.

## Point-in-time artifacts

- `docs/plans/` — Execution plans, handoffs, reviews. Date-prefixed. Not maintained after execution.
- `docs/design-briefs/` — Design briefs for in-flight work. Frozen once their work lands.
- `docs/symph-349-investigate-productivity.md`, `docs/symph-804-contract-inventory.md`, `docs/symph-805-stage-execution-profiles.md`, `docs/tokview-symphony-inspection.md`, `docs/council-review-forward-test.md` — Issue/investigation artifacts. Frozen records; not maintained as the system evolves.

## Archive

- `docs/archive/` — Superseded docs. Kept for history. Never delete; never edit.
