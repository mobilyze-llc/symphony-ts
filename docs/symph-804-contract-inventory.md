# SYMPH-804 Contract Inventory And Simplification Recommendations

Date: 2026-06-19

Status after SYMPH-812 (2026-06-21): this is a pre-removal inventory, not
current runtime guidance. The active package bins for
`symphony-council-review-gate` and `symphony-review-runtime-preflight`, the
`probe:review-runtime` script, direct workflow/deploy calls into the local CMUX
review runtime, and the `~/.cmux-spawn` worker sandbox grant have been removed
from the active product path. Use
[`docs/operations/03-crabrunner-review-qa.md`](operations/03-crabrunner-review-qa.md)
for the current crabrunner review/QA runbook and holding pattern. Any
"active" classifications below describe the 2026-06-19 inventory snapshot
unless the row names a backend-neutral contract that still survives.

Scope: characterize the current review/stage contracts, mine the CMUX removal surface, and classify what the SYMPH-805 through SYMPH-812 migration should preserve, delete, collapse, extract, or defer.

Non-goals: this document does not implement the crabrunner backend, does not remove CMUX, and does not preserve old review abstractions just because they exist.

## Sanity Check

Historical characterization suite used for this inventory:

```bash
pnpm exec vitest run tests/cli/council-review-gate.test.ts tests/orchestrator/core.test.ts tests/review/headless-council-gate.test.ts tests/review/review-journal-events.test.ts
```

Run the grep inventory used for the CMUX removal matrix:

```bash
rg -n --glob '!node_modules/**' --glob '!dist/**' --glob '!handoffs/**' "cmux|CMUX|cmux-spawn|CMUX_SPAWN_BIN|symphony-council-review-gate|headless-council|review-runtime-preflight" .
```

Do not treat the result count as a contract. The command was the pre-removal
inventory surface: it found CMUX and review-runtime terms and let the operator
sort active runtime surfaces from historical references.

## Characterization Added

| Coverage | Files | Contract pinned |
| --- | --- | --- |
| Review verdict downgrade ladder | `tests/review/headless-council-gate.test.ts` | `pass`, `fail`, and `error` from `aggregateHeadlessVerdict()`, plus the routing-guarantee `pass` to `error` downgrade outside the aggregate reducer. |
| CLI verdict exit/status | `tests/cli/council-review-gate.test.ts` | `symphony-council-review-gate` exits `0` only for review `pass`, exits `1` for review `fail` and `error`, and writes the JSON result to stdout. |
| Orchestrator review-result validator | `tests/orchestrator/core.test.ts` | A review worker must emit `[REVIEW_GATE_RESULT_PATH: ...]`; the orchestrator reads `review-result.json`, validates merge eligibility, validates `artifactPaths.resultJson`, and rejects a path-equality spoof before merge readiness. |
| Captured v1 journal replay | `tests/review/review-journal-events.test.ts`, `tests/fixtures/review/v1-review-merge-candidate-journal.jsonl` | Existing v1 `review_round`, `review_gate_result`, and `merge_candidate` rows replay green and reduce to the current merge-candidate record shape. |

## Contract Inventory

