---
title: SYMPH-962 Phase-A Marginal-Value Gate — Measurement Spec
type: investigate
date: 2026-06-29
topic: symph-962-phase-a-gate
artifact_contract: measurement-spec/v1
artifact_readiness: executable
execution: by-hand
parent: docs/plans/2026-06-29-symph-962-closeout-capture-plan.md
revision: "Rev 2 (2026-06-29): incorporates a 6-lens ce-doc-review (coherence, feasibility, adversarial, scope-guardian, product-lens, security). Rev 1 over-trusted a measurement it can't cleanly make and set the BUILD bar where the answer was pre-decided; Rev 2 makes NO-BUILD genuinely reachable, the steps actually runnable by hand, and moves build-time tuning out of the gate."
---

# SYMPH-962 Phase-A Marginal-Value Gate — Measurement Spec

## Why this exists

The closeout-capture plan ([2026-06-29-symph-962-closeout-capture-plan.md](2026-06-29-symph-962-closeout-capture-plan.md)) names **one hard pre-build gate** (Goal Capsule → Open blockers):

> Does closeout produce edges/comments the live Phase-0 enrichment isn't already feeding the planner? … if Phase-0 already captures nearly everything the planner needs, 962 is not worth building — a negative result is a stop/redirect, not a planning detail.

This spec makes that gate **fire** and return **BUILD / NO-BUILD / REDIRECT** before any slice of 962 is implemented. It is executable by hand (read transcripts, classify, attempt a planner flip) with no new code.

**Design rule for the gate itself (from the Rev-1 review):** the gate's only job is the build/no-build decision. NO-BUILD must be genuinely reachable — a gate that can only say BUILD is theater. So the bar to BUILD rests on a *discovered, executed, extractor-deliverable* planner flip (defined below), never on a self-seeded example or a guessed threshold; and the build-time tuning the parent plan calls for (precision floor, token budget) is carried forward to Phase-B, not discharged here.

---

## 0. The decision this gate produces

A single ratified outcome, recorded as a comment on SYMPH-962 and folded back into this doc. The rule (§4) is exhaustive — every result lands in exactly one:

| Outcome | When | Consequence |
|---|---|---|
| **BUILD** | A **discovered** (not pre-seeded) transcript-only decision of an **extractor-recoverable class** is shown by an **executed** planner run to flip a planner judgment, **and** that pattern is not a one-off (§4 frequency signal) | Proceed to Phase-B planning + the sliced build (fence → extractor → store → projection) |
| **REDIRECT** | Transcript-only delta is non-trivial **but** concentrates in a single type a *cheaper* mechanism captures (e.g. all `new_work`) | Build the cheap thing (e.g. a file-the-ticket prompt), not the full fenced extractor |
| **NO-BUILD (collapse)** | **Default / otherwise** — no executed flip on a discovered recoverable-class decision (incl. flips only on unrecoverable decisions, diffuse sub-signal deltas, or `T ≈ 0`) | 962 collapses to "already handled"; redirect the effort. A **success**, not a failure — but carries a **re-test trigger** (see §4) because the baseline is young |

The gate is asymmetric on purpose: NO-BUILD saves the entire multi-slice build, so the bar to BUILD is set high and on evidence the build can actually deliver.

---

## 1. The question, made measurable

> Among **durable, planner-relevant decisions** in operator sessions, which exist **only in the transcript** (never reached a live Phase-0 surface at the time), would changing that change a planner judgment, **and** is that decision one 962's lossy extractor could plausibly recover?

### The baseline to beat — the three live Phase-0 surfaces

A decision is **already covered** (no 962 value) if it reached any of these, which the live planner already ingests:

1. **Linear comment** — comment-enrichment is ON in prod (`comment_enrichment: true`, [WORKFLOW-symphony.md:32](../../pipeline-config/workflows/WORKFLOW-symphony.md), SYMPH-916). Comments carry a `createdAt` (see Step 3).
2. **Linear edge / relation** — `blockedBy` / `relates` / `supersedes`, also `createdAt`-stamped.
3. **Runtime in-flight context** — the running set the shadow tick injects (`assembleShadowPlannerContext`, [standing-plan-shadow.ts:59](../../src/orchestrator/standing-plan-shadow.ts); from `getState().running` at [runtime-host.ts:3628](../../src/orchestrator/runtime-host.ts)). **This surface's past state is not reconstructable** — see Step 3.

