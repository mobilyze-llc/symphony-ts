---
title: "Design: a single planner-output validation boundary (retire the canary/structure guard ratchet)"
status: design
date: 2026-06-28
type: design
issue: SYMPH-946
related: [SYMPH-784, SYMPH-787, SYMPH-826, SYMPH-836, SYMPH-918, SYMPH-920, SYMPH-944, SYMPH-815, SYMPH-801]
supersedes: [SYMPH-944]
---

# Design: a single planner-output validation boundary

**Issue:** SYMPH-946 · **Scope:** design only, **no production code changes in this ticket.** The only
artifact is this brief. Implementation is filed as a separate tracker issue (see *Follow-up* at the end).

---

## 1. Problem and premise check

The Manager's Opus@max planner emits LLM output that is parsed into a typed `PlanBatch[]` and journaled as a
standing-plan revision. Today the *same structural invariants* — chiefly "a `canary-chain` batch carries a
non-empty head whose head+contingent identifiers are all batch members" — are enforced **three times, in three
hand-maintained implementations, at three different layers**:

1. **Write edge** (model → domain) in [`src/agent/triage-planner.ts`](../../src/agent/triage-planner.ts) —
   `parsePlannerOutput` + `buildPlanBody` normalize and validate the raw model output.
2. **Read edge** (journal → domain) in [`src/domain/standing-plan.ts`](../../src/domain/standing-plan.ts) —
   `isPlanBatch` **re-derives the same canary invariant by hand** to drop corrupt journal rows on projection.
3. **Consumer edge** (domain → dispatch) in
   [`src/orchestrator/standing-plan-consumer.ts`](../../src/orchestrator/standing-plan-consumer.ts) —
   `selectDispatchableBatchMembers` **re-checks the same structure again** with defensive holds.

Each new failure mode has historically bolted another defensive check onto whichever layer noticed it
(SYMPH-826 extraction, SYMPH-836 canary tolerance, SYMPH-918 retry, and the council-surfaced read/consumer
re-checks). That is the *guard ratchet* the ticket names: the defensive surface keeps growing because there is
no single edge that, once crossed, lets every downstream consumer **trust** the value.

### Two premise corrections (surfaced from the code; they change the disposition table)

The ticket frames this as "consumers defend against planner output individually" and lists **numbered guards
#2–#5 in `standing-plan-consumer.ts`** as part of that surface. Reading the code, that attribution is
**partially wrong**, and the design is stronger for saying so:

