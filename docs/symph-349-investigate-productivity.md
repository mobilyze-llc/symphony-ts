# SYMPH-349 Investigate Productivity Recommendation

## Decision

Ship the workpad-present retry brake first. Then canary at least three
post-fix investigate units before splitting investigate into cheap scoping and
gated deep turns. Do not treat the original SYMPH-330 first-unit cost as proof
that all investigate work is waste: the strongest evidence shows the first unit
produced the workpad, while later cost came from signal/retry failures that
forced the worker to refresh or re-verify existing output.

Implementation queue:

- SYMPH-660: add the workpad-present investigate retry brake.
- SYMPH-661: split investigate into cheap scoping and gated deep turns.
- SYMPH-662: add a repeatable productivity report from durable stage telemetry.

## Cost Basis

The cache-aware estimate uses the current hard-stop defaults:

- `DEFAULT_HARD_STOP_ESTIMATED_COST_PER_1K_TOKENS_USD = 0.05`.
- `DEFAULT_HARD_STOP_CACHED_TOKEN_COST_RATIO = 0.1`.
- `computeBillableTokens()` computes
  `round(totalTokens - cacheReadTokens * (1 - cachedTokenCostRatio))` after
  clamping invalid cache telemetry and ratio values. At the default cached-token
  ratio, that reduces to `round(totalTokens - cacheReadTokens * 0.9)`.

Derived cost is `billableTokens * 0.05 / 1000`. Rows marked "logged" use the
runtime's own recorded cost; rows marked "derived" use the formula above.

## Evidence

The original SYMPH-349 prompt asked for at least three investigate units. The
best available pre-SYMPH-341 evidence combines the local Symphony stdout log at
`/Users/ericlitman/Library/Logs/symphony/symphony/stdout.log` with Linear
comments. SYMPH-341 now persists the durable fields needed to make this analysis
repeatable, but these older units predate that durable shape.

| Unit | Evidence | Turns | Raw tokens | Cache read | Billable | Cost | Workpad result |
| --- | --- | ---: | ---: | ---: | ---: | ---: | --- |
| SYMPH-330 seed unit | `stdout.log:15333`, `stdout.log:15375`; Linear comments `2854371c`, `f6cd6684` | 2 | 323,474 | 260,992 | 88,581 | $4.43 logged | Initial discovery completed and posted the workpad; local log has token proof, Linear has workpad proof. |
| SYMPH-330 retry unit | `stdout.log:16164`, `stdout.log:16220`; Linear comments `61f1bff9`, `e1059007` | 2 | 261,371 | 163,968 | 113,800 | $5.69 logged | Refreshed existing workpad and emitted `[STAGE_COMPLETE]`, but marker parsing missed it. |
| SYMPH-332 | `stdout.log:49739`, `stdout.log:49742` | 1 | 203,645 | 167,552 | 52,848 | $2.64 derived | Posted workpad comment `6bc0fd4b...`; stage completed. |
| SYMPH-338 | `stdout.log:192715`, `stdout.log:192718` | 1 | 148,086 | 123,904 | 36,572 | $1.83 derived | Updated workpad comment `816295ce...`; stage completed. |
| SYMPH-420 | `stdout.log:282258`, `stdout.log:282261` | 1 | 161,811 | 124,800 | 49,491 | $2.47 derived | Posted workpad comment `a9927d14...`; stage completed. |
| SYMPH-321 | `stdout.log:263488`, `stdout.log:263491` | 1 | 195,856 | 168,064 | 44,598 | $2.23 derived | Updated workpad comment `d9657568...`; stage completed. |

The seed plus retry units show the actionable waste pattern: once the workpad
existed, another $5.69 was spent refreshing the same artifact and trying to
signal completion. Linear's manual triage note for the first three SYMPH-330
units records about $14.47 of cumulative canary burn, all post-completion waste
from stacked signal bugs. That makes the saving upper bound large in retry-loop
cases, but it should not be generalized to all first-pass investigation.

Additional evidence:

- `tests/policy/hard-stops.test.ts` records the SYMPH-330 unit-3 cache-heavy
  shape: 1,032,161 raw tokens and 921,344 cache-read tokens stayed below the
  250,000 billable-token ceiling after SYMPH-351.
- `src/policy/hard-stops.ts` records the SYMPH-348 cadence decision: recent
  raw 2026-06-12..14 artifacts showed no individual token-grace, dollar, or
  premium-ceiling breach, and operators should size budgets against billable
  usage plus `liveBudgetGraceRatio`.
- `pipeline-config/prompts/investigate.liquid` already includes the first
  anti-rediscovery brake: inspect Linear comments/workpad/resume notes first,
  spend at most six shell/tool calls, cap shell output, and write open questions
  into the workpad instead of deep-diving.

## Recommendation

Choose option (a) plus the already-started part of option (b):

1. Treat a current workpad as the investigate retry boundary. A retry should
   verify the existing plan, update the same workpad, or record open questions;
   it should not repeat broad discovery.
2. Make `sync_workpad` idempotently update the existing issue `## Workpad`
   comment when possible. The current prompt asks workers to search first; the
   tool should enforce the invariant instead of relying on model discipline.
3. Keep the existing prompt brake, but back it with tests and runtime-visible
   workpad/comment evidence so the contract is not only prose.
4. Canary the retry brake before splitting budgets. If post-fix data still
   shows expensive first-pass investigation, make cheap scoping the default and
   gate deep investigate by right-sizing, risk predicates, or explicit
   uncertainty in the workpad.
5. Add the telemetry report so future decisions use durable `StageRecord`
   fields instead of hand-mined Linear comments.

Expected savings:

- In signal/retry loops like SYMPH-330, the retry brake would have avoided most
  of the repeated investigate-unit spend after the first workpad existed.
- For ordinary first-pass investigation, expected savings are lower and should
  come from split-budget defaults rather than from pretending the first workpad
  can be free.

## Validation

This document is a shaping artifact. The validation surface is:

- Live Linear evidence for SYMPH-349 and SYMPH-330 was read on 2026-06-15.
- Duplicate search found no existing active implementation tickets for the
  selected follow-ups beyond SYMPH-349 itself.
- Follow-up implementation tickets were filed before this recommendation named
  them: SYMPH-660, SYMPH-661, and SYMPH-662.
- Accidental duplicate follow-ups SYMPH-663, SYMPH-664, and SYMPH-665 were
  cancelled, with useful specifics copied onto SYMPH-660 and SYMPH-661.
