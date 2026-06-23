# Crucible Review Contract Corpus v0

These fixtures seed SYMPH-915/SYMPH-914 contract replay. They use the MOB-348
reviewer markdown contract: `## Verdict` with `PASS`, `CHANGES_REQUESTED`, or
`BLOCKED`, followed by one `## Findings` section with inline severity bullets.

When invoking the live crucible spine, omit unknown argv values. In particular,
do not pass literal `null` for `--prior-diff-hash` or `--fix-size-lines`; leave
those flags out when the value is unknown.

Known characteristic: crucible fingerprints include summary wording. Two
findings with the same `file:line` but different summaries can produce distinct
`fp` values and therefore fail toward over-escalation.
