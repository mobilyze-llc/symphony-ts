---
title: Implement-Stage Closeout Comment — Design
type: feat
date: 2026-06-29
topic: symph-962-implement-closeout
artifact_contract: ce-unified-plan/v1
artifact_readiness: implementation-ready
product_contract_source: superpowers:brainstorming
parent: docs/plans/2026-06-29-symph-962-closeout-capture-plan.md
execution: code
revision: "Rev 1 (2026-06-29): incorporates a 5-lens ce-doc-review (coherence, feasibility, security, scope-guardian, adversarial). Corrected the P0 transport (the implement stage runs on the current-runner backend — the controller reads .symphony/closeout.md from result.workspace, NOT artifactRefs); deferred planner machine-consumption to v1.1 (enrichment does not refetch completed issues); hardened redaction; qualified cite-or-omit; simplified the v1 gate to an env/build constant; consolidated implementation units 5→4."
---

# Implement-Stage Closeout Comment — Design

## Goal Capsule

- **Objective:** Capture the consequential decisions a dispatched **implement**
  agent makes — most importantly the ones not obvious from the merged ticket —
  into a durable, structured `## Closeout` Linear comment, written *during* the
  session at decision-time and posted by the controller at stage end.
- **Product authority:** Eric (operator).
- **Primary consumer (v1):** a future implementer / cold-reading agent (and the
  operator) reading the comment off the ticket — the rich rationale.
  **Secondary consumer (v1.1):** the planner / auditor, machine-consuming the
  structured tail. v1 does **not** wire planner consumption — the live
  comment-enrichment path fetches comments only for *candidate-backlog* issues,
  not a just-completed one (see Dependencies), so a v1 closeout is read by humans
  and cold agents, not the planner. Planner consumption is a v1.1 build.
- **Why this shape (the pivot):** SYMPH-962's post-hoc transcript-mining approach
  was reshaped after two findings: (1) the Phase-A gate over operator desktop
  logs ran the wrong experiment and returned NO-BUILD; (2) the failure it was
  fighting — agents losing context on long sessions and being unable to author a
  rich report at the end — is *partly avoidable* for dispatched agents, because
  their behavior is programmable. So we capture at decision-time in the lane, not
  by reconstructing a transcript afterward. This is the "decision-time structured
  capture" alternative the parent plan named as the natural fallback once mined
  recall proved too low.

---

## Product Contract

### Summary

The implement stage maintains a cite-or-omit `closeout.md` in its workspace as it
works. On stage end the **controller** reads it off the run's workspace, applies a
secret-redaction pass, and posts/updates one idempotent `## Closeout` Linear
comment per issue. v1 is report-only (the comment only); no structural Linear
edges are projected, and the planner does not yet machine-consume it. This reuses
the idempotent sync-by-marker pattern (as `sync_workpad` uses for `## Workpad`);
the transport is a workspace-file read, not the crabrunner artifact mechanism (see
KTD1 — the implement stage runs on the `current-runner` backend).

### Problem Frame

When a dispatched implement agent makes a consequential design decision — chooses
an approach the ticket didn't propose, departs from the approach it did propose,
defers part of the scope, discovers a blocker or a landmine — that decision is
durable and planner/implementer-relevant, but it is under-recorded in
machine-usable form:

- The "file deferred work as Linear edges" discipline only fires when work
  *remains*; a design decision that *completes* the work leaves nothing for it.
- The merged ticket says "done" and still describes the original approach, so it
  can actively *mislead* a cold reader.
- The diff shows *what* was built, never *why-not-the-alternative*; that reasoning
  lived only in the agent's context and is gone by session end.
- The just-shipped spec-fidelity judge (SYMPH-971) *detects* AC divergence
  post-hoc but, by construction, cannot recover the *reason* — the reason isn't in
  the diff. Only the agent, at decision-time, has it. (Note: spec-fidelity judges
  the diff against the AC; it never reads the closeout, so it is **not** a
  correctness check on closeout content — see KD5.)

