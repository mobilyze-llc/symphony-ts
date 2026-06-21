# SYMPH-805 Stage Execution Profiles And Simplification Inventory

Date: 2026-06-19

Status after SYMPH-812 (2026-06-21): this document records the stage-profile
migration snapshot before the active CMUX review runtime was removed. The
package bins for `symphony-council-review-gate` and
`symphony-review-runtime-preflight`, the `probe:review-runtime` script, direct
workflow/deploy calls into the local CMUX review runtime, and the
`~/.cmux-spawn` worker sandbox grant are no longer active product-path
requirements. Use
[`docs/operations/03-crabrunner-review-qa.md`](operations/03-crabrunner-review-qa.md)
for the current crabrunner review/QA runbook and holding pattern.

Scope: add behavior-neutral stage execution profiles, run group identity, capsule path contracts, and delegated stage attempt records so later tickets can replace CMUX-specific review execution without preserving old abstractions by accident.

Non-goals: this change does not switch any backend, does not remove CMUX, does not replatform the headless council CLI, and does not change stage workflow semantics.

## Implemented Contract

SYMPH-805 keeps the existing `runner`, `model`, transition, and stage validation paths intact, then adds an optional `execution` block on each stage:

- `role` and `phase` are required, typed values.
- `backend` defaults to `current-runner` and is separate from `runner.kind`, provider, model, and profile metadata.
- `control_needing` marks stages that require the current Codex app-server control surface; config validation rejects one-shot or delegated providers for those stages.
- `artifact_contract.requires` and `artifact_contract.produces` describe required and produced artifact names.
- `timeout_ms`, `budget`, `dependencies`, `run_group`, and `capsules` are parsed into typed config.
- Invalid fields are carried as path-specific `executionValidationErrors` and make stage/dispatch config validation fail.

The domain model now has replay-safe records for:

- `StageRunGroupRecord`
- `DelegatedStageAttemptRecord`
- `StageExecutionArtifactRef`
- `StageExecutionCapsuleRef`
- `DelegatedStageCapsuleReadiness`

Missing required capsule refs become explicit `failed` or `degraded` states through policy, rather than becoming implicit worker behavior.

## Validation Evidence

```bash
pnpm run lint
pnpm exec vitest run tests/config/stages.test.ts tests/config/config-contracts.test.ts tests/domain/model.test.ts
pnpm exec vitest run tests/cli/council-review-gate.test.ts tests/orchestrator/core.test.ts tests/review/headless-council-gate.test.ts tests/review/review-journal-events.test.ts
pnpm run typecheck
pnpm build
pnpm test
```

Required negative checks:

- Removing the routing-guarantee `pass` to `error` downgrade made `tests/review/headless-council-gate.test.ts` fail in `characterizes the review verdict downgrade ladder including routing guarantees`.
- Bypassing `artifactPaths.resultJson` versus marker path equality made `tests/orchestrator/core.test.ts` fail in `parks review completion when review-result artifact spoofs a different canonical path`.

The captured v1 review and merge-candidate journal fixture replays green through `tests/review/review-journal-events.test.ts`.

The required grep inventory was the active CMUX surface finder for this
pre-removal snapshot:

```bash
rg -n "cmux|CMUX|cmux-spawn|CMUX_SPAWN_BIN|symphony-council-review-gate|headless-council|review-runtime-preflight" . --glob '!node_modules/**' --glob '!dist/**' --glob '!coverage/**'
```

## Contract Inventory Summary

