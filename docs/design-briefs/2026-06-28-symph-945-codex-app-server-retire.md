# SYMPH-945 — Retire or migrate the in-process Codex app-server client

**Status:** Design brief (in-flight). Investigation only — no production code changes in SYMPH-945.
**Date:** 2026-06-28
**Author:** Symphony agent (operator-dispatched)
**Scope refs:** symphony-ts `origin/main` @ `b8934a1`; crucible @ `3f179ea`
**Linear:** [SYMPH-945](https://linear.app/mobilyze-llc/issue/SYMPH-945/investigate-retire-or-migrate-the-in-process-codex-app-server-client) · related [SYMPH-412](https://linear.app/mobilyze-llc/issue/SYMPH-412), [SYMPH-943](https://linear.app/mobilyze-llc/issue/SYMPH-943)

---

## TL;DR

The ticket's premise — *"no configured workflow selects codex as a runner"* — is **incomplete**. The grep `grep -rli codex pipeline-config/workflows/` returns nothing because the codex runner selection lives in the **template** the workflows inherit (`pipeline-config/templates/WORKFLOW-template.md`), not in the per-product workflow files.

Verified reality:

- **`CodexAppServerClient` is load-bearing, not vestigial.** It is the live execution runtime for the **investigate, implement, and merge** stages of every product pipeline today, because `runner: codex` is the template default and those stages dispatch through the default `current-runner` backend.
- **Only the review stage has left the in-process client** — in the live Symphony workflow it is dispatched to a crabrunner lane (`codex exec`), and the legacy in-process ensemble-review gate path never used codex at all (it throws on a codex reviewer kind).
- **The crabrunner `codex exec` lane is the proven migration target.** Crucible runs codex purely as a `codex exec --experimental-json -m <model>` subprocess — no app-server protocol — fully independent of symphony-ts's in-process client.

**Recommendation: ordered migration, NOT full-retire today.** Route investigate/implement/merge stage dispatch onto the existing crabrunner stage-execution backend (the same substrate already live for review), validate, then delete `app-server-client.ts` + `createDefaultCodexClient` + the SYMPH-412 session-rotation logic + the `codex` runner kind. Full-retire today would delete the only runtime that 3 of 4 stages depend on.

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

**Yes — fully, and independently of the in-process client.** (crucible @ `3f179ea`.)

Execution chain in crucible:

1. `lane_workers/run.ts:25-36` — handler dispatch; runtime `"openai-codex"` → `(await import("./openai_codex")).runCodex` (line 29-30).
2. `lane_workers/openai_codex.ts:14-16` — `runCodex` → `executeGenerate(spec, modelForCodex(spec), …)`.
3. `lane_workers/providers/codex.ts:66-73` — `modelForCodex` → `createCodexCli()(spec.resolved.modelId, …)` from `ai-sdk-provider-codex-cli` (v1.2.1). No `codexPath` is set, so the binary defaults to `codex`.
4. `ai-sdk-provider-codex-cli` builds args `["exec", "--experimental-json", … "-m", <modelId>, …]` and `spawn(cmd, args, …)`. The effective command is:

   ```
   codex exec --experimental-json -m <modelId> -c sandbox_mode=<mode> -c approval_policy=on-failure [...]
   ```

**No app-server / JSON-RPC / `newSession` protocol is used anywhere in crucible's lane workers** (grep for `app-server`/`newSession`/`appServer` → zero matches). Crucible uses the AI-SDK `ExecLanguageModel` (subprocess), never `AppServerLanguageModel`.

**Coverage of symphony-ts's remaining codex use:** The codex-exec lane already backs the live Symphony **review** stage (`review_execution.crabrunner_job_group.enabled: true` in `pipeline-config/workflows/WORKFLOW-symphony.md:59-61`, gated on `SYMPHONY_CRABRUNNER_ROOT`). The remaining in-process use — investigate/implement/merge agent turns — is the **same shape of work** (run a codex agent in a workspace to completion), so the lane is capable of covering it. The migration gap is **not** capability; it is wiring (route those stages' dispatch through the crabrunner backend) plus the per-turn / multi-turn and artifact/usage-reporting contract that `AgentRunner` currently owns in-process.

---

## AC3 — Recommendation: ordered migration (then delete)

Full-retire is **not** safe today: deleting `app-server-client.ts` + dependents now removes the live runtime for investigate/implement/merge. Do it as a staged migration whose end state is the same deletion set the ticket proposes.

### Target end-state deletion set (once stages are migrated and validated)