| Contract / invariant | Evidence | Owner | Downstream impact | Classification |
| --- | --- | --- | --- | --- |
| Symphony owns stage state, journal replay, and merge readiness; review workers supply artifacts, not merge decisions. | `src/orchestrator/core.ts` (`prepareReviewCompletionForMerge`); `src/orchestrator/merge-candidate.ts` (`buildMergeCandidateEntryFromReviewGate`, `reduceMergeCandidates`) | SYMPH-805, SYMPH-811 | Stage backends can change only behind the same journal-derived readiness model. | Preserve as contract |
| Authoritative review verdict order is `error` if no authoritative lane, `error` if any authoritative lane errors, `fail` if any authoritative lane fails, otherwise `pass`. | `src/review/headless-council-gate.ts` (`aggregateHeadlessVerdict`) | SYMPH-809 | Review-domain extraction must keep the same reducer semantics. | Extract as small domain module |
| Routing guarantees can downgrade an aggregate `pass` to `error` outside the aggregate verdict reducer. | `src/review/headless-council-gate.ts` (`collectRoutingGuaranteeDegradedConditions`, call-site verdict downgrade); characterized in `tests/review/headless-council-gate.test.ts` | SYMPH-809, SYMPH-810 | A clean reviewer artifact cannot merge unless author provenance and decorrelated reviewer proof are present. | Preserve as contract |
| CLI exit/status is a compatibility contract: review `pass` returns `0`; review `fail` and review `error` return `1`; freshness assertion `stale_review` returns `1`, invalid artifacts return `2`. | `src/cli/council-review-gate.ts` (`runCouncilReviewGateCli`); characterized in `tests/cli/council-review-gate.test.ts` | SYMPH-809, SYMPH-812 | Shell workflow templates and product review stages depend on these exit codes until the CLI disappears from the active path. | Preserve until deleted under SYMPH-812 |
| Orchestrator merge readiness requires both a marker and a validated canonical `review-result.json`. | `src/orchestrator/core.ts` (`REVIEW_GATE_RESULT_PATH_PREFIX`, `extractReviewGateResultPath`, `readAndValidateReviewGateArtifact`) | SYMPH-811 | Worker stdout alone is not authoritative; merge readiness is gated by disk artifact validation. | Preserve as contract |
| `artifactPaths.resultJson` must resolve to the same path as the marker. | `src/orchestrator/core.ts` (`readAndValidateReviewGateArtifact`); characterized in `tests/orchestrator/core.test.ts` | SYMPH-811 | Prevents a worker from pointing the dispatcher at one file while the artifact self-certifies another. | Preserve as contract |
| Passing review artifacts append `review_gate_result` and may produce `merge_candidate`; reducer chooses canonical candidate from journal replay. | `src/review/review-journal-events.ts` (`buildReviewJournalEntries`); `src/orchestrator/merge-candidate.ts` (`buildMergeCandidateEntryFromReviewGate`, `reduceMergeCandidates`) | SYMPH-811 | Merge readiness must remain replay-derived, not process-local. | Preserve as contract |
| Captured v1 review/merge-candidate journal rows remain readable. | `tests/fixtures/review/v1-review-merge-candidate-journal.jsonl` | SYMPH-811 | Schema-version enforcement or migration must not silently strand current journals. | Preserve as compatibility fixture |
| Track-finding filing is autonomous, best-effort, journaled, and must not block merge advance when tracker filing fails. | `src/orchestrator/track-finding-filing.ts`; `src/orchestrator/core.ts` (`fileTrackFindingsBestEffort`) | SYMPH-809, SYMPH-811 | Review-domain extraction must keep durable Track IDs when available and explicit unfiled evidence when not. | Extract as small domain module |
| `~/.cmux-spawn` lock/state access is required for in-pipeline review lanes today; sandbox denial makes CMUX lanes EPERM and the gate fails closed. | `src/agent/runner.ts` (`resolveCmuxSpawnStateRoot`, `augmentWorkspaceWriteSandbox`); `tests/agent/runner.test.ts` | SYMPH-810, SYMPH-812 | Crabrunner replacement must keep fail-closed admission/concurrency behavior rather than losing the lock failure signal. | Preserve as contract, then translate |
| Mirror fallback is a provenance and artifact-integrity contract, not a CMUX-specific shape. | `src/claude-runner/cmux-artifact-paths.ts` (`removeStaleCmuxMirror`, `resolveCmuxArtifactPath`, `validateRemoteArtifactSha256`) | SYMPH-810, SYMPH-812 | Cross-host artifacts must remain freshness-checked, path-contained, and hash-verified after CMUX. | Extract as artifact contract |
| CMUX-era env flags and defaults currently affect behavior: `CMUX_SPAWN_BIN`, routing/force/override flags, author-family provenance, Claude/Pi reviewer model and tool overrides, Kimi shadow toggles/defaults, and Codex excavation toggles/defaults. | `src/review/headless-council-gate.ts` (`runHeadlessCouncilGate`, `buildCouncilRouting`, reviewer config builders); `pipeline-config/WORKFLOW-staged.md`; package bins/scripts in `package.json` | SYMPH-809, SYMPH-812 | Migration must explicitly map or delete each knob; ad hoc env drift must not become the new stage API. | Preserve only as compatibility inputs |
| `writeResult()` currently writes `council-report.md` before `review-result.json` with no atomic barrier. | `src/review/headless-council-gate.ts` (`writeResult`) | SYMPH-809, SYMPH-812 | A crash can leave a human report without canonical JSON; the orchestrator currently fails closed on missing/unreadable JSON unless a durable canonical candidate already exists. | Preserve as observed crash profile, not desired design |

