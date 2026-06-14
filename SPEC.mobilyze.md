# Mobilyze Symphony Fork Specification

Status: canonical for fork-specific behavior in `mobilyze-llc/symphony-ts`.

This repository is a Mobilyze fork of upstream Symphony. `SPEC.upstream.md` remains the upstream baseline and compatibility reference, but it is not the behavioral authority for local orchestration deltas.

The Linear document **Crucible orchestration spine (canonical design)** is the canonical design spine for the Mobilyze orchestration model. This file pins the repository-level implementation contract so contributors and agents can resolve conflicts without re-reading session artifacts.

## Authority Order

When guidance conflicts, use this order:

1. `SPEC.mobilyze.md` and the Linear spine for fork-specific orchestration behavior.
2. Repository workflow docs such as `AGENTS.md`, `CLAUDE.md`, `README.md`, and `docs/`.
3. `SPEC.upstream.md` for unchanged upstream baseline behavior and conformance checks.

When fork behavior intentionally differs from upstream, update this file or the relevant repo workflow doc in the same change that introduces the delta.

## Fork Behavior

Mobilyze Symphony is the deterministic scheduling layer for judgment-routed, blast-bounded, eval-gated agent work.

Required local behavior:

- Dispatch decisions use deterministic tracker state, repository workflow configuration, and declared issue scope before model judgment.
- Co-running work must be bounded by declared file scope first, then by observed workspace writes once workers are live.
- Actual write collisions, branch reuse, base divergence, and eval drift are deterministic supervision findings.
- Model re-steer is a triggered side effect after deterministic findings exist. There is no steady-state model watcher deciding whether every worker is healthy.
- Decorrelated gates review agent work with independent tools or models. The agent that produced the work does not grade its own completion.
- Work units stay reviewable. Right-sizing, agent-authored tracker work, supervision, and gate decorrelation ship as focused increments rather than one broad organ graft.

## Anchor Comparator Trust Contract

Operator anchors can influence deterministic dispatch order only after they
survive the intent journal and comparator validation. The generic
`/api/v1/intents` route is an operator-authenticated transport, but it cannot
mint Linear field-edit provenance: `source: "linear_field_edit"`,
`fieldName`, and `editorEmail` are accepted only through the dedicated
field-edit ingestion route and its allowlist/secret checks.

Relative anchors (`above`/`below`) never dispatch by assumption. New writes
reject self-references and the pipeline sentinel. Existing or replayed anchors
whose target is missing from the current comparator candidate set, hard
excluded, or otherwise unavailable are preserved in the anchor read model but
degrade to no-op for ordering with a computed-order warning. `top` anchors are
bounded to the issue's priority band and do not jump ahead of higher-priority
work.

Anchor expiry has one semantic source: `until_merged` expires when the anchored
issue has terminal completion evidence, and `until_date` expires when the
configured instant is at or before the evaluation clock. Core replay,
comparator ordering, and `/api/v1/state` snapshots must use the same evaluator.

Linear field-edit ingestion resolves only issues visible to the runtime issue
resolver; non-active/pre-pin edits return `issue_not_found` until the resolver
is deliberately widened. Field-edit cursors are strict: any delivery whose
`editedAt` is equal to or older than the current anchor cursor is
`rejected_stale`, even when the payload is a duplicate. This prevents
equal-timestamp conflicting payloads from overwriting newer state.

## Dispatcher Resume Contract

Dispatcher organs must write an append-only run journal before starting side effects that can duplicate work. The durable journal lives under `.symphony/run-journals/dispatcher.jsonl` in the configured workspace root and records admission, right-sizing, supervision findings, re-steer requests, gate starts/results, tracker writes, and hard-stop triggers.

Each in-flight dispatcher operation owns a lease with an owner id, issue id, stage, attempt, expiry, and status. On restart, Symphony replays the journal before polling Linear. Non-expired active leases keep the issue claimed and block duplicate dispatch, gate, tracker-write, or hard-stop side effects. Expired leases are journaled as expired and may be retried. Completed tracker-write and re-steer journal entries are idempotency barriers: the same side effect key must not run again after replay.

