# CMUX Review Substrate Deploy

This is the deploy contract for the review substrate used by Symphony council
and lightweight decorrelated review lanes. The stable operating model is:

- Pro16 is the remote-primary CMUX substrate for ordinary review lanes.
- Pro14 is fallback or break-glass only, with an explicit recorded reason.
- Default deploy checkouts must end on merged refs, not detached PR heads.
- Evidence must prove the effective runtime root before a deploy is complete.

Use this runbook when changing any of:

- Crucible `cmux-spawn` or `cmux-spawn-remote`.
- Symphony council/review-gate routing.
- Pro16 review runtime deployment.
- CMUX substrate monitor LaunchAgents or state formats.
- Installed skills or docs that tell agents how to run CMUX review lanes.

The operator-facing helper is:

```bash
ops/cmux-review-substrate-deploy --artifact-dir /tmp/cmux-deploy-evidence
```

It writes an evidence bundle and makes no code changes. By default it inspects
local state, probes Pro16, runs remote preflight, captures monitor state, audits
review-callers for raw local CMUX usage, and exits non-zero when deploy gates
fail. Use `--no-remote` for local-only validation or CI, and `--allow-drift`
only when you intentionally need evidence from a known-bad substrate.

## Lightweight Decorrelated Review

For operational deploy, runbook, monitor, and small helper changes, use a
lightweight Kimi review instead of full council review.

1. Run focused tests and the deploy helper.
2. Run one Kimi lane against the diff and evidence bundle.
3. Treat Kimi as advisory, not merge-authoritative.
4. Fix meaningful correctness, safety, deployment, provenance, rollback, or
   usability findings.
5. Ignore nits and stylistic feedback unless they hide an operational ambiguity.
6. Rerun the relevant test or smoke after fixes.
7. Record the Kimi artifact path and disposition in the PR or deploy evidence.

Escalate to full council only when the change alters merge-authoritative review
semantics, shared runtime logic, schemas, or the review gate itself.

## Effective Runtime Inventory

Every deploy run must identify these surfaces and classify each as source,
deploy target, observer, or transient artifact:

- Pro14 local Crucible checkout and PATH wrapper.
- Pro14 installed skills/docs that mention CMUX routing.
- Pro14 monitor LaunchAgent and monitor state file.
- Pro16 Crucible default checkout used by `~/projects/crucible/bin/cmux-spawn`.
- Pro16 Symphony stable checkout used by review-gate/runtime commands.
- Pro16 staged worktrees used only for pre-merge proof.
- Pro16 CMUX app, active workspaces, and monitor state if present.
- The local `cmux-spawn-remote` shim and its default remote path resolution.

Before smoke tests, the evidence bundle must state which checkout is the
effective runtime root.

## Preflight Gates

Before promotion:

- Fetch relevant refs for Symphony and Crucible.
- Record current heads and dirty status for each target checkout.
- Fail closed, or require explicit override, if a default deploy checkout is
  detached, dirty in relevant files, or behind the expected merged ref.
- Distinguish staged worktree mode from stable promotion mode. Staged worktrees
  are allowed for pre-merge proof only; default deploy paths must return to
  merged `origin/main` after PRs land.
- Capture active CMUX workspaces and active lane processes before changing
  anything.

## Promotion Steps

Promote each surface separately:

- Crucible adapter substrate: update the default Pro16
  `~/projects/crucible` path to the intended merged ref, then verify
  `bin/cmux-spawn` and the adapter registry from that path.
- Symphony review-gate/runtime code: update the intended Pro16 Symphony runtime
  path to the intended merged ref and build it when required.
- Skills/docs: update installed or symlinked skill surfaces so ordinary agents
  find the remote-primary entrypoint and not stale local-first examples.
- Monitor configuration: explicitly decide whether Pro14 is the authoritative
  observer for Pro16 primary/Pro14 fallback, or whether Pro16 also runs a local
  monitor with a separate purpose.

## Caller Audit

Documentation alone is not enough. Each deploy run must audit active review
callers for raw local CMUX usage, including:

- `/Users/ericlitman/projects/crucible/bin/cmux-spawn`
- `$HOME/projects/crucible/bin/cmux-spawn`
- `command -v cmux-spawn`
- `CMUX_SPAWN_BIN` defaults that point to local-only paths

Classify every ordinary review-path hit as one of:

- migrated to the blessed remote-primary entrypoint,
- substrate-local debugging only,
- intentional break-glass path with reason and provenance,
- or blocked follow-up with a Linear issue.

## Smoke And Provenance

Smoke must prove routing and runtime provenance, not just execution.

Required evidence:

- Remote-primary preflight against `clawdilize@pro16.local`.
- A low-cost remote lane when appropriate, preferably fake if available, proving
  local-to-Pro16 artifact mirroring and `.remote-provenance.json` with
  `remote_host=clawdilize@pro16.local` and `substrate_tier=remote-pro16`.
- For adapter changes, a smoke for the changed agent such as `kimi`.
- For review-gate changes, a minimal gate smoke proving the relevant
  `review-result.json` semantics. For Kimi shadow, it must include
  `kimi-k27-shadow` with `mergeAuthoritative:false`.
- Evidence that the lane ran from the intended merged Pro16 runtime path, not an
  accidental staged detached worktree.

## Evidence Bundle

Each deploy run writes a directory containing:

- timestamp and operator/session identity when available,
- exact Symphony and Crucible refs before and after promotion,
- dirty status summaries for every target checkout,
- `cmux-spawn run --help` from the effective Pro16 default path,
- remote preflight JSON and stderr,
- monitor JSON and LaunchAgent status for the chosen monitor authority,
- active workspace listing before and after smoke,
- smoke command output, status files, artifact paths, and remote provenance,
- route tier: `remote-pro16`, `forced-local-pro14`, or `failed-closed`,
- this runbook's git SHA or patch status.

## Rollback

Capture previous known-good heads before promotion. Roll back separately for:

- Crucible adapter deploys,
- Symphony review-gate/runtime deploys,
- skill/doc propagation,
- monitor configuration changes.

Rollback must not destroy unrelated local files or staged worktrees. Record
rollback evidence in the same bundle shape.

## Closeout Gate

A deployment is not complete until:

- default deploy checkouts are on intended merged refs, not detached PR heads,
- staged worktrees are removed or documented as inactive/staged,
- ordinary review callers resolve to the blessed remote-primary path,
- monitor state reports Pro16 primary and Pro14 fallback, or the deploy fails
  closed with exact evidence,
- residual drift has a Linear issue referenced from the evidence bundle,
- this runbook and `ops/cmux-review-substrate-deploy --help` were updated or
  explicitly verified unchanged.
