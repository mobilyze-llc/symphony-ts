# Intake triage pass — 2026-07-09

Linear: SYMPH-1076

Rubric: `docs/intake-triage-rubric.md`

Fresh base: `origin/main` at `814a8c0c4d38353d24c79babf479553164778de7`
(PR #729, 2026-07-09T13:26:36Z)

## Scope and method

The frozen pull at 2026-07-09T19:04Z contained:

- 39 issues currently in Triage;
- 12 issues filed on 2026-07-09 (SYMPH-1070 through SYMPH-1081), with
  SYMPH-1081 already present in the Triage set; and
- SYMPH-709, explicitly added by the T0 acceptance criteria.

The union is **51 tickets**. One delegated lane read the 49 tickets other than
SYMPH-709 and this process ticket from the frozen body/comment export. A second
lane itemized SYMPH-709. The root session adjudicated every proposed decision
against the audit and fresh code.

The audit already covered 49 of the 51 tickets. Those dispositions were not
re-triaged because no later comment changed their evidence or root relationship.
The only post-audit substantive comment was on SYMPH-1070; it reported the newly
filed SYMPH-1081. No subject file or function expired in that inherited set.

## Ticket-level agreement baseline

The ticket is the T1 agreement unit. Audit-inherited decisions count because
they are the operator ground truth for the same frozen intake, even when no new
Linear mutation was necessary.

| Disposition | Count |
|---|---:|
| `keep` | 50 |
| `keep-but-move-release` | 0 |
| `absorb-into` | 1 |
| `supersede-by-root-fix` | 0 |
| `cancel-fixed` | 0 |
| `cancel-stale` | 0 |
| `needs-root-cause-trace` | 0 |
| **Total** | **51** |

T1 comparison-family baseline: keep 50, absorb 1, cancel-fixed 0,
cancel-stale 0, root-promote 0, insufficient-trace 0. This is report-only; no
agreement or enforcement threshold is inferred from a single pass.

## Inherited decisions — no mutation

Appendix D already dispositioned these 38 current-Triage tickets and no later
comment changed the picture:

SYMPH-951, SYMPH-952, SYMPH-956, SYMPH-964, SYMPH-970, SYMPH-973,
SYMPH-976, SYMPH-977, SYMPH-987, SYMPH-988, SYMPH-989, SYMPH-1003,
SYMPH-1004, SYMPH-1005, SYMPH-1006, SYMPH-1008, SYMPH-1009, SYMPH-1010,
SYMPH-1011, SYMPH-1018, SYMPH-1019, SYMPH-1021, SYMPH-1023, SYMPH-1024,
SYMPH-1025, SYMPH-1026, SYMPH-1035, SYMPH-1037, SYMPH-1043, SYMPH-1045,
SYMPH-1046, SYMPH-1053, SYMPH-1060, SYMPH-1062, SYMPH-1063, SYMPH-1064,
SYMPH-1067, and SYMPH-1069.

The audit also created and already root-traced SYMPH-1070 through SYMPH-1080.
Their ticket-level disposition remains `keep`; SYMPH-1070 and SYMPH-1071 had
advanced to In Progress at pull time, and the others remained Backlog except
this T0 process ticket, whose execution moved it to In Progress.

## New ticket decision — SYMPH-1081

**Disposition: `keep`.** Promote Triage to Backlog, attach it as a child of
SYMPH-1070, and retain it as a separate change.

Fresh evidence:

- `src/config/config-resolver.ts:601-607` resolves
  `queue_triage.plan_review.planner_grounding_enabled` independently.
- `src/review/plan-review.ts:99-108` skips tier-2 review with
  `note: "no grounded evidence"` when the flag is false.
- `pipeline-config/workflows/WORKFLOW-symphony.md:23-33` has no override on the
  audited base.

The issue shares SYMPH-1070's measurement-window root, but the live SYMPH-1070
work unit explicitly limits its PR to the three named flags and no other config
changes. Preserve that operator-set PR boundary. Re-triage if SYMPH-1070's
closeout proves the fourth flag unnecessary, or if the subject key is removed
or folded into the top-level grounding contract.

## SYMPH-709 item dispositions

The six review rounds reduce to 21 distinct items. Fresh tracing shows that the
10 live rate-limit items share a post-949 root: the current design depends on
Codex app-server rate-limit snapshots, while `crucible.lane-worker.usage.v2`
has no rate-limit fields and SYMPH-949 explicitly leaves them out of scope
(`docs/plans/2026-06-28-symph-949-runner-to-crabrunner-lane-migration-plan.md:51,126`).
SYMPH-1079 is the existing root-fix ticket for capacity-aware routing on lane
telemetry and per-provider window state.

| # | Item | Disposition | Fresh evidence |
|---:|---|---|---|
| 1 | Dashboard duplicates reset ETA already present in the reason. | `absorb-into` SYMPH-1079 | `src/orchestrator/core.ts:3683-3687`; `src/observability/dashboard-render.ts:1481-1487,1960-1971` |
| 2 | Estimate primary and secondary burn independently. | `absorb-into` SYMPH-1079 | One `Math.max` scalar at `src/orchestrator/core.ts:3802-3808` is applied to both windows at `:3564-3604`. |
| 3 | Select recent burn chronologically instead of issue-map order. | `cancel-fixed` | Sort + last-20 selection at `src/orchestrator/core.ts:3825-3832`; regression at `tests/orchestrator/core.test.ts:8114-8175`; PR #545, merge `fd7a854f`. |
| 4 | Clarify investigate low clamp versus higher risk override. | `cancel-fixed` | Contract at `pipeline-config/templates/WORKFLOW-template.md:107-111,377-382`; regression at `tests/orchestrator/right-sizing.test.ts:200-221`; PR #545. |
| 5 | Preserve reset/self-clear wording outside defer mode. | `absorb-into` SYMPH-1079 | Non-defer reason omits reset semantics at `src/orchestrator/core.ts:3683-3687`; the post-949 design must choose its operator contract. |
| 6 | Remove unreachable `stage_config` effort provenance. | `cancel-stale` | Non-null stage effort always produces `modeEffort` at `src/orchestrator/right-sizing.ts:423-446`; the metadata-only arm has no control consumer. |
| 7 | Confirm selected effort reaches the Codex command. | `cancel-fixed` | Threaded at `src/orchestrator/runtime-host.ts:1070-1080,4713,4787` and applied at `src/agent/runner.ts:486-491,1553-1570`; PR #414, merge `bea594a9`. |
| 8 | Guard `expected_unit_burn_pct: 0`. | `cancel-fixed` | Config rejects zero at `src/config/config-resolver.ts:911-921`; runtime guards `> 0` at `src/orchestrator/core.ts:3563-3568`; PR #545. |
| 9 | Surface and journal zero-dispatch admission capacity, including capacity 0. | `absorb-into` SYMPH-1079 | Core stores it at `src/orchestrator/core.ts:3689-3701`, runtime snapshot omits it at `src/logging/runtime-snapshot.ts:127-137,886-902`, and poll exhaustion silently breaks at `src/orchestrator/core.ts:3041-3043` while retry emits a verdict at `:5960-5975`. |
| 10 | Define capacity as a per-poll estimate, not an intra-tick queue. | `cancel-fixed` | Template contract at `pipeline-config/templates/WORKFLOW-template.md:59-61`; test at `tests/orchestrator/core.test.ts:7970-8015`; PR #545. |
| 11 | Verify allowed/off to recommended/off wording does not break consumers. | `cancel-fixed` | Advisory wording at `src/orchestrator/admission-card.ts:14-31` and `src/orchestrator/pipeline-notifier.ts:427-447`; focused tests; no parser exists; PR #545. |
| 12 | Reconcile optional `admissionCapacity` with the always-written gate shape. | `absorb-into` SYMPH-1079 | Optional field at `src/domain/model.ts:1094-1104`; always written at `src/orchestrator/core.ts:3689-3701`; legacy recovery remains permissive at `:1864-1870`. |
| 13 | Prevent reasoning-effort metadata on non-agent stages. | `cancel-stale` | Terminal/gate stages return before right-sizing at `src/orchestrator/core.ts:11632-11703`; the premise is unreachable. |
| 14 | Document expected burn as the binding threshold above configured floors. | `absorb-into` SYMPH-1079 | Behavior at `src/orchestrator/core.ts:3574-3604`; test at `tests/orchestrator/core.test.ts:7932-7967`; post-949 contract still needs the product decision. |
| 15 | Account for candidates skipped after admission-capacity exhaustion. | `absorb-into` SYMPH-1079 | The loop increments once, then breaks at `src/orchestrator/core.ts:3031-3043`; later candidates do not reach the count at `:3066`. |
| 16 | Handle legacy history rows without `completedAt` without mixing epoch and insertion-index domains. | `absorb-into` SYMPH-1079 | Mixed fallback at `src/orchestrator/core.ts:3810-3819` is sorted at `:3825-3831`. |
| 17 | Key reservations from frozen gate fields rather than live mutable `codexRateLimits`. | `absorb-into` SYMPH-1079 | Reservation key rereads live state at `src/orchestrator/core.ts:3751-3762`. |
| 18 | Re-evaluate admission during the poll loop instead of reusing one snapshot across awaited dispatches. | `absorb-into` SYMPH-1079 | One evaluation at `src/orchestrator/core.ts:2694-2697` is reused at `:3041`. |
| 19 | Avoid an expired violation suppressing a later reset. | `cancel-stale` | The sole caller only adds non-expired violations at `src/orchestrator/core.ts:3570-3612`; the helper's early return at `:15536-15545` cannot receive the alleged input. |
| 20 | Clarify implement effort as an opt-in sentinel rather than the literal effective value. | `cancel-fixed` | Contract at `pipeline-config/templates/WORKFLOW-template.md:403-408`; mapping at `src/orchestrator/right-sizing.ts:473-491`; PR #545. |
| 21 | Refine the overloaded `mode_mapping` provenance label. | `cancel-stale` | The label is nomenclature-only at `src/orchestrator/right-sizing.ts:423-446`; documented behavior has no control consumer. |

Item-level counts:

| Disposition | Count |
|---|---:|
| `absorb-into` | 10 |
| `cancel-fixed` | 7 |
| `cancel-stale` | 4 |
| all other rubric classes | 0 |
| **Total** | **21** |

**Ticket-level disposition: `absorb-into` SYMPH-1079.** Add the 10 live items
to SYMPH-1079 as a legacy preserve/redesign/delete checklist, then move
SYMPH-709 to Cancelled. Reopen SYMPH-709 only if SYMPH-1079 drops that checklist
without an equivalent successor.

## Linear mutations

| Issue | Mutation | Evidence trail |
|---|---|---|
| SYMPH-1081 | `keep`; parent SYMPH-1070; Triage -> Backlog; taxonomy labels normalized | Disposition comment cites the independent flag path, skip branch, explicit PR boundary, reopen condition, and this log. |
| SYMPH-1070 | Reciprocal context comment only | Records why the fourth flag remains a separately reversible child. |
| SYMPH-1079 | Absorption context + legacy checklist; taxonomy labels normalized | Names all 10 surviving SYMPH-709 items and the post-949 root trace. |
| SYMPH-709 | `absorb-into` SYMPH-1079; Backlog -> Cancelled; taxonomy labels normalized | Itemized 21-item disposition comment with code/PR evidence and reopen condition. |

State changes use `--state-name`. No issue moved to Todo. Nothing moved to Done
unless the ticket itself represented genuinely delivered work; the seven
item-level `cancel-fixed` decisions are evidence inside the absorbed shell, not
separate Linear issues.
