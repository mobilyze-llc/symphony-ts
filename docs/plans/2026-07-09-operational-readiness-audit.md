# Symphony Operational-Readiness Audit & Roadmap

Date: 2026-07-09
Audited at: origin/main `38b41906` (worktree synced + `pnpm install` fresh)
Crucible side: `~/projects/crucible` @ detached HEAD `ab444b7a` (clean)
Status: point-in-time artifact. Findings are evidence-linked (`file:line`); Linear mutations applied during this session are logged in Appendix E.

Method: baseline verify commands run first; bulk reading delegated to nine parallel read-only subagents (subsystem inventories ×2, god-file maps ×2, CMUX sweep, config census, crucible boundary diff, crucible anti-sprawl census, active-docs digest) plus two Linear clustering agents over a fresh GraphQL pull of all open SYMPH/MOB issues with comments and release membership. Load-bearing claims spot-verified in main context before inclusion. Completed across two sessions on 2026-07-09 (the first hit a usage limit after Sections A/C; the second re-ran the older-half ticket clustering from the preserved data pull, wrote Section B, and applied the Linear reconciliation).

---

## Executive summary

**Baseline is healthy; the architecture is not.** Typecheck, lint, and 4,446 tests pass on a fresh checkout. But `src/` is ~120k LOC with three god files (`core.ts` 15,615; `runtime-host.ts` 9,651; `headless-council-gate.ts` 7,272), 25 more files ≥600 LOC, ~116 env vars, and zero mechanical anti-sprawl enforcement. The repo is agent-built and it shows: duplicated exec/atomic-write/env-parse helpers, dead upstream leftovers, four orphaned CLI bins, and a live 7.2k-LOC review file that is ~47% dead legacy engine.

**The deterministic spine is further along than the backlog implies — and less along than the commit log implies.** Review, spec-fidelity, and the shadow planner already run on crabrunner lanes fail-closed. But the codex app-server remains the worker for **all four stages** (`runner.kind: codex` everywhere), so the "retire codex" epic (SYMPH-945/949) has not touched the default path. Meanwhile the two crucible-side gates that had SYMPH-949 stalled — turn-cap MOB-588 and cost-kill MOB-589 — are **Done**. The migration is unblocked and nobody has noticed.

