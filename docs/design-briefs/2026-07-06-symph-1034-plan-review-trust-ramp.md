# Design brief — Plan-review trust ramp (SYMPH-1034): report-only → advisory → gate → SYMPH-875

**Date:** 2026-07-06 · **Status:** design brief — seeds an operator-driven SYMPH-1034 design session (does NOT decide it) · **Filesystem-first** (not Linear Docs)
**Feeds:** the SYMPH-1034 design session · **Consumes:** the 2026-07-06 differential-review data point (`docs/plans/2026-07-02-manager-plan-dogfood-runbook.md`), the facet-3 plan (`docs/plans/2026-07-06-001-feat-standing-plan-diff-gate-shadow-wiring-plan.md`)

## Purpose

The trust ramp is the critical path from the manager producing plans in shadow to the manager *driving dispatch* (SYMPH-875 cutover). This brief frames the four decisions the design session must make — the report-only **exit criterion**, the **telemetry** that computes it, **advisory surfacing**, and **gate sequencing** — with recommended defaults and the genuinely-open methodology questions called out. Every threshold is deliberately left TBD-from-data (measure-before-caps); the brief's job is to define *what to measure and how*, not to guess the numbers.

## Where we are (what's proven, what's not)

- **Gate mechanics: proven.** The 2026-07-06 data point showed the diff-gate produces real `no_baseline` / `content_hash_changed` / `content_hash_unchanged` decisions and real `PASS`/`fail` verdicts (post the SYMPH-1061 materialization fix; both lanes `passed`, 0 validation errors).
- **Cost: measured.** ~30–35K tokens / ~90–110s per decorrelated review round (2 lanes: codex@high + opus); the gate's skip path costs **0**.
- **NOT yet proven — the whole point of the ramp:** that the decorrelated review actually **catches** bad plans the Opus author missed, at an acceptable **false-positive** rate and **cost-per-catch**. That is facet 1, and it cannot be measured until facet-3 (SYMPH-1066) + its grounding prerequisite (SYMPH-1065) land and the wired gate runs over time.

## The ramp as four rungs