Lease ownership is also workspace-root ownership. A lease that is admitted from workspace root A must write its completion or expiry back to root A's dispatcher journal even if runtime configuration later points at root B. Runtime reconfiguration with active dispatcher leases is fail-closed for polling: Symphony keeps the old root's journal mounted until those leases complete or expire, refuses to hydrate the new root while they are live, and only then replays the new root. Root swaps do not silently merge journals; any migration between roots must be explicit and provenance-checkable before replay.

Dispatcher journal write ownership is deliberately narrow. The runtime host is the primary writer: it owns in-memory sequence allocation, lease state, and ordered disk flushes for dispatcher, supervisor, feedback, tracker-write, and intent side effects. A standalone council review gate may append review lifecycle events only when it uses the dispatcher journal append lock for the full read/sequence/write batch; this serializes standalone writers for `--journal-workspace-root`, and the gate must fail closed if the lock or append fails. The lock is not a substitute for racing an active runtime host's in-memory sequence allocator: when a host owns a workspace root, review gate and operator mutations must be invoked by that host or run in an explicit single-writer maintenance window. Replay, calibration, dashboard projection, and state-delta tools are read-only journal consumers. Operator tools that mutate runtime state must route through the runtime host's intent/write surface, or use the same append lock for an explicitly supported standalone writer. No caller may allocate journal sequences from an unlocked snapshot of `dispatcher.jsonl`.

Recovery must preserve pause and escalation decisions. A crash after deterministic supervision emits a finding must not forget the finding; a crash during a gate must not run a second gate while the first lease is live; a crash during a tracker write must either observe the completed idempotency key or retry only after the lease expires.

## Spec-Time Review Readiness Authority

Spec-time Claude review readiness is durable dispatcher-journal state. For a
given issue and source intent hash, the latest `spec_review_result` journal row
wins over any generated readiness marker embedded in the Linear issue
description. The generated marker is a human-readable cache and source-intent
anchor, not the replay authority.

Selection must therefore consult the dispatcher journal before deciding that a
ticket with a current-looking marker is done. If the latest matching journal
row is `valid`, `needs_operator_context`, or `privacy_blocked`, selection may
skip the ticket for that source intent. If the latest matching journal row is a
retryable or persistence-failure state such as `failed`, `runner_failed`, or
`invalid_artifact`, selection must reselect the ticket even when the issue
description still contains an older `readiness-state:valid` marker. Journal rows
for a different source intent hash do not invalidate the current source intent;
normal source-hash mismatch handling covers edited tickets.

The spec-review watcher process status is a health signal, not an admission
decision. A deterministic privacy block is safe watcher behavior: batches where
every selected candidate is `privacy_blocked`, or where privacy-blocked
candidates are mixed with otherwise healthy reviews, must exit zero and expose
aggregate counts in the CLI output and selection artifact. The watcher must
still journal each privacy-blocked issue with `privacy_blocked` so admission can
block or warn from the durable per-issue readiness row. Actual substrate
failures, runner failures, or enforce-mode `needs_operator_context` results must
exit non-zero. This prevents monitors from treating safe privacy refusal as
watcher failure while still making "no useful review occurred" visible.

The source intent hash includes the full Linear issue description after
generated spec-review markers are stripped, plus a structured projection of
the `Acceptance Criteria` Markdown section. That projection is deliberately
section-scoped: it starts at an `Acceptance Criteria` heading and ends at the
next same-or-higher-level ATX-style Markdown heading, so later sections remain
part of the issue-body hash but are not double-counted as acceptance criteria.

## Reviewable Increment Boundaries

Keep the full orchestration graft split into small PRs:

1. Deterministic supervision core and runtime wiring.
2. Work-unit right-sizing and blast-radius classification.
3. Agent-authored tracker ticket shaping.
4. Decorrelated verify/review/acceptance gates.

Each increment should include focused tests, a PR linked to the owning Linear issue, and enough documentation for the next agent to understand which behavior is fork-specific.

## Upstream Compatibility

Use `SPEC.upstream.md` for baseline conformance and compatibility checks when behavior is unchanged from upstream Symphony. If a local test, comment, or implementation follows the Mobilyze spine instead, cite this spec and keep the local delta explicit.