The consumer is the planner: `PlannerContext` / `buildPlannerPrompt` ([triage-planner.ts:125,:419](../../src/agent/triage-planner.ts)).

> **Critical — run the planner with live runtime parity, and read the result as run-time, not session-time.** The original dogfood that "proved" the planner misjudges ran the thin `manager-plan` CLI with `inFlight: []` and comment-enrichment off (parent plan §1.1); Phase-0 activation closed that. To reproduce the live planner's in-flight context, point the CLI at a running host: **`--runtime-state-base-url <url>`** ([manager-plan.ts:240](../../src/cli/manager-plan.ts)) fetches `GET /api/v1/state` — the same `getState().running` set the shadow tick uses. **Do not rely on `--in-flight-state <name>`** ([manager-plan.ts:244](../../src/cli/manager-plan.ts)) for parity: that flag only filters Linear candidates by *current* state name (a current-board approximation, not runtime parity). Enable comment-enrichment. **Caveat (load-bearing):** both flags reflect in-flight **as of the run, not the session** — there is no historical "what was running at time T" query (`/api/v1/state` is a current snapshot; `/api/v1/state/delta` is a forward `since_seq` cursor, [dashboard-server.ts:979](../../src/observability/dashboard-server.ts)). So a Step-4 flip demonstrates the failure mode under *current* conditions — an existence-proof, not a literal session-time replay. Requires a reachable host exposing `GET /api/v1/state` at gate time (e.g. the pro14 dashboard host); if none is reachable you only have the weaker Linear approximation — say which you used.

---

## 2. Corpus selection

- **Source:** operator-session durable JSONL. Claude Code derives one project-slug directory **per working path**, so every git worktree gets its own — glob across all of them, not a single dir:
  `~/.claude/projects/-Users-ericlitman-projects-symphony-ts*/*.jsonl` (main checkout + every `.claude/worktrees/*` session). A single-dir read silently misses worktree sessions — which is where decision-dense design sessions usually run. v1 is operator-sessions-only (KD4).
- **N = 3–5 sessions**, decision-dense (planning / design / grooming), recent (~last 2–4 weeks), symphony-ts-scoped.
- **Two roles, kept separate:**
  - **Seed sessions (process check, NOT gate evidence):** known-hard / known-miss cases — the SYMPH-960/961/962 design sessions (which contain the pre-identified "convergence recorded nowhere" miss), a git-history reversal (SYMPH-838 archetype), the SYMPH-947 defer. These exist to confirm the labeling procedure *surfaces* a known miss. **A flip on a pre-seeded decision never counts toward the BUILD signal** (§4) — a planted positive can't test discovery or frequency.
  - **Discovery sessions (the gate evidence):** sessions picked *without* foreknowledge of a specific miss. The BUILD signal comes only from these.