- `src/codex/app-server-client.ts` (2,701 LOC) — the client, `CodexAppServerClientError`, and helpers (`prepareDisabledSkillsConfig`, `sweepStaleCodexHomes`, `detectHeadlessCommandOutputRisk`).
- `src/agent/runner.ts`: `createDefaultCodexClient` (1509-1533), the codex branch of `createDefaultClientFactory` (1494-1506 → collapse), and the **entire session-rotation surface** (560-587, 643-664, 668-676, 849-862, plus `clientFreshSession`/`clientInputTokens`/`midTurnClosureRotations` state at 554-559).
- `src/runners/factory.ts`: the `codex` case (46-49) and `codex` from `REGISTERED_RUNNER_KINDS`/`DEFAULT_MODELS`; `isAiSdkRunner` becomes vacuous and can be inlined/removed.
- `src/runners/provider-capabilities.ts`: the `codex-app-server` provider row and its default mapping (`codex → codex-app-server`).
- `tests/codex/app-server-client.test.ts` (incl. the SYMPH-943 elicitation tests).
- The `codex` runner kind from `src/config/types.ts` and the template defaults (`WORKFLOW-template.md:130,379,405,423,432`) flipped to the crabrunner-backed path.

### Ordered plan

1. **Stage-execution backend for non-review codex (report-only first).** Extend the crabrunner stage-execution backend (`src/stage-execution/crabrunner-backend.ts`) so investigate/implement/merge can dispatch as codex-exec lanes — behind a flag, shadow/parallel against the in-process path, comparing outcomes. (Honors the *measure-before-caps* discipline: prove parity before cutting over.) **File this as the execution issue.**
2. **Multi-turn / continuation contract.** `AgentRunner` currently owns the turn loop, prompt rebuild per turn, and `continueTurn` semantics. Confirm the lane contract covers Symphony's iteration model (max turns, rework continuation, workpad context) or move that orchestration above the lane. This is the real design risk, not codex invocation.
3. **Usage / artifact / event parity.** Reproduce `session_started`/usage/rate-limit/artifact events the dashboard and policy gates consume (`runner.ts` `onEvent` surface) from lane output, so observability and hard-stop gates keep working.
4. **Cut over per stage** (review is already done): merge → investigate → implement, each after a shadow window.
5. **Delete** the end-state set above once no stage selects the in-process client; verify `pnpm typecheck && pnpm lint && pnpm test && pnpm build`.

Rationale for ordered-not-big-bang: the in-process client is patched 28× in 3 weeks precisely because it is hot. A shadow-then-cutover per stage lets the codex-exec lane absorb that traffic with a rollback path, and each cutover *removes* a bandaid surface rather than adding one.

---

## AC4 — Disposition of SYMPH-412 and SYMPH-943

- **[SYMPH-412](https://linear.app/mobilyze-llc/issue/SYMPH-412)** (Backlog) — *codex app-server session closes mid-turn at high cumulative context.* **Root cause is the long-lived in-process app-server session model itself**: context accumulates across turns in one JSON-RPC session until the server dies at 0.9M–2.5M input tokens. `codex exec` is a one-shot subprocess per invocation with no long-lived accumulating session, so **the failure mode is structurally mooted by this migration**, and the session-rotation bandaid (its current mitigation) is deleted with the client. **Disposition: carry, do not invest further bandaids.** Keep open as *blocked-on / mooted-by SYMPH-945 migration*; it remains a real bug on the live in-process path until investigate/implement/merge are cut over, then close as resolved-by-deletion.
- **[SYMPH-943](https://linear.app/mobilyze-llc/issue/SYMPH-943)** (In Progress) — *flaky codex app-server-client elicitation test ejects the merge queue.* This is a test of the in-process client; full migration deletes the test entirely, mooting it. **But the migration is multi-week and the flake ejects the merge queue now** — it was already quarantined on `main` (`b8934a1`, *"quarantine flaky codex elicitation tests"*). **Disposition: carry as an independent near-term concern, already mitigated by quarantine.** Do not spend effort hardening the test for the long term; its eventual fate is deletion under SYMPH-945. The quarantine is the right interim state; SYMPH-943 can close once either (a) the test is made deterministic if it must live longer, or (b) it is deleted by the migration.

---

## AC5 — Artifact scope

The only artifact of SYMPH-945 is this design brief (also published to Linear Docs and attached to the issue). No production code, config, or test changed; `pnpm typecheck`, `pnpm lint`, and `pnpm test` are unaffected by this ticket. The execution of the migration above is tracked as separate follow-up issue(s).

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
