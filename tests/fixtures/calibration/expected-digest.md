# Calibration digest — verdict↔outcome joins

> **Graduation evidence for SYMPH-399.** Watchdog-L2 stuck-ticket triage
> is **default-disabled per product until calibrated**; this digest is the
> evidence an operator reviews to decide whether to enable it for a
> product. Every number below carries the dispatcher run-journal cursors
> (sequences) backing it.

- Journal: .symphony/run-journals/dispatcher.jsonl (synthetic)
- Generated at: 2026-06-12T00:00:00.000Z
- Entries: 15 (cursor range seq 1–15)

## L2 triage precision (verdict → eventual outcome)

Joins each applied `triage_verdict` to the issue's first subsequent
terminal event: a completed terminal tracker write counts as
**recovered**, a later `failure_exhausted` counts as **re-parked**.
Precision = recovered / (recovered + re-parked).

### By effective action

| action | recovered | re-parked | unresolved | precision | cursors |
| --- | --- | --- | --- | --- | --- |
| park | 1 | 0 | 0 | 100.0% | seq 5→12 |
| retry_once | 1 | 1 | 0 | 50.0% | seq 3→9, seq 4→10 |

### By model classification

| classification | recovered | re-parked | unresolved | precision | cursors |
| --- | --- | --- | --- | --- | --- |
| env_config | 0 | 1 | 0 | 0.0% | seq 4→10 |
| permanent_logic | 1 | 0 | 0 | 100.0% | seq 5→12 |
| transient_infra | 1 | 0 | 0 | 100.0% | seq 3→9 |

## Novelty-park accuracy

Parked-as-futile (novelty parks) that succeeded immediately on operator
resume are **false parks**; parks that re-parked after resume are **true
parks**. Accuracy = true parks / (true + false parks). Parks the operator
never resumed are listed but unjudged.

True parks: 0 · False parks: 1 · Accuracy: 0.0%

| issue | park | resume | judgement | outcome cursor |
| --- | --- | --- | --- | --- |
| SYMPH-102 | seq 5 | seq 11 | false_park | seq 12 |

## Breaker value (true saves)

Issues parked while a stage circuit breaker was open. A parked issue that
re-failed after operator resume is a **true save** (true_park); one that
succeeded on resume is a **false save** (false_park).

### Breaker deadbeef on stage implement — opened seq 6, closed seq 8

Parked issues: 1 · True saves: 1 · False saves: 0 · Save rate: 100.0%

| issue | park | resume | judgement | outcome cursor |
| --- | --- | --- | --- | --- |
| SYMPH-104 | seq 7 | seq 13 | true_park | seq 14 |

## Alert volume per tier vs operator actions

Dispatch verdict volume by disposition (gate/halt are the alerting
tiers) against operator intent actions actually taken in the window.

| disposition | tier | count | cursor range |
| --- | --- | --- | --- |
| gate | alerting | 1 | seq 2–2 |
| halt | alerting | 1 | seq 15–15 |
| skip | quiet | 1 | seq 1–1 |

Operator actions taken:

- release: 2 (seq 11, seq 13)

## Backlog hygiene proposal precision

Proposal precision joins each journaled `hygiene_proposal` to the first
subsequent `hygiene_proposal_decision` for the same proposal. Operator
accept/reject is calibration signal only; it does not imply issue-state
mutation. Precision = accepted / (accepted + rejected).

_No hygiene proposals in window._

## Queue baseline (week zero)

FIFO-control samples recorded before queue-triage lanes gain authority.
Each row keeps the comparator version, considered issue ids, dispatch
picks, manual jumps/reorders, quiet-death and urgent-reopen outcomes,
plus spend/delivery outcomes per delivered ticket.

_No queue baseline samples in window._