## CMUX Removal Matrix

| Surface | Category | Evidence | Classification | Owner |
| --- | --- | --- | --- | --- |
| `src/review/headless-council-gate.ts` lane spawning, preflight, artifact parsing, routing, reducers, report/result writer | Active runtime dependency | Review stage invokes this path; package bins in `package.json`; review setup in `docs/DEV_GUIDE.md` | Extract reducer/policy/artifact contracts; delete CMUX invocation path after parity | SYMPH-809, SYMPH-810, SYMPH-812 |
| `src/cli/council-review-gate.ts` and `symphony-council-review-gate` bin | Active runtime dependency | package bin in `package.json`; workflow prompts call the bin; CLI exit tests | Disappear from active product path rather than be replatformed; keep temporary compatibility until SYMPH-812 | SYMPH-812 |
| `src/cli/review-runtime-preflight.ts`, `probe:review-runtime`, deploy smoke | Active runtime dependency | package bin/script in `package.json`; review setup in `docs/DEV_GUIDE.md`; `ops/symphony-deploy` | Delete or replace with generic stage substrate preflight after stage backend parity | SYMPH-812 |
| `pipeline-config/WORKFLOW.md`, `WORKFLOW-staged.md`, `WORKFLOW-instrumentation.md`, `templates/WORKFLOW-template.md`, `prompts/merge.liquid` | Active workflow prompt/runtime docs | grep inventory shows direct CMUX/gate snippets and freshness assertion commands | Rewrite to generic stage job groups and artifact contracts; remove direct CMUX language | SYMPH-805, SYMPH-812 |
| `src/claude-runner/cmux-claude-runner.ts`, `src/cli/claude-runner.ts`, `src/spec-review/spec-review.ts`, `src/cli/spec-review-watch.ts`, `src/agent/triage-planner.ts`, `src/orchestrator/standing-plan-shadow.ts` | Active or adjacent runtime dependency | grep inventory and imports from `cmux-claude-runner.js` | Do not preserve because they exist; classify each caller before deletion. Runtime planner/review callers collapse into generic stage job groups; standalone skills remain historical/shared tooling unless active runtime still calls them. | SYMPH-805, SYMPH-812 |
| `src/claude-runner/cmux-artifact-paths.ts` | Active compatibility/artifact validator | Mirror fallback and SHA validation | Extract artifact contract before backend migration | SYMPH-810 |
| `src/agent/runner.ts` sandbox grant for `~/.cmux-spawn` | Active runtime dependency | SYMPH-394 comments and tests | Translate to crabrunner/admission lock contract; delete CMUX-specific root after no active CMUX lanes remain | SYMPH-810, SYMPH-812 |
| `docs/DEV_GUIDE.md`, `README.md`, `docs/operations/01-cmux-review-substrate-deploy.md`, `ops/cmux-review-substrate-deploy`, `ops/com.symphony.example.plist` | Active operator docs and deploy tooling | grep inventory | Rewrite active setup docs under SYMPH-812; keep deploy runbook only as historical evidence once CMUX exits | SYMPH-812 |
| Tests under `tests/review`, `tests/cli`, `tests/orchestrator`, `tests/claude-runner`, `tests/ops`, `tests/skills` | Historical tests plus active compatibility checks | grep inventory | Keep characterization and compatibility tests; delete tests that only assert removed CLI/doc surfaces when SYMPH-812 deletes those surfaces | SYMPH-809, SYMPH-812 |
| `tests/fixtures/review/v1-review-merge-candidate-journal.jsonl` | Compatibility fixture | Added by SYMPH-804 | Preserve as replay oracle | SYMPH-811 |
| `skills/council-review`, `skills/claude-runner`, `skills/spec-review-lane` | Agent workflow docs/tools | grep inventory | Historical/shared tooling unless runtime still depends on it; do not replatform into Symphony stage engine unless an active caller requires it | SYMPH-812 |

