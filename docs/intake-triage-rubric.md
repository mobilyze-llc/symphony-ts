# Intake triage rubric

Use this rubric to turn agent-filed intake into a code-verified planner candidate
pool. Filing stays cheap and provenance-rich; diagnosis happens in a recurring,
cross-ticket pass before an issue can influence planning.

Source: `docs/plans/2026-07-09-operational-readiness-audit.md` §B.2 and
§C.5. SYMPH-1076 owns the process and its evidence-based autonomy ramp.

## State contract

- **Triage is intake.** New findings land here and do not drive planning or
  dispatch.
- **Backlog is the planner candidate pool.** Only a completed triage decision
  may promote an issue from Triage to Backlog.
- **Todo is dispatch.** Triage never moves an issue directly to Todo.
- **Cancelled** is for absorbed, duplicated, superseded, or stale work.
- **Done** is only for work whose requested outcome was genuinely delivered.

Use `linear-pp-cli issues edit <id> --state-name <name> --agent` for state
changes. Do not infer dispatch authority from a project, release, or other
ambient field.

## Select the pass

Snapshot the union of:

1. every issue currently in Triage; and
2. every issue filed since the previous pass, regardless of its current state.

Pull each issue body and its complete comment thread once, then work from that
frozen scratch set. An earlier disposition remains authoritative unless a later
comment changes its evidence, scope, or root-cause relationship. Apply an
already-adjudicated but still-pending state transition without re-triaging the
issue.

Record the snapshot timestamp, cutoff, included identifiers, exclusions, and
final counts in a dated `docs/plans/YYYY-MM-DD-intake-triage-pass.md` log.

## Filing evidence floor

A Track finding must be actionable at file time. Its body or source comment
must name:

- the source PR or run, review round, and durable artifact when applicable;
- the affected repository, file, and function or symbol;
- the observed behavior or violated invariant, not only a request to "harden"
  a surface;
- severity and concrete harm if the behavior survives;
- code, test, reproduction, or runtime evidence; and
- an observable acceptance criterion and verification path.

Missing evidence does not become planner work. Leave the issue in Triage with
`needs-root-cause-trace` and state exactly what trace would make it actionable.
Do not reward speculative wording by promoting it.

## Adjudication procedure

1. Read the title, description, and **every comment**, oldest to newest.
2. Fetch `origin/main` immediately before verification. For cross-repository
   claims, verify the named repository's fresh default-branch HEAD too.
3. Grep the affected symbol and cite the current `file:line`. A historical line
   number or review artifact is provenance, not proof that the claim survives.
4. Apply expiry-on-subject-change: when the named file or function no longer
   exists, close the finding as `cancel-stale` unless the same invariant clearly
   moved to a live successor. If it moved, trace that successor before keeping
   or absorbing the issue.
5. Assign a root-cause cluster. When three or more issues share a root, name it
   and search Linear for an existing root-fix issue before creating one.
6. Choose exactly one disposition from the table below.
7. Batch small same-file or same-module survivors after itemizing them. Preserve
   each source item's evidence and acceptance criterion in the batch.
8. Comment on every mutated issue before changing its state or relationships.
   Add reciprocal context to an absorption or root-fix target.
9. When cancelling an agent-filed Track finding, append the stable marker
   `<!-- triage-disposition:<disposition>:<fingerprint> -->` to the disposition
   comment. For `absorb-into` and `supersede-by-root-fix`, also create the native
   `supersededBy` relation from the finding to the surviving root. These two
   provenance records let later review rounds suppress the same fingerprint
   only while that root remains open; they do not suppress a regression after
   the root is Done.

Never promote a "harden X" band-aid without a root trace. A symptom may remain
as a regression test or acceptance criterion, but the planner candidate must
name the structural fix it represents.

## Dispositions

| Disposition | Required proof | Linear effect |
|---|---|---|
| `keep` | The subject and failure mode survive on fresh main; scope is actionable and root-traced. | Promote Triage to Backlog. Otherwise leave the existing state unchanged. |
| `keep-but-move-release` | `keep` proof plus evidence that the current release misstates sequencing or ownership. | Promote to Backlog and move to the evidenced release. |
| `absorb-into` | An existing issue covers the same root, acceptance criteria, and verification. | Comment both issues; move the source to Cancelled. |
| `supersede-by-root-fix` | Multiple symptoms share a named root and a root-fix issue exists or is created after duplicate search. | Comment every symptom and the root; move symptoms to Cancelled. |
| `cancel-fixed` | A merged PR or commit delivered the requested outcome, verified against fresh main. | Cite PR and merge commit; move to Done. |
| `cancel-stale` | The premise is disproved, the subject expired, or the behavior is no longer actionable. | State why and move to Cancelled. |
| `needs-root-cause-trace` | Evidence or diagnosis is below the filing floor, or only a band-aid is proposed. | Keep in Triage; name the missing trace and do not promote. |

Release movement is taxonomy maintenance, not dispatch authority. Projects and
releases never substitute for the state contract above.

## Mutation comment

Use this shape for every disposition or relationship mutation:

```markdown
## Intake triage disposition

**Disposition:** <exact rubric value> [-> <target issue when applicable>]

**Evidence:** <fresh file:line and symbol; PR + merge commit for delivered work;
root-cluster relationship when applicable>

**Reopen or re-triage condition:** <specific new evidence that would invalidate
this decision>

**Doc reference:** `docs/intake-triage-rubric.md` and
`docs/plans/YYYY-MM-DD-intake-triage-pass.md`
```

For a `keep` promotion, the final line is a re-triage condition: subject
deletion/refactor, root-fix delivery, or new evidence that disproves the claim.

## Pass metrics and the T1 baseline

Count decisions by all seven exact disposition values. Count the ticket as the
unit of agreement; when a grab-bag is itemized, publish a separate item-level
count and one ticket-level disposition for its remaining shell.

T1 may additionally roll the exact classes into comparison families:

- `keep` + `keep-but-move-release` -> keep
- `absorb-into` -> absorb
- `cancel-fixed` -> cancel-fixed
- `cancel-stale` -> cancel-stale
- `supersede-by-root-fix` -> root-promote
- `needs-root-cause-trace` -> insufficient-trace

The shadow planner is report-only. Derive any agreement, cost, or autonomy
threshold from observed passes; do not guess an enforcement threshold in this
rubric.

The control doc reports Triage depth and recent inflow even before an alert
threshold exists. Leave `SYMPHONY_TRIAGE_INTAKE_ALERT_THRESHOLD` unset through
the first observed passes, then set it from that recorded inflow baseline. A
breach is journaled and displayed report-only; it never promotes or dispatches
intake.
