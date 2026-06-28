# SYMPH-945 — Retire or migrate the in-process Codex app-server client

**Status:** Design brief. Investigation only — no production code changes in SYMPH-945. Execution tracked in [SYMPH-949](https://linear.app/mobilyze-llc/issue/SYMPH-949).
**Date:** 2026-06-28 (Rev 2 — incorporates ce-doc-review findings: multi-turn parity, deletion-set completeness, security parity, alternatives)
**Author:** Symphony agent (operator-dispatched)
**Scope refs:** investigation done at symphony-ts `origin/main` @ `b8934a1` (this rev based on `9da9e82`); crucible @ `3f179ea`
**Linear:** [SYMPH-945](https://linear.app/mobilyze-llc/issue/SYMPH-945/investigate-retire-or-migrate-the-in-process-codex-app-server-client) · execution [SYMPH-949](https://linear.app/mobilyze-llc/issue/SYMPH-949) · related [SYMPH-412](https://linear.app/mobilyze-llc/issue/SYMPH-412), [SYMPH-943](https://linear.app/mobilyze-llc/issue/SYMPH-943)

---

## TL;DR

The ticket's premise — *"no configured workflow selects codex as a runner"* — is **incomplete**. The grep `grep -rli codex pipeline-config/workflows/` returns nothing because the codex runner selection lives in the **template** the workflows inherit (`pipeline-config/templates/WORKFLOW-template.md`), not in the per-product workflow files.

Verified reality:

- **`CodexAppServerClient` is load-bearing, not vestigial.** It is the live execution runtime for the **investigate, implement, and merge** stages of every product pipeline today, because `runner: codex` is the template default and those stages dispatch through the default `current-runner` backend.
- **Only the review stage has left the in-process client** — in the live Symphony workflow it is dispatched to a crabrunner lane (`codex exec`), and the legacy in-process ensemble-review gate path never used codex at all (it throws on a codex reviewer kind).
- **The crabrunner `codex exec` lane is the proven migration target.** Crucible runs codex purely as a `codex exec --experimental-json -m <model>` subprocess — no app-server protocol — fully independent of symphony-ts's in-process client.

**Recommendation: ordered migration, NOT full-retire today.** Route investigate/implement/merge stage dispatch onto the existing crabrunner stage-execution backend (the same substrate already live for review), validate, then delete `app-server-client.ts` + `createDefaultCodexClient` + the SYMPH-412 session-rotation logic + the `codex` runner kind. Full-retire today would delete the only runtime that 3 of 4 stages depend on.

**Two caveats this brief is explicit about (Rev 2):**
1. **The load-bearing migration work is the multi-turn/continuation contract, not codex invocation.** The crabrunner backend is one-shot submit/collect; review rides it precisely *because* review is single-pass. Investigate/implement run AgentRunner's stateful turn loop (`startSession` → `continueTurn`, per-turn prompt rebuild). Reproducing that on a one-shot lane is the real work and the gating risk (AC3 step 2). The "lane covers codex" claim is about invocation, not Symphony's iteration model.
2. **Migration is not the only way to retire the client.** The in-process client is reached *only* when `runner.kind === "codex"`. Flipping the template default to an already-wired AI-SDK runner (claude-code/gemini) escapes the client today with no lane work — at the cost of changing the model. Whether codex-the-model is actually required for these stages is unstated and must be decided before committing to the migration (AC3 → *Alternatives considered*).

---

## AC1 — Live call-site enumeration & classification

**Classification legend:** (a) dead/unreachable · (b) migratable to crabrunner `codex exec` lane · (c) genuinely still required today.

The in-process client is instantiated in **exactly one** production location. Every other `new CodexAppServerClient*(...)` occurrence in `src/codex/app-server-client.ts` constructs `CodexAppServerClientError` (the error class), not the client.

| # | Pattern | Site | What it does | Class | Proven path |
|---|---------|------|--------------|-------|-------------|
| 1 | `createCodexClient` (factory wiring) | `src/agent/runner.ts:286-291` | Assigns the default client factory on the `AgentRunner`; resolves to `createDefaultCodexClient` only when `config.runner.kind === "codex"` (via `createDefaultClientFactory`, `runner.ts:1488-1507`). | (c) required | Constructed for every `AgentRunner` (`runtime-host.ts`); the codex branch is taken only when the effective runner kind is `codex`. |
| 2 | `new CodexAppServerClient` | `src/agent/runner.ts:1512` | **The sole production instantiation.** `createDefaultCodexClient` builds the in-process app-server client. | (b)→(c) required today, migratable | `OrchestratorCore.handleStage → RuntimeHost` dispatch → `CurrentRunnerStageExecutionBackend` (`stage-execution/backend.ts:90`) → `AgentRunner.run()` → `buildClient()` (`runner.ts:447`) → `effectiveClientFactory` (`runner.ts:428-438`, takes `this.createCodexClient` because `isAiSdkRunner("codex") === false`) → `createDefaultCodexClient` (`runner.ts:1509`). |
| 3 | `.startSession(` | `src/agent/runner.ts:636` | Opens a new codex session for the first turn (and after each rotation). | (b)→(c) required today, migratable | Same path as #2; `clientFreshSession === true` branch of the turn loop. |
| 4 | `.continueTurn(` (ticket calls it `.runTurn(`; the actual method is `continueTurn`) | `src/agent/runner.ts:637` | Continues the existing session thread for turns 2..N. | (b)→(c) required today, migratable | Same path as #2; `clientFreshSession === false` branch. |
| 5 | `.startSession(` | `src/orchestrator/gate-handler.ts:182` | **Not a codex call-site.** The ensemble-review gate drives a reviewer client typed as the shared `AgentRunnerCodexClient` interface, but the concrete instance is **always** an AI-SDK runner. | (a) N/A for codex | `runtime-host.ts:1224-1239` builds the reviewer client and **throws** if the reviewer kind is not an AI-SDK runner: `if (!isAiSdkRunner(kind)) throw …only claude-code and gemini are supported for ensemble review` (`runtime-host.ts:1229-1233`). Codex can never reach `gate-handler.ts:182`. |
| 6 | `createRunnerFromConfig` codex case | `src/runners/factory.ts:46-49` | The AI-SDK factory **throws** for `kind === "codex"`, routing codex to `createCodexClient` instead. Confirms the in-process client is the dedicated codex path and is structurally distinct from the AI-SDK runners. | (c) required | n/a (guard). |

### Why the ticket's "no workflow selects codex" grep is misleading

```
grep -rli codex pipeline-config/workflows/   → (no matches)
```

…but the selection is inherited from the template:

```yaml
# pipeline-config/templates/WORKFLOW-template.md
runner:
  kind: codex            # line 130 — global default
stages:
  investigate: { runner: codex }   # line 379
  implement:   { runner: codex }   # line 405
  review:      { runner: codex }   # line 423  (diverted to crabrunner — see AC2)
  merge:       { runner: codex }   # line 432
```

No workflow file or template sets a per-stage `execution.backend`, so every non-review stage falls to the default backend `current-runner` (`src/stage-execution/job-spec.ts:47`: `const backend = execution?.backend ?? "current-runner";`). The `current-runner` backend wraps `AgentRunner` (`stage-execution/backend.ts:90`), which — for `runner: codex` — instantiates `CodexAppServerClient`.

### Session-rotation logic (the SYMPH-412 bandaid surface)

The deletion set includes the rotation machinery added for SYMPH-412, all in `src/agent/runner.ts`:

- `rotateClient(reason, detail)` — `runner.ts:560-587`. Closes the dead/old client, rebuilds via `buildClient()`, forces a fresh session, resets the per-session token counter, emits `session_rotated`.
- **Reactive** mid-turn-closure rotation — `runner.ts:643-664`. On `isMidTurnSessionClosureError`, rotate and retry the same turn in place, bounded by `MAX_MID_TURN_CLOSURE_ROTATIONS_PER_RUN`.
- **Proactive** input-token-threshold rotation — `runner.ts:849-862`. Rotate before the next turn once cumulative session input tokens cross `sessionRotationInputTokens`, motivated explicitly by "mid-turn closures cluster at 0.9M–2.5M input tokens."
- Turn-count compensation for double-counted `session_started` events — `runner.ts:668-676`.

All of this exists **only** to keep a long-lived in-process app-server session alive across high cumulative context. It is the "stream of defensive bandaids" the ticket describes, and it disappears with the migration (see AC4).

---

## AC2 — Does the crabrunner lane cover codex via `codex exec`?

**Yes for codex *invocation*, independently of the in-process client — but it does not yet cover Symphony's orchestrated multi-turn loop.** (crucible @ `3f179ea`.) Be precise about the two halves:

- **Invocation (covered):** the lane runs codex via `codex exec` with no app-server protocol dependency — proven below and already live for the review stage.
- **Iteration model (NOT yet covered):** the crabrunner stage-execution backend is a single submit/status/collect dispatch that carries one rendered prompt and reports `turnsCompleted: 0` / `lastTurn: null` (`src/stage-execution/crabrunner-backend.ts`). It has no analog to AgentRunner's `startSession`→`continueTurn` loop with per-turn prompt rebuild. Review tolerates this because review is single-pass (one reviewer lane → one `review-result.json`; rework is orchestrator re-dispatch via `max_rework`, not in-session turns). Investigate (`max_turns: 8`) and implement (`max_turns: 30`) genuinely use the in-session turn loop — so review's success is **not** evidence the lane covers them.

Execution chain in crucible:

1. `lane_workers/run.ts:25-36` — handler dispatch; runtime `"openai-codex"` → `(await import("./openai_codex")).runCodex` (line 29-30).
2. `lane_workers/openai_codex.ts:14-16` — `runCodex` → `executeGenerate(spec, modelForCodex(spec), …)`.
3. `lane_workers/providers/codex.ts:66-73` — `modelForCodex` → `createCodexCli()(spec.resolved.modelId, …)` from `ai-sdk-provider-codex-cli` (v1.2.1). No `codexPath` is set, so the binary defaults to `codex`.
4. `ai-sdk-provider-codex-cli` builds args `["exec", "--experimental-json", … "-m", <modelId>, …]` and `spawn(cmd, args, …)`. The effective command is:

   ```
   codex exec --experimental-json -m <modelId> -c sandbox_mode=<mode> -c approval_policy=on-failure [...]
   ```

**No app-server / JSON-RPC / `newSession` protocol is used anywhere in crucible's lane workers** (grep for `app-server`/`newSession`/`appServer` → zero matches). Crucible uses the AI-SDK `ExecLanguageModel` (subprocess), never `AppServerLanguageModel`.

**Coverage of symphony-ts's remaining codex use:** The codex-exec lane already backs the live Symphony **review** stage (`review_execution.crabrunner_job_group.enabled: true` in `pipeline-config/workflows/WORKFLOW-symphony.md:59-61`, gated on `SYMPHONY_CRABRUNNER_ROOT`). For the remaining in-process stages, the lane covers the *invocation* but **not** the orchestration: investigate/implement need the multi-turn loop, `continueTurn` thread continuation, and per-turn workpad/comment-delta prompt rebuild that `AgentRunner` owns today. So the migration gap is **two parts**: (1) wiring — route those stages' dispatch through the crabrunner backend (mechanical); and (2) **the multi-turn / continuation contract** — reproduce or relocate AgentRunner's turn loop, plus artifact/usage/event reporting and security parity. Part (2) is the load-bearing work and is unproven for these stages; do not infer it from review (AC3 step 2).

---

## AC3 — Recommendation: ordered migration (then delete)

Full-retire is **not** safe today: deleting `app-server-client.ts` + dependents now removes the live runtime for investigate/implement/merge. Do it as a staged migration whose end state is the same deletion set the ticket proposes.

> **The deletion set and ordered plan below are design inputs to the execution issue ([SYMPH-949](https://linear.app/mobilyze-llc/issue/SYMPH-949)), not changes approved for execution under SYMPH-945.**

### Target end-state deletion set (once stages are migrated and validated)

This set is broader than the ticket's first cut — the in-process client threads through config, domain, and observability surfaces that a naïve "delete the file" misses and that `pnpm typecheck` would surface mid-deletion.

**Core client + runner:**
- `src/codex/app-server-client.ts` (2,701 LOC) — the client, `CodexAppServerClientError`, and helpers (`prepareDisabledSkillsConfig`, `sweepStaleCodexHomes`, `detectHeadlessCommandOutputRisk`).
- `src/agent/runner.ts`: `createDefaultCodexClient` (1509-1533); the codex fall-through of `createDefaultClientFactory` (the `return createDefaultCodexClient;` at line 1506 — collapse the function once the AI-SDK branch at 1494-1503 is the only path); and the **entire session-rotation surface** (560-587, 643-664, 668-676, 849-862, plus `clientFreshSession`/`clientInputTokens`/`midTurnClosureRotations` state at 554-559).
- `src/runners/factory.ts`: the `codex` case (46-49) and `codex` from `REGISTERED_RUNNER_KINDS`/`DEFAULT_MODELS`; `isAiSdkRunner` becomes vacuous and can be inlined/removed.
- `src/runners/types.ts`: the `codex` member of the `RunnerKind` union (`RunnerKind = "codex" | "claude-code" | "gemini"`, line 5). *(The ticket and rev-1 of this brief mis-cited this as `src/config/types.ts`; `config/types.ts` holds the codex **config** object, below, not the runner-kind union.)*
- `src/runners/provider-capabilities.ts`: the `codex-app-server` provider row and its default mapping (`codex → codex-app-server`) (and the unused `codex-cli` row if it has no other consumer).

**Config surface (omitted in the first cut — must be enumerated):**
- `src/config/types.ts`: `WorkflowCodexConfig` interface (286) and the `codex: WorkflowCodexConfig` field (683).
- `src/config/defaults.ts`: `DEFAULT_RUNNER_KIND = "codex"` (69), `DEFAULT_CODEX_COMMAND` (82), and the `codex:` defaults sub-object (~295).
- `src/config/config-resolver.ts`: the codex resolver block (~445-468, 670-683).
- Consumers of `.codex.*` config that must be repointed or removed: `src/orchestrator/runtime-host.ts` (~14 callsites), `src/orchestrator/core.ts` (stall-timeout, 12472/12487), `src/cli/main.ts` (253-254), `src/agent/runner.ts`. **Decision required:** several knobs (`approvalPolicy`, `threadSandbox`/`turnSandboxPolicy`, `stallTimeoutMs`, `ephemeralHome`, `disableSkills`) are security/behavior controls the crabrunner backend must keep exposing — see *Security parity* below.

**Domain / observability surface (omitted in the first cut):**
- `src/domain/stage-usage.ts`: the `"codex_app_server"` cost-source union member (57) + `mapCodexAppServerUsageToStageUsage` (100-116).
- `src/domain/model.ts`: `codexAppServerPid` field (807, 1536, 1735) — **needs a successor** (crabrunner job id) so the emergency-stop projection and dashboard keep working, not a silent removal.
- `src/observability/dashboard-server.ts` (`codex_app_server_pid`, 275); `src/orchestrator/emergency-stop-projection.ts` (32, 58); `src/logging/session-metrics.ts` (63); the `codexAppServerPid: null` stubs in `claude-code-runner.ts`/`gemini-runner.ts`.

**Tests / config defaults:**
- `tests/codex/app-server-client.test.ts` (incl. the SYMPH-943 elicitation tests).
- The template defaults (`WORKFLOW-template.md:130,379,405,423,432`) flipped to the crabrunner-backed path.

### Ordered plan

0. **Decide the runner first (gate on *Alternatives considered* below).** Before any lane work, record whether codex-the-model is actually required for investigate/implement/merge. If not, the runner-swap escapes the in-process client without building a multi-turn lane contract, and steps 1–4 collapse.
1. **Stage-execution backend for non-review codex.** Extend the crabrunner stage-execution backend (`src/stage-execution/crabrunner-backend.ts`) so investigate/implement/merge can dispatch as codex-exec lanes — behind a flag. Run the new path with **fast rollback** on failure; where outcomes are mechanically comparable, shadow them, but note that "comparing outcomes" between two non-deterministic agent runs is ill-defined (the durable output is a commit/PR), so the gate is *no regression in success/stall/cost*, not run-for-run equivalence. (This is a behavioral cutover, not a cost cap — the *measure-before-caps* discipline does not directly apply.) **Tracked as [SYMPH-949](https://linear.app/mobilyze-llc/issue/SYMPH-949).**
2. **Multi-turn / continuation contract (the load-bearing decision, not a confirm).** Decide and specify: either (a) keep AgentRunner's turn loop and dispatch each turn as a separate codex-exec lane job — and specify how thread continuity / context re-injection is preserved across one-shot subprocesses (note: naive per-turn re-feed re-accumulates the same context that motivated SYMPH-412; see AC4); or (b) collapse to one codex-exec invocation per stage relying on codex's internal loop, and reconcile that against Symphony's max-turns / iteration-cap / rework-continuation / workpad semantics. This is a prerequisite for the investigate/implement cutover, not a follow-up confirmation.
3. **Parity — usage *and security*.** (i) Reproduce `session_started`/usage/rate-limit/artifact events the dashboard and policy gates consume (`runner.ts` `onEvent` surface) from lane output, so observability and hard-stop gates keep working; provide a successor for `codexAppServerPid` (crabrunner job id) for the emergency-stop projection. (ii) **Security parity** — the in-process path runs under template controls `approval_policy: never`, `thread_sandbox: workspace-write`, `turn_sandbox_policy.network_access: true` (`WORKFLOW-template.md:117-121`) and host-side guards (`detectHeadlessCommandOutputRisk`, `disableSkills`+`ephemeralHome`). The `codex exec` lane defaults differ (`approval_policy=on-failure`, `sandbox_mode` read-only for non-implement profiles, no host-side output guard) and `codexCliOptionsForSpec` does not set `approvalMode`. The cutover must enumerate per-stage expected `approval_policy`/`sandbox_mode`/`network_access`, decide the fate of the headless-output guard and skills-disabling, and not silently change posture. See *Security parity* in AC-S below.
4. **Cut over per stage** (review is already done): merge → investigate → implement, each after a shadow window. **Rationale for the order:** merge is the lowest-traffic stage and usually completes in one turn (its prompt is "your ONLY job is to merge"), so it is the natural first canary for lane wiring. But merge is configured `max_turns: 5` (`WORKFLOW-template.md:433`) and runs the same `startSession`→`continueTurn` loop up to that bound — so **no stage cutover, including merge, may precede step 2's multi-turn decision.** Either resolve the continuation contract first, or explicitly cap merge to one turn before cutting it over; merge-first is a *wiring* canary, never evidence the multi-turn contract works (investigate `max_turns: 8` / implement `max_turns: 30` need it more, but merge needs it too for runs that take continuation turns 2..5).
5. **Delete** the end-state set above once no stage selects the in-process client; verify `pnpm typecheck && pnpm lint && pnpm test && pnpm build`. **Gate the delete on net reduction, not just functional parity:** the shadow window must show the codex-exec lane absorbing investigate/implement/merge without re-accumulating a new context/session/usage bandaid stream approaching the 28-patches/3-weeks the migration exists to eliminate. If the bandaids merely relocate to the lane, the objective failed — keep the client until that's resolved.

Rationale for ordered-not-big-bang: the in-process client is patched 28× in 3 weeks precisely because it is hot. A staged cutover per stage lets the codex-exec lane absorb that traffic with a rollback path, and each cutover *removes* a bandaid surface rather than adding one — *provided* step 5's net-reduction gate holds.

### Alternatives considered

| Option | Escapes the in-process client? | Cost | Tradeoff |
|--------|-------------------------------|------|----------|
| **A. Crabrunner codex-exec migration** (recommended *if codex is required*) | Yes, after cutover | High — must build the multi-turn/continuation contract (step 2) + parity | Keeps codex-the-model; consolidates on the live substrate |
| **B. Runner-swap** — flip the template default to an existing AI-SDK runner (claude-code/gemini via `createRunnerFromConfig`) | **Yes, immediately** — the client is reached only when `runner.kind === "codex"` | Low — no lane multi-turn work; deletes the SYMPH-412 rotation surface at once | **Changes the model.** Viable only if codex-the-model is not required for these stages |
| **C. Do nothing** — keep the client + rotation + quarantine | No | Ongoing — the 28-patches/3-weeks bandaid stream continues | The status quo the ticket is trying to end |

The recommendation is **A**, but it is **conditional on codex-the-model being a hard requirement** for investigate/implement/merge — a fact this investigation could not establish (codex is the inherited template default, not a documented requirement). If it is not required, **B** retires the client far more cheaply and should win. Resolving that requirement question is step 0 above and an acceptance criterion of SYMPH-949.

### Interim posture during the multi-week cutover

The live in-process path keeps SYMPH-412 exposure until investigate/implement are cut over. Holding posture: the session-rotation mitigation stays as-is (no new bandaids, existing mitigation retained); if mid-turn closures spike during the window, that is the trigger to prioritize the affected stage's cutover early rather than to add another bandaid.

---

## AC4 — Disposition of SYMPH-412 and SYMPH-943

- **[SYMPH-412](https://linear.app/mobilyze-llc/issue/SYMPH-412)** (Backlog) — *codex app-server session closes mid-turn at high cumulative context.* **Root cause is the long-lived in-process app-server session model itself**: context accumulates across turns in one JSON-RPC session until the server dies at 0.9M–2.5M input tokens. **The "mooted by migration" claim is conditional on the AC3 step-2 decision, not automatic.** It holds *only if* the migration drops Symphony-orchestrated cross-turn continuity — i.e., each stage becomes one bounded `codex exec` invocation (option 2b), so no long-lived accumulating session exists. If instead continuity is preserved by re-feeding accumulated context into successive one-shot invocations (option 2a, naive), the high-cumulative-context wall is **relocated, not eliminated** — it reappears inside a single `codex exec` call. **Disposition: carry, do not invest further bandaids.** Keep open as *blocked-on SYMPH-945/949*; it remains a real bug on the live in-process path until investigate/implement are cut over. Close as resolved-by-deletion only once the turn model is decided such that no accumulating session survives.
- **[SYMPH-943](https://linear.app/mobilyze-llc/issue/SYMPH-943)** (In Progress) — *flaky codex app-server-client elicitation test ejects the merge queue.* This is a test of the in-process client; full migration deletes the test entirely, mooting it. **But the migration is multi-week and the flake ejects the merge queue now** — it was already quarantined on `main` (`b8934a1`, *"quarantine flaky codex elicitation tests"*). **Disposition: carry as an independent near-term concern, already mitigated by quarantine.** Do not spend effort hardening the test for the long term; its eventual fate is deletion under SYMPH-945. The quarantine is the right interim state; SYMPH-943 can close once either (a) the test is made deterministic if it must live longer, or (b) it is deleted by the migration.

---

## AC-S — Security parity (added Rev 2; acceptance criteria for SYMPH-949)

The migration swaps execution models, so it moves or deletes security-relevant controls. None of these is a live vuln in SYMPH-945 (investigation-only) — each is an **acceptance criterion the execution issue must carry** so posture is preserved deliberately, not changed silently.

- **Approval policy.** In-process runs under `approval_policy: never` (`WORKFLOW-template.md:117`) with Symphony enforcing controls programmatically. The `codex exec` lane (via `ai-sdk-provider-codex-cli`) defaults `approval_policy=on-failure` and `codexCliOptionsForSpec` does not set `approvalMode` — migrated stages would silently flip policy (and could stall unattended runs awaiting approval). **AC:** assert/parametrize the per-stage `approval_policy` for write lanes; test the constructed argv.
- **Sandbox mode + network.** Template sets `thread_sandbox: workspace-write` and `turn_sandbox_policy.network_access: true` for all stages (`WORKFLOW-template.md:118-121`). The lane maps non-implement profiles to `sandbox_mode=read-only` and has no per-turn sandbox concept (single `sandbox_mode` per invocation). **AC:** enumerate expected `sandbox_mode` + network access per stage; confirm merge/investigate still get the access they need.
- **Headless-output guard.** `detectHeadlessCommandOutputRisk` is a host-side control that declines tool calls likely to flood the session with unbounded output; it has no lane equivalent. **AC:** decide its successor (a codex output-limit config, or a documented rationale why `approval_policy` subsumes it) before deleting it.
- **Skill disabling.** In-process enforces `disable_skills` with a hard `ephemeralHome` precondition (never mutate the operator's live codex config). Crucible's slim denylist is a best-effort directory walk with a documented depth/count truncation gap. **AC:** confirm equivalent skill-disabling guarantees or record the residual gap explicitly — these stages process untrusted issue/diff content.

## AC5 — Artifact scope

The only artifact of SYMPH-945 is this design brief (also published to Linear Docs and attached to the issue). No production code, config, or test changed by SYMPH-945; `pnpm typecheck`, `pnpm lint`, and `pnpm test` are unaffected. The execution of the migration above is tracked in [SYMPH-949](https://linear.app/mobilyze-llc/issue/SYMPH-949). Rev 2 of this brief incorporates a 6-persona `ce-doc-review` (multi-turn parity, deletion-set completeness, security parity, runner-swap alternative); the revision itself is a docs-only change.

---

## Evidence index (first-hand, this investigation)

- Sole production instantiation: `src/agent/runner.ts:1512` (`new CodexAppServerClient`).
- Client factory selection: `src/agent/runner.ts:286-291`, `428-438`, `1488-1507`; `src/runners/factory.ts:46-55`.
- Session rotation (SYMPH-412): `src/agent/runner.ts:560-587`, `643-664`, `668-676`, `849-862`.
- Review never uses codex in-process: `src/orchestrator/gate-handler.ts:160-200`; reviewer-client guard `src/orchestrator/runtime-host.ts:1224-1239`.
- Crabrunner is review-only / additive: `src/orchestrator/runtime-host.ts:4720-4759`, `4858-4900`; `src/stage-execution/crabrunner-backend-factory.ts:359-366`.
- Default backend: `src/stage-execution/job-spec.ts:47`; current-runner backend `src/stage-execution/backend.ts:90`.
- Template runner defaults: `pipeline-config/templates/WORKFLOW-template.md:130,379,405,423,432`; live review opt-in `pipeline-config/workflows/WORKFLOW-symphony.md:59-61`.
- Crucible codex-exec lane: `lane_workers/run.ts:25-36`, `lane_workers/openai_codex.ts:14-16`, `lane_workers/providers/codex.ts:66-73` (crucible @ `3f179ea`).
- *(Rev 2)* `RunnerKind` union: `src/runners/types.ts:5` (not `config/types.ts`). Codex config surface: `src/config/types.ts:286,683`; `src/config/defaults.ts:69,82`. Observability/domain: `src/domain/stage-usage.ts:57,106`; `src/domain/model.ts:807,1536,1735`.
- *(Rev 2)* Security controls: `pipeline-config/templates/WORKFLOW-template.md:117-121` (`approval_policy: never`, `thread_sandbox: workspace-write`, `network_access: true`); lane defaults `approval_policy=on-failure` / `sandbox_mode` per profile (crucible `lane_workers/providers/codex.ts`, `ai-sdk-provider-codex-cli`).
- *(Rev 2)* Crabrunner backend is one-shot (no multi-turn): `src/stage-execution/crabrunner-backend.ts` (`turnsCompleted: 0`, `lastTurn: null`, single rendered prompt).

---

## Rev 2 — ce-doc-review disposition (2026-06-28)

A 6-persona `ce-doc-review` (coherence, feasibility, adversarial, product-lens, scope-guardian, security-lens) ran against Rev 1. Applied: factual fix (RunnerKind file), deletion-set completeness (config + domain/observability surfaces), tempered the invocation-vs-iteration overclaim across TL;DR/AC2, conditioned the SYMPH-412 "mooted" claim on the turn-model decision, added the runner-swap *Alternatives considered* table, added the *Security parity* acceptance criteria (AC-S), added the net-reduction delete gate and interim posture, and added the "inputs to SYMPH-949, not approved-for-execution" marker. Advisory (FYI) items — shadow-vs-flag+rollback framing and the execution-scope marker — were folded into AC3 directly.