## Simplification Inventory

### Preserve As Contract

Preserve these because downstream correctness depends on them, not because the old system had them:

- Review verdict reducer semantics, including routing-guarantee downgrade outside the aggregate function.
- Marker-plus-artifact validator before merge readiness, including marker handling, JSON validation, merge eligibility, and path equality.
- Journal-derived `review_gate_result` and `merge_candidate` replay.
- Track-finding filing evidence and explicit unfiled statuses.
- Cross-host artifact containment, freshness, SHA, and provenance behavior.
- Fail-closed admission/concurrency behavior currently represented by `~/.cmux-spawn` locks.

### Delete Outright

Delete these from the active product path under SYMPH-812 after parity is proven:

- `symphony-council-review-gate` as a product-stage command.
- `symphony-review-runtime-preflight` and `probe:review-runtime` as CMUX-specific readiness commands.
- Workflow prompt snippets that shell out to `cmux-spawn` or freshness-assert with the review gate.
- CMUX lane invocation, preflight, and sidecar parsing code once generic stage jobs own reviewer execution.
- CMUX-specific deploy evidence tooling after it is no longer an active operator path.

### Collapse Into Generic Stage Execution

Collapse duplicate concepts into the canonical delegated stage attempt model:

- Review round, reviewer lane attempt, CMUX run id, stage retry, reviewer job status, and usage rows become `run_group_id`, `stage_attempt`, `job_id`, artifact refs, and job telemetry.
- Reviewer fanout becomes a stage job group.
- `review-result.json`, structured artifacts, and QA evidence become artifact contracts.
- Verdict and routing reducers become reducers over stage job artifacts.
- Freshness and merge-candidate readiness become journal/projector reducers.
- Degraded evidence and Track-finding policy become stage policy hooks.

### Extract As Small Domain Modules

Extract before migration:

- Review verdict/routing reducer module.
- Review artifact validator module shared by CLI compatibility and orchestrator ingestion.
- Journal event builders and replay/projector helpers.
- Artifact provenance/freshness/hash validator independent of CMUX path names.
- Track-finding filing normalization and status builder.

### Defer Pending Evidence

Defer only to existing Linear issues:

- SYMPH-805 decides the exact delegated stage profile/run group/capsule config shape.
- SYMPH-806 proves current-runner lifecycle parity behind the backend interface.
- SYMPH-807 adds the deterministic crabrunner backend.
- SYMPH-808 moves front-half delegation while keeping rework orchestrator-owned.
- SYMPH-809 extracts review-domain contracts away from CMUX invocation.
- SYMPH-810 runs crabrunner review/QA job groups and proves authoritative-lane fail-closed behavior.
- SYMPH-811 hardens state projection, usage, failure, replay, schema-version, and validator lockstep.
- SYMPH-812 deletes CMUX surfaces after parity and updates active docs/templates.

## Historical Required Answers

Which review CLIs and preflight commands should disappear rather than be replatformed?

`symphony-council-review-gate`, `symphony-review-runtime-preflight`, and `probe:review-runtime` should disappear from the active product path under SYMPH-812. Keep them only as temporary compatibility until generic stage job groups, artifact contracts, and projectors own the behavior. `claude-runner`, `symphony-spec-review-watch`, and `symphony-kimi-council-replay` should not be replatformed as Symphony stage engine entrypoints unless SYMPH-812 finds an active runtime caller that still needs them.

Which review behaviors become generic stage job groups, artifact contracts, reducers, or policy hooks?

