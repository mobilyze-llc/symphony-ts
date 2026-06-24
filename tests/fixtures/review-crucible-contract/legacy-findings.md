## Verdict
FINDINGS

## Findings
- [P1] src/review/headless-council-gate.ts:5728 - Retired legacy FINDINGS verdict must be normalized, not silently degraded.
  evidence: src/review/headless-council-gate.ts:5728
  failure: an unrecognized FINDINGS token would degrade crucible council-triage to parse_quality partial and fail_open.
  test: pnpm exec vitest run tests/review/crucible-verdict-contract-cutover.test.ts
