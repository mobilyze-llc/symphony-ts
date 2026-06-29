# Backlog Intelligence — Design Plan (Rev 2, post-review)

> **Status:** DRAFT · pre-commitment. Rev 2 incorporates the 2026-06-28 `ce-doc-review` (6 reviewers). **The §4 extraction engine is now explicitly GATED on a Phase-0 activation experiment (§3)** — two reviewers independently showed the original premise was measured against a deliberately-thin CLI, not the live planner.
> **Date:** 2026-06-28 · **Authors:** Eric (operator) + Claude (design session)
> **Grounding:** symphony-ts codebase, current `origin/main`; a dogfood run of `symphony-manager-plan --project 9c1064215e8d` (note: that run used the thin CLI context — see §1.1).
> Open review findings not yet folded into the design live in **Deferred / Open Questions** at the bottom.

## 0. TL;DR

The goal is a **"backlog intelligence"** capability that (a) keeps Symphony's structured surfaces dense and current so the planner can be trusted, and (b) stops the operator being the lossy cross-session memory. But the review surfaced that the evidence for *needing a new engine* is confounded. So this plan is now two-staged:

- **§3 Phase 0 (the gate):** activate what's already built but dormant — wire the hygiene lane to a tick, enable comment-enrichment + in-flight context in the planning path — and **re-run the dogfood.** Reclassify each planner misjudgment as fixed-by-existing-context, fixed-by-one-Linear-edge, or genuinely-needs-extraction.
- **§4 The engine (CONDITIONAL):** build the extraction-and-promotion engine **only for the misjudgments Phase 0 does not recover.** If Phase 0 recovers them all, this block collapses to "activate what exists" and the engine is not built.

**Resolved this session:** the canonical store is a **markdown document in a stable project directory** (committed → git is the journal/provenance; human-legible; agents read/write files reliably; not an attack surface). **Two hard success criteria (operator-stated):** plans must be **trustworthy**, and a scan on a fast-moving backlog must **not burn ~5M tokens.**

## 1. Problem (grounded)

**1.1 The planner misjudges — but the dogfood that "proved" it ran a thinner context than the live planner.** A `symphony-manager-plan` run over this project's 34-ticket backlog scheduled SYMPH-941 (parked-in-a-comment that day), scheduled SYMPH-877/878 while excluding the SYMPH-947 work they're the first slice of, and couldn't sequence 839 after the in-flight 950. **But** that CLI hardcodes `inFlight: []` (`src/cli/manager-plan.ts:321`) and does not enable comment-enrichment, whereas the **live** shadow tick populates real in-flight (`src/orchestrator/runtime-host.ts:6195`) and runs comment-enrichment enabled in prod (`pipeline-config/workflows/WORKFLOW-symphony.md:32-33`, SYMPH-916). So at least two of the three failures are plausibly *empty-input / unfetched-comment* artifacts, not evaporated decisions: "839 after 950" needs the in-flight list the CLI zeroed; "parked-941" needs the comment the live tick already fetches. Only **877↔947** plausibly survives as genuinely-missing structure — and its remedy is "write one Linear `relates`/`blockedBy` edge," not a new engine. **The premise "every misjudgment was a missing decision, not a missing capability" is therefore a HYPOTHESIS to be tested by §3, not an established fact.** [adversarial + product-lens, ce-doc-review]

**1.2 The audit and planner are two disconnected generations that duplicate work** (verified accurate by the feasibility reviewer).
- Audit (Queue Triage v1): `src/audit/backlog-audit.ts` (1,345 LOC) detects `duplicate · supersession · stale · thin_spec · review_dispatch_mismatch`; `src/audit/backlog-audit-cli.ts` is registered as a `symphony-backlog-audit` bin in `package.json` but is **not symlinked into `~/.local/bin`** like `manager-plan`, and is run ad-hoc, not on a tick.
- Hygiene lane: `src/orchestrator/backlog-hygiene.ts` (530 LOC) runs the audit + **deep** code-grounding (`runManagedCodeGrounding`) into operator-gated proposals — but is **not wired to any runtime tick** (`runBacklogHygieneProposalLane` has only test callers). Its evaluation dimensions (`QUEUE_TRIAGE_EVALUATION_DIMENSIONS`) include `ordering · consolidation · parallelization` — the planner's exact job.
- Planner (Queue Triage v2): `src/agent/triage-planner.ts` reads the backlog with **shallow** grounding (`extractGroundingPathHints`).
- The enrichment family (SYMPH-874/895/896/939) is a built, partly-deployed comment/path/health grounding layer that overlaps what the hygiene lane already does deeply.