| Rung | State | What it does | Graduation gate |
|---|---|---|---|
| **R0 report-only** | facet-3 wires this (SYMPH-1066) | Review runs on changed ticks; verdict journaled + logged; **nothing acted on** | The exit criterion below (catch-rate / FP / cost clear thresholds set *from this rung's data*) |
| **R1 advisory** | design here | Verdicts **surfaced to an operator**; operator acts or dismisses; operator agree/dismiss **labels** the data | Sustained operator-confirmed value: high agree-rate on real findings, low noise |
| **R2 gate** | design here | Verdict **blocks/steers dispatch** (CHANGES_REQUESTED holds a plan; PASS lets it drive) | Clean gate over a window → input to SYMPH-875 |
| **cutover** | SYMPH-875 | Manager drives dispatch | The review-gate is **one** input, not the only one (envelope/safety gates too) |

**Design principle (from prior learnings):** *telemetry before consumer* — design R0's records first, then build the R1/R2 projections **from** those records. And *decide-don't-park* the kill-criterion: if R0 shows the lanes catch nothing the author didn't, **cut the tier** rather than ramping a no-op.

---

## Decision 1 — The report-only exit criterion (R0 → R1)

Four signals. Each needs a definition, a data source, and a threshold-TBD-from-data.

### 1a. Catch-rate on known escapes (the core signal)
- **Golden set:** historical plan revisions that contained a *known* defect the review should catch. Seed set: **SYMPH-942** (surfaced-superseded candidate the Opus planner scheduled), **SYMPH-906 / 907** (over-scheduling / envelope breach). Each entry = {plan-revision context, the defect, the plan anchor it lives at}.
- **How measured:** replay each golden entry's context through the *wired* tier-2 review; score a **catch** if a lane flags a P1/P2 finding at (or semantically matching) the known defect's anchor. Catch-rate = catches / golden entries.
- **Recommended default:** build the golden set by **replaying historical escapes** (fast) *and* accumulating **new** live escapes as they occur (ground truth). Do not wait for organic escapes alone — too slow.
- **Open:** how many golden entries are enough to trust the rate? (Small N is the honest risk — the data point was N=1.) Start with the 3 named + grow; report the N alongside the rate.

### 1b. Decorrelation value (the make-or-break)
- **The hypothesis under test:** the *non-author* lanes catch what the Opus author missed. If the decorrelated lanes' catches ⊆ what a same-model self-review would catch, the tier is dead weight.
- **How measured:** per catch, attribute it to a lane (codex vs opus-reviewer) and compare against the tier-1 self-review baseline (which the author model already runs). Count catches **unique to** the decorrelated lanes.
- **Kill-criterion (bake in):** if decorrelated-unique catches ≈ 0 over the golden set + a live window, **recommend cutting tier-2** and keeping only the tier-1 floor. This is the honest exit, and it must be a first-class possible outcome of the ramp, not an afterthought.

### 1c. False-positive rate
- **How measured:** replay **good** historical plans (ones that shipped fine) through the review; count `CHANGES_REQUESTED` verdicts / P1-P2 findings on them. FP-rate = false flags / good plans. In R1, augment with operator dismissals (operator marks a finding wrong).
- **Why it gates:** high FP → advisory noise → operators learn to ignore the review → the gate is worthless when it finally matters. FP-rate is as important as catch-rate.

### 1d. Cost-per-true-catch
- **Known input:** ~30–35K tokens/changed-tick. Combine with catch-rate to get **cost per true catch**. That is the number that says whether the tier earns its keep, not raw per-run cost.
- **No cost cap** (a guessed cap halts runs). Report cost-per-catch; let the design session set an acceptable ceiling *from observed value*.

---

## Decision 2 — What facet-3 must log (feeds back into SYMPH-1066 R4)

The exit criterion above is only computable if R0 emits the right records. **This is the timely part: it can refine facet-3's telemetry (R4) before facet-3 is built.** Proposed record per review (extends the `review_tier2` log the plan already adds):

- `gate_reason`, `status`, `diff_hash`, `revision_id`, `timestamp` — already planned.
- **Per-lane** verdict + findings (not just the aggregate) — **required** for decorrelation attribution (1b). The plan currently logs only `aggregate_verdict`; add per-lane.
- **Per-lane token cost** — for cost-per-catch (1d).
- **Skip disambiguation** — distinguish `content_hash_unchanged` (legitimate) from `no grounded evidence` (inert-state noise) via the record's `note`, so the noise the adversarial reviewer flagged does not pollute catch/FP math. (Already an Open Question on the facet-3 plan; resolve it here as a telemetry requirement.)
- **Golden-set linkage hook** — a way to tag a replayed revision with the known-defect id, so catch-rate is computable without hand-reconciliation.

**Action for the session:** confirm this schema, then it becomes an amendment to SYMPH-1066 R4 *before* implementation — cheaper than retrofitting telemetry after.

---

## Decision 3 — Advisory surfacing (R1)

The middle rung is where operators SEE verdicts and act — which both builds trust and **generates the labels** (agree/dismiss) that turn R0's replay estimates into live ground truth.

- **Where:** options — (a) Linear comments on the standing-plan issue / the scheduled issues, (b) the operator dashboard, (c) Slack digest, (d) a dedicated operator-action queue. **Recommended default:** start with (a) Linear comments on the affected issues + a Slack digest of P1/P2 findings — reuses existing operator surfaces, no new UI.
- **What's actionable:** P1/P2 findings → operator decision (accept → hold/adjust the plan; dismiss → label as FP). Track findings → logged only.
- **The labeling loop (the real value of R1):** every surfaced finding gets an operator agree/dismiss, which is the FP/catch ground truth 1a/1c need at scale. Design the surface so dismissing is one click and records a reason.

---

## Decision 4 — Gate sequencing (R2) and the SYMPH-875 relationship

- **R1 → R2 trigger:** advisory-phase catch-rate ↑, FP-rate ↓, and operator agree-rate sustained over a window (thresholds from R1 data).
- **What "gate" means:** the review verdict blocks/steers dispatch — `CHANGES_REQUESTED` holds the plan revision from driving dispatch; `PASS` lets it. This is where SYMPH-787's consumer (the plan-drives-dispatch path) meets the review.
- **Relationship to SYMPH-875:** the review-gate is **necessary but not sufficient** for the cutover. Name the *other* cutover gates explicitly in the session (envelope conformance, safety/blast-radius, the SYMPH-787 dispatch-consumer readiness) so 875 is not mistaken for "review passes → cut over."

---

## Open questions for the session (decide; don't park)

1. **Golden-set construction** — replay historical escapes vs synthetic bad plans vs wait-for-live. (Rec: replay + accumulate live; report N.)
2. **Trigger granularity** — whole-plan content-hash vs per-batch/delta review. (Carried from the facet-3 plan; a single-issue drop currently re-reviews the whole plan.)
3. **The decorrelation kill-criterion threshold** — how few unique catches ⇒ cut the tier.
4. **Advisory surface** — which operator channel(s) for R1 (Rec: Linear comments + Slack digest).
5. **How much data is "enough"** at each rung (N of reviews / window length) before graduating — the honest small-N risk.

## Success criteria for the ramp (not this brief)

- R0 emits records sufficient to compute catch-rate, decorrelation-unique catches, FP-rate, and cost-per-catch **without hand-reconciliation**.
- The ramp can **honestly kill tier-2** if the decorrelation value is absent.
- No threshold is hardcoded ahead of data; each graduation gate is set from the prior rung's observed distribution.
- The gate, when it lands, is one explicit input to SYMPH-875 among named others.

## References

- Data point + cost/verdict evidence: `docs/plans/2026-07-02-manager-plan-dogfood-runbook.md` → "Differential-review data point — 2026-07-06".
- Facet-3 plan (R0 wiring, telemetry R4): `docs/plans/2026-07-06-001-feat-standing-plan-diff-gate-shadow-wiring-plan.md` (SYMPH-1066), grounding prerequisite SYMPH-1065.
- Tickets: SYMPH-1034 (this ramp), SYMPH-875 (cutover), SYMPH-787 (plan-drives-dispatch consumer), SYMPH-942 / 906 / 907 (golden-set seed escapes), SYMPH-1032 (decorrelated tier-2), SYMPH-1029 (tier-1 floor).
