# SYMPH-1155 post-SYMPH-660 investigate productivity

- Date: 2026-07-15
- Production host: `pro14`
- Measured tree: `da06fd2217635d221afcff4e0e3d3e312f13d8c6` (PR #777)
- Decision: cancel SYMPH-661; do not add right-sizing-mode investigate envelopes.

## Scope

This artifact follows the newest scope-bearing SYMPH-1155 comment. It records
the completed production measurement and does not change the report invocation,
report semantics, hard-stop policy, right-sizing policy, source, tests, config,
or either specification.

The sample contains three post-SYMPH-660 first-pass investigate units and one
additional retry after a workpad already existed. This clears SYMPH-661's
requirement to measure at least three post-retry-brake units before deciding
whether to split the investigate envelope.

## Provenance and limitation

The authoritative operational artifact is:

`/Users/ericlitman/.local/state/crucible/operator-supervisor/queues/symph-1155-invocation-20260715/runs/SYMPH-1155/artifacts/post-merge-pro14-measurement/measurement.json`

Its enriched SHA-256 is
`b3dc7d9e946c78d7511cbb35676b4121b8c901968e3352b10009b02f4c2cb2ce`.
The source hashes recorded by that artifact are:

- Production journal:
  `9121221a782c4b5bead380f4209b31927e87b2b5165cf867ec41ce1938c353e7`.
- Direct empty report:
  `6b24c1acb13741eb1d1a36687cf7fbe175df0fd5ca3487b584cee021e5adcfb3`.
- Rehydrated journal:
  `f94bdcd4a2aa2b8d876082496dc6c382721df66e06987b8cb83d32d945d81505`.
- Merged CLI report:
  `3ce9ee60b3e0314a50da89b322163e5eef87d8dd5b91909fc26dc250236641aa`.

The live dispatcher journal had been compacted at checkpoint sequence `12178`.
Consequently, the merged report CLI's direct journal scan correctly returned no
rows. The checkpoint still retained exact `issueExecutionHistory` StageRecords,
so the operator rehydrated only post-#530 investigate records from that
checkpoint. The measurement uses retained `completedAt`, token, cache, rate-limit
window, turn, and outcome metadata plus live Linear UUID-to-identifier lookups.
Compaction did not retain attempt numbers, so every attempt is `unknown`. The
CLI's inability to read the checkpoint history is tracked separately as
SYMPH-1162.

## Retained observations

| Unit | Pass | Completed at | Raw tokens | Cache-read share | Billable tokens | Catalog-weighted tokens | Weighted envelope share | Primary / secondary window burn | Turns | Workpad outcome | Legacy display estimate |
| --- | --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | --- | ---: |
| SYMPH-713 | First | `2026-06-16T03:22:47.671Z` | 212,812 | 78.7324% | 62,015 | 248,032.2 | 20.6694% | 0 pp / 0 pp | 1 | Normal workpad completion | $3.1008 |
| SYMPH-713 | Post-workpad retry | `2026-06-16T03:46:11.937Z` | 110,541 | 64.6131% | 46,259 | 134,663.4 | 11.2220% | 0 pp / 0 pp | 1 | Normal completion after an existing workpad | $2.3130 |
| SYMPH-639 | First | `2026-06-17T02:26:50.422Z` | 150,080 | 70.9595% | 54,234 | 175,819.6 | 14.6516% | 0 pp / 0 pp | 1 | Normal workpad completion | $2.7117 |
| SYMPH-772 | First | `2026-06-18T01:59:51.842Z` | 204,820 | 77.3674% | 62,202 | 240,041.4 | 20.0035% | 0 pp / 0 pp | 1 | Normal workpad completion | $3.1101 |

`pp` means percentage points of the observed rate-limit window. Both retained
primary and secondary window observations were zero for all four observations.

## First-pass distribution

The decision distribution excludes the post-workpad retry and compares the
three independent first passes:

| Measure | Observed distribution | p90 / decision value |
| --- | ---: | ---: |
| Turns | 1 for all three units | 1 |
| Raw tokens | 150,080–212,812 | 212,812 |
| Cache-read share | 70.9595%–78.7324% | 78.7324% |
| Billable tokens | 54,234–62,202 | 62,202 |
| Catalog-weighted tokens | 175,819.6–248,032.2 | 248,032.2 |
| Weighted ceiling utilization | 14.6516%–20.6694% | 20.6694% |
| Primary window burn | 0 pp for all retained observations | 0 pp |
| Secondary window burn | 0 pp for all retained observations | 0 pp |
| Legacy display estimate | $2.7117–$3.1101 | $3.1101 |

With three first passes, nearest-rank p90 is the observed maximum. The sample is
small by design: it satisfies the explicit three-unit precondition and supports
the bounded go/no-go decision, but it is not a general long-run capacity model.

## Fuse audit

The active staged investigate envelope is `max_iterations: 4`,
`max_tokens_per_unit: 1200000`, and `max_dollar_budget_usd: 4`.

| Fuse | Comparison | Audit |
| --- | --- | --- |
| Iterations | Four allowed versus one observed turn on every first pass: 4x the observed p90. | Comfortable. The first-pass distribution is far below the iteration fuse. |
| Weighted-token ceiling | 1,200,000 versus p90 248,032.2: 20.67% utilization, about 4.84x headroom. | Comfortable. The binding OpenAI/Codex credit-lane fuse is well above the sample. |
| Legacy `$4` display rung | `$4` is only 1.29x the `$3.1101` first-pass p90 display estimate. | Not comfortable as distribution headroom. The observed catalog marks it nonbinding and display-only for this OpenAI/Codex credit-lane measurement. |

The first two fuses therefore sit comfortably above post-brake first-pass
behavior. The `$4` value should not be presented as comfortable, but it also
does not justify SYMPH-661 because it is not the enforcement denomination for
this lane. The repository configuration still carries dollar-budget fields;
this measurement does not remove or redefine them. SYMPH-1157 owns any later
change to that binding path.

## SYMPH-1157 ladder seed

Use the measured weighted-token p90 with the existing 20% live grace, then
round to a 50,000-token increment:

```text
248,032.2 × 1.20 = 297,638.64
round up to 50,000 = 300,000
```

Keeping the existing `multiplier: 2` and `max_steps: 2` produces:

```text
base       step 1     step 2
300,000 -> 600,000 -> 1,200,000
```

This preserves the current 1.2M terminal ceiling while making the initial rung
measured rather than inherited. SYMPH-1157 owns any later config change; this
report records only the seed.

## Go/no-go for SYMPH-661

**NO-GO / cancel SYMPH-661.** Post-brake first-pass investigate burn is
immaterial in binding terms: all three units completed normally in one turn,
used at most 20.67% of the weighted ceiling, and consumed no retained primary or
secondary rate-limit window share. Do not add cheap-scoping versus deep-turn
right-sizing-mode envelopes from this sample.

The measurement still supports re-denominating the escalation ladder through
SYMPH-1157 and fixing checkpoint-aware report invocation through SYMPH-1162.
Neither follow-up changes the SYMPH-661 cancellation decision.