**1.3 Facts/decisions rot because prose stores premise-free conclusions with no binding and no re-validation** — the "stale/conflicting comments bite us" failure. Archetype (real, SYMPH-838): a ticket with **3 formal items whose comments reveal a 4th (`--no-canary`) shipped unlisted**, item 1 shipped elsewhere (SYMPH-858), an operator rationale dropped, two same-day comments contradicting on whether `--project` "matches the live view," and a `--limit N` follow-up named but never filed. None of it is in the ticket's *structure*.

**1.4 The human is the lossy carrier.** Decisions made in sessions are stored only in the operator's memory; the surface exceeds what any human — or cold agent — can hold. *Two sessions independently recommended standardizing the handoff; the convergence is recorded nowhere.*

## 2. Thesis

**Don't (necessarily) build an engine. First make the existing structured surfaces dense by activating what's dormant; build new extraction only for the gap that remains.** Where extraction is needed: distill the *disposable* prose stream (comments, plans, sessions, handoffs) into *structured* truth — once, idempotently, with provenance — re-validated against live state. Prose is INPUT, never required reading. Prune and schedule are two heads over one grounding pass. The human authors architectural/novel decisions and ratifies atoms; even that authoring is captured.

## 3. Phase 0 — the activation experiment (the GATE) ⭐

**Cost: low (wiring + one re-run). Value: decides whether §4 is needed at all.** None of this builds the engine.

1. **Wire the dormant hygiene lane to a tick** (the scheduler hook missing in `runtime-host.ts`), report-only.
2. **Thread the existing enrichment into the planning entrypoint(s):** populate real `inFlight`, enable comment-enrichment, in the `manager-plan` CLI path (so the dogfood matches the live tick).
3. **Re-run the dogfood** over the same 34-ticket backlog through the now-equivalent context.
4. **Reclassify** each of the three misjudgments (and any new ones) as:
   - **(a)** recovered by existing-but-unwired context (→ no new work; just wire it),
   - **(b)** recovered by writing one Linear edge/relation (→ a hygiene-lane projection, not an engine),
   - **(c)** genuinely needs structured extraction the existing surfaces can't provide.
5. **Gate:** the §4 engine is built **only** for category (c). If (c) is empty, this block is done at Phase 0.

**Pass/fail line:** Phase 0 *succeeds at collapsing the block* if zero category-(c) misjudgments remain after the live-equivalent re-run. It *justifies the engine* only if ≥1 category-(c) misjudgment persists, named explicitly with the structure it would have needed.

## 4. The engine — CONDITIONAL on Phase 0 leaving category-(c) gaps

Everything here is contingent. Read as "if Phase 0 proves extraction is needed, this is the shape."

**4.1 The extraction contract (the atom).**
```
{ type, claim, subject, provenance{source, author, date, span},
  premise{depends_on, trigger}, supersedes[], confidence, mutation, disposition }
```
- `type` ∈ `state_fact · relation · decision · new_work · rationale_superseded · open_question`.
- `mutation` = the concrete structural change the atom maps to (a Linear edit, or a line in the markdown store) — the field the prune/schedule heads execute. *(Defined per coherence finding.)*
- Three rules: (1) **provenance is mandatory and is the anti-duplication key** — an atom whose `(subject, claim)` already matches structure is a no-op/update; (2) **deliberation model** — later + higher-authority supersedes, where **authority comes from the verified Linear actor type (human vs bot), not prose self-labeling** *(security finding)*; (3) **premise binds a trigger** — but see §4.4 on which premises are mechanically checkable.

**4.2 Two heads, one spine.** One enrich+ground+relate pass; a prune head and a schedule head read it. **Open:** prune needs *deep* grounding (clone+verify), schedule needs *shallow* — so "ground once" is really a cheap shared base + an on-demand deep layer the prune head triggers (cost reflected in §7 R6). Scheduling is deterministic-first; LLM only on grounding deltas.

