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

## Dispatcher Resume Contract

Dispatcher organs must write an append-only run journal before starting side effects that can duplicate work. The durable journal lives under `.symphony/run-journals/dispatcher.jsonl` in the configured workspace root and records admission, right-sizing, supervision findings, re-steer requests, gate starts/results, tracker writes, and hard-stop triggers.

Each in-flight dispatcher operation owns a lease with an owner id, issue id, stage, attempt, expiry, and status. On restart, Symphony replays the journal before polling Linear. Non-expired active leases keep the issue claimed and block duplicate dispatch, gate, tracker-write, or hard-stop side effects. Expired leases are journaled as expired and may be retried. Completed tracker-write and re-steer journal entries are idempotency barriers: the same side effect key must not run again after replay.

Recovery must preserve pause and escalation decisions. A crash after deterministic supervision emits a finding must not forget the finding; a crash during a gate must not run a second gate while the first lease is live; a crash during a tracker write must either observe the completed idempotency key or retry only after the lease expires.

## Reviewable Increment Boundaries

Keep the full orchestration graft split into small PRs:

1. Deterministic supervision core and runtime wiring.
2. Work-unit right-sizing and blast-radius classification.
3. Agent-authored tracker ticket shaping.
4. Decorrelated verify/review/acceptance gates.

Each increment should include focused tests, a PR linked to the owning Linear issue, and enough documentation for the next agent to understand which behavior is fork-specific.

## Upstream Compatibility

Use `SPEC.upstream.md` for baseline conformance and compatibility checks when behavior is unchanged from upstream Symphony. If a local test, comment, or implementation follows the Mobilyze spine instead, cite this spec and keep the local delta explicit.