The hand-maintained evidence that this class is real and valuable: the
`CLAUDE.md` "Fragile areas" list ("`active_states` must include ALL states — hit
3 times") and the operator's memory files are exactly this kind of
implementer-discovered record, captured manually because the cost of not having
it was paid repeatedly.

### Key Decisions

- KD1. **Decision-time, in-lane capture — not post-hoc transcript mining.**
  The agent appends to `closeout.md` at the moment a decision is made, while
  context is fresh, because the dispatched agent's behavior is set by the stage
  prompt. This is more reliable than reconstructing at session-end, but it is
  **not free of the same failure**: prompt-mandated file maintenance still
  degrades under long-run compaction (an agent that loses early context can also
  forget to append). v1 accepts this as a **measured recall risk** (report-only
  spot-checks against the transcript), not a solved problem. The structured
  per-decision-emission alternative (the agent emits a tool-call/event per
  decision, the controller assembles) was considered and rejected for v1 — no
  tool-call/event channel is wired into the lanes today, and prose is richer for
  the implementer-first consumer — but it is the v1.1 fallback if measured recall
  is low. Capture-at-decision-time is still an anti-hallucination property:
  recording what just happened beats confabulating at the end.
- KD2. **The lane never writes to Linear; the controller does.** The lane writes
  only the workspace file; the controller reads, redacts, and posts. The
  controller-posts choice is **forced, not arbitrary**: the implement lane carries
  no Linear tracker client/credentials (the in-lane `sync_workpad` path is a
  codex-tool that the implement lane does not run), and redaction must be
  controller-side regardless.
- KD3. **Separate `## Closeout` marker, distinct from `## Workpad`.** The workpad
  is a *forward plan* (investigate handoff, read by implement and by spec-fidelity
  as `planNarrative`, and load-bearing for the investigate retry brake). The
  closeout is a *backward record*. A distinct marker reuses 100% of the
  sync-by-marker plumbing while avoiding two collisions: the investigate retry
  brake (a successful `sync_workpad` is treated as stage-complete) and the
  spec-fidelity plan-narrative input.
- KD4. **Implementer-first; planner is a cheap projection (deferred to v1.1).** A
  good reason-rich decision record contains everything the planner's structural
  view needs; the reverse is false. So the artifact is designed for the
  cold-reading implementer (rich rationale). The planner machine-consuming the
  structured tail is a v1.1 build — v1 does not wire it (see Goal Capsule /
  Dependencies).
- KD5. **Cite-or-omit is the load-bearing anti-hallucination rule — and it guards
  presence, not correctness.** Every *structured* entry must cite concrete
  evidence (a `file:line`, commit, ticket id, or specific failure) or it is
  omitted — this suppresses uncited claims. It does **not** verify the citation is
  *right*: a plausibly-wrong citation (a real `file:line` that doesn't actually
  support the claim, or an unrelated real ticket) passes. There is **no automated
  correctness check in v1** — spec-fidelity judges the diff, not the closeout — so
  v1 precision rests on manual spot-checks. A fabricated/wrong structural claim (a
  bad `blockedBy`) is worse than a missing one because it actively mis-sequences
  future work — the parent plan's R1 ("extraction promotes confident garbage")
  risk. Empty sections are the expected normal; inventing entries to fill the
  shape is a failure.
- KD6. **Fact and opinion are separate tiers.** Factual sections (decisions,
  deferrals, blocks, landmines) are evidence-bound. The **Assessment** is
  explicitly subjective (confidence, risk, hindsight) and is never projected to a
  structural mutation.
- KD7. **v1 is report-only.** The comment is the only output. Projecting the
  structured tail to native Linear edges (blockedBy / relates / supersedes) — and
  wiring planner consumption — is v1.1, and edge projection requires a
  verify-before-mutate gate on the cited relations. This follows
  `measure-before-caps` / `telemetry-before-consumer`: emit the records now,
  design the projection from observed records.
- KD8. **This replaces the Document-based closeout convention.** The
  reason-first comment, sourced at decision-time, is a better-sourced and leaner
  artifact than a session-end-authored Linear-Document closeout, on a surface
  agents can reliably write and humans/cold-agents already read. The on-demand
  HTML `ezra-session-report` (user-addressed, explicit-request-only) is
  unaffected. A git-committed markdown store (the parent plan's canonical store)
  is optional for v1 — the comment is the durable home; Linear is queryable if a
  corpus is later needed.

### The Closeout Schema

`## Closeout` marker, then a narrative **head** and a structured **tail**. Only
sections with grounded content appear (per-section, independent).

```markdown
## Closeout

**What shipped:** <capability delivered — a few sentences, not a diff restatement>

### Design decisions              — cite-or-omit; the centerpiece
- **<decision>**: chose <B> over <A/alternatives>. Reason <C>. Evidence: <file:line>.
  [⚠ diverges from ticket: proposed <X>]   ← flag only when it contradicts the ticket

**Assessment:** <honest opinion: confidence, what I'm least sure about, risks a
reviewer/future implementer should watch, hindsight, effort vs. expectation.>

### Deferred / not done
- **<item>**: not done — <why>. → <SYMPH-XXX / new ticket>. Evidence: <where>.
### Blocked / depends on
- blockedBy SYMPH-XXX — <why>. Evidence: <what surfaced it>.
### Belongs elsewhere
- relates/supersedes SYMPH-XXX — <what moved>. Evidence: <where>.
### Landmines
- `<file/area>`: <constraint a future implementer must know>. Evidence: <file:line>.
### Open questions
- <unresolved — independent of whether anything diverged>
```

- **Head = What shipped + Design decisions + Assessment.** The narrative prose
  (What shipped + Assessment together) prefers **5 sentences, 7 at most**. The
  Design-decisions list is bounded by cite-or-omit, not a sentence count, and is
  the centerpiece — it captures *all* consequential `decision` atoms, both
  in-latitude choices (the ticket was silent) and divergences (flagged).
- **Tail = Deferred / Blocked / Belongs elsewhere / Landmines / Open questions.**
  Each cite-or-omit and independent. Open questions and landmines can appear with
  zero divergences.
- **Empty case is per-section.** A "built as specified" session = full head (What
  shipped + Assessment), no Design-decision/Deferred/Blocked entries, but possibly
  Landmines / Open questions. It is never a single line.
- **Atom-type mapping (parent plan §4.1 / KD5 reuse):** Design decisions =
  `decision`; Deferred = `new_work` / `state_fact`; Blocked / Belongs =
  `relation`; Landmines = `state_fact`; Open questions = `open_question`.

### Requirements

**Capture (in-lane)**
- R1. The implement stage prompt instructs the agent to maintain
  `.symphony/closeout.md` *during* the run, appending entries at decision-time,
  not reconstructing at the end.
- R2. The prompt enforces cite-or-omit on every structured entry and states that
  empty sections are normal and inventing entries to fill the shape is a failure.
- R3. The prompt bounds the narrative prose (What shipped + Assessment together)
  to 5 sentences (7 max) — the Design-decisions list is bounded by cite-or-omit,
  not a sentence count — and forbids secrets, tokens, or raw logs in the file.
- R4. Design decisions capture both in-latitude choices and divergences;
  divergence is a flag on a decision, not a separate section.
- R5. The agent never writes to Linear; it only writes the local workspace file.

**Projection (controller)**
- R6. The implement agent writes `.symphony/closeout.md` into its run workspace.
  No `produces`/artifact declaration is used — it is inert on the `current-runner`
  backend the implement stage runs on (see KTD1).
- R7. On stage end the controller reads `.symphony/closeout.md` from the implement
  run's workspace (`result.workspace`), at the stage-finalization seam.
- R8. The controller redacts before posting: `sanitizeForLinear` (heuristic
  credential redaction) **plus** a deterministic denylist of the known runtime
  `.env` secret values (e.g. `LINEAR_API_KEY`), because the heuristic misses
  key-name variants and alphanumeric-only tokens (see KTD4). A secret that slips
  the agent must not reach the comment.
- R9. The controller posts/updates exactly one `## Closeout` comment per issue via
  sync-by-marker (find the service-account `## Closeout` comment → update; else
  create), reusing the `sync_workpad` idempotency pattern.
- R10. On rework, the latest implement run **replaces** the comment (it reflects
  what shipped, not a per-attempt log). **Accepted v1 limitation:** durable tail
  facts (landmines, open questions) a *superseded* attempt recorded may be lost;
  accepted because rework typically re-traverses the same area (landmines recur)
  and accumulate/merge adds dedup complexity not justified until measurement shows
  real loss. Accumulate-tail-on-rework is a v1.1 option. *(Judgment call — see
  Open Questions; flip to accumulate if you prefer no-loss over simplicity.)*
- R11. Post on any run that produced a non-empty `closeout.md`, including
  blocked/failed implements. Absent, or empty/whitespace **after redaction** → no
  post (fail-open). The empty check runs *after* redaction so an all-secrets file
  that redacts to nothing posts nothing.
- R12. v1 projects **only** the comment — no native Linear edges, no planner
  consumption. (Edge projection + verify-before-mutate gate, and planner
  consumption, are v1.1.)

**Boundaries**
- R13. Distinct `## Closeout` marker; the `## Workpad` comment, the investigate
  retry brake, and spec-fidelity's `planNarrative` input are untouched.
- R14. v1 covers the implement stage only.

### Key Flows

- F1. Implement-stage closeout
  - **Trigger:** decision-time, throughout the implement run (R1).
  - **Steps:** agent appends cite-or-omit entries to `.symphony/closeout.md` as
    decisions are made → adds the bounded narrative head at stage end → the run
    finishes with `closeout.md` in the workspace → at stage finalization the
    controller reads it from `result.workspace`, redacts, and posts/updates the
    `## Closeout` comment.
  - **Outcome:** the ticket carries a durable, structured record of the
    consequential decisions, readable cold by a future implementer / the operator;
    nothing irreversible was mutated. (Planner machine-consumption is v1.1.)

### Acceptance Examples

- AE1. **Covers R1, R4.** A design decision made early in a long implement run
  (e.g. "put the brake in runtime-host, not the prompt") appears in the closeout
  because it was appended at the moment, not reconstructed from compacted context.
  *(Recall of this is the measured v1 risk per KD1.)*
- AE2. **Covers R4.** An in-latitude choice the ticket was silent on is recorded
  as a Design decision with no divergence flag; a choice that contradicts the
  ticket carries `⚠ diverges from ticket`.
- AE3. **Covers R2, KD5.** A run that built exactly what the ticket asked produces
  a closeout with What-shipped + Assessment and no Design-decision entries — no
  invented divergence.
- AE4. **Covers R8, R11.** A `closeout.md` whose content is entirely
  credential-shaped redacts to empty → no comment is posted (empty check runs
  after redaction). A secret embedded among real content is redacted and never
  reaches the comment.
- AE5. **Covers R9, R10.** Two implement runs on one issue yield exactly one
  `## Closeout` comment, updated to the second run's content.
- AE6. **Covers R11.** A blocked implement that recorded "couldn't proceed because
  X — evidence: file:line" still posts a closeout.

### Success Criteria

**v1**
- Capture-at-source: decisions made early in long runs survive in the closeout,
  measured against the run transcript on spot-checks. Recall is a *measured risk*
  (KD1), reported, not asserted.
- Precision: cite-or-omit suppresses uncited structural claims; citation
  *correctness* is checked only by manual spot-check in v1 (no automated check —
  KD5). Report-only first per `measure-before-caps`.
- Replaces the convention: implement closeouts land as `## Closeout` comments; the
  Document-based closeout is retired for this path.
- Cost: per-run closeout token cost is itemized and bounded; report-only first.

**v1.1**
- Planner consumption: the structured tail is fetched for a completed issue and
  machine-consumed by the planner/auditor (needs new wiring — enrichment does not
  refetch completed issues today).
- Edge projection: the structured tail projects to native Linear edges behind a
  verify-before-mutate gate; a captured atom is traceable to a planner candidate
  that cites it.
- Recall measurement: per-atom-type recall against a labeled corpus seeded from
  real closeout runs.

### Scope Boundaries

**Deferred to v1.1+**
- Planner machine-consumption of the closeout (fetch the completed issue's comment
  into `PlannerContext`; the live enrichment path fetches only candidate-backlog
  issues). When wired, `renderCandidateComments` must also apply redaction — today
  it only whitespace-normalizes comment bodies before the planner prompt.
- Projection of the structured tail to native Linear edges + the
  verify-before-mutate gate (R12).
- Accumulate/merge durable tail facts across rework attempts (R10 v1 replaces).
- Structured per-decision-emission capture channel (the KD1 fallback if recall is
  low).
- Recall measurement / golden corpus (needs real closeout runs to seed).
- A git-committed markdown store (optional; the comment is the v1 home).

**Outside this work**
- Investigate / review / merge closeouts (implement-only in v1).
- Post-hoc transcript mining (superseded by decision-time capture).
- Linear Documents as the transport (superseded by the comment; SYMPH-842 not
  built).
- The on-demand HTML `ezra-session-report` (unchanged, explicit-request-only).
- Any ticket create/close/merge execution (a downstream concern; the closeout
  records, it does not act).

### Dependencies / Assumptions

- The implement stage runs on the **`current-runner`** backend
  (`StageExecutionJobSpec.backend` defaults to `current-runner`; only the *review*
  stage opts into crabrunner via `review_execution.crabrunner_job_group`). The
  current-runner result exposes the run's **workspace (`result.workspace`)** but
  **no `artifactRefs`/tar bundle** — only crabrunner review/spec-fidelity lanes
  populate `artifactRefs`. So the controller reads `.symphony/closeout.md` off the
  workspace, not from artifacts.
- The implement prompt is rendered controller-side and delivered to the run; the
  U1 capture block reaches the agent that way (independent of backend).
- The live comment-enrichment path (`comment_enrichment: true`) fetches comments
  only for **candidate-backlog** issues (non-in-flight), **not** a just-completed
  one. A done/merged issue is not refetched, so its `## Closeout` is **not** read
  by the planner in v1 — v1's consumer is the durable cold read of the comment.
  Planner consumption is a v1.1 build.

---

## Planning Contract

**Product Contract preservation:** changed during the 2026-06-29 ce-doc-review —
R6/R7/R8/R10/R11/R12 and KD1/KD2/KD4/KD5 were corrected (transport, planner-
consumption deferral, redaction, cite-or-omit, rework). The product *intent*
(decision-time capture → durable `## Closeout` comment, implementer-first,
report-only) is unchanged; the corrections fixed grounding and over-claims the
review surfaced.

**Depth:** Standard · **Type:** feat. Crosses prompt → lane → controller →
Linear; the product design is settled, 4 units.

### Key Technical Decisions

- **KTD1 — Transport is a workspace-file read; `closeout.md` is opportunistic and
  fail-open.** The implement stage runs on the `current-runner` backend, whose
  result exposes `result.workspace` but no `artifactRefs`. The controller reads
  `.symphony/closeout.md` off the workspace at stage finalization; absence or
  emptiness is a no-op (R11). There is **no** `produces`/artifact declaration — it
  is inert on current-runner (and the decomposed `verifyProducedCapsules`
  fail-closed check keys on the unrelated `capsules.produce` field, not
  `artifacts.produces`, so it never applied here). *If the implement stage is ever
  moved to a crabrunner backend, this transport must be revisited (the artifactRefs
  path would then apply).*
- **KTD2 — Controller posts; the lane is read-only to Linear (forced).** The
  implement lane carries no Linear tracker client/credentials, so posting must be
  controller-side; redaction is controller-side regardless.
  `LinearTrackerClient.postComment` (create) exists
  (`src/tracker/linear-client.ts:579`); the update-by-marker half is added in U2.
  The controller's client must resolve the service-account viewer id for
  author-scoping (verify it exposes a viewer query).
- **KTD3 — Idempotent `## Closeout` upsert reuses the workpad pattern.** Fetch
  comments → find the latest service-account comment whose body starts with
  `## Closeout` → `commentUpdate` if found, else create. Port the
  find-by-marker + author-scoping + `COMMENT_UPDATE_MUTATION` logic from
  `src/codex/workpad-sync-tool.ts`. Author-scoping ensures operator comments are
  never clobbered.
- **KTD4 — Redaction = heuristic + deterministic denylist; specify the length
  cap.** Apply `sanitizeForLinear` from `src/shared/egress.ts`, but its
  `redactSecretAssignments` only matches `token/secret/password/apikey` key-names
  and `BASE64_RUN_REGEX` requires a digit + non-alphanumeric char — so
  `ANTHROPIC_KEY`/`SSH_PRIVATE_KEY`-style names, prose-embedded secrets, and
  alphanumeric-only tokens slip. Add a **deterministic denylist of the known
  runtime `.env` secret values** before the heuristic pass, and record the
  heuristic's residual limits as a known v1 risk. Pass an **explicit length cap**
  (the `DEFAULT_LINEAR_MAX_LEN = 2000` default truncates a multi-section closeout)
  sized to the bounded schema (≈16k chars, well under Linear's comment limit), and
  **drop whole tail sections head-first** rather than byte-slicing (a byte-slice
  can bisect a `blockedBy` line — re-introducing confident garbage at the egress
  boundary).
- **KTD5 — v1 gate is an env/build constant, not a per-workflow config flag.** For
  report-only v1 with no live planner consumer to widen to, a full per-workflow
  config-shape + resolver + WORKFLOW change is premature surface. Gate U3's hook on
  an env/build constant (e.g. an env var, or an inline `workflow.name ===
  "symphony"` check). The real per-workflow `closeout_comment` config flag is
  v1.1, added once measurement justifies widening.
- **KTD6 — Decomposed/capsule path deferred.** The decomposed sub-stage path
  (SYMPH-856/857) drops comment/workpad context for capsule handoff and is not the
  v1 target; if symphony migrates implement to it before v1.1, the workspace-read
  transport must be re-checked.

### High-Level Technical Design

```mermaid
sequenceDiagram
  participant A as Implement agent (lane)
  participant W as Run workspace (.symphony/closeout.md)
  participant C as Controller (runtime-host, stage finalization)
  participant K as Linear (## Closeout comment)
  A->>A: append cite-or-omit entries at decision-time
  A->>W: stage end — closeout.md left in the workspace
  C->>W: read result.workspace/.symphony/closeout.md (skip if absent/empty)
  C->>C: redact (sanitizeForLinear + .env denylist); empty-after-redaction → stop
  C->>K: upsert ## Closeout by marker (create or update; author-scoped)
```

---

## Implementation Units

### U1. Closeout-capture block in the implement prompt

- **Goal:** The implement agent maintains `.symphony/closeout.md` at decision-time
  per the schema, and writes only that local file.
- **Requirements:** R1, R2, R3, R4, R5; KD1, KD5.
- **Dependencies:** none.
- **Files:** `pipeline-config/prompts/implement.liquid` (add block);
  `tests/agent/prompt-builder.test.ts` (assert the block renders).
- **Approach:** add the `## Closeout capture` block (the trigger wording in the
  Product Contract). Static text — introduces no new LiquidJS variables, so
  `strictVariables` is unaffected. Mirror the existing output-discipline / workpad
  instruction style already in the prompt.
- **Patterns to follow:** the existing instruction sections in
  `pipeline-config/prompts/implement.liquid`; the shared output-budget block in
  `pipeline-config/prompts/global.liquid`.
- **Test scenarios:**
  - Covers R1, R4. Rendering the implement-stage prompt includes a
    `## Closeout capture` section instructing decision-time capture to
    `.symphony/closeout.md`, with the Design-decisions + divergence-flag guidance.
  - Covers R2. The rendered block states cite-or-omit and "empty sections are
    normal; do not invent entries to fill the shape."
  - Covers R3. The block states the 5-sentence (7 max) narrative bound and forbids
    secrets, tokens, and raw logs.
  - Covers R5. The block instructs writing only the local file — no Linear-write
    directive appears in it.
  - The implement prompt still renders under `strictVariables: true` with the
    standard render context (no new undefined variables).
- **Verification:** the implement prompt renders with the block present; existing
  prompt-builder render tests pass.

### U2. Idempotent `## Closeout` comment upsert on the tracker client

- **Goal:** A controller-side upsert that creates or updates the single
  service-account `## Closeout` comment per issue.
- **Requirements:** R9, R10; KD2; KTD3.
- **Dependencies:** none (parallel to U1).
- **Files:** `src/tracker/linear-client.ts` (add an upsert-by-marker method);
  `tests/tracker/linear-client.test.ts`.
- **Approach:** fetch issue comments → find the latest comment authored by the
  service account whose body starts with `## Closeout` → `commentUpdate` if found,
  else create via the existing `postComment`. Port `findExistingWorkpadComment` +
  `COMMENT_UPDATE_MUTATION` + viewer-id author-scoping from
  `src/codex/workpad-sync-tool.ts`. Confirm `LinearTrackerClient` can resolve the
  service-account viewer id for scoping.
- **Patterns to follow:** `src/codex/workpad-sync-tool.ts`; existing `postComment`
  / `fetchIssueComments` in `src/tracker/linear-client.ts`.
- **Test scenarios:**
  - Covers R9. No existing `## Closeout` comment → creates one.
  - Covers R9, R10. An existing service-account `## Closeout` comment → updates it
    (one comment, not two).
  - Author-scoping: an operator-authored `## Closeout`-shaped comment is NOT
    updated or clobbered.
  - Idempotent: two upserts with the same body → a single comment, no duplicate.
- **Verification:** linear-client tests assert create-when-absent,
  update-when-present, and author-scoping.

### U3. Post-implement workspace read + redact + post (controller hook)

- **Goal:** At implement-stage finalization, read `.symphony/closeout.md` from the
  run workspace, redact it, and upsert the `## Closeout` comment — gated on the v1
  env/build constant.
- **Requirements:** R6, R7, R8, R10, R11, R12; KD2, KD7; KTD1, KTD4, KTD5.
- **Dependencies:** U2.
- **Files:** `src/orchestrator/runtime-host.ts` (post-implement finalization
  hook); `tests/orchestrator/runtime-host.test.ts`.
- **Approach:** add a post-implement seam in the worker-execution finalization path
  (no such hook exists today for non-review stages — spec-fidelity is a separate
  review-lane invocation, not a pattern to extend). Read
  `result.workspace/.symphony/closeout.md` from disk. If absent → no-op. Redact
  with `sanitizeForLinear` + the `.env` denylist (KTD4) at an explicit length cap
  with head-first section drop; if the result is empty/whitespace **after
  redaction** → no-op (fail-open, R11). Else call the U2 upsert. Post on any run
  with non-empty post-redaction content, including blocked/failed implements. v1
  posts only the comment — no Linear edges, no planner wiring (R12). Gate the whole
  hook on the v1 env/build constant (KTD5).
- **Execution note:** the finalization seam and the guarantee that the workspace is
  still readable at that point (after any post-stage git-sync/cleanup) are the
  key implementation-time discoveries — see Open Questions.
- **Patterns to follow:** how `runSpecFidelityLane` results are recorded in
  `src/orchestrator/runtime-host.ts` (for the recording shape, not the transport);
  `sanitizeForLinear` in `src/shared/egress.ts`.
- **Test scenarios:**
  - Covers R11. Absent `closeout.md` → no comment posted.
  - Covers R8, R11. An all-credential `closeout.md` redacts to empty → no post
    (empty check after redaction). A secret among real content is redacted out.
  - Covers R7, R10. Non-empty (post-redaction) content → upserts the `## Closeout`
    comment with the redacted body.
  - Covers KTD4. A full multi-section closeout exceeding the cap drops whole tail
    sections head-first and is not byte-sliced mid-entry.
  - Covers AE6. A blocked implement that produced non-empty content still posts.
  - Covers AE5, R10. Two implement runs → one comment, updated to the latest.
  - Covers R12, KTD5. With the gate constant off → no post; no Linear edges in any
    case.
- **Verification:** runtime-host tests assert the read → redact → upsert path, the
  fail-open no-ops (absent, empty-after-redaction, gate-off), and the cap behavior.

### U4. v1 enable constant for symphony

- **Goal:** Turn the closeout hook on for symphony via the v1 env/build constant
  (not a per-workflow config flag).
- **Requirements:** R12; Success Criteria (report-only); KTD5; KD7.
- **Dependencies:** U3.
- **Files:** the constant/env wiring U3 checks (in `src/orchestrator/` or config
  surface, minimal); `pipeline-config/run-pipeline.sh` or the symphony launch env
  if an env var is used; relevant test.
- **Approach:** enable the gate for symphony only, via the smallest mechanism
  (env var or inline workflow-name check). No new config-shape/resolver surface —
  that is the v1.1 per-workflow flag.
- **Test scenarios:**
  - Constant/env off → U3 hook does not post (default).
  - On for symphony → posts.
- **Verification:** the gate test asserts off-by-default and on-for-symphony.

---

## Verification Contract

Project gates (must all pass — see `CLAUDE.md`):

- `pnpm exec vitest run` — all tests pass (use `vitest run` directly in a
  worktree; the `pnpm test` pretest can fail on operator skill drift).
- `pnpm build` — compiles without errors.
- `pnpm typecheck` — no type errors.
- `pnpm lint` — Biome passes.

Dogfood (manual, report-only): run one symphony implement on a test ticket with
the gate on; confirm a single `## Closeout` comment appears, is updated (not
duplicated) on a re-run, and that an injected secret (including a non-`KEY=value`
prose secret and the literal `.env` `LINEAR_API_KEY` value) is redacted.

---

## Definition of Done

- All four units landed with their test scenarios; every Verification Contract
  gate is green.
- A symphony implement run produces a `## Closeout` comment (report-only): present
  when the agent recorded content, read from the run workspace, idempotent on
  rework (replace), redacted (heuristic + `.env` denylist, empty-after-redaction
  fail-open), and capped without bisecting a structured entry.
- No Linear edges are projected and the planner does not machine-consume the
  closeout (v1 boundary holds); the on-demand HTML report and the now-retired
  Document closeout are unaffected.
- The hook is gated by the v1 env/build constant, off by default except symphony.

---

## Open Questions

- **Workspace availability at finalization (U3).** Does the controller retain
  readable access to the implement run's workspace at the finalization seam, after
  any post-stage git-sync/cleanup hook? If the workspace is reset/synced before the
  read, `.symphony/closeout.md` may be gone — resolve before U3.
- **Rework workspace state (R10).** On a rework attempt, is `.symphony/closeout.md`
  from the prior attempt carried forward or wiped? Confirms the "latest run
  replaces" semantics read the correct attempt's file.
- **Rework tail-handling (judgment call, R10).** v1 replaces the whole comment,
  accepting possible loss of a superseded attempt's durable tail facts. Confirm
  this, or elect accumulate/merge-tail (more complexity, no loss).

---

## Grounding (verified 2026-06-29; transport corrected by 2026-06-29 review)

- Mechanism precedents: `sync_workpad` idempotent marker comment
  (`src/codex/workpad-sync-tool.ts`); `sanitizeForLinear` credential redaction
  (`src/shared/egress.ts`); `LinearTrackerClient.postComment` create
  (`src/tracker/linear-client.ts:579`).
- Backend reality (review finding): the implement stage runs on the
  `current-runner` backend (`StageExecutionJobSpec.backend` default); only the
  *review* stage opts into crabrunner. `current-runner` returns `result.workspace`
  but no `artifactRefs` — so the closeout transport is a workspace-file read, not
  the spec-fidelity artifact mechanism.
- Read/dispatch path: controller assembles `implementationCommentDeltas` /
  `workpadContext` (`src/orchestrator/runtime-host.ts:4746`); decomposed sub-stage
  path drops comment/workpad context for capsule handoff
  (`src/orchestrator/decomposed-stage-dispatch.ts:262`).
- Prompt: `pipeline-config/prompts/implement.liquid` (capture block added here).
- Parent: `docs/plans/2026-06-29-symph-962-closeout-capture-plan.md`
  (KD reuse §4.1 atom vocabulary, R1 confident-garbage risk); SYMPH-971
  spec-fidelity lane (detection complement; does not read the closeout).
- Review provenance: Rev 1 incorporates a 5-lens `ce-doc-review` (2026-06-29) —
  coherence, feasibility, security, scope-guardian, adversarial — with the P0
  transport and security/redaction findings verified against source.
