# Crabrunner Review And QA Runbook

This is the live operator runbook for Symphony review/QA after SYMPH-812. The
active review path is the crabrunner-backed review job group wired through
`review_execution.crabrunner_job_group.enabled: true`. The previous local
review runtime is not a production fallback.

## Current Holding Pattern

Codex/session-orchestrator remains the merge-authoritative holding pattern until
Symphony's crabrunner review path has passed the required real-PR gates. Use
session-orchestrator `council-flow` / crabbox-council evidence for PR-backed
work during that interval.

## Runtime Requirements

- `SYMPHONY_CRABRUNNER_ROOT` points to the Crucible checkout with `bin/crabrunner`.
- `SYMPHONY_CRABRUNNER_TARGET_REPO` points to the product checkout when it
  differs from the process cwd or `REPO_URL`.
- `SYMPHONY_CRABRUNNER_HOST`, `SYMPHONY_CRABRUNNER_REMOTE_USER`, and related
  remote variables select remote crabbox execution when needed.
- The workflow has `review_execution.crabrunner_job_group.enabled: true`.
- A `crabrunner` stage backend and review dispatcher are both wired. If either
  is missing, review fails closed and must not fall back to local review.

For the Claude crabrunner adapter, `input.workspace` is the authoritative target
repo checkout. Production `schedulerOptions.targetRepoRoot` must resolve to the
same path so source visibility preflight and delegated execution inspect the
same tree. When callers provide an explicit target repo root, that explicit
workspace-derived value wins over `SYMPHONY_CRABRUNNER_TARGET_REPO`; the
environment value is only a production default for callers that do not supply
one. The adapter is a one-shot lane and does not support CMUX `retryOnInvalid`;
callers that pass it fail before scheduler submission.

## Smoke

Run the focused contract tests before enabling a workflow or after changing the
review job group:

```bash
pnpm exec vitest run \
  tests/review/crabrunner-review-job-group.test.ts \
  tests/review/crabrunner-review-dispatcher.test.ts \
  tests/review/crabrunner-review-stage.test.ts \
  tests/review/review-journal-events.test.ts \
  tests/orchestrator/runtime-host.test.ts \
  tests/agent/workflow-template-smoke.test.ts
```

For substrate admission, run crabrunner from the configured Crucible checkout
against the target repo and keep the admission/status/collect artifacts with the
operator evidence bundle. A missing prompt file, missing head SHA, empty diff,
or unavailable backend is a fail-closed smoke failure.

## Real-PR Parity

Before treating Symphony review as production-authoritative, record an
operator-approved set of real PRs with:

- PR number, base SHA, reviewed head SHA, and merge candidate head.
- Previous review-era verdict and degraded state, when available.
- Crabrunner review verdict, degraded state, lane provenance, and artifact path.
- Accepted deltas, with the reason they do not weaken merge safety.
- Confirmation that v1 journal replay and review-result validator parity stayed
  green.

## Failure Triage

- `verdict: "pass"` with `review_metadata.decorrelation_merge_eligible: true`:
  review may advance to merge if the reviewed head still equals the live PR head.
- `verdict: "fail"` with surviving P1/P2 findings: return to implement/rework.
- `verdict: "error"` with only substrate stall or missing substrate artifacts:
  treat as review infrastructure, not product rework.
- Missing `review-result.json`, mismatched marker path, stale reviewed head, or
  missing decorrelation provenance: fail closed and rerun review after fixing the
  procedure or substrate.

Crabrunner admission and static-lease ownership carry the former concurrency
lock invariant: if the substrate cannot prove safe admission, it rejects the job
before reviewer work starts.

## Rollback Decision

There is no live CMUX rollback path. The historical CMUX deploy helper and
runbook are retained for one-release audit and archaeology only, and must not be
used as merge-authoritative review evidence. If crabrunner review is not ready,
route PR-backed work through Codex/session-orchestrator crabbox-council until
the crabrunner path is repaired and re-proven.
