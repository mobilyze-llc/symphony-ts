# Crucible Review Contract Corpus v0

These fixtures seed SYMPH-915 / SYMPH-914 contract replay. They use the MOB-348
reviewer markdown contract: `## Verdict` with `PASS`, `CHANGES_REQUESTED`, or
`BLOCKED`, followed by one `## Findings` section with inline severity bullets
`- [P1|P2|P3|Track] file:line — summary` and optional indented `evidence:` /
`failure:` / `test:` sub-fields.

Everything after "a reviewer emits markdown" in crucible's design is
deterministic, so these canned artifacts exercise the whole post-review path
(triage → cross-exam-select → convergence → mapping → verdict) with **zero model
calls**.

## Cases

| Fixture | Verdict | What it pins |
| --- | --- | --- |
| `pass.md` | PASS | clean, no findings |
| `changes-requested-p1.md` | CHANGES_REQUESTED | a P1 with `file:line` + reachable `failure:` + `test:` → escalate |
| `blocked.md` | BLOCKED | a blocked lane fails closed; its finding escalates |
| `track-only.md` | PASS | an explicitly non-blocking finding buckets to track, not escalate |
| `preamble-prefixed.md` | CHANGES_REQUESTED | a short preamble before `## Verdict` (the DeepSeek tendency) must still parse |
| `malformed-preamble.md` | malformed | a heading-shaped preamble is unsafe and must degrade rather than silently pass |
| `wording-sensitive-a.md` / `-b.md` | CHANGES_REQUESTED | same `file:line`, different summary → distinct `fp` |
| `legacy-findings.md` | FINDINGS (retired) | SYMPH-908: the retired Symphony-only `FINDINGS` token. Symphony normalizes it to `CHANGES_REQUESTED` before council-triage; fed raw to the spine it degrades to `parse_quality: partial` / `fail_open`. The cutover gate proves normalization prevents that. |

## Runners (single command: `pnpm smoke:review`)

- `tests/review/crucible-verdict-contract-cutover.test.ts` — **SYMPH-908 cutover
  gate.** Proves a Symphony-prompted artifact parses `clean` (not `partial`) through
  crucible's council-triage, and a legacy `FINDINGS` artifact is normalized to
  `CHANGES_REQUESTED` before the spine — never silently degraded. Live-spine portion
  auto-skips when the crucible checkout is absent.
- `tests/review/crucible-contract-smoke.test.ts` — Symphony's own parser
  (`synthesizeStructuredReviewerArtifactRecord`) consumes each fixture without
  degrading to `malformed_artifact`.
- `tests/review/crucible-spine-conformance.test.ts` — **Phase A.** Pipes the
  fixtures through the REAL crucible spine subcommands via `CrabboxSpineClient`
  and asserts the versioned schemas + bucketing + convergence. Auto-skips when
  the crucible checkout is absent (CI); runs green on the controller / local dev.
- `tests/review/crucible-consumer-replay.test.ts` — **Phase B / cutover gate.**
  Feeds the fixtures through `CrabboxSpineClient` + `ReviewAggregator`
  (SYMPH-908 PR-1/PR-2) and asserts verdict mapping, severity bucketing,
  preserved spine `fp`, the Track→Linear filer handoff (mocked), and
  fail-closed-on-missing-spine.

Override the spine path with `SYMPHONY_REVIEW_SPINE_PATH`.

## Two characteristics that must not re-surprise the integration agent

1. **omit-not-null argv contract.** When invoking the live crucible spine, omit
   unknown argv values. In particular, do **not** pass the literal string `null`
   for `--prior-diff-hash` or `--fix-size-lines`; leave those flags out when the
   value is unknown (the CLI rejects `"null"`). `CrabboxSpineClient` enforces
   this.
2. **Fingerprint wording-sensitivity.** Crucible `fp` values include the summary
   wording: two findings at the same `file:line` with different summaries
   produce distinct `fp`s. Across review *rounds* this is the over-escalation
   hazard (a re-worded finding looks new). Within a *single* triage round it is
   mitigated — cross-lane grouping is keyed by **location**, so two lanes
   reporting the same `file:line` with divergent wording collapse to a single
   escalate target rather than over-escalating.