**4.3 Canonical store — RESOLVED.** A **markdown document in a stable project directory** (e.g. `docs/backlog-intelligence/`), **committed to git** — so git provides versioning, diff, and blame-as-provenance, and the store is human-legible *and* reliably agent-readable. The high-frequency derived grounding *cache* may be a gitignored sibling (disposable, regenerable); the *decision/fact residue* is committed. **Ticket-level structural conclusions** (state, `blockedBy`/relations, splits, priority) project **one-way** to Linear (auto-applied per §4.5); Linear is never a competing source of truth for the derived layer. **Store poisoning is out of scope** — it is the operator's own trusted project directory, not an attack surface (operator decision).

**4.4 Staleness via premise-binding — with an honest carve-out.** Volatile conclusions ("839 after 950") are never stored; they're re-derived each scan from durable premises. **But premises split two ways** *(scope-guardian + adversarial)*: **mechanically-checkable** ("is 950 open? is core.ts >15k LOC? did a model ship?") — re-validated cheaply, generalizing the *spirit* (not the code) of `evaluateReplanPredicates` — and **LLM-judged** ("does 950's extracted predicate still subsume 839's need?") — which cannot be cheaply re-validated and either rot or re-incur LLM cost. The design MUST classify each premise and route LLM-judged premises to the operator queue rather than silently trusting or silently re-spending. The mechanically-checkable fraction is the number the whole anti-staleness claim turns on — measure it on the SYMPH-838 corpus before committing.

**4.5 Disposition tiers + a graduation gate** *(scope-guardian + adversarial + product-lens)*. `auto_apply` · `propose` · `flag_operator`. Auto-apply is **NOT** justified by the old planner's "never overridden" record (that was the *operator* authoring edits over shallow grounding; it doesn't transfer to a new engine's output distribution). So: **start every conclusion-type as `propose`; graduate a type to `auto_apply` only after a measured ratification floor** (e.g. N≥10 operator-ratified proposals with zero corrections, tracked in the markdown store's provenance log). **Never auto-apply an irreversible mutation** (close/merge a ticket) from a session-derived atom. Auto-apply requires full provenance + a *reversible* mutation — and "reversible" means a single idempotent inverse with no downstream side-effect (a `blockedBy` edge qualifies; a webhook-triggering close does not).

**4.6 Untrusted-input fence — REQUIRED** *(security P0)*. Ticket comments, external session logs, and non-system-authored handoffs are **untrusted**. Atoms derived from them MUST pass through the existing-style untrusted-data fence (analogous to SYMPH-897 in `triage-planner.ts`) and may auto-apply only if their *entire derivation chain* stayed fenced. A crafted comment (`Correction: SYMPH-950 is Done…`) must not become a high-authority auto-applied atom. This is independent of the engine's justification — it's a hard requirement wherever untrusted prose feeds a mutation.

**4.7 Session/handoff closeout — PHASE 2+, not in the first slice** *(scope-guardian + security)*. The JSONL front-end is the hardest, riskiest input (implicit/contrarian ratification; secrets and cross-project content in logs). It is explicitly *out* of the first build slice. When it lands it MUST: scope to the target project (reject cross-project), redact credential-shaped strings before any LLM pass, never promote raw tool-result content, and derive authority from verified actor identity. Standardizing the handoff doc (the two-sessions-converged item) belongs here.

## 5. Decisions made (record, so they don't evaporate)

| Decision | Rationale | Trigger that would reopen it |
|---|---|---|
| **§4 engine is GATED on Phase-0 (§3)** | the premise was measured on a thin CLI; activate-and-re-measure first | Phase 0 leaves category-(c) gaps |
| Canonical store = **markdown in a stable project dir, git-committed** | legible + agent-reliable + git = journal/provenance; not an attack surface | operator reverses |
| Store **poisoning out of scope** | operator's own trusted project dir | — |
| Untrusted *input* prose still **fenced** before auto-apply | input ≠ store; crafted comments are real | — |
| Auto-apply **ramps from propose**, never from a transferred track record; never irreversible-from-session | new author ≠ old author; R1 garbage risk | measured ratification floor met |
| SYMPH-947 (god-file decomp) **stands deferred** | too risky under current loop | next-gen models ship (~1-2 wks) |
| Linear graph-shaping auto-applies (mechanical types) | operator never overrides it | operator starts overriding |
| Build an **extraction engine, not a decision ledger** | a parallel store re-duplicates + rots | — |
| **Pressure-test before filing tickets** | done — this review | — |

## 6. Open forks → status

