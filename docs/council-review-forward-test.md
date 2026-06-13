# SYMPH-555 Forward Test

## Historical Family

The 2026-06-13 retrospective named a review convergence family where a
stale Pipeline attachment survived after the SYMPH-321 runbook rewrite
changed the work semantics. That family kept inviting broad re-review
instead of a narrow current-head check against the journal invariant.

## Synthetic Replay

Input to the manual council after a tactical fix:

- Review mode: convergence pass
- Previous reviewed head SHA: `abc1234`
- Current head SHA: `def5678`
- Named invariant: Pipeline attachment references must match the
  current runbook semantics and current journal event contract.
- Artifact status: one prior reviewer note is stale, current diff
  artifact is complete.

## Expected Prompt Behavior

- Review only `previous_reviewed_head..HEAD` plus the semantic
  neighborhood that can falsify the named invariant.
- Do not launch another broad whole-diff round.
- Do not promote the stale reviewer note to P1/P2 without current-head
  file:line evidence.
- Require any surviving P1/P2 to name the contract violated,
  reachable failure mode, and test/proof gap.
- Put P3/Track items in Track with cold-read acceptance criteria,
  source refs, and verification steps.
- If the same family reopens again, produce an operator-decision brief:
  restructure against the named contract or park-with-synthesis.

## Expected Output Shape

The correct manual-council outcome is a scoped convergence decision:
PASS if no current-head P1/P2 survives, or FAIL only for a concrete
current-head defect in the fix delta or semantic neighborhood. The stale
artifact is recorded as unavailable evidence, not as a merge blocker.