| Surface | Classification | Reason |
| --- | --- | --- |
| Stage workflow names, transitions, and existing `runner`/`model` fields | Preserve as contract | These are product workflow concepts and existing config remains behavior-neutral. |
| Stage `execution.role`, `execution.phase`, artifact contract, dependency policy, run group, and capsule paths | Preserve as contract | Later backend tickets need a typed, backend-neutral shape before swapping execution substrate. |
| `execution.backend` | Preserve as contract | It keeps backend selection orthogonal to runner/provider/model/profile metadata. |
| Provider capability matrix | Preserve as contract | `docs/stage-provider-capabilities.md` distinguishes current repo behavior from target/buildable behavior before provider selection changes execution semantics. |
| Path-specific execution validation errors | Preserve as contract | Operators need config errors that point to the exact invalid field before a worker runs. |
| Delegated stage attempt record | Collapse into generic stage execution | It is the canonical model for review rounds, reviewer lanes, retry attempts, job status, usage, artifacts, and capsule readiness. |
| Missing required capsule handling | Preserve as contract | Required evidence must fail or degrade explicitly instead of disappearing into worker prose. |
| Review verdict reducer semantics | Extract as small domain module | SYMPH-809 should reuse current reducer behavior without keeping CMUX invocation. |
| Review artifact validation and marker/path equality | Extract as small domain module | The orchestrator and temporary CLI compatibility both need the same validator until SYMPH-812 deletes the CLI path. |
| Journal builders, replay, and merge-candidate projection | Extract as small domain module | Merge readiness must remain replay-derived under SYMPH-811. |
| Track-finding filing status normalization | Extract as small domain module | Durable filed/unfiled evidence should survive review-domain extraction. |
| `symphony-council-review-gate` active product-stage CLI | Delete outright after parity | It should not be replatformed as the new stage engine; SYMPH-812 owns deletion after generic job groups replace it. |
| `symphony-review-runtime-preflight` and `probe:review-runtime` | Delete outright after parity | They are CMUX-specific readiness commands, not durable stage execution contracts. |
| CMUX lane invocation, preflight, sidecar JSON parsing, and deploy evidence tooling | Delete outright after parity | These are substrate mechanics; keep their behavioral contracts only where listed above. |
| Workflow snippets that shell out to `cmux-spawn` or freshness-assert with the review gate | Delete outright after parity | Active prompts should move to generic stage job groups and artifact contracts under SYMPH-812. |
| `src/claude-runner/cmux-artifact-paths.ts` mirror fallback and SHA checks | Extract as small domain module | Cross-host artifact integrity is not CMUX-specific and must survive. |
| `~/.cmux-spawn` sandbox/lock access | Preserve as contract, then translate | SYMPH-394 established fail-closed lock/admission behavior; the directory name can die after crabrunner parity. |
| Ambient CMUX-era env knobs | Preserve only as compatibility inputs | Current behavior depends on them, but the replacement should map them into explicit stage profile/job config or delete them. |
| `writeResult()` report-before-JSON behavior | Defer pending evidence | Preserve as observed crash profile only; do not design the replacement around a non-atomic write order. |

## CMUX Removal Matrix Summary

| Surface | Current status | Go-forward owner |
| --- | --- | --- |
| `src/review/headless-council-gate.ts` | Active runtime path | SYMPH-809 extracts reducers/policies/artifacts; SYMPH-812 deletes CMUX invocation. |
| `src/cli/council-review-gate.ts` and `symphony-council-review-gate` | Active compatibility CLI | SYMPH-812 removes from active product path after parity. |
| `src/cli/review-runtime-preflight.ts`, `probe:review-runtime` | Active CMUX readiness path | SYMPH-812 deletes or replaces with generic substrate preflight. |
| `pipeline-config/*`, `templates/WORKFLOW-template.md`, `prompts/merge.liquid` | Active workflow docs/prompts | SYMPH-812 rewrites direct CMUX/gate references. |
| `src/claude-runner/cmux-claude-runner.ts`, `src/spec-review/spec-review.ts`, `src/cli/spec-review-watch.ts`, `src/agent/triage-planner.ts`, `src/orchestrator/standing-plan-shadow.ts` | Active or adjacent callers | SYMPH-812 classifies each caller before deletion; runtime callers should collapse into generic stage jobs. |
| `src/claude-runner/cmux-artifact-paths.ts` | Active artifact validator | SYMPH-810 extracts backend-neutral artifact integrity checks. |
| `src/agent/runner.ts` `~/.cmux-spawn` sandbox grant | Active fail-closed lock support | SYMPH-810 translates the invariant to crabrunner/admission locks. |
| CMUX operator docs and deploy tooling | Active operator support | SYMPH-812 removes from active docs after parity. |

## Historical Required Answers

Which review CLIs and preflight commands should disappear rather than be replatformed?

`symphony-council-review-gate`, `symphony-review-runtime-preflight`, and `probe:review-runtime` should disappear from the active product path under SYMPH-812. Keep them only as temporary compatibility while SYMPH-809 through SYMPH-811 move the behavior into job groups, artifact contracts, reducers, and projectors.

Which review behaviors become generic stage job groups, artifact contracts, reducers, or policy hooks?

