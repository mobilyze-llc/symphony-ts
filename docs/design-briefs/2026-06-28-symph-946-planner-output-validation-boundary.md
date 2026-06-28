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
non-empty head whose head+contingent identifiers are all batch members" — are enforced at **three layers
(write, read, consumer) via five hand-maintained guard-checks** (G-W4, G-W6, G-R4, G-C1, G-C2 in §2):

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
  read-side `isPlanBatch` and the consumer holds. The ticket's bare `613 ("stabilize planner output")` reference
  resolves to **PR [#613](https://github.com/mobilyze-llc/symphony-ts/pull/613) "Stabilize standing-plan planner
  output"** (merged, commit `bd6a046`; it touches `triage-planner.ts` / `standing-plan.ts` /
  `standing-plan-shadow.ts` — exactly this surface), **not** the Linear ticket SYMPH-613 ("Repoint mobile
  dashboard report-server pro16 → pro14"), which is unrelated. The bare number is ambiguous (PR# vs ticket ID),
  not wrong — read it as the PR. SYMPH-920 is now a *regression test*
  ([`tests/no-nul-bytes.test.ts`](../../tests/no-nul-bytes.test.ts)); its original NUL-delimiter dedup key was
  replaced by a `JSON.stringify` key (see G-W9). **SYMPH-944 is already `Cancelled`** (declined as "safe by
  construction"); this design retroactively satisfies its intent (§5).

**Motivation (honest framing).** This is **DRY / maintenance-surface reduction**, not incident-driven. The
read-edge and consumer guards trace to council-review hardening (the in-code comments cite "council R1/R2,
Codex/Pi P1/P2"), not a known production bug where the triple-enforcement diverged. There is no quoted incident.
That matters for sizing: it argues for the **smallest** change that kills the duplication (§3.5), not the
largest. The benefit is a single place to fix the next failure mode, plus deleting hand-reimplemented predicates
— real, but bounded.

So the precise problem is narrower and sharper than "retire guards #2–5": **single-source the triple-enforced
structural-validity rule (write + read + consumer) so it is defined once, and let the re-plan predicates and
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
| RP#5 | canary head stuck (SYMPH-815) — touches `headIssueIdentifiers` but is **safe on its own** (null-guard `:305` + `.some([]) === false`); SYMPH-944 noted the shared invariant but RP#5 does not depend on it for correctness | `standing-plan-consumer.ts:290-320` | ⊘ world-drift |

**The duplication to remove** is the canary/structure validity rule re-derived as five guard-checks across three
layers: G-W4 + G-W6 (write), G-R4 (read), G-C1 + G-C2 (consumer). (The shape-only guards G-R1/R2/R3/R5 are also
marked `✔ invariant` but are *single-homed* on the read edge — not part of the triple-enforced duplication, and
out of this boundary's scope; see §4.) Everything `↻` is legitimate input-coercion that *belongs* inside the
boundary; everything `⊘` is orthogonal and stays.

---

## 3. AC2 — The single validation/normalization boundary

> **One canonical definition of "valid `PlanBatch`" — the invariant predicate — is the sole source of truth. It
> is enforced at BOTH trust transitions (model→domain and journal→domain). The write and read edges do
> *different operations* over that one predicate, so the module exposes two pieces, not one.**

### 3.1 Shape — separate the *validator* from the *normalizer* (they are not the same operation)

A subtlety that the first draft elided, surfaced in review: **the write edge and the read edge do different
things to a malformed canary.** Today's write-side `normalizeCanary` ([`triage-planner.ts:952-972`](../../src/agent/triage-planner.ts))
**filters** out-of-member head/contingent refs and **keeps** the batch (downgrading only when no head survives);
the read-side `isPlanBatch` ([`standing-plan.ts:560-568`](../../src/domain/standing-plan.ts)) requires *all*
refs ⊆ members and **drops the whole row** on any violation. A single function cannot be both "normalize-and-keep"
and "validate-and-drop." So the canonical module owns **one invariant predicate** plus **one write-only
normalizer whose output is guaranteed to satisfy that predicate**:

```text
src/domain/plan-batch.ts
  ├─ PlanBatchSchema              // ONE Zod schema = the invariant predicate (the single source of truth):
  │                               //   mode ∈ PLAN_BATCH_MODES
  │                               //   members.min(1), each {issueId, issueIdentifier}
  │                               //   canary:  canary-chain ⟹ non-empty head ∧ head∪contingent ⊆ members
  │                               //            every other mode ⟹ canary === null
  │                               // (expressible via .superRefine over the same object — zod is already a dep)
  ├─ isValidPlanBatch(value)      // = PlanBatchSchema.safeParse(value).success — the READ-edge gate, and the
  │                               //   write-edge POST-CONDITION assertion
  └─ normalizePlanBatch(rawBatch, members)  // WRITE-ONLY repair: filter head/contingent to members, downgrade
         → { ok: true; batch } | { ok: false; rejection }   //   canary-chain→parallel-isolated when no head survives;
                                 //   OUTPUT is guaranteed to satisfy PlanBatchSchema (asserted in dev/test)
```

Two thin public entry points, both grounded in the **one** `PlanBatchSchema`:

- **`parsePlannerOutputToPlan(markdown, context): { ok: true; body: PlanBody } | { ok: false; rejection: PlanRejection }`**
  — the write edge. Keeps its tolerant **parse/normalize front-half** (G-W1, G-W2, G-W3, G-W5, G-W7, G-W8, G-W9
  — extraction, alias coercion, member resolution, downgrade, dep-edge resolution) because turning prose-wrapped
  model output into candidate structures is *real* normalization ("parse, don't validate"). It is
  **normalize-then-validate**: `normalizePlanBatch` repairs, then every emitted batch is checked against
  `PlanBatchSchema` as a post-condition. Its old validate-half (G-W4 schema + the duplicated G-W6 canary rule)
  becomes that single shared predicate.
- **`parseJournalPlanBatch(value): batch | null`** — the read edge. **validate-only**: `isPlanRevision` calls
  `isValidPlanBatch` instead of the hand-written `isPlanBatch`. Same predicate, **one implementation**, drop on
  fail.

The single shared thing across both edges is **`PlanBatchSchema` (the predicate)** — not the normalizer. That is
what kills the duplication: the canary/structure rule is written once and enforced at write (post-condition),
read (gate), and consumer (assert, §4).

### 3.2 Preserve the existing structured-result contract (do not throw)

This is **status quo, not a new design choice**: the write edge *already* returns a structured result, not a
throw — `parsePlannerOutput` returns `{ ok: false; reason }` ([`triage-planner.ts:554,563-575`](../../src/agent/triage-planner.ts))
and the read edge already returns a predicate/`null`. The boundary **keeps** that shape so graceful degradation
is preserved verbatim:

- `runShadowPlanCycle` ([`standing-plan-shadow.ts:378-389`](../../src/orchestrator/standing-plan-shadow.ts))
  keeps logging `queue_triage_planner_invalid` and returning `{status:"invalid"}` → dispatch keeps using the
  comparator.
- `manager-plan.ts:351` keeps its `status === "invalid"` branch.
- The SYMPH-918 retry (G-W10) wraps the boundary unchanged.

Keep the existing `{ ok: false; reason: string }` rejection shape. A **typed `PlanRejection` code union**
(`"unparseable" | "schema" | "no-valid-batch"`) is *deferred* (§3.5, Increment C): every current consumer
branches only on the binary invalid/not-invalid outcome, so a discriminant has no reader today and would be
generality ahead of need. Add it only if a consumer needs to branch by failure category (e.g. retry-on-schema-only).

### 3.3 What the boundary actually buys (and what it doesn't)

- **Single source of truth for validity.** The canary invariant, the mode enum, the non-empty-member rule exist
  in `PlanBatchSchema` only. A future failure mode is fixed *once* and is automatically enforced at write
  (post-condition), read (gate), and consumer (assert) — the ratchet can't re-form. **This is the boundary's
  real contribution**: it collapses the write-side `normalizeCanary`/schema and the read-side `isPlanBatch`
  re-derivation into one predicate.
- **The consumer guards are removable — but credit the *existing read filter*, not the new boundary.** The read
  edge *already* drops any revision row with a bad batch: `readStandingPlanJournal` → `isStandingPlanJournalEntry`
  ([`standing-plan-journal.ts:87`](../../src/logging/standing-plan-journal.ts)) → `isPlanRevision` →
  `batches.every(isPlanBatch)` ([`standing-plan.ts:505`](../../src/domain/standing-plan.ts)). The consumer only
  ever reads `projectStandingPlan` output, which iterates that already-filtered journal — so a projected
  `canary-chain` batch *already today* cannot have a null/empty-head canary. G-C1/G-C2 are therefore redundant
  **against the status-quo read filter**, independent of this design; removing them is justified by what the read
  edge already guarantees. They are replaced by **one** invariant-assert at the consumer entry (§4) — fail-loud-once
  instead of silent-defend-everywhere — which documents the invariant rather than re-checking it.
- **Optional: a brand for compile-time trust** (`ValidatedPlanBody`, §3.5 Increment B). *Not* part of the core
  de-dup, and *not* recommended for v1 — it earns its keep only if a second `recordPlanRevision` caller appears
  that could bypass the boundary. Today there is one producer and one consumer of plan bodies, so a private
  module boundary + the read-edge filter already provide the guarantee.

### 3.4 What this is *not*

It does not move re-plan intelligence or world-drift detection into the boundary (those stay in the consumer; see
the project's scope-boundary rule). It does not add a queue/Redis. It does not touch the dispatch hot path's zero-
LLM guarantee — the boundary is pure and synchronous.

### 3.5 Alternatives considered (and the recommended v1)

Given the motivation is DRY (no incident, §1), favor the smallest change that kills the duplication. Three
increments, only the first recommended for v1:

- **V1 (recommended) — one shared predicate + write-only normalizer, no brand, no rejection-union redesign.**
  Extract `PlanBatchSchema` (the predicate) and `normalizePlanBatch` into `src/domain/plan-batch.ts`; have the
  write edge post-condition-check against it and the read edge gate on it (`isPlanRevision` calls it); delete the
  hand-reimplemented `isPlanBatch` canary block (G-R4) and the consumer holds (G-C1/G-C2, already redundant per
  §3.3). Keep `recordPlanRevision`'s plain `PlanBody` signature and the existing `{ok:false}` rejection shape.
  This is the entire de-dup win at the smallest surface — no new type-level machinery.
- **Increment B (optional, deferred) — branded `ValidatedPlanBody`.** Compile-time enforcement that no caller
  reaches `recordPlanRevision` without crossing the boundary. Buys little today (single producer → single
  consumer) and costs a `unique symbol` brand every maintainer and test must thread. Adopt only when a second
  write path appears. *If adopted, it sets a precedent other domain boundaries would be expected to follow —
  own that trajectory deliberately, don't acquire it as a side effect of this ticket.*
- **Increment C (optional, deferred) — typed `PlanRejection` code union.** Add a failure-category discriminant
  only when a consumer needs to branch on it (§3.2).
- **Rejected — do nothing.** The read filter already protects the *consumer*, but the **write↔read re-derivation
  of the same rule remains** a live maintenance cost (the ratchet): the next canary failure mode would again be
  patched in two hand-written places. V1 removes that, do-nothing does not.

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
| G-R1/R2/R3/R5 shape guards | **KEPT** (out of de-dup scope) | single-homed on the read edge — **not** part of the triple-enforced duplication. Leave as-is; optionally schema-ify in a *separate* follow-up so this boundary's equivalence proof stays narrow to the canary/structure rule. |
| G-R6 journal filter | **KEPT** | unchanged (still drops rows the schema rejects) |
| **G-C1 canary===null hold** | **DELETED** | **`standing-plan-consumer.ts:102-105` removed** — redundant against the existing read filter `batches.every(isPlanBatch)` (§3.3), not just the new boundary: a projected `canary-chain` batch already cannot have a null canary today. |
| **G-C2 empty-head check** | **SIMPLIFIED** | **`standing-plan-consumer.ts:125-129`** — drop the `headIssueIdentifiers.length > 0 &&` clause only (the `headValidated` logic stays); the invariant + read filter already guarantee a non-empty head. |
| *(new)* consumer invariant-assert | **KEPT-ASSERT** (one) | add `assertProjectedPlanValid(plan)` at `selectDispatchableBatchMembers`/`decidePlanDrivenDispatch` entry — one cheap structural assert that logs-and-degrades if ever violated. Documents the system-wide invariant in one place (and is the "small defensive assertion" SYMPH-944 proposed). |
| G-C3 running/merged exclusion | **KEPT** (orthogonal) | unchanged |
| RP#1–#4 re-plan predicates | **KEPT** (out of scope — world-drift) | unchanged |
| RP#5 canary-head-stuck | **KEPT** | unchanged. RP#5 is already safe on its own — it null-guards (`:305`) and `headIssueIdentifiers.some([]) === false` — so it does **not** depend on the invariant for correctness; the new assert documents the invariant system-wide, it doesn't rescue RP#5. |

**Net production removal:** `standing-plan.ts:541-568` (G-R4, hand re-derived canary invariant), `normalizeCanary`
at `triage-planner.ts:952-972` (G-W6, folded into the write-only normalizer), `standing-plan-consumer.ts:102-105`
(G-C1, redundant hold), and the `length > 0` clause at `standing-plan-consumer.ts:125-129` (G-C2) — **four of the
five** `✔ invariant` re-implementations of the canary/structure rule gone (G-W6, G-R4, G-C1, G-C2), and the
**fifth (G-W4 write schema) becomes the single shared `PlanBatchSchema`**. The scattered consumer defense
collapses to one assert. (The shape-only guards G-R1/R2/R3/R5 are untouched — out of scope.)

---

## 5. AC4 — Migration order + back-compat (shadow-validate before cutover)

**Hard constraint:** the standing-plan journal is durable and append-only; live rows on pro14 were written by
the *current* normalizer. The new `PlanBatchSchema` **must accept every row the current `isPlanBatch` accepts**
(equal-or-looser on existing data), or a cutover silently drops live plan history on read. The migration proves
equivalence *before* any layer switches, using the existing `shadowMode` substrate
([`config/types.ts:568-581`](../../src/config/types.ts), `runShadowPlanCycle`) and the pro14 journal corpus.

**Phase 0 — Extract the invariant, change nothing (shadow-validate). Two equivalence proofs, not one.**
Add `src/domain/plan-batch.ts` with `PlanBatchSchema` / `isValidPlanBatch` / `normalizePlanBatch`. Do **not**
wire it in. The two edges need *separate* proofs because they do different operations (§3.1):
- **Read-edge equivalence (boolean):** for every value `isPlanBatch` sees on read, also run `isValidPlanBatch`
  and log any divergence (`plan_batch_schema_divergence`). Target: `isValidPlanBatch(row) === isPlanBatch(row)`
  for all rows. *This requires exporting the currently module-private `isPlanBatch`* (or adding a test-only
  differential harness inside `standing-plan.ts`) — a trivial, revertible visibility change to existing code, so
  Phase 0 is not *purely* additive.
- **Write-edge equivalence (value):** assert `normalizePlanBatch(raw, members)` produces **byte-identical**
  batches to today's `normalizeCanary`+downgrade over the same corpus — including a stable `contentBatchId`
  (it is content-derived, so any normalization-order change silently churns batch ids and idempotency keys).
  The read-edge boolean check does **not** cover this.

Drive both with (a) a property test over generated batches, (b) the existing fixtures, and (c) a replay of the
live pro14 standing-plan journal — pull a snapshot of the journal file from the workspace root on pro14 (under
the standing-plan journal dir; see `getStandingPlanJournalPath`) for offline replay. **Gate to Phase 1:** zero
divergences on **both** proofs across a defined observation window (e.g. N plan cycles or a fixed date range).
*No behavior change; revertible (delete the module + the export).*

**Phase 1 — Cut the READ edge over.**
`isPlanRevision` (`standing-plan.ts:505`) calls `isValidPlanBatch`; delete `isPlanBatch`'s bespoke canary
block (`:541-568`). Behavior is identical *by Phase-0's read-edge proof*. *Revertible: restore the predicate.*

**Phase 2 — Cut the WRITE edge over.**
`buildPlanBody` calls `normalizePlanBatch` and post-condition-checks each batch against `PlanBatchSchema`; delete
`normalizeCanary` (`triage-planner.ts:952-972`). Output is identical *by Phase-0's write-edge value proof*.
*(Optional, Increment B only: brand the output `ValidatedPlanBody` and tighten `recordPlanRevision` to accept
only the brand — deferred; not in v1.)* *Revertible per-call.*

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