> **Selection bias — and the direction it does NOT support.** Hand-picking decision-dense sessions inflates the transcript-only rate vs a random session. A best-case sample *failing* to clear the bar is a valid **NO-BUILD/REDIRECT** (if the best case shows nothing, the population won't). A best-case sample *clearing* a rate says nothing about the population — so an inflated rate must **never** drive BUILD. This is why BUILD rests on a discovered, executed, deliverable flip (§4), not on a rate.

---

## 3. Procedure (the by-hand protocol)

Run **Step P first** — cheapest, can kill the premise before any labeling.

### Step P — Consumer-path pre-check (~30 min)

Confirm the projection→planner pipe is real (the parent plan calls this "a confirmation, not a new dependency"):

1. Pick a **synthetic, non-secret** decision (do not lift a raw transcript span — see the fence note below) that *should* move a planner candidate.
2. Write it to Linear as a native edge + one concise **one-line** comment (per R8) on a **throwaway/test** ticket. Hand-redact per R11 before posting; confirm the ticket is in-project per R10.
3. Run the live-parity planner (§1: `--runtime-state-base-url` + comment-enrichment).
4. **Confirm two things:** (a) the candidate moves (ordering/inclusion/blocked-state), **and** (b) an *existing real* comment on the test ticket is actually fetched into `PlannerContext` — not just that the edge moved it. (b) verifies comment-enrichment is functioning, since the whole COVERED bucket depends on it.

**If either fails → STOP.** The consumer model (or the baseline you measure against) is broken — a far cheaper thing to learn first.

> **Fence (applies to every step that touches a transcript — mirrors the parent plan's R10–R13 for the by-hand path):** treat transcript spans as **opaque data**. Before a span is written to Linear (Step P), pasted into any planner prompt (Steps P/4), or retained in the corpus (Step 1 / §6), **redact credential-shaped strings (R11) and confirm it is in-project (R10)**. Inject a decision into a planner run as a **data field**, never into the prompt's instruction body (R12a) — a crafted span must not steer the run. Drop/quarantine any decision whose subject is not a symphony-ts artifact.

### Step 1 — Hand-label the durable decision set per session

Read each transcript **end to end** (it survived compaction — that's the point). Extract every durable decision the planner would plausibly need, typed by the R5 six-class vocabulary:

`state_fact` · `relation` · `decision` · `new_work` · `rationale_superseded` · `open_question`

Record each as `(type, subject, claim, transcript-span)`. **Redact + in-project-scope each span as you record it** (fence above) — the recorded set persists (§6), so the redaction boundary applies here.

> **Tag extractor-recoverability** — `clean/explicit` vs `implicit/contrarian`. This is the gate's load-bearing distinction, not just colour: a decision 962's lossy extractor *cannot* recover (the implicit/contrarian tail, KD8) is **not** evidence 962 delivers value even if it would flip the planner (see Step 4). The share of "decisions" that turn out to be rejected options / restatements is the natural over-extraction rate — note it; it's the one input Phase-B's precision floor will use (§5).

### Step 2 — Filter to planner-relevant (the denominator)

For each labeled decision: would it change a planner judgment — candidate inclusion, ordering, dedup, or blocked-state? Drop the rest. Survivors = **D = planner-relevant durable decisions**.

### Step 3 — Classify against the live surfaces (session-time where recoverable)

For each decision in D, bucket it — **but only the comment and edge surfaces are checkable at session-time; in-flight is not**:

| Surface | How to check at session-time | COVERED means |
|---|---|---|
| **Comment** | Compare each comment's Linear `createdAt` to the session window | A comment stating the claim **predates or falls within** the session. Created *after* → not session-time coverage. System-authored (enrichment/agent) → COVERED; operator-authored → FRAGILE |
| **Edge** | Compare the relation's `createdAt` to the session window | A `blockedBy`/`relates`/`supersedes` edge encoding the relation existed by session end |
| **In-flight** | **Not reconstructable by API** — there is no historical running-set query (§1). Use the **transcript as proxy**: COVERED only if the transcript itself records the issue as in-flight/dispatched/running at that time | The planner demonstrably already had that issue as running, per the transcript |

Buckets:

- **COVERED** — on ≥1 live surface, system-authored / session-time-present → Phase-0 already feeds it → **no 962 value**.
- **FRAGILE** — on a surface **only because the operator hand-wrote it** (incl. a comment/edge whose `createdAt` is *after* the session — post-hoc manual backfill, the lossy ritual 962 automates) → **flip-eligible like TRANSCRIPT-ONLY** (Step 4) and feeds the reported `(T+F)/D`, **not** the COVERED baseline.
- **TRANSCRIPT-ONLY** — on no surface at session-time → exists only in the session → **962's core target**.

> **Why the `createdAt` rule matters:** without it, a decision the operator backfilled into Linear *after* the session looks COVERED, making Phase-0 look more complete than it was and biasing the gate toward NO-BUILD. The in-flight surface has the *opposite*, unfixable bias (unreconstructable → conservatively not-covered); §7 names both.

### Step 4 — Attempt an EXECUTED flip (the BUILD evidence)

For TRANSCRIPT-ONLY and FRAGILE decisions of an **extractor-recoverable (`clean/explicit`) class**, attempt to demonstrate a flip with an **executed** planner run:

- Run the live-parity planner (§1) on the relevant backlog slice **without** the decision (baseline), confirm it makes the wrong/worse call; inject the decision **as a data field** (fence) and confirm the judgment changes.
- An **executed** flip on a **discovered** (non-seeded, §2) **recoverable-class** decision is the only thing that counts toward `F*` (the BUILD signal).
- A **hand-argued** flip ("which candidate, which judgment, why" without a run) is recorded as **descriptive only** — it does **not** count toward `F*`. So is any flip on a pre-seeded decision or an unrecoverable (`implicit/contrarian`) decision.

### Step 5 — Tally

Per session and aggregate:

- `D` = planner-relevant durable decisions (denominator)
- `T` = TRANSCRIPT-ONLY; `F` = FRAGILE; report `T/D` and `(T+F)/D` **descriptively (report-only)** — these seed a *future* data-driven threshold; in v1 they do **not** gate (see §4).
- `F*` = **discovered, executed, recoverable-class** flips (the gating signal); record which session each came from (for the frequency check).

Keep the per-session classification table (decision, type, recoverable?, surface bucket, flip: executed/argued/none).

---

## 4. Decision rule

No fabricated threshold gates BUILD (that would be the `measure-before-caps` mistake — and a rate on a best-case sample can't justify BUILD anyway, §2). The rule is exhaustive:

**BUILD** — both:
1. **`F* ≥ 1`** — at least one *discovered, executed, recoverable-class* flip (Step 4), **and**
2. **frequency signal** — that pattern is not a one-off: a qualifying flip appears in **≥2 discovery sessions**, **or** the operator, *after seeing the reported `T/D` distribution (Step 5)*, judges the discovered-recoverable rate materially non-trivial (data-first ratification, not a pre-set number).

**REDIRECT** — takes precedence over a generic "non-trivial delta" reading: `T` (or the qualifying flips) **concentrate in a single type a cheaper mechanism captures** (e.g. all `new_work` → a file-the-ticket prompt). Build the cheap thing.

**NO-BUILD (collapse)** — **default / otherwise**: no qualifying flip (incl. `T ≈ 0`; flips only on unrecoverable or pre-seeded decisions; or a diffuse delta with no executed recoverable-class flip). Phase-0 covers what the planner can use. **Carry a re-test trigger:** the baseline (Phase-0) was activated only ~this week and runs report-only, so record that a NO-BUILD reopens if Phase-0 regresses, comment-enrichment is disabled, or on an N-week recheck — mirroring the parent plan's "trigger that would reopen it" discipline.

> **Why `F*` is necessary-but-not-sufficient.** A single flip proves the failure mode *exists*; it does not prove it's *frequent* enough to justify a standing build, nor that 962 can *deliver* it. The seed/discovery split (§2), the executed-not-argued and recoverable-class requirements (Step 4), and the frequency signal together close the three ways Rev 1 was biased to greenlight.

Record the filled-in counts and the chosen outcome on SYMPH-962.

---

## 5. Carry-forward to Phase-B (NOT discharged in the gate)

The parent plan requires a **precision / false-positive floor** and a **per-closeout token budget** "before the first measured run." Rev 1 set these in the gate; the review found that wrong — they tune an extractor that doesn't exist yet, can't fail-honestly at gate time, and never feed the BUILD/NO-BUILD decision. So:

- **Precision floor → Phase-B planning's first task.** Its one gate-time input is captured here: the Step-1 over-extraction rate (share of labeled "decisions" that were rejected options / restatements), per recoverable class. Do **not** commit a number (e.g. "90%") at gate time.
- **Token budget → Phase-B.** The only gate-time obligation is a **rough order-of-magnitude sanity check** that a closeout plausibly sits under the parent plan's ~5M-per-scan ceiling. Estimate from **post-fence semantic size** (transcript turns after stripping/redacting tool-result payloads, which R12 excludes from atoms) — *not* raw JSONL token count, which is dominated by tool-result bulk and over-estimates by a large factor. The chunk/merge cost model is a Phase-B output (the parent plan defers chunking strategy to planning).

---

## 6. Outputs / artifacts

1. Step-P pre-check result (both legs) — pass → proceed; fail → STOP.
2. Per-session classification table + tallies: `D`, `T`, `F` (report-only), `F*` (gating, with session provenance).
3. The ratified **BUILD / NO-BUILD / REDIRECT** outcome (+ re-test trigger if NO-BUILD), recorded on SYMPH-962.
4. The Step-1 over-extraction observation (the one input Phase-B's precision floor uses) + the order-of-magnitude token sanity check.

The Step-1 labeled atoms are a useful by-product that **may** seed the v1.1 golden corpus (R14) **if** BUILD is chosen — they are not a gate output and are not required to reach a verdict. **If retained, they must be redacted + in-project-scoped first (the Step-1 fence) and stored in a gitignored / access-controlled local location**, never committed or shared unredacted — they carry verbatim transcript spans.

---

## 7. Sizing & honesty carve-outs

- **Effort:** realistically **~1–1.5 days**, not half a day — Step 1 requires end-to-end reads of 3–5 long (≈100k–400k-token) decision-dense sessions, six-class labeling with redacted spans, per-decision surface classification, and executed planner-flip runs. Budgeting half a day risks the gate being rushed or abandoned mid-way, which for a build-gating decision is the costly failure. A clean Step-P fail or an early `T ≈ 0` read can short-circuit it.
- **Two surface biases, named:** the in-flight gap (unreconstructable → conservatively not-covered) pushes toward TRANSCRIPT-ONLY/BUILD; the comment/edge `createdAt` rule (Step 3) removes the opposite backfill bias for those surfaces. Near any rate read the net is indeterminate — which is *why* the rule leans on the executed flip, not the rate.
- **Run-time ≠ session-time:** Step-P/Step-4 planner runs reflect in-flight/comment state at run time (§1), so a flip is an existence-proof under current conditions, not a session-time reconstruction.
- **Labeler variance:** the planner-relevance filter (Step 2) and bucket assignment are judgment calls. For a BUILD that hinges on one labeler's flip, have a second reader re-check that session before ratifying.
- **Gate-worth-running:** 962 post-collapse is a "lightweight emit," so confirm the build it gates costs materially more than the gate itself before running; if not, prefer build-and-measure-report-only.
- **Detects only verbalized decisions:** a decision the operator never verbalized leaves no trace in any transcript, so NO-BUILD is really **NO-BUILD-against-recoverable-loss** (R16) — accepted for v1.

---

## Grounding

- Plan: [2026-06-29-symph-962-closeout-capture-plan.md](2026-06-29-symph-962-closeout-capture-plan.md) (R2/R3/R5/R6/R8/R10–R13/R14/R16, KD1/KD4/KD8, Success Criteria, Outstanding Questions); [2026-06-28-backlog-intelligence-plan.md](2026-06-28-backlog-intelligence-plan.md) §1.1 (thin-CLI confound), §3 (Phase-0 gate), §9 (~5M ceiling).
- Code (verified 2026-06-29): `PlannerContext`/`buildPlannerPrompt` ([triage-planner.ts:125,:419](../../src/agent/triage-planner.ts)); `assembleShadowPlannerContext` ([standing-plan-shadow.ts:59](../../src/orchestrator/standing-plan-shadow.ts)); in-flight from `getState().running` ([runtime-host.ts:3628](../../src/orchestrator/runtime-host.ts)); `--runtime-state-base-url`→`GET /api/v1/state` ([manager-plan.ts:240,:663](../../src/cli/manager-plan.ts)) vs `--in-flight-state` Linear filter ([manager-plan.ts:244](../../src/cli/manager-plan.ts)); current-snapshot vs `since_seq` delta ([dashboard-server.ts:955,:979](../../src/observability/dashboard-server.ts)); `comment_enrichment: true` ([WORKFLOW-symphony.md:32](../../pipeline-config/workflows/WORKFLOW-symphony.md)).
- Review provenance: Rev 2 incorporates a 6-lens `ce-doc-review` (2026-06-29) — coherence, feasibility, adversarial, scope-guardian, product-lens, security — with the three code-level findings independently verified against source.