- **Guards #1–#5 in `standing-plan-consumer.ts` are re-plan *trigger predicates*, not output-validation guards.**
  They live in `evaluateReplanPredicates` and answer "has the *world* drifted out from under an
  already-valid plan?" — envelope changed (#1), no planned member is still a candidate (#2), new work outranks
  the plan by a priority band (#3), enough merges landed that the base moved (#4), a canary head is stuck (#5).
  None of them re-parse or re-validate the *shape* of model output. **A planner-output validation boundary
  cannot subsume them**, because they are triggered by external state changes (merges, new candidates, Governor
  clamps), not by output validity. Their honest disposition is **kept** (§4). The *real* per-call output
  defenses in this file are the **canary-structure holds** at lines 102–105 and 125–129 — those are what the
  boundary retires.
- **The actual planner-output-stabilization lineage is SYMPH-826 / SYMPH-836 / SYMPH-918**, plus the
  read-side `isPlanBatch` and the consumer holds. The ticket's `SYMPH-613 ("stabilize planner output")` is a
  **mis-reference** — SYMPH-613 is "Repoint mobile dashboard report-server pro16 → pro14" (Done) and has
  nothing to do with the planner. SYMPH-920 is now a *regression test*
  ([`tests/no-nul-bytes.test.ts`](../../tests/no-nul-bytes.test.ts)); its original NUL-delimiter dedup key was
  replaced by a `JSON.stringify` key (see G-W9). **SYMPH-944 is already `Cancelled`** (declined as "safe by
  construction"); this design retroactively satisfies its intent (§5).

So the precise problem is narrower and sharper than "retire guards #2–5": **collapse the triple-enforced
structural-validity surface (write + read + consumer) into one validator, and let the re-plan predicates and
the transient-retry stay as the orthogonal concerns they actually are.**

---

## 2. AC1 — Inventory of every defensive guard / normalization on planner output

Grouped by trust edge. `✔ invariant` marks code that (re-)derives the canary/structure validity rule; those are
the duplication the boundary removes. `↻ parse/normalize` marks genuine input-coercion (kept, but single-homed).
`⊘ orthogonal` marks defenses that are not about output *validity* (kept as-is).

### Edge 1 — Write (model output → typed `PlanBody`), `src/agent/triage-planner.ts`

| ID | What | Location | Class |
|----|------|----------|-------|
| G-W1 | `extractPlannerJson` — fenced → trimmed-whole → largest-balanced parseable (SYMPH-826) | `triage-planner.ts:866-900` | ↻ parse |
| G-W2 | `JSON.parse` try/catch → structured `{ok:false,reason}` | `triage-planner.ts:559-567` | ↻ parse |
| G-W3 | `normalizeRawPlanCanaries` / `coerceRawCanary` / `toIdentifierArray` — tolerate aliased/garbage `canary` per-batch (SYMPH-836) | `triage-planner.ts:589-634` | ↻ normalize |
| G-W4 | `PLANNER_OUTPUT_SCHEMA` (Zod): `mode∈PLAN_BATCH_MODES`, `issueIdentifiers.min(1)`, `canary.headIssueIdentifiers.min(1)` | `triage-planner.ts:139-168`, `:568-576` | ✔ invariant |
| G-W5 | `buildPlanBody` member resolution: resolve identifiers → backlog, drop unknowns, drop empty batch | `triage-planner.ts:653-664` | ↻ normalize |
| G-W6 | `normalizeCanary` — restrict head/contingent to members; **null when no head survives** | `triage-planner.ts:668`, `:952-972` | ✔ invariant |
| G-W7 | canary-chain with null canary → **downgrade to parallel-isolated** | `triage-planner.ts:673-676` | ↻ normalize |
| G-W8 | post-downgrade **envelope re-check** — drop a final mode outside the envelope | `triage-planner.ts:681-683` | ↻ normalize |
| G-W9 | `resolvePlanDependencyEdges` — union(blockedBy, canary head→contingent, soft deps), **dedup** (`JSON.stringify` key, ex-SYMPH-920 NUL), drop self/out-of-set/cycle-closing edges | `triage-planner.ts:726-786` (dedup key `:749`) | ↻ normalize |
| G-W10 | `runTriagePlanner` **bounded single retry** (≤2 attempts) on `invalid` only; `attempts` surfaced (SYMPH-918) | `triage-planner.ts:842-863` | ⊘ orthogonal (transient model-call recovery) |

### Edge 2 — Read (journal row → projected `StandingPlan`), `src/domain/standing-plan.ts` + journal reader

| ID | What | Location | Class |
|----|------|----------|-------|
| G-R1 | `isStandingPlanJournalEntry` — top-level row shape + kind enum | `standing-plan.ts:465-493` | ✔ invariant (shape) |
| G-R2 | `isPlanRevision` — revision fields + `batches.every(isPlanBatch)` | `standing-plan.ts:495-511` | ✔ invariant |
| G-R3 | `isPlanEnvelope` — deep envelope validation | `standing-plan.ts:516-527` | ✔ invariant |
| **G-R4** | **`isPlanBatch` — re-derives the canary invariant by hand**: null-canary drop for `canary-chain` (`:541-546`), non-empty head + head/contingent ⊆ members (`:551-568`) | `standing-plan.ts:529-569` | ✔ invariant **(prime duplication — mirrors G-W4/G-W6)** |
| G-R5 | `isPlanBatchMember` / `isPlanCanaryStructure` / `isPlanOptionLine` / `isPlanDecision` / `isPlanOutcome` | `standing-plan.ts:571-631` | ✔ invariant (shape) |
| G-R6 | journal read filter — drops any row failing G-R1 | [`standing-plan-journal.ts:85-92`](../../src/logging/standing-plan-journal.ts) | ↻ apply |

> The write path (`recordPlanRevision`, [`standing-plan-store.ts:96-132`](../../src/orchestrator/standing-plan-store.ts))
> does **not** validate — it trusts `buildPlanBody`'s output. Validity is asserted on the write edge and then
> **re-asserted from scratch** on every read. That asymmetry is the core of the ratchet.

### Edge 3 — Consumer (projected plan → dispatch), `src/orchestrator/standing-plan-consumer.ts`

| ID | What | Location | Class |
|----|------|----------|-------|
| **G-C1** | `selectDispatchableBatchMembers` — **HOLD** a `canary-chain` batch whose `canary === null` (re-checks G-W6/G-W7/G-R4) | `standing-plan-consumer.ts:102-105` | ✔ invariant (per-call defense) |
| **G-C2** | `headValidated` — **empty-head guard** `canary.headIssueIdentifiers.length > 0 &&` before contingent-release (re-checks the non-empty-head invariant) | `standing-plan-consumer.ts:125-129` | ✔ invariant (per-call defense) |
| G-C3 | running/merged re-dispatch exclusion | `standing-plan-consumer.ts:137-145` | ⊘ orthogonal (runtime de-dup, not output validity) |

### Edge 3b — Re-plan trigger predicates (the ticket's "guards #2–5"), same file — **NOT output validation**

| ID | What | Location | Class |
|----|------|----------|-------|
| RP#1 | envelope version changed | `standing-plan-consumer.ts:218-223` | ⊘ world-drift |
| RP#2 | no lookahead member still an eligible candidate | `standing-plan-consumer.ts:225-239` | ⊘ world-drift |
| RP#3 | new work outranks the plan by a priority band (SYMPH-801) | `standing-plan-consumer.ts:241-275` | ⊘ world-drift |
| RP#4 | merge moved the world (≥ threshold merges since plan, SYMPH-801) | `standing-plan-consumer.ts:277-288` | ⊘ world-drift |
| RP#5 | canary head stuck (SYMPH-815) — **leans on the non-empty-head invariant**; this is the dependency SYMPH-944 documented | `standing-plan-consumer.ts:290-320` | ⊘ world-drift (with an implicit output-invariant dependency) |

**The duplication to remove** is everything marked `✔ invariant`: G-W4 + G-W6 (write), G-R4 (read), G-C1 + G-C2
(consumer) — three independent implementations of one rule. Everything `↻` is legitimate input-coercion that
*belongs* inside the boundary; everything `⊘` is orthogonal and stays.

---

## 3. AC2 — The single validation/normalization boundary

> **One canonical `PlanBatch` validator is the sole definition of "valid `PlanBatch`". It is consumed at BOTH
> trust transitions (model→domain and journal→domain). Once a value has crossed it, the type proves its
> invariants, so the consumer drops every per-call guard.**

### 3.1 Shape

Create one domain module — `src/domain/plan-batch.ts` — that owns validity in exactly one place:

```text
src/domain/plan-batch.ts
  ├─ PlanBatchSchema           // ONE Zod schema = the full invariant set:
  │                            //   mode ∈ PLAN_BATCH_MODES
  │                            //   members.min(1), each {issueId, issueIdentifier}
  │                            //   canary:  canary-chain ⟹ non-empty head ∧ head∪contingent ⊆ members
  │                            //            every other mode ⟹ canary === null
  ├─ normalizePlanBatch(rawBatch, members)  // the ONE normalizer (today's normalizeCanary + downgrade live here)
  │      → { ok: true, batch } | { ok: false, rejection }
  └─ type ValidatedPlanBody = PlanBody & { readonly __planBatchValidated: unique symbol }
         // a brand minted ONLY by the boundary constructor; recordPlanRevision accepts only this brand
```

Two thin public entry points, both delegating to `PlanBatchSchema` / `normalizePlanBatch`:

- **`parsePlannerOutputToPlan(markdown, context): { ok: true; body: ValidatedPlanBody } | { ok: false; rejection: PlanRejection }`**
  — the write edge. Keeps its tolerant **parse/normalize front-half** (G-W1, G-W2, G-W3, G-W5, G-W7, G-W8, G-W9
  — extraction, alias coercion, member resolution, downgrade, dep-edge resolution) because turning prose-wrapped
  model output into candidate structures is *real* normalization ("parse, don't validate"). Its **validate
  half** (G-W4 schema + G-W6 canary rule) becomes a single `PlanBatchSchema` / `normalizePlanBatch` call.
- **`parseJournalPlanBatch(value): batch | null`** — the read edge. `isPlanRevision` calls this instead of the
  hand-written `isPlanBatch`. Same schema, same rule, **one implementation**.

### 3.2 Structured rejection, not throw

The boundary returns a typed `PlanRejection { code: "unparseable" | "schema" | "no-valid-batch"; detail }`
rather than throwing, so existing graceful degradation is preserved verbatim:

- `runShadowPlanCycle` ([`standing-plan-shadow.ts:378-389`](../../src/orchestrator/standing-plan-shadow.ts))
  keeps logging `queue_triage_planner_invalid` and returning `{status:"invalid"}` → dispatch keeps using the
  comparator.
- `manager-plan.ts:351` keeps its `status === "invalid"` branch.
- The SYMPH-918 retry (G-W10) wraps the boundary unchanged — it retries on `rejection.code` exactly as it
  retries on today's `{ok:false}`.

### 3.3 Why this is "one boundary every consumer can trust"

- **Single source of truth for validity.** The canary invariant, the mode enum, the non-empty-member rule exist
  in `PlanBatchSchema` only. A future failure mode is fixed *once*, in the schema, and is automatically enforced
  at both edges — the ratchet can't re-form.
- **The brand makes "trusted" checkable by the compiler.** `recordPlanRevision(body: ValidatedPlanBody, …)`
  cannot be called with an unvalidated body; the journal can only contain boundary-minted batches.
- **The consumer stops re-validating.** Because every projected plan came through `parseJournalPlanBatch`, the
  consumer's G-C1/G-C2 become provably dead. They are replaced (not just deleted) by **one** invariant-assert at
  the consumer entry (§4) — fail-loud-once instead of silent-defend-everywhere.

### 3.4 What this is *not*

It does not move re-plan intelligence or world-drift detection into the boundary (those stay in the consumer; see
the project's scope-boundary rule). It does not add a queue/Redis. It does not touch the dispatch hot path's zero-
LLM guarantee — the boundary is pure and synchronous.

---

## 4. AC3 — Disposition of each guard under the new boundary

Dispositions: **SUBSUMED** (folded into the single validator), **DELETED** (removed; the boundary makes it
provably unnecessary), **KEPT-ASSERT** (replaced by one invariant assertion), **KEPT** (orthogonal, unchanged).

| Guard | Disposition | Specific code that changes |
|-------|-------------|----------------------------|
| G-W1 extraction (826) | **KEPT** (boundary parse-half) | unchanged; moves under `parsePlannerOutputToPlan` |
| G-W2 JSON.parse | **KEPT** (boundary parse-half) | unchanged |
| G-W3 canary alias coercion (836) | **KEPT** (boundary normalize-half) | unchanged |
| G-W4 `PLANNER_OUTPUT_SCHEMA` batch shape | **SUBSUMED** | the per-batch object shape + `canary.head.min(1)` move into `PlanBatchSchema`; the standalone schema keeps only the top-level `{rationale, batches, dependencies}` envelope |
| G-W5 member resolution | **KEPT** (boundary normalize) | unchanged |
| G-W6 `normalizeCanary` | **SUBSUMED** | body folds into `normalizePlanBatch` in `plan-batch.ts`; `triage-planner.ts:952-972` deleted, call-site `:668` retargeted |
| G-W7 downgrade | **KEPT** (boundary normalize) | unchanged; lives beside `normalizePlanBatch` |
| G-W8 envelope re-check | **KEPT** (boundary normalize) | unchanged |
| G-W9 dep-edge dedup (ex-920) | **KEPT** (boundary normalize) | unchanged |
| G-W10 retry (918) | **KEPT** (orthogonal) | unchanged; wraps the boundary |
| **G-R4 `isPlanBatch` canary re-check** | **DELETED + replaced** | **`standing-plan.ts:541-568` removed**; `isPlanRevision` (`:505`) calls `parseJournalPlanBatch` |
| G-R1/R2/R3/R5 shape guards | **SUBSUMED** (single-sourced) | bespoke per-field guards collapse into `PlanBatchSchema` / one journal-entry schema; the hand-written predicate functions shrink to schema calls |
| G-R6 journal filter | **KEPT** | unchanged (still drops rows the schema rejects) |
| **G-C1 canary===null hold** | **DELETED** | **`standing-plan-consumer.ts:102-105` removed** (provably dead: a projected `canary-chain` batch has a valid canary) |
| **G-C2 empty-head check** | **DELETED** | **`standing-plan-consumer.ts:125-129` simplified** — drop `headIssueIdentifiers.length > 0 &&` (invariant guarantees it) |
| *(new)* consumer invariant-assert | **KEPT-ASSERT** (one) | add `assertProjectedPlanValid(plan)` at `selectDispatchableBatchMembers`/`decidePlanDrivenDispatch` entry — one cheap structural assert that logs-and-degrades if ever violated. **Documents the invariant RP#5 and SYMPH-944 lean on, in one place.** |
| G-C3 running/merged exclusion | **KEPT** (orthogonal) | unchanged |
| RP#1–#4 re-plan predicates | **KEPT** (out of scope — world-drift) | unchanged |
| RP#5 canary-head-stuck | **KEPT** | unchanged; its implicit non-empty-head dependency is now *explicit* via the consumer invariant-assert |

**Net production removal:** `standing-plan.ts:541-568` (hand re-derived canary invariant), `normalizeCanary` at
`triage-planner.ts:952-972` (folded), `standing-plan-consumer.ts:102-105` (dead hold), and the `length > 0`
clause at `standing-plan-consumer.ts:125-129` — three of the four `✔ invariant` re-implementations gone, the
fourth (write schema) becomes the single source, and the scattered consumer defense collapses to one assert.

---

## 5. AC4 — Migration order + back-compat (shadow-validate before cutover)

**Hard constraint:** the standing-plan journal is durable and append-only; live rows on pro14 were written by
the *current* normalizer. The new `PlanBatchSchema` **must accept every row the current `isPlanBatch` accepts**
(equal-or-looser on existing data), or a cutover silently drops live plan history on read. The migration proves
equivalence *before* any layer switches, using the existing `shadowMode` substrate
([`config/types.ts:568-581`](../../src/config/types.ts), `runShadowPlanCycle`) and the pro14 journal corpus.

**Phase 0 — Extract the invariant, change nothing (shadow-validate).**
Add `src/domain/plan-batch.ts` with `PlanBatchSchema` / `normalizePlanBatch`. Do **not** wire it in. Add a
differential check: for every value `isPlanBatch` sees on read, also run `parseJournalPlanBatch` and log any
divergence (`plan_batch_schema_divergence`). Drive it with (a) a property test over generated batches, (b) the
existing fixtures, and (c) a replay of the live pro14 journal. **Gate to Phase 1:** zero divergences across a
defined observation window. *No behavior change; fully revertible (delete the module).*

**Phase 1 — Cut the READ edge over.**
`isPlanRevision` (`standing-plan.ts:505`) calls `parseJournalPlanBatch`; delete `isPlanBatch`'s bespoke canary
block (`:541-568`). Behavior is identical *by Phase-0 proof*. *Revertible: restore the predicate.*

**Phase 2 — Cut the WRITE edge over.**
`buildPlanBody` routes its validate-half through `normalizePlanBatch`; delete `normalizeCanary`
(`triage-planner.ts:952-972`); brand the output `ValidatedPlanBody`; tighten `recordPlanRevision` to accept only
the brand. Same invariants ⇒ same output. *Revertible per-call.*

**Phase 3 — Drop the consumer guards (assert-before-remove).**
First ship the **invariant-assert only**, *with G-C1/G-C2 still in place*, logging any violation over a window
(belt-and-suspenders shadow). Once the window is clean, remove G-C1 (`:102-105`) and the `length > 0` clause
(`:125-129`). Order matters: never remove a guard before the assert has proven, on live traffic, that it never
fires. *Revertible: re-add the holds.*

**Phase 4 — Close out.**
Update tests (`tests/agent/triage-planner.test.ts`, `tests/orchestrator/standing-plan-consumer.test.ts`,
`tests/logging/standing-plan-journal.test.ts`) to assert against the single schema; note SYMPH-944 superseded.

Every phase is independently revertible and **none changes dispatch behavior** — the boundary only changes
*where* validity is decided, never *what* is valid.

---

## 6. AC5 — SYMPH-944 disposition and artifact note

- **SYMPH-944** ("Guard #5 empty-head defense: assert canary heads are non-empty") is **already `Cancelled`** —
  declined at the time as "safe by construction" because `.some([]) === false` and `isPlanBatch` already drops
  empty-head canary-chain rows. This design **subsumes its intent**: the non-empty-head invariant becomes a
  single named rule in `PlanBatchSchema`, and the consumer invariant-assert (§4) is exactly the "small defensive
  assertion documenting the invariant guard #5 leans on" that SYMPH-944 proposed — now justified because it
  replaces *removed* per-call guards rather than adding a redundant one. **Marked superseded-by-boundary** (a
  comment is posted on SYMPH-944 pointing here; no state change needed since it is already terminal).
- **This brief is the only artifact for SYMPH-946.** No production code changes land under this ticket.

---

## 7. Follow-up (implementation)

Implementation of Phases 0–4 is durable work and is filed as a separate tracker issue under the same workstream,
related to SYMPH-946 (see the closeout comment for the issue ID). Acceptance criteria there are the five phases
above, each with its shadow-validate gate.