Reviewer fanout becomes a stage job group. Reviewer markdown, structured findings, reports, and canonical result JSON become artifact contracts. Verdict aggregation, routing guarantees, freshness, merge-candidate readiness, and replay become reducers/projectors. Track-finding filing, degraded substrate evidence, and route-policy acceptance become policy hooks.

Which modules should be extracted before migration versus deleted after parity?

Extract review reducers, review artifact validation, journal builders/projectors, artifact provenance validation, and Track-finding status normalization before migration. Delete CMUX lane invocation, CMUX preflight, CMUX-specific deploy tooling, CMUX docs, and CMUX shell snippets after parity under SYMPH-812.

Which duplicate concepts collapse into the canonical delegated stage attempt model?

Review rounds, reviewer lanes, CMUX workspace/run IDs, retry attempts, reviewer process status, usage reports, artifact paths, and capsule readiness collapse into run groups, delegated stage attempts, job IDs, artifact refs, job telemetry, and replayable journal rows.

Which CMUX-era env flags and defaults still matter?

`CMUX_SPAWN_BIN` matters only as current compatibility. Routing/provenance inputs still matter until extraction: `SYMPHONY_COUNCIL_FORCE_LEGACY`, `SYMPHONY_COUNCIL_FORCE_OPUS`, `SYMPHONY_COUNCIL_REVIEW_ROUTING_MODE`, `SYMPHONY_COUNCIL_ROUTING_MODE`, `SYMPHONY_COUNCIL_ACCEPT_NARROWER_RISK`, `SYMPHONY_COUNCIL_ACCEPT_NARROW_RISK`, `SYMPHONY_COUNCIL_OPERATOR_OVERRIDE_REASON`, and `SYMPHONY_COUNCIL_AUTHOR_FAMILY`. Reviewer execution defaults also still matter: `SYMPHONY_COUNCIL_CLAUDE_MODEL`, `SYMPHONY_COUNCIL_CLAUDE_PROFILE`, `SYMPHONY_COUNCIL_CLAUDE_ALLOWED_TOOLS`, `SYMPHONY_COUNCIL_PI_PROVIDER`, `SYMPHONY_COUNCIL_PI_MODEL`, `SYMPHONY_COUNCIL_PI_THINKING`, `SYMPHONY_COUNCIL_PI_TOOLS`, Kimi shadow toggles/defaults, and Codex excavation toggles/defaults. The replacement should map these into explicit profile/job config or delete them.

Which invariants come from `~/.cmux-spawn`, especially SYMPH-394 fail-closed-on-lock behavior?

The live invariant is that CMUX admission/concurrency lock state under `~/.cmux-spawn` must be writable by review lanes; if lock access fails, review execution fails closed instead of silently running without admission control. Crabrunner does not need the same path, but it must keep visible fail-closed admission behavior.

What mirror fallback, cross-host artifact hash, and provenance behavior must survive?

Remote artifact paths must stay path-contained, same-stem mirror fallback must be fresh from pre-run cleanup, mirror fallback must reject symlink/path escapes and basename mismatches, and remote SHA evidence must match local artifact bytes. Provenance must continue to identify the producing job/lane, host, artifact path, and hash evidence.

What is the current `writeResult()` crash profile for `council-report.md` and `review-result.json`?

`writeResult()` writes `council-report.md` first and `review-result.json` second without an atomic group commit. A crash between writes can leave the human report present while canonical JSON is missing. The orchestrator currently fails closed on missing/unreadable JSON unless a durable canonical candidate from the same round already exists.

## Go-Forward Recommendation

SYMPH-806 is still the right next ticket. It should consume the SYMPH-805 execution profile/run group/capsule types and prove `current-runner` parity behind a backend interface before SYMPH-807 adds crabrunner scheduling.

Keep the existing order for SYMPH-805 through SYMPH-812:

- SYMPH-806: add the backend interface with current-runner parity.
- SYMPH-807: add deterministic crabrunner scheduling.
- SYMPH-808: delegate investigate/plan/implement through phase profiles.
- SYMPH-809: extract review-domain contracts away from CMUX invocation.
- SYMPH-810: add crabrunner review and QA job groups.
- SYMPH-811: project crabrunner state, usage, failures, and replay.
- SYMPH-812: remove active CMUX review runtime, docs, and tests after parity.

The only scope guidance is to keep SYMPH-806 narrow: no review extraction, no CMUX deletion, and no backend switch beyond proving the backend boundary with current-runner behavior.
