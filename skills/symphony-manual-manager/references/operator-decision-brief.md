# Symphony Operator Decision Brief

Use this template when a manual-manager ticket hits a non-autonomous boundary:
review round cap, budget cap, repeated same-family reopen, degraded review
substrate, missing live proof, unclear split/merge decision, or conflicting
ownership. This is the pause point aligned with `SYMPH-376`.

```markdown
# Operator Decision Brief - [SYMPH-123 / PR #123]

## Recommendation
[Continue scoped | split | park | merge Track-only | abandon/rework] because [one concise reason].

## Current Truth
- Issue: [SYMPH-123 title and URL]
- PR: [URL or none]
- Branch/head: [branch] @ [head sha]
- Base: [base ref] @ [base sha]
- Linear state: [state]
- CI/local validation: [commands and results]
- Live proof: [evidence or exact blocker]

## Why This Needs A Decision
[Name the cap, repeated finding family, degraded lane, missing credential, or product choice.]

## Work Completed
- [change/fix]
- [tests/proof]
- [Track issues filed or updated]

## Remaining Findings
| Severity | Family | Evidence | Current reachability | Proposed action |
| --- | --- | --- | --- | --- |
| P1/P2/Track | [family] | [file:line or artifact] | [reachable/stale/theoretical] | [fix/split/file/dismiss] |

## Options
| Option | What happens | Cost | Risk |
| --- | --- | --- | --- |
| Continue scoped | [exact next review/implementation prompt] | [time/tokens] | [risk] |
| Split | [new/existing issue IDs] | [cost] | [risk] |
| Park | [state and unblock condition] | [cost] | [risk] |
| Merge Track-only | [why P1/P2 are gone] | [cost] | [risk] |

## Next Prompt If Continuing
```text
[copy-ready worker or review prompt scoped to the named invariant/fix delta]
```

## Durable Links
- Council/review artifacts: [path or URL]
- Linear comments/docs: [URL]
- Report/handoff: [URL/path]
```

Decision brief rules:

- Refresh live Linear and GitHub immediately before writing the brief.
- Do not ask for a decision from stale PR or worker state.
- Include the manager's recommendation. Do not hand the operator an undigested
  list of findings.
- If the brief names durable follow-up, create or update the Linear issue
  before publishing the brief and include the issue ID.
- If the decision is "continue scoped," include the exact next prompt and why
  it is scoped rather than broad.
