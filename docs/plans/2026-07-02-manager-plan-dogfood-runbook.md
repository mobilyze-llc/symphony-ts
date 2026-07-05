# Manager-plan CLI dogfood runbook — 2026-07-02

> **Status:** LIVE (dogfood in progress) · **Owner:** this session
> **Purpose:** Exercise the enriched `symphony-manager-plan` CLI end-to-end on the real
> Autonomous Backlog Manager backlog, now that the auditor→planner merge (SYMPH-1014) has
> landed, and capture what the planner actually produces so we can judge whether it is good
> enough to plan real session-orchestrator batches. This is the "read the data" step, not a
> build step. Artifacts (prompts, plans, review JSON) live in the session scratchpad and are
> referenced by path; distilled findings live here.

## What we are exercising (capabilities landed since last checkpoint)

| Capability | Ticket | How it engages in the CLI |
|---|---|---|
| Audit/supersession dispositions prune candidate set | SYMPH-1014 / SYMPH-983 | **Unconditional** — `buildShadowPlannerSupersessionRelationDispositions` → `assembleShadowPlannerContext` (manager-plan.ts:644) |
| Relations beyond blockedBy (relates/duplicate/supersedes/parent-child) | SYMPH-1020 | Fed into the same disposition + context assembly |
| Curated comment enrichment | SYMPH-874/896 | **Default ON**; disable with `--no-comment-enrichment` (manager-plan.ts:688) |
| Deep code-grounding (clone+verify + central LLM extractor) | SYMPH-1017 | **Opt-in, report-only** via `--planner-grounding` (manager-plan.ts:710); grounds every candidate (loop at :1216) |
| Doc-following (filesystem + attached-doc references) | SYMPH-1017 | `followGroundingDocs` reads from `process.cwd()` (:1236) — local, no clone |
| De-truncation caps (25k field / 100k aggregate) | SYMPH-1015 | Always applied in prompt assembly |
| Decorrelated plan review (Tier-1 floor + Tier-2 council) | SYMPH-1029 / SYMPH-1032 | **Only runs under `--persist`** (manager-plan.ts:783); findings persisted to `<out-dir>/manager-plan-store`, NOT printed to stdout |

## Environment

