# Design brief — Consolidate crabrunner artifact materialization at the producer boundary

**Date:** 2026-07-05 · **Status:** in-flight design brief (Fork A selected) · feeds `/ce-plan`
**Repos:** crucible (MOB) + symphony-ts (SYMPH)
**Reshapes:** supersedes SYMPH-1050 (retryOnInvalid band-aid); folds in SYMPH-1047 (collect archive path contract) + SYMPH-1048 (collect lifecycle). Aligns with SYMPH-947 (decompose, don't grow).

## Problem / root cause (unowned responsibility at a boundary)

The crucible→symphony artifact-collect boundary is under-specified, so "get a readable artifact" is re-implemented per-caller and keeps attracting band-aids that bloat files.

- Crucible `collect` (`crabrunner/src/host.ts:2322-2355`; `CollectResult` `crabrunner/src/types.ts:159`) returns a **raw `.tar` archive path** — `spawnSync("tar", -cf …)`, **no extraction, no stat/completeness barrier, no documented contract**. Crucible has **zero** tar-extraction anywhere.
- Symphony re-solves "refs → readable artifact" independently in ≥4 files and **hand-parses crucible's tar** (512-byte headers, octal sizes) in ≥4 files, each with a weak `size>0` readiness check: `crabrunner-scheduler-client.ts:1358-1414`, `crabrunner-claude-runner.ts:591-690`, `crabrunner-review-job-group.ts`, `crabrunner-backend.ts`, `spec-fidelity.ts`, `spec-review-watch.ts`.
- Cross-host artifacts aren't guaranteed materialized when a consumer reads them → valid model output is read as empty → rejected `invalid_artifact` → the tier-2 review degrades to no verdict.

**Confirmed (validity2 run, 2026-07-05):** the opus and codex review lanes both *succeeded* and wrote valid `## Verdict`/`## Findings` artifacts on disk, yet `validateClaudeArtifact` (`crabrunner-claude-runner.ts:324`, reading the path materialized at `:591` past the `size>0` gate at `:645`) rejected both as missing headings. Not model-specific, not a format problem — a materialization race against an unowned boundary.

## Decision — Fork A: the producer owns materialization

Crucible's `collect` extracts to a guaranteed-complete local path behind a completeness barrier and returns a **materialized artifact**. Symphony **deletes all hand-tar-parsing + per-caller materialization** and consumes one typed artifact. This is a net-negative-LOC refactor with a single owner — the opposite of a band-aid.

## Target abstraction — `CollectedArtifact` (the seam consumers depend on)

A typed, discriminated value representing a fully-materialized lane result. Consumers depend on **this type**, never on refs/tars/archive internals.

```
type CollectedArtifact =
  | { status: "ready"; jobId; path: string /* guaranteed-complete local */; content: string; hash: string }
  | { status: "missing" | "empty"; jobId; reason: string }
```

- Produced **once** at the collect boundary; the completeness barrier + extraction happen there and nowhere else.
- Validation (`validateClaudeArtifact`) is refactored to take `content: string` (pure, race-free, unit-testable), not a path.

## Module layout — anti-ballooning is a FIRST-CLASS constraint

### Crucible (MOB) — do NOT grow `host.ts` (already ~2300+ LOC)
- **New small module** `crabrunner/src/collect-materialize.ts`: extract the tar → `<stateRoot>/collected/<jobId>/`, apply a stat/size completeness barrier, return the materialized descriptor. `collectJob()` (`host.ts:2322`) calls it in a few lines — extraction logic never inlined into `host.ts`.
- `CollectResult` (`types.ts:159`) gains the materialized artifact fields (path + content/hash).
- **Document the collect artifact contract** in `docs/crabrunner-operator-runbook.md` (today silent).

### Symphony (SYMPH) — net-negative LOC; do NOT grow `crabrunner-scheduler-client.ts` (~1400+ LOC)
- **New small module** `src/stage-execution/collected-artifact.ts`: the `CollectedArtifact` type + `readCollectedArtifact(collectResult)` — the **single** place artifact reading lives. No tar-parsing; just reads crucible's guaranteed path/content.
- `crabrunner-scheduler-client.ts` `collect()` returns `CollectedArtifact` via that module; **DELETE its tar-parsing (`:1358-1414`)**.
- `crabrunner-claude-runner.ts`: **DELETE** `materializeCrabrunnerArtifact` / `extractArtifactFromTar` / `parseTarString` / `isReadableTextArtifact` (`:591-690`, ~100 LOC); consume `CollectedArtifact`.
- Collapse `crabrunner-review-job-group.ts`, `crabrunner-backend.ts`, `spec-fidelity.ts`, `spec-review-watch.ts` onto `readCollectedArtifact`.

## Anti-ballooning guardrails — design these in from day one

1. **One-owner rule.** Extraction/materialization/read exists in **exactly one module per repo** (`collect-materialize.ts`, `collected-artifact.ts`). Every other file depends on the interface.
2. **Guard test (mechanical).** A test that fails if tar-parsing primitives — `parseTarString`, raw 512-byte tar-header reads, `tar -x`, `readFile(*.tar)` — appear **outside** the owning module. This is the tripwire that prevents the exact re-duplication that caused this bug. Add it in the same change.
3. **File-size budget.** Each new module ≤ ~150 LOC. **No touched existing file may grow**; symphony net LOC must be negative; `host.ts` and `crabrunner-scheduler-client.ts` must shrink or hold. Enforce via the diff-coverage/size check in CI where available; otherwise assert in the PR.
4. **Interface-only dependency.** Consumers import `CollectedArtifact` + `readCollectedArtifact` only — never archive/tar internals.
5. **Deletion-first sequencing.** Introduce the seam and delete the duplicates in the same PR so duplication never coexists with the new owner.

## Sequencing (cross-repo)

1. **MOB (crucible):** `collect` returns a materialized artifact + completeness barrier + documented contract + crucible-side guard. Versioned so old consumers still work during rollout.
2. **SYMPH (symphony):** consume `CollectedArtifact`, delete all tar-parsing/materializers, add the symphony guard test. Lands after MOB is available.

## Ticket reshape

- **Supersede SYMPH-1050** (retryOnInvalid) — unnecessary once completeness is guaranteed.
- **Fold SYMPH-1047 + SYMPH-1048** — they point at exactly this boundary; reframe as the real contract, not pin-tests on scattered code.
- **New:** MOB (crucible materialization + contract) → SYMPH (consume + delete duplicates). MOB first.

## Success criteria

- The tier-2 review returns a real `PASS`/`CHANGES_REQUESTED` verdict (not `degraded`) on a re-run of the 2026-07-05 validity check.
- **Symphony net LOC negative; no touched file grows; guard test present and green in both repos.**
- `rg` finds **zero** tar-parsing outside the one owning module in each repo.

## Evidence refs

- validity2 run artifacts + `crabrunner-claude-runner.ts:324/591/645`; crucible `host.ts:2322-2355`, `types.ts:159`, `paths.ts:79`.
- Dogfood runbook: `docs/plans/2026-07-02-manager-plan-dogfood-runbook.md`.