- **A. Canonical store** — RESOLVED (§4.3).
- **B. Auto-apply scope/ramp** — RESOLVED to propose-first + graduation gate (§4.5).
- **C. Build order** — RESOLVED: Phase 0 activation → conditional engine → session front-end last.
- **D. Unify vs keep separate** — partially resolved: Phase 0 wires the hygiene lane; full unification (its deep grounding becomes the shared spine) is decided *after* Phase 0 shows whether the engine is built. → Open Questions.
- **E/F/G** — see Deferred / Open Questions.

## 7. Risks

- **R1. Extraction promotes confident garbage.** The loudest prose is often the rejected option. Mitigation: §4.6 fence + §4.5 propose-first + provenance; build on settled comments before live sessions; Phase 0 may obviate it entirely.
- **R2. Operator-action queue becomes a firehose.** Mitigation: reconcile-then-surface; only material, unresolvable conflicts.
- **R3. The markdown store rots like comments did.** Mitigation: store premises+triggers, derive volatile conclusions, re-validate; the LLM-judged-premise carve-out (§4.4) is the sharp edge.
- **R4. Scope balloon.** Mitigation: Phase 0 first; session front-end deferred; engine conditional.
- **R6. Cost.** Deep grounding isn't free; "ground once" is a cheap base + on-demand deep layer (§4.2). Reconcile per-scan cost (comment fetch, premise re-validation) against the ~5M ceiling *with a stated budget* before the engine is built.

## 8. Relation to existing work

- **SYMPH-842** (Backlog, "Feed Linear document attachments (handoffs) into the planner context") — the consumer half; this is the producer.
- **HSUI-56** (Done, "Design decisions don't get promoted into surface specs (no closeout ritual)") — the same problem solved once in another team; mine for a reusable pattern.
- **SYMPH-796** (Track 3, partial-completion extraction) — *is* the promote-buried-facts-to-structure pattern; likely the first prune-head consumer.
- The **dormant audit/hygiene lane** + **standing-plan store** are the substrates Phase 0 activates and the engine (if built) extends — not rebuilds.

## 9. Success criteria (with thresholds)

1. **Trust:** zero scheduled tickets whose blocking/closing decision is recorded in structure the planner consumed, over a defined window (the Phase-0 re-run is the first measurement).
2. **Cost:** tokens per planner scan do not exceed a stated per-scan ceiling (itemize comment-fetch + premise-re-validation + any session pass against the ~5M target) — measured via `calibration/standing-plan-digest.ts` + run-journal.
3. **Memory:** `flag_operator` queue items decrease over N consecutive runs (measured from the markdown store).
4. The operator-action queue stays short and high-precision.
5. Agents reliably read/write the markdown store (fixed project path).

## 10. Questions for a future reviewer

Largely resolved above; remaining genuine open questions are in Deferred / Open Questions.

---

## Deferred / Open Questions

_From the 2026-06-28 `ce-doc-review`. Captured here; not yet folded into the design above._

- **Premise-checkability ratio (adversarial, P1).** What fraction of the SYMPH-838 decision-premises are mechanically checkable vs LLM-judged? This number decides whether §4.4's staleness model is cheap or re-incurs per-scan LLM cost. Measure before committing the engine.
- **Unify vs lighter-couple the hygiene lane (scope-guardian, P1).** After Phase 0, does the hygiene lane's `runManagedCodeGrounding` *become* the shared spine's deep-grounding pass (full unification), or feed proposals via Linear state (lighter coupling)? Decide post-Phase-0.
- **planner-comment-curation migration (scope-guardian, P2).** Does the engine consume `planner-comment-curation.ts` output as raw input (cheapest, no migration) or supersede it (migrate the three `standing-plan-shadow.ts` callers)?
- **"Wait one model cycle" inversion (product-lens, P2).** The cold-agent-recall and lossy-prose problems may shrink under the same next-gen models that unblock SYMPH-947 (~1-2 wks). Which parts of this block are durable regardless of model capability, and which should sequence behind that trigger?
- **Success-criteria thresholds (scope-guardian + adversarial, P2).** §9 now has thresholds; confirm the per-scan token ceiling number and the trust-window length before the first Phase-0 run, so the run can actually fail.
- **Coherence nits (P2, not yet applied):** "continuously distills" (§0/§2) reads as a daemon but the design is scan-triggered — reword if it misleads; the engine is described as conditional now, which partly resolves it.
- **Factual reconciliation (feasibility):** §1.2 now says `symphony-backlog-audit` is a registered bin but not symlinked into `~/.local/bin` — confirm against the actual install when tickets are filed.