Reviewer fanout becomes a stage job group. Reviewer markdown, structured findings, reports, and `review-result.json` become artifact contracts. Verdict aggregation, routing guarantees, merge-candidate projection, freshness, and spec-fidelity holds become reducers/projectors. Track-finding filing, degraded evidence, and route-policy acceptance become policy hooks.

Which modules should be extracted before migration versus deleted after parity?

Extract review reducers, review artifact validation, journal builders/projectors, artifact provenance validation, and Track-finding status normalization before migration. Delete CMUX lane invocation, CMUX preflight, CMUX-specific deploy/docs, and CMUX shell snippets after parity under SYMPH-812.

Which duplicate concepts collapse into the canonical delegated stage attempt model?

Review rounds, reviewer lanes, CMUX workspace/run IDs, retry attempts, reviewer process status, and usage reports collapse into stage attempts, job groups, job IDs, artifact refs, job telemetry, and replayable journal rows.

Which CMUX-era env flags and defaults still matter?

`CMUX_SPAWN_BIN` matters only as current compatibility. Review routing and provenance inputs still matter until extracted: `SYMPHONY_COUNCIL_FORCE_LEGACY`, `SYMPHONY_COUNCIL_FORCE_OPUS`, `SYMPHONY_COUNCIL_REVIEW_ROUTING_MODE`, `SYMPHONY_COUNCIL_ROUTING_MODE`, `SYMPHONY_COUNCIL_ACCEPT_NARROWER_RISK`, `SYMPHONY_COUNCIL_ACCEPT_NARROW_RISK`, `SYMPHONY_COUNCIL_OPERATOR_OVERRIDE_REASON`, and `SYMPHONY_COUNCIL_AUTHOR_FAMILY`. Reviewer execution defaults also still matter: `SYMPHONY_COUNCIL_CLAUDE_MODEL`, `SYMPHONY_COUNCIL_CLAUDE_PROFILE`, `SYMPHONY_COUNCIL_CLAUDE_ALLOWED_TOOLS`, `SYMPHONY_COUNCIL_PI_PROVIDER`, `SYMPHONY_COUNCIL_PI_MODEL`, `SYMPHONY_COUNCIL_PI_THINKING`, `SYMPHONY_COUNCIL_PI_TOOLS`, Kimi shadow toggles/defaults, and Codex excavation toggles/defaults. The replacement should map these to explicit stage profile/job config or delete them; it should not preserve ambient env reads as the new architecture.

Which invariants come from `~/.cmux-spawn`, especially SYMPH-394 fail-closed-on-lock behavior?

The current invariant is that CMUX concurrency/admission locks live under `~/.cmux-spawn/locks/`, and the Codex sandbox grants that root so review lanes do not EPERM and fail closed. The replacement must keep the admission failure visible and fail closed; it does not need to keep the directory name after CMUX is gone.

What mirror fallback, cross-host artifact hash, and provenance behavior must survive?

A remote artifact path must stay path-contained, same-stem mirror fallback must be fresh from pre-run cleanup, mirror fallback must reject symlink/path escapes and remote basename mismatch, and a supplied remote SHA must match the local artifact bytes. These are artifact-integrity contracts and should survive independent of CMUX.

What is the current `writeResult()` crash profile for `council-report.md` and `review-result.json`?

`writeResult()` writes `council-report.md` first and `review-result.json` second, with no atomic group commit. A crash between writes can leave the human report present but the canonical JSON missing. The orchestrator currently treats missing/unreadable JSON as fail-closed unless a durable canonical merge candidate from the same round already exists.

## Go-Forward Recommendation

SYMPH-805 remains the right next primary ticket. Keep SYMPH-805 behavior-neutral: introduce delegated stage profiles, run groups, and capsules without changing review semantics or execution backend. SYMPH-809 can start after this inventory if review-domain extraction capacity is available, but it must consume the SYMPH-804 characterization tests and should not remove CMUX invocation. SYMPH-811 must keep the v1 replay fixture and validator/path-equality lockstep green. SYMPH-812 should remain the deletion ticket after parity evidence from SYMPH-806 through SYMPH-811.
