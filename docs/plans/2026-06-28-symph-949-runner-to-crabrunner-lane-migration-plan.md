# SYMPH-949 — Migrate all model execution onto crabrunner lanes (phased plan)

**Status:** Implementation plan (Rev 3 — two ce-doc-review rounds + crucible substrate inventory + operator decisions).
**Type:** refactor / migration.
**Date:** 2026-06-28
**Origin:** SYMPH-945 design brief (`docs/design-briefs/2026-06-28-symph-945-codex-app-server-retire.md`) + operator decisions 2026-06-28.
**Tracker:** [SYMPH-949](https://linear.app/mobilyze-llc/issue/SYMPH-949). **Crucible deps:** [MOB-588](https://linear.app/mobilyze-llc/issue/MOB-588) (turn cap), [MOB-589](https://linear.app/mobilyze-llc/issue/MOB-589) (cost-kill) — both **block U3**.
**Scope refs:** symphony-ts `origin/main` @ `9daf5ab`; crucible inventory @ `3044368` (was `3f179ea` at brief time — re-validate at execution).
**"Static suite"** throughout = `pnpm typecheck && pnpm lint && pnpm test && pnpm build`.

---

## Target architecture

Today symphony-ts executes a stage's agent **in-process** three ways: codex via `CodexAppServerClient` (owns Symphony-orchestrated multi-turn), claude/gemini via in-process AI-SDK runners, review via a crabrunner lane group. The codex app-server generates a continuous bandaid stream (~28 patches/3wk).

**End state:** crabrunner lanes are the **single, model-agnostic execution substrate** for every `type: agent` stage. The workflow template selects a model per stage; the orchestrator maps that to a crabrunner job (crucible runtime + model id) and dispatches **one lane per stage** through the **generic** stage-execution backend. The crucible lane worker owns the model's internal loop. Symphony's orchestrator becomes "dumb": dispatch one lane, collect one result, parse per-run signals from the result, transition.

```
workflow template (per stage: runner/model + execution.backend: crabrunner + write-grant)
        │  runnerToLane(runner, model) → { runtime, modelId };  write-grant → write|read-only profile
        ▼
orchestrator ── one crabrunner job per stage (GENERIC backend) ──▶ crucible lane worker (owns internal loop)
        ▲                                                                      │
        └── result: .md text → lastTurn.message (signal parse) + usage.v2 + laneJobId + progress.jsonl ◀┘
```

**Critical seam (corrected Rev 2):** route agent stages through the **generic** `CrabrunnerStageExecutionBackend.execute` via per-stage `execution.backend: "crabrunner"` → `resolveStageExecutionBackend` (`runtime-host.ts:5053`) → `backend.execute` (`runtime-host.ts:4753`). Do **NOT** generalize `resolveCrabrunnerReviewBackend` (the review job-*group* dispatcher). *Verified round 2:* `resolveCrabrunnerReviewBackend` returns null for `stageName!=="review"` (`runtime-host.ts:4860`), so a non-review stage with `execution.backend:"crabrunner"` correctly flows to the generic backend.

Stays in-process (not model-stages): local-model judgment gates (`pause-triage`/`stuck-triage`/`ac-gate`/`spec-fidelity` via `local-openai-compatible.ts`); the Slack bot.

## Confirmed decisions (operator, 2026-06-28)

- Codex is the required implement model **today**; substrate is model-agnostic (opus/claude swappable via template).
- All workflow model-stages → crabrunner lanes; no in-process model execution for stages remains.
- **No runtime flag / shadow / fallback** in the *shipped* system; implement directly, fail loudly. Pipeline stays stopped until complete. (Rollback during the migration is structural — see *Contingency*: nothing before U4's deletion removes the in-process path, so "hold" is always available.)
- **One invocation per stage** — the lane owns the internal loop; the orchestrator does not drive `continueTurn`. Cross-stage **rework** stays orchestrator re-dispatch.
- **Per-turn control surface:** **Drop** mid-stage comment/workpad re-injection + the per-turn workpad-retry-brake. **Preserve** per-run failure/human-block/stage-complete signals (from the lane artifact — see U1, this is *real symphony wiring*, not free), turn caps (MOB-588), and a runaway-cost kill (MOB-589). **Accepted loss:** the fine-grained per-turn no-progress brake (but it must still satisfy the enforcement contract — see U3).
- **Usage parity yes; security parity punted** to the AI SDK 7 migration.
- **Delete in-process execution promptly**, static-suite-gated — but only at U4, and only after C1/C2 are verified end-to-end (below).

**Two hard gates (round-2 corrections):**
1. **Symphony budget validation ≠ crucible enforcement.** `validateCrabrunnerLaneEnforcementContract` (`crabrunner-backend.ts:507-564`) only checks fields are present; crucible ignores all but `timeoutSeconds` today. **No agent stage's template `execution.backend` may flip to `crabrunner` until C1/C2 are verified end-to-end** — i.e., a stage exceeding its turn cap / cost budget is actually killed *by crucible*, proven by the U3 e2e. Otherwise migrated stages run uncapped.
2. **Signal parsing is unbuilt symphony work.** `createCrabrunnerAgentResult` returns `lastTurn: null` (`crabrunner-backend.ts:720`); only the review-marker path populates `lastTurn.message`. U1 must add wiring to read the lane's text artifact into `lastTurn.message`/`metadata.agentMessage` so the existing parsers fire.

## Crucible substrate inventory — @ `3044368`

| Capability | Status | Detail |
|---|---|---|
| Generic (non-review) lane | **EXISTS** | Runtime-agnostic worker (`lane_workers/run.ts`); `profile: write` enables mutating work. |
| Usage reporting | **EXISTS** | `crucible.lane-worker.usage.v2`; correct cumulative multi-turn for Claude. Completion-time. No rate-limit fields. |
| Cancel actuator | **EXISTS, fast** | `crabrunner cancel` → SIGTERM pgid (~100ms; SIGKILL ≤2s). |
| Per-turn signals | **PARTIAL** | Progress JSONL (`step`/`tool`/`tool-error`/`finish`/`error`) + heartbeat. **Final `.md` = final message only** → mid-loop markers can be lost (U1). |
| Turn / iteration cap | **GAP → MOB-588** | No `maxTurns` in JobSpec; anthropic hardcodes 24, codex unbounded. |
| Runaway-cost mid-stream kill | **GAP → MOB-589** | Usage completion-only; no live usage/budget predicate. Cancel actuator exists; the live-usage half is missing. |

---

## Phases — symphony-ts track

Each phase ends static-suite green and is independently reviewable; phases >5 files sub-split at execution. Line/symbol refs are 2026-06-28 checkpoints — re-validate at execution. **Phase dependencies:** U0 → U1 → {U2, U3}; U3 also requires C1/C2 **merged into crucible and verified** (not merely designed). U4 requires U0–U3 + C1/C2 verified. U1 gates all e2e verification.

### U0 — Model→lane selection + write-grant contract

- **Goal:** a resolver `runnerToLane(runner, model) → { runtime, modelId }` (codex→`openai-codex`, claude/opus→`anthropic-agent-sdk`; **no gemini branch**), and a per-stage **write-grant** so commit-stages get a write lane. **Additive** — the `codex` `RunnerKind` member is removed later (U4).
- **Files:** `src/runners/types.ts`, `src/config/types.ts`, `src/config/config-resolver.ts`, `src/config/defaults.ts`, new `src/stage-execution/runner-to-lane.ts`, **`src/stage-execution/crabrunner-scheduler-client.ts`** (the write decision lives here).
- **Write-grant — pick a verified mechanism (round-2 P1):** `resolveProfile` (`crabrunner-scheduler-client.ts:1385`) returns `write` only for `phase==="implement" || role==="implementer"`, and `STAGE_EXECUTION_PHASES` has **no `"merge"`** member — so "set `execution.phase: merge`" cannot work. Choose and implement one, with a unit test asserting each stage→profile: (a) extend `resolveProfile`'s write predicate to the commit-stage set `{implement, merge}`; (b) set `execution.role: "implementer"` on merge (semantic overload); (c) honor an explicit `execution.profile: "write"` **if** it threads to the manifest independent of `resolveProfile` — the two round-2 reviewers disagreed on whether `execution.profile`/`identity.profileId` bypasses `resolveProfile`, so **verify in code before relying on (c)**. **Recommendation: (a).**
- **Investigate write-need (open):** implement + merge clearly need write; investigate may be read-only (exploration/risk-predicate). Determine per the template's investigate stage; default investigate to read-only unless it writes a workpad/scratch.
- **Verification:** resolver unit tests (codex, anthropic, unsupported-runtime throw); per-stage profile test (merge + implement → write).

### U1 — Generic single-invocation lane dispatch + signal seam

- **Goal:** route every `type: agent` stage through the generic crabrunner backend as one lane invocation; **build the per-run signal seam**; capture `laneJobId`.
- **Files:** `pipeline-config/templates/WORKFLOW-template.md` (per agent stage: `execution.backend: "crabrunner"` + write-grant — but see Gate 1: do not flip until C1/C2 verified), `src/stage-execution/crabrunner-backend.ts` (`createCrabrunnerAgentResult`), `src/orchestrator/runtime-host.ts`, `src/stage-execution/job-spec.ts`.
- **Approach:** stages dispatch via `execution.backend: "crabrunner"` → generic backend (leave the review path alone). **Signal seam (real work):** read the lane's final `.md` text into `AgentRunResult.lastTurn.message`/`metadata.agentMessage` so the existing `containsStageCompleteSignal`/`parseFailureSignal`/`parseHumanBlockSignal` fire (today `createCrabrunnerAgentResult` returns `lastTurn: null`). **Mid-loop hazard:** the final `.md` is the model's *final* message; a marker emitted mid-loop then continued-past is absent. Validate that codex/anthropic terminate their internal loop on `[STAGE_COMPLETE]`/`[BLOCKED_NEEDS_HUMAN]`; if not guaranteed, scan `progress.jsonl` assistant-message events for the earliest terminal marker. Capture the crabrunner job id onto the run context as `laneJobId` (consumed by U2). Define the signal-precedence rule for multiple signals in one run (match today's last-wins).
- **Verification:** dispatch unit tests; a real **crabrunner lane** e2e (model via `runnerToLane`) for `implement` on a throwaway issue that completes and whose stage-complete/failure/human-block signals parse from the artifact; a test that a mid-loop human-block is surfaced (not dropped).

### U2 — Usage parity + cancellable emergency-stop (rewire, not rename)

- **Goal:** consume `usage.v2` as `StageUsage`; replace `codexAppServerPid` with `laneJobId`; **rewire** emergency-stop from PID-kill to scheduler cancel.
- **Files:** `src/domain/model.ts` (`codexAppServerPid`→`laneJobId`), `src/domain/stage-usage.ts`, `src/observability/dashboard-server.ts`, `src/orchestrator/emergency-stop-projection.ts`, `src/logging/session-metrics.ts`. *(Sub-split U2a domain / U2b observability at execution.)*
- **Approach:** emergency-stop today parses `codexAppServerPid` as a local OS PID and kills it (`emergency-stop-projection.ts:88`); a remote crabbox lane has **no local PID**. Rewire the projection to call the crabrunner scheduler `cancel(jobId)` path (the actuator exists, `crabrunner-backend.ts:436`). This is a control-path rewire, not a field rename. **Gate the `codexAppServerPid` deletion on Open Q4** (below).
- **Verification:** usage-mapping unit tests; emergency-stop cancels a live lane within the operator-acceptable bound **and leaves a recoverable workspace** (no unreconcilable partial commit/push); dashboard renders a lane-backed run.

### U3 — Caps + cost-kill (consumes C1/C2; reuse existing contract fields)

- **Goal:** preserve runaway-prevention: hard turn cap + runaway-cost kill, enforced *by crucible*.
- **Depends on:** **C1** (MOB-588) and **C2** (MOB-589) **merged + verified**.
- **Files:** `src/stage-execution/crabrunner-backend.ts`, **`src/stage-execution/crabrunner-scheduler-client.ts`** (`buildManifest` must serialize the new fields into the manifest — else they're a silent no-op), template.
- **Approach:** symphony **already validates + carries** `enforcement.timing.maxIterations`/`noProgressTurns` and `budget.maxTokens`/`maxUsd` at submit (`crabrunner-backend.ts:507-589`) but forwards only `timeoutSeconds` across the boundary. The work is to **forward those existing fields** into the manifest/argv and have crucible (C1/C2) act on them — not invent new caller fields. **No-progress brake:** the enforcement contract requires `noProgressTurns > 0` when `enforcement.required` (`crabrunner-backend.ts:559-564`); since the per-turn brake is dropped, either keep a benign sentinel value or relax the validator — do not let the dropped brake fail the submit-time contract.
- **Verification:** merge-with-conflicts e2e that runs ≥3 internal rounds **and commits** (proves write-grant + multi-round); a stage exceeding its turn cap is killed by crucible; a stage exceeding its cost budget is killed mid-stream by crucible (proves Gate 1).

### U4 — Cut over + delete in-process execution

- **Cutover order:** merge → investigate → implement (review already on lanes), after U1–U3 + C1/C2 verified. **Gate 1 applies: no agent-stage template flip until C1/C2 verified e2e.**
- **Deletion set** (static-suite-gated; re-validate refs):
  - `src/codex/app-server-client.ts` (client + error + helpers).
  - `src/agent/runner.ts`: `createDefaultCodexClient`, codex fall-through of `createDefaultClientFactory`, session-rotation surface (560-587, 643-664, 668-676, 849-862 + state 554-559), dropped comment/workpad re-injection + workpad-retry-brake.
  - **In-process AI-SDK runners** `src/runners/claude-code-runner.ts`, `src/runners/gemini-runner.ts`; `createRunnerFromConfig` + `isAiSdkRunner` + **the `case "gemini"`/`GeminiRunner` import in `src/runners/factory.ts`**. **Prerequisite:** extract `resolveClaudeModelId` (imported by `slack-bot/handler.ts:21`, which stays) to a shared util first.
  - **`current-runner` default + backend:** flip the `job-spec.ts:47` default away from `"current-runner"`; delete `CurrentRunnerStageExecutionBackend` (`stage-execution/backend.ts:90`) + the enum member. **Gate restated:** no stage *resolves* to `current-runner` (including via the default) — audit **all per-product workflows**, not just the template (round-2: the grep-for-references check is unsound because it's the default).
  - **`control_needing` contract (round-2 addition):** `config-contracts.ts:261-308` + its rule registration (`:351`); `requiresCodexAppServerControlPath` + the `fullControlSemantics` field in `provider-capabilities.ts`. Only `codex-app-server` sets `fullControlSemantics:true`, so this contract is dead once it's gone.
  - **Vestigial ensemble-review gate** — `runEnsembleGate`/`handleEnsembleGate`/`gateType:"ensemble"` (`gate-handler.ts`, `core.ts`, reviewer-client builder in `runtime-host.ts`).
  - `provider-capabilities.ts`: **both** `codex-app-server` **and** `codex-cli` rows + default mapping.
  - `src/runners/types.ts`: remove `codex` from `RunnerKind`.
  - Config surface: residual `WorkflowCodexConfig`/`DEFAULT_CODEX_COMMAND`/resolver/`.codex.*` consumers.
  - Domain/observability: `codex_app_server` cost-source (`domain/stage-usage.ts:57,106` + `mapCodexAppServerUsageToStageUsage`); `codexAppServerPid` (replaced U2).
  - **Tests (round-2 addition — else the static gate fails):** `tests/codex/app-server-client.test.ts`; `tests/config/config-contracts.test.ts`; `tests/runners/provider-capabilities.test.ts`; `tests/runners/provider-control-parity.test.ts`. Template defaults flipped (`WORKFLOW-template.md:130,379,405,423,432`).
- **Verification:** static suite green; an e2e per cut-over stage.

---

## Contingency / reversal (round-2 addition)

The "no fallback" decision applies to the *shipped* system, not the migration. Rollback is structural: **nothing before U4's deletion removes the in-process path**, so until U4 the safe action is always "hold" (don't flip the template; pipeline stays stopped). If C1/C2 (MOB-588/589) slip: do **not** flip agent stages to lanes (they'd be uncapped) and do **not** run U4 — hold on the in-process path. The operator decides whether to wait on the crucible track or accept a documented interim posture; this plan does not ship uncapped lanes to unstick the pipeline.

## Crucible-side track (MOB — blocks U3)

- **[MOB-588] — caller-settable lane turn cap.** `--max-turns`/`JobSpec.maxTurns` wired into anthropic (replace hardcoded 24) + codex options + manifest/argv. **Reuse** symphony's existing `enforcement.timing.maxIterations` field rather than a new surface. Verify codex-exec actually honors a turn bound (the required implement model).
- **[MOB-589] — streaming-usage budget abort.** Per-step usage during `streamText` → budget comparator → `ac.abort()`; distinct `budget_exceeded` failure class. **Reuse** symphony's existing `budget.maxTokens`/`maxUsd`. Cancel actuator + `usage.v2` already exist.

## Disposition of related issues
- **SYMPH-412** — closes resolved-by-deletion: one lane invocation per stage; no long-lived accumulating session.
- **SYMPH-943** — deleted with `tests/codex/app-server-client.test.ts`.

## Out of scope
Mid-stage comment/workpad re-injection + per-turn workpad-retry-brake; security-policy parity (→ AI SDK 7 migration); local-model judgment gates + Slack bot; a crucible gemini handler; rate-limit fields in `usage.v2`.

## Open questions
1. **Investigate write-need:** read-only (exploration) or write (workpad)? Determines U0's write-grant set.
2. **Marker-terminates-loop:** do codex/anthropic always end their internal loop on `[STAGE_COMPLETE]`/`[BLOCKED_NEEDS_HUMAN]` (final-`.md` parsing lossless), or must U1 scan `progress.jsonl`? Empirically check in U1.
3. **Config migration:** does generalizing `WorkflowCodexConfig` break persisted/operator config, or is it template-only?
4. **Emergency-stop safety + latency:** measure live crabbox lane cancel latency vs. PID kill **and** confirm a cancelled write lane leaves a recoverable workspace, before deleting `codexAppServerPid` (U2).
5. **No-progress brake:** keep a benign `noProgressTurns` sentinel to satisfy the enforcement contract, or relax the validator? (Leaning sentinel.)