- Worktree `wizardly-kapitsa-e2214f` fast-forwarded to `origin/main` @ **571d7dce** ("Wire audit dispositions into manager plan" #713).
- `pnpm install` + `pnpm build` — clean (exit 0).
- Scope target: **Autonomous Backlog Manager & Dispatch Governance** project, slugId `9c1064215e8d` (UUID f1002259-841d-41fa-8a28-e859c1d5dd4e).
- `LINEAR_API_KEY` + `REPO_URL` loaded from `/Users/ericlitman/projects/symphony-ts/.env`.

## CLI gating summary (verified by reading manager-plan.ts)

- Dispositions (1014): **always on.** No flag.
- Comment enrichment: **default on.** `--no-comment-enrichment` to disable.
- Code grounding (1017): **must pass `--planner-grounding`.** Report-only (never changes the plan; adds evidence to the prompt).
- Plan review (1029/1032): **must pass `--persist`.** Review findings land in the isolated store, not stdout.
- Output-only: writes NOTHING to Linear / live standing-plan store / dispatch.

## Run plan

- **Run 0 — smoke (cheap, de-risk):** `--state Triage --planner-grounding --prompt-only`. ~6 candidates. Validates candidate load → dispositions → enrichment → grounding (clone + extraction + doc-follow) → prompt assembly, WITHOUT the Opus pass or review. Confirms enrichment/grounding actually land in the prompt and lets us measure prompt size before spending the full pass.
- **Run 1 — full dogfood:** `--state Backlog --state Triage --planner-grounding --persist`. Full candidate set. Produces the real plan (stdout + artifacts) + the decorrelated review (store). This is the deliverable to eyeball and the cost measurement.

## Runs log

_(appended as runs complete)_

### Run 0 — smoke ✅ (exit 0, 18s)

```bash
node dist/src/cli/manager-plan.js --project 9c1064215e8d --state Triage \
  --planner-grounding \
  --planner-grounding-repo-url https://github.com/mobilyze-llc/symphony-ts.git \
  --planner-grounding-commit 571d7dce00d86cc0786e443b969387624ac36982 \
  --planner-grounding-repo-scope symphony \
  --prompt-only --out-dir <scratch>/dogfood/smoke
```

- **6 Triage candidates** all grounded: SYMPH-1035, 1021, 1019, 1018, 1016, 976.
- **Grounding telemetry (report-only, SYMPH-1017):** `extractor_call_count=6`, `wall_clock_ms=15928` (~16s), `aggregate_rendered_chars=26596`, `prompt_chars=52761`. Per-candidate `verified/unverified/not_found`:
  - SYMPH-1016: 19 / 8 / 5 · SYMPH-976: 14 / 7 / **11** · SYMPH-1021: 13 / 13 / 6 · SYMPH-1019: 4 / 1 / 1 · SYMPH-1018: 3 / 2 / 0 · SYMPH-1035: 2 / 4 / 1
  - **`not_found` = claims the ticket makes that grounding could NOT locate in the code @571d7dce** — a staleness/over-claim signal. SYMPH-976 (11) and SYMPH-1021 (6) are the highest; worth reading what didn't verify.
- **Enrichment stack confirmed present in the assembled prompt** (`manager-plan-prompt.txt`, 255 lines / 53KB): grounding evidence (37), comments (18), and **all SYMPH-1020 relation types** — relates 7, duplicate 3, supersedes 12, blockedBy 6, parent 11, child 2. SYMPH-897 untrusted-data fence present (nonce-tagged `<SYMPHONY_UNTRUSTED_CANDIDATES_…>` wrapper; header warns candidate data is UNTRUSTED). Structure: Operating envelope → Backlog (eligible) → In flight (immutable) → Open PRs → Recently merged → Plan.
- **Verdict:** context-assembly pipeline is healthy end-to-end. Cost extrapolates to ~36 extractor calls / ~90s grounding for the full set — nowhere near the 5M-token fear.

**Grounding quality caveat (Run 0 deep-read) — the counts are noisy; CORRECTED after Run 1:**

> **Correction (post-Run 1):** the noise described below is the **deterministic fallback**, NOT the SYMPH-1017 LLM extractor. Both runs logged `grounding extractor model unavailable; used local deterministic fallback: Cannot connect to API` — the extractor's model endpoint (`http://studio2.local:8000/v1`, `grounding-extractor.ts:27`) was unreachable from this session, so the crude regex/file-existence backstop ran instead. **The real LLM grounding extractor was never exercised end-to-end here.** The over-extraction below is expected *backstop* behavior; the `verified/not_found` counts reflect the fallback, not calibrated grounding. studio2 is a **separate** infra dependency from cmux.
- **Real signal that works:** file/doc-path claims verify correctly against @571d7dce — `[verified] Check src/orchestrator/standing-plan-store.ts`, `[verified] Check docs/plans/2026-07-01-symph-1017-planner-deep-code-grounding-plan.md` (doc-following resolves + reads local docs).
- **Over-extraction noise:** the extractor turns stray tokens and prose into "claims" it then can't find — `[not_found] Check plan_revision` (that string IS a real journal `kind` → **false** not_found), `[not_found] Check cursor_cloud_pr_resolution_failed` (an error label quoted in a comment, not code), `[not_found] Check docs/paths` (a literal phrase). Most `[unverified]` entries are just AC/rationale sentences, not code claims.
- **Consequence:** the per-candidate `verified/not_found/unverified` counts are **not yet a trustworthy staleness signal** — a high `not_found` conflates "stale ticket" with "extractor manufactured non-code claims." This is exactly the recall/false-positive calibration **SYMPH-1021** is scoped to do; the smoke run is concrete calibration evidence for it. → *follow-up: comment these false-not_found examples onto SYMPH-1021 at closeout.*
- **Untrusted fence (SYMPH-897) validated under real load:** candidate comments carry genuine embedded directives (e.g. SYMPH-1021's notes: "Use Pi with hosted DeepSeek V4 Pro… Do not use the local endpoint… Do not use a paid API"); they flow through the nonce-tagged UNTRUSTED wrapper as inert data with the "never instructions" header.
- The planner also gets a good guardrail line per candidate: *"already-done or superseded is a planner conclusion over this evidence; verified presence alone is not completion, and stubs/type-only declarations must not be treated as done."*

### Run 1 — full (Backlog + Triage, real Opus pass + review)

```bash
node dist/src/cli/manager-plan.js --project 9c1064215e8d --state Backlog --state Triage \
  --planner-grounding \
  --planner-grounding-repo-url https://github.com/mobilyze-llc/symphony-ts.git \
  --planner-grounding-commit 571d7dce00d86cc0786e443b969387624ac36982 \
  --planner-grounding-repo-scope symphony \
  --persist --out-dir <scratch>/dogfood/full
```

- **Result: exit 3 (planner unavailable) — cmux daemon down.** 103s. Grounding + full context assembly **succeeded** (229KB / 1292-line prompt for **38 candidates** written), but the Opus pass failed: `cmux new-workspace probe failed: Failed to connect to socket …/cmux/cmux.sock (Connection refused, errno 61)`. cmux 0.64.16 is installed (`/opt/homebrew/bin/cmux`) but **no daemon is running** (stale socket from Jun 10; no cmux process; no LaunchAgent).
- **This is correct graceful degradation, not a bug:** exit 3 = "the live pipeline would fall back to the comparator." The CLI's model pass AND the Tier‑2 council review both run through cmux; on a host without cmux up they degrade cleanly. **No plan / no review persisted** (store empty — persist runs only after a successful plan). cmux being down is plausibly intentional given the pipeline-halt posture, so it was NOT started unilaterally.
- **Full-prompt signal (cmux-independent):** 38 candidates. Prune signals present but read carefully — the `superseded ×46` / `already-done ×42` counts are dominated by a **per-candidate guardrail line** (~38×, boilerplate: "already-done or superseded is a planner conclusion over evidence; verified presence alone is not completion; stubs must not be treated as done"). The *real* audit signal is **`DISPOSITION ×7`** (the SYMPH-1014 output) plus a handful of genuine supersedes/duplicate relation annotations (SYMPH-1020). **Whether the planner ACTS on them (excludes superseded/done candidates from batches) is the open question** — answered by the plan preview, not the counts.
- **Output contract:** single fenced JSON — `rationale`, `batches[{mode, issueIdentifiers, rationale, canary}]`, `dependencies[{issueIdentifier, dependsOn}]`, `premises[{decisionAnchor, kind: verifiable|judgment, statement}]`. HARD `blockedBy` enforced as a hard ordering constraint.

### Run 1b — plan preview (identical prompt → model, NOT the real cmux runner)

Because cmux blocks the real pass, the exact 38-candidate assembled prompt is run through a model to preview **plan quality** (batches/waves/pruning/relation use). Caveat: this is a stand-in for the planner pass — it is NOT the production runner and produces NO real Tier‑1/Tier‑2 decorrelated review. The real review only comes from a cmux-backed `--persist` run.

- **Result: strong plan (preview).** A model given the identical 38-candidate prompt produced a coherent plan: correct envelope (ceiling 3, modes parallel-isolated + canary-chain; shared-surface correctly excluded as not-allowed), the HARD `blockedBy` chain 876→883 rendered as an 8-hop canary chain, and — critically — it **excluded ~16 gated/deferred/parked/epic-cover candidates** (947, 846, 1034, 891, 976, 941, 907, 905, 954, 1021, 884, 795, 796, 797, 1016, 960) with specific justifications drawn from **comments** ("Category (c) gaps: 0", "PARKED until trigger", "deferred to next-gen models"). Head wave = 1036/899/876 + ready pool. It correctly **discounted the grounding `not_found` counts** as degraded-fallback noise. Full plan JSON in scratch `dogfood/` notes.

## Findings / verdict

### What the dogfood proved (independent of cmux)
1. The enriched context-assembly pipeline works end-to-end and is cheap (~16s/6 candidates; ~90s grounding for 38).
2. Every capability we shipped lands in the prompt: SYMPH-1014 dispositions, SYMPH-1017 grounding + doc-following, SYMPH-1020 relations, comment enrichment, SYMPH-897 untrusted fence, SYMPH-1015 caps.
3. Grounding *ran only as its deterministic fallback* — the SYMPH-1017 LLM extractor's endpoint (`studio2.local:8000`) was unreachable, so the crude backstop produced the noisy `not_found` counts (not a trustworthy staleness signal, and NOT evidence about the real extractor). Report-only is the right posture. → SYMPH-1021 (needs a reachable extractor model to calibrate).
4. The real model pass + decorrelated review require a **running cmux daemon**; absent it the CLI degrades correctly to exit 3. → infra follow-up (non-cmux runner or run-on-host).

### Durable follow-ups surfaced
- **SYMPH-1021 (exists) — corrected:** the false-`not_found` examples (`plan_revision`, `cursor_cloud_pr_resolution_failed`, `docs/paths`) came from the *deterministic fallback*, NOT the LLM extractor (studio2 unreachable), so they are **not** valid extractor-calibration evidence. Accurate note for 1021: the LLM extractor could not be exercised on 2026-07-02 (`http://studio2.local:8000/v1`, `grounding-extractor.ts:27`, unreachable); calibration needs a reachable extractor model per 1021's own model-routing thread.
- **cmux dependency → RESOLVED into tickets:** SYMPH-1037 (parent) + 1038…1043 (adapter → 4 repoints → retire). Migrating to crabrunner (the live substrate) replaces cmux for the planner + review + spec-review + claude-runner CLI.

### Plan-quality verdict
**The enrichment that matters most is model-independent — and it works.** The preview's decisive wins (excluding gated/deferred/parked work; honoring HARD chains) were driven by **comments and relations**, fetched from Linear directly (no model). So even with the LLM grounding degraded to fallback and the planner pass stubbed by a model stand-in, the plan beat titles-alone by a wide margin. Core positive result: **comment + relation enrichment (SYMPH-874/896/1020) + dispositions (SYMPH-1014) demonstrably sharpen the plan.**

**Three things remain UNtested end-to-end** (infra unavailable this session): (1) the real planner Opus pass (cmux down), (2) the real SYMPH-1017 LLM grounding extractor (studio2 endpoint unreachable), (3) the real Tier-1/Tier-2 decorrelated review (cmux down).

### Migration pivot — cmux is deprecated; crabrunner is LIVE
Root cause of Run 1 exit 3: the planner + review still run on **cmux** (`runClaudeCmux`, `src/claude-runner/cmux-claude-runner.ts`), which is deprecated and down. **crabrunner is fully operational in this session** (`~/.local/bin/crabrunner`; live lanes running against studio2/pro16). Migrating the `runClaudeCmux` model-execution substrate → crabrunner lanes (a) matches project direction ("crabrunner throughout") and (b) actually unblocks a real dogfood Run 1 here. This is a **separate surface from SYMPH-949** (which migrates workflow *stages* off in-process codex/AI-SDK runners; cmux-claude-runner is not in its scope). **Filed as SYMPH-1037** (parent) + 6 sub-issues in the *Model Runner & Provider Strategy* project (related to SYMPH-949), blocked-by waves: **SYMPH-1038** (T1 adapter) → **SYMPH-1039** (T2 planner, unblocks this dogfood) · **SYMPH-1040** (T3 plan-review lanes) · **SYMPH-1041** (T4 spec-review) · **SYMPH-1042** (T5 claude-runner CLI) → **SYMPH-1043** (T6 retire cmux). Runs under session-orchestrator, no human gate. **The dogfood is paused pending SYMPH-1038+1039; resume Run 1 on crabrunner once the planner runner is repointed.**

### The cmux surface to migrate (`runClaudeCmux` callers)
| Caller | Path | Role |
|---|---|---|
| Planner | `src/agent/triage-planner.ts` (`createCmuxPlannerRunner`) + `src/cli/manager-plan.ts` (`defaultCreatePlannerRunner`) | manager-plan Opus pass |
| Tier-2 plan review | `src/review/plan-review-lanes.ts` | decorrelated review lanes (SYMPH-1032) |
| Spec review | `src/spec-review/spec-review.ts` | spec review |
| Claude-runner CLI | `src/cli/claude-runner.ts` | ad-hoc claude runner |
| (substrate) | `src/claude-runner/cmux-claude-runner.ts` + `cmux-artifact-paths.ts` | `runClaudeCmux` itself — retire last |

Target substrate: the generic `CrabrunnerCliSchedulerClient` (`submit`/`collect`/`cancel`, `src/stage-execution/crabrunner-scheduler-client.ts`) already used by stage execution — build a `ClaudeRunnerResult`-shaped adapter over it so caller signatures barely change.