**The planner trust-ramp is fully built and measuring nothing.** Grounding (#704–706, #724), tier-1/tier-2 standing-plan review (#710/#711), the diff gate (#725), and per-lane telemetry (#728) all landed report-only — but their gating flags (`planner_grounding.enabled`, `queue_triage.plan_review.enabled`) are default-false and set in **no** workflow config. The measurement window that SYMPH-1034's trust-ramp thresholds depend on is shut. Opening it is a config-only change.

**The Linear queue confirms the band-aid-factory diagnosis — and it reconciles cleanly.** Of 212 open issues audited (192 SYMPH + 20 MOB-in-releases, every comment read, ~70 claims grep-verified), **61 closed today without losing scope**: fixed-but-open, pinned to deleted/retiring code, duplicates, or consolidated into root-fix tickets (Appendix E). The queue is young (oldest open ticket: 30 days) — the in-run filing loop generates symptom tickets faster than roots get named, which is why the roadmap adds a standing triage layer (C.5) rather than a one-off cleanup. Notable reactivation: SYMPH-403 (stage-entry seam) — marked absorbed into 405, but 405 shipped without the seam; it is the root of the recurring park/retry defect class.

**The crucible boundary has no broken interfaces but is drifting and under-instrumented.** 6 DRIFTED + 6 FRAGILE findings (dead `heartbeat_seq`, phantom `workspace` field, reasoning-token telemetry lost, `measurement_kind` one alias from breaking, substring error-code mapping). Debugging a lane failure from artifacts alone fails on four gaps: no shared correlation ID, structured `error_code` payloads discarded, no liveness signal during 30-minute polls, rendered stage prompts unrecoverable. The execution seam (the one that grew fastest) has zero cross-repo conformance tests; the golden-corpus plan (2026-06-23-002) was never built.

**Roadmap (Section C):** six workstreams, all now ticketed. W0 opens the measurement window (config-only, days — **SYMPH-1070**); W1 hardens the crucible contract consumers + adds an execution-seam conformance harness (small — **SYMPH-1071**); W2 executes SYMPH-949 — investigate/implement/merge onto crabrunner lanes, retiring the codex app-server (the critical path to "operational"); W3 ramps planner authority on W0's evidence (SYMPH-1034 + 1069, moved to R3); W4 ports crucible's anti-sprawl gates (**SYMPH-1073**) and un-defers SYMPH-947 in guardrail-first form; W5 deletes CMUX (~12.5k LOC — SYMPH-1043 + 1008); W6 designs multi-repo (SYMPH-845/899–903). A **continuous intake-triage stream** (T0→T3 autonomy ramp, **SYMPH-1076**, Section C.5) keeps agent-filed symptom tickets from re-silting the queue — filing agents mid-run are the worst-positioned to diagnose root causes, so diagnosis happens at a batch triage layer that starts operator-led and hands off to the queue-triage planner as measured agreement earns it. **Dispatch next: W0 / SYMPH-1070** — a one-PR config flip that unblocks the most downstream work per unit of effort (Section 5).

---

## 1. Baseline health (2026-07-09, origin/main 38b41906)

| Check | Result |
|---|---|
| `pnpm typecheck` | clean |
| `pnpm lint` (biome, 497 files) | clean |
| `pnpm test` | **fails in pretest** on operator-machine skill drift (`validate-skill-installs`: duplicate cmux-spawn install at `~/.claude/skills/`) — an environment issue and itself CMUX residue, not repo health |
| `pnpm exec vitest run` | **4,446 passed, 5 skipped** (227 files passed, 1 skipped), 19.3s |
| LOC | `src/` = 119,998 across ~200 files (Appendix A) |

Stale-doc note: `CLAUDE.md` claims "347 tests" and an architecture tree missing 8+ top-level `src/` areas. Ticketed rather than fixed inline: **SYMPH-1077**.

---

## 2. Section A — Code audit

### A.1 Subsystem inventory (wired / shadow / dormant / dead)

Classification of every `src/` area against the deployed reality: one orchestrator LaunchAgent on pro14 running `dist/src/cli/main.js` with `WORKFLOW-symphony.md`, which enables `queue_triage` (shadow), `merge_actuator` (+auto_merge), and `review_execution.crabrunner_job_group` — three systems that are default-off in code. Audits that read only `src/config/defaults.ts` misclassify the planner subsystem; audits that read only the template miss that prod flipped these. Full table in Appendix C.

**Wired and gating (the production spine):**
- Orchestrator tick: `core.ts` poll/admission/dispatch/retry/lease/journal; `dispatch-comparator` is still the authoritative dispatch ORDER (planner is shadow). Team-scoped admission holds all dispatch until operator `symphonyctl release_batch` (`WORKFLOW-symphony.md` team_keys + standing-plan admission).
- Workers: **codex app-server for all four stages** (`DEFAULT_RUNNER_KIND = "codex"`, src/config/defaults.ts:69; template runner.kind codex). SYMPH-945's retirement target is the live backbone, not vestigial code.
- Review: crabrunner review job group (fail-closed without `SYMPHONY_CRABRUNNER_ROOT`), pre-review verify gate (default-on), spine aggregator authoritative (SYMPH-926/927 cutover done), merge actuator live with auto-merge for the symphony product.
- Guards: hard-stops budget gate (window-pct caps armed in prod 25/5), rate-limit admission (prod 10/5), signature-cluster circuit breaker, supervision write-collision enforcement, portfolio eligibility partition, AC gate (prod on), pause-triage (studio2 deepseek-v4-flash).
- Continuous feedback is **wired and behavior-changing** (default-on; an open checkpoint finding bounces the worker) — worth remembering when reasoning about "report-only" claims elsewhere.

**Shadow / report-only (running, gating nothing):**
- Standing-plan shadow tick (`queue_triage.enabled: true` + `shadow_mode: true` in prod): persists releasable plans + outcome calibration rows; ordering stays on the comparator.
- Comment-enrichment measurement (SYMPH-916 window), backlog-hygiene proposal lane, admission card, spec-fidelity lane (report-only by design in v1), decision-quality events, kimi shadow + codex excavation council lanes (both default-ON via env), review-quality ledger, loop-trace/runtime-snapshot telemetry.

**Dormant / flag-gated (complete, off):**
- **Plan-driven dispatch** (`shadow_mode: false` is the promotion seam — `standing-plan-consumer.ts`, runtime-host.ts:3890).
- **Tier-2 plan review + diff gate + per-lane telemetry** (`queue_triage.plan_review.enabled`, default false, **set nowhere**) — the SYMPH-1066/1068 wiring landed in #725/#728 is prod-inert.
- **Planner grounding** (`planner_grounding.enabled` + `code_grounding.enabled`, both default false, set nowhere) — the #724 shadow-tick wiring is prod-inert. LLM extractor additionally gated on `SYMPHONY_GROUNDING_EXTRACTOR_BASE_URL` (studio2 endpoint; unreachable in every dogfood so far → deterministic fallback only, SYMPH-1021).
- Control-doc surface (`queue_triage.control_doc.enabled`) — contradicts the filesystem-first direction; removal candidate rather than enablement candidate.
- Stuck-triage L2 (`watchdog.stuck_triage.enabled`, no workflow sets it), decomposed stages (seam complete, no workflow declares `sub_stages`), browser-QA review lane (policy code complete, **no producer emits the lane kind**), Linear webhook reconciler (secret configured nowhere), gemini/claude-code runners (config-selectable, never selected), a dozen operator one-shot CLIs (manager-plan, spec-review-watch, backlog-audit, calibration digest — deliberately unwired).

**Dead (no production callers):**
- `runHeadlessCouncilGate` legacy executor + lane runners + freshness assertion inside `headless-council-gate.ts` (~3.4k LOC, ~47% of the file) — zero callers outside tests (verified).
- `src/streaming.ts`, `src/test-alpha.ts` (upstream leftovers), `src/audit/altitude-reliability.ts`, `src/calibration/standing-plan-digest.ts`, `src/cli/manager-plan-dogfood-evidence.ts`, `src/orchestrator/standing-plan-envelope.ts` (re-export shim), core's exported `sortIssuesForDispatch` (superseded), `runClaudeCmux` executor + mirror/SHA block in cmux-named files (types/validators in those files ARE live — see A.4).
- 4 orphaned bins (`symphony-portfolio-audit`, `symphony-portfolio-classify`, `symphony-manager-run-import`, `symphony-investigate-productivity-report`) + `symphony-kimi-council-replay` (ships retired by its own header).
- The `index.ts` barrel `export *` masks deadness — the npm surface is the only "consumer" of several dead modules.

**Enablement ladders (what remains, in order, with evidence gates):**

1. **Measurement window (W0)** — set `planner_grounding.enabled: true`, `code_grounding.enabled: true`, and `queue_triage.plan_review.enabled: true` in `WORKFLOW-symphony.md`; deploy. All three are report-only by construction (grounding evidence blocks, tier-1/tier-2 findings, diff-gate baselines, per-lane telemetry). Evidence gate to move past W0: several planner revisions' worth of `review_tier2.*` records + grounding evidence blocks + diff-gate skip/run rates. Extractor reachability (SYMPH-1021) upgrades evidence quality but the deterministic fallback + tier-2 lanes work without it (verified e2e 2026-07-06).
2. **Planner authority (W3)** — after the window produces data and the SYMPH-1034 threshold session sets exit criteria: flip `queue_triage.shadow_mode: false` (plan orders dispatch; admission still operator-gated by team-scope), then consider raising `auto_release_frontier`. Gate each step on standing-plan-outcome calibration rows and comparator `ordering_disagreement` divergence.
3. **Codex retirement (W2 = SYMPH-949)** — per-stage crabrunner backends for investigate/implement/merge (seam exists; review + spec-fidelity already prove it). Gate each stage cutover on lane completion telemetry vs codex baseline. Crucible-side prerequisites MOB-588/589 are **Done**.
4. Browser-QA lane needs a producer (emit `kind:"browser-qa"` lanes) → run `degrade` before `block`. Stuck-triage needs one workflow to arm it. Decomposed stages need a `sub_stages` declaration. Webhook reconciler needs the secret + a Linear webhook registration.

### A.2 Crucible boundary contract

Symphony consumes five seams from crucible (full inventory + field-level detail in Appendix B):

- **Seam A — `bin/crabrunner` scheduler CLI** (stage execution + claude adapter): submit/status/collect/cancel/run with `crucible.crabrunner.{status,collect,run-result}.v1` envelopes, `crucible.crabrunner.job.v1` manifests, `crucible.lane-worker.usage.v2` usage, materialized artifacts. Fail-closed on `SYMPHONY_CRABRUNNER_ROOT`.
- **Seam B — review spine** (`production-rollout.mjs` council-triage / cross-exam-select / convergence-decision) — fail-closed subprocess client, zod-pinned `crucible.session-orchestrator.*.v1` schemas.
- **Seam C — review-quality ledger** (data capture, fail-open by design).
- **Seam D — reviewer artifacts**: symphony-owned schema; crucible only executes the lanes.
- **Seam E — ops preflight + WORKFLOW gates**; `plan-pr-batch`/`run-batch` are operator-skill surfaces, NOT on symphony's runtime path.

**Verdict: no BROKEN interfaces at crucible HEAD `ab444b7a`** — states, flags, schema literals, manifest validation, exit codes all verified on both sides. Drift is evidence-degradation plus one-alias-away fragility:

| Sev | Finding (abbrev; full table Appendix B) |
|---|---|
| DRIFTED | `status.heartbeat_seq` read for progress evidence; **no writer exists in crucible** — progress evidence is always null |
| DRIFTED | `status.workspace` read but the field doesn't exist in `CrabrunnerStatus` — silently falls back to artifactRoot |
| DRIFTED | Reasoning tokens lost: crucible writes `reasoning_output_tokens`; symphony reads `reasoning_tokens`/`reasoningTokens` |
| DRIFTED | Materialized status `"invalid"` mislabeled `missing`/`producer_predates_materialization` (wrong diagnosis, still fail-closed) |
| DRIFTED | Docstring claims schemas not actually consumed; crucible alignment doc still describes pre-SYMPH-908 verdict vocabulary |
| FRAGILE | `measurement_kind` is a compat alias (canonical: `measurement_quality`) — one crucible cleanup from usage going `unknown` |
| FRAGILE | error_code **substring** mapping vs crucible's named codes — `turn_cap_reached` (MOB-588!) falls to generic `runner_failed`; `admission_lock_timeout` would misclassify as lane timeout |
| FRAGILE | Staged-binary coupling: symphony never runs `crabrunner stage`; a fresh state root rejects every submit `staged_runtime_not_ready` |
| FRAGILE | Local status poll budget fixed 1800×1s, not derived from lane timeout; CLI error payloads (`crucible.crabrunner.error.v1` on stdout) discarded; spine consumed via the 13.8k-line skill script (SYMPH-909's narrow CLI still pending) |

**Artifact-only debuggability: fails on four gaps.** (1) No shared correlation ID — crucible manifests don't carry symphony's `runGroupId`/`stageAttempt`/idempotencyKey (fix candidate: the free-form `workspace_identity` manifest object, no crucible change needed). (2) Structured `error_code` payloads on stdout are discarded on non-zero exits. (3) No liveness during runs — heartbeat/progress files never read; a stalled 30-min lane looks healthy. (4) Rendered stage prompts are temp files deleted post-run, no hash retained (the claude adapter records `promptSha256`; the stage backend records nothing). Remote runs add a memory-fence: run-results cached in-process; a crash between run and collect orphans evidence.

**Contract coverage:** the review seam has real fixtures + live-gated conformance tests (`crucible-verdict-contract-cutover`, `crucible-spine-conformance`, `crucible-consumer-replay`). **The execution seam (Seam A) has zero cross-repo tests** — symphony tests pin expectations against fakes; crucible tests pin crucible against itself; findings 1–4/7 sat undetected exactly there. The golden-corpus plan (2026-06-23-002) is unbuilt (U1/U2 don't exist in crucible; only U4 partially real) and its target failure class recurred anyway (the collect-tar race) and was fixed structurally instead (SYMPH-1061).

**Proposals (adopted into roadmap W1):**
- P1: execution-seam conformance harness — live-gated submit→status→collect round-trip against a temp state root + frozen real-output fixtures; consumer fixes (read `measurement_quality ?? measurement_kind`; add `reasoning_output_tokens`; replace substring error mapping with the documented named-code table).
- P2: correlation IDs via `workspace_identity`; parse `crucible.crabrunner.error.v1` stdout on failures; persist stage prompt hash; ask crucible for a `materialized` schema tag; read heartbeat mtime during long polls.
- P3: re-scope the golden-corpus plan — corpus moves to crucible, producer conformance, report-only drift detector; archive the 2026-06-23-002 plan in favor of the re-scope.

### A.3 Modularization plan (god files)

Full section maps with line ranges in the subagent evidence; extraction phasing summarized here. All three files keep their public surface via re-exports (`src/index.ts` does `export *`; 300+ characterization tests drive the class facades), so every phase is test-green by construction.

**`src/orchestrator/core.ts` (15,615 LOC → target ~4.5–5k).**
- Phase 0 (pure module-level functions, ~2.1k LOC, zero risk): `journal-metadata.ts`, `core-state-clone.ts`, `stop-signal.ts`, `retry-backoff.ts`, anchor codecs → `anchor-codec.ts`, `queue-baseline.ts`.
- Phase 1 (narrow-state services): `rate-limit-admission.ts`, `review-artifact.ts`.
- Phase 2: `core-recovery.ts` (`recoverFromRunJournal` + 12 `recover*` + checkpoints, ~1.1k LOC) behind a `RecoveryHost` interface.
- Phase 3 (behavioral collaborators over a `CoreContext`): `intent-verbs.ts` (the "408a" seam already named in code), `failure-routing.ts`, `budget-pause.ts`, `gate-execution.ts`, `merge-actuation.ts`.
- Stays: `pollTick`, `dispatchIssue`/`admitAndDispatch`, `onRetryTimer`, `onWorkerExit`, `scheduleRetry`, lease/journal primitives, terminal-clear ordering invariants.
- Consolidation: a `parkIssueLoudly()` helper for the ≥7 hand-repeated "park loudly" sequences (failed.add → releaseClaim → clearTerminal → cluster → escalate → exhausted — a documented-ordering bug class); `deferRetry()`; `notify()`/`postCommentBestEffort()` wrappers.

**`src/orchestrator/runtime-host.ts` (9,651 LOC).** P1: the ~2.7k-LOC pure module tail (`merge-actuator-gh.ts`, `worker-process-control.ts`, `closeout-comment.ts`, `issue-detail-projection.ts`, `runtime-git.ts`, `prior-review-state.ts`, `journal-recovery.ts`). P2: narrow-state stores (`LoopTraceJournalStore`, `RateLimitSnapshotStore`, `ControlDocStore`, `PipelineStatusProjector`). P3: `runtime-service.ts` composition root + tick scheduler. P4: `buildOrchestratorCoreOptions()` extraction from the 740-LOC constructor. Note: `council-risk-predicate.ts` pattern-matches the literal path `src/orchestrator/runtime-host.ts` — update when splitting.

**`src/review/headless-council-gate.ts` (7,272 LOC → ~1,000).** The live surface is five exports consumed by the crabrunner dispatchers; ~47% (~3.4k LOC) is legacy engine reachable only from `runHeadlessCouncilGate` (zero non-test callers). Extract live modules first — `review-finding-parser.ts` (~1.1k, the structured-finding parser), `council-routing.ts` (~700), `review-context-io.ts`, `targeted-convergence.ts`, `review-prompts.ts`, `diff-paths.ts` — then quarantine `legacy-council-gate-engine.ts` and delete it with its test clusters **after porting the ~158/162 gate-driving tests that pin live parsing/routing semantics through the dead entrypoint**. This dovetails with CMUX removal step 3 (A.4).

**Cross-file consolidation (repeated patterns → shared modules):** subprocess exec wrappers (≥5 copies), atomic file replace (≥4), record/coercion guards (adopt existing `src/review/record-utils.ts`), env parsing helpers (≥6), journal reverse-scan "latest entry for X" reducers (≥4), sha256/stable-JSON, text truncation, `mapWithConcurrency`, and the five copies of the 10-minute triage timeout. Target grain: the existing extracted siblings (`review-verdict.ts`, `merge-candidate.ts`, `spine/review-aggregator.ts` — 200–800 LOC, pure core + injected I/O).

### A.4 CMUX removal

Post-SYMPH-812/985, **no cmux binary is ever executed by shipped code**. What remains: a dead executor (`runClaudeCmux`), a dead gate engine (A.3), shared types/validators trapped in cmux-named files, compat flags parsed-and-ignored, skill/deploy enforcement machinery, and docs. Three live edges depend on cmux-*named* modules for types/validators only: `crabrunner-claude-runner.ts` imports from `cmux-artifact-paths.js` (`isInside`/`realpathOrSelf`) and `cmux-claude-runner.js` (input/result types, `validateClaudeArtifact`); the live `claude-runner` bin does the same; the persisted result JSON still carries a `cmuxSpawnBin` field name (crabrunner writes its own bin path into it).

Removal order (tests green at each step): (1) extract validators/path-utils/types to neutral modules + resolve the mirror/SHA artifact-integrity contract (port-or-retire: crabrunner's `CollectedArtifact` seam has its own sha256; recommendation: **record contract-retired** — different transport — noting it in the materialization plan's terms); (2) delete the `runClaudeCmux` engine + mirror block + cmux filenames; (3) gate excision (riskiest; port live-semantic tests first — same work as A.3's council-gate quarantine); (4) delete retired kimi-replay CLI + bin; (5) flag/field sweep (`--cmux-spawn-bin` everywhere, `ClaudeRunnerResult.cmuxSpawnBin` v2 rename decision, planner aliases); (6) skills + enforcement (rewrite `skills/claude-runner` SKILL for crabrunner wording; delete `skills/council-review` (~2.4k LOC, superseded by crabbox-council); strip `validate-skill-installs` cmux entries + `ops/symphony-deploy` cmux functions); (7) docs (archive `docs/operations/01`, delete `ops/cmux-review-substrate-deploy` + test, reword stale comments — `standing-plan-shadow.ts:669` "cmux in prod" is factually false; keep the workflow-template negative guards as a permanent fence).

**Total: ~12.5–13k LOC deleted** (src ~2.9k; tests ~6.6k; skills/ops/docs ~3.2k). Out-of-repo (flagged, not touched here): `claude-config/skills/cmux-spawn` (canonical source — retire only AFTER repo enforcement drops or every `pnpm test` fails), `~/.agents/skills/cmux-spawn` symlinks, crucible `bin/cmux-spawn`, `.env.enc` CMUX vars (audit via sops-edit). Prod `.env.enc` also ships `SYMPHONY_COUNCIL_REVIEW_GATE` — zero consumers anywhere.

### A.5 Config externalization (ticketed: SYMPH-1074)

Census: **~116 distinct env names** (~66 `SYMPHONY_*`): council 28, review 9, crabrunner 11, planner/grounding 9, queue-audit 12, orchestrator-misc 4, tracker 5, slack 7, operator/observability 7, deploy 14, skills-validation 7, CI 10, +3 child-env injections. Plus hardcoded policy constants sprinkled through core/gate-handler/review (Appendix G highlights).

Dispositions (following crucible's `config/<surface>.json` + schema + fail-closed pattern):
- **New shared pipeline-config files (the big win):** `review-policy.json` (24 of 28 council vars + lane literals — model/provider/tools/timeouts/routing/thresholds; dual-read compat window ≥1 deploy train since these are live via `.env.enc`); `crabrunner-hosts.json` (the 11-var topology family — also fixes the dual-reader drift between `main.ts` and the adapter); `policy.json` (supervision constants relocated at current values — pure relocation, zero behavior change, no retuning without observed data).
- **WORKFLOW.md keys:** queue-audit family → new `queue_audit:` section; grounding extractor → `planner_grounding.extractor:` (kills the `studio2.local` literal); `SYMPHONY_SPEC_FIDELITY_MODEL` → `spec_fidelity.model`; `SYMPHONY_BASE_BRANCH` → `tracker.base_branch`; closeout flag → `notifications.closeout_comment`.
- **Keep env:** secrets (`LINEAR_API_KEY`, Slack tokens, LLM keys, operator token, webhook secret → `.env.enc`), deploy/paths family, CI family, per-run operator overrides, child-env markers.
- **Delete:** `SYMPHONY_COUNCIL_FORCE_LEGACY`, `SYMPHONY_LEGACY_REVIEW_SPAWN_BIN`, `SYMPHONY_REVIEW_PARSE_LEGACY_SECTIONS`, `SYMPHONY_COUNCIL_FORCE_OPUS`, one spelling from each alias pair (`ROUTING_MODE` vs `REVIEW_ROUTING_MODE`; `ACCEPT_NARROW` vs `NARROWER_RISK`), kimi-shadow toggles when that experiment concludes, `SLACK_CHANNEL_ID` hardcoded default.

Drift bugs found by the census (fix regardless of externalization): `SYMPHONY_COUNCIL_CLAUDE_MODEL` doubles as the spec-fidelity fallback (tuning the reviewer silently retargets the fidelity judge); crabrunner family parsed twice with different target-repo fallback chains; queue-audit family parsed twice with the CLI honoring 2 extra vars; merge wait ceilings defined in both `defaults.ts` and `merge-candidate.ts`; codex token caps duplicated as WORKFLOW keys and council env defaults; `SLACK_SIGNING_SECRET` set in a plist but read nowhere; `ops/com.slack-bridge.plist` points at the orchestrator binary instead of `slack-bot/server.js`; doc drift on `max_tokens_per_unit` (template 1.5M vs defaults 6M vs WORKFLOW.template.md 1.2M).

### A.6 Anti-sprawl enforcement

Crucible enforces mechanically what symphony enforces not at all: a **file-size ratchet** (new files ≤350 LOC; ≥600 may not grow), **god-file pins** (2 files pinned at current LOC, downward-only ratchet, full-set audit on main), **forbidden-new-pattern gates** on added lines in pinned files, an **env-read boundary** (named keys readable only in allowlisted files), **expiring waivers as data** (`{glob, rule, reason, expires}`), schema-versioned guard configs, and hermetic output-contract tests — all dependency-free node scripts on every PR, deliberately un-path-filtered so they're safe as required checks. Symphony today: CI test job (blocking), semgrep delta (blocking), diff-coverage ≥70% (**built but `continue-on-error: true`** since SYMPH-356), docs-sync gate covering exactly one AUTOGEN block, post-merge gate with auto-Linear-issue plumbing, and biome with `noUnusedImports`/`noUnusedVariables` **unenforced**.

Adoption plan (all report-only first via the existing `continue-on-error` + post-merge-issue channels; thresholds confirmed against symphony's observed PR stream, not copied blind):
1. **God-file pins** (S): port `check-god-files.mjs`/`guard-core.mjs` near-verbatim; pin core.ts/runtime-host.ts/headless-council-gate.ts at current LOC; downward-only `--update-pins`; fix crucible's own gap by wiring the guard self-tests into CI.
2. **File-size ratchet** (S): new src files ≤350, ≥600 no-growth; 2-week report-only window to sanity-check thresholds against symphony's distribution.
3. **Unused imports/vars** (S): enable the two biome rules after one auto-fix pass — extends the already-blocking lint step.
4. **Docs-sync expansion** (S–M): register remaining CLI `--help` AUTOGEN blocks.
5. **Diff-coverage flip** (S): the ramp has been running since SYMPH-356 — review its data and remove `continue-on-error` if pass-rates support it.
6. **Env-var registry** (M): generalize crucible's env-read boundary — committed baseline of the ~116 names + read sites; fail on NEW unregistered reads (delta-scoped, nothing retroactive).
7. **Dead-export gate** (M): knip with committed baseline; fail only on new dead exports.
8. **Forbidden-new-pattern list for pinned files** (M, later): mine merged diffs for the patterns that actually grow core.ts before writing regexes.

Not transferred: crucible's config-surface brace-parser (fragile for TS — do it as an AST vitest instead), codex lane-hook trust machinery (different trust boundary), canonical-floor git hooks (symphony's enforcement plane is CI), hermetic-subset markers (vitest already hermetic). Transferable discipline for SYMPH-947: **freeze mechanically, shrink opportunistically** — crucible never CI-mandates retroactive decomposition.

---

## 3. Section B — Linear audit

> Filled after the two clustering agents' sweeps of all 192 open SYMPH issues (136 Backlog / 51 Triage / 3 Blocked / 2 In Progress) + 20 open MOB issues sitting in Symphony releases. See B.1–B.4 below and Appendix D.

### B.1 Queue shape

At pull time (2026-07-09 08:53): **192 open SYMPH** (136 Backlog / 51 Triage / 3 Blocked / 2 In Progress — zero Todo, consistent with the dispatch fence being closed) + **20 open MOB** inside Symphony releases. 100% agent-generated; the Triage lane is dominated by per-PR council Track filings (by design, one per PR), which is exactly the intake stream C.5 formalizes.

Shape findings:
- **The queue is bimodal**: a small operational-critical core (R1's ~6 open, the contract/conformance family, 2 verified correctness gaps) buried under a long tail of single-file test-hardening Track tickets and deferred measure-first tickets. Prioritization signal exists (releases, comments) but Triage-state noise swamps it — SYMPH-987/989/1005 (verified correctness gaps) sat at the same prio-0 Triage level as test nits.
- **Duplicate/absorbed rate is material**: this audit closed 21 tickets (11% of open SYMPH) as stale, fixed-elsewhere, or absorbable without losing any scope — and that's before the older half's pass. The generator files faster than anything reconciles.
- **State semantics mostly hold** (Triage=intake, Backlog=planner pool), with drift at the edges: one ticket sat In Progress with both its tests `it.skip` (943); an epic sat open whose own gate comment said NO-BUILD (960).
- Post-reconciliation (Appendix E): **61 closures, 11 creates** → open SYMPH 192 → 145; MOB-in-releases 20 → 17.

### B.2 Root-cause clusters

Merged across both halves (per-ticket evidence in Appendix D). The headline: **61 of 212 open issues (29%) closed today without losing any scope** — every closure either verifiably landed already, targeted deleted/retiring code, duplicated a sibling, or consolidated into a root-fix ticket. That ratio is the empirical case for the C.5 triage layer: the filing loop generates symptom tickets ~3× faster than roots get named. A second correction: the intake is *young* (slice-A max age 30 days, not months) — this is a fast generator, not an old backlog.

| Cluster (size) | Diagnosed root cause | Root fix | Closed today |
|---|---|---|---|
| codex-retire (13) | In-process app-server client (2.7k LOC) is a high-entropy surface mass-producing flake/hardening/contract tickets | **SYMPH-949** (W2) — everything resolves by deletion | 282, 307, 323, 412, 423, 424, 428, 669, 943, 1044 → 949; 342 → 1079 (redesign); 393 kept (independent cull) |
| cmux-residue (11) | Review substrate replaced by crabrunner (#640, #714–722) but deletion trails | **SYMPH-1043 + SYMPH-1008** (W5) | 275, 561, 600, 602, 742, 844, 885, 1027, MOB-90 closed; 1037 closes on 1043 |
| crabrunner-contract (~20) | Zero cross-repo tests on the execution seam; review-seam drift re-pins by hand | **SYMPH-1071** (W1, new — execution seam), **SYMPH-999/914** (review-seam corpus), **SYMPH-977** (re-baseline; absorbed 935/957), **SYMPH-1078** (security coverage re-target, new) | 935, 957, 278 |
| council-track-tail (~20) | Per-PR council files P3 Track findings by design; surfaces then move and findings age into noise (709 accreted ~20 items over 6 rounds) | **SYMPH-1076** (C.5) now owns the missing lifecycle policy: file-time severity floor + expiry-on-subject-change | 636, 640, 861 + the adapter 7 (below); rest batched by module |
| crabrunner-adapter-batch (7) | #714/#716 shipped fast; Track tail all in one file | **SYMPH-1072** (new, R2) | 1051–1058 (7) |
| planner-trust-ramp (~25) | Shadow-until-trust *by design*; the build trajectory landed (#698–#728) but measures nothing (flags unset) | **SYMPH-1070** (W0, window) → **SYMPH-1034 + SYMPH-875** (cross-linked, R3, the cutover); verified correctness gaps kept: 989, 1005, 1019 | 960, 1016, 863 |
| retry-park-semantics (5) | Missing stage-entry reducer seam in core.ts — the 4×-recurring signature-clearing defect class; SYMPH-405 shipped events but NOT the seam | **SYMPH-403 REACTIVATED** (its absorption into 405 never actually happened; 47 raw `issueStages[` sites verified); 294 is its first consumer | 337 (fixed) |
| config-sprawl (6 + census) | Four parallel workflow/prompt surfaces drift independently; ~116 env names | **SYMPH-641** (workflow surfaces; cluster note added) + **SYMPH-1074** (externalization, new) | 419/738 kept but tied to 641 |
| context-tooling-canary (5) | June token-burn pain spawned 3 parallel tool canaries + 1 dead integration | **SYMPH-1080** (new, consolidated, post-949) | 580, 637, 682, 693; 380 kept (deliberate deferral marker) |
| journal-replay (3) | — none: all three verifiably fixed on main; cluster emptied | (987 from slice-B remains the one live journal gap) | 297, 400, 502 |
| god-file-growth (3) | No mechanical ceilings; agent-built code accretes into the biggest file | **SYMPH-1073** (W4 pins, new) + **SYMPH-947** (deferred map; absorbed 365/386); 364 kept as supervision mitigation | 365, 386 |
| dashboard-polish (8 + 5 MOB) | Council tails against a fast-iterating localhost surface; threat-model mismatch | — accepted-behavior decisions recorded on each | 563, 564, 565, 566; keeps batched (273/782/851; MOB 299–311) |
| deploy-ops (7) | Independent chores, no shared root | **SYMPH-888** (deploy gates); 362 flip is over-ripe (calibration window 4× exceeded); **270 has a hard 2026-09-16 deadline** | 887 |
| planner-batching (8) | Not band-aids — council-verified R3 design chain, sequenced behind 875 | 795 epic + 876–883, healthy | — |
| pipeline-halt / observability / token-cost | Small real edges (646/647/268); measurement windows starve while dispatch is halted — correctly parked, all queue behind 949's restart | continuous streams (C.2) | 959, 745 |
| crucible-side + crabbox-ssh (8) | Controller-side transport lifecycle (894's thread re-diagnosed it 3×; fix landed upstream — detached spawn + process-group kill) | 894 → retest-and-close; 952 recurrence stays | MOB-205, MOB-253 (fixed in crucible) |

### B.3 Release & epic reconciliation

All four release targets are stale (2026-06-26) and should be re-dated when W0 ships; membership was reconciled today (E.3) so each release again means something:

- **R1 · Supervised self-dev readiness — 54/60 done; now 9 open and coherent.** Post-reconciliation contents ARE the operational-critical path: SYMPH-949 (W2 keystone), 999 (first contract slice), 1070/1071 (W0/W1, audit-filed), 911 (token measurement, queues behind restart), 914 (umbrella), 412/774 (close via 949 — verified from the SYMPH-945 brief's AC), MOB-391 (the one *regressing* item: orchestrator boundary violated again 7-02; needs the orphan-diff detector + fix-dispatch in crucible). **R1 done ≈ "operational" per C.1 minus the planner-authority criterion**, which is deliberately R3.
- **R2 · Review & merge trust GA — 25→22 open.** Review-path hardening tail + the new adapter batch (1072). Two crucible-side members closed as fixed (MOB-205/253). Slice-A dispositions (D.3) cover its older members (267–742 range).
- **R3 · Dispatch intelligence GA — 29 open at pull; 27 after today.** Now the planner-authority home: 875 (shadow→active), 1034+1069 (trust ramp, moved in today), 1076 (intake-triage ramp), the batching family (876–884), multi-repo phases (899–903; the 845 design closed Done today; 343 cancel-fixed), 891 (release-train awareness). Coherent as "everything that makes dispatch smart," all correctly downstream of W0's data.
- **R4 · Observability, cost & outcome — 30 open, 0 done, never started.** A parking lot: MOB alerting Phase-2 batch (289–297), dashboard-polish batch (299–311), token-cost tickets whose windows starve until dispatch restarts, plus 16 older SYMPH observability tickets awaiting the slice-A verdict. Keep as the explicit "after operational" bucket; its token-cost members are consumed by the continuous measurement stream (C.2) rather than dispatched individually.

**Epics vs the code audit:** SYMPH-948 (umbrella) closed after its 2026-06-28 reshape — its "no cheap gates" decision is *respected, not reversed*, by W4's mechanical ceilings (SYMPH-1073 body records the distinction). SYMPH-947 (god-file decomposition) **stays deferred** — the audit's A.3 maps make the eventual work cheaper, and W4's pins freeze growth meanwhile; un-deferring the behavioral splits before W2 lands would churn the dispatch path under the migration (C.3). SYMPH-945/949 (codex retirement): the epic reads "in progress" but the code audit shows the default path untouched — and, decisively, its crucible-side hard gates (MOB-588 turn-cap, MOB-589 cost-kill) are **Done**, so the stall reason evaporated; comment recorded on 949. SYMPH-946 (planner output-validation boundary) landed (#698) and is consumed by the planner-trust-ramp cluster's remaining correctness gaps (989, 1005, 1019).

### B.4 Dispositions applied

See Appendix E (mutation log).

---

## 4. Section C — Roadmap

### C.1 Definition of "operational"

Adopting the working definition with two sharpenings (evidence-measurability and an explicit token-cost denominator):

> **Symphony is operational when it runs the full 4-stage pipeline unattended on ≥1 real product where (1) every stage executes on crabrunner lanes — no codex app-server in the worker path, no CMUX anywhere; (2) triage + planner are wired: plan-driven dispatch ordering live (`shadow_mode: false`) with the trust-ramp evidence that justified it recorded on SYMPH-1034's criteria; (3) a symphony↔crucible lane failure is diagnosable from persisted artifacts alone (correlation ID present in both repos' evidence, structured error codes captured, liveness signal during runs); and (4) orchestration cost is measured and small: orchestrator token spend ≤10% of worker token spend over a trailing week of runs (threshold set from the observed ledger, revisable — the point is the ratio is measured and bounded, not the specific number).**

Two deliberate exclusions: god-file decomposition and CMUX deletion are **not** operational criteria (they're velocity/hygiene work — W4/W5); multi-repo is post-operational (W6).

### C.2 Workstreams

**W0 — Open the measurement window** (size: XS, config-only + deploy) — **SYMPH-1070 (R1)**
- Entry: now. Exit: `WORKFLOW-symphony.md` sets `planner_grounding.enabled`, `code_grounding.enabled`, `queue_triage.plan_review.enabled: true`; deployed; first `review_tier2.*`/grounding-evidence/diff-gate journal rows observed on pro14.
- Evidence gate (for consumers, not for W0 itself — it's report-only): none to ship; data accrues for W3.
- Follow-on inside W0: SYMPH-1021 extractor reachability (studio2 endpoint or substitute) upgrades grounding evidence from deterministic-fallback to LLM-extracted; re-measure cost per the shadow-tick plan.
- Depends on: nothing. Unblocks: W3 (all of it), SYMPH-1034 threshold session.

**W1 — Crucible contract hardening** (size: S) — **SYMPH-1071 (R1)**
- Scope: the P1 consumer fixes (`measurement_quality` alias, `reasoning_output_tokens`, named error-code table); execution-seam conformance harness (live-gated round-trip + frozen fixtures); P2 correlation ID via `workspace_identity` + parse `error.v1` stdout + persist stage prompt hash; heartbeat-mtime liveness read.
- Exit: conformance suite green in CI against both fake and (when present) live crucible; a synthetic lane failure diagnosable from artifacts alone in a tabletop exercise.
- Depends on: nothing. Unblocks: W2 rides this seam at 4× current volume; protects W3's tier-2 lanes.
- Also: re-scope-and-archive the golden-corpus plan (P3) — corpus to crucible as a follow-up ticket, not a blocker.

**W2 — Finish the deterministic spine: SYMPH-949 execution migration** (size: L — the critical path)
- Scope: per the 2026-06-28 plan Rev 3 (U0–U4): generic crabrunner backend for investigate → implement → merge; one lane invocation per stage; signal parsing (`lastTurn.message`); delete in-process codex path last (U4 = SYMPH-945's actual retirement).
- Entry: MOB-588 (turn cap) + MOB-589 (cost kill) — **both Done; verify e2e as U0's first act** (the plan's own hard gates).
- Exit criteria per stage: crabrunner lane completion parity vs codex baseline on the symphony product (completion rate, retry rate, wall-clock, token cost), measured over ≥1 week of real dispatches per stage before the next stage flips; template default flips only after all three.
- Depends on: W1 (contract harness). Unblocks: the token-burn goal (retiring the ~85% orchestrating-agent share), session-orchestrator absorption, C.1 criterion (1).

**W3 — Planner authority ramp** (size: M, mostly evidence + one config flip at a time) — rides **SYMPH-1034 + SYMPH-1069 (both moved to R3)**
- Scope: SYMPH-1034 threshold-setting session on W0's data (exit criterion, kill criterion for tier-2, FP rate, cost-per-true-catch); then `shadow_mode: false` (plan-driven ordering); then `auto_release_frontier` relaxation. Comment-enrichment (SYMPH-916 window) and topology decision (SYMPH-905) resolve inside this stream.
- Exit: plan-driven dispatch live on the symphony product with the ramp evidence recorded; operator release gate relaxed to the extent the evidence supports.
- Depends on: W0 (data). Independent of W2 (planner rides the shadow tick, not the worker path) — can proceed in parallel.

**W4 — Anti-sprawl gates + god-file drain** (size: M spread out) — gates: **SYMPH-1073**; diff-coverage flip: SYMPH-362; decomposition map: SYMPH-947 (stays deferred); config externalization: SYMPH-1074; dead-code batch: SYMPH-1075
- Scope: A.6 gates 1–5 (pins, ratchet, unused-imports, docs-sync, diff-coverage flip) report-only → blocking on observed data; then SYMPH-947 un-deferred in guardrail-first form: Phase-0/P1 pure extractions of core.ts + runtime-host.ts and the live-module extractions of the council gate (A.3), opportunistically, behind the pins.
- Exit: three pinned files not growing (enforced); ≥2 extraction phases landed per file; shared-module consolidations (exec/atomic-write/env-parse) done.
- Depends on: nothing hard; behavioral splits (core.ts Phase 2–3) sequenced **after** W2 lands to avoid churning the dispatch path under the migration.

**W5 — CMUX deletion** (size: M, mostly mechanical) — **SYMPH-1043 + SYMPH-1008** (A.4's 7-step order + out-of-repo flags recorded on 1043; absorbed 885/1027)
- Scope: A.4 steps 1–7 (~12.5k LOC). Steps 1–2 anytime; step 3 (gate excision) after/with the council-gate extraction in W4; steps 6–7 close the operator-machine drift (the `pnpm test` pretest failure this audit hit).
- Exit: zero cmux references in src/tests/ops/skills except frozen docs; `validate-skill-installs` no longer enforces cmux-spawn; out-of-repo retirements flagged to claude-config.
- Depends on: W4's council-gate test-porting for step 3 only.

**W6 — Multi-repo workspaces (design only now)** (size: design S; build L later) — existing tickets: SYMPH-845 (design delivered — closed Done this session) + phases SYMPH-899–903 (R3)
- Shape recommendation: extend the workspace manager to materialize N repos per work unit under one workspace root (primary repo + `linked_repos[]` in WORKFLOW/ticket scope), with per-repo base branches, a shared prompt context block enumerating repo roots, per-repo diff/PR outputs, and supervision's write-collision scope extended across repos. Crabrunner side: lanes already take a workspace path; the manifest's `workspace_identity` carries the multi-repo map (no crucible schema change). Linked-issue pairs (symphony+crucible) become one work unit with two PRs and a cross-repo verify command set.
- Sequencing: design brief after W2 proves single-repo lane parity; build after operational. Do not build now.

**Continuous stream — token-cost measurement:** the stage-usage ledger already exists; W2's exit criteria consume it; C.1(4)'s ≤10% ratio gets a weekly report (report-only, per standing preference) starting when W2's first stage flips.

**Continuous stream — in-cycle intake triage (SYMPH-1076, R3):** the standing process that keeps agent-filed tickets from re-silting the queue, with a phased handoff to the automated triage/planner. Full design in Section C.5; it is a parallel stream, not a serialized workstream — T0 (operator-led cadence) must be running **before** W2 restarts dispatch, because dispatch is what generates intake (~1 Track ticket per PR by design).

### C.3 The ordering call

**Recommended order: W0 → W1 → W2 (critical path), W3 in parallel off W0, W4/W5 as background lanes, W6 design after W2.**

The strongest alternative is **god-files-first** (W4 before W2): "everything else lands inside core.ts/runtime-host.ts; decompose first and all subsequent work is cheaper and safer." Rejected, with its strength acknowledged:

1. **The migration doesn't land where the god files are worst.** W2's work lives in `stage-execution/` (already modular), `agent/runner.ts`, and per-stage config — the dispatch heart of core.ts changes little (dispatch one lane, collect one result replaces worker-loop plumbing that mostly lives in runner/backends). The extraction maps show the tangled regions (retry/park/journal) are precisely the ones W2 doesn't touch.
2. **Operational is the stated goal; decomposition is a velocity multiplier, not a capability.** The 85% orchestration-burn problem is retired by W2+W3, not by smaller files. Deferring W2 behind a multi-week refactor extends the burn.
3. **The bleeding stops without the surgery.** W4's pins/ratchet (days of work, report-only) freeze god-file growth immediately — the actual root cause ("agent-built code accretes into the biggest file") is addressed by the gate, while extraction proceeds opportunistically behind it.
4. **Risk asymmetry.** A migration stalled on a half-done decomposition leaves both incomplete. A decomposition proceeding behind pins while the migration runs costs only occasional rebase friction — and Phase-0 extractions are pure-function moves with near-zero conflict surface.

Second alternative — **contract-first everything (W1 as a big program before W2)**: rejected as a program, adopted as a small stage (W1 is deliberately scoped to P1/P2 consumer-side fixes + the harness, ~days). The boundary shows drift but nothing broken; hardening beyond the P1/P2 list before the migration would be speculative coverage of surfaces W2 may reshape.

W0 before everything because it is nearly free and every planner-side decision (SYMPH-1034 thresholds, SYMPH-905 topology, shadow-mode flip) is starved of data until it happens — three landed workstreams (#704–#728) currently measure nothing.

### C.4 Risk register

Carried from CLAUDE.md (verified still real) plus audit-surfaced:

| Risk | Evidence | Mitigation home |
|---|---|---|
| `active_states` omissions cause silent failures (hit 3×) | CLAUDE.md fragile-areas | config-contracts validation exists; add a startup assert that every state written appears in active_states (W4 gate candidate) |
| LiquidJS `strictVariables` throws on missing context | CLAUDE.md | template-context conformance tests exist; keep |
| `scheduleRetry` dual-use (failures AND continuations) — retry cap must not count continuations | CLAUDE.md; core.ts:13040 | pinned by retry-novelty tests; preserve through W4 Phase-3 extraction |
| Hook scripts cwd/resolution semantics | CLAUDE.md | do-not-modify boundary holds |
| `stall_timeout_ms` default too short for Claude agents | CLAUDE.md | WORKFLOW-level; fold into A.5 policy.json move |
| **Codex app-server remains the entire worker path while its retirement epic reads as "in progress"** | A.1 | W2 is the fix; until then treat codex client as production-critical (no opportunistic deletion) |
| **Measurement window believed open but shut** — landed telemetry emitting nothing | A.1 (#724/#725/#728 inert) | W0; add a "flag-reachability" line to future wiring PRs' AC (ticketed) |
| Crucible contract drift (6 DRIFTED / 6 FRAGILE) + zero execution-seam cross-repo tests | A.2 | W1 |
| `turn_cap_reached` / cost-kill signals (the just-cleared MOB-588/589) misclassified as generic `runner_failed` by the substring mapper | A.2 finding 8 | W1 P1 (must land before W2 relies on those signals) |
| Staged-binary coupling: fresh state root rejects all submits | A.2 finding 9 | W1 (document + preflight `crabrunner stage` in deploy) |
| God files (3 files = 27% of src LOC); park-sequence ordering invariants hand-repeated ≥7× | A.3 | W4 pins immediately; `parkIssueLoudly()` consolidation |
| Dashboard server is also the operator-intent control plane — `server.port` off breaks release_batch, not just telemetry | A.1 periphery | document in ops 05; risk-register only |
| fence-sync launchd job lives outside the repo; self-declared throwaway pending SYMPH-891 | A.1 periphery | ticket carried in reconciliation |
| Council alias-pair env vars + cross-purpose `SYMPHONY_COUNCIL_CLAUDE_MODEL` | A.5 | review-policy.json externalization (W4-adjacent) |
| Remote crabrunner runs memory-fence evidence (crash orphans results) | A.2 debuggability | W1 P2; multi-host is W6-era anyway |
| Operator-machine skill drift breaks `pnpm test` pretest (hit in this audit) | baseline | W5 step 6 removes the cmux entry; keep the rest |

### C.5 In-cycle intake triage: process + autonomy ramp (SYMPH-1076)

**The problem this solves.** 100% of tickets are agent-generated and ~75% are filed on-the-fly during implement/review runs. The filing agent is mid-task, sees one PR's blast radius, and optimizes for "record it and move on" — so it systematically underreports root causes and proposes band-aids ("harden X") over structural fixes. Left untriaged, clusters of these accrete around undiagnosed roots; god-file growth is the canonical output of that loop, and this audit's Section B found the same pattern at queue level (52-ticket Triage lane dominated by per-PR Track filings; 7 adapter tickets against one file; 3 tickets for one conformance drift).

**Design principle: separate filing from diagnosis.** Filing stays cheap, in-the-moment, and provenance-rich — we *want* agents to record findings mid-run. Diagnosis moves to a batch triage layer that reads across tickets, verifies claims against fresh main, and clusters to root cause before anything is promoted. The Linear state semantics already encode the gate: **Triage = auto-intake** (agent filings land here, drive nothing), **Backlog = planner candidate pool** (only the triage layer promotes into it), **Todo = dispatch signal**. The ramp below formalizes who operates the Triage→Backlog gate and how that operator changes over time.

**The rubric (fixed across all phases — this audit's Section B method, made repeatable):**
1. Read title + description + **all comments** (dispositions frequently hinge on "actually fixed by #X" comments).
2. Verify dispositive claims against freshly fetched origin/main (and crucible HEAD where cross-repo) — grep the symbol, cite the line.
3. Assign a root-cause cluster; when ≥3 tickets share a root, name the root and check whether a root-fix ticket exists.
4. Disposition ∈ {keep, keep-but-move-release, absorb-into, supersede-by-root-fix, cancel-fixed (cite PR), cancel-stale (why), needs-root-cause-trace} — with a comment trail on every mutated ticket.
5. Never promote a "harden X" band-aid without tracing the root; batch small same-file/same-module items (token-cost grouping).

**The ramp (each promotion gated on observed evidence; thresholds set from T1's measured data, never guessed):**

- **T0 — operator-led cadence (start now, before W2 restarts dispatch).** A recurring frontier-session pass (weekly, or per ~25 intake tickets, whichever first) applying the rubric to everything in Triage plus new Backlog arrivals. Output: dated disposition log appended to a `docs/plans/` triage note + applied Linear mutations. Cost containment: delegate ticket-reading to 1–2 subagents (~50 tickets each) exactly as this audit did; main context only adjudicates. The audit's two clustering prompts are the seed rubric doc.
- **T1 — planner shadows triage (report-only).** The queue-triage/backlog-audit machinery emits proposed dispositions with root-cause tags for the same intake the operator triages; agreement is scored per disposition class (absorb / cancel-fixed / cancel-stale / keep / root-promote). Prereqs, all existing work: the measurement window (W0/SYMPH-1070); SYMPH-989 resolved so cull candidates are *visible* to the planner in proposal mode (today hygiene mode strips them — the planner literally cannot propose kills); SYMPH-965 + MOB-604 so filed-by-agent provenance is machine-readable. Runs inside the shadow tick; no new infrastructure.
- **T2 — scoped autonomy (audit-not-gate).** Disposition classes where T1 shows sustained high agreement auto-apply — expected first: exact-duplicate absorb and verified-fixed cancel with PR citation (mechanically checkable). Applied + logged + Slack-digested, reversible; no operator pre-approval (autonomy-over-guardrails: audit, don't gate). Root-cause *promotion* — creating a root-fix ticket that supersedes N symptom tickets — stays advisory: it's the class where in-the-moment misdiagnosis does the most damage, so it earns autonomy last.
- **T3 — full triage authority.** The planner owns Triage→Backlog inside its tick; the operator reads digests. Final gate: reopen/rework rate on its dispositions and the review-survival rate of its root-fix tickets — i.e., its diagnoses hold up downstream, not merely agree with historical operator calls.

**Why this arrives at the automated planner rather than starting there:** the planner's own trust-ramp (W3/SYMPH-1034) uses the same shape — shadow → measured agreement → advisory → authority. Intake triage is deliberately the *second* consumer of that pattern: dispatch ordering has a cheap ground truth (the comparator) while triage dispositions need operator adjudication to score, so triage autonomy rides one step behind dispatch autonomy on the same evidence machinery (decision-quality events, calibration rows, per-lane telemetry from #728).

---

## 5. Dispatch next

**Recommendation: W0 — open the measurement window (SYMPH-1070, R1, filed by this audit).** One PR against `pipeline-config/workflows/WORKFLOW-symphony.md` setting `planner_grounding.enabled: true`, `code_grounding.enabled: true` (its dependency), and `queue_triage.plan_review.enabled: true`, plus a pro14 deploy and a journal check that `review_tier2.*` / grounding-evidence rows appear on the next shadow ticks.

Why it unblocks the most: three landed workstreams (planner grounding #704–706/#724, standing-plan tier-1/tier-2 review #710–711, diff gate + per-lane telemetry #725/#728) are all waiting on exactly this data to exist; SYMPH-1034 (trust-ramp thresholds) cannot be scheduled without it; W3 is gated on it end-to-end. It is report-only by construction (three independent report-only designs), config-only in blast radius, reversible by reverting one file, and costs hours including the deploy. Nothing else on the board buys that much unblocking per unit of risk.

(The runner-up is starting W2/SYMPH-949 U0 — its crucible gates MOB-588/589 cleared and nobody noticed — but U0's first act is an e2e verification task that W1's harness makes cheaper, so the efficient sequence is W0 today, W1 immediately after, W2 U0 on its heels.)

---

## Appendix A — LOC table (top 40 non-test files, `src/`)

| LOC | File |
|---|---|
| 15,615 | src/orchestrator/core.ts |
| 9,651 | src/orchestrator/runtime-host.ts |
| 7,272 | src/review/headless-council-gate.ts |
| 2,701 | src/codex/app-server-client.ts |
| 2,555 | src/logging/runtime-snapshot.ts |
| 2,471 | src/observability/dashboard-render.ts |
| 2,295 | src/spec-review/spec-review.ts |
| 2,234 | src/orchestrator/merge-candidate.ts |
| 2,128 | src/agent/runner.ts |
| 2,085 | src/observability/dashboard-server.ts |
| 1,994 | src/orchestrator/code-grounding.ts |
| 1,906 | src/tracker/linear-client.ts |
| 1,854 | src/domain/model.ts |
| 1,661 | src/agent/triage-planner.ts |
| 1,657 | src/audit/backlog-audit.ts |
| 1,453 | src/orchestrator/pipeline-notifier.ts |
| 1,335 | src/config/config-resolver.ts |
| 1,334 | src/stage-execution/crabrunner-scheduler-client.ts |
| 1,319 | src/cli/manager-plan.ts |
| 1,233 | src/review/calibration/fixtures.ts |
| 1,192 | src/cli/spec-review-watch.ts |
| 1,080 | src/tracker/linear-queries.ts |
| 1,065 | src/claude-runner/cmux-claude-runner.ts |
| 1,015 | src/review/crabrunner-review-job-group.ts |
| 1,000 | src/orchestrator/standing-plan-shadow.ts |
| 955 | src/tracker/ticket-feature.ts |
| 935 | src/orchestrator/dispatch-comparator.ts |
| 878 | src/claude-runner/crabrunner-claude-runner.ts |
| 857 | src/calibration/digest.ts |
| 839 | src/cli/symphonyctl.ts |
| 804 | src/review/review-artifacts.ts |
| 783 | src/orchestrator/grounding-extractor.ts |
| 781 | src/config/types.ts |
| 771 | src/shared/process-tree.ts |
| 750 | src/review/spine/review-aggregator.ts |
| 729 | src/stage-execution/crabrunner-backend.ts |
| 724 | src/policy/hard-stops.ts |
| 718 | src/domain/standing-plan.ts |
| 707 | src/orchestrator/supervision.ts |
| 706 | src/orchestrator/signature-cluster.ts |

Totals: `src/` 119,998 LOC; 25 non-test files ≥600 LOC; 30 more in 350–599. Test mirrors: `tests/orchestrator/core.test.ts` 18,479 LOC (321 tests); `tests/orchestrator/runtime-host.test.ts` 12,875 (239); `tests/review/headless-council-gate.test.ts` 9,092 (162, ~158 of which drive the dead legacy entrypoint).

## Appendix B — Crucible boundary: interface inventory & drift detail

**Seam A (`bin/crabrunner` scheduler CLI).** Invocations (all cwd=crucibleRoot, execFile, 16 MiB maxBuffer, 120s default timeout; consumer `src/stage-execution/crabrunner-scheduler-client.ts`):
- `submit --manifest-file <tmp> --repo-root <root> --state-root <root> [--no-stage]` → `crucible.crabrunner.status.v1`; admitted iff `state ∈ {accepted,queued,starting,running,complete}`.
- `status --job-id <id> --state-root <root>` — polled 1s × ≤1800; waits `collectible===true`; 3 grace polls for terminal-not-collectible.
- `collect --job-id <id> --state-root <root>` → `crucible.crabrunner.collect.v1` `{job_id,state,status,archive_path,materialized}`; `materialized.entries[*]` names lead with `/`; caps 256K primary / 64K entry / 512K total; usage from entries matching `*/artifact/*.usage.json`.
- `cancel --job-id <id> --state-root <root>` — killed iff `state==="stopped"`.
- `run …` (remote/ssh path; all 20+ flags verified against `CRU/crabrunner/src/cli.ts:184-258`) → `crucible.crabrunner.run-result.v1` incl. `workspace_sync_artifact{path,sha256}` (re-hashed on receipt).
- Manifest `crucible.crabrunner.job.v1`: job_id = `<issue>-<stage>-<sha256(idempotencyKey)[:8]>`; model slug `provider/model`; `closeout_policy:"disabled"`; `lane_worker_protocol:"lane-worker.v1"`; profile `write` iff implement.
- Usage `crucible.lane-worker.usage.v2`: summable iff `measurement_kind ∈ {true,estimated,partial}`.
- Status fields consumed: schema, job_id (identity-asserted), state, message, worker_pid/pgid, updated_at, artifact_path, usage_path, collect_archive, workspace*, collectible, error_code, heartbeat_seq* (*= drifted, see below).
- Env passed: `SYMPHONY_CRABRUNNER_{ROOT,TARGET_REPO,STATE_ROOT,HOST,REMOTE_USER,REMOTE_PORT,REMOTE_WORK_ROOT,REMOTE_STATE_ROOT,REMOTE_ARTIFACT_DIR,CRABBOX_BIN,VERSION}`. State root default `~/.crucible/crabrunner` both sides.

**Seam B (review spine).** `node <spine> {council-triage|cross-exam-select|convergence-decision}` with `--review-file/--reviewer` pairs etc.; 60s timeout, 64MB buffer; `SpineUnavailableError` fail-closed on exit≠0/bad JSON/schema mismatch. Schemas zod-pinned (`crucible.session-orchestrator.{council-triage,cross-exam-select,convergence-decision}.v1`). MOB-348 verdict vocabulary (`PASS|CHANGES_REQUESTED|BLOCKED`); symphony normalizes legacy `FINDINGS` pre-spine (SYMPH-908).

**Seam C (review-quality ledger).** `node <ledger> record --triage-file … --blocking-fps … --review-tier --run-id --pr --head-sha --round`; fail-open, never gates merge.

**Drift findings (full):**

| # | Sev | Finding | Symphony | Crucible |
|---|---|---|---|---|
| 1 | DRIFTED | `heartbeat_seq` has no writer — progress evidence always null | scheduler-client.ts:186,1216-1226 | types.ts:111 only; no writer in crabrunner/src or lane_workers |
| 2 | DRIFTED | `status.workspace` doesn't exist in `CrabrunnerStatus`; falls back to artifactRoot | client.ts:183,463,748; backend.ts:670,679 | types.ts:93-124; real fixture lacks key |
| 3 | DRIFTED | reasoning tokens: writes `reasoning_output_tokens`, reads `reasoning_tokens`/`reasoningTokens` | client.ts:244,252,1177-1180 | lane_workers/usage.ts:223,253,345 |
| 4 | DRIFTED | materialized `"invalid"` mapped to `missing`/`producer_predates_materialization` | collected-artifact.ts:71-79,113-123 | collect-materialize.ts:20,43-45 |
| 5 | DRIFTED | docstring claims unconsumed schemas; run-result ref literal is `workspace-sync-artifact-ref.v1` (unpinned string, no breakage) | crabrunner-claude-runner.ts:47-54; client.ts:203-209 | types.ts:175-179 |
| 6 | DRIFTED | crucible alignment doc describes pre-SYMPH-908 `PASS\|FINDINGS` | tests/review/crucible-verdict-contract-cutover.test.ts:108-141 | docs/review/07-symphony-alignment.md |
| 7 | FRAGILE | `measurement_kind` is compat alias; canonical `measurement_quality` unread | client.ts:234,1114,1125 | usage.ts:75-78,99 |
| 8 | FRAGILE | substring error mapping: `turn_cap_reached`→`runner_failed`; `admission_lock_timeout` would map to `timed_out`; `stall`/`kill` mappings dead | client.ts:1071-1091 | host.ts:2146; contract doc :548-579 |
| 9 | FRAGILE | submit default `require-ready`; symphony never runs `crabrunner stage` — fresh state root rejects all submits | client.ts:342-356 | cli.ts:264; host.ts:1405-1462 |
| 10 | FRAGILE | local poll budget fixed 1800×1s, not derived from timeout (remote path derives it) | client.ts:104-105,386-418 vs 674-678 | host.ts:1419-1440 |
| 11 | FRAGILE | `crucible.crabrunner.error.v1` on stdout discarded at exit≠0; only stderr text surfaced | client.ts:779-785,813-819,847-853 | cli.ts:350-357 |
| 12 | FRAGILE | spine consumed via 13.8k-line skill script (SYMPH-909 narrow CLI pending); static-analysis findings would lack `reviewer` field symphony's zod requires (latent) | crabbox-spine-client.ts:27-30; schemas.ts:31 | docs/crabrunner-execution-contract.md:8-10 |

**Debuggability gaps:** no shared correlation ID (manifest lacks runGroupId/stageAttempt/idempotencyKey; fix via free-form `workspace_identity`); error_code payloads discarded; no liveness reads during polls (heartbeat/progress files exist crucible-side, content-withheld in materialization); rendered stage prompt deleted post-run with no hash (claude adapter keeps `promptSha256`, stage backend keeps nothing); remote run-results memory-fenced (crash orphans evidence); scheduler argv not logged.

**Coverage:** review seam covered (fixtures + live-gated conformance + consumer replay). Execution seam: zero cross-repo tests. Golden-corpus plan unbuilt (U1/U2 missing in crucible; U3/U5/U6 unstarted; only U4 partial).

## Appendix C — Flag / shadow inventory (condensed)

| Feature | Flag (exact) | Default | Prod (WORKFLOW-symphony) | Status |
|---|---|---|---|---|
| Queue-triage planner (shadow tick) | `queue_triage.enabled` | false | **true** | shadow |
| Plan-driven dispatch ordering | `queue_triage.shadow_mode` | true | **true** (shadow) | dormant seam |
| Comment enrichment measurement | `queue_triage.comment_enrichment.enabled` | false | **true** | shadow (SYMPH-916 window) |
| Tier-2 plan review + diff gate + per-lane telemetry | `queue_triage.plan_review.enabled` | false | **unset** | dormant — W0 target |
| Planner grounding (shadow tick + CLI) | `planner_grounding.enabled` | false | **unset** | dormant — W0 target |
| Code grounding checkouts | `code_grounding.enabled` | false | **unset** | dormant — W0 target |
| Grounding LLM extractor | `SYMPHONY_GROUNDING_EXTRACTOR_BASE_URL` | studio2 default, unreachable | — | deterministic fallback only (SYMPH-1021) |
| Control-doc surface | `queue_triage.control_doc.enabled` | false | unset | dormant; removal candidate (filesystem-first) |
| Merge actuator | `merge_actuator.enabled` / `.auto_merge` | false/false | **true/true** | wired-gating |
| Crabrunner review job group | `review_execution.crabrunner_job_group.enabled` | false | **true** | wired (fail-closed on env) |
| Pre-review verify gate | `review_execution.pre_review_verify.enabled` | true | inherited | wired |
| Spec-fidelity lane | `spec_fidelity.enabled` | false | **true** (template) | shadow (report-only by design) |
| AC gate | `ac_gate.enabled` | false | **true** (template) | wired-gating |
| Admission card | `admission_card.enabled` | false | **true** (template) | shadow |
| Continuous feedback | `continuous_feedback.enabled` (+`bounce_on_finding`) | **true/true** | inherited | wired — behavior-changing |
| Stuck-triage L2 | `watchdog.stuck_triage.enabled` | false | unset | dormant |
| Circuit breaker | `watchdog.circuit_breaker` | true | inherited | wired-gating |
| Kimi shadow council lane | `SYMPHONY_COUNCIL_KIMI_SHADOW_ENABLED` | **ON** (unset→true) | .env.enc value unknown (encrypted) | shadow |
| Codex excavation lane | `SYMPHONY_COUNCIL_CODEX_EXCAVATION_ENABLED` | **ON** | inherited | wired non-authoritative |
| Spine aggregator authority | `SYMPHONY_REVIEW_AGGREGATOR_AUTHORITATIVE` | **true** | inherited | wired-gating (`=0` = report-only escape) |
| Review-quality ledger | `SYMPHONY_REVIEW_QUALITY_LEDGER*` | on when spine present | inherited | shadow (data capture) |
| Decomposed stages | `stages.<n>.execution.sub_stages` | none declared | none | dormant seam |
| Browser-QA lane policy | (needs producer) | — | — | dormant, unreachable |
| Linear webhook reconciler | `SYMPHONY_LINEAR_WEBHOOK_SECRET` | unset → 503 | unset | dormant |
| Dashboard/state API + operator intents | `server.port` | null (off) | **4321** | wired — control plane |
| Rate-limit admission headroom | `rate_limit_admission.min_*_headroom_pct` | null (inert) | **10/5** (template) | wired-gating |
| Hard-stop window caps | `max_*_window_pct_per_unit` | null | **25/5** (template) | wired-gating |
| Team-scoped admission (release_batch gate) | `tracker.team_keys` | unset | **[SYMPH]** | wired-gating |

## Appendix D — Ticket clusters (per-ticket tables)

Dispositions marked **applied** were executed in this session (Appendix E). Verification legend: V = grep-verified against origin/main `38b41906` / crucible `ab444b7a` · L = likely (strong comment/doc evidence) · U = unverified (live-only).

### D.1 Slice B — SYMPH-882..1069 (96 issues; all descriptions + comments read; ~35 claims grep-verified)

| ID | state | rel | cluster | gist | disposition |
|---|---|---|---|---|---|
| SYMPH-882 | Backlog | R3 | planner-batching | shared-surface dissolve-on-failure semantics | keep (design child of 795/884; core.ts:2977 guard V) |
| SYMPH-883 | Backlog | R3 | planner-batching | shared-surface → allowed envelope modes | keep (V: mode intentionally excluded, standing-plan.ts:417-423; final step) |
| SYMPH-884 | Backlog | R3 | planner-trust-ramp | epic: backlog manager + dispatch governance | keep (live umbrella) |
| SYMPH-885 | Backlog | – | cmux-residue | make CMUX runbook non-executable | **applied: absorbed → SYMPH-1043** |
| SYMPH-886 | Backlog | – | config-sprawl | dedupe review-stage prompt across 4 workflows | keep (V: dup freshness logic merge.liquid:68 + template:766/868) |
| SYMPH-887 | Backlog | – | deploy-ops | revisit negative-only preflight deletion test | **applied: cancel-stale** (file now 380 LOC w/ positive suites) |
| SYMPH-888 | Backlog | – | deploy-ops | port drain+version gates into symphony-deploy | keep — root-fix (V: symphony-deploy has neither; deploy-train has both) |
| SYMPH-889 | Backlog | – | test-flake | run-journal races on shared /tmp/workspaces | keep (V: 92 hardcoded refs in runtime-host.test.ts) |
| SYMPH-891 | Backlog | R3 | planner-trust-ramp | planner release-train awareness | keep (deferred to R3 window by design) |
| SYMPH-892 | Backlog | – | deploy-ops | deploy-train guard not linked-worktree-aware | keep (V: path-equality only, deploy-train.sh:84) |
| SYMPH-894 | Backlog | – | crabbox-ssh-transport | council lanes hang; controller transport wedges | needs-retest (V: crucible fix landed — detached spawn + kill(-pid)); close on green retest |
| SYMPH-899–903 | Backlog | R3 | multi-repo | 845 P0–P4 phases | keep (ratified design, sequenced) |
| SYMPH-905 | Backlog | – | planner-trust-ramp | two-pass vs one-pass from measurement | keep (window live since 6-23; halt may have starved it) |
| SYMPH-906/907 | Backlog | – | planner-trust-ramp | prompt-size guard; field encoding | keep, do NOT schedule (deferred-until-pressure pair) |
| SYMPH-911 | Backlog | R1 | token-cost-measurement | tune reviewer-lane count from observed spend | keep (unblocked by #665; queues behind 949 restart for data) |
| SYMPH-914 | Backlog | R1 | crabrunner-contract | golden-corpus contract epic | keep umbrella (Q1–Q3 resolved; corpus V-absent; first slice = 999) |
| SYMPH-933 | Backlog | – | council-track-tail | verify-gate hardening | keep (V: tokensSavedEstimate stub :347; no test file) |
| SYMPH-935 | Backlog | – | crabrunner-contract | live-spine conformance RED | **applied: absorbed → SYMPH-977** |
| SYMPH-936 | Backlog | – | council-track-tail | multi-lane primitive Track findings | keep (V: validationErrors[0] fallback, decomposed-stage.ts:278) |
| SYMPH-937 | Backlog | – | council-track-tail | round-summary degraded-lane tests | keep (small batch) |
| SYMPH-938 | Backlog | – | deploy-ops | preflight parsing helper edge cases | keep (V: dotenv_value, ops/symphony-deploy:174) |
| SYMPH-940 | Backlog | – | planner-trust-ramp | behavioral A/B health-signal enrichment | keep (operator research, not overnight work) |
| SYMPH-941 | Backlog | – | council-track-tail | hot-file-reader CRLF tests | keep (parked, platform-unreachable) |
| SYMPH-943 | was In Progress | – | codex-retire | flaky elicitation test ejects merge queue | **applied: absorbed → SYMPH-949** (V: both tests it.skip since #670; state contradiction fixed) |
| SYMPH-947 | Backlog | – | god-file-growth | decompose core/runtime-host | keep deferred (holds the map; pins are W4) |
| SYMPH-949 | Backlog | R1 | codex-retire | migrate stage dispatch to crabrunner | keep — **W2 keystone** (MOB-588/589 Done; ready) |
| SYMPH-951 | Triage | – | council-track-tail | spine cutover edge-case tests | keep-but-trim (AC#1 targets module 1008 deletes) |
| SYMPH-952 | Triage | – | crabbox-ssh-transport | SSH-bootstrap timeout recurrence | keep (crucible-side; post-MOB-323 recurrence) |
| SYMPH-954 | Backlog | – | council-track-tail | normalizePlanBatch parity guards | keep (V: wired via #698 — now actionable) |
| SYMPH-956 | Triage | – | token-cost-measurement | tighten ×6 weighted budgets from spend | keep (sole cost gate for subscription lanes) |
| SYMPH-957 | Triage | – | crabrunner-contract | investigate live-spine red | **applied: absorbed → SYMPH-977** (own comment disproved hypothesis) |
| SYMPH-959 | Triage | – | pipeline-halt | post-merge gate failure on 9ddbb7c | **applied: cancel-stale** (~50 green merges since) |
| SYMPH-960 | Backlog | – | planner-trust-ramp | backlog-intelligence extraction epic | **applied: cancel-stale** (own Phase-0 gate: NO-BUILD; activation landed) |
| SYMPH-964 | Triage | – | crucible-side | fixScheduleRound slash regex | keep (trivial, batch; V: adaptive-orchestrator.mjs:3758) |
| SYMPH-965 | Backlog | – | linear-sync-semantics | model attribution for follow-ups | keep (pairs MOB-604; T1 prereq in C.5) |
| SYMPH-970 | Triage | – | crabrunner-contract | spec-fidelity Opus judge | keep (V: consumption landed #695/#722; enablement remains) |
| SYMPH-973 | Triage | – | linear-sync-semantics | retire inline Track filer post-relay | keep (blocked MOB-604; V: filer live core.ts:4842) |
| SYMPH-976 | Triage | – | planner-trust-ramp | standing re-test trigger for 962 Phase-A | keep (parked trigger) |
| SYMPH-977 | Triage | – | crabrunner-contract | live-spine grouping conformance drift | keep — root-fix home (absorbed 935/957); crucible-vs-test decision |
| SYMPH-987 | Triage | – | journal-replay | AC snapshots not normalized at checkpoint recovery | keep — verified correctness gap (core.ts:1678 vs :1810) |
| SYMPH-988 | Triage | – | token-cost-measurement | crabrunner usage → $0 cost | keep (blocked SYMPH-853 pricing source) |
| SYMPH-989 | Triage | – | planner-trust-ramp | hygiene strips culls from planner view | keep — needs design decision (T1 prereq in C.5) |
| SYMPH-993 | Triage | – | manager-plan-cli | manager-plan doc drift + test gaps | **applied: absorbed → SYMPH-1006** |
| SYMPH-996–1002, 1012 | Backlog | – | crabrunner-contract | 914 U1–U7 + corpus expansion | keep (999 promoted to R1 as first slice — applied) |
| SYMPH-1003/1004 | Triage | – | crabrunner-contract | archive-hash attest + alignment semantics | keep (blocked on crucible sha256 exposure) |
| SYMPH-1005 | Triage | – | planner-trust-ramp | heartbeat-skip [] = clean dispositions | keep — verified correctness gap (runtime-host ~6560) |
| SYMPH-1006 | Triage | – | manager-plan-cli | manager-plan v2 coverage + exit codes | keep (absorbed 993; V: parseGhPrContext untested) |
| SYMPH-1008 | Triage | – | cmux-residue | remove dead council-gate + replay CLI | keep — root-fix (V: zero call sites) |
| SYMPH-1009/1010/1011 | Triage | – | council-track-tail | AC-snapshot decision; cost-sum tests; closeout v1.1 | keep (small batches) |
| SYMPH-1013 | Backlog | – | planner-trust-ramp | agents must decide, not park | keep (V: no best-judgement instruction in prompts yet) |
| SYMPH-1016 | Triage | – | planner-trust-ramp | decorrelated standing-plan review | **applied: cancel-fixed** (#710/#711 merged; remainder = 1034) |
| SYMPH-1018/1019 | Triage | – | council-track-tail / planner-trust-ramp | dependency-edge diagnostics; malformed-entry isolation | keep (1019 V: all-or-nothing schema, triage-planner.ts:276) |
| SYMPH-1021 | Triage | – | planner-trust-ramp | extractor calibration spike | keep (W0 quality upgrade, not blocker) |
| SYMPH-1023 | Triage | – | planner-trust-ramp | bound doc-follower extraction cache | keep (V: unbounded Map, doc-follower.ts:63) |
| SYMPH-1024 | Triage | – | observability-gaps | grounding telemetry counts pre-truncation | keep (metrics-only) |
| SYMPH-1025 | Triage | – | planner-trust-ramp | doc grounding uses cwd not target checkout | keep (V: planner-grounding.ts:177) |
| SYMPH-1026 | Triage | – | council-track-tail | cover defaultGroundPlannerContext | keep |
| SYMPH-1027 | Triage | – | cmux-residue | cmux deploy tests time out | **applied: absorbed → SYMPH-1043** |
| SYMPH-1034 | Backlog | now R3 | planner-trust-ramp | trust ramp report-only→advisory→gate | keep — **applied: moved to R3**; window opened by SYMPH-1070 |
| SYMPH-1035/1036 | Triage/Backlog | – | planner-trust-ramp | self-review journal churn; supersession role contract | keep |
| SYMPH-1037 | Triage | – | cmux-residue | migrate runClaudeCmux (parent) | keep (T1–T5 landed; close on 1043) |
| SYMPH-1043 | Triage | – | cmux-residue | delete cmux runner + config + doc | keep — **root-fix, W5** (absorbed 885/1027; scope comment applied) |
| SYMPH-1044 | Triage | – | codex-retire | flake: late dynamic tool response | **applied: absorbed → SYMPH-949** |
| SYMPH-1045/1046 | Triage | – | crucible-side | verify-worker home; ENOBUFS misclassify | keep (crucible substrate) |
| SYMPH-1051–1058 (7) | Triage | – | crabrunner-adapter-batch | adapter Track tail (one file) | **applied: absorbed → SYMPH-1072 (new, R2)** |
| SYMPH-1053 | Triage | – | council-track-tail | cmux-spawn deploy edge tests | keep (#715 helper) |
| SYMPH-1060 | Triage | – | config-sprawl | smoke-test Sonnet IDs post-Opus-default | keep (tiny) |
| SYMPH-1062/1063 | Triage | – | crabrunner-contract | spec-fidelity precedence test; anti-spoof diagnostics | keep |
| SYMPH-1064 | Triage | – | manager-plan-cli | --persist cold-start "dev" version | keep (operator-facing; V: scheduler-client.ts:299) |
| SYMPH-1067 | Triage | – | planner-trust-ramp | route tick grounding through cache | keep (gated on telemetry) |
| SYMPH-1069 | Triage | now R3 | planner-trust-ramp | golden-set defect-id tagging | keep — **applied: moved to R3** (1034 companion) |

### D.2 MOB in Symphony releases (20)

| ID | state | rel | cluster | gist | disposition |
|---|---|---|---|---|---|
| MOB-90 | Backlog | R4 | cmux-residue | telemetry for cmux headless gate | **applied: cancel-stale** (instrumenting dead code) |
| MOB-205 | Backlog | R2 | crabrunner-contract | harden reviewer prompts vs malformed verdicts | **applied: cancel-fixed** (V: "## Verdict" line-1 mandated; fixture AC → 914) |
| MOB-253 | Backlog | R2 | crucible-side | operator-run hydration drops body | **applied: cancel-fixed** (V: linear-issue-hydration.mjs wired) |
| MOB-254/255 | Backlog | R4 | token-cost-measurement | legacy adapter usage v2; reasoning tokens | keep (V: fields still absent) |
| MOB-257 | Backlog | R2 | crucible-side | flock helper lifecycle diagnostics | keep (residual-risk decision open) |
| MOB-279 | Todo | R2 | crucible-side | crabbox-council lifecycle hardening | keep (V: writeIfChanged non-atomic, manage-skill.mjs:94) |
| MOB-289/291/292/293/296/297 | Backlog | R4 | observability-gaps / slack-formatting | MOB-287 alerting Phase-2 remainder | keep as coherent batch (all V/L still-real) |
| MOB-299/306/307/310/311 | Backlog | R4 | dashboard-polish | v1 scope cuts | keep as batch (299 keep-but-trim: 4 items pre-fixed) |
| MOB-300 | Backlog | R2 | crucible-side | skills-deploy skip variant-generated | keep partial (deny-list exists, coverage gap) |
| MOB-391 | Triage | R1 | orchestrator-boundary | dispatch-only orchestrator by mechanism | keep — **R1 active, regressing** (7-02: violated again in SYMPH-1017 run; needs orphan-diff detector + fix-dispatch) |

### D.3 Slice A — SYMPH-267..881 (96 issues; ages 18–30 days; same rubric)

| ID | state | rel | cluster | gist | disposition |
|---|---|---|---|---|---|
| SYMPH-267 | Backlog | R2 | deploy-ops | restore calver bump automation | keep (V: calver-plan still non-mutating) |
| SYMPH-268 | Backlog | R4 | pipeline-halt | pre-Node fallback for halt reporting | keep (L) |
| SYMPH-270 | Backlog | – | deploy-ops | upgrade Actions for Node 24 | keep (V: actions still @v4) — **hard 2026-09-16 deadline; cheap dispatch candidate** |
| SYMPH-273 | Backlog | – | dashboard-polish | token-report v5 chart token drift | keep (V: #0d1117 at chart-utils.ts:23) |
| SYMPH-275 | Backlog | R2 | cmux-residue | council review as first-class stage | **applied: cancel-fixed** (delivered by crabrunner review stage #640/#714–722) |
| SYMPH-278 | Backlog | R2 | crabrunner-contract | security-review coverage contract | **applied: superseded → SYMPH-1078** (V: no security categories in lanes) |
| SYMPH-282 | Backlog | – | codex-retire | app-server normalization tests | **applied: absorbed → SYMPH-949** |
| SYMPH-294 | Blocked | R2 | retry-park-semantics | eligibility predicate mutates resume state | keep (V: still mutates, core.ts:2442–2506; first consumer of 403's seam) |
| SYMPH-296 | Backlog | R2 | retry-park-semantics | StopReason parse drift guard | keep (V: manual guard core.ts:14269, no drift test) |
| SYMPH-297 | Backlog | – | journal-replay | issueState metadata semantics | **applied: cancel-fixed** (V: replay consumes it; tested core.test.ts:2323) |
| SYMPH-306 | Backlog | – | workspace-git-hygiene | base-refresh structured-log smoke | keep (V: zero test hits; 3 pipeline attempts never landed) |
| SYMPH-307 | Backlog | – | codex-retire | app-server test-family concurrency flake | **applied: absorbed → SYMPH-949** |
| SYMPH-323 | Backlog | – | codex-retire | codex session artifact URL contract | **applied: absorbed → SYMPH-949** |
| SYMPH-337 | Backlog | – | retry-park-semantics | budget-pause escalation ladder | **applied: cancel-fixed** (V: live core.ts:3857/3986; slice-3 deprioritized) |
| SYMPH-342 | Backlog | R4 | codex-retire | multi-subscription switchover | **applied: superseded → SYMPH-1079** (design built on retiring rate_limits payload) |
| SYMPH-343 | Backlog | R3 | stale-fixed | spec-fidelity verdicts + digest | **applied: cancel-fixed** (V: wired; digest CLI #380; delivery = 436) |
| SYMPH-345 | Backlog | R4 | token-cost-measurement | Linear API complexity telemetry | keep (measure-first; unbuilt) |
| SYMPH-356 | Backlog | R2 | deploy-ops | per-product CI hardening rollout | keep (symphony slice done 06-15; rollout remains) |
| SYMPH-357 | Backlog | R4 | deploy-ops | Dependabot burndown | keep (L: debt remains; live state unverifiable offline) |
| SYMPH-362 | Backlog | R2 | deploy-ops | flip diff-coverage to enforcing | keep — **over-ripe** (V: continue-on-error still at ci.yml:66; calibration window 4× exceeded) |
| SYMPH-364 | Backlog | – | god-file-growth | hunk-level collision granularity | keep (mitigation while 947 deferred) |
| SYMPH-365 | Backlog | – | god-file-growth | decompose orchestrator god-files | **applied: absorbed → SYMPH-947** |
| SYMPH-371 | Backlog | R4 | host-topology | controller resource-aware admission | keep (rescoped 06-21; surviving slice open) |
| SYMPH-375 | Backlog | R2 | spec-fidelity-gates | implement-exit evidence gate slice 2 | keep (slice 1 = #356; sequenced) |
| SYMPH-376 | Backlog | R4 | retry-park-semantics | decision briefs on park paths | keep (L: contract unenforced) |
| SYMPH-380 | Backlog | – | context-tooling-canary | per-product learnings memory | keep (DEFERRED-BY-DESIGN marker) |
| SYMPH-383 | Backlog | R4 | linear-sync-semantics | actor-attribution split | keep (residual = API-actor split; check vs service-account setup) |
| SYMPH-386 | Backlog | – | god-file-growth | junction-seam extraction | **applied: absorbed → SYMPH-947** (V: no registry/hook chain on main) |
| SYMPH-393 | Backlog | – | codex-retire | remove dormant ClaudeCode+Gemini runners | keep (V: both exist, never selected; cheap cull — but see W2: gemini stays removal-friendly by policy) |
| SYMPH-400 | Backlog | R4 | journal-replay | stale rehydrated markers on reopen | **applied: cancel-fixed** (V: terminal replay clears, core.ts:1645–1663) |
| SYMPH-403 | Backlog | R2 | retry-park-semantics | enterStage / stage-entry centralization | keep — **REACTIVATED as cluster root** (V: 405 shipped without the seam; 47 raw sites) |
| SYMPH-404 | Backlog | R4 | config-sprawl | notifier ignores hot-reload | keep (V: bound once, runtime-host.ts:849) |
| SYMPH-410 | Backlog | – | host-topology | single-writer lease SPEC | keep (deferred-by-design; spec-only) |
| SYMPH-412 | Backlog | R1 | codex-retire | mid-turn session closures root cause | **applied: absorbed → SYMPH-949** (own comment folded it into now-Done 945) |
| SYMPH-419 | Backlog | R2 | config-sprawl | staged workflow lacks pre-gate check | keep (V: absent; tied to 641 family root) |
| SYMPH-423 | Backlog | R2 | codex-retire | turn-start window misclassification | **applied: absorbed → SYMPH-949** |
| SYMPH-424 | Backlog | R4 | codex-retire | session_rotated reports dead ids | **applied: absorbed → SYMPH-949** (V: bug present but machinery retiring) |
| SYMPH-425 | Backlog | R2 | spec-fidelity-gates | doc-sync CI-authority redundancy | keep (tiny) |
| SYMPH-428 | Backlog | R2 | codex-retire | rotation turn-count clamp | **applied: absorbed → SYMPH-949** |
| SYMPH-436 | Backlog | R3 | observability-gaps | calibration digest delivery wiring | keep (V: CLI exists, zero Slack/Linear wiring) |
| SYMPH-502 | Backlog | – | journal-replay | anchor cleanup replay contract | **applied: cancel-fixed** (L: covered by write-intent tests ×4) |
| SYMPH-561 | Backlog | R2 | cmux-residue | reviewer mutation attribution | **applied: absorbed → SYMPH-1008** |
| SYMPH-563/564/565/566 | Backlog | R4/–/–/R4 | dashboard-polish | auth-review tail (rotation, attribution, side channel, mobile entry) | **applied: cancel-stale ×4** (localhost threat model; 566's premise gone from code — V) |
| SYMPH-569 | Backlog | R3 | spec-fidelity-gates | spec-review admission calibration | keep (V: watcher in tree; evidence-gated enablement) |
| SYMPH-580 | Backlog | – | context-tooling-canary | Headroom compression canary | **applied: cancel-stale** (integration point retires with 949) |
| SYMPH-591 | Backlog | – | config-sprawl | skill-validator diagnostics hardening | keep (absorbed 668) |
| SYMPH-600 | Backlog | – | cmux-residue | procedure-stop docs alignment | **applied: absorbed → SYMPH-1008** |
| SYMPH-602 | Backlog | – | cmux-residue | dedupe procedure-stop predicates | **applied: absorbed → SYMPH-1008** |
| SYMPH-616 | Backlog | – | council-track-tail | prompt-builder delta polish | keep (V: double-normalize remains; tiny, active surface) |
| SYMPH-636 | Backlog | R2 | council-track-tail | contradictory draft-flag policy | **applied: cancel-stale** (current behavior conservative) |
| SYMPH-637 | Backlog | – | context-tooling-canary | codebase-memory-mcp canary | **applied: superseded → SYMPH-1080** |
| SYMPH-640 | Backlog | – | council-track-tail | document hard-stop comment caps | **applied: cancel-stale** (cap live core.ts:229; doc-only) |
| SYMPH-641 | Backlog | R2 | config-sprawl | centralize merge-readiness partial | keep — family root fix (deliberate restage; cluster note added) |
| SYMPH-646 | Backlog | R4 | pipeline-halt | cross-SHA halt collapse policy | keep (policy decision genuinely open) |
| SYMPH-647 | Backlog | R2 | pipeline-halt | PR-number extraction fragile | keep (V: `grep -oE '#[0-9]+'\|head -1` at post-merge-gate.yml:71) |
| SYMPH-661 | Blocked | – | token-cost-measurement | split investigate cheap/deep | keep (evidence-gated ≥3 post-660 units; 662's tooling landed) |
| SYMPH-668 | Backlog | – | config-sprawl | skill-install drift diagnostics | **applied: absorbed → SYMPH-591** |
| SYMPH-669 | Backlog | – | codex-retire | output-guard edge cases | **applied: absorbed → SYMPH-949** (V: app-server-client.ts:2108) |
| SYMPH-671 | Backlog | R2 | deploy-ops | deploy-train cleanup e2e coverage | keep (weigh with SYMPH-888) |
| SYMPH-682 | Backlog | – | context-tooling-canary | codedb bounded-retrieval canary | **applied: superseded → SYMPH-1080** |
| SYMPH-693 | Backlog | – | context-tooling-canary | codedb root-packet pilot | **applied: superseded → SYMPH-1080** (gated on never-resolved 692) |
| SYMPH-706 | Backlog | – | right-sizing-envelope | risk-class governs execution envelope | keep (deliberate SYMPH-340 follow-up) |
| SYMPH-709 | Backlog | R4 | council-track-tail | PR #545 scheduler Track grab-bag (~20 items) | keep — **itemize in first T0 triage pass** |
| SYMPH-738 | Backlog | R2 | config-sprawl | merge-queue rejection contract split | keep (pairs with 641) |
| SYMPH-742 | Backlog | R2 | cmux-residue | remote lead triage artifact access | **applied: cancel-stale** (V: zero cmux refs in src/review) |
| SYMPH-743 | Backlog | – | council-track-tail | hook timeout contract JSDoc | keep (V: sentinel exists, JSDoc absent; 15-min task) |
| SYMPH-744 | Backlog | – | test-flake | stress mutex wait helper | **applied: cancel-stale** (no flake since June) |
| SYMPH-745 | Backlog | R4 | observability-gaps | exit_code:null consumer check | **applied: cancel-stale** (live 3 wks, no breakage) |
| SYMPH-774 | Blocked | R1 | crabrunner-contract | crabrunner durable stage execution epic | keep (Blocked-by-design until 949 go-live; OAuth residual noted) |
| SYMPH-782 | Backlog | R4 | dashboard-polish | rate-limit snapshot clear route | keep (V: absent; note codex-window dependency post-949) |
| SYMPH-795/796 | Backlog | R3 | planner-batching | batching epic + HITL extraction | keep (decomposed design chain) |
| SYMPH-797 | Backlog | R3 | planner-trust-ramp | ramp governor (envelope writer) | keep (gated on safe self-deploy / 888 family) |
| SYMPH-798 | Backlog | – | docs-hygiene | Linear doc convention + cleanup | **applied: cancel-stale** (filesystem-first reversal 2026-07-01) |
| SYMPH-799 | Backlog | R3 | planner-trust-ramp | shadow-hook integration tests | keep (feeds 1034 ramp evidence) |
| SYMPH-813 | Backlog | R3 | planner-trust-ramp | dispatch-time outcome attribution | keep (V: still current-plan-based; needed pre-Stage-3) |
| SYMPH-814 | Backlog | R3 | manager-plan-cli | interpret-then-confirm doc comments | keep (V: free_text logs-only; safe today) |
| SYMPH-844 | Backlog | – | cmux-residue | cmux planner lane 401 on OAuth expiry | **applied: cancel-stale** (V: runner aliased to crabrunner; OAuth residual → 774) |
| SYMPH-845 | was In Progress | R3 | multi-repo | multi-team/repo design | **applied: closed Done** (design accepted 06-22; phases 899–903 filed) |
| SYMPH-846 | Backlog | – | linear-sync-semantics | explicit admit vs Todo-state signal | keep (operator-parked "do NOT action") |
| SYMPH-850 | Backlog | – | crabrunner-adapter-batch | crabrunner AI SDK provider | keep (optional by design) |
| SYMPH-851 | Backlog | – | dashboard-polish | unify usage formatting paths | keep (V: duplicate formatUsageQuality client/server) |
| SYMPH-857 | Backlog | – | crabrunner-contract | per-sub-stage prompts in decomposed lanes | keep (V: no prompt field in stage-execution-profile.ts; blocks decomposed canary) |
| SYMPH-861 | Backlog | – | council-track-tail | AST test computed-key gap | **applied: cancel-stale** (static-analysis boundary; runtime gate sound) |
| SYMPH-863 | Backlog | – | planner-trust-ramp | decouple retry cadence vs freshness | **applied: cancel-stale** (measure-first: keep coupling) |
| SYMPH-873 | Backlog | – | crabrunner-contract | diagnostics for dropped prior review state | keep (V: silent degrade real, runtime-host.ts:7943) |
| SYMPH-875 | Backlog | R3 | planner-trust-ramp | shadow→active cutover operator gate | keep — **cross-linked with SYMPH-1034** (same decision) |
| SYMPH-876–881 | Backlog | R3 | planner-batching | batch identity → per-ticket attribution chain | keep (sequenced; 877 doubles as first core.ts decomp slice) |

### D.4 Slice-A cluster notes not in B.2

- **SYMPH-270's 25 comments** are June-9 self-host launch-incident logging unrelated to its subject; the actual chore is tiny with a hard runner deadline.
- **workspace-git-hygiene (306)** and **host-topology (371/410)** are small deliberate families, no shared defect.
- **Verification limits:** live CI/Dependabot state (357, 744) and SYMPH-692's verdict (gated 693) were not verifiable offline; marked L/U accordingly.

## Appendix E — Linear mutation log

All mutations applied 2026-07-09 via `linear-pp-cli` (+ raw GraphQL for release membership; the CLI release surface is read-broken). Every closure carries an evidence comment citing this doc; absorbing tickets received context comments listing what they absorbed and why.

### E.1 Created (8) — `--pp-session audit-20260709`

| ID | Title (short) | Release | Maps to |
|---|---|---|---|
| SYMPH-1070 | Open the planner measurement window (3 flags in WORKFLOW-symphony) | R1 | W0 — **dispatch next** |
| SYMPH-1071 | Crucible execution-seam hardening: drift fixes, conformance harness, correlation IDs | R1 | W1 |
| SYMPH-1072 | Crabrunner claude-adapter contract hardening batch | R2 | absorbs 1051–1058 |
| SYMPH-1073 | Port crucible anti-sprawl gates (report-only first) | — | W4 gates |
| SYMPH-1074 | Externalize council/crabrunner/policy config + fix census drift bugs | — | A.5 |
| SYMPH-1075 | Delete dead upstream leftovers + orphaned bins | — | Appendix F |
| SYMPH-1076 | In-cycle intake triage: T0→T3 autonomy ramp | R3 | C.5 stream |
| SYMPH-1077 | Refresh stale CLAUDE.md (tree, test count, fragile areas) | — | §1 |

### E.2 Closed with evidence comments (21)

| ID | Disposition | Evidence (abbrev) |
|---|---|---|
| SYMPH-887 | cancel-stale | premise gone: test file now has positive crabrunner/cmux-spawn suites |
| SYMPH-959 | cancel-stale | one-shot halt record (PR #678 gate); ~50 green merges since |
| SYMPH-960 | cancel-stale | own Phase-0 gate: 0 category-c gaps → NO-BUILD; activation landed (981–983) |
| SYMPH-1016 | cancel-fixed | #710/#711 merged; remainder = SYMPH-1034 |
| SYMPH-885 | absorbed → SYMPH-1043 | runbook archiving subsumed by doc+runner deletion |
| SYMPH-1027 | absorbed → SYMPH-1043 | hardens a file scheduled for deletion |
| SYMPH-935 | absorbed → SYMPH-977 | identical 3 assertions; 977 has freshest repro |
| SYMPH-957 | absorbed → SYMPH-977 | own comment disproved checkout-lag hypothesis |
| SYMPH-993 | absorbed → SYMPH-1006 | both items already in 1006 scope (verified still-real) |
| SYMPH-943 | absorbed → SYMPH-949 | tests it.skip since #670; was wrongly In Progress; deletion-resolved |
| SYMPH-1044 | absorbed → SYMPH-949 | same codex flake class; quarantine if it recurs pre-949 |
| SYMPH-1051–1058 (7) | absorbed → SYMPH-1072 | single-file Track tail batched per grouping convention |
| MOB-90 | cancel-stale | telemetry for dead cmux gate (0 call sites) |
| MOB-205 | cancel-fixed (verified) | review-prompt.mjs mandates "## Verdict" line-1 at crucible HEAD |
| MOB-253 | cancel-fixed (verified) | linear-issue-hydration.mjs exists + wired |

### E.3 Release membership changes (7, via GraphQL `issueUpdate.addedReleaseIds`)

| ID | Change | Rationale |
|---|---|---|
| SYMPH-1070 | → R1 | W0 is now-work; R1 = dispatch fence |
| SYMPH-1071 | → R1 | W1 unblocks/protects the R1 keystone (949) |
| SYMPH-1072 | → R2 | adapter serves the review path |
| SYMPH-1076 | → R3 | triage handoff is dispatch-intelligence work |
| SYMPH-1034 | none → R3 | ramp exit = plan-driven dispatch = R3 core (875); keeps R1 closeable |
| SYMPH-1069 | none → R3 | 1034's catch-rate companion |
| SYMPH-999 | none → R1 | U4 = designated first slice of 914; R1 carries the executable unit |

### E.4 Context comments (6)

SYMPH-1043 (A.4 seven-step order + out-of-repo flags + absorptions), SYMPH-977 (consolidation + seam split vs 1071), SYMPH-1006 (absorbed 993), SYMPH-949 (MOB-588/589 Done — stall cleared; absorptions; error-code sequencing wrt 1071), SYMPH-1034 (R3 move + window opened by 1070 + 1069 companion), SYMPH-999 (R1 promotion rationale + seam distinction).

### E.5 Slice-A round (applied after the D.3 pass)

**Created (3):** SYMPH-1078 (security-review coverage for crabrunner lanes → R2, supersedes 278), SYMPH-1079 (post-949 capacity-aware lane routing → R4, supersedes 342), SYMPH-1080 (consolidated context-retrieval canary, supersedes 637/682/693).

**Absorbed (14):** 282, 307, 323, 412, 423, 424, 428, 669 → SYMPH-949 · 365, 386 → SYMPH-947 · 561, 600, 602 → SYMPH-1008 · 668 → SYMPH-591.

**Cancel-fixed (6):** 275 (crabrunner review replaced it), 297, 337, 343, 400, 502 — each with file:line/PR citation in its comment.

**Cancel-stale (14):** 563, 564, 565, 566 (dashboard auth tail — accepted-behavior decisions recorded), 580, 636, 640, 742, 744, 745, 798 (filesystem-first reversal), 844 (OAuth residual re-homed on 774), 861, 863.

**Superseded (5):** 278 → 1078, 342 → 1079, 637/682/693 → 1080.

**Closed Done (1):** 845 — design delivered (doc accepted 06-22; phases 899–903 filed).

**Context comments (10):** 403 (REACTIVATED — 405 shipped without the seam; cluster root), 875 + 1034 (cross-linked — same cutover decision), 774 (Blocked-by-design confirmed + OAuth residual), 1076 (Track-finding lifecycle policy scope), 641 (config-sprawl family root note), 949 (slice-A absorption list — now carries 10 resolved-by-deletion tickets), 947 (absorptions + stay-deferred posture), 1008 (absorptions + runtime-host `:8049` import must be ported before deletion), 591 (absorption).

### E.6 Session totals

11 issues created · **61 closed** (18 slice-B SYMPH + 3 MOB + 40 slice-A) · 9 release-membership changes · 16 context comments · 61 disposition comments. Open SYMPH: 192 → **145** (−24%); open MOB in Symphony releases: 20 → 17. Every mutation carries an evidence comment citing this doc; closures state their reopen condition where applicable.

## Appendix F — Dead code & orphaned surfaces (deletion shortlist; ticketed: SYMPH-1075)

- `src/streaming.ts` (+ its barrel re-export), `src/test-alpha.ts`, `src/audit/altitude-reliability.ts`, `src/calibration/standing-plan-digest.ts`, `src/cli/manager-plan-dogfood-evidence.ts`, `src/orchestrator/standing-plan-envelope.ts` (shim), `src/cli/direct-run.ts` (only the retired kimi replay imports it), core's `sortIssuesForDispatch` re-export.
- Orphaned bins: `symphony-portfolio-audit`, `symphony-portfolio-classify`, `symphony-manager-run-import`, `symphony-investigate-productivity-report`; retired: `symphony-kimi-council-replay`.
- `logging/fields.ts` runtime consts (type-only consumption); manager-run-journal append API (writer is a manual import CLI only).
- Two same-named `prompt-fence.ts` modules (src/agent/ 119 LOC vs src/review/ 45 LOC) — different implementations, both live; consolidation candidate, not deletion.
- `ops/com.slack-bridge.plist` mispoints ProgramArguments at the orchestrator and sets never-read `SLACK_SIGNING_SECRET`.
- CMUX surfaces: see A.4 (~12.5k LOC program).

## Appendix G — Env & hardcoded-policy census (highlights)

~116 distinct env names by family: council 28, review 9, crabrunner 11, planner/grounding 9, queue-audit 12, orch-misc 4, tracker 5, slack 7, operator/obs 7, deploy 14, skills-validation 7, CI 10 (+3 child-env injections: `SYMPHONY_PIPELINE`, `SYMPHONY_STAGE`, `SYMPHONY_CODEX_APP_SERVER_TOKEN`; `SYMPHONY_UNTRUSTED_*` are prompt-fence delimiters, not env).

Hardcoded policy worth externalizing (values preserved on move): prototype/thin $5/$20 caps (hard-stops.ts:135,151); rework/escalation ceilings 3/2/2/2 (core.ts:236-239); retry delays + 15m lease TTL (core.ts:223-259); reviewer retry 3×5s + 12k diff cap (gate-handler.ts:155-228, duplicated in continuous-feedback-provider.ts:15-16); code-grounding rails 500 files/256kB/depth 64/TTL 24h; merge wait ceilings duplicated (merge-candidate.ts:1245-1369 vs defaults.ts:172-178); council lane envelope 1800s/5MB/20MB/0.7; five copies of the 10-minute triage timeout; crabrunner poll envelope 1s×1800/120s/16MB; delegated-lane cadences 30s×3+5s.
